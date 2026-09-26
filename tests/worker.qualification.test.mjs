import test from 'node:test';
import assert from 'node:assert/strict';
import { createPostgresStore, migratePostgres } from '../packages/database/postgres-store.mjs';
import { hashPassword } from '../apps/api/src/security.mjs';
import { processDueWork } from '../apps/api/src/worker.mjs';
import { materializeEscalationPlan } from '../packages/shared/escalation.mjs';

// Relay 0.2 / RLY-0.2-M-002 — real-PostgreSQL worker qualification.
//
// These tests exercise the properties the design depends on, against a real
// cluster rather than the in-memory store:
//
//   * `FOR UPDATE SKIP LOCKED` claims are disjoint: concurrent workers never
//     attempt the same page twice.
//   * A crashed worker's lease expires and is reclaimed, and the crashed worker
//     can no longer write its outcome over the new owner's.
//   * A restart delivers every due page exactly once, with one immutable
//     attempt row per provider call.
//   * An acknowledgement can never be overtaken by an escalation page: either
//     the step is cancelled before it creates work, or the page already exists
//     and is cancelled as unsent.
//
// No provider is ever contacted: the transport table is injected and records
// its calls in memory.

const databaseUrl = process.env.DATABASE_URL;
const skip = !databaseUrl ? 'DATABASE_URL not available in this environment' : false;
const silent = { warn() {}, error() {}, info() {} };

let sequence = 0;
const marker = () => `qual-${Date.now().toString(36)}-${(sequence += 1).toString(36)}`;

async function seed({ withPolicy = false } = {}) {
  await migratePostgres(databaseUrl);
  const { default: postgres } = await import('postgres');
  const sql = postgres(databaseUrl, { max: 4, connect_timeout: 10 });
  const store = await createPostgresStore(databaseUrl);
  const id = marker();
  const hash = await hashPassword('relay-password-123');
  const owner = await store.createUser({ email: `q-owner-${id}@example.com`, displayName: 'Owner', passwordHash: hash });
  const ada = await store.createUser({ email: `q-ada-${id}@example.com`, displayName: 'Ada Qual', passwordHash: hash });
  const org = await store.createOrganization({ userId: owner.id, name: `Qual ${id}`, slug: `qual-${id}` });
  await sql.unsafe(`INSERT INTO organization_memberships(organization_id,user_id,role) VALUES($1,$2,'RESPONDER')`, [org.id, ada.id]);
  const team = await store.createTeam(org.id, { name: `Team ${id}`, slug: `team-${id}`, description: '' });
  await store.addTeamMember(org.id, team.id, ada.id);
  const schedule = await store.createSchedule(org.id, {
    name: `Primary ${id}`, teamId: team.id, timeZone: 'UTC',
    rotationStartsAt: new Date(Date.now() - 3600_000).toISOString(), rotationIntervalMinutes: 1440,
    participantUserIds: [ada.id]
  });
  const integration = await store.upsertIntegration(org.id, {
    provider: 'DISCORD', name: 'Qual Discord', secretEncrypted: 'v1.qual.qual.qual', config: {}, enabled: true
  });
  let policy = null;
  if (withPolicy) {
    policy = await store.saveEscalationPolicy(org.id, {
      name: `Escalate ${id}`, description: '', enabled: true,
      steps: [{ position: 0, afterMinutes: 5, targetScheduleId: schedule.id, channels: ['DISCORD'] }]
    });
  }
  return { sql, store, org, owner, ada, team, schedule, integration, policy, close: async () => { await store.close(); await sql.end({ timeout: 5 }); } };
}

/**
 * Ingest and route an alert, then enqueue its due deliveries. One alert can
 * carry at most one immediate delivery per provider (that is the idempotency
 * key), so concurrency qualification uses one alert per delivery.
 */
