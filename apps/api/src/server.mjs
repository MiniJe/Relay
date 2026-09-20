import { loadConfig } from './config.mjs';
import { createRelayServer } from './app.mjs';
import { createPostgresStore } from '../../../packages/database/postgres-store.mjs';
import { MemoryStore } from '../../../packages/database/memory-store.mjs';

const config=loadConfig();
const useMemory=process.env.RELAY_STORE==='memory';
if(!useMemory&&!config.databaseUrl){console.error('DATABASE_URL is required unless RELAY_STORE=memory is explicitly selected.');process.exit(1)}
const store=useMemory?new MemoryStore():await createPostgresStore(config.databaseUrl);
const server=createRelayServer({store,config});
server.listen(config.port,()=>console.log(`Relay 0.1 listening on ${config.appOrigin} (${useMemory?'memory verification store':'PostgreSQL'})`));

async function shutdown(signal){
  console.log(`${signal} received; shutting down.`);
  server.close(async()=>{try{await store.close?.()}finally{process.exit(0)}});
  setTimeout(()=>process.exit(1),10_000).unref();
}
process.on('SIGTERM',()=>shutdown('SIGTERM'));
process.on('SIGINT',()=>shutdown('SIGINT'));
