import crypto from 'node:crypto';
import { createServer } from 'node:http';
import { aggregatePublicStatus, assertIncidentTransition, domainError } from '../../../packages/shared/domain.mjs';
import { componentInput, email, id, incidentInput, incidentPatch, metadata, object, organizationInput, password, serviceInput, statusPageInput, string } from '../../../packages/shared/validation.mjs';
import { authenticate, requireOrgRole, requireUser } from './auth.mjs';
import { sendDiscordNotification } from './discord.mjs';
import { assertMutationOrigin, clientIp, errorResponse, readJson, sendJson, sendNoContent, serveStatic } from './http.mjs';
import { openapi } from './openapi.mjs';
import { clearSessionCookie, createOpaqueToken, encryptSecret, hashPassword, safeEqualText, sessionCookie, sha256, SlidingWindowRateLimiter, verifyPassword } from './security.mjs';
import { RealtimeHub } from './sse.mjs';

const responderRoles=['OWNER','ADMIN','RESPONDER'];
const adminRoles=['OWNER','ADMIN'];
const readableRoles=['OWNER','ADMIN','RESPONDER','VIEWER'];
const route=(pathname,re)=>pathname.match(re);
const cleanUser=(u)=>u?({id:u.id,email:u.email,displayName:u.displayName,createdAt:u.createdAt}):undefined;

function publicIncident(incident) {
  return {
    id:incident.id,title:incident.title,severity:incident.severity,status:incident.status,
    startedAt:incident.startedAt,resolvedAt:incident.resolvedAt,updatedAt:incident.updatedAt,
    affectedComponentIds:incident.affectedComponentIds,
    updates:(incident.updates??[]).filter((u)=>u.isPublic).map((u)=>({id:u.id,message:u.message,createdAt:u.createdAt}))
  };
}

async function validateReferences(store,organizationId,serviceIds=[],componentIds=[]) {
  const [services,components]=await Promise.all([store.listServices(organizationId),store.listComponents(organizationId)]);
  const serviceSet=new Set(services.map((x)=>x.id)); const componentSet=new Set(components.map((x)=>x.id));
  const badService=serviceIds.find((x)=>!serviceSet.has(x)); const badComponent=componentIds.find((x)=>!componentSet.has(x));
  if(badService||badComponent)throw domainError('INVALID_REFERENCE','Affected services/components must belong to the same organization.',400);
}

async function validateCommander(store,organizationId,commanderUserId) {
  if(!commanderUserId)return;
  const membership=await store.getMembership(organizationId,commanderUserId);
  if(!membership)throw domainError('INVALID_COMMANDER','Incident commander must be a member of the organization.',400);
}

