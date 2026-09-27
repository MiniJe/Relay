import { loadConfig } from './config.mjs';
import { createRelayServer } from './app.mjs';
import { createDeliveryWorker } from './worker.mjs';
import { createPostgresStore } from '../../../packages/database/postgres-store.mjs';
import { MemoryStore } from '../../../packages/database/memory-store.mjs';
import { RELAY_VERSION } from '../../../packages/shared/version.mjs';

const config=loadConfig();
const useMemory=process.env.RELAY_STORE==='memory';
if(!useMemory&&!config.databaseUrl){console.error('DATABASE_URL is required unless RELAY_STORE=memory is explicitly selected.');process.exit(1)}
const store=useMemory?new MemoryStore():await createPostgresStore(config.databaseUrl);

// The durable-delivery worker starts only after the store is ready, so it can
// never race the migration or claim against a half-open pool. The request path
// gets the same worker instance for its post-commit latency kick, which means a
// crash between the commit and the kick still leaves the page durable.
const worker=createDeliveryWorker({store,config,pollIntervalMs:config.workerIntervalMs,leaseSeconds:config.workerLeaseSeconds,batchSize:config.workerBatchSize});
const server=createRelayServer({store,config,worker});
// Bind all interfaces: the deployment runs in a container and the preview/health
// checks reach it through the container or sandbox network, never only loopback.
server.listen(config.port,'0.0.0.0',()=>console.log(`Relay ${RELAY_VERSION} listening on ${config.appOrigin} (${useMemory?'memory verification store':'PostgreSQL'})`));
if(config.workerEnabled!==false)worker.start();else console.log('Delivery worker disabled by RELAY_WORKER_ENABLED=false.');

async function shutdown(signal){
  console.log(`${signal} received; shutting down.`);
  // Stop claiming new work and let an in-flight pass finish before the pool
  // closes; a lease that does expire is recovered by whichever worker starts
  // next, because recovery is decided in PostgreSQL rather than in memory.
  await worker.stop().catch(()=>{});
  server.close(async()=>{try{await store.close?.()}finally{process.exit(0)}});
  setTimeout(()=>process.exit(1),10_000).unref();
}
process.on('SIGTERM',()=>shutdown('SIGTERM'));
process.on('SIGINT',()=>shutdown('SIGINT'));
