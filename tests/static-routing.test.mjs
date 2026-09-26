import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { serveStatic, sendJson } from '../apps/api/src/http.mjs';

async function withStaticServer(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'relay-static-'));
  await writeFile(path.join(dir, 'index.html'), '<!doctype html><title>Relay shell</title><div id="app">Relay shell</div>');
  await writeFile(path.join(dir, 'app.js'), 'export const relayBoot = true;\n');
  await writeFile(path.join(dir, 'styles.css'), 'body { color: rgb(1, 2, 3); }\n');
  const server = createServer(async (req, res) => {
    if (req.url.startsWith('/api/')) return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'API route not found.' } });
    if (await serveStatic(req, res, dir)) return;
    sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Route not found.' } });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try { await run(`http://127.0.0.1:${address.port}`); }
  finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
}

async function get(base, pathname) {
  const response = await fetch(`${base}${pathname}`);
  return { response, body: await response.text() };
}

test('static assets win over application document routes and preserve MIME/body integrity', async () => {
  await withStaticServer(async (base) => {
    for (const pathname of ['/app.js', '/app.js?version=test']) {
      const { response, body } = await get(base, pathname);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') ?? '', /^text\/javascript\b/);
      assert.match(body, /relayBoot/);
      assert.doesNotMatch(body, /Relay shell/);
    }
    const css = await get(base, '/styles.css');
    assert.equal(css.response.status, 200);
    assert.match(css.response.headers.get('content-type') ?? '', /^text\/css\b/);
    assert.match(css.body, /rgb\(1, 2, 3\)/);
  });
});

test('only supported SPA document routes receive the application shell', async () => {
  await withStaticServer(async (base) => {
    for (const pathname of ['/', '/signin', '/register', '/app', '/app/', '/app/incidents/abc_123', '/app/escalations', '/app/alerts/alert_ab12cd', '/status/relay-cloud-status', '/status/relay-cloud-status/incidents/abc-123']) {
      const { response, body } = await get(base, pathname);
      assert.equal(response.status, 200, pathname);
      assert.match(response.headers.get('content-type') ?? '', /^text\/html\b/, pathname);
      assert.match(body, /Relay shell/, pathname);
    }
  });
});

test('missing assets and unsupported document-like paths return 404 instead of the shell', async () => {
  await withStaticServer(async (base) => {
    for (const pathname of ['/app-missing.js', '/app/missing.js', '/assets/missing.js', '/app/not-a-real-screen', '/app/alerts/a/b', '/app/escalations/extra', '/status/bad/extra/path', '/%E0%A4%A']) {
      const { response, body } = await get(base, pathname);
      assert.equal(response.status, 404, pathname);
      assert.doesNotMatch(body, /Relay shell/, pathname);
      assert.match(response.headers.get('content-type') ?? '', /^application\/json\b/, pathname);
    }
    const api = await get(base, '/api/v1/missing');
    assert.equal(api.response.status, 404);
    assert.match(api.response.headers.get('content-type') ?? '', /^application\/json\b/);
    assert.doesNotMatch(api.body, /Relay shell/);
  });
});

test('path traversal never serves files outside the static directory', async () => {
  await withStaticServer(async (base) => {
    for (const pathname of ['/../package.json', '/%2e%2e/package.json', '/assets/%2e%2e/%2e%2e/package.json']) {
      const response = await fetch(`${base}${pathname}`);
      assert.equal(response.status, 404, pathname);
    }
  });
});
