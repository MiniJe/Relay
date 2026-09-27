import test from 'node:test';
import assert from 'node:assert/strict';
import { createOrg, harness, register, registerMember } from './helpers.mjs';
import { processDueWork } from '../apps/api/src/worker.mjs';

// Relay 0.2 / RLY-0.2-M-002 — durable immediate delivery.
//
// Every assertion below is about the *persisted* outbox: a logical delivery per
// configured channel is created before any provider is contacted, every
// provider call writes an immutable attempt, retries are bounded, and a manual
// retry adds history instead of erasing it.

const ALERT_KEY = 'test-alert-key-123';
const DISCORD_URL = 'https://discord.com/api/webhooks/123456789012345678/durable-delivery-token';
const SLACK_URL = 'https://hooks.slack.com/services/T00000000/B00000000/durable-slack-token';
const WEBHOOK_TOKEN = 'durable-delivery-token';
const SLACK_TOKEN = 'durable-slack-token';

function controlledHarness({ status = 204, transports = {}, fetchImpl } = {}) {
  const calls = [];
  const logged = [];
  return harness({
    fetchImpl: fetchImpl ?? (async (url, request) => {
      calls.push({ url: String(url), body: JSON.parse(request.body) });
      return new Response(null, { status });
    }),
    transports,
    logger: { warn: (...args) => logged.push(args.join(' ')), error: (...args) => logged.push(args.join(' ')), info: () => {} }
  }).then((h) => ({ ...h, calls, logged }));
}

async function workspace(h, { channels = ['DISCORD'], escalationSteps = [] } = {}) {
  const owner = await register(h.client, `owner-${Date.now()}-${Math.random().toString(36).slice(2)}@relay.test`, 'Owner Durable');
  const org = await createOrg(owner, `Durable Org ${Math.random().toString(36).slice(2)}`);
  const ada = await registerMember(h, org.id, `ada-${Math.random().toString(36).slice(2)}@relay.test`, 'RESPONDER', 'Ada Lovelace');
  const viewer = await registerMember(h, org.id, `viewer-${Math.random().toString(36).slice(2)}@relay.test`, 'VIEWER', 'Vera Viewer');
  await owner.client.request(`/api/v1/organizations/${org.id}/integrations/discord`, { method: 'PUT', body: { name: 'Ops', webhookUrl: DISCORD_URL, enabled: true } });
  if (channels.includes('SLACK')) {
    await owner.client.request(`/api/v1/organizations/${org.id}/integrations/slack`, { method: 'PUT', body: { name: 'Paging', webhookUrl: SLACK_URL, enabled: true } });
  }
  if (channels.includes('EMAIL')) {
    const smtp = await owner.client.request(`/api/v1/organizations/${org.id}/integrations/smtp`, {
      method: 'PUT',
      body: { name: 'Email', host: 'smtp.relay.test', port: 587, secure: false, username: 'relay@relay.test', password: 'smtp-secret-password', fromEmail: 'relay@relay.test', fromName: 'Relay Paging' }
    });
    assert.equal(smtp.res.status, 200, JSON.stringify(smtp.json));
  }
  const team = (await owner.client.request(`/api/v1/organizations/${org.id}/teams`, { method: 'POST', body: { name: 'Core Platform' } })).json.data;
  await owner.client.request(`/api/v1/organizations/${org.id}/teams/${team.id}/members`, { method: 'POST', body: { userId: ada.user.id } });
  const schedule = (await owner.client.request(`/api/v1/organizations/${org.id}/oncall/schedules`, {
    method: 'POST',
    body: { name: 'Primary', teamId: team.id, timeZone: 'UTC', rotationStartsAt: new Date(Date.now() - 60_000).toISOString(), rotationIntervalMinutes: 60, participantUserIds: [ada.user.id] }
  })).json.data;
  let policy = null;
  if (escalationSteps.length) {
    policy = (await owner.client.request(`/api/v1/organizations/${org.id}/escalation-policies`, {
      method: 'POST',
      body: { name: `Policy ${Math.random().toString(36).slice(2)}`, description: 'durable delivery test', enabled: true, steps: escalationSteps.map((step) => ({ ...step, targetScheduleId: schedule.id })) }
    })).json.data;
  }
  const rule = (await owner.client.request(`/api/v1/organizations/${org.id}/routing-rules`, {
    method: 'POST',
    body: { name: 'All criticals', priority: 10, matchSeverities: ['critical'], targetScheduleId: schedule.id, notificationChannels: channels, escalationPolicyId: policy?.id ?? null }
  })).json.data;
  return { owner, org, ada, viewer, team, schedule, rule, policy };
}

async function ingest(h, org, title, externalId) {
  return h.client().request('/api/v1/alerts', {
    method: 'POST',
    headers: { 'x-relay-alert-key': ALERT_KEY },
    body: { organizationSlug: org.slug, source: 'synthetic-monitor', title, severity: 'critical', externalId }
  });
}

