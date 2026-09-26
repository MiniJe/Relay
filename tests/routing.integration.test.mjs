import test from 'node:test';
import assert from 'node:assert/strict';
import { createOrg, harness, register, registerMember } from './helpers.mjs';

// Relay 0.2 alert routing, on-call resolution, acknowledgement and tenant
// isolation, exercised through the real HTTP API.

const ALERT_KEY = 'test-alert-key-123';
const WEBHOOK_TOKEN = 'super-secret-webhook-token';
const DISCORD_URL = `https://discord.com/api/webhooks/123456789012345678/${WEBHOOK_TOKEN}`;
const DAY = 86_400_000;
const WEEK = 7 * DAY;

const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();

function discordHarness(options = {}) {
  const calls = [];
  const logged = [];
  return harness({
    fetchImpl: options.fetchImpl ?? (async (url, request) => {
      calls.push({ url: String(url), body: JSON.parse(request.body) });
      return new Response(null, { status: 204 });
    }),
    logger: { warn: (...args) => logged.push(args.join(' ')), error: (...args) => logged.push(args.join(' ')) },
    ...options
  }).then((h) => ({ ...h, calls, logged }));
}

/**
 * A fully configured workspace: an owner, three rotation responders, a read-only
 * viewer, an outsider with their own organization, one service owned by one
 * team, one weekly schedule and one catch-all routing rule.
 */
async function buildWorkspace(h, { startOffset = -3600_000, rotationStartsAt = iso(startOffset) } = {}) {
  const owner = await register(h.client, `owner-${Date.now()}-${Math.random().toString(36).slice(2)}@relay.test`, 'Owner Prime');
  const org = await createOrg(owner, `Routing Org ${Math.random().toString(36).slice(2)}`);
  const ada = await registerMember(h, org.id, `ada-${Math.random().toString(36).slice(2)}@relay.test`, 'RESPONDER', 'Ada Lovelace');
  const grace = await registerMember(h, org.id, `grace-${Math.random().toString(36).slice(2)}@relay.test`, 'RESPONDER', 'Grace Hopper');
  const linus = await registerMember(h, org.id, `linus-${Math.random().toString(36).slice(2)}@relay.test`, 'RESPONDER', 'Linus Torvalds');
  const viewer = await registerMember(h, org.id, `viewer-${Math.random().toString(36).slice(2)}@relay.test`, 'VIEWER', 'Vera Viewer');
  const outsider = await register(h.client, `outsider-${Math.random().toString(36).slice(2)}@relay.test`, 'Oscar Outsider');
  const otherOrg = await createOrg(outsider, `Other Org ${Math.random().toString(36).slice(2)}`);

  // A Discord integration is configured for every workspace so routed alerts
  // have a real first notification path to exercise.
  await owner.client.request(`/api/v1/organizations/${org.id}/integrations/discord`, {
    method: 'PUT', body: { name: 'Ops', webhookUrl: 'https://discord.com/api/webhooks/123456789012345678/workspace-hook-token', enabled: true }
  });

  const team = (await owner.client.request(`/api/v1/organizations/${org.id}/teams`, { method: 'POST', body: { name: 'Core Platform', description: 'Owns checkout' } })).json.data;
  for (const member of [ada, grace, linus]) {
    const added = await owner.client.request(`/api/v1/organizations/${org.id}/teams/${team.id}/members`, { method: 'POST', body: { userId: member.user.id } });
    assert.equal(added.res.status, 201, `team member must be addable: ${JSON.stringify(added.json)}`);
  }

  const service = (await owner.client.request(`/api/v1/organizations/${org.id}/services`, { method: 'POST', body: { name: 'Checkout API', description: 'Checkout requests' } })).json.data;
  const owned = await owner.client.request(`/api/v1/organizations/${org.id}/services/${service.id}`, { method: 'PATCH', body: { ownerTeamId: team.id } });
  assert.equal(owned.res.status, 200);
  assert.equal(owned.json.data.ownerTeamId, team.id);

  const schedule = (await owner.client.request(`/api/v1/organizations/${org.id}/oncall/schedules`, {
    method: 'POST',
    body: {
      name: 'Primary on-call', teamId: team.id, timeZone: 'Europe/Bucharest',
      rotationStartsAt, rotationIntervalMinutes: 1440,
      participantUserIds: [ada.user.id, grace.user.id, linus.user.id]
    }
  })).json.data;

  const rule = (await owner.client.request(`/api/v1/organizations/${org.id}/routing-rules`, {
    method: 'POST',
    body: { name: 'Checkout criticals', priority: 10, matchServiceId: service.id, matchSource: 'synthetic-monitor', matchSeverities: ['critical'], targetScheduleId: schedule.id }
  })).json.data;

  return { owner, org, ada, grace, linus, viewer, outsider, otherOrg, team, service, schedule, rule };
}

async function ingest(h, org, body, extra = {}) {
  return h.client().request('/api/v1/alerts', {
    method: 'POST',
    headers: { 'x-relay-alert-key': ALERT_KEY },
    body: { organizationSlug: org.slug, source: 'synthetic-monitor', title: 'Checkout latency', severity: 'critical', ...body, ...extra }
  });
}

test('an ingested alert is routed, resolved to the on-call responder, recorded and notified', async (t) => {
  const h = await discordHarness(); t.after(() => h.close());
  const w = await buildWorkspace(h);

  const response = await ingest(h, w.org, { title: 'Checkout p95 latency', description: 'p95 above 900ms', serviceIdentifier: w.service.slug, externalId: 'route-1', metadata: { region: 'eu' } });
  assert.equal(response.res.status, 202);
  const routing = response.json.data.routing;
  assert.equal(routing.resolution, 'ROUTED');
  assert.equal(routing.ruleName, 'Checkout criticals');
  assert.equal(routing.scheduleName, 'Primary on-call');
  assert.equal(routing.teamName, 'Core Platform');
  assert.equal(routing.oncallUserId, w.ada.user.id, 'the rotation anchored one hour ago resolves its first participant');
  assert.equal(routing.oncallDisplayName, 'Ada Lovelace');
  assert.equal(routing.responderSource, 'ROTATION');
  assert.equal(routing.notificationStatus, 'SENT');
  assert.ok(routing.notifiedAt, 'delivery time must be recorded');
  assert.ok(routing.evaluatedAt, 'evaluation time must be recorded');
  assert.ok(routing.periodStartsAt && routing.periodEndsAt);
  assert.equal(response.json.data.duplicate, false);

  // One Discord notification carrying everything needed to act.
  assert.equal(h.calls.length, 1);
  const payload = h.calls[0].body;
  assert.equal(payload.embeds[0].title, 'Alert routed — Checkout p95 latency');
  assert.equal(payload.embeds[0].description, 'p95 above 900ms');
  const fields = Object.fromEntries(payload.embeds[0].fields.map((f) => [f.name, f.value]));
  assert.equal(fields.Severity, 'critical');
  assert.equal(fields.Source, 'synthetic-monitor');
  assert.equal(fields.Service, 'Checkout API');
  assert.equal(fields['On call'], 'Ada Lovelace');
  assert.equal(fields['Routed via'], 'Checkout criticals → Primary on-call → Core Platform');
  assert.ok(fields.Observed.includes('UTC'), 'observed time must be rendered with an explicit offset');
  assert.deepEqual(payload.allowed_mentions.parse, [], 'broadcast mentions must never be parsed');
  assert.deepEqual(payload.allowed_mentions.users, [], 'no mapping means no mention, but the responder is still named');

  // The audit record is readable on its own and through the alert list.
  const detail = await w.owner.client.request(`/api/v1/organizations/${w.org.id}/alerts/${response.json.data.id}/routing`);
  assert.equal(detail.res.status, 200);
  assert.equal(detail.json.data.oncallUserId, w.ada.user.id);
  const list = await w.owner.client.request(`/api/v1/organizations/${w.org.id}/alerts`);
  assert.equal(list.res.status, 200);
  assert.equal(list.json.data[0].routing.resolution, 'ROUTED');
  assert.equal(list.json.data[0].serviceName, 'Checkout API');
  const audit = await w.owner.client.request(`/api/v1/organizations/${w.org.id}/routings`);
  assert.equal(audit.res.status, 200);
  assert.equal(audit.json.data.length, 1);
  assert.equal(audit.json.data[0].routing.ruleId, w.rule.id);
});