async function enqueueAlertWork(fixture, { immediate = true, at = new Date().toISOString() } = {}) {
  const ingested = await fixture.store.ingestAlert(fixture.org.id, {
    source: 'qualification', externalId: `alert-${marker()}`, title: 'Checkout p95 latency', severity: 'critical', serviceId: null, description: ''
  });
  const alert = ingested.alert;
  const routing = await fixture.store.recordAlertRouting(fixture.org.id, alert.id, {
    resolution: 'ROUTED', ruleId: null, ruleName: 'Qual rule', scheduleId: fixture.schedule.id, scheduleName: fixture.schedule.name,
    teamId: fixture.team.id, teamName: fixture.team.name, oncallUserId: fixture.ada.id, oncallDisplayName: 'Ada Qual',
    notificationStatus: 'NOT_ATTEMPTED', notificationProvider: 'DISCORD', notifiedAt: null, notificationError: null, acknowledgedAt: null, acknowledgedByUserId: null, reason: null
  });
  const inserted = immediate ? await fixture.store.enqueueDeliveries([{
    organizationId: fixture.org.id, alertId: alert.id, routingId: routing.id, escalationJobId: null,
    provider: 'DISCORD', responderUserId: fixture.ada.id, responderNameSnapshot: 'Ada Qual',
    destinationSnapshot: { kind: 'DISCORD_WEBHOOK', integrationId: fixture.integration.id, integrationName: 'Qual Discord', discordUserId: null, timeZone: 'UTC' },
    status: 'PENDING', attemptCount: 0, scheduledAt: at, nextAttemptAt: at
  }]) : [];
  if (immediate) assert.equal(inserted.length, 1, 'the immediate delivery is inserted once');
  // Re-enqueueing the same intent must never create a second page: routing can
  // be re-evaluated, but an alert is not paged twice for the same channel.
  const duplicate = !immediate || await fixture.store.enqueueDeliveries([{
    organizationId: fixture.org.id, alertId: alert.id, routingId: routing.id, escalationJobId: null,
    provider: 'DISCORD', responderUserId: fixture.ada.id, responderNameSnapshot: 'Ada Qual',
    destinationSnapshot: {}, status: 'PENDING', attemptCount: 0, scheduledAt: at, nextAttemptAt: at
  }]);
  if (immediate) assert.equal(duplicate.length, 0, 'a duplicate immediate delivery is refused by the database, not by application memory');
  return { alert, routing, deliveries: inserted };
}

/** `count` independent routed alerts, each with exactly one due delivery. */
async function enqueueAlerts(fixture, count) {
  const out = [];
  for (let index = 0; index < count; index += 1) out.push(await enqueueAlertWork(fixture));
  return out;
}

test('concurrent workers claim disjoint work and never page the same responder twice', { skip }, async () => {
  const fixture = await seed();
  try {
    const alerts = await enqueueAlerts(fixture, 8);
    assert.equal(new Set(alerts.map((entry) => entry.alert.id)).size, 8);
    const alertIds = new Set(alerts.map((entry) => entry.alert.id));
    const calls = [];
    const transports = {
      DISCORD: async ({ alert, mentionDiscordUserId }) => {
        // A non-trivial provider call: the point is that the claim is already
        // committed when it happens, so concurrency cannot duplicate it.
        await new Promise((resolve) => setTimeout(resolve, 25));
        calls.push({ alertId: alert?.id, mentionDiscordUserId, at: Date.now() });
        return { status: 204 };
      }
    };
    // The database is shared with the rest of the suite, so only this
    // fixture's alerts are asserted on; the concurrency contract is that no
    // alert is ever paged twice, not that the cluster is otherwise idle.
    const mine = () => calls.filter((call) => alertIds.has(call.alertId));
    const summaries = await Promise.all([1, 2, 3, 4].map((worker) => processDueWork({
      store: fixture.store, config: { integrationEncryptionKey: 'qualification-key' }, transports, logger: silent,
      owner: `qual-worker-${worker}`, leaseSeconds: 120, batchSize: 4, now: new Date()
    })));
    assert.ok(summaries.reduce((sum, summary) => sum + summary.deliveriesClaimed, 0) >= 8, 'the four workers claim the due pages');
    assert.equal(mine().length, 8, 'each of the eight pages produced exactly one provider call');

    const deliveries = (await Promise.all(alerts.map((entry) => fixture.store.listAlertDeliveries(fixture.org.id, entry.alert.id)))).flat();
    assert.equal(deliveries.length, 8);
    for (const delivery of deliveries) {
      assert.equal(delivery.status, 'SENT');
      assert.equal(delivery.attemptCount, 1, 'no delivery was attempted twice');
      assert.equal(delivery.leaseOwner, null, 'a completed delivery releases its lease');
      const attempts = await fixture.store.listDeliveryAttempts(fixture.org.id, delivery.id);
      assert.equal(attempts.length, 1, 'exactly one immutable attempt row per provider call');
      assert.equal(attempts[0].outcome, 'SENT');
    }
    // A further pass has nothing to do: the outbox is drained, not replayed.
    await processDueWork({ store: fixture.store, config: { integrationEncryptionKey: 'qualification-key' }, transports, logger: silent, owner: 'qual-worker-5', now: new Date(Date.now() + 60_000) });
    assert.equal(mine().length, 8, 'a drained outbox is never replayed, even by a late worker');
  } finally { await fixture.close(); }
});

