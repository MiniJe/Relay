import crypto from 'node:crypto';
import { assertIncidentTransition, domainError } from './domain.mjs';
import { enumValue, id, object, string } from './validation.mjs';

export const OPERATIONAL_ROLES = ['OWNER','ADMIN','RESPONDER'];
export const TASK_STATES = ['TODO','IN_PROGRESS','BLOCKED','DONE','CANCELLED'];
export const incidentEtag = (incident) => `"incident-${incident.id}-r${incident.revision}"`;
const fail = (code,message,status=409) => { throw domainError(code,message,status); };
const equal = (a,b) => JSON.stringify(a)===JSON.stringify(b);
const terminal = (state) => ['DONE','CANCELLED'].includes(state);
const hash = (input) => crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');

export function incidentPrecondition(value,incidentId,required=false) {
  if(value===undefined){if(required)fail('PRECONDITION_REQUIRED','Refresh the incident and send its If-Match ETag.',428);return null;}
  const match = /^"incident-([a-zA-Z0-9_-]+)-r([1-9][0-9]*)"$/.exec(value);
  if(!match || match[1]!==incidentId)fail('VALIDATION_ERROR','If-Match must be the exact incident ETag.',400);
  return match[2];
}
export function timestamp(value,name) {
  if(value===null)return null;
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)||!Number.isFinite(Date.parse(value)))fail('VALIDATION_ERROR',`${name} must be an RFC 3339 timestamp with an offset.`,400);
  const [year,month,day,hour,minute,second]=value.slice(0,19).split(/[-T:]/).map(Number);
  const calendar=new Date(Date.UTC(year,month-1,day));
  if(calendar.getUTCFullYear()!==year||calendar.getUTCMonth()!==month-1||calendar.getUTCDate()!==day||hour>23||minute>59||second>59)fail('VALIDATION_ERROR',`${name} must name a real calendar instant.`,400);
  return new Date(value).toISOString();
}
export function commandInput(action,value) {
  const b=object(value),out={};
  const fields={taskCreate:['id','kind','title','description','assigneeUserId','dueAt'],taskPatch:['title','description','assigneeUserId','dueAt','state','blockedReason','cancellationReason'],taskReopen:['reason'],handoffCreate:['id','toUserId','note'],handoffAccept:[],handoffDecline:['reason'],handoffCancel:['reason'],reassign:['userId','reason'],communication:['ownerUserId','nextUpdateAt']}[action];
  if(!fields)fail('VALIDATION_ERROR','Unknown incident command.',400);
  for(const key of Object.keys(b))if(!fields.includes(key))fail('VALIDATION_ERROR',`Unknown field: ${key}.`,400);
  for(const key of fields){if(!(key in b))continue;
    if(['id','toUserId','userId','assigneeUserId','ownerUserId'].includes(key))out[key]=b[key]===null&&['assigneeUserId','ownerUserId'].includes(key)?null:id(b[key],key);
    else if(['dueAt','nextUpdateAt'].includes(key))out[key]=timestamp(b[key],key);
    else if(key==='state')out[key]=enumValue(b[key],key,TASK_STATES);
    else if(key==='kind')out[key]=enumValue(b[key],key,['RESPONSE','FOLLOW_UP']);
    else out[key]=string(b[key],key,{min:key==='description'?0:1,max:key==='title'?200:['reason','blockedReason','cancellationReason'].includes(key)?1000:5000});
  }
  if(['taskCreate','handoffCreate'].includes(action)){
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(out.id??''))fail('VALIDATION_ERROR','id must be a client-generated UUID.',400);
  }
  const required={taskCreate:['id','kind','title'],handoffCreate:['id','toUserId','note'],taskReopen:['reason'],handoffCancel:['reason'],reassign:['userId','reason']}[action]??[];
  for(const key of required)if(out[key]===undefined)fail('VALIDATION_ERROR',`${key} is required.`,400);
  if(action==='taskCreate')Object.assign(out,{description:out.description??'',assigneeUserId:out.assigneeUserId??null,dueAt:out.dueAt??null});
  if(['taskPatch','communication'].includes(action)&&!Object.keys(out).length)fail('VALIDATION_ERROR','Provide at least one field.',400);
  return out;
}