test('a Discord identity mapping adds a real mention and stays inside the allowed list', async (t) => {
  const h = await discordHarness(); t.after(() => h.close());
  const w = await buildWorkspace(h);

  const mapped = await w.owner.client.request(`/api/v1/organizations/${w.org.id}/discord-identities/${w.ada.user.id}`, { method: 'PUT', body: { discordUserId: '223344556677889900' } });
  assert.equal(mapped.res.status, 200);
  assert.equal(mapped.json.data.discordUserId, '223344556677889900');

  const response = await ingest(h, w.org, { title: 'Checkout errors', serviceIdentifier: w.service.id, externalId: 'mention-1' });
  assert.equal(response.res.status, 202);
  assert.equal(response.json.data.routing.discordUserId, '223344556677889900');
  const payload = h.calls[0].body;
  assert.deepEqual(payload.allowed_mentions.users, ['223344556677889900'], 'only the mapped responder may be mentioned');
  assert.deepEqual(payload.allowed_mentions.parse, []);
  assert.ok(payload.embeds[0].fields.find((f) => f.name === 'On call').value.includes('<@223344556677889900>'));

  // The mapping list is administrative only.
  const asViewer = await w.viewer.client.request(`/api/v1/organizations/${w.org.id}/discord-identities`);
  assert.equal(asViewer.res.status, 403);
  const asOwner = await w.owner.client.request(`/api/v1/organizations/${w.org.id}/discord-identities`);
  assert.equal(asOwner.res.status, 200);
  assert.equal(asOwner.json.data.length, 1);
});

test('the on-call answer is deterministic across handoffs and queryable at any timestamp', async (t) => {
  const h = await discordHarness(); t.after(() => h.close());
  // Anchor the rotation to a fixed instant so handoff maths is exact.
  const anchor = new Date(Date.parse('2026-04-01T00:00:00.000Z') - DAY);
  const w = await buildWorkspace(h, { rotationStartsAt: anchor.toISOString() });

  const expected = [w.ada.user.id, w.grace.user.id, w.linus.user.id, w.ada.user.id];
  for (let day = 0; day < 4; day += 1) {
    const at = new Date(anchor.getTime() + day * DAY + 60_000).toISOString();
    const resolved = await w.owner.client.request(`/api/v1/organizations/${w.org.id}/oncall/schedules/${w.schedule.id}/oncall?at=${encodeURIComponent(at)}`);
    assert.equal(resolved.res.status, 200);
    assert.equal(resolved.json.data.userId, expected[day], `day ${day}`);
    assert.equal(resolved.json.data.periodStartsAt, new Date(anchor.getTime() + day * DAY).toISOString());
    assert.equal(resolved.json.data.periodEndsAt, new Date(anchor.getTime() + (day + 1) * DAY).toISOString());
  }
  // The same instant resolved twice is identical, and the state endpoint agrees.
  const at = new Date(anchor.getTime() + 2 * DAY).toISOString();
  const a = await w.owner.client.request(`/api/v1/organizations/${w.org.id}/oncall/schedules/${w.schedule.id}/oncall?at=${encodeURIComponent(at)}`);
  const b = await w.owner.client.request(`/api/v1/organizations/${w.org.id}/oncall/schedules/${w.schedule.id}/oncall?at=${encodeURIComponent(at)}`);
  assert.deepEqual(a.json.data.userId, b.json.data.userId);
  const state = await w.owner.client.request(`/api/v1/organizations/${w.org.id}/oncall/state?at=${encodeURIComponent(at)}`);
  assert.equal(state.res.status, 200);
  assert.equal(state.json.data.oncall[0].current.userId, w.linus.user.id);
  assert.equal(state.json.data.oncall[0].next[0].userId, w.ada.user.id, 'the next responder is reported');
  assert.equal(state.json.data.oncall[0].schedule.timeZone, 'Europe/Bucharest');

  // Before the rotation starts, nobody is on call rather than a guessed person.
  const before = await w.owner.client.request(`/api/v1/organizations/${w.org.id}/oncall/schedules/${w.schedule.id}/oncall?at=${encodeURIComponent(new Date(anchor.getTime() - 1000).toISOString())}`);
  assert.equal(before.json.data.resolved, false);
  assert.equal(before.json.data.reason, 'ROTATION_NOT_STARTED');
  const malformed = await w.owner.client.request(`/api/v1/organizations/${w.org.id}/oncall/schedules/${w.schedule.id}/oncall?at=not-a-date`);
  assert.equal(malformed.res.status, 400);
});

