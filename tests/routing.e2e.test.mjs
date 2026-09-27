import test from 'node:test';
import assert from 'node:assert/strict';
import { createOrg, harness, register, registerMember } from './helpers.mjs';
import { RELAY_VERSION } from '../packages/shared/version.mjs';

// Relay 0.2 end-to-end journey: a monitoring system posts an alert with an
// ingest key, Relay routes it through a rule to a schedule, resolves the
// on-call responder, pages them on Discord, the responder acknowledges, and a
// human escalates the alert into an incident. Every step runs through the real
// HTTP API and the real store — no store internals are poked mid-journey except
// for organization membership, which Relay 0.1 has no invitation API for.

const ALERT_KEY = 'test-alert-key-123';
const WEBHOOK_TOKEN = 'e2e-super-secret-webhook-token';
const DISCORD_URL = `https://discord.com/api/webhooks/987654321098765432/${WEBHOOK_TOKEN}`;
const DISCORD_ID = '223344556677889900';
const DAY = 86_400_000;
const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();

test('E2E: alert → routing rule → on-call schedule → responder → notification → acknowledgement → incident', async (t) => {
  const calls = [];
  const logged = [];
  const h = await harness({
    fetchImpl: async (url, request) => { calls.push({ url: String(url), body: JSON.parse(request.body) }); return new Response(null, { status: 204 }); },
    logger: { warn: (...args) => logged.push(args.join(' ')), error: (...args) => logged.push(args.join(' ')) }
  });
  t.after(() => h.close());

  // ---- 1. Provision an organization and its operational model --------------
  const owner = await register(h.client, 'e2e-routing-owner@relay.test', 'Owner Prime');
  const org = await createOrg(owner, 'Relay 0.2 E2E');
  const base = `/api/v1/organizations/${org.id}`;
  const ada = await registerMember(h, org.id, 'e2e-ada@relay.test', 'RESPONDER', 'Ada Lovelace');
  const grace = await registerMember(h, org.id, 'e2e-grace@relay.test', 'RESPONDER', 'Grace Hopper');
  const linus = await registerMember(h, org.id, 'e2e-linus@relay.test', 'RESPONDER', 'Linus Torvalds');
  const viewer = await registerMember(h, org.id, 'e2e-viewer@relay.test', 'VIEWER', 'Vera Viewer');

  const service = (await owner.client.request(`${base}/services`, { method: 'POST', body: { name: 'Checkout API', description: 'Checkout requests' } })).json.data;
  const component = (await owner.client.request(`${base}/components`, { method: 'POST', body: { name: 'Payments', serviceIds: [service.id] } })).json.data;
  const page = (await owner.client.request(`${base}/status-pages`, { method: 'POST', body: { name: 'Public Status', slug: 'e2e-routing-status', componentIds: [component.id] } })).json.data;
  assert.ok(service.id && component.id && page.id);

  // ---- 2. Responder team owns the service ---------------------------------
  const team = (await owner.client.request(`${base}/teams`, { method: 'POST', body: { name: 'Core Platform', description: 'Owns checkout' } })).json.data;
  for (const member of [ada, grace, linus]) {
    const added = await owner.client.request(`${base}/teams/${team.id}/members`, { method: 'POST', body: { userId: member.user.id } });
    assert.equal(added.res.status, 201);
  }
  assert.equal((await owner.client.request(`${base}/teams/${team.id}`)).json.data.members.length, 3);
  const owned = await owner.client.request(`${base}/services/${service.id}`, { method: 'PATCH', body: { ownerTeamId: team.id } });
  assert.equal(owned.json.data.ownerTeamId, team.id, 'service ownership points at the responder team');
  assert.equal((await owner.client.request(`${base}/teams/${team.id}`)).json.data.services[0].id, service.id);

  // ---- 3. Daily rotation anchored one hour ago ----------------------------
  const schedule = (await owner.client.request(`${base}/oncall/schedules`, {
    method: 'POST',
    body: {
      name: 'Primary on-call', teamId: team.id, timeZone: 'Europe/Bucharest',
      rotationStartsAt: iso(-3600_000), rotationIntervalMinutes: 1440,
      participantUserIds: [ada.user.id, grace.user.id, linus.user.id]
    }
  })).json.data;
  assert.deepEqual(schedule.participants.map((p) => p.userId), [ada.user.id, grace.user.id, linus.user.id]);

  // ---- 4. Routing rule targets the schedule -------------------------------
  const rule = (await owner.client.request(`${base}/routing-rules`, {
    method: 'POST',
    body: { name: 'Checkout criticals', priority: 10, matchServiceId: service.id, matchSource: 'synthetic-monitor', matchSeverities: ['critical'], targetScheduleId: schedule.id }
  })).json.data;
  assert.equal(rule.scheduleName, 'Primary on-call');

  // ---- 5. Discord is the first notification channel -----------------------
  const discord = await owner.client.request(`${base}/integrations/discord`, { method: 'PUT', body: { name: 'Ops', webhookUrl: DISCORD_URL, enabled: true } });
  assert.equal(discord.res.status, 200);
  assert.equal(JSON.stringify(discord.json).includes(WEBHOOK_TOKEN), false, 'the webhook secret is never returned to the client');
  const mapped = await owner.client.request(`${base}/discord-identities/${ada.user.id}`, { method: 'PUT', body: { discordUserId: DISCORD_ID } });
  assert.equal(mapped.res.status, 200);

  // ---- 6. A monitoring system posts an alert with the ingest key ----------
  const post = await h.client().request('/api/v1/alerts', {
    method: 'POST',
    headers: { 'x-relay-alert-key': ALERT_KEY },
    body: {
      organizationSlug: org.slug, source: 'synthetic-monitor', externalId: 'e2e-checkout-1',
      title: 'Checkout p95 latency above SLO', description: 'p95 1.9s over 15 minutes',
      severity: 'critical', serviceIdentifier: service.slug, metadata: { region: 'eu-central-1' },
      observedAt: iso(-120_000)
    }
  });
  assert.equal(post.res.status, 202);
  const alert = post.json.data;
  assert.equal(alert.serviceId, service.id, 'the service identifier is resolved to a stored service');

  const routing = alert.routing;
  assert.equal(routing.resolution, 'ROUTED');
  assert.equal(routing.ruleId, rule.id);
  assert.equal(routing.ruleName, 'Checkout criticals');
  assert.equal(routing.scheduleId, schedule.id);
  assert.equal(routing.teamName, 'Core Platform');
  assert.equal(routing.oncallUserId, ada.user.id, 'the responder on call at the routing instant is selected');
  assert.equal(routing.oncallDisplayName, 'Ada Lovelace');
  assert.equal(routing.responderSource, 'ROTATION');
  assert.equal(routing.notificationStatus, 'SENT');
  assert.equal(routing.notificationProvider, 'DISCORD');
  assert.ok(routing.notifiedAt, 'the notification timestamp is recorded');
  assert.equal(routing.acknowledgedAt, null, 'routing never acknowledges on the operator\'s behalf');

  // ---- 7. The Discord page carries the operational facts ------------------
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, DISCORD_URL);
  const embed = calls[0].body.embeds[0];
  assert.equal(embed.title, 'Alert routed — Checkout p95 latency above SLO');
  const fields = Object.fromEntries(embed.fields.map((f) => [f.name, f.value]));
  assert.equal(fields.Severity, 'critical');
  assert.equal(fields.Source, 'synthetic-monitor');
  assert.equal(fields.Service, 'Checkout API');
  assert.equal(fields['Routed via'], 'Checkout criticals → Primary on-call → Core Platform');
  assert.ok(fields['On call'].includes('<@223344556677889900>'), 'the mapped Discord identity is mentioned');
  assert.ok(fields['On call'].includes('Ada Lovelace'));
  assert.ok(fields.Observed.includes('UTC'), 'the observed timestamp is rendered in the schedule timezone');
  assert.deepEqual(calls[0].body.allowed_mentions.parse, [], 'no role or everyone mention may be parsed from alert text');
  assert.deepEqual(calls[0].body.allowed_mentions.users, [DISCORD_ID]);

  // ---- 8. Idempotent replay neither duplicates nor re-pages ---------------
  const replay = await h.client().request('/api/v1/alerts', {
    method: 'POST', headers: { 'x-relay-alert-key': ALERT_KEY },
    body: { organizationSlug: org.slug, source: 'synthetic-monitor', externalId: 'e2e-checkout-1', title: 'Checkout p95 latency above SLO', severity: 'critical' }
  });
  assert.equal(replay.res.status, 202, 'alert intake keeps its 0.1 accepted semantics');
  assert.equal(replay.json.data.duplicate, true, 'a replayed alert is reported as already known');
  assert.equal(replay.json.data.id, alert.id);
  assert.equal(replay.json.data.routing.id, routing.id);
  assert.equal(calls.length, 1, 'an idempotent retry must not page the responder a second time');
  const wrongKey = await h.client().request('/api/v1/alerts', { method: 'POST', headers: { 'x-relay-alert-key': 'wrong-key' }, body: { organizationSlug: org.slug, source: 'synthetic-monitor', title: 'Rejected', severity: 'critical' } });
  assert.equal(wrongKey.res.status, 401);

  // ---- 9. Anyone in the org can see who is on call now --------------------
  const state = await viewer.client.request(`${base}/oncall/state`);
  assert.equal(state.res.status, 200, 'VIEWER may read the on-call state');
  assert.equal(state.json.data.oncall[0].current.userId, ada.user.id);
  assert.equal(state.json.data.oncall[0].next[0].userId, grace.user.id);
  assert.equal(state.json.data.oncall[0].schedule.timeZone, 'Europe/Bucharest');
  const at = (await viewer.client.request(`${base}/oncall/schedules/${schedule.id}/oncall?at=${encodeURIComponent(iso(DAY + 60_000))}`)).json.data;
  assert.equal(at.userId, grace.user.id, 'tomorrow the next responder is on call');

  // ---- 10. Acknowledgement is authorized, first-wins and idempotent -------
  const asViewer = await viewer.client.request(`${base}/alerts/${alert.id}/acknowledge`, { method: 'POST', body: {} });
  assert.equal(asViewer.res.status, 403, 'a VIEWER cannot acknowledge');
  const ack = await grace.client.request(`${base}/alerts/${alert.id}/acknowledge`, { method: 'POST', body: { note: 'Looking at the checkout traces.' } });
  assert.equal(ack.res.status, 200);
  assert.equal(ack.json.alreadyAcknowledged, false, 'the first acknowledgement is reported alongside the routing record');
  assert.equal(ack.json.data.acknowledgedByUserId, grace.user.id);
  assert.equal(ack.json.data.acknowledgedByDisplayName, 'Grace Hopper');
  const reack = await ada.client.request(`${base}/alerts/${alert.id}/acknowledge`, { method: 'POST', body: {} });
  assert.equal(reack.res.status, 200);
  assert.equal(reack.json.alreadyAcknowledged, true, 're-acknowledging is a defined idempotent outcome');
  assert.equal(reack.json.data.acknowledgedByUserId, grace.user.id, 'the first acknowledgement stands');

  // ---- 11. Only a human may turn an alert into an incident ----------------
  const beforeIncidents = (await owner.client.request(`${base}/incidents`)).json.data;
  assert.equal(beforeIncidents.length, 0, 'routing and acknowledgement never create an incident');
  const escalate = await grace.client.request(`${base}/alerts/${alert.id}/incidents`, {
    method: 'POST', body: { title: 'Checkout latency breach', severity: 'SEV2', summary: 'Escalated from a routed alert.', affectedComponentIds: [component.id] }
  });
  assert.equal(escalate.res.status, 201);
  const incident = escalate.json.data;
  assert.equal(incident.affectedServiceIds[0], service.id, 'the alert service seeds the incident scope');
  assert.ok(incident.timeline.some((e) => e.metadata?.sourceAlertId === alert.id), 'the incident records which alert it came from');
  const routed = await owner.client.request(`${base}/alerts/${alert.id}/routing`);
  assert.equal(routed.json.data.incidentId, incident.id, 'the routing record links to the incident');
  const again = await grace.client.request(`${base}/alerts/${alert.id}/incidents`, { method: 'POST', body: { title: 'Duplicate', severity: 'SEV4' } });
  assert.equal(again.res.status, 409, 'an alert is escalated at most once');

  // ---- 12. Public page shows the incident, never the internal machinery ---
  const publicRes = await h.client().request('/api/v1/public/status/e2e-routing-status');
  assert.equal(publicRes.res.status, 200);
  const publicJson = JSON.stringify(publicRes.json);
  assert.equal(publicJson.includes('Checkout latency breach'), true);
  for (const secret of [WEBHOOK_TOKEN, DISCORD_ID, 'Primary on-call', 'Core Platform', 'Ada Lovelace', 'Grace Hopper', 'Europe/Bucharest', ALERT_KEY, 'Looking at the checkout traces']) {
    assert.equal(publicJson.includes(secret), false, `public payload must not contain ${secret}`);
  }

  // ---- 13. Resolving the incident does not un-acknowledge the alert -------
  await owner.client.request(`${base}/incidents/${incident.id}/resolve`, { method: 'POST', body: {} });
  const afterResolve = await owner.client.request(`${base}/alerts/${alert.id}/routing`);
  assert.equal(afterResolve.json.data.acknowledgedByUserId, grace.user.id, 'alert acknowledgement is independent of incident resolution');
  assert.equal(afterResolve.json.data.resolution, 'ROUTED');

  // ---- 14. History is immutable when the rotation moves on ----------------
  await owner.client.request(`${base}/oncall/schedules/${schedule.id}`, { method: 'PATCH', body: { name: 'Renamed schedule', rotationStartsAt: iso(-DAY - 60_000) } });
  await owner.client.request(`${base}/routing-rules/${rule.id}`, { method: 'PATCH', body: { name: 'Renamed rule' } });
  await owner.client.request(`${base}/teams/${team.id}`, { method: 'PATCH', body: { name: 'Renamed team' } });
  const live = (await owner.client.request(`${base}/oncall/schedules/${schedule.id}/oncall`)).json.data;
  assert.notEqual(live.userId, ada.user.id, 'the live rotation has genuinely moved on');
  const historical = await owner.client.request(`${base}/alerts/${alert.id}/routing`);
  assert.equal(historical.json.data.oncallUserId, ada.user.id, 'the audit record still names who was actually paged');
  assert.equal(historical.json.data.oncallDisplayName, 'Ada Lovelace');
  assert.equal(historical.json.data.scheduleName, 'Primary on-call', 'snapshot names do not follow renames');
  assert.equal(historical.json.data.ruleName, 'Checkout criticals');
  assert.equal(historical.json.data.teamName, 'Core Platform');
  const audit = await owner.client.request(`${base}/routings`);
  assert.equal(audit.res.status, 200);
  assert.equal(audit.json.data[0].alertId, alert.id, 'the routing audit trail is queryable');

  // ---- 15. Overrides change the future, never the past --------------------
  const override = (await owner.client.request(`${base}/oncall/schedules/${schedule.id}/overrides`, {
    method: 'POST', body: { replacementUserId: ada.user.id, startsAt: iso(60_000), endsAt: iso(3600_000), reason: 'Scheduled responder unavailable' }
  })).json.data;
  assert.equal(override.replacementUserId, ada.user.id);
  const duringOverride = (await owner.client.request(`${base}/oncall/schedules/${schedule.id}/oncall?at=${encodeURIComponent(iso(120_000))}`)).json.data;
  assert.equal(duringOverride.userId, ada.user.id);
  assert.equal(duringOverride.source, 'OVERRIDE');
  const afterOverride = (await owner.client.request(`${base}/oncall/schedules/${schedule.id}/oncall?at=${encodeURIComponent(iso(7200_000))}`)).json.data;
  assert.notEqual(afterOverride.userId, ada.user.id, 'the rotation resumes once the override ends');
  assert.equal(afterOverride.source, 'ROTATION');
  assert.equal((await owner.client.request(`${base}/alerts/${alert.id}/routing`)).json.data.oncallUserId, ada.user.id);
  assert.equal((await owner.client.request(`${base}/oncall/overrides/${override.id}`, { method: 'DELETE' })).res.status, 204);

  // ---- 16. Secrets stay out of responses and logs -------------------------
  const settingsPage = JSON.stringify((await owner.client.request(`${base}/integrations`)).json);
  assert.equal(settingsPage.includes(WEBHOOK_TOKEN), false);
  assert.equal(JSON.stringify(logged).includes(WEBHOOK_TOKEN), false, 'the webhook secret is never written to logs');
  assert.equal(JSON.stringify(calls.map((c) => c.body)).includes(ALERT_KEY), false);

  // ---- 17. The API surface is versioned, documented and at 0.2 ------------
  const health = await h.client().request('/api/v1/health');
  assert.equal(health.json.version, RELAY_VERSION);
  const spec = await h.client().request('/api/v1/openapi.json');
  assert.equal(spec.res.status, 200);
  assert.equal(spec.json.openapi.startsWith('3.'), true);
  for (const path of [
    '/alerts',
    '/organizations/{organizationId}/members',
    '/organizations/{organizationId}/teams',
    '/organizations/{organizationId}/teams/{teamId}/members',
    '/organizations/{organizationId}/oncall/state',
    '/organizations/{organizationId}/oncall/schedules',
    '/organizations/{organizationId}/oncall/schedules/{scheduleId}/oncall',
    '/organizations/{organizationId}/oncall/schedules/{scheduleId}/overrides',
    '/organizations/{organizationId}/routing-rules',
    '/organizations/{organizationId}/alerts',
    '/organizations/{organizationId}/alerts/{alertId}/routing',
    '/organizations/{organizationId}/alerts/{alertId}/acknowledge',
    '/organizations/{organizationId}/alerts/{alertId}/route',
    '/organizations/{organizationId}/alerts/{alertId}/incidents',
    '/organizations/{organizationId}/routings',
    '/organizations/{organizationId}/discord-identities'
  ]) {
    assert.ok(spec.json.paths[path], `the OpenAPI document must describe ${path}`);
  }
  assert.ok(spec.json.components.schemas.AlertRouting, 'the routing audit record is a documented schema');
  const alertPages = calls.filter((c) => String(c.body.embeds?.[0]?.title ?? '').startsWith('Alert routed'));
  assert.equal(alertPages.length, 1, 'the whole journey pages the responder for this alert exactly once');
  assert.ok(calls.length >= 1, 'Discord was used as the first notification channel');
});
