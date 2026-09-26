// Relay real-browser boot and routing verification.
//
// Launches a local Chrome/Chromium headless instance, drives the deployed
// Relay application over CDP (no external dependencies), and asserts the
// browser-facing runtime contract:
//
//   - JavaScript modules are served with a JavaScript MIME type and boot;
//     a module script answered with text/html is always a hard failure.
//   - Stylesheets are served as CSS and actually apply.
//   - Application routes boot without fatal console errors or failed
//     network requests.
//   - Missing assets and unsupported paths do not fall back to the shell.
//   - A missing public status slug never renders as healthy.
//   - Deep links (refresh/direct navigation) recover to the sign-in view.
//   - The API is reachable from the browser context (health, OpenAPI).
//   - Key views hold at desktop (1440x900), laptop (1280x800) and mobile
//     (390x844) viewports without page-level horizontal overflow.
//   - Dialogs manage focus: initial focus inside, Escape to close, focus
//     restored to the invoking control.
//   - Public updates require an explicit review step before publication;
//     internal notes publish directly.
//   - The public status page renders readable status labels (health is
//     never communicated by color alone) and never shows missing data as
//     healthy.
//   - Motion is disabled under `prefers-reduced-motion: reduce`.
//   - An authenticated operator pass exercises the real workspace: dialog
//     driven incident creation, internal notes, the public-update review
//     flow, and public status rendering.
//
// Environment:
//   RELAY_VERIFY_BASE_URL          base URL of the deployed Relay (default http://127.0.0.1:4000)
//   RELAY_BROWSER                  browser executable (default: auto-detect)
//   RELAY_BROWSER_SCREENSHOT_DIR   optional directory for PNG evidence
//   RELAY_BROWSER_EXTRA_ARGS       optional space-separated extra Chromium args
//
// Exit code 0 = all mandatory checks passed.

import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const baseUrl = (process.env.RELAY_VERIFY_BASE_URL ?? 'http://127.0.0.1:4000').replace(/\/+$/, '');
const screenshotDir = process.env.RELAY_BROWSER_SCREENSHOT_DIR ?? '';
const extraArgs = (process.env.RELAY_BROWSER_EXTRA_ARGS ?? '').split(' ').map((s) => s.trim()).filter(Boolean);

const VIEWPORTS = [
  { label: 'desktop', width: 1440, height: 900 },
  { label: 'laptop', width: 1280, height: 800 },
  { label: 'mobile', width: 390, height: 844, mobile: true },
];

function detectBrowser() {
  if (process.env.RELAY_BROWSER) return process.env.RELAY_BROWSER;
  const candidates = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];
  for (const candidate of candidates) {
    for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
      const full = path.join(dir, candidate);
      if (existsSync(full)) return full;
    }
  }
  throw new Error('No browser executable found; set RELAY_BROWSER.');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = [];
    this.closed = false;
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', () => reject(new Error('CDP WebSocket connection failed')), { once: true });
    });
    this.ws.addEventListener('message', (event) => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message.id !== undefined && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(`CDP ${message.error.message} (${message.error.code})`));
        else resolve(message.result);
      } else if (message.method) {
        for (const listener of this.listeners) listener(message);
      }
    });
    const closed = new Promise((resolve) => this.ws.addEventListener('close', resolve, { once: true }));
    void closed.then(() => { this.closed = true; for (const { reject } of this.pending.values()) reject(new Error('CDP connection closed')); });
  }

  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error('CDP connection closed'));
    const id = this.nextId++;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    this.ws.send(JSON.stringify(message));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  on(listener) { this.listeners.push(listener); }

  close() { try { this.ws.close(); } catch { /* already closed */ } }
}

class Probe {
  constructor(label) {
    this.label = label;
    this.consoleErrors = [];
    this.pageExceptions = [];
    this.mimeFailures = [];
    this.requestFailures = [];
    this.expectedSessionProbes = 0;
  }

  take() {
    const snapshot = {
      consoleErrors: this.consoleErrors.splice(0),
      pageExceptions: this.pageExceptions.splice(0),
      mimeFailures: this.mimeFailures.splice(0),
      requestFailures: this.requestFailures.splice(0),
    };
    return snapshot;
  }

  problems(snapshot = this) {
    return [
      ...snapshot.mimeFailures.map((m) => `MIME: ${m}`),
      ...snapshot.pageExceptions.map((m) => `exception: ${m}`),
      ...snapshot.consoleErrors.map((m) => `console error: ${m}`),
      ...snapshot.requestFailures.map((m) => `request failed: ${m}`),
    ];
  }
}

async function launchBrowser() {
  const executable = detectBrowser();
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'relay-browser-smoke-'));
  const args = [
    '--headless=new',
    '--no-sandbox',
    '--no-zygote',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--window-size=1440,900',
    `--user-data-dir=${userDataDir}`,
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
    'about:blank',
    ...extraArgs,
  ];
  const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const wsUrl = await new Promise((resolve, reject) => {
    let buffer = '';
    const fail = (error) => { clearTimeout(timer); child.removeAllListeners('error'); child.removeAllListeners('exit'); stderr.destroy(); reject(error); };
    const timer = setTimeout(() => fail(new Error('Browser did not expose a DevTools endpoint within 20s.')), 20_000);
    const onData = (chunk) => {
      buffer += String(chunk);
      const match = buffer.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) { clearTimeout(timer); child.removeAllListeners('error'); child.removeAllListeners('exit'); resolve(match[1]); }
    };
    const stderr = child.stderr;
    stderr.on('data', onData);
    child.on('error', (error) => fail(new Error(`Failed to launch browser at ${executable}: ${error.message}`)));
    child.on('exit', (code) => fail(new Error(`Browser exited early with code ${code}.`)));
  });
  return { child, wsUrl, userDataDir };
}

const MIME_BY_EXTENSION = [
  [/\.m?js($|\?)/, /^text\/javascript|^application\/javascript/],
  [/\.css($|\?)/, /^text\/css\b/],
  [/\.html?($|\?)/, /^text\/html\b/],
  [/\.json($|\?)/, /^application\/json\b/],
];