test('overrides take precedence, reject overlaps, and the rotation resumes unchanged', async (t) => {
  const h = await discordHarness(); t.after(() => h.close());
  const w = await buildWorkspace(h);
  const base = `/api/v1/organizations/${w.org.id}`;

  const invalidWindow = await w.owner.client.request(`${base}/oncall/schedules/${w.schedule.id}/overrides`, {
    method: 'POST', body: { replacementUserId: w.grace.user.id, startsAt: iso(DAY), endsAt: iso(0) }
  });
  assert.equal(invalidWindow.res.status, 400, 'startsAt must be strictly before endsAt');
  assert.equal(invalidWindow.json.error.code, 'VALIDATION_ERROR');

  const crossTenant = await w.owner.client.request(`${base}/oncall/schedules/${w.schedule.id}/overrides`, {
    method: 'POST', body: { replacementUserId: w.outsider.user.id, startsAt: iso(0), endsAt: iso(DAY) }
  });
  assert.equal(crossTenant.res.status, 400);
  assert.equal(crossTenant.json.error.code, 'INVALID_REFERENCE');

  const created = await w.owner.client.request(`${base}/oncall/schedules/${w.schedule.id}/overrides`, {
    method: 'POST', body: { replacementUserId: w.grace.user.id, startsAt: iso(-3600_000), endsAt: iso(3600_000), reason: 'Conference coverage' }
  });
  assert.equal(created.res.status, 201);
  const overrideId = created.json.data.id;

  const overlapping = await w.owner.client.request(`${base}/oncall/schedules/${w.schedule.id}/overrides`, {
    method: 'POST', body: { replacementUserId: w.linus.user.id, startsAt: iso(-1800_000), endsAt: iso(7200_000) }
  });
  assert.equal(overlapping.res.status, 409, 'overlapping overrides are rejected explicitly');
  assert.equal(overlapping.json.error.code, 'OVERRIDE_OVERLAP');

  const adjacent = await w.owner.client.request(`${base}/oncall/schedules/${w.schedule.id}/overrides`, {
    method: 'POST', body: { replacementUserId: w.linus.user.id, startsAt: iso(3600_000), endsAt: iso(7200_000) }
  });
  assert.equal(adjacent.res.status, 201, 'a window that merely touches the existing one is allowed');

  const resolved = await w.owner.client.request(`${base}/oncall/schedules/${w.schedule.id}/oncall`);
  assert.equal(resolved.json.data.source, 'OVERRIDE');
  assert.equal(resolved.json.data.userId, w.grace.user.id);
  assert.equal(resolved.json.data.overrideId, overrideId);

  // An alert ingested during the override pages the override responder.
  const during = await ingest(h, w.org, { title: 'Checkout down', serviceIdentifier: w.service.id, externalId: 'override-1' });
  assert.equal(during.json.data.routing.oncallUserId, w.grace.user.id);
  assert.equal(during.json.data.routing.responderSource, 'OVERRIDE');
  assert.equal(during.json.data.routing.overrideId, overrideId);

  const state = await w.owner.client.request(`${base}/oncall/state`);
  assert.ok(state.json.data.oncall[0].activeOverride, 'the active override is surfaced');
  assert.equal(state.json.data.oncall[0].activeOverride.reason, 'Conference coverage');

  // Deleting every override restores the untouched rotation.
  assert.equal((await w.owner.client.request(`${base}/oncall/overrides/${overrideId}`, { method: 'DELETE' })).res.status, 204);
  assert.equal((await w.owner.client.request(`${base}/oncall/overrides/${adjacent.json.data.id}`, { method: 'DELETE' })).res.status, 204);
  const after = await w.owner.client.request(`${base}/oncall/schedules/${w.schedule.id}/oncall`);
  assert.equal(after.json.data.source, 'ROTATION');
  assert.equal(after.json.data.userId, w.ada.user.id, 'the underlying rotation was never rewritten');
  assert.equal((await w.owner.client.request(`${base}/oncall/overrides/${overrideId}`, { method: 'DELETE' })).res.status, 404);
});

test('rule precedence, non-matching alerts and disabled rules behave deterministically', async (t) => {
  const h = await discordHarness(); t.after(() => h.close());
  const w = await buildWorkspace(h);
  const base = `/api/v1/organizations/${w.org.id}`;

  // A broader catch-all rule with a worse priority must not win.
  const catchAll = await w.owner.client.request(`${base}/routing-rules`, {
    method: 'POST', body: { name: 'Catch all', priority: 900, targetScheduleId: w.schedule.id }
  });
  assert.equal(catchAll.res.status, 201);
  const matched = await ingest(h, w.org, { title: 'Matched alert', serviceIdentifier: w.service.id, source: 'synthetic-monitor', severity: 'critical', externalId: 'prec-1' });
  assert.equal(matched.json.data.routing.ruleName, 'Checkout criticals');

  // Severity outside the rule's list falls through to the catch-all.
  const fallthrough = await ingest(h, w.org, { title: 'Info alert', serviceIdentifier: w.service.id, source: 'synthetic-monitor', severity: 'info', externalId: 'prec-2' });
  assert.equal(fallthrough.json.data.routing.ruleName, 'Catch all');

  // Source matching is case-insensitive and exact.
  const caseInsensitive = await ingest(h, w.org, { title: 'Case alert', serviceIdentifier: w.service.id, source: 'Synthetic-Monitor', severity: 'CRITICAL', externalId: 'prec-3' });
  assert.equal(caseInsensitive.json.data.routing.resolution, 'ROUTED');
  assert.equal(caseInsensitive.json.data.routing.ruleName, 'Checkout criticals', 'source and severity matching are case-insensitive');

  // A literal-looking value is inert text, not a wildcard: `*` matches only an
  // alert whose source is exactly `*`.
  const starRule = await w.owner.client.request(`${base}/routing-rules`, { method: 'POST', body: { name: 'Star source', priority: 1, matchSource: '*', targetScheduleId: w.schedule.id } });
  assert.equal(starRule.res.status, 201);
  const starMiss = await ingest(h, w.org, { title: 'Star probe', serviceIdentifier: w.service.id, severity: 'critical', externalId: 'prec-star' });
  assert.equal(starMiss.json.data.routing.ruleName, 'Checkout criticals', 'a `*` source condition never acts as a wildcard');
  await w.owner.client.request(`${base}/routing-rules/${starRule.json.data.id}`, { method: 'DELETE' });

  // With every rule disabled nothing routes, but the alert stays durable.
  for (const rule of [w.rule, catchAll.json.data]) {
    const disabled = await w.owner.client.request(`${base}/routing-rules/${rule.id}`, { method: 'PATCH', body: { enabled: false } });
    assert.equal(disabled.res.status, 200);
    assert.equal(disabled.json.data.enabled, false);
  }
  const unrouted = await ingest(h, w.org, { title: 'Unrouted alert', serviceIdentifier: w.service.id, externalId: 'prec-4' });
  assert.equal(unrouted.res.status, 202);
  assert.equal(unrouted.json.data.routing.resolution, 'NO_MATCHING_RULE');
  assert.equal(unrouted.json.data.routing.notificationStatus, 'SKIPPED_NO_RESPONDER');
  const stillListed = await w.owner.client.request(`${base}/alerts`);
  assert.equal(stillListed.json.data.length, 5, 'unrouted alerts remain durably listed');

  // Priority changes reorder evaluation.
  await w.owner.client.request(`${base}/routing-rules/${w.rule.id}`, { method: 'PATCH', body: { enabled: true, priority: 1000 } });
  await w.owner.client.request(`${base}/routing-rules/${catchAll.json.data.id}`, { method: 'PATCH', body: { enabled: true, priority: 5 } });
  const reordered = await ingest(h, w.org, { title: 'Reordered alert', serviceIdentifier: w.service.id, severity: 'critical', externalId: 'prec-5' });
  assert.equal(reordered.json.data.routing.ruleName, 'Catch all');

  const rules = await w.owner.client.request(`${base}/routing-rules`);
  assert.deepEqual(rules.json.data.map((r) => r.name), ['Catch all', 'Checkout criticals'], 'rules are returned in evaluation order');
});