const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();

test('routing persists one logical delivery per configured channel before any provider call', async (t) => {
  const h = await controlledHarness({ transports: { SLACK: async () => ({ status: 200 }) } });
  t.after(() => h.close());
  const w = await workspace(h, { channels: ['DISCORD', 'SLACK'] });

  const response = await ingest(h, w.org, 'Checkout p95 latency', 'durable-1');
  assert.equal(response.res.status, 202);
  const alertId = response.json.data.id;

  const deliveries = await w.owner.client.request(`/api/v1/organizations/${w.org.id}/alerts/${alertId}/deliveries`);
  assert.equal(deliveries.res.status, 200);
  assert.equal(deliveries.json.data.length, 2, 'one logical delivery per configured channel');
  const providers = deliveries.json.data.map((d) => d.provider).sort();
  assert.deepEqual(providers, ['DISCORD', 'SLACK']);
  for (const delivery of deliveries.json.data) {
    assert.equal(delivery.status, 'SENT');
    assert.equal(delivery.statusLabel, 'Sent');
    assert.equal(delivery.responderUserId, w.ada.user.id, 'the responder is snapshotted on the delivery');
    assert.equal(delivery.responderDisplayName, 'Ada Lovelace');
    assert.equal(delivery.attemptCount, 1);
    assert.equal(delivery.attempts.length, 1, 'every provider call leaves exactly one attempt');
    assert.equal(delivery.attempts[0].outcome, 'SENT');
    assert.equal(delivery.attempts[0].attemptNumber, 1);
  }
  const discord = deliveries.json.data.find((d) => d.provider === 'DISCORD');
  assert.equal(discord.destination.kind, 'DISCORD_WEBHOOK');
  assert.equal(JSON.stringify(deliveries.json).includes(WEBHOOK_TOKEN), false, 'no read may expose the webhook secret');

  // The logical rows exist independently of the provider calls: a duplicate
  // intake can never create a second page for the same channel.
  const duplicate = await ingest(h, w.org, 'Checkout p95 latency', 'durable-1');
  assert.equal(duplicate.res.status, 202);
  assert.equal(duplicate.json.data.duplicate, true);
  const afterDuplicate = await w.owner.client.request(`/api/v1/organizations/${w.org.id}/alerts/${alertId}/deliveries`);
  assert.equal(afterDuplicate.json.data.length, 2, 'duplicate intake adds no delivery');
  assert.equal(h.calls.length, 1, 'duplicate intake sends no second Discord page');
});

test('a retryable failure retries at +1 minute and +5 minutes and then stops forever', async (t) => {
  const h = await controlledHarness({ status: 503 });
  t.after(() => h.close());
  const w = await workspace(h);
  const response = await ingest(h, w.org, 'Durable failure', 'retry-1');
  const alertId = response.json.data.id;

  const first = (await w.owner.client.request(`/api/v1/organizations/${w.org.id}/alerts/${alertId}/deliveries`)).json.data[0];
  assert.equal(first.status, 'RETRYING');
  assert.equal(first.statusLabel, 'Retry scheduled');
  assert.equal(first.attemptCount, 1);
  assert.equal(first.attempts[0].outcome, 'RETRYABLE_FAILURE');
  assert.equal(first.attempts[0].providerStatusCode, 503);
  const firstRetryAt = new Date(first.nextAttemptAt).getTime();
  assert.ok(firstRetryAt - Date.now() > 55_000 && firstRetryAt - Date.now() <= 60_000, 'first retry is scheduled one minute out');

  const worker = { store: h.store, config: h.config, fetchImpl: h.fetchImpl, logger: { warn() {}, error() {}, info() {} } };
  // Not due yet: nothing is attempted early.
  await processDueWork({ ...worker, now: iso(30_000) });
  assert.equal(h.calls.length, 1, 'an early pass must not send an extra page');

  await processDueWork({ ...worker, now: iso(61_000) });
  const second = (await w.owner.client.request(`/api/v1/organizations/${w.org.id}/alerts/${alertId}/deliveries`)).json.data[0];
  assert.equal(second.attemptCount, 2);
  assert.equal(second.attempts.length, 2, 'the first attempt is never overwritten');
  const secondRetryAt = new Date(second.nextAttemptAt).getTime();
  assert.ok(secondRetryAt - Date.now() > 295_000, 'second retry is scheduled five minutes out');

  // The five-minute delay is measured from the second attempt's completion.
  await processDueWork({ ...worker, now: iso(61_000 + 301_000) });
  const third = (await w.owner.client.request(`/api/v1/organizations/${w.org.id}/alerts/${alertId}/deliveries`)).json.data[0];
  assert.equal(third.attemptCount, 3);
  assert.equal(third.status, 'FAILED', 'the third failure is terminal');
  assert.equal(third.statusLabel, 'Delivery failed');
  assert.equal(third.nextAttemptAt, third.completedAt, 'no further retry is scheduled');

  await processDueWork({ ...worker, now: iso(86_400_000) });
  const later = (await w.owner.client.request(`/api/v1/organizations/${w.org.id}/alerts/${alertId}/deliveries`)).json.data[0];
  assert.equal(later.attemptCount, 3, 'retries are bounded and never become infinite');
  assert.equal(h.calls.length, 3, 'exactly three provider calls for three attempts');

  // The compact M-001 summary mirrors the failure and leaks no secret.
  const routing = (await w.owner.client.request(`/api/v1/organizations/${w.org.id}/alerts/${alertId}/routing`)).json.data;
  assert.equal(routing.notificationStatus, 'FAILED');
  assert.equal(routing.notificationProvider, 'DISCORD');
  assert.ok(routing.notificationError.includes('503'));
  assert.equal(routing.notificationError.includes(WEBHOOK_TOKEN), false);
  assert.equal(h.logged.some((line) => line.includes(WEBHOOK_TOKEN)), false, 'the webhook secret is never logged');
});