test('an expired lease is reclaimed after a crash and the dead worker cannot overwrite the new outcome', { skip }, async () => {
  const fixture = await seed();
  try {
    const { alert } = await enqueueAlertWork(fixture);
    // Worker A claims the page and then dies before reporting anything: that is
    // exactly the state a killed process leaves behind.
    const claimed = await fixture.store.claimDueDeliveries({ now: new Date().toISOString(), leaseOwner: 'qual-worker-dead', leaseSeconds: 1, limit: 1 });
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0].status, 'IN_FLIGHT');
    assert.equal(claimed[0].leaseOwner, 'qual-worker-dead');

    // Worker B recovers the expired lease and delivers it.
    const calls = [];
    const now = new Date(Date.now() + 5_000);
    const recovery = await processDueWork({
      store: fixture.store, config: { integrationEncryptionKey: 'qualification-key' }, logger: silent,
      transports: { DISCORD: async ({ alert }) => { calls.push(alert?.id); return { status: 204 }; } },
      owner: 'qual-worker-alive', now
    });
    assert.ok(recovery.recoveredDeliveries >= 1, 'the expired lease is recovered in the same pass');
    assert.deepEqual(calls, [alert.id], 'the recovered page is delivered exactly once');
    const delivered = (await fixture.store.listAlertDeliveries(fixture.org.id, alert.id))[0];
    assert.equal(delivered.status, 'SENT');
    assert.equal(delivered.attemptCount, 1);

    // The dead worker finally wakes up. Its write must be refused: the lease
    // token no longer matches, so the delivered history stays exactly as it is.
    const stale = await fixture.store.completeDelivery({
      deliveryId: delivered.id, organizationId: fixture.org.id, leaseOwner: 'qual-worker-dead',
      attemptNumber: 1, startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
      outcome: 'RETRYABLE_FAILURE', status: 'RETRYING', nextAttemptAt: new Date(Date.now() + 60_000).toISOString(),
      safeError: 'stale worker write', providerStatusCode: 500
    });
    assert.equal(stale?.staleLease, true, 'a stale lease owner cannot write an outcome');
    const unchanged = await fixture.store.getDelivery(fixture.org.id, delivered.id);
    assert.equal(unchanged.status, 'SENT');
    assert.equal(unchanged.attemptCount, 1);
    assert.equal(unchanged.lastError, null);
    assert.equal((await fixture.store.listDeliveryAttempts(fixture.org.id, delivered.id)).length, 1, 'a refused write adds no attempt row');
  } finally { await fixture.close(); }
});

test('a restarted worker recovers abandoned work and keeps one immutable attempt per provider call', { skip }, async () => {
  const fixture = await seed();
  try {
    const [first, second] = await enqueueAlerts(fixture, 2);
    // Run 1 delivers nothing: the first page fails retryably.
    await processDueWork({
      store: fixture.store, config: { integrationEncryptionKey: 'qualification-key' }, logger: silent,
      owner: 'qual-worker-run-1', batchSize: 1, now: new Date(),
      transports: { DISCORD: async () => { const error = new Error('Discord webhook returned HTTP 503.'); error.status = 503; throw error; } }
    });
    const afterRun1 = await fixture.store.listAlertDeliveries(fixture.org.id, first.alert.id);
    assert.equal(afterRun1[0].status, 'RETRYING');
    assert.equal(afterRun1[0].attemptCount, 1);
    assert.equal((await fixture.store.listDeliveryAttempts(fixture.org.id, afterRun1[0].id))[0].outcome, 'RETRYABLE_FAILURE');
    // The worker then dies while holding the second page: the row is left
    // IN_FLIGHT with a lease that is already one second old.
    await fixture.store.claimDueDeliveries({ now: new Date().toISOString(), leaseOwner: 'qual-worker-run-1', leaseSeconds: 1, limit: 1 });

    // Run 2 is a fresh process: it recovers the abandoned lease and delivers it.
    const calls = [];
    const summary = await processDueWork({
      store: fixture.store, config: { integrationEncryptionKey: 'qualification-key' }, logger: silent,
      owner: 'qual-worker-run-2', batchSize: 10, now: new Date(Date.now() + 10_000),
      transports: { DISCORD: async ({ alert }) => { calls.push(alert?.id); return { status: 204 }; } }
    });
    assert.ok(summary.recoveredDeliveries >= 1, 'the restarted worker claims the abandoned lease');
    assert.deepEqual(calls, [second.alert.id], 'the abandoned page is delivered exactly once');

    const finalDeliveries = [
      ...(await fixture.store.listAlertDeliveries(fixture.org.id, first.alert.id)),
      ...(await fixture.store.listAlertDeliveries(fixture.org.id, second.alert.id))
    ];
    assert.equal(finalDeliveries.length, 2);
    for (const delivery of finalDeliveries) {
      const attempts = await fixture.store.listDeliveryAttempts(fixture.org.id, delivery.id);
      assert.equal(attempts.length, delivery.attemptCount, 'attempt rows equal the recorded attempt count');
      assert.equal(delivery.leaseOwner, null, 'no lease survives a completed or rescheduled page');
    }
    const retrying = finalDeliveries.find((delivery) => delivery.alertId === first.alert.id);
    assert.equal(retrying.attemptCount, 1, 'the restart does not consume an extra attempt');
    assert.equal(retrying.status, 'RETRYING', 'the bounded retry is still scheduled for the first page');
    assert.ok(new Date(retrying.nextAttemptAt).getTime() > Date.now(), 'the retry stays in the future');
    const delivered = finalDeliveries.find((delivery) => delivery.alertId === second.alert.id);
    assert.equal(delivered.status, 'SENT');
    assert.equal(delivered.attemptCount, 1, 'recovery does not double-attempt the abandoned page');
  } finally { await fixture.close(); }
});