// Pure aggregate command. Stores provide a locked snapshot and commit the
// resulting aggregate and events together. Assignment never grants authority.
export function applyIncidentCommand(snapshot,{action,input={},entityId,actorUserId,expectedRevision},members,pages=[],at=new Date().toISOString()) {
  const i=structuredClone(snapshot),events=[];
  i.revision=String(i.revision??'1');i.tasks??=[];i.handoffs??=[];
  const actor=members.find((m)=>m.userId===actorUserId);
  if(!OPERATIONAL_ROLES.includes(actor?.role))fail('FORBIDDEN','Operational organization membership is required.',403);
  const admin=['OWNER','ADMIN'].includes(actor.role);
  const eligible=(userId)=>{
    if(userId===null)return null;
    const member=members.find((m)=>m.userId===userId);
    if(!OPERATIONAL_ROLES.includes(member?.role))fail('INVALID_REFERENCE','Assignment requires an eligible member of this organization.',400);
    return member;
  };
  const name=(userId)=>members.find((m)=>m.userId===userId)?.displayName??null;
  const event=(eventType,message,metadata={})=>events.push({id:crypto.randomUUID(),organizationId:i.organizationId,incidentId:i.id,actorUserId,actorDisplayNameSnapshot:actor.displayName,eventType,message,metadata,occurredAt:at,schemaVersion:1});
  const active=()=>{if(i.status==='RESOLVED')fail('INCIDENT_RESOLVED','This operation requires an active incident.');};
  const cancelPending=(reason)=>{for(const h of i.handoffs.filter((h)=>h.state==='PENDING')){Object.assign(h,{state:'CANCELLED',decidedAt:at,decidedByUserId:actorUserId,decidedByNameSnapshot:actor.displayName,decisionReason:reason});event('HANDOFF_CANCELLED','Command handoff cancelled.',{handoffId:h.id,reason});}};
  let entity,replayed=false;
  if(['taskCreate','handoffCreate'].includes(action)){
    const collection=action==='taskCreate'?i.tasks:i.handoffs;
    entity=collection.find((x)=>x.id===input.id);
    if(entity){
      if((entity.createdByUserId??entity.requestedByUserId)!==actorUserId)fail('FORBIDDEN','Only the original creator may replay this command.',403);
      if(entity.creationPayloadHash!==hash(input))fail('IDEMPOTENCY_CONFLICT','This ID was already used with different content.');
      replayed=true;
    }
  }
  if(!replayed && expectedRevision!==null && expectedRevision!==undefined && expectedRevision!==i.revision)throw domainError('REVISION_MISMATCH','The incident changed. Refresh, review your draft and retry.',412,{revision:i.revision});
  if(replayed)return {incident:i,entity,replayed,events,changed:false};
  switch(action){
    case 'handoffCreate': {
      active();if(!admin&&i.commanderUserId!==actorUserId)fail('FORBIDDEN','Only the commander or an administrator may propose a handoff.',403);
      const recipient=eligible(input.toUserId);
      if(input.toUserId===i.commanderUserId)fail('INVALID_HANDOFF','Choose a different commander.');
      if(i.handoffs.some((h)=>h.state==='PENDING'))fail('HANDOFF_PENDING','A command handoff is already awaiting acceptance.');
      entity={...input,organizationId:i.organizationId,incidentId:i.id,fromUserId:i.commanderUserId??null,fromNameSnapshot:name(i.commanderUserId),toNameSnapshot:recipient.displayName,requestedByUserId:actorUserId,requestedByNameSnapshot:actor.displayName,state:'PENDING',createdAt:at,decidedAt:null,decidedByUserId:null,decidedByNameSnapshot:null,decisionReason:null,creationPayloadHash:hash(input)};
      i.handoffs.push(entity);event('HANDOFF_REQUESTED','Command handoff requested; current commander remains responsible.',{handoffId:entity.id,fromUserId:entity.fromUserId,toUserId:entity.toUserId,toName:entity.toNameSnapshot,note:entity.note});break;
    }
    case 'handoffAccept':case 'handoffDecline':case 'handoffCancel': {
      entity=i.handoffs.find((h)=>h.id===entityId);if(!entity)fail('HANDOFF_NOT_FOUND','Handoff not found.',404);
      if(action==='handoffCancel'){if(!admin&&![entity.requestedByUserId,i.commanderUserId].includes(actorUserId))fail('FORBIDDEN','Only the proposer, commander or administrator may cancel.',403);}
      else if(entity.toUserId!==actorUserId)fail('FORBIDDEN','Only the named recipient may accept or decline.',403);
      const state={handoffAccept:'ACCEPTED',handoffDecline:'DECLINED',handoffCancel:'CANCELLED'}[action];
      if(entity.state===state)break;
      if(entity.state!=='PENDING')fail('HANDOFF_NOT_PENDING','This handoff has already been decided.');
      if(action==='handoffAccept'){active();eligible(entity.toUserId);if((i.commanderUserId??null)!==entity.fromUserId)fail('HANDOFF_SOURCE_CHANGED','The current commander differs from this handoff. Request a fresh transfer.');i.commanderUserId=entity.toUserId;if(!i.responders.some((r)=>r.userId===entity.toUserId))i.responders.push({incidentId:i.id,userId:entity.toUserId,joinedAt:at});}
      Object.assign(entity,{state,decidedAt:at,decidedByUserId:actorUserId,decidedByNameSnapshot:actor.displayName,decisionReason:input.reason??null});
      event(`HANDOFF_${state}`,`Command handoff ${state.toLowerCase()}.`,{handoffId:entity.id,fromUserId:entity.fromUserId,toUserId:entity.toUserId,toName:entity.toNameSnapshot,reason:input.reason??null});break;
    }
    case 'reassign': {
      active();if(!admin)fail('FORBIDDEN','Administrative recovery requires OWNER or ADMIN.',403);eligible(input.userId);
      if(i.commanderUserId===input.userId)break;
      cancelPending('ADMIN_REASSIGNMENT');const from=i.commanderUserId;i.commanderUserId=input.userId;
      event('COMMANDER_REASSIGNED','Commander reassigned through administrative recovery.',{fromUserId:from,toUserId:input.userId,toName:name(input.userId),reason:input.reason});break;
    }
    case 'communication': {
      if('ownerUserId' in input)eligible(input.ownerUserId);
      if(input.nextUpdateAt)active();
      const before={ownerUserId:i.communicationsOwnerUserId??null,nextUpdateAt:i.nextPublicUpdateAt??null};
      const after={...before,...input};
      if(!equal(before,after)){i.communicationsOwnerUserId=after.ownerUserId;i.nextPublicUpdateAt=after.nextUpdateAt;event('COMMUNICATION_PLAN_CHANGED','Private communication responsibility updated.',{before,after,ownerName:name(after.ownerUserId)});}break;
    }
    case 'taskCreate': {
      if((input.kind==='RESPONSE')===(i.status==='RESOLVED'))fail('INVALID_TASK_KIND','Response tasks require an active incident; follow-up tasks require resolution.');
      const assignee=eligible(input.assigneeUserId);
      entity={...input,organizationId:i.organizationId,incidentId:i.id,state:'TODO',assigneeNameSnapshot:assignee?.displayName??null,blockedReason:null,cancellationReason:null,createdByUserId:actorUserId,createdByNameSnapshot:actor.displayName,createdAt:at,updatedAt:at,completedAt:null,creationPayloadHash:hash(input)};
      i.tasks.push(entity);event('TASK_CREATED','Operational task created.',{taskId:entity.id,title:entity.title,assigneeUserId:entity.assigneeUserId,assigneeName:entity.assigneeNameSnapshot,dueAt:entity.dueAt});break;
    }
    case 'taskPatch':case 'taskReopen': {
      entity=i.tasks.find((t)=>t.id===entityId);if(!entity)fail('TASK_NOT_FOUND','Task not found.',404);
      const before=structuredClone(entity);
      if(action==='taskReopen'){if(!terminal(entity.state))fail('TASK_NOT_TERMINAL','Only completed or cancelled work can be reopened.');entity.state='TODO';}
      else {
        if('assigneeUserId' in input){const m=eligible(input.assigneeUserId);entity.assigneeNameSnapshot=m?.displayName??null;}
        if(terminal(entity.state)&&input.state&&input.state!==entity.state)fail('TASK_REOPEN_REQUIRED','Use the explicit reopen command for terminal work.');
        Object.assign(entity,input);
      }
      if(entity.state==='BLOCKED')entity.blockedReason=string(entity.blockedReason,'blockedReason',{max:1000});else entity.blockedReason=null;
      if(entity.state==='CANCELLED')entity.cancellationReason=string(entity.cancellationReason,'cancellationReason',{max:1000});else entity.cancellationReason=null;
      entity.completedAt=entity.state==='DONE'?(entity.completedAt??at):null;
      if(!equal(before,entity)){entity.updatedAt=at;event(action==='taskReopen'?'TASK_REOPENED':'TASK_CHANGED','Operational task updated.',{taskId:entity.id,before,after:structuredClone(entity),reason:input.reason??null});}break;
    }
    case 'patch': {
      if('commanderUserId' in input&&input.commanderUserId!==(i.commanderUserId??null))fail('HANDOFF_REQUIRED','Use an accepted handoff or administrative commander recovery.');
      if(input.status)assertIncidentTransition(i.status,input.status);
      for(const [key,type] of [['summary','SUMMARY_CHANGED'],['severity','SEVERITY_CHANGED'],['status','STATUS_CHANGED'],['affectedServiceIds','AFFECTED_SERVICES_CHANGED'],['affectedComponentIds','AFFECTED_COMPONENTS_CHANGED']]){
        if(input[key]!==undefined&&!equal(i[key],input[key])){const before=i[key];i[key]=input[key];event(key==='status'&&input.status==='RESOLVED'?'INCIDENT_RESOLVED':type,`${key} changed.`,{from:before,to:input[key]});}
      }
      if(i.status==='RESOLVED'&&snapshot.status!=='RESOLVED'){i.resolvedAt=at;i.nextPublicUpdateAt=null;cancelPending('INCIDENT_RESOLVED');}break;
    }
    case 'update': {
      if(input.reviewedScope){
        const expected={componentIds:[...i.affectedComponentIds].sort(),statusPageIds:pages.filter((p)=>p.isPublic&&p.componentIds.some((c)=>i.affectedComponentIds.includes(c))).map((p)=>p.id).sort()};
        const actual={componentIds:[...input.reviewedScope.componentIds].sort(),statusPageIds:[...input.reviewedScope.statusPageIds].sort()};
        if(!equal(expected,actual))fail('PUBLIC_SCOPE_CHANGED','Public destinations changed. Review the message and audience again.');
      }
      if('nextPublicUpdateAt' in input){if(!input.isPublic)fail('VALIDATION_ERROR','Internal notes cannot change the public-update plan.',400);if(input.nextPublicUpdateAt)active();i.nextPublicUpdateAt=input.nextPublicUpdateAt;}
      entity={id:crypto.randomUUID(),incidentId:i.id,actorUserId,message:input.message,isPublic:input.isPublic,createdAt:at};i.updates.push(entity);
      event(input.isPublic?'PUBLIC_UPDATE_PUBLISHED':'INTERNAL_NOTE_ADDED',input.isPublic?'Public update published.':'Internal note added.',{updateId:entity.id,updateVisibility:input.isPublic?'PUBLIC':'INTERNAL'});break;
    }
    case 'responder': {
      eligible(input.userId);if(!i.responders.some((r)=>r.userId===input.userId)){i.responders.push({incidentId:i.id,userId:input.userId,joinedAt:at});event('RESPONDER_JOINED','Responder joined the incident.',{userId:input.userId});}break;
    }
    case 'postmortem': {
      if(i.status!=='RESOLVED')fail('INCIDENT_NOT_RESOLVED','Postmortems require a resolved incident.');
      i.postmortem={...(i.postmortem??{id:crypto.randomUUID(),incidentId:i.id,createdByUserId:actorUserId,createdAt:at}),...input,updatedAt:at};event(snapshot.postmortem?'POSTMORTEM_UPDATED':'POSTMORTEM_CREATED','Postmortem saved.');break;
    }
    default:fail('VALIDATION_ERROR','Unknown command.',400);
  }
  const changed=events.length>0;
  if(changed){i.revision=(BigInt(i.revision)+1n).toString();i.updatedAt=at;events.forEach((e,n)=>Object.assign(e,{incidentRevision:i.revision,eventIndex:n}));i.timeline.push(...events);}
  return {incident:i,entity,events,replayed:false,changed};
}