test('a permanent provider failure stops immediately and never retries', async (t) => {
  const h = await controlledHarness({ status: 400 });
  t.after(() => h.close());
  const w = await workspace(h);
  const alertId = (await ingest(h, w.org, 'Permanent failure', 'perm-1')).json.data.id;

  const delivery = (await w.owner.client.request(`/api/v1/organizations/${w.org.id}/alerts/${alertId}/deliveries`)).json.data[0];
  assert.equal(delivery.status, 'FAILED');
  assert.equal(delivery.attempts[0].outcome, 'PERMANENT_FAILURE');
  assert.equal(delivery.attempts[0].providerStatusCode, 400);

  await processDueWork({ store: h.store, config: h.config, fetchImpl: h.fetchImpl, now: iso(86_400_000), logger: { warn() {}, error() {}, info() {} } });
  assert.equal(h.calls.length, 1, 'a permanent failure is never retried');
});

test('manual retry keeps earlier attempts, records who asked, and is closed to VIEWER', async (t) => {
  let status = 503;
  const h = await controlledHarness({ fetchImpl: async (url, request) => {
    h.calls.push({ url: String(url), body: JSON.parse(request.body) });
    return new Response(null, { status });
  } });
  t.after(() => h.close());
  const w = await workspace(h);
  const alertId = (await ingest(h, w.org, 'Manual retry', 'manual-1')).json.data.id;
  const worker = { store: h.store, config: h.config, fetchImpl: h.fetchImpl, logger: { warn() {}, error() {}, info() {} } };
  await processDueWork({ ...worker, now: iso(61_000) });
  await processDueWork({ ...worker, now: iso(61_000 + 301_000) });
  const failed = (await w.owner.client.request(`/api/v1/organizations/${w.org.id}/alerts/${alertId}/deliveries`)).json.data[0];
  assert.equal(failed.attemptCount, 3);
  assert.equal(failed.status, 'FAILED');

  const asViewer = await w.viewer.client.request(`/api/v1/organizations/${w.org.id}/deliveries/${failed.id}/retry`, { method: 'POST', body: {} });
  assert.equal(asViewer.res.status, 403, 'VIEWER may not trigger a page');

  status = 204;
  const retried = await w.ada.client.request(`/api/v1/organizations/${w.org.id}/deliveries/${failed.id}/retry`, { method: 'POST', body: {} });
  assert.equal(retried.res.status, 202, JSON.stringify(retried.json));
  assert.equal(retried.json.data.status, 'SENT');
  assert.equal(retried.json.data.attempts.length, 4, 'history is preserved and extended, never replaced');
  assert.deepEqual(retried.json.data.attempts.slice(0, 3).map((a) => a.outcome), ['RETRYABLE_FAILURE', 'RETRYABLE_FAILURE', 'RETRYABLE_FAILURE']);
  assert.equal(retried.json.data.attempts.at(-1).outcome, 'SENT');
  assert.equal(retried.json.data.attempts.at(-1).manualRetryByUserId, w.ada.user.id, 'the retry records who asked for it');

  // A delivered page is never re-sent by a manual retry.
  const again = await w.owner.client.request(`/api/v1/organizations/${w.org.id}/deliveries/${failed.id}/retry`, { method: 'POST', body: {} });
  assert.equal(again.res.status, 409);
  assert.equal(again.json.error.code, 'DELIVERY_ALREADY_SENT');
});

