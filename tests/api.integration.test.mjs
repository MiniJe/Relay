import test from 'node:test';
import assert from 'node:assert/strict';
import { createOrg, harness, register } from './helpers.mjs';

test('principal API workflow persists timeline, separates public updates, delivers Discord, and enforces tenant isolation',async(t)=>{
  const discord=[];const h=await harness({fetchImpl:async(url,options)=>{discord.push({url,body:JSON.parse(options.body)});return new Response('',{status:204})}});t.after(()=>h.close());
  const owner=await register(h.client);const org=await createOrg(owner);

  let r=await owner.client.request(`/api/v1/organizations/${org.id}/services`,{method:'POST',body:{name:'Checkout API',description:'Checkout requests'}});assert.equal(r.res.status,201);const service=r.json.data;
  r=await owner.client.request(`/api/v1/organizations/${org.id}/components`,{method:'POST',body:{name:'Checkout',serviceIds:[service.id]}});assert.equal(r.res.status,201);const component=r.json.data;
  r=await owner.client.request(`/api/v1/organizations/${org.id}/status-pages`,{method:'POST',body:{name:'Acme Status',slug:'acme-status',componentIds:[component.id],branding:{headline:'Acme',description:'Live health'}}});assert.equal(r.res.status,201);
  r=await owner.client.request(`/api/v1/organizations/${org.id}/integrations/discord`,{method:'PUT',body:{name:'Ops',webhookUrl:'https://discord.com/api/webhooks/123/token',enabled:true}});assert.equal(r.res.status,200);assert.equal(r.json.data.secretEncrypted,undefined);

  r=await owner.client.request(`/api/v1/organizations/${org.id}/incidents`,{method:'POST',body:{title:'Checkout failures',summary:'Requests returning 500',severity:'SEV2',affectedServiceIds:[service.id],affectedComponentIds:[component.id]}});assert.equal(r.res.status,201);const incident=r.json.data;assert.equal(incident.timeline.at(-1).eventType,'INCIDENT_CREATED');assert.equal(discord.length,1);
  r=await owner.client.request(`/api/v1/organizations/${org.id}/incidents/${incident.id}`,{method:'PATCH',body:{severity:'SEV1',status:'IDENTIFIED'}});assert.equal(r.res.status,200);assert.equal(r.json.data.severity,'SEV1');assert.ok(r.json.data.timeline.some((e)=>e.eventType==='SEVERITY_CHANGED'));

  r=await owner.client.request(`/api/v1/organizations/${org.id}/incidents/${incident.id}/updates`,{method:'POST',body:{message:'Database saturation suspected.',isPublic:false}});assert.equal(r.res.status,201);assert.equal(discord.length,1);
  r=await owner.client.request(`/api/v1/organizations/${org.id}/incidents/${incident.id}/updates`,{method:'POST',body:{message:'We are investigating elevated checkout errors.',isPublic:true}});assert.equal(r.res.status,201);assert.equal(discord.length,2);

  r=await h.client().request('/api/v1/public/status/acme-status');assert.equal(r.res.status,200);assert.equal(r.json.data.overallStatus,'MAJOR_OUTAGE');assert.equal(r.json.data.activeIncidents.length,1);assert.deepEqual(r.json.data.activeIncidents[0].updates.map((u)=>u.message),['We are investigating elevated checkout errors.']);

  r=await owner.client.request(`/api/v1/organizations/${org.id}/incidents/${incident.id}/resolve`,{method:'POST',body:{}});assert.equal(r.res.status,200);assert.equal(r.json.data.status,'RESOLVED');assert.ok(r.json.data.resolvedAt);assert.equal(discord.length,3);
  r=await owner.client.request(`/api/v1/organizations/${org.id}/incidents/${incident.id}/postmortem`,{method:'PUT',body:{title:'Checkout incident postmortem',summary:'Summary',impact:'Checkout errors',rootCause:'Connection exhaustion',resolution:'Pool tuned',followUpActions:['Add saturation alert']}});assert.equal(r.res.status,200);assert.equal(r.json.data.rootCause,'Connection exhaustion');

  r=await h.client().request('/api/v1/public/status/acme-status');assert.equal(r.json.data.overallStatus,'OPERATIONAL');assert.equal(r.json.data.activeIncidents.length,0);assert.equal(r.json.data.recentIncidents.length,1);

  r=await h.client().request('/api/v1/alerts',{method:'POST',headers:{'x-relay-alert-key':'test-alert-key-123'},body:{organizationSlug:org.slug,source:'synthetic-monitor',externalId:'a-1',title:'Checkout latency',description:'p95 high',severity:'warning',serviceIdentifier:service.slug,metadata:{region:'eu'},timestamp:new Date().toISOString()}});assert.equal(r.res.status,202);const firstAlert=r.json.data.id;
  r=await h.client().request('/api/v1/alerts',{method:'POST',headers:{'x-relay-alert-key':'test-alert-key-123'},body:{organizationSlug:org.slug,source:'synthetic-monitor',externalId:'a-1',title:'Checkout latency',severity:'warning',serviceIdentifier:service.id}});assert.equal(r.json.data.id,firstAlert,'external alert ID is idempotent per source/org');

  const outsider=await register(h.client,'outsider@example.com');r=await outsider.client.request(`/api/v1/organizations/${org.id}/incidents`);assert.equal(r.res.status,403);assert.equal(r.json.error.code,'FORBIDDEN');
});

