// Dependency-free hosted-Chrome browser qualification for the standalone website.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = new URL('.', import.meta.url);
const base = 'http://127.0.0.1:4179/';
const shots = process.env.WEBSITE_SCREENSHOT_DIR || 'website/screenshots';
const chromePath = process.env.RELAY_BROWSER || '/usr/bin/google-chrome';
const viewports = [[1440,900],[1280,800],[768,1024],[390,844]];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let server, browser, profile, ws;
let id = 0;
const pending = new Map();
const errors = [];
function send(method, params = {}, sessionId) {
  const key = ++id;
  ws.send(JSON.stringify({id:key,method,params,...(sessionId ? {sessionId} : {})}));
  return new Promise((resolve,reject) => pending.set(key,{resolve,reject}));
}
async function until(check, label, timeout = 15000) {
  const start = Date.now();
  while (Date.now()-start < timeout) {
    const result = await check();
    if (result) return result;
    await delay(120);
  }
  throw Error(`Timed out: ${label}`);
}
async function evaluate(expression, session) {
  const result = await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},session);
  if (result.exceptionDetails) throw Error(`JavaScript evaluation: ${result.exceptionDetails.text}`);
  return result.result.value;
}
function assert(ok, message) { if (!ok) throw Error(message); }
function log(label, fn) { return Promise.resolve().then(fn).then(() => console.log(`PASS ${label}`)); }
async function shot(name, session) {
  const {data} = await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false},session);
  await writeFile(path.join(shots,name),Buffer.from(data,'base64'));
}
async function positionSection(selector, session) {
  const position = await evaluate(`(() => {
    // The site uses smooth scrolling for visitors; evidence positioning must be immediate.
    document.documentElement.style.scrollBehavior = 'auto';
    const section = document.querySelector(${JSON.stringify(selector)});
    section.scrollIntoView({behavior:'instant',block:'start'});
    const rect = section.getBoundingClientRect();
    return {top:rect.top,bottom:rect.bottom,height:innerHeight};
  })()`,session);
  assert(Math.abs(position.top) <= 2 && position.bottom > 0,
    `${selector} is not aligned within the screenshot viewport: ${JSON.stringify(position)}`);
  console.log(`PASS screenshot position ${selector}: top=${position.top}`);
}
async function focusTab(session) { await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9},session); await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9},session); }
async function main() {
  await mkdir(shots,{recursive:true});
  server = spawn(process.execPath,['server.mjs'],{cwd:new URL('.',root),env:{...process.env,PORT:'4179'},stdio:['ignore','pipe','pipe']});
  server.stderr.on('data', b => process.stderr.write(b));
  await until(async () => {try {return (await fetch(base)).ok;} catch {return false;}},'website server');
  profile = await mkdtemp(path.join(os.tmpdir(),'relay-website-chrome-'));
  browser = spawn(chromePath,['--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-first-run','--disable-background-networking',`--user-data-dir=${profile}`,'--remote-debugging-port=0','about:blank'],{stdio:['ignore','ignore','pipe']});
  let stderr = '';
  browser.stderr.on('data', b => {stderr += b.toString();});
  const endpoint = await until(() => stderr.match(/DevTools listening on (ws:\/\/\S+)/)?.[1],`Chrome DevTools endpoint (${chromePath}): ${stderr}`);
  ws = new WebSocket(endpoint);
  await new Promise((resolve,reject) => { ws.addEventListener('open',resolve,{once:true}); ws.addEventListener('error',reject,{once:true}); });
  ws.addEventListener('message', e => {
    const m = JSON.parse(String(e.data));
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result);
    } else if (m.method === 'Runtime.exceptionThrown') errors.push(`exception: ${m.params.exceptionDetails.text}`);
    else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(`console: ${m.params.args.map(a => a.value ?? a.description).join(' ')}`);
    else if (m.method === 'Network.loadingFailed' && !m.params.canceled) errors.push(`resource: ${m.params.errorText}`);
    else if (m.method === 'Network.responseReceived' && m.params.response.url.startsWith(base) && m.params.response.status >= 400) errors.push(`HTTP ${m.params.response.status}: ${m.params.response.url}`);
  });
  const {targetId} = await send('Target.createTarget',{url:'about:blank'});
  const {sessionId:s} = await send('Target.attachToTarget',{targetId,flatten:true});
  await Promise.all(['Page.enable','Runtime.enable','Network.enable'].map(method => send(method,{},s)));
  for (const [width,height] of viewports) {
    const label = `${width}x${height}`;
    await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false},s);
    await send('Page.navigate',{url:base},s);
    await until(async () => evaluate('document.readyState === "complete" && !!document.querySelector(".footer")',s),`page loaded ${label}`);
    await log(label, async () => {
      const result = await evaluate(`(() => {
        const w = innerWidth, rect = e => e.getBoundingClientRect();
        const names = ['.site-header','nav','.hero h1','.hero-demo','.record','.record-line','.tag','.timeline','.terminal','.resource-list','.footer'];
        const bad = names.flatMap(name => [...document.querySelectorAll(name)].filter(e => { const r = rect(e); return r.left < -2 || r.right > w+2 || r.width < 1; }).map(e => name+' '+JSON.stringify({left:Math.round(rect(e).left),right:Math.round(rect(e).right)})));
        const heading = document.querySelector('.hero h1');
        if (heading.getBoundingClientRect().left < -2 || heading.getBoundingClientRect().right > w+2 || getComputedStyle(heading).overflow !== 'visible') bad.push('hero heading clipped');
        if (document.documentElement.scrollWidth > w+2) bad.push('page overflow: '+document.documentElement.scrollWidth+' > '+w);
        if (document.querySelector('nav').getBoundingClientRect().height < 16 || [...document.querySelectorAll('nav a')].some(a => a.getBoundingClientRect().width < 28)) bad.push('navigation too small');
        if (getComputedStyle(document.querySelector('.demo-public')).display === 'none') bad.push('public demo hidden');
        if (getComputedStyle(document.querySelector('.demo-internal')).display === 'none') bad.push('internal demo hidden');
        if (document.querySelector('.terminal pre').scrollWidth > document.querySelector('.terminal pre').clientWidth+2 && getComputedStyle(document.querySelector('.terminal pre')).overflowX !== 'auto') bad.push('terminal not scrollable');
        return bad;
      })()`,s);
      assert(result.length === 0, `${label}: ${result.join('; ')}`);
    });
    if (width === 1440) {
      await shot('desktop-hero-1440x900.png',s);
      await positionSection('#product',s);
      await shot('desktop-product-or-workflow.png',s);
      await positionSection('#self-host',s);
      await shot('desktop-self-host.png',s);
    }
    if (width === 390) await shot('mobile-390x844.png',s);
  }
  await send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false},s);
  await send('Page.navigate',{url:base},s);
  await until(async () => evaluate('document.readyState === "complete"',s),'keyboard page load');
  await log('keyboard/focus',async () => {
    await focusTab(s);
    const skip = await evaluate('({text:document.activeElement.textContent.trim(),href:document.activeElement.getAttribute("href"),visible:document.activeElement.getBoundingClientRect().top >= 0,outline:getComputedStyle(document.activeElement).outlineStyle})',s);
    assert(skip.href === '#main' && skip.visible && skip.outline !== 'none',`skip link: ${JSON.stringify(skip)}`);
    await focusTab(s);
    const brand = await evaluate('document.activeElement.className',s);
    assert(brand === 'brand',`brand not keyboard reachable: ${brand}`);
    await focusTab(s);
    const nav = await evaluate('document.activeElement.closest("nav") !== null && getComputedStyle(document.activeElement).outlineStyle !== "none"',s);
    assert(nav,'navigation link not focused with visible outline');
    for (let i=0;i<35;i++) await focusTab(s);
    assert(await evaluate('document.activeElement !== null',s),'keyboard trap');
    assert(await evaluate('!!document.querySelector("main#main") && !!document.querySelector("header nav") && !!document.querySelector("footer") && !!document.querySelector(".status-indicator").textContent.trim()',s),'landmark or status label missing');
  });
  await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]},s);
  await log('reduced motion',async () => assert(await evaluate('getComputedStyle(document.documentElement).scrollBehavior === "auto"',s),'smooth scrolling persists under reduced motion'));
  await log('console/runtime',async () => assert(errors.length === 0,errors.join('; ')));
  console.log(`PASS screenshots: ${shots}`);
}
try { await main(); } catch(e) { console.error(`FAIL ${e.stack || e.message}`); console.error(`::error::Website browser qualification: ${String(e.message).replaceAll('\n',' ')}`); process.exitCode = 1; }
finally { ws?.close(); browser?.kill(); server?.kill(); if(profile) await rm(profile,{recursive:true,force:true}); }
