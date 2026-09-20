import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const mode = process.argv[2] ?? 'initial';
const baseUrl = (process.env.RELAY_VERIFY_BASE_URL ?? 'http://127.0.0.1:4000').replace(/\/$/, '');
const stateFile = process.env.RELAY_VERIFY_STATE_FILE ?? '/tmp/relay-production-e2e.json';

class Client {
  constructor() { this.cookie = ''; }
  async request(path, { method = 'GET', body, expected } = {}) {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.cookie) headers.cookie = this.cookie;
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0];
    let json = {};
    const text = await res.text();
    if (text) {
      try { json = JSON.parse(text); }
      catch { throw new Error(`${method} ${path} returned non-JSON ${res.status}: ${text.slice(0, 500)}`); }
    }
    if (expected !== undefined && res.status !== expected) {
      throw new Error(`${method} ${path} expected ${expected}, got ${res.status}: ${JSON.stringify(json)}`);
    }
    return { res, json };
  }
}

async function verifyHealthAndUi() {
  const health = await fetch(`${baseUrl}/api/v1/health`);
  assert.equal(health.status, 200, 'health endpoint must return 200');
  const healthBody = await health.json();
  assert.equal(healthBody.ok, true, 'health endpoint must report ok=true');

  const ui = await fetch(`${baseUrl}/`);
  assert.equal(ui.status, 200, 'UI root must load');
  assert.match(await ui.text(), /Relay/i, 'UI should contain Relay branding');
}

async function login(client, email, password) {
  const result = await client.request('/api/v1/auth/login', {
    method: 'POST',
    body: { email, password },
    expected: 200
  });
  return result.json.data;
}

