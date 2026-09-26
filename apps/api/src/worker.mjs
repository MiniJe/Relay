import crypto from 'node:crypto';
import { attemptDelivery, destinationSnapshot, integrationProviderFor, loadIntegrationFor, normalizeChannels, routingSummaryFor } from './delivery.mjs';
import { resolveOnCall } from '../../../packages/shared/oncall.mjs';
import { planAfterAttempt } from '../../../packages/shared/escalation.mjs';

// ---------------------------------------------------------------------------
// Relay 0.2 / RLY-0.2-M-002 — PostgreSQL-backed delivery worker.
//
// Two layers, deliberately separated:
//
//   processDueWork(now, options)   the core. Fully deterministic, takes an
//                                  explicit clock, performs no sleeping and is
//                                  what the concurrency/restart tests drive.
//   createDeliveryWorker(...)      the lifecycle. Polls on a bounded interval,
//                                  processes bounded batches, stops cleanly.
//
// PostgreSQL remains the source of truth. Claims happen inside a short
// transaction (`SELECT ... FOR UPDATE SKIP LOCKED` -> mark IN_FLIGHT -> lease),
// and every provider call happens OUTSIDE any transaction, so a slow Discord,
// Slack or SMTP endpoint can never hold a row lock or a connection.
// ---------------------------------------------------------------------------

export const DEFAULT_LEASE_SECONDS = 120;
export const DEFAULT_BATCH_SIZE = 20;
export const DEFAULT_POLL_INTERVAL_MS = 15_000;
export const WORKER_OWNER_PREFIX = 'relay-worker';

export function createLeaseOwner(hostname = 'relay') {
  return `${WORKER_OWNER_PREFIX}:${hostname}:${process.pid}:${crypto.randomBytes(4).toString('hex')}`;
}

/** Rebuild the routing decision the provider payload needs from a snapshot. */
function routingContextFrom(alertRouting, delivery) {
  return {
    ruleName: alertRouting?.ruleName ?? null,
    scheduleName: alertRouting?.scheduleName ?? null,
    teamName: alertRouting?.teamName ?? null,
    oncallUserId: delivery.responderUserId ?? alertRouting?.oncallUserId ?? null,
    oncallDisplayName: delivery.responderDisplayNameSnapshot ?? alertRouting?.oncallDisplayName ?? null,
    timeZone: delivery.destinationSnapshot?.timeZone ?? 'UTC'
  };
}

/**
 * Deliver one claimed delivery. Returns a normalized execution result. The
 * caller persists it through the store under the lease token.
 */
export async function executeDelivery({ store, config, delivery, transports, fetchImpl, logger, now = new Date() }) {
  const organizationId = delivery.organizationId;
  const alert = await store.getAlert(organizationId, delivery.alertId);
  if (!alert) {
    // The alert was deleted (organization cascade). Nothing to page.
    return { outcome: 'PERMANENT_FAILURE', providerStatusCode: null, safeError: 'The source alert no longer exists.', skipAttempt: true };
  }
  const [service, alertRouting, responderUser] = await Promise.all([
    alert.serviceId ? store.getService(organizationId, alert.serviceId) : Promise.resolve(undefined),
    store.getAlertRouting(organizationId, alert.id),
    delivery.responderUserId ? store.getUserById(delivery.responderUserId) : Promise.resolve(undefined)
  ]);
  const { integration, skipped } = await loadIntegrationFor({ store, organizationId, provider: delivery.provider });
  if (skipped || !integration) {
    // Not a provider call: no attempt row, but the delivery is terminal and the
    // reason is recorded so operators can see the configuration gap.
    return { outcome: 'SKIPPED', skipAttempt: true, providerStatusCode: null, safeError: skipped === 'SKIPPED_DISABLED' ? `${delivery.provider} integration is disabled.` : `${delivery.provider} integration is not configured.`, skipped };
  }
  let escalation = null;
  if (delivery.escalationJobId) {
    const jobs = await store.listEscalationJobs(organizationId, delivery.alertId);
    escalation = jobs.find((job) => job.id === delivery.escalationJobId) ?? null;
  }
  return attemptDelivery({
    delivery,
    config,
    transports,
    fetchImpl,
    logger,
    context: {
      organizationId,
      alert,
      service,
      routing: routingContextFrom(alertRouting, delivery),
      escalation,
      responderUser,
      integration
    }
  });
}

/**
 * One deterministic pass of the worker core.
 *
 * Order matters: expired leases are recovered first so work abandoned by a dead
 * process becomes claimable in the same pass, then due escalation jobs run
 * (they create deliveries), then due deliveries are attempted.
 */