test('a disabled schedule or an empty rotation resolves nobody instead of guessing', async (t) => {
  const h = await discordHarness(); t.after(() => h.close());
  const w = await buildWorkspace(h);
  const base = `/api/v1/organizations/${w.org.id}`;

  await w.owner.client.request(`${base}/oncall/schedules/${w.schedule.id}`, { method: 'PATCH', body: { enabled: false } });
  const disabled = await ingest(h, w.org, { title: 'Disabled schedule', serviceIdentifier: w.service.id, externalId: 'gate-1' });
  assert.equal(disabled.json.data.routing.resolution, 'SCHEDULE_DISABLED');
  assert.equal(disabled.json.data.routing.oncallUserId, null);
  assert.equal(disabled.json.data.routing.notificationStatus, 'SKIPPED_NO_RESPONDER');
  assert.equal(h.calls.length, 0, 'nobody is notified when nobody is on call');

  await w.owner.client.request(`${base}/oncall/schedules/${w.schedule.id}`, { method: 'PATCH', body: { enabled: true } });
  await w.owner.client.request(`${base}/oncall/schedules/${w.schedule.id}`, { method: 'PATCH', body: { rotationStartsAt: iso(10 * DAY) } });
  const notStarted = await ingest(h, w.org, { title: 'Future rotation', serviceIdentifier: w.service.id, externalId: 'gate-2' });
  assert.equal(notStarted.json.data.routing.resolution, 'ROTATION_NOT_STARTED');
});

test('retried and concurrent intake of the same alert never duplicates routing or notification', async (t) => {
  const h = await discordHarness(); t.after(() => h.close());
  const w = await buildWorkspace(h);
  const base = `/api/v1/organizations/${w.org.id}`;

  const first = await ingest(h, w.org, { title: 'Idempotent alert', serviceIdentifier: w.service.id, externalId: 'idem-1' });
  assert.equal(first.json.data.duplicate, false);
  assert.equal(h.calls.length, 1);

  const second = await ingest(h, w.org, { title: 'Idempotent alert', serviceIdentifier: w.service.id, externalId: 'idem-1' });
  assert.equal(second.res.status, 202);
  assert.equal(second.json.data.id, first.json.data.id, 'the external alert id is idempotent per source and organization');
  assert.equal(second.json.data.duplicate, true);
  assert.equal(second.json.data.routing.id, first.json.data.routing.id, 'the same routing record is returned');
  assert.equal(h.calls.length, 1, 'a retry must not page anybody twice');

  // Concurrent intake: eight simultaneous requests for one external id.
  const concurrent = await Promise.all(Array.from({ length: 8 }, () => ingest(h, w.org, { title: 'Concurrent alert', serviceIdentifier: w.service.id, externalId: 'idem-2' })));
  const ids = new Set(concurrent.map((r) => r.json.data.id));
  assert.equal(ids.size, 1, 'all concurrent requests must resolve to a single alert');
  assert.equal(concurrent.filter((r) => r.json.data.duplicate === false).length, 1, 'exactly one intake created the alert');
  assert.equal(h.calls.length, 2, 'exactly one notification per distinct alert');

  const routings = await w.owner.client.request(`${base}/routings`);
  assert.equal(routings.json.data.length, 2, 'exactly one routing record per alert');
  const alerts = await w.owner.client.request(`${base}/alerts`);
  assert.equal(alerts.json.data.length, 2);

  // Different sources with the same external id are distinct alerts.
  const otherSource = await h.client().request('/api/v1/alerts', {
    method: 'POST', headers: { 'x-relay-alert-key': ALERT_KEY },
    body: { organizationSlug: w.org.slug, source: 'prometheus', title: 'Other source', severity: 'critical', externalId: 'idem-1', serviceIdentifier: w.service.id }
  });
  assert.notEqual(otherSource.json.data.id, first.json.data.id);
});

test('notification failure never rolls back the alert and never leaks the webhook secret', async (t) => {
  const h = await discordHarness({ fetchImpl: async () => new Response('failure', { status: 503 }) }); t.after(() => h.close());
  const w = await buildWorkspace(h);
  await w.owner.client.request(`/api/v1/organizations/${w.org.id}/integrations/discord`, { method: 'PUT', body: { name: 'Ops', webhookUrl: DISCORD_URL, enabled: true } });

  const response = await ingest(h, w.org, { title: 'Durable alert', description: 'Discord is down', serviceIdentifier: w.service.id, externalId: 'fail-1' });
  assert.equal(response.res.status, 202, 'the alert is accepted even though delivery failed');
  assert.equal(response.json.warnings?.[0]?.code, 'ALERT_NOTIFICATION_FAILED');
  const routing = response.json.data.routing;
  assert.equal(routing.resolution, 'ROUTED', 'routing succeeded independently of delivery');
  assert.equal(routing.notificationStatus, 'FAILED');
  assert.equal(routing.notificationProvider, 'DISCORD');
  assert.ok(routing.notificationError.includes('503'));
  assert.equal(routing.notificationError.includes(WEBHOOK_TOKEN), false, 'the failure detail must not contain the webhook secret');

  const persisted = await w.owner.client.request(`/api/v1/organizations/${w.org.id}/alerts/${response.json.data.id}`);
  assert.equal(persisted.res.status, 200);
  assert.equal(persisted.json.data.title, 'Durable alert', 'the alert survived the delivery failure');
  assert.equal(JSON.stringify(persisted.json).includes(WEBHOOK_TOKEN), false);

  const integrations = await w.owner.client.request(`/api/v1/organizations/${w.org.id}/integrations`);
  assert.equal(integrations.json.data.some((x) => x.secretEncrypted !== undefined), false, 'no integration read may return secret material');
  assert.equal(h.logged.some((line) => line.includes(WEBHOOK_TOKEN)), false, 'the webhook secret must never be logged');
  assert.ok(h.logged.some((line) => line.includes('Alert notification delivery failed')), 'the failure is logged without secrets');

  // An explicit re-route retries delivery; a SENT notification is never re-sent by accident.
  const rerouted = await w.owner.client.request(`/api/v1/organizations/${w.org.id}/alerts/${response.json.data.id}/route`, { method: 'POST', body: {} });
  assert.equal(rerouted.res.status, 200);
  assert.equal(rerouted.json.data.notificationStatus, 'FAILED');
});