async function initial() {
  await verifyHealthAndUi();
  const marker = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
  const email = `release-${marker}@example.com`;
  const password = `Relay-${crypto.randomBytes(12).toString('base64url')}!9a`;
  const statusSlug = `release-${marker}`.toLowerCase();
  const internalMessage = `INTERNAL-ONLY-${crypto.randomBytes(10).toString('hex')}`;
  const publicMessage = `Public release verification ${marker}`;
  const client = new Client();

  let r = await client.request('/api/v1/auth/register', {
    method: 'POST',
    body: { displayName: 'Relay Release Verifier', email, password },
    expected: 201
  });
  const user = r.json.data.user;
  assert.ok(user?.id);

  r = await client.request('/api/v1/organizations', {
    method: 'POST',
    body: { name: `Release Verification ${marker}` },
    expected: 201
  });
  const organization = r.json.data;

  r = await client.request(`/api/v1/organizations/${organization.id}/services`, {
    method: 'POST',
    body: { name: 'Verification API', description: 'Release closure service.' },
    expected: 201
  });
  const service = r.json.data;

  r = await client.request(`/api/v1/organizations/${organization.id}/components`, {
    method: 'POST',
    body: { name: 'Verification Component', description: 'Public release component.', serviceIds: [service.id] },
    expected: 201
  });
  const component = r.json.data;
  assert.deepEqual(component.serviceIds, [service.id], 'component/service mapping must persist');

  r = await client.request(`/api/v1/organizations/${organization.id}/status-pages`, {
    method: 'POST',
    body: {
      name: 'Release Verification Status',
      slug: statusSlug,
      componentIds: [component.id],
      branding: { headline: 'Relay Release Verification', description: 'Release closure status page.' }
    },
    expected: 201
  });
  const statusPage = r.json.data;

  r = await client.request(`/api/v1/organizations/${organization.id}/incidents`, {
    method: 'POST',
    body: {
      title: `Release verification incident ${marker}`,
      summary: 'Production-path verification incident.',
      severity: 'SEV2',
      commanderUserId: user.id,
      affectedServiceIds: [service.id],
      affectedComponentIds: [component.id]
    },
    expected: 201
  });
  let incident = r.json.data;
  assert.equal(incident.commanderUserId, user.id, 'commander must be assigned');
  assert.ok(incident.responders.some((x) => x.userId === user.id), 'creator must be a responder');

  r = await client.request(`/api/v1/organizations/${organization.id}/incidents/${incident.id}/responders`, {
    method: 'POST',
    body: { userId: user.id },
    expected: 200
  });
  assert.ok(r.json.data.responders.some((x) => x.userId === user.id));

  await client.request(`/api/v1/organizations/${organization.id}/incidents/${incident.id}/updates`, {
    method: 'POST',
    body: { message: internalMessage, isPublic: false },
    expected: 201
  });

  await client.request(`/api/v1/organizations/${organization.id}/incidents/${incident.id}/updates`, {
    method: 'POST',
    body: { message: publicMessage, isPublic: true },
    expected: 201
  });

  r = await client.request(`/api/v1/public/status/${statusSlug}`, { expected: 200 });
  assert.equal(r.json.data.overallStatus, 'PARTIAL_OUTAGE');
  assert.equal(r.json.data.components[0].effectiveState, 'PARTIAL_OUTAGE');
  assert.equal(r.json.data.activeIncidents[0].id, incident.id);
  assert.equal(r.json.data.activeIncidents[0].updates.some((u) => u.message === publicMessage), true);
  assert.equal(JSON.stringify(r.json).includes(internalMessage), false, 'internal note must not leak publicly');

  r = await client.request(`/api/v1/public/status/${statusSlug}/incidents/${incident.id}`, { expected: 200 });
  assert.equal(r.json.data.updates.some((u) => u.message === publicMessage), true);
  assert.equal(JSON.stringify(r.json).includes(internalMessage), false, 'public incident endpoint must not leak internal note');

  r = await client.request(`/api/v1/organizations/${organization.id}/incidents/${incident.id}`, {
    method: 'PATCH', body: { status: 'IDENTIFIED' }, expected: 200
  });
  assert.equal(r.json.data.status, 'IDENTIFIED');

  r = await client.request(`/api/v1/organizations/${organization.id}/incidents/${incident.id}`, {
    method: 'PATCH', body: { status: 'MONITORING' }, expected: 200
  });
  assert.equal(r.json.data.status, 'MONITORING');

  r = await client.request(`/api/v1/organizations/${organization.id}/incidents/${incident.id}/resolve`, {
    method: 'POST', body: {}, expected: 200
  });
  incident = r.json.data;
  assert.equal(incident.status, 'RESOLVED');
  assert.ok(incident.resolvedAt);

  r = await client.request(`/api/v1/public/status/${statusSlug}`, { expected: 200 });
  assert.equal(r.json.data.overallStatus, 'OPERATIONAL');
  assert.equal(r.json.data.components[0].effectiveState, 'OPERATIONAL');
  assert.ok(r.json.data.recentIncidents.some((x) => x.id === incident.id));
  assert.equal(JSON.stringify(r.json).includes(internalMessage), false, 'resolved public status must not leak internal note');

  const postmortemPayload = {
    title: `Release verification postmortem ${marker}`,
    summary: 'Production release verifier completed the canonical workflow.',
    impact: 'Synthetic verification only.',
    rootCause: 'Synthetic release-verification incident.',
    resolution: 'Synthetic incident resolved after lifecycle verification.',
    followUpActions: ['Preserve release verification coverage.']
  };
  r = await client.request(`/api/v1/organizations/${organization.id}/incidents/${incident.id}/postmortem`, {
    method: 'PUT', body: postmortemPayload, expected: 200
  });
  assert.equal(r.json.data.title, postmortemPayload.title);

  r = await client.request(`/api/v1/organizations/${organization.id}/incidents/${incident.id}`, { expected: 200 });
  incident = r.json.data;
  assert.equal(incident.status, 'RESOLVED');
  assert.ok(incident.timeline.some((e) => e.eventType === 'INCIDENT_CREATED'));
  assert.ok(incident.timeline.some((e) => e.eventType === 'INTERNAL_NOTE_ADDED'));
  assert.ok(incident.timeline.some((e) => e.eventType === 'PUBLIC_UPDATE_PUBLISHED'));
  assert.ok(incident.timeline.some((e) => e.eventType === 'INCIDENT_RESOLVED'));
  assert.ok(incident.timeline.some((e) => e.eventType === 'POSTMORTEM_CREATED'));
  assert.ok(incident.updates.some((u) => !u.isPublic && u.message === internalMessage));
  assert.ok(incident.updates.some((u) => u.isPublic && u.message === publicMessage));
  assert.equal(incident.postmortem.title, postmortemPayload.title);

  await writeFile(stateFile, JSON.stringify({
    email, password,
    userId: user.id,
    organizationId: organization.id,
    serviceId: service.id,
    componentId: component.id,
    statusPageId: statusPage.id,
    statusSlug,
    incidentId: incident.id,
    internalMessage,
    publicMessage,
    postmortemTitle: postmortemPayload.title
  }, null, 2), { mode: 0o600 });

  console.log('Production E2E PASS:', JSON.stringify({ organizationId: organization.id, incidentId: incident.id, statusSlug }));
}