export async function processDueWork({ store, config, transports = {}, fetchImpl = fetch, logger = console, owner, now = new Date(), leaseSeconds = DEFAULT_LEASE_SECONDS, batchSize = DEFAULT_BATCH_SIZE, alertId = null } = {}) {
  const at = new Date(now);
  const claimedBy = owner ?? createLeaseOwner();
  const summary = {
    at: at.toISOString(),
    leaseOwner: claimedBy,
    recoveredDeliveries: 0,
    recoveredEscalations: 0,
    deliveriesClaimed: 0,
    deliveriesSent: 0,
    deliveriesRetrying: 0,
    deliveriesFailed: 0,
    deliveriesSkipped: 0,
    escalationsClaimed: 0,
    escalationsExecuted: 0,
    escalationsCancelled: 0,
    escalationsFailed: 0
  };

  summary.recoveredDeliveries = await store.recoverExpiredDeliveryLeases(at, { limit: batchSize });
  summary.recoveredEscalations = await store.recoverExpiredEscalationLeases(at, { limit: batchSize });

  // ---- escalation jobs ----------------------------------------------------
  const jobs = await store.claimDueEscalationJobs({ now: at, leaseOwner: claimedBy, leaseSeconds, limit: batchSize });
  summary.escalationsClaimed = jobs.length;
  for (const job of jobs) {
    const result = await executeEscalationJob({ store, config, job, leaseOwner: claimedBy, now: at, logger });
    if (result.state === 'CANCELLED_ACKNOWLEDGED') summary.escalationsCancelled += 1;
    else if (result.state === 'COMPLETED') summary.escalationsExecuted += 1;
    else summary.escalationsFailed += 1;
  }

  // ---- deliveries ---------------------------------------------------------
  const due = await store.claimDueDeliveries({ now: at, leaseOwner: claimedBy, leaseSeconds, limit: batchSize, alertId });
  summary.deliveriesClaimed = due.length;
  for (const delivery of due) {
    const attemptNumber = Number(delivery.attemptCount ?? 0) + 1;
    const startedAt = new Date().toISOString();
    const execution = await executeDelivery({ store, config, delivery, transports, fetchImpl, logger, now: at });
    const completedAt = new Date().toISOString();
    if (execution.outcome === 'SKIPPED') {
      await store.completeDelivery({
        deliveryId: delivery.id, organizationId: delivery.organizationId, leaseOwner: claimedBy,
        attemptNumber, startedAt, completedAt, outcome: 'PERMANENT_FAILURE', skipAttempt: true,
        status: 'FAILED', nextAttemptAt: null, safeError: execution.safeError, providerStatusCode: null
      });
      await store.recordRoutingNotification(delivery.organizationId, delivery.alertId, {
        status: execution.skipped, provider: delivery.provider, error: execution.safeError, notifiedAt: null
      });
      summary.deliveriesSkipped += 1;
      continue;
    }
    const plan = planAfterAttempt({ now: at, attemptNumber, outcome: execution.outcome });
    await store.completeDelivery({
      deliveryId: delivery.id, organizationId: delivery.organizationId, leaseOwner: claimedBy,
      attemptNumber, startedAt, completedAt, outcome: execution.outcome,
      status: plan.status, nextAttemptAt: plan.nextAttemptAt,
      safeError: execution.safeError, providerStatusCode: execution.providerStatusCode,
      manualRetryByUserId: delivery.manualRetryByUserId ?? null
    });
    // The M-001 compact summary still mirrors the latest known outcome.
    if (execution.outcome === 'SENT') {
      // The compact M-001 summary keeps the Discord user id that was actually
      // mentioned, exactly as the previous direct-send path did.
      await store.recordRoutingNotification(delivery.organizationId, delivery.alertId, {
        ...routingSummaryFor({ outcome: 'SENT', provider: delivery.provider }),
        discordUserId: delivery.provider === 'DISCORD' ? delivery.destinationSnapshot?.discordUserId ?? null : null
      });
      summary.deliveriesSent += 1;
    } else {
      await store.recordRoutingNotification(delivery.organizationId, delivery.alertId, routingSummaryFor({ outcome: execution.outcome, provider: delivery.provider, error: execution.safeError }));
      if (plan.status === 'RETRYING') summary.deliveriesRetrying += 1;
      else summary.deliveriesFailed += 1;
    }
  }
  return summary;
}

/**
 * Execute one claimed escalation step.
 *
 * The acknowledgement check and the delivery creation happen in a single store
 * transaction that also holds the routing row lock, so an acknowledgement can
 * never interleave: either the acknowledgement is observed (the step is
 * cancelled and no page is created) or the page is already durably created
 * before the acknowledgement commits.
 */
