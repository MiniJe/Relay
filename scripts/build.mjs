import { execFileSync } from 'node:child_process';
import { readdir, stat, access } from 'node:fs/promises';
import path from 'node:path';

const required=['README.md','LICENSE','.env.example','.dockerignore','package-lock.json','docker-compose.yml','Dockerfile','docs/ARCHITECTURE.md','docs/DEVELOPMENT.md','docs/API.md','docs/SECURITY.md','docs/RELAY-0.1.md','apps/web/public/index.html','apps/web/public/app.js','apps/web/public/styles.css','apps/api/src/server.mjs','packages/database/migrations/001_initial.sql','.github/workflows/release-verification.yml','scripts/production-e2e.mjs'];
for(const file of required){try{await access(file)}catch{throw new Error(`Required build artifact missing: ${file}`)}}
async function walk(dir){const out=[];for(const entry of await readdir(dir)){const full=path.join(dir,entry);const info=await stat(full);if(info.isDirectory())out.push(...await walk(full));else if(/\.(mjs|js)$/.test(full))out.push(full)}return out}
const files=[...await walk('apps'),...await walk('packages'),...await walk('scripts')];
for(const file of files)execFileSync(process.execPath,['--check',file],{stdio:'pipe'});
await import('../apps/api/src/openapi.mjs');await import('../packages/shared/domain.mjs');
console.log(`Build verification passed: ${files.length} JavaScript modules parsed; required Relay 0.1 artifacts present.`);
