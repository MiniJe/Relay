import test from 'node:test';
import assert from 'node:assert/strict';
import { requireOrgRole } from '../apps/api/src/auth.mjs';

test('server-side authorization allows only declared organization roles', async()=>{
  const store={async getMembership(org,user){return org==='org-a'&&user==='viewer'?{organizationId:org,userId:user,role:'VIEWER'}:org==='org-a'&&user==='admin'?{organizationId:org,userId:user,role:'ADMIN'}:undefined}};
  await assert.doesNotReject(()=>requireOrgRole({store,userId:'viewer',organizationId:'org-a',allowed:['VIEWER','ADMIN']}));
  await assert.rejects(()=>requireOrgRole({store,userId:'viewer',organizationId:'org-a',allowed:['OWNER','ADMIN']}),(e)=>e.code==='FORBIDDEN'&&e.status===403);
  await assert.rejects(()=>requireOrgRole({store,userId:'admin',organizationId:'org-b',allowed:['OWNER','ADMIN']}),(e)=>e.code==='FORBIDDEN'&&e.status===403);
});


import { createOrg, harness, register } from './helpers.mjs';

test('representative OWNER/ADMIN/RESPONDER/VIEWER permissions and tenant-scoped commander references are enforced by API',async(t)=>{
  const h=await harness();t.after(()=>h.close());
  const owner=await register(h.client,'owner-authz@example.com');const org=await createOrg(owner,'Authz Org');
  const admin=await register(h.client,'admin-authz@example.com');
  const responder=await register(h.client,'responder-authz@example.com');
  const viewer=await register(h.client,'viewer-authz@example.com');
  const outsider=await register(h.client,'outsider-authz@example.com');const otherOrg=await createOrg(outsider,'Other Authz Org');
  const at=new Date().toISOString();
  h.store.memberships.push(
    {organizationId:org.id,userId:admin.user.id,role:'ADMIN',createdAt:at},
    {organizationId:org.id,userId:responder.user.id,role:'RESPONDER',createdAt:at},
    {organizationId:org.id,userId:viewer.user.id,role:'VIEWER',createdAt:at}
  );

  let r=await owner.client.request(`/api/v1/organizations/${org.id}/services`,{method:'POST',body:{name:'Owner Service'}});assert.equal(r.res.status,201);
  r=await admin.client.request(`/api/v1/organizations/${org.id}/services`,{method:'POST',body:{name:'Admin Service'}});assert.equal(r.res.status,201);
  r=await responder.client.request(`/api/v1/organizations/${org.id}/incidents`,{method:'POST',body:{title:'Responder incident',severity:'SEV3',affectedServiceIds:[],affectedComponentIds:[]}});assert.equal(r.res.status,201);
  r=await responder.client.request(`/api/v1/organizations/${org.id}/services`,{method:'POST',body:{name:'Forbidden responder service'}});assert.equal(r.res.status,403);
  r=await viewer.client.request(`/api/v1/organizations/${org.id}/services`);assert.equal(r.res.status,200);
  r=await viewer.client.request(`/api/v1/organizations/${org.id}/incidents`,{method:'POST',body:{title:'Forbidden viewer incident',severity:'SEV4',affectedServiceIds:[],affectedComponentIds:[]}});assert.equal(r.res.status,403);

  r=await viewer.client.request(`/api/v1/organizations/${otherOrg.id}/services`);assert.equal(r.res.status,403);
  r=await outsider.client.request(`/api/v1/organizations/${org.id}/components`,{method:'POST',body:{name:'Cross tenant component'}});assert.equal(r.res.status,403);

  r=await owner.client.request(`/api/v1/organizations/${org.id}/incidents`,{method:'POST',body:{title:'Invalid commander create',severity:'SEV4',commanderUserId:outsider.user.id,affectedServiceIds:[],affectedComponentIds:[]}});assert.equal(r.res.status,400);assert.equal(r.json.error.code,'INVALID_COMMANDER');
  r=await owner.client.request(`/api/v1/organizations/${org.id}/incidents`,{method:'POST',body:{title:'Valid commander incident',severity:'SEV4',affectedServiceIds:[],affectedComponentIds:[]}});assert.equal(r.res.status,201);const incident=r.json.data;
  r=await owner.client.request(`/api/v1/organizations/${org.id}/incidents/${incident.id}`,{method:'PATCH',body:{commanderUserId:outsider.user.id}});assert.equal(r.res.status,400);assert.equal(r.json.error.code,'INVALID_COMMANDER');
  r=await outsider.client.request(`/api/v1/organizations/${org.id}/incidents/${incident.id}`);assert.equal(r.res.status,403);
});