test('acknowledgement is authorized, idempotent, and never conflated with incident resolution', async (t) => {
  const h = await discordHarness(); t.after(() => h.close());
  const w = await buildWorkspace(h);
  const base = `/api/v1/organizations/${w.org.id}`;

  const alert = (await ingest(h, w.org, { title: 'Acknowledge me', serviceIdentifier: w.service.id, externalId: 'ack-1' })).json.data;
  assert.equal(alert.routing.acknowledgedAt, null);

  const forbiddenViewer = await w.viewer.client.request(`${base}/alerts/${alert.id}/acknowledge`, { method: 'POST', body: {} });
  assert.equal(forbiddenViewer.res.status, 403, 'VIEWER may not acknowledge');
  const forbiddenOutsider = await w.outsider.client.request(`${base}/alerts/${alert.id}/acknowledge`, { method: 'POST', body: {} });
  assert.equal(forbiddenOutsider.res.status, 403, 'a non-member may not acknowledge');
  const anonymous = await h.client().request(`${base}/alerts/${alert.id}/acknowledge`, { method: 'POST', body: {} });
  assert.equal(anonymous.res.status, 401);

  const acked = await w.grace.client.request(`${base}/alerts/${alert.id}/acknowledge`, { method: 'POST', body: {} });
  assert.equal(acked.res.status, 200);
  assert.equal(acked.json.alreadyAcknowledged, false);
  assert.equal(acked.json.data.acknowledgedByUserId, w.grace.user.id);
  assert.equal(acked.json.data.acknowledgedByDisplayName, 'Grace Hopper');
  assert.ok(acked.json.data.acknowledgedAt);

  // Repeating is an idempotent no-op, even from a different responder.
  const repeated = await w.ada.client.request(`${base}/alerts/${alert.id}/acknowledge`, { method: 'POST', body: {} });
  assert.equal(repeated.res.status, 200);
  assert.equal(repeated.json.alreadyAcknowledged, true);
  assert.equal(repeated.json.data.acknowledgedByUserId, w.grace.user.id, 'the first acknowledgement wins');
  assert.equal(repeated.json.data.acknowledgedAt, acked.json.data.acknowledgedAt);

  // Concurrent acknowledgement records exactly one acknowledger.
  const concurrentAlert = (await ingest(h, w.org, { title: 'Concurrent ack', serviceIdentifier: w.service.id, externalId: 'ack-2' })).json.data;
  const results = await Promise.all([w.ada, w.grace, w.linus].map((member) => member.client.request(`${base}/alerts/${concurrentAlert.id}/acknowledge`, { method: 'POST', body: {} })));
  assert.equal(results.filter((r) => r.json.alreadyAcknowledged === false).length, 1, 'only one acknowledgement is recorded');

  // Acknowledgement is not incident resolution.
  const incidents = await w.owner.client.request(`${base}/incidents`);
  assert.equal(incidents.json.data.length, 0, 'no incident may be created automatically by routing or acknowledgement');
  const acknowledgedList = await w.owner.client.request(`${base}/alerts`);
  assert.equal(acknowledgedList.json.data.find((a) => a.id === alert.id).routing.acknowledgedAt, acked.json.data.acknowledgedAt);
});

test('alerts that predate routing can be evaluated explicitly, then acknowledged', async (t) => {
  const h = await discordHarness(); t.after(() => h.close());
  const w = await buildWorkspace(h);
  const base = `/api/v1/organizations/${w.org.id}`;

  // A Relay 0.1 alert row has no routing record at all.
  const legacyId = `legacy-${Math.random().toString(36).slice(2)}`;
  h.store.alerts.push({
    id: legacyId, organizationId: w.org.id, source: 'synthetic-monitor', externalId: 'legacy-1',
    title: 'Legacy 0.1 alert', description: '', severity: 'critical', serviceId: w.service.id,
    // source matches the workspace rule; only the routing record is missing.
    metadata: {}, observedAt: iso(-10 * DAY), receivedAt: iso(-10 * DAY)
  });

  const acked = await w.grace.client.request(`${base}/alerts/${legacyId}/acknowledge`, { method: 'POST', body: {} });
  assert.equal(acked.res.status, 409);
  assert.equal(acked.json.error.code, 'ROUTING_NOT_EVALUATED');

  const listed = await w.owner.client.request(`${base}/alerts`);
  const legacyRow = listed.json.data.find((a) => a.id === legacyId);
  assert.equal(legacyRow.routing, null, 'a pre-0.2 alert reports no routing decision rather than a fabricated one');

  const rerouted = await w.grace.client.request(`${base}/alerts/${legacyId}/route`, { method: 'POST', body: {} });
  assert.equal(rerouted.res.status, 200);
  assert.equal(rerouted.json.data.resolution, 'ROUTED');
  assert.equal(rerouted.json.data.oncallUserId, w.ada.user.id, 'the current responder is resolved, not whoever was on call ten days ago');

  const nowAcked = await w.grace.client.request(`${base}/alerts/${legacyId}/acknowledge`, { method: 'POST', body: {} });
  assert.equal(nowAcked.res.status, 200);
  assert.equal(nowAcked.json.data.acknowledgedByUserId, w.grace.user.id);
});

test('historical routing records never change when the rotation, rule or schedule changes later', async (t) => {
  const h = await discordHarness(); t.after(() => h.close());
  const w = await buildWorkspace(h);
  const base = `/api/v1/organizations/${w.org.id}`;

  const alert = (await ingest(h, w.org, { title: 'Historical alert', serviceIdentifier: w.service.id, externalId: 'hist-1' })).json.data;
  assert.equal(alert.routing.oncallUserId, w.ada.user.id);
  assert.equal(alert.routing.oncallDisplayName, 'Ada Lovelace');
  assert.equal(alert.routing.scheduleName, 'Primary on-call');
  assert.equal(alert.routing.ruleName, 'Checkout criticals');
  assert.equal(alert.routing.teamName, 'Core Platform');

  // Advance the rotation by re-anchoring it, rename everything, and change priority.
  await w.owner.client.request(`${base}/oncall/schedules/${w.schedule.id}`, { method: 'PATCH', body: { name: 'Renamed schedule', rotationStartsAt: iso(-DAY - 60_000) } });
  await w.owner.client.request(`${base}/routing-rules/${w.rule.id}`, { method: 'PATCH', body: { name: 'Renamed rule', priority: 1 } });
  await w.owner.client.request(`${base}/teams/${w.team.id}`, { method: 'PATCH', body: { name: 'Renamed team' } });
  const current = await w.owner.client.request(`${base}/oncall/schedules/${w.schedule.id}/oncall`);
  assert.notEqual(current.json.data.userId, w.ada.user.id, 'the live rotation has genuinely moved on');

  const historical = await w.owner.client.request(`${base}/alerts/${alert.id}/routing`);
  assert.equal(historical.json.data.oncallUserId, w.ada.user.id, 'history records who was actually on call at routing time');
  assert.equal(historical.json.data.oncallDisplayName, 'Ada Lovelace');
  assert.equal(historical.json.data.scheduleName, 'Primary on-call', 'the snapshot name does not follow a rename');
  assert.equal(historical.json.data.ruleName, 'Checkout criticals');
  assert.equal(historical.json.data.teamName, 'Core Platform');

  // Deleting the rule and schedule must not erase the audit record.
  await w.owner.client.request(`${base}/routing-rules/${w.rule.id}`, { method: 'DELETE' });
  const afterRuleDelete = await w.owner.client.request(`${base}/alerts/${alert.id}/routing`);
  assert.equal(afterRuleDelete.res.status, 200);
  assert.equal(afterRuleDelete.json.data.ruleName, 'Checkout criticals', 'the snapshot survives rule deletion');
});