export function createRelayServer({store,config,fetchImpl=fetch,hub=new RealtimeHub(),logger=console}) {
  const loginLimiter=new SlidingWindowRateLimiter({windowMs:15*60_000,limit:30});
  const alertLimiter=new SlidingWindowRateLimiter({windowMs:60_000,limit:120});
  const publicLimiter=new SlidingWindowRateLimiter({windowMs:60_000,limit:600});

  async function notifyDiscord(organizationId,kind,incident,extra={}) {
    try {
      const integration=await store.getIntegration(organizationId,'DISCORD');
      if(!integration?.enabled)return undefined;
      await sendDiscordNotification({integration,encryptionKey:config.integrationEncryptionKey,kind,incident,extra,fetchImpl});
      return undefined;
    } catch(error) {
      logger.warn?.('Discord delivery failed:',error.message);
      return {code:'DISCORD_DELIVERY_FAILED',message:error.message};
    }
  }

  return createServer(async(req,res)=>{
    const requestId=crypto.randomUUID();
    res.setHeader('x-request-id',requestId);
    try {
      const url=new URL(req.url,'http://relay.local');
      const pathname=url.pathname;
      if(pathname.startsWith('/api/')) {
        res.setHeader('x-frame-options','DENY');
        res.setHeader('x-content-type-options','nosniff');
        res.setHeader('referrer-policy','same-origin');
      }

      if(req.method==='GET'&&pathname==='/api/v1/health')return sendJson(res,200,{ok:true,version:'0.1.0'});
      if(req.method==='GET'&&pathname==='/api/v1/openapi.json')return sendJson(res,200,openapi,{'cache-control':'public, max-age=300'});

      if(req.method==='POST'&&pathname==='/api/v1/alerts') {
        const ip=clientIp(req,config.trustProxy); if(!alertLimiter.take(ip))throw domainError('RATE_LIMITED','Too many alert intake requests.',429);
        if(!config.alertIngestKey)throw domainError('CONFIGURATION_ERROR','ALERT_INGEST_KEY is not configured.',500);
        if(!safeEqualText(req.headers['x-relay-alert-key'],config.alertIngestKey))throw domainError('INVALID_ALERT_KEY','Alert intake key is invalid.',401);
        const body=object(await readJson(req));
        const organizationSlug=string(body.organizationSlug,'organizationSlug',{min:1,max:80});
        const organization=await store.getOrganizationBySlug(organizationSlug); if(!organization)throw domainError('ORGANIZATION_NOT_FOUND','Organization not found.',404);
        let serviceId;
        if(body.serviceIdentifier){
          const services=await store.listServices(organization.id);
          const identifier=string(body.serviceIdentifier,'serviceIdentifier',{max:120});
          const service=services.find((s)=>s.id===identifier||s.slug===identifier);
          if(!service)throw domainError('SERVICE_NOT_FOUND','Alert service identifier did not match an organization service.',400);
          serviceId=service.id;
        }
        const observedAt=body.timestamp?new Date(body.timestamp):new Date(); if(Number.isNaN(observedAt.getTime()))throw domainError('VALIDATION_ERROR','timestamp must be a valid date.',400);
        const alert=await store.createAlert(organization.id,{source:string(body.source,'source',{max:120}),externalId:body.externalId?string(body.externalId,'externalId',{max:200}):undefined,title:string(body.title,'title',{max:200}),description:string(body.description??'','description',{min:0,max:5000,optional:true})??'',severity:string(body.severity,'severity',{max:40}),serviceId,metadata:metadata(body.metadata),observedAt:observedAt.toISOString()});
        return sendJson(res,202,{data:alert});
      }

      const publicStatus=route(pathname,/^\/api\/v1\/public\/status\/([a-z0-9-]+)$/);
      if(req.method==='GET'&&publicStatus){
        if(!publicLimiter.take(clientIp(req,config.trustProxy)))throw domainError('RATE_LIMITED','Too many public status requests.',429);
        const raw=await store.getPublicStatusPage(publicStatus[1]); if(!raw)throw domainError('STATUS_PAGE_NOT_FOUND','Status page not found.',404);
        const active=raw.incidents.filter((i)=>i.status!=='RESOLVED');
        const resolved=raw.incidents.filter((i)=>i.status==='RESOLVED');
        const aggregation=aggregatePublicStatus(raw.components,active);
        return sendJson(res,200,{data:{page:raw.page,overallStatus:aggregation.overallStatus,components:aggregation.components,activeIncidents:active.map(publicIncident),recentIncidents:resolved.slice(0,20).map(publicIncident)}},{'cache-control':'public, max-age=15'});
      }
      const publicIncidentMatch=route(pathname,/^\/api\/v1\/public\/status\/([a-z0-9-]+)\/incidents\/([a-zA-Z0-9_-]+)$/);
      if(req.method==='GET'&&publicIncidentMatch){
        const raw=await store.getPublicStatusPage(publicIncidentMatch[1]);if(!raw)throw domainError('STATUS_PAGE_NOT_FOUND','Status page not found.',404);
        const incident=raw.incidents.find((i)=>i.id===publicIncidentMatch[2]);if(!incident)throw domainError('INCIDENT_NOT_FOUND','Incident not found.',404);
        return sendJson(res,200,{data:publicIncident(incident)},{'cache-control':'public, max-age=15'});
      }

      if(pathname.startsWith('/api/v1/auth/')||pathname==='/api/v1/me'||pathname.startsWith('/api/v1/organizations')) assertMutationOrigin(req,config.appOrigin);
      const session=await authenticate(req,store,config);

      if(req.method==='POST'&&pathname==='/api/v1/auth/register'){
        const ip=clientIp(req,config.trustProxy);if(!loginLimiter.take(`register:${ip}`))throw domainError('RATE_LIMITED','Too many registration attempts.',429);
        const body=object(await readJson(req)); const normalizedEmail=email(body.email); const normalizedPassword=password(body.password); const displayName=string(body.displayName,'displayName',{min:2,max:120});
        const user=await store.createUser({email:normalizedEmail,displayName,passwordHash:await hashPassword(normalizedPassword)});
        const token=createOpaqueToken(); const ttl=config.sessionTtlHours*3600; await store.createSession({userId:user.id,tokenHash:sha256(token),expiresAt:new Date(Date.now()+ttl*1000).toISOString()});
        return sendJson(res,201,{data:{user:cleanUser(user),organizations:[]}},{'set-cookie':sessionCookie(config.sessionCookieName,token,{maxAgeSeconds:ttl,secure:config.cookieSecure})});
      }
      if(req.method==='POST'&&pathname==='/api/v1/auth/login'){
        const ip=clientIp(req,config.trustProxy);if(!loginLimiter.take(`login:${ip}`))throw domainError('RATE_LIMITED','Too many login attempts.',429);
        const body=object(await readJson(req)); const normalizedEmail=email(body.email); const candidate=string(body.password,'password',{min:1,max:256}); const user=await store.getUserByEmail(normalizedEmail);
        if(!user||!(await verifyPassword(candidate,user.passwordHash)))throw domainError('INVALID_CREDENTIALS','Email or password is incorrect.',401);
        const token=createOpaqueToken();const ttl=config.sessionTtlHours*3600;await store.createSession({userId:user.id,tokenHash:sha256(token),expiresAt:new Date(Date.now()+ttl*1000).toISOString()});
        const organizations=await store.listOrganizationsForUser(user.id);
        return sendJson(res,200,{data:{user:cleanUser(user),organizations}},{'set-cookie':sessionCookie(config.sessionCookieName,token,{maxAgeSeconds:ttl,secure:config.cookieSecure})});
      }
      if(req.method==='POST'&&pathname==='/api/v1/auth/logout'){
        const cookies=(req.headers.cookie??'').split(';').map((x)=>x.trim());const target=cookies.find((x)=>x.startsWith(`${config.sessionCookieName}=`)); if(target)await store.deleteSession(sha256(decodeURIComponent(target.split('=').slice(1).join('='))));
        return sendNoContent(res,204,{'set-cookie':clearSessionCookie(config.sessionCookieName,{secure:config.cookieSecure})});
      }
      if(req.method==='GET'&&pathname==='/api/v1/me'){
        const user=requireUser(session);const organizations=await store.listOrganizationsForUser(user.id);return sendJson(res,200,{data:{user:cleanUser(user),organizations}});
      }
      if(req.method==='GET'&&pathname==='/api/v1/organizations'){
        const user=requireUser(session);return sendJson(res,200,{data:await store.listOrganizationsForUser(user.id)});
      }
      if(req.method==='POST'&&pathname==='/api/v1/organizations'){
        const user=requireUser(session);const org=await store.createOrganization({userId:user.id,...organizationInput(await readJson(req))});return sendJson(res,201,{data:org});
      }

      const orgBase=route(pathname,/^\/api\/v1\/organizations\/([a-zA-Z0-9_-]+)$/);
      if(req.method==='GET'&&orgBase){const user=requireUser(session);await requireOrgRole({store,userId:user.id,organizationId:orgBase[1],allowed:readableRoles});const org=await store.getOrganization(orgBase[1]);if(!org)throw domainError('ORGANIZATION_NOT_FOUND','Organization not found.',404);return sendJson(res,200,{data:org});}

      const collection=route(pathname,/^\/api\/v1\/organizations\/([a-zA-Z0-9_-]+)\/(services|components|status-pages|incidents|alerts|integrations)$/);
      if(collection){
        const user=requireUser(session);const organizationId=collection[1],resource=collection[2];await requireOrgRole({store,userId:user.id,organizationId,allowed:readableRoles});
        if(req.method==='GET'){
          if(resource==='services')return sendJson(res,200,{data:await store.listServices(organizationId)});
          if(resource==='components')return sendJson(res,200,{data:await store.listComponents(organizationId)});
          if(resource==='status-pages')return sendJson(res,200,{data:await store.listStatusPages(organizationId)});
          if(resource==='incidents')return sendJson(res,200,{data:await store.listIncidents(organizationId)});
          if(resource==='alerts')return sendJson(res,200,{data:await store.listAlerts(organizationId)});
          if(resource==='integrations')return sendJson(res,200,{data:await store.listIntegrations(organizationId)});
        }
        if(req.method==='POST'){
          if(resource==='services'){await requireOrgRole({store,userId:user.id,organizationId,allowed:adminRoles});return sendJson(res,201,{data:await store.createService(organizationId,serviceInput(await readJson(req)))});}
          if(resource==='components'){await requireOrgRole({store,userId:user.id,organizationId,allowed:adminRoles});const input=componentInput(await readJson(req));await validateReferences(store,organizationId,input.serviceIds,[]);return sendJson(res,201,{data:await store.createComponent(organizationId,input)});}
          if(resource==='status-pages'){await requireOrgRole({store,userId:user.id,organizationId,allowed:adminRoles});const input=statusPageInput(await readJson(req));await validateReferences(store,organizationId,[],input.componentIds);return sendJson(res,201,{data:await store.createStatusPage(organizationId,input)});}
          if(resource==='incidents'){
            await requireOrgRole({store,userId:user.id,organizationId,allowed:responderRoles});const input=incidentInput(await readJson(req));await validateReferences(store,organizationId,input.affectedServiceIds,input.affectedComponentIds);const commanderUserId=input.commanderUserId??user.id;await validateCommander(store,organizationId,commanderUserId);
            const incident=await store.createIncident(organizationId,{title:input.title,summary:input.summary,severity:input.severity,creatorUserId:user.id,commanderUserId},input.affectedServiceIds,input.affectedComponentIds,{actorUserId:user.id,eventType:'INCIDENT_CREATED',message:'Incident created.',metadata:{severity:input.severity,affectedServiceIds:input.affectedServiceIds,affectedComponentIds:input.affectedComponentIds}});
            const warning=await notifyDiscord(organizationId,'created',incident);hub.publish(organizationId,{type:'incident.created',incidentId:incident.id});return sendJson(res,201,{data:incident,...(warning?{warnings:[warning]}:{})});
          }
        }
      }

      const serviceItem=route(pathname,/^\/api\/v1\/organizations\/([a-zA-Z0-9_-]+)\/services\/([a-zA-Z0-9_-]+)$/);
      if(serviceItem&&req.method==='PATCH'){
        const user=requireUser(session),organizationId=serviceItem[1];await requireOrgRole({store,userId:user.id,organizationId,allowed:adminRoles});const current=await store.getService(organizationId,serviceItem[2]);if(!current)throw domainError('SERVICE_NOT_FOUND','Service not found.',404);const input=serviceInput({...current,...await readJson(req)});return sendJson(res,200,{data:await store.updateService(organizationId,serviceItem[2],input)});
      }
      const componentItem=route(pathname,/^\/api\/v1\/organizations\/([a-zA-Z0-9_-]+)\/components\/([a-zA-Z0-9_-]+)$/);
      if(componentItem&&req.method==='PATCH'){
        const user=requireUser(session),organizationId=componentItem[1];await requireOrgRole({store,userId:user.id,organizationId,allowed:adminRoles});const current=await store.getComponent(organizationId,componentItem[2]);if(!current)throw domainError('COMPONENT_NOT_FOUND','Component not found.',404);const input=componentInput({...current,...await readJson(req)});await validateReferences(store,organizationId,input.serviceIds,[]);return sendJson(res,200,{data:await store.updateComponent(organizationId,componentItem[2],input)});
      }

      const incidentItem=route(pathname,/^\/api\/v1\/organizations\/([a-zA-Z0-9_-]+)\/incidents\/([a-zA-Z0-9_-]+)$/);
      if(incidentItem){
        const user=requireUser(session),organizationId=incidentItem[1],incidentId=incidentItem[2];await requireOrgRole({store,userId:user.id,organizationId,allowed:readableRoles});const current=await store.getIncident(organizationId,incidentId);if(!current)throw domainError('INCIDENT_NOT_FOUND','Incident not found.',404);
        if(req.method==='GET')return sendJson(res,200,{data:current});
        if(req.method==='PATCH'){
          await requireOrgRole({store,userId:user.id,organizationId,allowed:responderRoles});const patch=incidentPatch(await readJson(req));if(patch.status)assertIncidentTransition(current.status,patch.status);if(patch.affectedServiceIds||patch.affectedComponentIds)await validateReferences(store,organizationId,patch.affectedServiceIds??current.affectedServiceIds,patch.affectedComponentIds??current.affectedComponentIds);if('commanderUserId' in patch)await validateCommander(store,organizationId,patch.commanderUserId);
          const events=[];
          if(patch.severity&&patch.severity!==current.severity)events.push({actorUserId:user.id,eventType:'SEVERITY_CHANGED',message:`Severity changed from ${current.severity} to ${patch.severity}.`,metadata:{from:current.severity,to:patch.severity}});
          if(patch.status&&patch.status!==current.status)events.push({actorUserId:user.id,eventType:patch.status==='RESOLVED'?'INCIDENT_RESOLVED':'STATUS_CHANGED',message:`Status changed from ${current.status} to ${patch.status}.`,metadata:{from:current.status,to:patch.status}});
          if(patch.affectedServiceIds)events.push({actorUserId:user.id,eventType:'AFFECTED_SERVICES_CHANGED',message:'Affected services changed.',metadata:{serviceIds:patch.affectedServiceIds}});
          if(patch.affectedComponentIds)events.push({actorUserId:user.id,eventType:'AFFECTED_COMPONENTS_CHANGED',message:'Affected components changed.',metadata:{componentIds:patch.affectedComponentIds}});
          if('commanderUserId' in patch&&patch.commanderUserId!==current.commanderUserId)events.push({actorUserId:user.id,eventType:'COMMANDER_CHANGED',message:'Incident commander changed.',metadata:{commanderUserId:patch.commanderUserId}});
          const updated=await store.updateIncident(organizationId,incidentId,patch,{affectedServiceIds:patch.affectedServiceIds,affectedComponentIds:patch.affectedComponentIds,events});let warning;if(patch.status==='RESOLVED'&&current.status!=='RESOLVED')warning=await notifyDiscord(organizationId,'resolved',updated);hub.publish(organizationId,{type:'incident.updated',incidentId});return sendJson(res,200,{data:updated,...(warning?{warnings:[warning]}:{})});
        }
      }

      const responderRoute=route(pathname,/^\/api\/v1\/organizations\/([a-zA-Z0-9_-]+)\/incidents\/([a-zA-Z0-9_-]+)\/responders$/);
      if(responderRoute&&req.method==='POST'){
        const user=requireUser(session),organizationId=responderRoute[1];await requireOrgRole({store,userId:user.id,organizationId,allowed:responderRoles});const body=object(await readJson(req));const target=body.userId?id(body.userId,'userId'):user.id;const targetMembership=await store.getMembership(organizationId,target);if(!targetMembership)throw domainError('INVALID_RESPONDER','Responder must be a member of the organization.',400);const incident=await store.addResponder(organizationId,responderRoute[2],target,user.id);if(!incident)throw domainError('INCIDENT_NOT_FOUND','Incident not found.',404);hub.publish(organizationId,{type:'incident.updated',incidentId:responderRoute[2]});return sendJson(res,200,{data:incident});
      }

      const updatesRoute=route(pathname,/^\/api\/v1\/organizations\/([a-zA-Z0-9_-]+)\/incidents\/([a-zA-Z0-9_-]+)\/updates$/);
      if(updatesRoute&&req.method==='POST'){
        const user=requireUser(session),organizationId=updatesRoute[1];await requireOrgRole({store,userId:user.id,organizationId,allowed:responderRoles});const body=object(await readJson(req));const message=string(body.message,'message',{min:1,max:5000});const isPublic=body.isPublic===true;const result=await store.addIncidentUpdate(organizationId,updatesRoute[2],{actorUserId:user.id,message,isPublic},{actorUserId:user.id,eventType:isPublic?'PUBLIC_UPDATE_PUBLISHED':'INTERNAL_NOTE_ADDED',message:isPublic?'Public update published.':'Internal note added.',metadata:{updateVisibility:isPublic?'PUBLIC':'INTERNAL'}});if(!result)throw domainError('INCIDENT_NOT_FOUND','Incident not found.',404);const warning=isPublic?await notifyDiscord(organizationId,'update',result.incident,{message}):undefined;hub.publish(organizationId,{type:'incident.updated',incidentId:updatesRoute[2]});return sendJson(res,201,{data:result,...(warning?{warnings:[warning]}:{})});
      }

      const resolveRoute=route(pathname,/^\/api\/v1\/organizations\/([a-zA-Z0-9_-]+)\/incidents\/([a-zA-Z0-9_-]+)\/resolve$/);
      if(resolveRoute&&req.method==='POST'){
        const user=requireUser(session),organizationId=resolveRoute[1];await requireOrgRole({store,userId:user.id,organizationId,allowed:responderRoles});const current=await store.getIncident(organizationId,resolveRoute[2]);if(!current)throw domainError('INCIDENT_NOT_FOUND','Incident not found.',404);assertIncidentTransition(current.status,'RESOLVED');const updated=await store.updateIncident(organizationId,current.id,{status:'RESOLVED'},{events:[{actorUserId:user.id,eventType:'INCIDENT_RESOLVED',message:'Incident resolved.',metadata:{from:current.status,to:'RESOLVED'}}]});const warning=await notifyDiscord(organizationId,'resolved',updated);hub.publish(organizationId,{type:'incident.resolved',incidentId:current.id});return sendJson(res,200,{data:updated,...(warning?{warnings:[warning]}:{})});
      }

      const postmortemRoute=route(pathname,/^\/api\/v1\/organizations\/([a-zA-Z0-9_-]+)\/incidents\/([a-zA-Z0-9_-]+)\/postmortem$/);
      if(postmortemRoute&&req.method==='PUT'){
        const user=requireUser(session),organizationId=postmortemRoute[1];await requireOrgRole({store,userId:user.id,organizationId,allowed:responderRoles});const incident=await store.getIncident(organizationId,postmortemRoute[2]);if(!incident)throw domainError('INCIDENT_NOT_FOUND','Incident not found.',404);if(incident.status!=='RESOLVED')throw domainError('INCIDENT_NOT_RESOLVED','Postmortems can be created after incident resolution.',409);const body=object(await readJson(req));const input={title:string(body.title,'title',{min:3,max:200}),summary:string(body.summary??'','summary',{min:0,max:5000,optional:true})??'',impact:string(body.impact??'','impact',{min:0,max:10000,optional:true})??'',rootCause:string(body.rootCause??'','rootCause',{min:0,max:10000,optional:true})??'',resolution:string(body.resolution??'','resolution',{min:0,max:10000,optional:true})??'',followUpActions:Array.isArray(body.followUpActions)?body.followUpActions.slice(0,50).map((x)=>string(x,'followUpActions',{min:1,max:500})):[]};const updated=await store.upsertPostmortem(organizationId,incident.id,input,user.id);hub.publish(organizationId,{type:'incident.updated',incidentId:incident.id});return sendJson(res,200,{data:updated.postmortem});
      }

      const discordRoute=route(pathname,/^\/api\/v1\/organizations\/([a-zA-Z0-9_-]+)\/integrations\/discord$/);
      if(discordRoute&&req.method==='PUT'){
        const user=requireUser(session),organizationId=discordRoute[1];await requireOrgRole({store,userId:user.id,organizationId,allowed:adminRoles});const body=object(await readJson(req));const webhookUrl=string(body.webhookUrl,'webhookUrl',{min:20,max:1000});let parsed;try{parsed=new URL(webhookUrl)}catch{throw domainError('VALIDATION_ERROR','webhookUrl must be a valid URL.',400)};if(parsed.protocol!=='https:'||!['discord.com','discordapp.com'].some((host)=>parsed.hostname===host||parsed.hostname.endsWith(`.${host}`)))throw domainError('VALIDATION_ERROR','Only Discord HTTPS webhook URLs are supported.',400);const integration=await store.upsertIntegration(organizationId,{provider:'DISCORD',name:string(body.name??'Discord','name',{max:80}),secretEncrypted:encryptSecret(webhookUrl,config.integrationEncryptionKey),enabled:body.enabled!==false});const {secretEncrypted,...safe}=integration;return sendJson(res,200,{data:safe});
      }

      const eventsRoute=route(pathname,/^\/api\/v1\/organizations\/([a-zA-Z0-9_-]+)\/events$/);
      if(eventsRoute&&req.method==='GET'){
        const user=requireUser(session),organizationId=eventsRoute[1];await requireOrgRole({store,userId:user.id,organizationId,allowed:readableRoles});
        res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache, no-transform','connection':'keep-alive','x-accel-buffering':'no'});res.write(`event: ready\ndata: ${JSON.stringify({organizationId})}\n\n`);
        const unsub=hub.subscribe(organizationId,(event)=>{if(!res.writableEnded)res.write(`event: relay\ndata: ${JSON.stringify(event)}\n\n`)});const keep=setInterval(()=>{if(!res.writableEnded)res.write(': keepalive\n\n')},25_000);req.on('close',()=>{clearInterval(keep);unsub()});return;
      }

      if(pathname.startsWith('/api/'))throw domainError('NOT_FOUND','API route not found.',404);
      if(await serveStatic(req,res,config.staticDir))return;
      throw domainError('NOT_FOUND','Page not found.',404);
    } catch(error) {
      if(res.headersSent){if(!res.writableEnded)res.end();return;}
      const {status,body}=errorResponse(error,requestId); if(status>=500)logger.error?.(error); sendJson(res,status,body);
    }
  });
}
