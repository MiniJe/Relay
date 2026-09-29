import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { harness, register, createOrg } from './helpers.mjs';
import { MemoryStore } from '../packages/database/memory-store.mjs';
import { createPostgresStore, migratePostgres } from '../packages/database/postgres-store.mjs';

for(const backend of ['memory','postgres'])test(`${backend}: incident command API, conflicts, tenant/RBAC and public boundary`,{skip:backend==='postgres'&&!process.env.DATABASE_URL?'DATABASE_URL required':false},async(t)=>{
  if(backend==='postgres')await migratePostgres(process.env.DATABASE_URL);
  const store=backend==='postgres'?await createPostgresStore(process.env.DATABASE_URL):new MemoryStore();
  const h=await harness({store,logger:console});t.after(async()=>{await h.close();if(store.close)await store.close();});
  const marker=crypto.randomUUID();
  const owner=await register(h.client,`owner-${marker}@example.com`,'Command Owner');const org=await createOrg(owner,`Command ${marker}`);
  const members={};
  for(const role of ['ADMIN','RESPONDER','VIEWER']){
    const auth=await register(h.client,`${role}-${marker}@example.com`,role);
    if(backend==='postgres')await store.sql.unsafe('INSERT INTO organization_memberships(organization_id,user_id,role) VALUES($1,$2,$3)',[org.id,auth.user.id,role]);
    else store.memberships.push({organizationId:org.id,userId:auth.user.id,role});members[role]=auth;
  }
  const outsider=await register(h.client,`outside-${marker}@example.com`,'Outside');const other=await createOrg(outsider,`Other ${marker}`);
  const request=(auth,path,method='GET',body,tag)=>auth.client.request(path,{method,body,headers:tag?{'If-Match':tag}:{}});
  const root=`/api/v1/organizations/${org.id}`;
  const created=await request(owner,root+'/incidents','POST',{title:'Command boundary incident',severity:'SEV2',affectedServiceIds:[],affectedComponentIds:[]});assert.equal(created.res.status,201);
  let incident=created.json.data;const path=root+'/incidents/'+incident.id;
  const read=async()=>{const r=await request(owner,path);assert.equal(r.res.status,200);incident=r.json.data;assert.equal(JSON.stringify(incident).includes('passwordHash'),false);assert.equal(typeof incident.revision,'string');return r.res.headers.get('etag');};
  let tag=await read();
  const taskBody={id:crypto.randomUUID(),kind:'RESPONSE',title:'PRIVATE-TASK-CONTEXT',assigneeUserId:members.RESPONDER.user.id,dueAt:'2026-09-29T14:00:00Z'};
  assert.equal((await request(owner,path+'/tasks','POST',taskBody)).res.status,428);
  assert.equal((await request(owner,path+'/tasks','POST',taskBody,'*')).res.status,400);
  for(const role of ['VIEWER'])assert.equal((await request(members[role],path+'/tasks','POST',taskBody,tag)).res.status,403);
  assert.equal((await request(outsider,path+'/tasks','POST',taskBody,tag)).res.status,403);
  for(const assigneeUserId of [outsider.user.id,members.VIEWER.user.id])assert.equal((await request(owner,path+'/tasks','POST',{...taskBody,assigneeUserId},tag)).res.status,400);
  assert.equal((await request(owner,path+'/tasks','POST',{...taskBody,bogus:'invalid'},tag)).res.status,400);
  const taskResult=await request(owner,path+'/tasks','POST',taskBody,tag);assert.equal(taskResult.res.status,201);const taskId=taskResult.json.data.task.id;
  assert.equal((await request(owner,path+'/tasks','POST',taskBody,tag)).json.replayed,true,'lost-response replay allowed with old but valid ETag');
  assert.equal((await request(owner,path+'/tasks','POST',{...taskBody,title:'changed'},tag)).res.status,409);
  assert.equal((await request(members.ADMIN,path+'/tasks','POST',taskBody,tag)).res.status,403,'another creator cannot replay');
  tag=await read();
  const competing=await Promise.all([
    request(owner,path+'/tasks/'+taskId,'PATCH',{state:'IN_PROGRESS'},tag),
    request(members.RESPONDER,path+'/tasks/'+taskId,'PATCH',{state:'BLOCKED',blockedReason:'PRIVATE-BLOCKED-REASON'},tag)
  ]);assert.deepEqual(competing.map((r)=>r.res.status).sort(),[200,412]);
  tag=await read();const beforeFailure=incident.timeline.length;
  assert.equal((await request(owner,path+'/tasks/'+taskId,'PATCH',{state:'BLOCKED',blockedReason:''},tag)).res.status,400);
  await read();assert.equal(incident.timeline.length,beforeFailure,'invalid work does not leave audit events');
  assert.equal((await request(members.RESPONDER,path+'/handoffs','POST',{id:crypto.randomUUID(),toUserId:members.ADMIN.user.id,note:'PRIVATE-HANDOFF'},tag)).res.status,403,'ordinary responder cannot hand off another commander');
  const proposals=await Promise.all([members.RESPONDER,members.ADMIN].map((recipient)=>request(owner,path+'/handoffs','POST',{id:crypto.randomUUID(),toUserId:recipient.user.id,note:'PRIVATE-HANDOFF'},tag)));
  assert.deepEqual(proposals.map((r)=>r.res.status).sort(),[201,412]);
  tag=await read();const pending=incident.handoffs.find((h)=>h.state==='PENDING');assert.equal(incident.commanderUserId,owner.user.id,'proposal keeps current commander');
  const recipient=Object.values(members).find((a)=>a.user.id===pending.toUserId);
  assert.equal((await request(owner,path+'/handoffs/'+pending.id+'/accept','POST',{},tag)).res.status,403,'admin cannot impersonate acceptance');
  const decisions=await Promise.all([request(recipient,path+'/handoffs/'+pending.id+'/accept','POST',{},tag),request(owner,path+'/handoffs/'+pending.id+'/cancel','POST',{reason:'Cancel competing handoff'},tag)]);
  assert.deepEqual(decisions.map((r)=>r.res.status).sort(),[200,412]);
  tag=await read();const decided=incident.handoffs.find((h)=>h.id===pending.id);
  assert.equal(incident.commanderUserId,decided.state==='ACCEPTED'?recipient.user.id:owner.user.id);
  assert.equal(incident.timeline.filter((e)=>['HANDOFF_ACCEPTED','HANDOFF_CANCELLED'].includes(e.eventType)&&e.metadata.handoffId===pending.id).length,1);
  assert.equal((await request(owner,path,'PATCH',{commanderUserId:incident.commanderUserId===members.ADMIN.user.id?owner.user.id:members.ADMIN.user.id},tag)).json.error.code,'HANDOFF_REQUIRED');
  assert.equal((await request(members.RESPONDER,path+'/commander/reassign','POST',{userId:members.ADMIN.user.id,reason:'Recover'},tag)).res.status,403);
  assert.equal((await request(members.ADMIN,path+'/commander/reassign','POST',{userId:owner.user.id,reason:'Command recovery'},tag)).res.status,200);
  tag=await read();
  assert.equal((await request(owner,path+'/communication-plan','PATCH',{ownerUserId:members.RESPONDER.user.id,nextUpdateAt:'2026-09-29T14:30:00Z'},tag)).res.status,200);
  tag=await read();assert.equal(incident.communicationsOwnerUserId,members.RESPONDER.user.id);
  assert.equal((await request(owner,path+'/communication-plan','PATCH',{nextUpdateAt:'2026-09-29T14:00:00'},tag)).res.status,400);
  assert.equal((await request(owner,path+'/updates','POST',{message:'internal',isPublic:false,nextPublicUpdateAt:null},tag)).res.status,400);
  const component=(await request(owner,root+'/components','POST',{name:'Public Portal'})).json.data;
  const page=(await request(owner,root+'/status-pages','POST',{name:'Command Public Page',slug:`command-${marker}`,componentIds:[component.id]})).json.data;
  assert.equal((await request(owner,path,'PATCH',{affectedComponentIds:[component.id]},tag)).res.status,200);
  tag=await read();
  assert.equal((await request(owner,path+'/updates','POST',{message:'Scope conflict message',isPublic:true,reviewedScope:{componentIds:[],statusPageIds:[]}},tag)).json.error.code,'PUBLIC_SCOPE_CHANGED');
  assert.equal((await request(owner,path+'/updates','POST',{message:'Reviewed public message',isPublic:true,reviewedScope:{componentIds:[component.id],statusPageIds:[page.id]}},tag)).res.status,201);
  tag=await read();assert.equal(incident.nextPublicUpdateAt,'2026-09-29T14:30:00.000Z','publication does not silently clear deadline');
  for(const suffix of ['',`/incidents/${incident.id}`]){
    const pub=await request(owner,`/api/v1/public/status/${page.slug}${suffix}`);assert.equal(pub.res.status,200);
    const json=JSON.stringify(pub.json);for(const privateValue of ['PRIVATE-TASK','PRIVATE-HANDOFF','PRIVATE-BLOCKED','communicationsOwnerUserId','nextPublicUpdateAt','handoffs','assigneeUserId'])assert.equal(json.includes(privateValue),false,privateValue);
  }
  for(const [resource,method,body] of [['tasks','POST',{...taskBody,id:crypto.randomUUID()}],['communication-plan','PATCH',{ownerUserId:null}],['commander/reassign','POST',{userId:outsider.user.id,reason:'Recover'}]]){
    const target=`/api/v1/organizations/${other.id}/incidents/${incident.id}/${resource}`;
    assert.equal((await request(outsider,target,method,body,tag)).res.status,404,'authorized wrong-tenant ID never mutates');
  }
  const resolvedHandoff=await request(owner,path+'/handoffs','POST',{id:crypto.randomUUID(),toUserId:members.RESPONDER.user.id,note:'Resolution race'},tag);assert.equal(resolvedHandoff.res.status,201);
  tag=await read();const handoffId=resolvedHandoff.json.data.handoff.id;
  const resolveRace=await Promise.all([request(owner,path+'/resolve','POST',{},tag),request(members.RESPONDER,path+'/handoffs/'+handoffId+'/accept','POST',{},tag)]);
  assert.deepEqual(resolveRace.map((r)=>r.res.status).sort(),[200,412]);
  tag=await read();if(incident.status!=='RESOLVED'){assert.equal((await request(owner,path+'/resolve','POST',{},tag)).res.status,200);tag=await read();}
  assert.equal(incident.nextPublicUpdateAt,null);assert.equal(incident.tasks.length,1);assert.equal(incident.handoffs.some((h)=>h.state==='PENDING'),false);
  const n=incident.timeline.length;assert.equal((await request(owner,path+'/resolve','POST',{},tag)).res.status,200);await read();assert.equal(incident.timeline.length,n,'repeat resolve has no duplicate event');
  assert.equal((await request(owner,path+'/tasks','POST',{...taskBody,id:crypto.randomUUID()},tag)).res.status,409);
  assert.equal((await request(owner,path+'/tasks/'+taskId,'PATCH',{state:'DONE'},tag)).res.status,200,'existing response work remains editable after resolution');
  tag=await read();assert.equal((await request(owner,path+'/tasks/'+taskId,'PATCH',{state:'TODO'},tag)).json.error.code,'TASK_REOPEN_REQUIRED');
  assert.equal((await request(owner,path+'/tasks/'+taskId+'/reopen','POST',{reason:'More validation needed'},tag)).res.status,200);
  tag=await read();assert.equal((await request(owner,path+'/tasks','POST',{...taskBody,id:crypto.randomUUID(),kind:'FOLLOW_UP'},tag)).res.status,201);
  tag=await read();const different=(await request(owner,root+'/incidents','POST',{title:'Different incident',severity:'SEV3'},null)).json.data;const differentPath=root+'/incidents/'+different.id;const differentTag=(await request(owner,differentPath)).res.headers.get('etag');
  assert.equal((await request(owner,differentPath+'/tasks','POST',taskBody,differentTag)).res.status,409,'stable create ID cannot overwrite another incident');
  assert.equal((await request(owner,differentPath)).json.data.tasks.length,0);
  tag=await read();const list=await request(owner,path+'/tasks?limit=1');assert.equal(list.json.data.length,1);assert.equal(list.json.page.total,2);assert.ok(list.json.page.nextCursor);
  const next=await request(owner,path+'/tasks?limit=1&cursor='+list.json.page.nextCursor);assert.equal(next.json.data.length,1);assert.notEqual(next.json.data[0].id,list.json.data[0].id);
  assert.equal((await request(owner,path+'/handoffs?cursor='+list.json.page.nextCursor)).res.status,400);
  // Eligible actor becomes read-only even when a historical handoff/task names them.
  if(backend==='postgres')await store.sql.unsafe('UPDATE organization_memberships SET role=$3 WHERE organization_id=$1 AND user_id=$2',[org.id,members.RESPONDER.user.id,'VIEWER']);
  else store.memberships.find((m)=>m.organizationId===org.id&&m.userId===members.RESPONDER.user.id).role='VIEWER';
  assert.equal((await request(members.RESPONDER,path+'/communication-plan','PATCH',{ownerUserId:null},tag)).res.status,403);
  assert.equal((await request(owner,path+'/tasks/'+taskId,'PATCH',{assigneeUserId:members.RESPONDER.user.id},tag)).res.status,400);
  await read();const newEvents=incident.timeline.filter((e)=>e.schemaVersion===1);assert.ok(newEvents.length>8);
  assert.equal(new Set(newEvents.map((e)=>`${e.incidentRevision}/${e.eventIndex}`)).size,newEvents.length);
  assert.ok(newEvents.every((e)=>e.organizationId===org.id&&e.actorDisplayNameSnapshot));
});
