import { once } from 'node:events';
import { createRelayServer } from '../apps/api/src/app.mjs';
import { MemoryStore } from '../packages/database/memory-store.mjs';

export async function harness({fetchImpl=async()=>new Response('',{status:204}),logger={warn(){},error(){}}}={}){
  const store=new MemoryStore();
  const config={nodeEnv:'test',port:0,appOrigin:'http://127.0.0.1',databaseUrl:'',sessionCookieName:'relay_session',sessionTtlHours:168,alertIngestKey:'test-alert-key-123',integrationEncryptionKey:'test-integration-encryption-key',staticDir:new URL('../apps/web/public/',import.meta.url).pathname,trustProxy:false};
  const server=createRelayServer({store,config,fetchImpl,logger});
  server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();const base=`http://127.0.0.1:${address.port}`;config.appOrigin=base;
  const client=(cookie='')=>({
    async request(path,{method='GET',body,headers={}}={}){
      const res=await fetch(base+path,{method,headers:{...(body?{'content-type':'application/json'}:{}),...(cookie?{cookie}:{}),...headers},body:body?JSON.stringify(body):undefined});let json={};try{json=await res.json()}catch{}return{res,json,setCookie:res.headers.get('set-cookie')};
    }
  });
  return{store,server,base,client,close:()=>new Promise((resolve)=>server.close(resolve))};
}

export async function register(client,email='owner@example.com'){
  const result=await client().request('/api/v1/auth/register',{method:'POST',body:{displayName:'Owner',email,password:'relay-password-123'}});
  if(result.res.status!==201)throw new Error(JSON.stringify(result.json));
  const cookie=result.setCookie.split(';')[0];return{cookie,user:result.json.data.user,client:client(cookie)};
}

export async function createOrg(auth,name='Acme Operations'){
  const result=await auth.client.request('/api/v1/organizations',{method:'POST',body:{name}});if(result.res.status!==201)throw new Error(JSON.stringify(result.json));return result.json.data;
}