test('acknowledgement cancels unsent pages and leaves sent pages and attempts intact', async (t) => {
  // A provider that never returns lets the alert be acknowledged while the page
  // is still queued; the immediate attempt is simulated by claiming the row with
  // an attempt already recorded.
  const h = await controlledHarness();
  t.after(() => h.close());
  const w = await workspace(h);
  const sentAlertId = (await ingest(h, w.org, 'Already paged', 'ack-sent')).json.data.id;
  const queuedAlertId = (await ingest(h, w.org, 'Still queued', 'ack-queued')).json.data.id;

  const queued = h.store.notificationDeliveries.find((d) => d.alertId === queuedAlertId);
  // Rewind the queued page to its pre-attempt state: no provider call has been
  // made for it, so the acknowledgement must cancel it rather than page anyone.
  queued.status = 'PENDING';
  queued.attemptCount = 0;
  queued.nextAttemptAt = iso(3_600_000);
  queued.completedAt = null;
  h.store.notificationAttempts = h.store.notificationAttempts.filter((attempt) => attempt.deliveryId !== queued.id);

  const ack = await w.owner.client.request(`/api/v1/organizations/${w.org.id}/alerts/${queuedAlertId}/acknowledge`, { method: 'POST', body: {} });
  assert.equal(ack.res.status, 200);

  const cancelled = (await w.owner.client.request(`/api/v1/organizations/${w.org.id}/alerts/${queuedAlertId}/deliveries`)).json.data[0];
  assert.equal(cancelled.status, 'CANCELLED', 'a page that never reached a provider is cancelled by an acknowledgement');
  assert.equal(cancelled.statusLabel, 'Cancelled');
  assert.equal(cancelled.attempts.length, 0);

  const kept = (await w.owner.client.request(`/api/v1/organizations/${w.org.id}/alerts/${sentAlertId}/deliveries`)).json.data[0];
  assert.equal(kept.status, 'SENT', 'delivered history is immutable');
  assert.equal(kept.attempts.length, 1);
});

test('Slack and email pages carry sanitized text and can never choose their own recipient', async (t) => {
  const slackCalls = [];
  const emailCalls = [];
  const h = await controlledHarness({
    transports: {
      SLACK: async (payload) => { slackCalls.push(payload); return { status: 200 }; },
      EMAIL: async (payload) => { emailCalls.push(payload); return { status: 250 }; }
    }
  });
  t.after(() => h.close());
  const w = await workspace(h, { channels: ['SLACK', 'EMAIL'] });

  const hostile = '<!channel> @here <@U12345> checkout failing — page attacker@evil.test';
  const alertId = (await ingest(h, w.org, hostile, 'sanitize-1')).json.data.id;

  assert.equal(slackCalls.length, 1, 'the Slack transport is used for the Slack channel');
  assert.equal(h.calls.length, 0, 'no page is routed through Discord when Discord is not configured');

  assert.equal(emailCalls.length, 1);
  assert.match(emailCalls[0].recipient, /^ada-.*@relay\.test$/, 'the recipient is the resolved responder account, never alert content');
  assert.equal(emailCalls[0].recipient.includes('attacker@evil.test'), false);

  const deliveries = (await w.owner.client.request(`/api/v1/organizations/${w.org.id}/alerts/${alertId}/deliveries`)).json.data;
  assert.deepEqual(deliveries.map((d) => d.provider).sort(), ['EMAIL', 'SLACK']);
  const email = deliveries.find((d) => d.provider === 'EMAIL');
  assert.match(email.destination.to, /^ada-.*@relay\.test$/);
  assert.equal(JSON.stringify(deliveries).includes('smtp-secret-password'), false, 'no read may expose the SMTP password');
  assert.equal(h.logged.some((line) => line.includes('smtp-secret-password')), false, 'the SMTP password is never logged');
  assert.equal(h.logged.some((line) => line.includes(SLACK_TOKEN)), false, 'the Slack webhook token is never logged');
});

test('unusable destinations fail permanently with an operator-readable reason', async (t) => {
  const h = await controlledHarness({ transports: { SLACK: async () => ({ status: 200 }) } });
  t.after(() => h.close());
  const w = await workspace(h, { channels: ['SLACK'] });
  // Delete the integration after the rule exists: the delivery was created when
  // the operator intended to page, and the skip is recorded against it.
  await w.owner.client.request(`/api/v1/organizations/${w.org.id}/integrations/slack`, { method: 'DELETE' });
  const ingestResult = await ingest(h, w.org, 'No integration left', 'gap-1');
  assert.equal(ingestResult.res.status, 202, 'the alert stays durable even when the channel cannot serve it');
  const deliveries = (await w.owner.client.request(`/api/v1/organizations/${w.org.id}/alerts/${ingestResult.json.data.id}/deliveries`)).json.data;
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].status, 'FAILED');
  assert.match(deliveries[0].lastError, /not configured/i);
  assert.equal(deliveries[0].attempts.length, 0, 'a configuration gap is not a provider attempt');
});
