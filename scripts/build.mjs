import { execFileSync } from 'node:child_process';
import { readdir, stat, access } from 'node:fs/promises';
import path from 'node:path';

const required=['README.md','LICENSE','.env.example','.dockerignore','package-lock.json','docker-compose.yml','Dockerfile','docs/ARCHITECTURE.md','docs/DEVELOPMENT.md','docs/API.md','docs/SECURITY.md','docs/RELAY-0.1.md','docs/RELAY-0.2.md','docs/ONCALL.md','apps/web/public/index.html','apps/web/public/app.js','apps/web/public/styles.css','apps/api/src/server.mjs','packages/database/migrations/001_initial.sql','packages/database/migrations/002_alert_routing_oncall.sql','.github/workflows/release-verification.yml','scripts/production-e2e.mjs','scripts/browser-smoke.mjs','scripts/verify-release-surface.mjs','packages/shared/oncall.mjs','apps/api/src/routing.mjs'];
for(const file of required){try{await access(file)}catch{throw new Error(`Required build artifact missing: ${file}`)}}
async function walk(dir){const out=[];for(const entry of await readdir(dir)){const full=path.join(dir,entry);const info=await stat(full);if(info.isDirectory())out.push(...await walk(full));else if(/\.(mjs|js)$/.test(full))out.push(full)}return out}
const files=[...await walk('apps'),...await walk('packages'),...await walk('scripts')];
for(const file of files)execFileSync(process.execPath,['--check',file],{stdio:'pipe'});
await import('../apps/api/src/openapi.mjs');await import('../packages/shared/domain.mjs');
// The reported release version must agree with the published package version, so
// the API, the OpenAPI document, the startup banner and npm can never drift.
const {RELAY_VERSION}=await import('../packages/shared/version.mjs');
const {readFile}=await import('node:fs/promises');
const manifest=JSON.parse(await readFile('package.json','utf8'));
if(manifest.version!==RELAY_VERSION)throw new Error(`Version mismatch: package.json is ${manifest.version} but RELAY_VERSION is ${RELAY_VERSION}`);
console.log(`Build verification passed: ${files.length} JavaScript modules parsed; required Relay 0.2 artifacts present.`);