async function restart() {
  await verifyHealthAndUi();
  const state = JSON.parse(await readFile(stateFile, 'utf8'));
  const client = new Client();
  const loginData = await login(client, state.email, state.password);
  assert.equal(loginData.user.id, state.userId);
  assert.ok(loginData.organizations.some((o) => o.id === state.organizationId), 'organization must survive restart');

  let r = await client.request(`/api/v1/organizations/${state.organizationId}/services`, { expected: 200 });
  assert.ok(r.json.data.some((x) => x.id === state.serviceId), 'service must survive restart');

  r = await client.request(`/api/v1/organizations/${state.organizationId}/components`, { expected: 200 });
  const component = r.json.data.find((x) => x.id === state.componentId);
  assert.ok(component, 'component must survive restart');
  assert.ok(component.serviceIds.includes(state.serviceId), 'component/service mapping must survive restart');

  r = await client.request(`/api/v1/organizations/${state.organizationId}/status-pages`, { expected: 200 });
  assert.ok(r.json.data.some((x) => x.id === state.statusPageId), 'status page must survive restart');

  r = await client.request(`/api/v1/organizations/${state.organizationId}/incidents/${state.incidentId}`, { expected: 200 });
  const incident = r.json.data;
  assert.equal(incident.status, 'RESOLVED');
  assert.equal(incident.commanderUserId, state.userId);
  assert.ok(incident.affectedServiceIds.includes(state.serviceId));
  assert.ok(incident.affectedComponentIds.includes(state.componentId));
  assert.ok(incident.responders.some((x) => x.userId === state.userId));
  assert.ok(incident.timeline.some((e) => e.eventType === 'INCIDENT_CREATED'));
  assert.ok(incident.timeline.some((e) => e.eventType === 'PUBLIC_UPDATE_PUBLISHED'));
  assert.ok(incident.timeline.some((e) => e.eventType === 'INCIDENT_RESOLVED'));
  assert.ok(incident.timeline.some((e) => e.eventType === 'POSTMORTEM_CREATED'));
  assert.ok(incident.updates.some((u) => !u.isPublic && u.message === state.internalMessage));
  assert.ok(incident.updates.some((u) => u.isPublic && u.message === state.publicMessage));
  assert.equal(incident.postmortem.title, state.postmortemTitle);

  r = await client.request(`/api/v1/public/status/${state.statusSlug}`, { expected: 200 });
  assert.equal(r.json.data.overallStatus, 'OPERATIONAL');
  assert.ok(r.json.data.recentIncidents.some((x) => x.id === state.incidentId));
  assert.equal(JSON.stringify(r.json).includes(state.internalMessage), false, 'internal note must remain private after restart');

  r = await client.request(`/api/v1/public/status/${state.statusSlug}/incidents/${state.incidentId}`, { expected: 200 });
  assert.equal(r.json.data.updates.some((u) => u.message === state.publicMessage), true);
  assert.equal(JSON.stringify(r.json).includes(state.internalMessage), false, 'public incident must remain private-note free after restart');

  console.log('Restart persistence PASS:', JSON.stringify({ organizationId: state.organizationId, incidentId: state.incidentId }));
}

if (mode === 'initial') await initial();
else if (mode === 'restart') await restart();
else throw new Error(`Unknown mode: ${mode}. Use initial or restart.`);