test('resolved incidents cannot be silently reopened',async(t)=>{
  const h=await harness();t.after(()=>h.close());const owner=await register(h.client,'terminal@example.com');const org=await createOrg(owner,'Terminal Org');let r=await owner.client.request(`/api/v1/organizations/${org.id}/incidents`,{method:'POST',body:{title:'Terminal transition',severity:'SEV4',affectedServiceIds:[],affectedComponentIds:[]}});const incident=r.json.data;await owner.client.request(`/api/v1/organizations/${org.id}/incidents/${incident.id}/resolve`,{method:'POST',body:{}});r=await owner.client.request(`/api/v1/organizations/${org.id}/incidents/${incident.id}`,{method:'PATCH',body:{status:'INVESTIGATING'}});assert.equal(r.res.status,409);assert.equal(r.json.error.code,'INVALID_INCIDENT_TRANSITION');
});


test('Discord delivery failure is non-destructive and does not log webhook secrets',async(t)=>{
  const logged=[];const secret='super-secret-webhook-token';
  const h=await harness({fetchImpl:async()=>new Response('failure',{status:503}),logger:{warn(...args){logged.push(args.join(' '))},error(){}}});t.after(()=>h.close());
  const owner=await register(h.client,'discord-failure@example.com');const org=await createOrg(owner,'Discord Failure Org');
  let r=await owner.client.request(`/api/v1/organizations/${org.id}/integrations/discord`,{method:'PUT',body:{name:'Discord',webhookUrl:`https://discord.com/api/webhooks/123/${secret}`,enabled:true}});assert.equal(r.res.status,200);
  r=await owner.client.request(`/api/v1/organizations/${org.id}/incidents`,{method:'POST',body:{title:'Delivery failure incident',severity:'SEV3',affectedServiceIds:[],affectedComponentIds:[]}});assert.equal(r.res.status,201);assert.equal(r.json.warnings?.[0]?.code,'DISCORD_DELIVERY_FAILED');const incident=r.json.data;
  r=await owner.client.request(`/api/v1/organizations/${org.id}/incidents/${incident.id}/updates`,{method:'POST',body:{message:'Public update survives Discord failure.',isPublic:true}});assert.equal(r.res.status,201);assert.equal(r.json.warnings?.[0]?.code,'DISCORD_DELIVERY_FAILED');
  r=await owner.client.request(`/api/v1/organizations/${org.id}/incidents/${incident.id}/resolve`,{method:'POST',body:{}});assert.equal(r.res.status,200);assert.equal(r.json.data.status,'RESOLVED');assert.equal(r.json.warnings?.[0]?.code,'DISCORD_DELIVERY_FAILED');
  r=await owner.client.request(`/api/v1/organizations/${org.id}/incidents/${incident.id}`);assert.equal(r.res.status,200);assert.equal(r.json.data.status,'RESOLVED');assert.ok(r.json.data.updates.some((x)=>x.message==='Public update survives Discord failure.'));
  assert.equal(logged.some((line)=>line.includes(secret)),false);
  assert.equal(logged.length,3);
});
