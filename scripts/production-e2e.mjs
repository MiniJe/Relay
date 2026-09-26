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

/** POST to the keyed alert-intake endpoint, which is not session-authenticated. */
async function postAlert(alertKey, body, keyOverride) {
  const res = await fetch(`${baseUrl}/api/v1/alerts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-relay-alert-key': keyOverride ?? alertKey },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  let json = {};
  if (text) { try { json = JSON.parse(text); } catch { throw new Error(`POST /api/v1/alerts returned non-JSON ${res.status}: ${text.slice(0, 500)}`); } }
  return { status: res.status, json };
}

const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();
const HOUR = 3_600_000;
const DAY = 86_400_000;

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

  // =========================================================================
  // Relay 0.2 - alert routing and on-call foundation
  // =========================================================================
  const orgBase = `/api/v1/organizations/${organization.id}`;

  r = await client.request(`${orgBase}/members`, { expected: 200 });
  assert.ok(r.json.data.some((m) => m.userId === user.id && m.role === 'OWNER'), 'member roster must include the owner');

  r = await client.request(`${orgBase}/teams`, {
    method: 'POST',
    body: { name: `Release Verification Team ${marker}`, description: 'Owns the release verification service.' },
    expected: 201
  });
  const team = r.json.data;
  assert.equal(team.slug, `release-verification-team-${marker}`.toLowerCase());

  await client.request(`${orgBase}/teams/${team.id}/members`, { method: 'POST', body: { userId: user.id }, expected: 201 });
  r = await client.request(`${orgBase}/teams/${team.id}/members`, { method: 'POST', body: { userId: user.id }, expected: 200 });
  assert.equal(r.json.data.alreadyMember, true, 'adding an existing team member must be a reported no-op');
  r = await client.request(`${orgBase}/teams/${team.id}`, { expected: 200 });
  assert.equal(r.json.data.members.length, 1, 'adding an existing team member must be idempotent');
  assert.equal(r.json.data.members[0].userId, user.id);

  r = await client.request(`${orgBase}/teams/${team.id}/members`, { method: 'POST', body: { userId: crypto.randomUUID() }, expected: 400 });
  assert.equal(r.json.error.code, 'INVALID_REFERENCE', 'a user outside the organization can never join a team');

  r = await client.request(`${orgBase}/services/${service.id}`, { method: 'PATCH', body: { ownerTeamId: team.id }, expected: 200 });
  assert.equal(r.json.data.ownerTeamId, team.id, 'service ownership must persist');
  r = await client.request(`${orgBase}/teams/${team.id}`, { expected: 200 });
  assert.ok(r.json.data.services.some((x) => x.id === service.id), 'the team must list the services it owns');

  // A daily rotation anchored one hour ago, in a non-UTC zone.
  const rotationStartsAt = new Date(Date.now() - HOUR).toISOString();
  r = await client.request(`${orgBase}/oncall/schedules`, {
    method: 'POST',
    body: {
      name: 'Release verification on-call', teamId: team.id, timeZone: 'Europe/Bucharest',
      rotationStartsAt, rotationIntervalMinutes: 1440, participantUserIds: [user.id]
    },
    expected: 201
  });
  const schedule = r.json.data;
  assert.equal(schedule.timeZone, 'Europe/Bucharest');
  assert.deepEqual(schedule.participants.map((p) => p.userId), [user.id]);

  r = await client.request(`${orgBase}/oncall/schedules`, {
    method: 'POST',
    body: { name: 'Bad timezone', teamId: team.id, timeZone: 'Not/AZone', rotationStartsAt, rotationIntervalMinutes: 1440, participantUserIds: [user.id] },
    expected: 400
  });
  assert.equal(r.json.error.code, 'INVALID_TIMEZONE', 'a malformed timezone must be rejected before persistence');

  r = await client.request(`${orgBase}/oncall/schedules`, {
    method: 'POST',
    body: { name: 'Bad roster', teamId: team.id, timeZone: 'UTC', rotationStartsAt, rotationIntervalMinutes: 1440, participantUserIds: [crypto.randomUUID()] },
    expected: 400
  });
  assert.equal(r.json.error.code, 'INVALID_PARTICIPANT', 'every rotation participant must be a team member');

  r = await client.request(`${orgBase}/oncall/schedules/${schedule.id}/oncall`, { expected: 200 });
  assert.equal(r.json.data.resolved, true);
  assert.equal(r.json.data.userId, user.id, 'the rotation must resolve its first participant');
  assert.equal(r.json.data.source, 'ROTATION');
  assert.ok(r.json.data.periodStartsAt && r.json.data.periodEndsAt);

  r = await client.request(`${orgBase}/oncall/schedules/${schedule.id}/oncall?at=${encodeURIComponent(iso(DAY + HOUR))}`, { expected: 200 });
  assert.equal(r.json.data.userId, user.id, 'a single-participant rotation is stable across handoffs');

  r = await client.request(`${orgBase}/oncall/state`, { expected: 200 });
  assert.equal(r.json.data.oncall[0].current.userId, user.id, 'the state endpoint must agree with the schedule endpoint');
  assert.equal(r.json.data.oncall[0].schedule.timeZone, 'Europe/Bucharest');

  r = await client.request(`${orgBase}/oncall/schedules/${schedule.id}/overrides`, {
    method: 'POST',
    body: { replacementUserId: user.id, startsAt: iso(HOUR), endsAt: iso(2 * HOUR), reason: 'Release verification overlap check.' },
    expected: 201
  });
  const overlapProbe = r.json.data;
  r = await client.request(`${orgBase}/oncall/schedules/${schedule.id}/overrides`, {
    method: 'POST',
    body: { replacementUserId: user.id, startsAt: iso(90 * 60_000), endsAt: iso(3 * HOUR), reason: 'Clash.' },
    expected: 409
  });
  assert.equal(r.json.error.code, 'OVERRIDE_OVERLAP', 'overlapping overrides must be refused deterministically');

  r = await client.request(`${orgBase}/oncall/schedules/${schedule.id}/oncall?at=${encodeURIComponent(iso(90 * 60_000))}`, { expected: 200 });
  assert.equal(r.json.data.source, 'OVERRIDE');
  assert.equal(r.json.data.overrideId, overlapProbe.id);

  await client.request(`${orgBase}/oncall/overrides/${overlapProbe.id}`, { method: 'DELETE', expected: 204 });
  r = await client.request(`${orgBase}/oncall/schedules/${schedule.id}/oncall?at=${encodeURIComponent(iso(90 * 60_000))}`, { expected: 200 });
  assert.equal(r.json.data.source, 'ROTATION', 'the rotation must resume unchanged once the override ends');

  // A second, surviving override so restart mode can prove override durability.
  r = await client.request(`${orgBase}/oncall/schedules/${schedule.id}/overrides`, {
    method: 'POST',
    body: { replacementUserId: user.id, startsAt: iso(DAY), endsAt: iso(DAY + 2 * HOUR), reason: 'Release verification durability override.' },
    expected: 201
  });
  const durableOverride = r.json.data;

  r = await client.request(`${orgBase}/routing-rules`, {
    method: 'POST',
    body: {
      name: 'Release verification criticals', priority: 10, matchServiceId: service.id,
      matchSource: 'release-verifier', matchSeverities: ['critical'], targetScheduleId: schedule.id
    },
    expected: 201
  });
  const rule = r.json.data;
  assert.equal(rule.scheduleName, schedule.name);

  r = await client.request(`${orgBase}/routing-rules`, {
    method: 'POST',
    body: { name: 'Release verification catch-all', priority: 900, targetScheduleId: schedule.id },
    expected: 201
  });
  const catchAll = r.json.data;

  r = await client.request(`${orgBase}/routing-rules`, { expected: 200 });
  assert.deepEqual(r.json.data.map((x) => x.name), [rule.name, catchAll.name], 'rules must be ordered by explicit priority');

  const alertKey = process.env.ALERT_INGEST_KEY;
  let alert = null;
  let escalatedIncident = null;
  if (!alertKey) {
    console.log('Production E2E NOTE: ALERT_INGEST_KEY is not set, so alert intake/routing/acknowledgement verification is skipped. Configuration, on-call resolution and rule ordering were still verified.');
  } else {
    const alertPayload = {
      organizationSlug: organization.slug, source: 'release-verifier', externalId: `release-${marker}`,
      title: `Release verification alert ${marker}`, description: 'Production-path alert routing verification.',
      severity: 'critical', serviceIdentifier: service.slug, metadata: { marker },
      timestamp: new Date(Date.now() - 60_000).toISOString()
    };
    const intake = await postAlert(alertKey, alertPayload);
    assert.equal(intake.status, 202, `alert intake must return 202, got ${intake.status}: ${JSON.stringify(intake.json)}`);
    alert = intake.json.data;
    assert.equal(alert.duplicate, false);
    assert.equal(alert.serviceId, service.id, 'the service identifier must resolve to a stored service');
    assert.equal(JSON.stringify(intake.json).includes(alertKey), false, 'the ingest key must never be echoed');

    const routing = alert.routing;
    assert.ok(routing, 'intake must return the routing record');
    assert.equal(routing.resolution, 'ROUTED');
    assert.equal(routing.ruleId, rule.id);
    assert.equal(routing.ruleName, rule.name);
    assert.equal(routing.scheduleId, schedule.id);
    assert.equal(routing.teamName, team.name);
    assert.equal(routing.oncallUserId, user.id, 'the responder on call at the routing instant must be selected');
    assert.equal(routing.responderSource, 'ROTATION');
    assert.ok(['SENT', 'FAILED', 'SKIPPED_NO_INTEGRATION', 'SKIPPED_DISABLED'].includes(routing.notificationStatus), `unexpected notification status ${routing.notificationStatus}`);
    assert.equal(routing.acknowledgedAt, null, 'routing must never acknowledge on the operator\'s behalf');
    assert.equal(routing.incidentId, null, 'routing must never create an incident');

    const replay = await postAlert(alertKey, alertPayload);
    assert.equal(replay.status, 202);
    assert.equal(replay.json.data.duplicate, true, 'a replayed alert must be reported as a duplicate');
    assert.equal(replay.json.data.id, alert.id);
    assert.equal(replay.json.data.routing.id, routing.id, 'a replay must never create a second routing record');

    const rejected = await postAlert(alertKey, alertPayload, 'definitely-the-wrong-key');
    assert.equal(rejected.status, 401, 'an invalid ingest key must be rejected');

    r = await client.request(`${orgBase}/alerts`, { expected: 200 });
    const listed = r.json.data.find((x) => x.id === alert.id);
    assert.ok(listed?.routing, 'the alert list must join the routing record');
    assert.equal(listed.routing.resolution, 'ROUTED');
    assert.equal(listed.serviceName, service.name);

    r = await client.request(`${orgBase}/alerts/${alert.id}/routing`, { expected: 200 });
    assert.equal(r.json.data.oncallUserId, user.id);

    r = await client.request(`${orgBase}/routings`, { expected: 200 });
    assert.ok(r.json.data.some((x) => x.alertId === alert.id), 'the routing audit trail must be queryable');

    r = await client.request(`${orgBase}/alerts/${alert.id}/acknowledge`, { method: 'POST', body: { note: `Release verification acknowledgement ${marker}` }, expected: 200 });
    assert.equal(r.json.alreadyAcknowledged, false);
    assert.equal(r.json.data.acknowledgedByUserId, user.id);
    r = await client.request(`${orgBase}/alerts/${alert.id}/acknowledge`, { method: 'POST', body: {}, expected: 200 });
    assert.equal(r.json.alreadyAcknowledged, true, 're-acknowledging must be an idempotent no-op');
    assert.equal(r.json.data.acknowledgedByUserId, user.id);

    r = await client.request(`${orgBase}/incidents`, { expected: 200 });
    assert.equal(r.json.data.length, 1, 'acknowledgement must not create an incident');

    r = await client.request(`${orgBase}/alerts/${alert.id}/incidents`, {
      method: 'POST',
      body: { title: `Escalated from alert ${marker}`, severity: 'SEV3', summary: 'Explicit human escalation from a routed alert.', affectedComponentIds: [component.id] },
      expected: 201
    });
    escalatedIncident = r.json.data;
    assert.deepEqual(escalatedIncident.affectedServiceIds, [service.id], 'the alert service must seed the incident scope');
    assert.ok(escalatedIncident.timeline.some((e) => e.metadata?.sourceAlertId === alert.id), 'the incident must record which alert it came from');

    r = await client.request(`${orgBase}/alerts/${alert.id}/incidents`, { method: 'POST', body: { title: 'Duplicate escalation', severity: 'SEV4' }, expected: 409 });
    assert.equal(r.json.error.code, 'ALERT_ALREADY_ESCALATED');

    r = await client.request(`${orgBase}/alerts/${alert.id}/routing`, { expected: 200 });
    assert.equal(r.json.data.incidentId, escalatedIncident.id, 'the routing record must link the escalated incident');

    // Public boundary: on-call machinery must never appear publicly.
    r = await client.request(`/api/v1/public/status/${statusSlug}`, { expected: 200 });
    const publicJson = JSON.stringify(r.json);
    assert.equal(publicJson.includes('Escalated from alert'), true, 'the escalated incident is published like any other incident');
    for (const internal of [team.name, schedule.name, rule.name, catchAll.name, alertKey, internalMessage, 'release-verifier', durableOverride.reason]) {
      assert.equal(publicJson.includes(internal), false, `public status must not leak ${internal}`);
    }

    r = await client.request(`${orgBase}/incidents/${escalatedIncident.id}/resolve`, { method: 'POST', body: {}, expected: 200 });
    assert.equal(r.json.data.status, 'RESOLVED');
    r = await client.request(`${orgBase}/alerts/${alert.id}/routing`, { expected: 200 });
    assert.equal(r.json.data.acknowledgedByUserId, user.id, 'incident resolution must not un-acknowledge the alert');

    // Historical immutability: rename everything the record references.
    await client.request(`${orgBase}/oncall/schedules/${schedule.id}`, { method: 'PATCH', body: { name: 'Renamed schedule', rotationStartsAt: new Date(Date.now() - DAY - HOUR).toISOString() }, expected: 200 });
    await client.request(`${orgBase}/teams/${team.id}`, { method: 'PATCH', body: { name: 'Renamed team' }, expected: 200 });
    await client.request(`${orgBase}/routing-rules/${rule.id}`, { method: 'PATCH', body: { name: 'Renamed rule', priority: 5 }, expected: 200 });
    await client.request(`${orgBase}/routing-rules/${catchAll.id}`, { method: 'DELETE', expected: 204 });

    r = await client.request(`${orgBase}/alerts/${alert.id}/routing`, { expected: 200 });
    assert.equal(r.json.data.oncallUserId, user.id, 'history must still name who was actually paged');
    assert.equal(r.json.data.scheduleName, schedule.name, 'the snapshotted schedule name must not follow a rename');
    assert.equal(r.json.data.teamName, team.name, 'the snapshotted team name must not follow a rename');
    assert.equal(r.json.data.ruleName, rule.name, 'the snapshotted rule name must not follow a rename');
    assert.equal(r.json.data.resolution, 'ROUTED');
  }

  // ---- Relay 0.2 / M-002: durable delivery and escalation read model -------
  let deliveryState = null;
  if (alert) {
    const deliveries = (await client.request(`${orgBase}/alerts/${alert.id}/deliveries`, { expected: 200 })).json;
    assert.ok(deliveries.data.length >= 1, 'routing must persist at least one logical delivery for the configured channel');
    assert.equal(deliveries.summary.total, deliveries.data.length);
    assert.equal(typeof deliveries.summary.label, 'string', 'the delivery summary must carry an operator-readable label');
    const first = deliveries.data[0];
    assert.equal(typeof first.statusLabel, 'string', 'every delivery carries an operator-readable state label');
    assert.ok(Array.isArray(first.attempts), 'the delivery read model must include its attempt history');
    assert.equal(first.attempts.length, first.attemptCount, 'there is exactly one immutable attempt row per recorded attempt');
    assert.equal(first.destination.integrationId !== undefined, true, 'the destination snapshot describes where the page went without exposing a secret');

    let detail = (await client.request(`${orgBase}/deliveries/${first.id}`, { expected: 200 })).json.data;
    assert.equal(detail.id, first.id);
    assert.equal(detail.alert.id, alert.id, 'a delivery is always traceable to its alert');
    const serialized = JSON.stringify(deliveries) + JSON.stringify(detail);
    for (const forbidden of [alertKey, 'hooks.slack.com', 'smtp://', 'password']) {
      assert.equal(serialized.includes(forbidden), false, `delivery reads must never expose ${forbidden}`);
    }

    // A delivered page is terminal; anything else can be retried by a human,
    // and the retry adds an attempt instead of erasing the history.
    if (first.status === 'SENT') {
      const retry = await client.request(`${orgBase}/deliveries/${first.id}/retry`, { method: 'POST', body: {}, expected: 409 });
      assert.equal(retry.json.error.code, 'DELIVERY_ALREADY_SENT', 'a delivered page is never re-sent by a manual retry');
    } else {
      const before = first.attemptCount;
      const retry = await client.request(`${orgBase}/deliveries/${first.id}/retry`, { method: 'POST', body: {}, expected: 202 });
      assert.ok(retry.json.data.attempts.length >= before, 'a manual retry preserves and extends the attempt history');
      assert.ok(['FAILED', 'RETRYING', 'SENT'].includes(retry.json.data.status), `unexpected post-retry status ${retry.json.data.status}`);
    }
    detail = (await client.request(`${orgBase}/deliveries/${first.id}`, { expected: 200 })).json.data;

    const escalation = (await client.request(`${orgBase}/alerts/${alert.id}/escalation`, { expected: 200 })).json.data;
    assert.equal(escalation.planned, escalation.steps.length, 'the escalation read model reports every materialized step');
    assert.equal(typeof escalation.executed, 'number');
    assert.equal(typeof escalation.unresolved, 'number');
    assert.equal(Array.isArray(escalation.immediateDeliveries), true);
    const allDeliveries = (await client.request(`${orgBase}/alerts/${alert.id}/deliveries`, { expected: 200 })).json;
    assert.equal(allDeliveries.data.length, 1 + escalation.steps.reduce((sum, step) => sum + step.deliveries.length, 0), 'immediate and escalation pages are both present in the audit');

    deliveryState = {
      deliveryId: detail.id,
      provider: detail.provider,
      status: detail.status,
      attemptCount: detail.attemptCount,
      completionAt: detail.completedAt ?? null,
      attemptIds: detail.attempts.map((attempt) => attempt.id),
      attemptOutcomes: detail.attempts.map((attempt) => attempt.outcome),
      escalationPlanned: escalation.planned,
      escalationExecuted: escalation.executed,
      escalationCancelled: escalation.cancelled
    };
  }

  // Re-read the 0.2 configuration so restart mode verifies whatever is actually
  // persisted now, including the renames performed by the immutability checks.
  const finalSchedule = (await client.request(`${orgBase}/oncall/schedules/${schedule.id}`, { expected: 200 })).json.data;
  const finalTeam = (await client.request(`${orgBase}/teams/${team.id}`, { expected: 200 })).json.data;
  const finalRules = (await client.request(`${orgBase}/routing-rules`, { expected: 200 })).json.data;
  const finalRule = finalRules.find((x) => x.id === rule.id) ?? null;

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
    postmortemTitle: postmortemPayload.title,
    relay02: {
      teamId: team.id,
      teamName: finalTeam.name,
      scheduleId: schedule.id,
      scheduleName: finalSchedule.name,
      originalScheduleName: schedule.name,
      originalTeamName: team.name,
      rotationStartsAt: finalSchedule.rotationStartsAt,
      timeZone: finalSchedule.timeZone,
      rotationIntervalMinutes: finalSchedule.rotationIntervalMinutes,
      ruleId: finalRule?.id ?? null,
      ruleName: finalRule?.name ?? null,
      rulePriority: finalRule?.priority ?? null,
      originalRuleName: rule.name,
      overrideId: durableOverride.id,
      overrideReason: durableOverride.reason,
      alertId: alert?.id ?? null,
      alertExternalId: `release-${marker}`,
      routingId: alert?.routing?.id ?? null,
      notificationStatus: alert?.routing?.notificationStatus ?? null,
      escalatedIncidentId: escalatedIncident?.id ?? null,
      delivery: deliveryState
    }
  }, null, 2), { mode: 0o600 });

  console.log('Production E2E PASS:', JSON.stringify({ organizationId: organization.id, incidentId: incident.id, statusSlug, teamId: team.id, scheduleId: schedule.id, alertId: alert?.id ?? null }));
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

  // =========================================================================
  // Relay 0.2 durability across a restart
  // =========================================================================
  const r02 = state.relay02;
  if (!r02) throw new Error('State file has no relay02 section; re-run verify:production before verify:restart.');
  const orgBase = `/api/v1/organizations/${state.organizationId}`;

  r = await client.request(`${orgBase}/teams/${r02.teamId}`, { expected: 200 });
  assert.equal(r.json.data.name, r02.teamName, 'the renamed team must survive restart');
  assert.ok(r.json.data.members.some((m) => m.userId === state.userId), 'team membership must survive restart');
  assert.ok(r.json.data.services.some((x) => x.id === state.serviceId), 'service ownership must survive restart');

  r = await client.request(`${orgBase}/services`, { expected: 200 });
  assert.equal(r.json.data.find((x) => x.id === state.serviceId).ownerTeamId, r02.teamId, 'service ownerTeamId must survive restart');

  r = await client.request(`${orgBase}/oncall/schedules/${r02.scheduleId}`, { expected: 200 });
  const schedule = r.json.data;
  assert.equal(schedule.name, r02.scheduleName, 'the renamed schedule must survive restart');
  assert.equal(schedule.timeZone, r02.timeZone, 'the schedule timezone must survive restart');
  assert.equal(schedule.rotationIntervalMinutes, r02.rotationIntervalMinutes, 'the rotation interval must survive restart');
  assert.equal(schedule.rotationStartsAt, r02.rotationStartsAt, 'the rotation anchor must survive restart exactly');
  assert.deepEqual(schedule.participants.map((p) => p.userId), [state.userId], 'the rotation roster must survive restart');
  assert.ok(schedule.overrides.some((o) => o.id === r02.overrideId && o.reason === r02.overrideReason), 'overrides must survive restart');

  // On-call resolution must be identical after a restart: the same absolute
  // anchor and interval on any machine at any time.
  r = await client.request(`${orgBase}/oncall/schedules/${r02.scheduleId}/oncall`, { expected: 200 });
  assert.equal(r.json.data.resolved, true);
  assert.equal(r.json.data.userId, state.userId, 'on-call resolution must survive restart');

  r = await client.request(`${orgBase}/oncall/state`, { expected: 200 });
  assert.equal(r.json.data.oncall.find((x) => x.schedule.id === r02.scheduleId).current.userId, state.userId, 'the on-call state endpoint must survive restart');

  if (r02.ruleId) {
    r = await client.request(`${orgBase}/routing-rules`, { expected: 200 });
    const rule = r.json.data.find((x) => x.id === r02.ruleId);
    assert.ok(rule, 'the routing rule must survive restart');
    assert.equal(rule.name, r02.ruleName, 'the rule name must survive restart');
    assert.equal(rule.priority, r02.rulePriority, 'the reordered priority must survive restart');
    assert.equal(rule.matchServiceId, state.serviceId, 'rule conditions must survive restart');
    assert.deepEqual(rule.matchSeverities, ['critical'], 'rule severity conditions must survive restart as real JSON');
    assert.equal(rule.targetScheduleId, r02.scheduleId);
    assert.equal(r.json.data.some((x) => x.name === 'Release verification catch-all'), false, 'the deleted catch-all rule must stay deleted');
  }

  if (r02.alertId) {
    r = await client.request(`${orgBase}/alerts`, { expected: 200 });
    const listed = r.json.data.find((x) => x.id === r02.alertId);
    assert.ok(listed, 'the alert must survive restart');
    assert.equal(listed.routing.id, r02.routingId, 'the routing record must survive restart');
    assert.equal(listed.routing.resolution, 'ROUTED');
    assert.equal(listed.routing.oncallUserId, state.userId, 'the resolved responder must survive restart');
    assert.equal(listed.routing.notificationStatus, r02.notificationStatus, 'the notification outcome must survive restart');
    assert.equal(listed.routing.acknowledgedByUserId, state.userId, 'the acknowledgement must survive restart');
    assert.ok(listed.routing.acknowledgedAt, 'the acknowledgement timestamp must survive restart');
    assert.equal(listed.routing.incidentId, r02.escalatedIncidentId, 'the alert-to-incident link must survive restart');
    // Snapshotted names, recorded before the restart-time renames, must not drift.
    assert.equal(listed.routing.scheduleName, r02.originalScheduleName, 'the historical schedule snapshot must survive restart');
    assert.equal(listed.routing.teamName, r02.originalTeamName, 'the historical team snapshot must survive restart');
    assert.equal(listed.routing.ruleName, r02.originalRuleName, 'the historical rule snapshot must survive restart');
    assert.equal(listed.metadata?.marker !== undefined, true, 'alert metadata must survive restart as real JSON');

    r = await client.request(`${orgBase}/routings`, { expected: 200 });
    assert.ok(r.json.data.some((x) => x.alertId === r02.alertId), 'the routing audit trail must survive restart');

    r = await client.request(`${orgBase}/incidents/${r02.escalatedIncidentId}`, { expected: 200 });
    assert.equal(r.json.data.status, 'RESOLVED');
    assert.ok(r.json.data.timeline.some((e) => e.metadata?.sourceAlertId === r02.alertId), 'the escalation provenance must survive restart');

    // Idempotency must still hold after a restart, so a late retry from a
    // monitoring system cannot resurrect a duplicate alert or a second page.
    const alertKey = process.env.ALERT_INGEST_KEY;
    if (alertKey) {
      const replay = await postAlert(alertKey, {
        organizationSlug: (await client.request(`/api/v1/organizations/${state.organizationId}`, { expected: 200 })).json.data.slug,
        source: 'release-verifier', externalId: r02.alertExternalId,
        title: 'Release verification alert replay', severity: 'critical'
      });
      assert.equal(replay.status, 202);
      assert.equal(replay.json.data.duplicate, true, 'a post-restart replay must still be recognised as a duplicate');
      assert.equal(replay.json.data.id, r02.alertId);
      assert.equal(replay.json.data.routing.id, r02.routingId, 'a post-restart replay must not create a second routing record');
    }

    // Durable delivery survives the restart: same record, same attempt history,
    // and nothing already delivered is attempted again by the restarted worker.
    if (r02.delivery) {
      const after = (await client.request(`${orgBase}/alerts/${r02.alertId}/deliveries`, { expected: 200 })).json.data;
      const delivery = after.find((entry) => entry.id === r02.delivery.deliveryId);
      assert.ok(delivery, 'the persisted delivery must survive a restart');
      assert.equal(delivery.provider, r02.delivery.provider);
      assert.equal(delivery.attemptCount, r02.delivery.attemptCount, 'a restart must not add or lose an attempt');
      assert.equal(delivery.status, r02.delivery.status, 'the delivery state is decided by the database, not by process memory');
      assert.deepEqual(delivery.attempts.map((attempt) => attempt.id), r02.delivery.attemptIds, 'attempt rows are immutable across a restart');
      assert.deepEqual(delivery.attempts.map((attempt) => attempt.outcome), r02.delivery.attemptOutcomes);
      const escalation = (await client.request(`${orgBase}/alerts/${r02.alertId}/escalation`, { expected: 200 })).json.data;
      assert.equal(escalation.planned, r02.delivery.escalationPlanned, 'the escalation plan must survive a restart');
      assert.equal(escalation.executed, r02.delivery.escalationExecuted);
      assert.equal(escalation.cancelled, r02.delivery.escalationCancelled);
      if (delivery.status === 'SENT') {
        const retry = await client.request(`${orgBase}/deliveries/${delivery.id}/retry`, { method: 'POST', body: {}, expected: 409 });
        assert.equal(retry.json.error.code, 'DELIVERY_ALREADY_SENT', 'a delivered page must never be re-sent after a restart');
      }
    }

    r = await client.request(`/api/v1/public/status/${state.statusSlug}`, { expected: 200 });
    const publicJson = JSON.stringify(r.json);
    assert.equal(r.json.data.overallStatus, 'OPERATIONAL');
    for (const internal of [r02.teamName, r02.scheduleName, r02.ruleName, r02.overrideReason, state.internalMessage]) {
      assert.equal(publicJson.includes(internal), false, `public status must not leak ${internal} after restart`);
    }
  }

  console.log('Restart persistence PASS:', JSON.stringify({ organizationId: state.organizationId, incidentId: state.incidentId, teamId: r02.teamId, scheduleId: r02.scheduleId, alertId: r02.alertId }));
}

if (mode === 'initial') await initial();
else if (mode === 'restart') await restart();
else throw new Error(`Unknown mode: ${mode}. Use initial or restart.`);