test('cross-organization access to teams, schedules, rules and alerts is refused', async (t) => {
  const h = await discordHarness(); t.after(() => h.close());
  const w = await buildWorkspace(h);
  const base = `/api/v1/organizations/${w.org.id}`;

  for (const path of ['/teams', '/oncall/state', '/oncall/schedules', '/routing-rules', '/alerts', '/routings', '/members', '/discord-identities']) {
    const read = await w.outsider.client.request(`${base}${path}`);
    assert.ok(read.res.status === 403, `outsider GET ${path} must be forbidden, got ${read.res.status}`);
  }
  for (const path of [`/teams/${w.team.id}`, `/oncall/schedules/${w.schedule.id}`, `/routing-rules/${w.rule.id}`, `/oncall/schedules/${w.schedule.id}/oncall`, `/oncall/schedules/${w.schedule.id}/overrides`]) {
    const read = await w.outsider.client.request(`${base}${path}`);
    assert.equal(read.res.status, 403, `outsider GET ${path} must be forbidden`);
  }

  // The outsider cannot inject themselves, or their own entities, into this org.
  const addOutsider = await w.owner.client.request(`${base}/teams/${w.team.id}/members`, { method: 'POST', body: { userId: w.outsider.user.id } });
  assert.equal(addOutsider.res.status, 400);
  assert.equal(addOutsider.json.error.code, 'INVALID_REFERENCE', 'a user from another organization must never be attachable');

  const outsiderTeam = (await w.outsider.client.request(`/api/v1/organizations/${w.otherOrg.id}/teams`, { method: 'POST', body: { name: 'Other Team' } })).json.data;
  const outsiderSchedule = await w.outsider.client.request(`/api/v1/organizations/${w.otherOrg.id}/oncall/schedules`, {
    method: 'POST', body: { name: 'Other schedule', teamId: outsiderTeam.id, timeZone: 'UTC', rotationStartsAt: iso(0), rotationIntervalMinutes: 1440, participantUserIds: [w.outsider.user.id] }
  });
  assert.equal(outsiderSchedule.res.status, 400, 'a schedule with no valid team members cannot be created');

  const crossTeamSchedule = await w.owner.client.request(`${base}/oncall/schedules`, {
    method: 'POST', body: { name: 'Cross tenant schedule', teamId: outsiderTeam.id, timeZone: 'UTC', rotationStartsAt: iso(0), rotationIntervalMinutes: 1440, participantUserIds: [w.ada.user.id] }
  });
  assert.equal(crossTeamSchedule.res.status, 400);
  assert.equal(crossTeamSchedule.json.error.code, 'INVALID_REFERENCE');

  const crossServiceRule = await w.owner.client.request(`${base}/routing-rules`, {
    method: 'POST', body: { name: 'Cross tenant rule', priority: 1, targetScheduleId: w.schedule.id, matchServiceId: 'does-not-exist-here' }
  });
  assert.equal(crossServiceRule.res.status, 400);

  const crossOwnerTeam = await w.owner.client.request(`${base}/services/${w.service.id}`, { method: 'PATCH', body: { ownerTeamId: outsiderTeam.id } });
  assert.equal(crossOwnerTeam.res.status, 400, 'a service cannot be owned by another organization\'s team');

  const crossDiscord = await w.owner.client.request(`${base}/discord-identities/${w.outsider.user.id}`, { method: 'PUT', body: { discordUserId: '223344556677889900' } });
  assert.equal(crossDiscord.res.status, 400, 'a non-member cannot be given a notification mapping');

  // The outsider cannot read or act on this organization's alerts.
  const alert = (await ingest(h, w.org, { title: 'Tenant alert', serviceIdentifier: w.service.id, externalId: 'tenant-1' })).json.data;
  assert.equal((await w.outsider.client.request(`${base}/alerts/${alert.id}`)).res.status, 403);
  assert.equal((await w.outsider.client.request(`${base}/alerts/${alert.id}/routing`)).res.status, 403);
  assert.equal((await w.outsider.client.request(`${base}/alerts/${alert.id}/acknowledge`, { method: 'POST', body: {} })).res.status, 403);
  assert.equal((await w.outsider.client.request(`${base}/alerts/${alert.id}/route`, { method: 'POST', body: {} })).res.status, 403);
  assert.equal((await w.outsider.client.request(`${base}/alerts/${alert.id}/incidents`, { method: 'POST', body: {} })).res.status, 403);
  assert.equal((await w.outsider.client.request(`${base}/teams/${w.team.id}/members/${w.ada.user.id}`, { method: 'DELETE' })).res.status, 403);
  assert.equal((await w.outsider.client.request(`${base}/routing-rules/${w.rule.id}`, { method: 'DELETE' })).res.status, 403);

  // An alert cannot be ingested into another organization's workspace by slug.
  const wrongOrg = await h.client().request('/api/v1/alerts', {
    method: 'POST', headers: { 'x-relay-alert-key': ALERT_KEY },
    body: { organizationSlug: w.otherOrg.slug, source: 'synthetic-monitor', title: 'Misdirected', severity: 'critical', externalId: 'tenant-1', serviceIdentifier: w.service.slug }
  });
  assert.equal(wrongOrg.res.status, 400, 'a service identifier from another organization must not resolve');
});

test('configuration authority follows the existing role model', async (t) => {
  const h = await discordHarness(); t.after(() => h.close());
  const w = await buildWorkspace(h);
  const base = `/api/v1/organizations/${w.org.id}`;

  // RESPONDER may observe routing and on-call state.
  for (const path of ['/teams', '/oncall/state', '/oncall/schedules', '/routing-rules', '/alerts', '/members']) {
    assert.equal((await w.ada.client.request(`${base}${path}`)).res.status, 200, `responder GET ${path}`);
  }
  // VIEWER may read too, but not configure or acknowledge.
  for (const path of ['/teams', '/oncall/state', '/oncall/schedules', '/routing-rules', '/alerts']) {
    assert.equal((await w.viewer.client.request(`${base}${path}`)).res.status, 200, `viewer GET ${path}`);
  }
  for (const actor of [w.ada, w.viewer]) {
    const label = actor === w.ada ? 'responder' : 'viewer';
    assert.equal((await actor.client.request(`${base}/teams`, { method: 'POST', body: { name: 'Nope' } })).res.status, 403, `${label} create team`);
    assert.equal((await actor.client.request(`${base}/teams/${w.team.id}`, { method: 'PATCH', body: { name: 'Nope' } })).res.status, 403, `${label} update team`);
    assert.equal((await actor.client.request(`${base}/teams/${w.team.id}/members`, { method: 'POST', body: { userId: w.grace.user.id } })).res.status, 403, `${label} add member`);
    assert.equal((await actor.client.request(`${base}/oncall/schedules`, { method: 'POST', body: { name: 'Nope', teamId: w.team.id, timeZone: 'UTC', rotationIntervalMinutes: 1440, participantUserIds: [w.ada.user.id] } })).res.status, 403, `${label} create schedule`);
    assert.equal((await actor.client.request(`${base}/oncall/schedules/${w.schedule.id}`, { method: 'PATCH', body: { enabled: false } })).res.status, 403, `${label} update schedule`);
    assert.equal((await actor.client.request(`${base}/oncall/schedules/${w.schedule.id}/overrides`, { method: 'POST', body: { replacementUserId: w.grace.user.id, startsAt: iso(0), endsAt: iso(DAY) } })).res.status, 403, `${label} create override`);
    assert.equal((await actor.client.request(`${base}/routing-rules`, { method: 'POST', body: { name: 'Nope', targetScheduleId: w.schedule.id } })).res.status, 403, `${label} create rule`);
    assert.equal((await actor.client.request(`${base}/routing-rules/${w.rule.id}`, { method: 'PATCH', body: { priority: 1 } })).res.status, 403, `${label} update rule`);
    assert.equal((await actor.client.request(`${base}/routing-rules/${w.rule.id}`, { method: 'DELETE' })).res.status, 403, `${label} delete rule`);
    assert.equal((await actor.client.request(`${base}/services/${w.service.id}`, { method: 'PATCH', body: { ownerTeamId: w.team.id } })).res.status, 403, `${label} set service ownership`);
    assert.equal((await actor.client.request(`${base}/discord-identities/${w.ada.user.id}`, { method: 'PUT', body: { discordUserId: '223344556677889900' } })).res.status, 403, `${label} map discord identity`);
  }
  // RESPONDER may acknowledge; VIEWER may not (asserted in the ack test too).
  const alert = (await ingest(h, w.org, { title: 'Authz alert', serviceIdentifier: w.service.id, externalId: 'authz-1' })).json.data;
  assert.equal((await w.ada.client.request(`${base}/alerts/${alert.id}/acknowledge`, { method: 'POST', body: {} })).res.status, 200);
  assert.equal((await w.viewer.client.request(`${base}/alerts/${alert.id}/acknowledge`, { method: 'POST', body: {} })).res.status, 403);

  // ADMIN shares configuration authority with OWNER.
  const admin = await registerMember(h, w.org.id, `admin-${Math.random().toString(36).slice(2)}@relay.test`, 'ADMIN', 'Anne Admin');
  assert.equal((await admin.client.request(`${base}/teams`, { method: 'POST', body: { name: 'Admin Team' } })).res.status, 201);
  assert.equal((await admin.client.request(`${base}/routing-rules/${w.rule.id}`, { method: 'PATCH', body: { priority: 42 } })).res.status, 200);

  // Unauthenticated access is refused.
  assert.equal((await h.client().request(`${base}/oncall/state`)).res.status, 401);
  assert.equal((await h.client().request(`${base}/alerts`)).res.status, 401);
});

