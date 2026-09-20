import test from 'node:test';
import assert from 'node:assert/strict';
import { createOrg, harness, register } from './helpers.mjs';

test('E2E smoke: authenticate → service → component → incident → public page → resolve → postmortem',async(t)=>{
  const h=await harness();t.after(()=>h.close());const auth=await register(h.client,'e2e@example.com');const org=await createOrg(auth,'E2E Workspace');
  let r=await auth.client.request(`/api/v1/organizations/${org.id}/services`,{method:'POST',body:{name:'Authentication API'}});const service=r.json.data;
  r=await auth.client.request(`/api/v1/organizations/${org.id}/components`,{method:'POST',body:{name:'Authentication',serviceIds:[service.id]}});const component=r.json.data;
  await auth.client.request(`/api/v1/organizations/${org.id}/status-pages`,{method:'POST',body:{name:'E2E Status',slug:'e2e-status',componentIds:[component.id]}});
  r=await auth.client.request(`/api/v1/organizations/${org.id}/incidents`,{method:'POST',body:{title:'Login requests failing',severity:'SEV2',summary:'Elevated 5xx',affectedServiceIds:[service.id],affectedComponentIds:[component.id]}});const incident=r.json.data;
  await auth.client.request(`/api/v1/organizations/${org.id}/incidents/${incident.id}/updates`,{method:'POST',body:{message:'Investigating authentication errors.',isPublic:true}});
  r=await h.client().request('/api/v1/public/status/e2e-status');assert.equal(r.json.data.activeIncidents[0].title,'Login requests failing');assert.equal(r.json.data.components[0].effectiveState,'PARTIAL_OUTAGE');
  await auth.client.request(`/api/v1/organizations/${org.id}/incidents/${incident.id}/resolve`,{method:'POST',body:{}});
  r=await auth.client.request(`/api/v1/organizations/${org.id}/incidents/${incident.id}/postmortem`,{method:'PUT',body:{title:'Authentication incident review',summary:'Resolved',impact:'Login degradation',rootCause:'Pool exhaustion',resolution:'Capacity restored',followUpActions:['Load test pool']}});assert.equal(r.res.status,200);
  r=await h.client().request('/api/v1/public/status/e2e-status');assert.equal(r.json.data.overallStatus,'OPERATIONAL');assert.equal(r.json.data.recentIncidents.length,1);
});