export async function executeEscalationJob({ store, config, job, leaseOwner, now = new Date(), logger = console }) {
  const at = new Date(now);
  const routing = await store.getAlertRouting(job.organizationId, job.alertId);
  if (!routing?.acknowledgedAt) {
    const schedule = job.targetScheduleId ? await store.getSchedule(job.organizationId, job.targetScheduleId) : undefined;
    const resolution = schedule
      ? resolveOnCall({ schedule, participants: schedule.participants ?? [], overrides: schedule.overrides ?? [] }, at.toISOString())
      : { resolved: false, reason: 'SCHEDULE_MISSING' };
    const responderUserId = resolution.responderUserId ?? null;
    const responderNameSnapshot = resolution.responderDisplayName ?? null;
    if (!responderUserId) {
      // Nobody is on call. The step is honestly recorded as unresolved, and it
      // is never silently retried into a page for the wrong person.
      return store.completeEscalationJob({
        organizationId: job.organizationId, jobId: job.id, leaseOwner, state: 'FAILED',
        responderUserId: null, responderNameSnapshot: null,
        result: { reason: resolution.reason, targetScheduleName: job.targetScheduleNameSnapshot, channels: job.channels }
      });
    }
    let deliveries = [];
    if (responderUserId) {
      const responderUser = await store.getUserById(responderUserId);
      const channels = normalizeChannels(job.channels);
      const integrationByProvider = {};
      for (const provider of channels) {
        integrationByProvider[provider] = await store.getIntegration(job.organizationId, integrationProviderFor(provider));
      }
      const discordIdentity = channels.includes('DISCORD') ? await store.getDiscordIdentity(job.organizationId, responderUserId) : undefined;
      deliveries = channels.map((provider) => ({
        organizationId: job.organizationId,
        alertId: job.alertId,
        routingId: job.routingId,
        escalationJobId: job.id,
        provider,
        responderUserId,
        responderNameSnapshot,
        scheduledAt: at.toISOString(),
        destinationSnapshot: destinationSnapshot({
          provider,
          integration: integrationByProvider[provider],
          responder: responderUser,
          extra: { discordUserId: provider === 'DISCORD' ? discordIdentity?.discordUserId ?? null : null, timeZone: schedule?.timeZone ?? 'UTC' }
        }),
        status: 'PENDING',
        attemptCount: 0,
        nextAttemptAt: at.toISOString()
      }));
    }
    void config;
    return store.completeEscalationJob({
      organizationId: job.organizationId, jobId: job.id, leaseOwner, state: 'COMPLETED',
      responderUserId, responderNameSnapshot, deliveries,
      result: { reason: resolution.reason, source: resolution.source ?? null, targetScheduleName: job.targetScheduleNameSnapshot, channels: job.channels }
    });
  }
  logger.info?.(`Escalation step ${job.id} skipped: the alert was acknowledged before the worker claimed it.`);
  return store.completeEscalationJob({
    organizationId: job.organizationId, jobId: job.id, leaseOwner, state: 'CANCELLED_ACKNOWLEDGED',
    responderUserId: null, responderNameSnapshot: null,
    result: { reason: 'ACKNOWLEDGED', acknowledgedAt: routing.acknowledgedAt }
  });
}

/**
 * Worker lifecycle. Started by the server after database readiness, stopped
 * cleanly on shutdown, bounded batches, safe operational logging only.
 */
export function createDeliveryWorker({ store, config, transports = {}, fetchImpl = fetch, logger = console, owner, pollIntervalMs = DEFAULT_POLL_INTERVAL_MS, leaseSeconds = DEFAULT_LEASE_SECONDS, batchSize = DEFAULT_BATCH_SIZE, clock = () => new Date() }) {
  const leaseOwner = owner ?? createLeaseOwner();
  let timer = null;
  let running = false;
  let stopped = true;
  let passes = 0;
  let lastSummary = null;
  let lastError = null;

  async function runOnce(now = clock(), options = {}) {
    if (running) return null;
    running = true;
    try {
      const summary = await processDueWork({ store, config, transports, fetchImpl, logger, owner: leaseOwner, now, leaseSeconds, batchSize, ...options });
      passes += 1;
      lastSummary = summary;
      lastError = null;
      const didWork = summary.deliveriesClaimed + summary.escalationsClaimed + summary.recoveredDeliveries + summary.recoveredEscalations;
      if (didWork) logger.info?.(`Delivery worker pass: ${JSON.stringify(summary)}`);
      return summary;
    } catch (error) {
      lastError = error;
      // A failed pass must never kill the loop: the work stays durable.
      logger.error?.('Delivery worker pass failed:', error?.message ?? error);
      return null;
    } finally {
      running = false;
    }
  }

  function start() {
    if (!stopped) return;
    stopped = false;
    const tick = () => {
      runOnce().catch(() => {});
    };
    timer = setInterval(tick, pollIntervalMs);
    timer.unref?.();
    tick();
  }

  async function stop() {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
    // Wait for an in-flight pass so shutdown cannot abandon a claimed lease.
    const deadline = Date.now() + 10_000;
    while (running && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  }

  return {
    leaseOwner,
    start,
    stop,
    runOnce,
    kick: (now = clock()) => runOnce(now),
    get stats() { return { passes, lastSummary, lastError: lastError?.message ?? null, running, stopped, pollIntervalMs, leaseOwner }; }
  };
}