test('malformed timezones, intervals, Discord ids and hostile rule or alert input are rejected', async (t) => {
  const h = await discordHarness(); t.after(() => h.close());
  const w = await buildWorkspace(h);
  const base = `/api/v1/organizations/${w.org.id}`;

  for (const timeZone of ['Not/AZone', 'Mars/Olympus_Mons', 'Europe/Bucharest; DROP TABLE users', '<script>alert(1)</script>', 'Local', 'GMT+3', '', '   ', 'A'.repeat(200)]) {
    const created = await w.owner.client.request(`${base}/oncall/schedules`, {
      method: 'POST', body: { name: 'Bad tz', teamId: w.team.id, timeZone, rotationStartsAt: iso(0), rotationIntervalMinutes: 1440, participantUserIds: [w.ada.user.id] }
    });
    assert.equal(created.res.status, 400, `timezone ${JSON.stringify(timeZone)} must be rejected`);
    assert.ok(['INVALID_TIMEZONE', 'VALIDATION_ERROR'].includes(created.json.error.code), `timezone ${JSON.stringify(timeZone)} -> ${created.json.error.code}`);
    const patched = await w.owner.client.request(`${base}/oncall/schedules/${w.schedule.id}`, { method: 'PATCH', body: { timeZone } });
    assert.equal(patched.res.status, 400, `patched timezone ${JSON.stringify(timeZone)} must be rejected`);
  }
  // A well-formed but unknown zone is reported as an invalid timezone specifically.
  const unknownZone = await w.owner.client.request(`${base}/oncall/schedules`, {
    method: 'POST', body: { name: 'Unknown zone', teamId: w.team.id, timeZone: 'Not/AZone', rotationStartsAt: iso(0), rotationIntervalMinutes: 1440, participantUserIds: [w.ada.user.id] }
  });
  assert.equal(unknownZone.json.error.code, 'INVALID_TIMEZONE');

  for (const rotationIntervalMinutes of [0, -1440, 59, 1440.5, 'soon', 525_601, null]) {
    const created = await w.owner.client.request(`${base}/oncall/schedules`, {
      method: 'POST', body: { name: 'Bad interval', teamId: w.team.id, timeZone: 'UTC', rotationStartsAt: iso(0), rotationIntervalMinutes, participantUserIds: [w.ada.user.id] }
    });
    assert.equal(created.res.status, 400, `interval ${JSON.stringify(rotationIntervalMinutes)} must be rejected`);
  }

  const noParticipants = await w.owner.client.request(`${base}/oncall/schedules`, {
    method: 'POST', body: { name: 'No participants', teamId: w.team.id, timeZone: 'UTC', rotationStartsAt: iso(0), rotationIntervalMinutes: 1440, participantUserIds: [] }
  });
  assert.equal(noParticipants.res.status, 400, 'a rotation needs at least one participant');

  const nonMemberParticipant = await w.owner.client.request(`${base}/oncall/schedules`, {
    method: 'POST', body: { name: 'Non member', teamId: w.team.id, timeZone: 'UTC', rotationStartsAt: iso(0), rotationIntervalMinutes: 1440, participantUserIds: [w.viewer.user.id] }
  });
  assert.equal(nonMemberParticipant.res.status, 400, 'a rotation participant must be a team member');
  assert.equal(nonMemberParticipant.json.error.code, 'INVALID_PARTICIPANT');

  for (const discordUserId of ['abc', '12345', '<@223344556677889900>', '@everyone', '223344556677889900extra', '2233445566778899 00', '1'.repeat(40)]) {
    const mapped = await w.owner.client.request(`${base}/discord-identities/${w.ada.user.id}`, { method: 'PUT', body: { discordUserId } });
    assert.equal(mapped.res.status, 400, `discord id ${JSON.stringify(discordUserId)} must be rejected`);
    assert.equal(mapped.json.error.code, 'VALIDATION_ERROR');
  }
  const validMapping = await w.owner.client.request(`${base}/discord-identities/${w.ada.user.id}`, { method: 'PUT', body: { discordUserId: '223344556677889900' } });
  assert.equal(validMapping.res.status, 200);

  for (const body of [
    { name: 'Bad priority', priority: -1, targetScheduleId: w.schedule.id },
    { name: 'Bad priority', priority: 100_001, targetScheduleId: w.schedule.id },
    { name: 'Bad priority', priority: 'high', targetScheduleId: w.schedule.id },
    { name: 'x', targetScheduleId: w.schedule.id },
    { name: 'No target', priority: 1 },
    { name: 'Bad target kind', priority: 1, targetKind: 'WEBHOOK', targetScheduleId: w.schedule.id },
    { name: 'Bad severities', priority: 1, matchSeverities: 'critical', targetScheduleId: w.schedule.id },
    { name: 'Too many severities', priority: 1, matchSeverities: Array.from({ length: 40 }, (_, i) => `s${i}`), targetScheduleId: w.schedule.id }
  ]) {
    const created = await w.owner.client.request(`${base}/routing-rules`, { method: 'POST', body });
    assert.equal(created.res.status, 400, `rule ${JSON.stringify(body).slice(0, 90)} must be rejected`);
  }

  // A rule whose payload contains markup is stored as inert text and cannot
  // reach a public surface or execute anything.
  const hostileName = '"><script>window.pwned=1</script>';
  const hostile = await w.owner.client.request(`${base}/routing-rules`, {
    method: 'POST', body: { name: hostileName, priority: 5, matchSource: '"><img src=x onerror=alert(1)>', targetScheduleId: w.schedule.id }
  });
  assert.equal(hostile.res.status, 201);
  assert.equal(hostile.json.data.name, hostileName, 'the value is stored verbatim as data');
  const routedHostile = await ingest(h, w.org, { title: '<img src=x onerror=alert(1)>', source: '"><img src=x onerror=alert(1)>', severity: 'critical', externalId: 'hostile-1' });
  assert.equal(routedHostile.res.status, 202);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].body.embeds[0].title.includes('<img'), false, 'angle brackets are stripped from Discord text');
  assert.equal(JSON.stringify(h.calls[0].body).includes('<script'), false);

  // Prototype-pollution style metadata is stored as inert data.
  const polluted = await ingest(h, w.org, { title: 'Polluted', serviceIdentifier: w.service.id, externalId: 'hostile-2', metadata: { __proto__: { polluted: true }, constructor: { prototype: { polluted: true } } } });
  assert.equal(polluted.res.status, 202);
  assert.equal({}.polluted, undefined, 'Object.prototype must not be polluted');
  const tooLarge = await ingest(h, w.org, { title: 'Big metadata', serviceIdentifier: w.service.id, externalId: 'hostile-3', metadata: { blob: 'x'.repeat(40_000) } });
  assert.equal(tooLarge.res.status, 400);

  // Malformed bodies are rejected without touching routing.
  assert.equal((await h.client().request('/api/v1/alerts', { method: 'POST', headers: { 'x-relay-alert-key': ALERT_KEY }, body: { organizationSlug: w.org.slug, source: 's', title: 't', severity: 'critical', timestamp: 'not-a-date' } })).res.status, 400);
  assert.equal((await h.client().request('/api/v1/alerts', { method: 'POST', headers: { 'x-relay-alert-key': 'wrong-key' }, body: { organizationSlug: w.org.slug, source: 's', title: 't', severity: 'critical' } })).res.status, 401);
});