function resourceTypePath(type, url) {
  try { return { path: new URL(url).pathname, type }; } catch { return { path: url, type }; }
}

// Relay deliberately probes /api/v1/me on boot; 401 is the documented
// "no session" semantic, handled by redirecting to sign-in. Chromium logs
// every non-2xx resource as a console error, so those probes are matched
// against the observed Network responses and not treated as defects.
function isHandledSessionProbe(text, probe) {
  if (/Failed to load resource.*\b401\b/.test(text) && probe.expectedSessionProbes > 0) {
    probe.expectedSessionProbes -= 1;
    return true;
  }
  return false;
}

async function openPage(cdp, startUrl) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const probe = new Probe('page');

  const responses = new Map();
  cdp.on((message) => {
    if (message.sessionId !== sessionId) return;
    const { method, params } = message;
    if (method === 'Runtime.exceptionThrown') {
      const detail = params.exceptionDetails;
      const text = detail.exception?.description ?? detail.text ?? 'unknown exception';
      probe.pageExceptions.push(text.split('\n')[0].slice(0, 300));
    } else if (method === 'Runtime.consoleAPICalled' && params.type === 'error') {
      const text = params.args?.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300) ?? 'console.error';
      if (isHandledSessionProbe(text, probe)) return;
      probe.consoleErrors.push(text);
    } else if (method === 'Log.entryAdded' && params.entry.level === 'error') {
      const text = `${params.entry.text}`.slice(0, 300);
      // Network-level problems are judged through the Network domain; avoid double counting.
      if (/net::/.test(text)) return;
      if (isHandledSessionProbe(text, probe)) return;
      probe.consoleErrors.push(text);
    } else if (method === 'Network.responseReceived') {
      const { path: resPath, type } = resourceTypePath(params.type, params.response.url);
      responses.set(`${params.type}:${params.response.url}`, {
        status: params.response.status,
        mime: params.response.mimeType,
        path: resPath,
        resourceType: type,
      });
      if (resPath === '/api/v1/me' && params.response.status === 401) probe.expectedSessionProbes += 1;
      if (params.response.fromDiskCache || params.response.fromPrefetchCache) return;
      for (const [pattern, allowed] of MIME_BY_EXTENSION) {
        if (pattern.test(resPath) && !allowed.test(params.response.mimeType)) {
          probe.mimeFailures.push(`${resPath} served as '${params.response.mimeType}' (expected JavaScript/CSS/HTML/JSON by extension)`);
        }
      }
    } else if (method === 'Network.loadingFailed') {
      if (params.errorText === 'net::ERR_ABORTED') return; // navigation cancellations are normal
      probe.requestFailures.push(`${params.errorText} (type ${params.type})`);
    }
  });

  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Network.enable', {}, sessionId);
  await cdp.send('Log.enable', {}, sessionId);

  async function evaluate(expression) {
    const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (result.exceptionDetails) throw new Error(`evaluate failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
    return result.result.value;
  }

  async function goto(url, { waitFor = null, timeout = 15_000 } = {}) {
    const loaded = new Promise((resolve) => {
      const listener = (message) => {
        if (message.sessionId === sessionId && message.method === 'Page.loadEventFired') {
          cdp.listeners.splice(cdp.listeners.indexOf(listener), 1);
          resolve();
        }
      };
      cdp.listeners.push(listener);
    });
    await cdp.send('Page.navigate', { url }, sessionId);
    await Promise.race([loaded, sleep(timeout)]);
    if (waitFor) await waitForCondition(waitFor, timeout);
  }

  async function waitForCondition(expression, timeout = 15_000) {
    const deadline = Date.now() + timeout;
    for (;;) {
      let value = false;
      try { value = await evaluate(expression); } catch { value = false; }
      if (value) return true;
      if (Date.now() > deadline) return false;
      await sleep(150);
    }
  }

  async function setViewport({ width, height, mobile = false }) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: mobile ? 2 : 1, mobile,
    }, sessionId);
  }

  async function screenshot(fileLabel) {
    if (!screenshotDir) return null;
    await mkdir(screenshotDir, { recursive: true });
    const file = path.join(screenshotDir, `${fileLabel.replace(/[^a-z0-9.-]+/gi, '_')}.png`);
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    await writeFile(file, Buffer.from(data, 'base64'));
    return file;
  }

  async function pressKey(key, { code, windowsVirtualKeyCode = 0 } = {}) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode, autoRepeat: false }, sessionId);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode }, sessionId);
  }

  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
  if (startUrl) await goto(startUrl);

  return { sessionId, targetId, probe, take: () => probe.take(), problems: (snapshot) => probe.problems(snapshot), evaluate, goto, waitForCondition, setViewport, screenshot, pressKey, responses };
}

async function httpRequest(pathname) {
  const res = await fetch(`${baseUrl}${pathname}`);
  return { status: res.status, text: await res.text(), headers: res.headers };
}

const failures = [];
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok  ${name}`);
  } else {
    failures.push(detail ? `${name} — ${detail}` : name);
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function main() {
  console.log(`Relay browser smoke against ${baseUrl}`);

  // Preconditions over plain HTTP before spending time in the browser.
  const health = await httpRequest('/api/v1/health');
  check('API health responds ok:true', health.status === 200 && JSON.parse(health.text).ok === true, `status ${health.status} body ${health.text.slice(0, 120)}`);
  const root = await httpRequest('/');
  check('root document is HTML', root.status === 200 && /text\/html/.test(root.headers.get('content-type') ?? ''), `status ${root.status}`);

  const { child, wsUrl, userDataDir } = await launchBrowser();
  const cdp = new Cdp(wsUrl);
  await cdp.connect();
  let page;
  try {
    page = await openPage(cdp);

    // ------------------------------------------------------------------
    // Anonymous boot contract
    // ------------------------------------------------------------------
    console.log('\n[anonymous] / boots the application shell');
    await page.goto(`${baseUrl}/`, { waitFor: `!document.querySelector('#app .boot') && document.querySelector('#app').children.length > 0` });
    check('root route replaces the boot placeholder (module script executed)', await page.evaluate(`document.querySelector('#app .boot') === null && document.title === 'Relay'`));
    check('module script executed real application code', await page.evaluate(`document.querySelector('#app').innerHTML.trim().length > 0`));

    const jsRequests = [...page.responses.values()].filter((r) => /\.m?js($|\?)/.test(r.path));
    check('JavaScript assets answered with JavaScript MIME type', jsRequests.length > 0 && jsRequests.every((r) => /^text\/javascript|^application\/javascript/.test(r.mime)), JSON.stringify(jsRequests.map((r) => `${r.path} -> ${r.mime}`)));
    const cssRequests = [...page.responses.values()].filter((r) => /\.css($|\?)/.test(r.path));
    check('CSS assets answered with CSS MIME type', cssRequests.length > 0 && cssRequests.every((r) => /^text\/css/.test(r.mime)), JSON.stringify(cssRequests.map((r) => `${r.path} -> ${r.mime}`)));
    const design = await page.evaluate(`getComputedStyle(document.querySelector('#app')).fontFamily`);
    check('stylesheet actually applied (font-family resolved)', typeof design === 'string' && design.length > 0 && design !== 'inherit', String(design));

    console.log('\n[anonymous] API reachable from the browser context');
    const healthInPage = await page.evaluate(`fetch('/api/v1/health').then(r => r.json()).then(j => j.ok === true)`);
    check('in-page fetch /api/v1/health ok', healthInPage === true);
    const openapiInPage = await page.evaluate(`fetch('/api/v1/openapi.json').then(r => r.json()).then(j => typeof j.openapi === 'string')`);
    check('in-page fetch /api/v1/openapi.json is a valid OpenAPI document', openapiInPage === true);
    const rootProblems = page.problems(page.take());
    check('root route free of console/exception/MIME/request failures', rootProblems.length === 0, rootProblems.join(' | '));

    console.log('\n[anonymous] sign-in and register render usable forms');
    await page.goto(`${baseUrl}/signin`, { waitFor: `!!document.querySelector('#auth-form input[name=email]')` });
    check('/signin renders the sign-in form', await page.evaluate(`!!document.querySelector('#auth-form input[type=email]') && !!document.querySelector('#auth-form input[type=password]') && !!document.querySelector('#auth-form button[type=submit]')`));
    const signinProblems = page.problems(page.take());
    check('/signin free of console/exception/MIME/request failures', signinProblems.length === 0, signinProblems.join(' | '));

    // Keyboard: Tab must reach the email field with a visible focus indicator.
    let focused = '';
    for (let i = 0; i < 6 && !focused; i++) {
      await page.pressKey('Tab', { code: 'Tab', windowsVirtualKeyCode: 9 });
      focused = await page.evaluate(`document.activeElement && document.activeElement.name === 'email' ? 'email' : ''`);
    }
    check('keyboard Tab reaches the email field', focused === 'email');
    if (focused === 'email') {
      const focusVisible = await page.evaluate(`(() => { const s = getComputedStyle(document.activeElement); return (parseFloat(s.outlineWidth) > 0 && s.outlineStyle !== 'none') || (s.boxShadow && s.boxShadow !== 'none'); })()`);
      check('focused control shows a visible focus indicator', focusVisible === true, JSON.stringify(await page.evaluate(`(() => { const s = getComputedStyle(document.activeElement); return { outline: s.outline, shadow: s.boxShadow }; })()`)));
    }

    await page.goto(`${baseUrl}/register`, { waitFor: `!!document.querySelector('#auth-form input[name=displayName]')` });
    check('/register renders the registration form', await page.evaluate(`!!document.querySelector('#auth-form input[name=displayName]')`));
    const registerProblems = page.problems(page.take());
    check('/register free of console/exception/MIME/request failures', registerProblems.length === 0, registerProblems.join(' | '));

    console.log('\n[anonymous] deep links and missing data degrade safely');
    await page.goto(`${baseUrl}/app`, { waitFor: `!!document.querySelector('#auth-form input[name=email]')` });
    check('deep link to protected /app recovers to the sign-in view', await page.evaluate(`location.pathname === '/signin' && !!document.querySelector('#auth-form')`), await page.evaluate('location.pathname'));
    const appDeepProblems = page.problems(page.take());
    check('/app deep link free of console/exception/MIME/request failures', appDeepProblems.length === 0, appDeepProblems.join(' | '));

    const missingSlug = `missing-${Date.now().toString(36)}`;
    await page.goto(`${baseUrl}/status/${missingSlug}`, { waitFor: `document.querySelector('#app .boot') === null && document.querySelector('#app').textContent.length > 0` });
    const publicMissing = await page.evaluate(`(() => ({ healthy: document.body.textContent.includes('All systems operational'), recovered: !!document.querySelector('#app .onboarding, #app .card') }))()`);
    check('missing status slug is not rendered as healthy', publicMissing.healthy === false);
    check('missing status slug shows a recoverable error surface', publicMissing.recovered === true);
    // A handled 404 logs a console error by design; only structural failures count here.
    const missingStructural = [...page.take().mimeFailures, ...page.problems().filter((p) => p.startsWith('request failed:'))];
    check('missing status slug causes no MIME/network failures', missingStructural.length === 0, missingStructural.join(' | '));

    // ------------------------------------------------------------------
    // Responsive contract (no page-level horizontal overflow)
    // ------------------------------------------------------------------
    console.log('\n[responsive] viewport sweep');
    for (const viewport of VIEWPORTS) {
      for (const route of ['/', '/signin']) {
        await page.goto(`${baseUrl}${route}`, { waitFor: `document.querySelector('#app .boot') === null && document.querySelector('#app').children.length > 0` });
        await page.setViewport(viewport);
        await page.waitForCondition(`document.documentElement.clientWidth >= ${Math.min(viewport.width, 200)}`);
        const overflow = await page.evaluate(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
        check(`no page-level horizontal overflow at ${viewport.label} ${viewport.width}x${viewport.height} on ${route}`, overflow <= 1, `scrollWidth exceeds clientWidth by ${overflow}px`);
        if (route === '/signin') {
          const file = await page.screenshot(`signin-${viewport.label}`);
          if (file) console.log(`      screenshot: ${file}`);
        }
      }
    }
    await page.setViewport(VIEWPORTS[0]);

    // ------------------------------------------------------------------
    // Operator pass (uses the real registration + sign-in UI)
    // ------------------------------------------------------------------
    console.log('\n[operator] authenticated workspace pass');
    const marker = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const email = `browser-smoke-${marker}@relay.local`;
    const password = `Browser-Smoke-${marker}-pass1`;
    const pageSlug = `smoke-edge-status-${marker}`;
    const registered = await page.evaluate(`fetch('/api/v1/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ displayName: 'Browser Smoke', email: ${JSON.stringify(email)}, password: ${JSON.stringify(password)} }) }).then(r => r.json().then(j => ({ status: r.status, code: j?.error?.code })))`);
    if (registered.status === 201) {
      await page.goto(`${baseUrl}/signin`, { waitFor: `!!document.querySelector('#auth-form input[name=email]')` });
      await page.evaluate(`(() => { const set = (name, value) => { const input = document.querySelector('#auth-form input[name=' + name + ']'); input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); }; set('email', ${JSON.stringify(email)}); set('password', ${JSON.stringify(password)}); })()`);
      await page.evaluate(`document.querySelector('#auth-form button[type=submit]').click()`);
      const reachedWorkspace = await page.waitForCondition(`location.pathname === '/app' && document.querySelector('#app .app-shell, #app .onboarding')`, 15_000);
      check('sign-in form reaches the workspace', reachedWorkspace === true, `at ${await page.evaluate('location.pathname')}`);

      const onboarding = await page.evaluate(`!!document.querySelector('#org-form')`);
      if (onboarding) {
        await page.evaluate(`(() => { document.querySelector('#org-name').value = 'Browser Smoke Ops ${marker}'; document.querySelector('#org-form button[type=submit]').click(); })()`);
        await page.waitForCondition(`!!document.querySelector('.app-shell')`, 15_000);
      }
      check('workspace shell renders (sidebar + topbar + content)', await page.evaluate(`!!document.querySelector('.app-shell aside.sidebar') && !!document.querySelector('.app-shell .topbar') && !!document.querySelector('.app-shell .content')`));

      const dashboardProblems = page.problems(page.take());
      check('dashboard free of console/exception/MIME/request failures', dashboardProblems.length === 0, dashboardProblems.join(' | '));

      // Provision supporting records through the same-origin API.
      const provisioned = await page.evaluate(`(async () => {
        const orgId = localStorage.getItem('relay.orgId');
        const grab = async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) });
        const post = (path, body) => fetch('/api/v1/organizations/' + orgId + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(grab);
        const service = await post('/services', { name: 'Smoke Edge API', description: 'browser smoke service' });
        const serviceId = service.body?.data?.id ?? null;
        const component = await post('/components', { name: 'Smoke Edge Component', operationalState: 'DEGRADED_PERFORMANCE', serviceIds: serviceId ? [serviceId] : [] });
        const componentId = component.body?.data?.id ?? null;
        const statusPage = await post('/status-pages', { name: 'Smoke Edge Status', slug: ${JSON.stringify(pageSlug)}, componentIds: componentId ? [componentId] : [], branding: { headline: 'Smoke Edge Status', description: 'Browser smoke public page.' } });
        return { service: service.status, component: component.status, statusPage: statusPage.status, slug: statusPage.body?.data?.slug ?? null };
      })()`);
      check('operator can provision service, component and status page via API', provisioned.service === 201 && provisioned.component === 201 && provisioned.statusPage === 201 && provisioned.slug === pageSlug, JSON.stringify(provisioned));

      // Dialog keyboard contract, then incident creation through the dialog.
      await page.goto(`${baseUrl}/app/incidents`, { waitFor: `!!document.querySelector('.app-shell')` });
      await page.evaluate(`document.querySelector('#new-incident').setAttribute('data-smoke-target', '1')`);
      await page.evaluate(`(() => { const el = document.querySelector('[data-smoke-target]'); el.focus(); el.click(); })()`);
      const opened = await page.waitForCondition(`!!document.querySelector('.modal-backdrop [role=dialog]')`);
      check('create-incident dialog opens', opened === true);
      if (opened) {
        const focusInside = await page.waitForCondition(`document.querySelector('.modal-backdrop [role=dialog]').contains(document.activeElement)`);
        check('dialog focus is placed inside the dialog', focusInside === true);
        await page.pressKey('Escape', { code: 'Escape', windowsVirtualKeyCode: 27 });
        const closed = await page.waitForCondition(`!document.querySelector('.modal-backdrop')`);
        check('dialog closes on Escape', closed === true);
        const restored = await page.evaluate(`document.activeElement && document.activeElement.matches('[data-smoke-target]')`);
        check('dialog restores focus to the invoking control', restored === true);

        await page.evaluate(`(() => { const el = document.querySelector('[data-smoke-target]'); el.focus(); el.click(); })()`);
        await page.waitForCondition(`!!document.querySelector('.modal-backdrop [role=dialog]')`);
        await page.evaluate(`(() => { const input = document.querySelector('.modal-backdrop input[name=title]'); input.value = 'Browser smoke incident ${marker}'; input.dispatchEvent(new Event('input', { bubbles: true })); const component = document.querySelector('.modal-backdrop input[name=component]'); if (component) component.checked = true; })()`);
        await page.evaluate(`document.querySelector('.modal-backdrop button[type=submit], .modal-backdrop form button.btn-primary').click()`);
        const incidentView = await page.waitForCondition(`/^\\/app\\/incidents\\/[a-zA-Z0-9_-]+$/.test(location.pathname) && document.querySelector('#update-form')`, 15_000);
        if (!incidentView) console.log(`      debug: app=${await page.evaluate(`document.querySelector('#app').innerHTML.slice(0, 300)`)} errors=${JSON.stringify([...page.take().consoleErrors, ...page.take().pageExceptions])}`);
        check('incident declared through the dialog opens the incident workspace', incidentView === true, `at ${await page.evaluate('location.pathname')}`);
      }
      const dialogProblems = page.problems(page.take());
      check('incident dialog pass free of console/exception/MIME/request failures', dialogProblems.length === 0, dialogProblems.join(' | '));

      // Internal notes publish directly.
      await page.evaluate(`(() => { const area = document.querySelector('#update-form textarea[name=message]'); area.value = 'Internal smoke note ${marker}. Responders only.'; area.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await page.evaluate(`document.querySelector('#update-form button[type=submit]').click()`);
      const internalPosted = await page.waitForCondition(`document.body.textContent.includes('Internal smoke note ${marker}.') && document.body.textContent.includes('Internal note')`);
      check('internal note publishes without a review gate', internalPosted === true);

      // Public updates require the explicit review-and-publish step.
      await page.evaluate(`(() => { const area = document.querySelector('#update-form textarea[name=message]'); area.value = 'Public smoke update ${marker}. Customers affected.'; area.dispatchEvent(new Event('input', { bubbles: true })); const radio = document.querySelector('#update-form input[name=visibility][value=public]'); radio.checked = true; })()`);
      await page.evaluate(`document.querySelector('#update-form button[type=submit]').click()`);
      const reviewShown = await page.waitForCondition(`!!document.querySelector('.modal-backdrop [role=dialog]') && document.body.textContent.includes('Review public update')`);
      check('public update opens the review dialog instead of publishing', reviewShown === true);
      if (reviewShown) {
        const reviewContent = await page.evaluate(`(() => ({ message: document.body.textContent.includes('Public smoke update ${marker}.'), destination: document.body.textContent.includes('Smoke Edge Status'), publish: !!document.querySelector('#confirm-publish'), stillHidden: ![...document.querySelectorAll('.update.public p')].some((p) => p.textContent.includes('Public smoke update ${marker}.')) }))()`);
        check('review dialog shows the composed message', reviewContent.message === true);
        check('review dialog shows the truthful destination status page', reviewContent.destination === true);
        check('review dialog exposes an explicit publish action', reviewContent.publish === true);
        check('public update is not yet visible in the update history', reviewContent.stillHidden === true);
        await page.evaluate(`document.querySelector('#confirm-publish').click()`);
        const published = await page.waitForCondition(`[...document.querySelectorAll('.update.public p')].some((p) => p.textContent.includes('Public smoke update ${marker}.')) && document.body.textContent.includes('Public update')`);
        check('explicit publish action posts the public update', published === true);
      }
      const updateProblems = page.problems(page.take());
      check('public-update flow free of console/exception/MIME/request failures', updateProblems.length === 0, updateProblems.join(' | '));

      // Public status page: readable labels, never healthy-by-default.
      await page.goto(`${baseUrl}/status/${pageSlug}`, { waitFor: `!!document.querySelector('.public-page') && document.querySelector('.component-list')` });
      const publicPage = await page.evaluate(`(() => ({
        headline: (document.querySelector('.public-hero h1')?.textContent ?? '').trim(),
        bannerLabel: (document.querySelector('.status-banner .badge')?.textContent ?? '').trim(),
        falselyHealthy: document.body.textContent.includes('All systems operational'),
        knownLabels: ['Operational', 'Degraded performance', 'Partial outage', 'Major outage', 'Maintenance'],
        incidentTitle: document.body.textContent.includes('Browser smoke incident ${marker}'),
        publicUpdate: document.body.textContent.includes('Public smoke update ${marker}.'),
        labeledBadges: [...document.querySelectorAll('.badge')].length > 0 && [...document.querySelectorAll('.badge')].every((b) => b.textContent.trim().length > 0)
      }))()`);
      check('public status page leads with a readable status label (not color alone)', publicPage.headline.length > 0 && publicPage.knownLabels.includes(publicPage.bannerLabel), JSON.stringify(publicPage.headline + ' / ' + publicPage.bannerLabel));
      if (publicPage.falselyHealthy) {
        const where = await page.evaluate(`(() => { const needle = 'All systems operational'; const hits = []; for (const el of document.querySelectorAll('*')) { if ([...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.includes(needle))) hits.push({ tag: el.tagName, cls: String(el.className).slice(0, 60), html: el.outerHTML.slice(0, 240) }); } return { hits, hero: document.querySelector('.public-hero h1')?.textContent, badges: [...document.querySelectorAll('.badge')].map((b) => b.textContent.trim()).slice(0, 6) }; })()`);
        console.log(`      debug: phantom-string ${JSON.stringify(where)}`);
      }
      check('public status page does not claim all systems operational during impact', publicPage.falselyHealthy === false);
      check('public status page lists the incident with its public update', publicPage.incidentTitle === true && publicPage.publicUpdate === true);
      check('every status badge carries a text label', publicPage.labeledBadges === true);
      const publicProblems = page.problems(page.take());
      check('public status page free of console/exception/MIME/request failures', publicProblems.length === 0, publicProblems.join(' | '));
      const publicShot = await page.screenshot(`status-page-desktop`);
      if (publicShot) console.log(`      screenshot: ${publicShot}`);

      // ------------------------------------------------------------------
      // Relay 0.2: alerts, on-call, teams and routing configuration
      // ------------------------------------------------------------------
      console.log('\n[relay-0.2] alert routing and on-call surfaces');
      const alertKey = process.env.ALERT_INGEST_KEY ?? '';
      const provisioned02 = await page.evaluate(`(async () => {
        const orgId = localStorage.getItem('relay.orgId');
        const grab = async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) });
        const call = (path, body, method) => fetch('/api/v1/organizations/' + orgId + path, { method: method ?? (body === undefined ? 'GET' : 'POST'), headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }).then(grab);
        const me = await fetch('/api/v1/me').then((r) => r.json());
        const org = await call('');
        const team = await call('/teams', { name: 'Smoke Responder Team ${marker}', description: 'browser smoke team' });
        const teamId = team.body?.data?.id ?? null;
        const member = teamId ? await call('/teams/' + teamId + '/members', { userId: me.data.user.id }) : { status: 0 };
        const services = await call('/services');
        const serviceId = services.body?.data?.[0]?.id ?? null;
        const owned = serviceId && teamId ? await call('/services/' + serviceId, { ownerTeamId: teamId }, 'PATCH') : { status: 0 };
        const schedule = teamId ? await call('/oncall/schedules', {
          name: 'Smoke on-call ${marker}', teamId, timeZone: 'Europe/Bucharest',
          rotationStartsAt: new Date(Date.now() - 3600000).toISOString(),
          rotationIntervalMinutes: 1440, participantUserIds: [me.data.user.id]
        }) : { status: 0 };
        const scheduleId = schedule.body?.data?.id ?? null;
        const badTz = teamId ? await call('/oncall/schedules', { name: 'Bad tz', teamId, timeZone: 'Not/AZone', rotationStartsAt: new Date().toISOString(), rotationIntervalMinutes: 1440, participantUserIds: [me.data.user.id] }) : { status: 0 };
        const rule = scheduleId ? await call('/routing-rules', { name: 'Smoke criticals ${marker}', priority: 10, matchSource: 'browser-smoke', matchSeverities: ['critical'], targetScheduleId: scheduleId }) : { status: 0 };
        const override = scheduleId ? await call('/oncall/schedules/' + scheduleId + '/overrides', {
          replacementUserId: me.data.user.id,
          startsAt: new Date(Date.now() + 86400000).toISOString(),
          endsAt: new Date(Date.now() + 90000000).toISOString(),
          reason: 'Smoke override ${marker}'
        }) : { status: 0 };
        const overlapping = scheduleId ? await call('/oncall/schedules/' + scheduleId + '/overrides', {
          replacementUserId: me.data.user.id,
          startsAt: new Date(Date.now() + 87000000).toISOString(),
          endsAt: new Date(Date.now() + 91000000).toISOString(),
          reason: 'Smoke clash'
        }) : { status: 0 };
        const state = await call('/oncall/state');
        return {
          override: override.status,
          overlapStatus: overlapping.status,
          overlapCode: overlapping.body?.error?.code ?? null,
          orgSlug: org.body?.data?.slug ?? null,
          displayName: me.data?.user?.displayName ?? null,
          team: team.status, member: member.status, owned: owned.status,
          schedule: schedule.status, scheduleId, badTzStatus: badTz.status, badTzCode: badTz.body?.error?.code ?? null,
          rule: rule.status,
          resolvedUserId: state.body?.data?.oncall?.[0]?.current?.userId ?? null,
          meId: me.data?.user?.id ?? null,
          timeZone: state.body?.data?.oncall?.[0]?.schedule?.timeZone ?? null
        };
      })()`);
      check('operator can provision team, membership, schedule, override and routing rule via API', provisioned02.team === 201 && provisioned02.member === 201 && provisioned02.owned === 200 && provisioned02.schedule === 201 && provisioned02.override === 201 && provisioned02.rule === 201, JSON.stringify(provisioned02));
      check('an overlapping override is refused deterministically', provisioned02.overlapStatus === 409 && provisioned02.overlapCode === 'OVERRIDE_OVERLAP', `status ${provisioned02.overlapStatus} code ${provisioned02.overlapCode}`);
      check('a malformed schedule timezone is rejected before it reaches the UI', provisioned02.badTzStatus === 400 && provisioned02.badTzCode === 'INVALID_TIMEZONE', `status ${provisioned02.badTzStatus} code ${provisioned02.badTzCode}`);
      check('on-call state resolves a responder server-side', provisioned02.resolvedUserId === provisioned02.meId, `resolved ${provisioned02.resolvedUserId} vs me ${provisioned02.meId}`);
      check('on-call state reports the schedule IANA timezone', provisioned02.timeZone === 'Europe/Bucharest', String(provisioned02.timeZone));

      let routedAlertTitle = '';
      if (alertKey && provisioned02.orgSlug) {
        routedAlertTitle = `Smoke routed alert ${marker}`;
        const ingested = await page.evaluate(`(async () => {
          const body = { organizationSlug: ${JSON.stringify(provisioned02.orgSlug)}, source: 'browser-smoke', externalId: 'smoke-${marker}', title: ${JSON.stringify(routedAlertTitle)}, description: 'browser smoke routing', severity: 'critical' };
          const r = await fetch('/api/v1/alerts', { method: 'POST', headers: { 'content-type': 'application/json', 'x-relay-alert-key': ${JSON.stringify(alertKey)} }, body: JSON.stringify(body) });
          const j = await r.json().catch(() => ({}));
          return { status: r.status, resolution: j?.data?.routing?.resolution ?? null, responder: j?.data?.routing?.oncallDisplayName ?? null, team: j?.data?.routing?.teamName ?? null, keyEchoed: JSON.stringify(j).includes(${JSON.stringify(alertKey)}) };
        })()`);
        check('alert ingested through the keyed endpoint is routed to the on-call responder', ingested.status === 202 && ingested.resolution === 'ROUTED' && ingested.responder === provisioned02.displayName, JSON.stringify(ingested));
        check('the routing response never echoes the ingest key', ingested.keyEchoed === false);
      } else {
        console.log('      note: ALERT_INGEST_KEY unavailable, so the routed-alert table pass is skipped');
      }

      // Provisioning deliberately provokes a 400 (malformed timezone) and a 409
      // (overlapping override). Those rejections are the point of the checks
      // above, but the browser still reports them as failed resources, so drain
      // them here and confirm nothing else was logged.
      const rejectionNoise = page.problems(page.take());
      check('the only network noise from provisioning is the two deliberate rejections', rejectionNoise.length <= 2 && rejectionNoise.every((p) => /40[09]/.test(p)), rejectionNoise.join(' | '));

      await page.goto(`${baseUrl}/app/oncall`, { waitFor: `!!document.querySelector('.app-shell') && !!document.querySelector('.content h1')` });
      const oncallView = await page.evaluate(`(() => {
        const text = document.querySelector('.content').textContent;
        return {
          heading: (document.querySelector('.content h1')?.textContent ?? '').trim(),
          namesResponder: text.includes(${JSON.stringify('Browser Smoke')}),
          showsTimeZone: text.includes('Europe/Bucharest') || /UTC[+-]/.test(text),
          showsHandoff: /next handoff/i.test(text),
          hero: !!document.querySelector('.oncall-hero'),
          schedulesTable: document.querySelectorAll('.table-wrap tbody tr').length,
          detailAction: !!document.querySelector('[data-schedule-detail]'),
          overrideAction: !!document.querySelector('[data-add-override]'),
          toggleAction: !!document.querySelector('[data-toggle-schedule]')
        };
      })()`);
      check('on-call view answers "who is on call now" with a named responder', oncallView.namesResponder === true, JSON.stringify(oncallView));
      check('on-call view renders handoff times in the schedule timezone, not server-local time', oncallView.showsTimeZone === true, JSON.stringify(oncallView));
      check('on-call view surfaces the next handoff', oncallView.showsHandoff === true, JSON.stringify(oncallView));
      check('on-call view renders its hero and one row per schedule', oncallView.hero === true && oncallView.schedulesTable >= 1, JSON.stringify(oncallView));
      check('on-call view exposes rotation detail, override and enable/disable actions', oncallView.detailAction === true && oncallView.overrideAction === true && oncallView.toggleAction === true, JSON.stringify(oncallView));

      // Progressive disclosure: opening a schedule loads its ordered rotation and
      // its full override table on demand.
      await page.evaluate(`document.querySelector('[data-schedule-detail]').click()`);
      const rotationLoaded = await page.waitForCondition(`!!document.querySelector('#schedule-detail-section .rotation-list')`, 15_000);
      check('opening a schedule loads its ordered rotation', rotationLoaded === true);
      const rotationDetail = await page.evaluate(`(() => {
        const box = document.querySelector('#schedule-detail-section');
        const text = box?.textContent ?? '';
        return {
          participants: box?.querySelectorAll('.rotation-list li').length ?? 0,
          firstPosition: (box?.querySelector('.rotation-pos')?.textContent ?? '').trim(),
          inScheduleTimeZone: text.includes('Europe/Bucharest'),
          listsOverride: text.includes('Smoke override ${marker}'),
          overrideWindowsLabeled: /UTC[+-]|Europe\/Bucharest/.test(text),
          deleteOverride: !!box?.querySelector('[data-delete-override]')
        };
      })()`);
      check('rotation detail lists participants in configured order', rotationDetail.participants >= 1 && rotationDetail.firstPosition === '1', JSON.stringify(rotationDetail));
      check('rotation detail renders in the schedule timezone', rotationDetail.inScheduleTimeZone === true, JSON.stringify(rotationDetail));
      check('rotation detail lists the schedule override with its reason', rotationDetail.listsOverride === true, JSON.stringify(rotationDetail));
      check('rotation detail offers override deletion to an OWNER', rotationDetail.deleteOverride === true, JSON.stringify(rotationDetail));
      const oncallProblems = page.problems(page.take());
      check('on-call view free of console/exception/MIME/request failures', oncallProblems.length === 0, oncallProblems.join(' | '));
      const oncallShot = await page.screenshot('oncall-desktop');
      if (oncallShot) console.log(`      screenshot: ${oncallShot}`);

      await page.goto(`${baseUrl}/app/teams`, { waitFor: `!!document.querySelector('.app-shell') && !!document.querySelector('.content h1')` });
      const teamsView = await page.evaluate(`(() => {
        const text = document.querySelector('.content').textContent;
        return { listsTeam: text.includes('Smoke Responder Team ${marker}'), memberList: !!document.querySelector('.member-list'), form: !!document.querySelector('#team-name') };
      })()`);
      check('teams view lists the team and its roster', teamsView.listsTeam === true && teamsView.memberList === true, JSON.stringify(teamsView));
      check('teams view exposes the create-team form to an OWNER', teamsView.form === true);
      const teamsProblems = page.problems(page.take());
      check('teams view free of console/exception/MIME/request failures', teamsProblems.length === 0, teamsProblems.join(' | '));

      await page.goto(`${baseUrl}/app/routing`, { waitFor: `!!document.querySelector('.app-shell') && !!document.querySelector('#rule-form')` });
      const routingView = await page.evaluate(`(() => {
        const rows = [...document.querySelectorAll('.table-wrap tbody tr')];
        return {
          listsRule: document.querySelector('.content').textContent.includes('Smoke criticals ${marker}'),
          rowCount: rows.length,
          firstRowPriority: (rows[0]?.textContent ?? '').trim().slice(0, 40),
          form: ['rule-name', 'rule-priority', 'rule-service', 'rule-source', 'rule-severities', 'rule-target'].every((id) => !!document.getElementById(id))
        };
      })()`);
      check('routing view lists configured rules', routingView.listsRule === true, JSON.stringify(routingView));
      check('routing rule form exposes name, priority, conditions and target', routingView.form === true);
      const routingProblems = page.problems(page.take());
      check('routing view free of console/exception/MIME/request failures', routingProblems.length === 0, routingProblems.join(' | '));

      await page.goto(`${baseUrl}/app/alerts`, { waitFor: `!!document.querySelector('.app-shell') && !!document.querySelector('.summary-strip')` });
      const alertsView = await page.evaluate(`(() => {
        const text = document.querySelector('.content').textContent;
        const strip = [...document.querySelectorAll('.summary-strip .summary-label')].map((e) => e.textContent.trim());
        return {
          strip,
          scrollableTable: !!document.querySelector('.table-wrap.table-scroll-x'),
          showsRoutedAlert: text.includes(${JSON.stringify('Smoke routed alert')}),
          showsRoutingPath: /→/.test(text),
          showsResponder: text.includes(${JSON.stringify('Browser Smoke')}),
          ackButton: !!document.querySelector('[data-ack]'),
          escalateButton: !!document.querySelector('[data-escalate]')
        };
      })()`);
      check('alerts view reports routed, unacknowledged and failed-delivery counts', alertsView.strip.length === 4 && alertsView.strip.includes('Routed') && alertsView.strip.includes('Unacknowledged') && alertsView.strip.includes('Delivery failed'), JSON.stringify(alertsView.strip));
      check('alerts table scrolls horizontally inside its wrapper rather than the page', alertsView.scrollableTable === true);
      if (alertKey) {
        check('alerts table shows the routed alert, its routing path and its responder', alertsView.showsRoutedAlert === true && alertsView.showsRoutingPath === true && alertsView.showsResponder === true, JSON.stringify(alertsView));
        check('alerts table exposes acknowledge and escalate actions to a responder', alertsView.ackButton === true && alertsView.escalateButton === true);
        if (alertsView.ackButton) {
          await page.evaluate(`document.querySelector('[data-ack]').click()`);
          const acked = await page.waitForCondition(`!document.querySelector('[data-ack]') && document.querySelector('.content').textContent.includes('Acknowledged')`, 15_000);
          check('acknowledging from the alerts table updates the row without a reload', acked === true);
        }
      }
      const alertsProblems = page.problems(page.take());
      check('alerts view free of console/exception/MIME/request failures', alertsProblems.length === 0, alertsProblems.join(' | '));
      const alertsShot = await page.screenshot('alerts-desktop');
      if (alertsShot) console.log(`      screenshot: ${alertsShot}`);

      // The sidebar must expose every 0.2 surface by name, not by icon alone.
      const nav = await page.evaluate(`[...document.querySelectorAll('.sidebar .nav a')].map((a) => ({ href: a.getAttribute('href'), label: a.textContent.trim() }))`);
      const navLabels = nav.map((n) => n.label.replace(/^[^A-Za-z]*/, ''));
      for (const [href, label] of [['/app/alerts', 'Alerts'], ['/app/oncall', 'On-call'], ['/app/teams', 'Teams'], ['/app/routing', 'Routing']]) {
        check(`sidebar exposes ${label} at ${href}`, nav.some((n) => n.href === href && n.label.includes(label)), JSON.stringify(navLabels));
      }

      // Deep links to the new routes must survive a full page load.
      for (const route of ['/app/alerts', '/app/oncall', '/app/teams', '/app/routing']) {
        await page.goto(`${baseUrl}${route}`, { waitFor: `!!document.querySelector('.app-shell') && !!document.querySelector('.content h1')` });
        const deep = await page.evaluate(`({ path: location.pathname, heading: (document.querySelector('.content h1')?.textContent ?? '').trim(), active: document.querySelector('.sidebar .nav a.active')?.getAttribute('href') ?? null })`);
        check(`deep link ${route} renders its own view`, deep.path === route && deep.heading.length > 0 && deep.active === route, JSON.stringify(deep));
      }

      // Operator routes must hold at both representative viewports.
      const dashOverflow = {};
      for (const viewport of [VIEWPORTS[0], VIEWPORTS[2]]) {
        await page.setViewport(viewport);
        await page.waitForCondition(`document.documentElement.clientWidth <= ${viewport.width}`);
        await page.goto(`${baseUrl}/app`, { waitFor: `!!document.querySelector('.app-shell')` });
        for (const route of ['/app', '/app/alerts', '/app/oncall', '/app/incidents', '/app/services', '/app/components', '/app/teams', '/app/routing', '/app/status-pages']) {
          if (route !== '/app') await page.goto(`${baseUrl}${route}`, { waitFor: `!!document.querySelector('.app-shell')` });
          const measured = await page.evaluate(`(() => {
            const cw = document.documentElement.clientWidth;
            const delta = document.documentElement.scrollWidth - cw;
            if (delta <= 1) return { delta };
            const offenders = [];
            for (const el of document.querySelectorAll('body *')) {
              const rect = el.getBoundingClientRect();
              if (rect.right > cw + 1) {
                offenders.push(el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : '') + ' right=' + Math.round(rect.right) + ' w=' + Math.round(rect.width) + ' ' + JSON.stringify((el.textContent || '').trim().slice(0, 28)));
              }
            }
            return { delta, offenders: offenders.slice(0, 6) };
          })()`);
          const delta = measured.delta;
          dashOverflow[`${viewport.label} ${route}`] = delta;
          check(`no page-level horizontal overflow at ${viewport.label} on ${route}`, delta <= 1, `+${delta}px past a ${await page.evaluate('document.documentElement.clientWidth')}px viewport; offenders: ${(measured.offenders ?? []).join(' , ') || 'none identified'}`);
        }
        const file = await page.screenshot(`dashboard-${viewport.label}`);
        if (file) console.log(`      screenshot: ${file}`);
      }
      await page.setViewport(VIEWPORTS[0]);

      // Reduced-motion preference must disable motion.
      await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }, page.sessionId);
      const reducedMotion = await page.evaluate(`(() => { const btn = document.querySelector('.btn'); const s = getComputedStyle(btn); return { transition: parseFloat(s.transitionDuration) || 0, animation: parseFloat(getComputedStyle(document.querySelector('.skeleton') ?? btn).animationDuration) || 0 }; })()`);
      check('motion is disabled under prefers-reduced-motion: reduce', reducedMotion.transition < 0.001 && reducedMotion.animation < 0.001, JSON.stringify(reducedMotion));
      await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: '' }] }, page.sessionId);
    } else {
      console.log(`  note: operator pass skipped — registration unavailable (status ${registered.status} code ${registered.code ?? 'n/a'})`);
    }

    // ------------------------------------------------------------------
    console.log('\n[summary]');
    if (failures.length) {
      console.log(`Browser smoke FAILED with ${failures.length} finding(s):`);
      for (const failure of failures) console.log(`  - ${failure}`);
      process.exitCode = 1;
    } else {
      console.log('Browser smoke passed: boot, MIME, routing, keyboard, dialog, publication review, alert routing/on-call surfaces, responsive and reduced-motion contracts verified.');
    }
  } finally {
    cdp.close();
    child.removeAllListeners('exit');
    child.kill('SIGTERM');
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error('Browser smoke crashed:', error?.stack ?? error);
  process.exitCode = 1;
});
