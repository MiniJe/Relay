import { once } from 'node:events';
import { createRelayServer } from '../apps/api/src/app.mjs';
import { MemoryStore } from '../packages/database/memory-store.mjs';

export async function harness({fetchImpl=async()=>new Response(null,{status:204}),logger={warn(){},error(){},info(){}},transports={}}={}){
  const store=new MemoryStore();
  const config={nodeEnv:'test',port:0,appOrigin:'http://127.0.0.1',databaseUrl:'',sessionCookieName:'relay_session',sessionTtlHours:168,alertIngestKey:'test-alert-key-123',integrationEncryptionKey:'test-integration-encryption-key',staticDir:new URL('../apps/web/public/',import.meta.url).pathname,trustProxy:false};
  const server=createRelayServer({store,config,fetchImpl,logger,transports});
  server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();const base=`http://127.0.0.1:${address.port}`;config.appOrigin=base;
  const client=(cookie='')=>({
    async request(path,{method='GET',body,headers={}}={}){
      const res=await fetch(base+path,{method,headers:{...(body?{'content-type':'application/json'}:{}),...(cookie?{cookie}:{}),...headers},body:body?JSON.stringify(body):undefined});let json={};try{json=await res.json()}catch{}return{res,json,setCookie:res.headers.get('set-cookie')};
    }
  });
  return{store,server,base,client,config,fetchImpl,transports,close:()=>new Promise((resolve)=>server.close(resolve))};
}

export async function register(client,email='owner@example.com',displayName='Owner'){
  const result=await client().request('/api/v1/auth/register',{method:'POST',body:{displayName,email,password:'relay-password-123'}});
  if(result.res.status!==201)throw new Error(JSON.stringify(result.json));
  const cookie=result.setCookie.split(';')[0];return{cookie,user:result.json.data.user,client:client(cookie)};
}

export async function createOrg(auth,name='Acme Operations'){
  const result=await auth.client.request('/api/v1/organizations',{method:'POST',body:{name}});if(result.res.status!==201)throw new Error(JSON.stringify(result.json));return result.json.data;
}

/**
 * Relay 0.1 has no member-invitation API, so multi-role scenarios grant
 * organization membership directly on the verification store. This mirrors the
 * established pattern in authz.test.mjs and is a test harness shortcut only -
 * every authorization decision below is still enforced server-side.
 */
export function grantRole(harness, organizationId, auth, role) {
  harness.store.memberships.push({ organizationId, userId: auth.user.id, role, createdAt: new Date().toISOString() });
  return auth;
}

/** Register a user and immediately make them a member of `organizationId`. */
export async function registerMember(harness, organizationId, email, role = 'RESPONDER', displayName = 'Responder') {
  const auth = await register(harness.client, email, displayName);
  if (role !== 'OUTSIDER') grantRole(harness, organizationId, auth, role);
  return { ...auth, role, displayName };
}
