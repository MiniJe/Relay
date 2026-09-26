import { execFileSync } from 'node:child_process';
import { readdir, stat, access, readFile } from 'node:fs/promises';
import path from 'node:path';

const required=['README.md','LICENSE','.env.example','.dockerignore','package-lock.json','docker-compose.yml','Dockerfile','docs/ARCHITECTURE.md','docs/DEVELOPMENT.md','docs/API.md','docs/SECURITY.md','docs/RELAY-0.1.md','docs/RELAY-0.2.md','docs/ONCALL.md','apps/web/public/index.html','apps/web/public/app.js','apps/web/public/styles.css','apps/api/src/server.mjs','packages/database/migrations/001_initial.sql','packages/database/migrations/002_alert_routing_oncall.sql','.github/workflows/release-verification.yml','scripts/production-e2e.mjs','scripts/browser-smoke.mjs','scripts/verify-release-surface.mjs','packages/shared/oncall.mjs','apps/api/src/routing.mjs'];
for(const file of required){try{await access(file)}catch{throw new Error(`Required build artifact missing: ${file}`)}}
async function walk(dir){const out=[];for(const entry of await readdir(dir)){const full=path.join(dir,entry);const info=await stat(full);if(info.isDirectory())out.push(...await walk(full));else if(/\.(mjs|js)$/.test(full))out.push(full)}return out}
const files=[...await walk('apps'),...await walk('packages'),...await walk('scripts')];
for(const file of files)execFileSync(process.execPath,['--check',file],{stdio:'pipe'});
await import('../apps/api/src/openapi.mjs');await import('../packages/shared/domain.mjs');
// Browser-qualification payloads are JavaScript source strings handed to CDP
// `Runtime.evaluate`. A regex escape written inside the surrounding template
// literal is consumed before the browser ever sees it (`/Europe\/Bucharest/`
// arrives as `/Europe/Bucharest/`), which only fails in CI, minutes into a run.
// Parse every payload here so the mistake fails the build instead.
{
  const smoke=await readFile('scripts/browser-smoke.mjs','utf8');
  const unescape=(text)=>text.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g,(match,char)=>{
    const simple={n:'\n',t:'\t',r:'\r',b:'\b',f:'\f',v:'\v','0':'\0'}[char];
    if(simple!==undefined)return simple;
    if(char[0]==='u'||char[0]==='x')return String.fromCodePoint(parseInt(char[char[1]==='{'?2:1],16));
    return char; // \` \$ \\ and any other \x collapses to x, exactly as JS does
  });
  const payloads=[];
  for(let cursor=0;cursor<smoke.length;cursor+=1){
    const start=smoke.indexOf('page.evaluate(`',cursor);
    if(start<0)break;
    let index=start+'page.evaluate(`'.length;
    const bodyStart=index;
    while(index<smoke.length){
      if(smoke[index]==='\\'){index+=2;continue}
      if(smoke[index]==='`')break;
      index+=1;
    }
    const rendered=unescape(smoke.slice(bodyStart,index)).replace(/\$\{[^{}]*\}/g,'SMOKE_PLACEHOLDER');
    payloads.push({line:smoke.slice(0,bodyStart).split('\n').length,rendered});
    cursor=index;
  }
  for(const payload of payloads){
    // Wrap in an arrow body so the payload is parsed but never executed here.
    try{execFileSync(process.execPath,['--input-type=module','-e',`const probe = () => (${payload.rendered});`],{stdio:'pipe'})}
    catch(error){throw new Error(`browser-smoke.mjs line ${payload.line}: the CDP evaluate payload is not valid JavaScript once the surrounding template literal is processed. Regex escapes are consumed by that template before the browser ever sees them. ${String(error.stderr??'').split('\n').slice(0,4).join(' ')}`)}
  }
  console.log(`Browser-qualification payloads verified: ${payloads.length} CDP evaluate expressions parse.`);
}

// The reported release version must agree with the published package version, so
// the API, the OpenAPI document, the startup banner and npm can never drift.
const {RELAY_VERSION}=await import('../packages/shared/version.mjs');
const manifest=JSON.parse(await readFile('package.json','utf8'));
if(manifest.version!==RELAY_VERSION)throw new Error(`Version mismatch: package.json is ${manifest.version} but RELAY_VERSION is ${RELAY_VERSION}`);
console.log(`Build verification passed: ${files.length} JavaScript modules parsed; required Relay 0.2 artifacts present.`);