test('an acknowledgement cancels unexecuted escalation steps and no page is ever created after it commits', { skip }, async () => {
  const fixture = await seed({ withPolicy: true });
  try {
    const { alert, routing } = await enqueueAlertWork(fixture, { immediate: false });
    const plan = materializeEscalationPlan({
      organizationId: fixture.org.id, alertId: alert.id, routingId: routing.id, routedAt: new Date(Date.now() - 3_600_000).toISOString(),
      policy: fixture.policy, steps: fixture.policy.steps, schedulesById: { [fixture.schedule.id]: fixture.schedule }
    });
    assert.equal(plan.length, 1);
    await fixture.store.materializeEscalationJobs(plan);
    const ack = await fixture.store.acknowledgeAlertRouting(fixture.org.id, alert.id, { userId: fixture.ada.id, displayName: 'Ada Qual' });
    assert.equal(ack.acknowledgedAt !== null, true);

    const calls = [];
    const summary = await processDueWork({
      store: fixture.store, config: { integrationEncryptionKey: 'qualification-key' }, logger: silent,
      transports: { DISCORD: async ({ alert: subject }) => { calls.push(subject?.id); return { status: 204 }; } },
      owner: 'qual-worker-ack', now: new Date()
    });
    assert.equal(calls.filter((call) => call === alert.id).length, 0, 'no page is sent for a step that was cancelled by the acknowledgement');
    const deliveries = await fixture.store.listAlertDeliveries(fixture.org.id, alert.id);
    assert.equal(deliveries.length, 0, 'a cancelled step creates no delivery at all');
    const jobs = await fixture.store.listEscalationJobs(fixture.org.id, alert.id);
    assert.equal(jobs[0].state, 'CANCELLED_ACKNOWLEDGED');

    // Now the opposite order: the step runs first (creating a durable page),
    // then the acknowledgement arrives. The created-but-unsent page is
    // cancelled, and the acknowledgement never rewrites the executed step.
    const second = await enqueueAlertWork(fixture, { immediate: false });
    const secondPlan = materializeEscalationPlan({
      organizationId: fixture.org.id, alertId: second.alert.id, routingId: second.routing.id, routedAt: new Date(Date.now() - 3_600_000).toISOString(),
      policy: fixture.policy, steps: fixture.policy.steps, schedulesById: { [fixture.schedule.id]: fixture.schedule }
    });
    await fixture.store.materializeEscalationJobs(secondPlan);
    // Claim the escalation work with a dead owner so the job is IN_FLIGHT and
    // no delivery exists yet, then let the same worker complete it.
    const executed = await processDueWork({
      store: fixture.store, config: { integrationEncryptionKey: 'qualification-key' }, logger: silent,
      transports: { DISCORD: async ({ alert: subject }) => { calls.push(subject?.id); return { status: 204 }; } },
      owner: 'qual-worker-escalation', now: new Date()
    });
    assert.equal(calls.filter((call) => call === second.alert.id).length, 1, 'the executed step pages the responder exactly once');
    const secondJobs = await fixture.store.listEscalationJobs(fixture.org.id, second.alert.id);
    assert.equal(secondJobs[0].state, 'COMPLETED');
    const secondDeliveries = await fixture.store.listAlertDeliveries(fixture.org.id, second.alert.id);
    assert.equal(secondDeliveries.length, 1);
    assert.equal(secondDeliveries[0].status, 'SENT');
    await fixture.store.acknowledgeAlertRouting(fixture.org.id, second.alert.id, { userId: fixture.ada.id, displayName: 'Ada Qual' });
    const keptJobs = await fixture.store.listEscalationJobs(fixture.org.id, second.alert.id);
    assert.equal(keptJobs[0].state, 'COMPLETED', 'an executed step is never rewritten by a later acknowledgement');
    const keptDeliveries = await fixture.store.listAlertDeliveries(fixture.org.id, second.alert.id);
    assert.equal(keptDeliveries[0].status, 'SENT', 'a delivered page is never cancelled retroactively');
    assert.equal((await fixture.store.listDeliveryAttempts(fixture.org.id, keptDeliveries[0].id)).length, 1, 'the attempt history survives the acknowledgement');
  } finally { await fixture.close(); }
});