test('creating an incident from an alert is explicit, traceable and cannot be repeated', async (t) => {
  const h = await discordHarness(); t.after(() => h.close());
  const w = await buildWorkspace(h);
  const base = `/api/v1/organizations/${w.org.id}`;

  const alert = (await ingest(h, w.org, { title: 'Escalate me', description: 'Sustained errors', serviceIdentifier: w.service.id, externalId: 'esc-1' })).json.data;
  assert.equal(alert.routing.incidentId, null, 'routing alone must never declare an incident');

  const forbidden = await w.viewer.client.request(`${base}/alerts/${alert.id}/incidents`, { method: 'POST', body: {} });
  assert.equal(forbidden.res.status, 403, 'VIEWER may not declare an incident');

  const created = await w.grace.client.request(`${base}/alerts/${alert.id}/incidents`, { method: 'POST', body: { severity: 'SEV2' } });
  assert.equal(created.res.status, 201);
  assert.equal(created.json.data.sourceAlertId, alert.id);
  assert.equal(created.json.data.title, 'Escalate me', 'the incident inherits the alert title by default');
  assert.deepEqual(created.json.data.affectedServiceIds, [w.service.id], 'the alert service is carried over');
  assert.ok(created.json.data.timeline.some((e) => e.eventType === 'INCIDENT_CREATED' && e.metadata?.sourceAlertId === alert.id), 'traceability from alert to incident is preserved');

  const linked = await w.owner.client.request(`${base}/alerts/${alert.id}/routing`);
  assert.equal(linked.json.data.incidentId, created.json.data.id, 'the routing record points back at the incident');

  const repeated = await w.grace.client.request(`${base}/alerts/${alert.id}/incidents`, { method: 'POST', body: {} });
  assert.equal(repeated.res.status, 409);
  assert.equal(repeated.json.error.code, 'ALERT_ALREADY_ESCALATED');

  // The alert is still acknowledged separately from incident resolution.
  assert.equal((await w.owner.client.request(`${base}/incidents/${created.json.data.id}`)).json.data.status, 'INVESTIGATING');
  assert.equal((await w.owner.client.request(`${base}/alerts/${alert.id}/routing`)).json.data.acknowledgedAt, null, 'an open incident does not imply an acknowledged alert');
});

test('public status surfaces expose none of the internal on-call configuration', async (t) => {
  const h = await discordHarness(); t.after(() => h.close());
  const w = await buildWorkspace(h);
  const base = `/api/v1/organizations/${w.org.id}`;

  await w.owner.client.request(`${base}/integrations/discord`, { method: 'PUT', body: { name: 'Ops', webhookUrl: DISCORD_URL, enabled: true } });
  await w.owner.client.request(`${base}/discord-identities/${w.ada.user.id}`, { method: 'PUT', body: { discordUserId: '223344556677889900' } });
  const component = (await w.owner.client.request(`${base}/components`, { method: 'POST', body: { name: 'Checkout', serviceIds: [w.service.id] } })).json.data;
  const page = (await w.owner.client.request(`${base}/status-pages`, { method: 'POST', body: { name: 'Public Status', slug: `public-${Math.random().toString(36).slice(2)}`, componentIds: [component.id], branding: { headline: 'Status', description: 'Public health' } } })).json.data;

  const incident = (await w.owner.client.request(`${base}/incidents`, { method: 'POST', body: { title: 'Public incident', severity: 'SEV2', affectedComponentIds: [component.id] } })).json.data;
  await w.owner.client.request(`${base}/incidents/${incident.id}/updates`, { method: 'POST', body: { message: 'INTERNAL-ROUTING-NOTE', isPublic: false } });
  await ingest(h, w.org, { title: 'Public leak probe', serviceIdentifier: w.service.id, externalId: 'leak-1' });

  const published = await h.client().request(`/api/v1/public/status/${page.slug}`);
  assert.equal(published.res.status, 200);
  const publicJson = JSON.stringify(published.json);
  for (const forbidden of ['Primary on-call', 'Core Platform', 'Checkout criticals', 'Ada Lovelace', '223344556677889900', WEBHOOK_TOKEN, 'INTERNAL-ROUTING-NOTE', 'Europe/Bucharest', 'rotationIntervalMinutes', 'oncallUserId', 'discordUserId']) {
    assert.equal(publicJson.includes(forbidden), false, `public status must not expose ${forbidden}`);
  }
  assert.equal(publicJson.includes('Public incident'), true, 'the public incident itself is still published');

  const publicIncident = await h.client().request(`/api/v1/public/status/${page.slug}/incidents/${incident.id}`);
  const incidentJson = JSON.stringify(publicIncident.json);
  assert.equal(incidentJson.includes('INTERNAL-ROUTING-NOTE'), false);
  assert.equal(incidentJson.includes('Ada Lovelace'), false);

  // Internal on-call endpoints are never reachable without a session.
  assert.equal((await h.client().request(`${base}/oncall/state`)).res.status, 401);
  assert.equal((await h.client().request(`${base}/routing-rules`)).res.status, 401);
  assert.equal((await h.client().request(`${base}/teams`)).res.status, 401);
  assert.equal((await h.client().request(`${base}/alerts`)).res.status, 401);
  assert.equal((await h.client().request(`${base}/discord-identities`)).res.status, 401);
});
