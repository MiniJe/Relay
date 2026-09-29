// Run inside the production Compose Relay container so DATABASE_URL is the
// deployed database. Fixture membership is the same qualification shortcut as
// the existing multi-role tests, never a product invitation/privilege endpoint.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createPostgresStore } from '../packages/database/postgres-store.mjs';

const mode=process.argv[2]??'initial';
const base=process.env.RELAY_VERIFY_BASE_URL??'http://127.0.0.1:4000';
const stateFile=process.env.RELAY_COMMAND_STATE_FILE??'/tmp/relay-command-state.json';
// Compose startup/restart completes before the HTTP listener is necessarily ready.
for(let attempt=0;attempt<30;attempt++){try{if((await fetch(base+'/api/v1/health')).ok)break;}catch{}if(attempt===29)throw new Error('Relay health unavailable after startup.');await new Promise((resolve)=>setTimeout(resolve,1000));}
const makeClient=()=>{
  let cookie='';return async(path,method='GET',body,etag,expected=200)=>{
    const r=await fetch(base+path,{method,headers:{...(cookie?{cookie}:{}),...(body?{'content-type':'application/json'}:{}),...(etag?{'If-Match':etag}:{})},body:body?JSON.stringify(body):undefined});
    if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];const json=await r.json();
    assert.equal(r.status,expected,JSON.stringify(json));return {data:json.data,etag:r.headers.get('etag'),json};
  };
};
if(mode==='initial'){
  const marker=crypto.randomUUID(),password='command-verification-123';const client=makeClient(),recipient=makeClient();
  const email=`command-${marker}@example.com`,recipientEmail=`recipient-${marker}@example.com`;
  const user=(await client('/api/v1/auth/register','POST',{email,password,displayName:'Production Commander'},null,201)).data.user;
  const to=(await recipient('/api/v1/auth/register','POST',{email:recipientEmail,password,displayName:'Production Recipient'},null,201)).data.user;
  const org=(await client('/api/v1/organizations','POST',{name:`Command Production ${marker}`},null,201)).data;
  const store=await createPostgresStore(process.env.DATABASE_URL);
  try{await store.sql.unsafe('INSERT INTO organization_memberships(organization_id,user_id,role) VALUES($1,$2,$3)',[org.id,to.id,'RESPONDER']);}finally{await store.close();}
  const orgPath=`/api/v1/organizations/${org.id}`;
  const service=(await client(orgPath+'/services','POST',{name:'Command API'},null,201)).data;
  const component=(await client(orgPath+'/components','POST',{name:'Command Portal',serviceIds:[service.id]},null,201)).data;
  const page=(await client(orgPath+'/status-pages','POST',{name:'Command status',slug:`command-${marker}`,componentIds:[component.id]},null,201)).data;
  const intake=await fetch(base+'/api/v1/alerts',{method:'POST',headers:{'content-type':'application/json','x-relay-alert-key':process.env.ALERT_INGEST_KEY},body:JSON.stringify({organizationSlug:org.slug,source:'command-e2e',externalId:marker,title:'Command signal',severity:'critical',serviceIdentifier:service.slug})});assert.equal(intake.status,202);const alert=(await intake.json()).data;
  let r=await client(`${orgPath}/alerts/${alert.id}/incidents`,'POST',{title:'Production command incident',affectedComponentIds:[component.id]},null,201);
  const path=orgPath+'/incidents/'+r.data.id;
  r=await client(path);assert.equal(r.data.commanderUserId,user.id);assert.equal(r.data.linkedAlerts.length,1);
  const taskId=crypto.randomUUID();r=await client(path+'/tasks','POST',{id:taskId,kind:'RESPONSE',title:'PRIVATE-PRODUCTION-TASK',assigneeUserId:to.id,dueAt:'2026-09-29T14:00:00Z'},r.etag,201);
  r=await client(path+'/tasks/'+taskId,'PATCH',{state:'BLOCKED',blockedReason:'PRIVATE-PRODUCTION-BLOCK'},r.etag);
  const handoffId=crypto.randomUUID();r=await client(path+'/handoffs','POST',{id:handoffId,toUserId:to.id,note:'PRIVATE-PRODUCTION-HANDOFF'},r.etag,201);assert.equal(r.data.incident.commanderUserId,user.id);
  r=await recipient(path+'/handoffs/'+handoffId+'/accept','POST',{},r.etag);assert.equal(r.data.incident.commanderUserId,to.id);
  r=await client(path+'/communication-plan','PATCH',{ownerUserId:to.id,nextUpdateAt:'2026-09-29T15:00:00Z'},r.etag);
  r=await recipient(path+'/updates','POST',{message:'Approved production update',isPublic:true,reviewedScope:{componentIds:[component.id],statusPageIds:[page.id]}},r.etag,201);
  const final=await client(path);assert.equal(final.data.nextPublicUpdateAt,'2026-09-29T15:00:00.000Z');
  const publicData=await client(`/api/v1/public/status/${page.slug}`);assert.equal(JSON.stringify(publicData).includes('PRIVATE-PRODUCTION'),false);
  await writeFile(stateFile,JSON.stringify({email,password,path,commanderUserId:to.id,revision:final.data.revision,taskId,handoffId,incident:final.data}));
  console.log('Incident command Docker E2E PASS: accepted handoff, owned blocked work, private communications, linked alert, reviewed publication.');
}else if(mode==='restart'){
  const state=JSON.parse(await readFile(stateFile,'utf8'));const client=makeClient();await client('/api/v1/auth/login','POST',{email:state.email,password:state.password});const r=await client(state.path);
  assert.deepEqual(r.data,state.incident,'complete command aggregate, tasks, handoffs, audit and plan survive restart unchanged');
  console.log('Incident command restart persistence PASS:',JSON.stringify({revision:r.data.revision,taskId:state.taskId,handoffId:state.handoffId}));
}else throw new Error('Use initial or restart.');
