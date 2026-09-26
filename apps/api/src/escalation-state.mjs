import { DELIVERY_STATE_LABELS, ESCALATION_STATE_LABELS } from '../../../packages/shared/escalation.mjs';

// ---------------------------------------------------------------------------
// Relay 0.2 / RLY-0.2-M-002 — alert escalation read model.
//
// One place answers "what was planned, what executed, who was resolved, what
// was sent and what was cancelled" for an alert. Everything reported here is
// already-persisted history: nothing in this module resolves on-call state
// again, so reading an alert can never change it.
// ---------------------------------------------------------------------------

function deliveryView(delivery) {
  return {
    id: delivery.id,
    provider: delivery.provider,
    status: delivery.status,
    statusLabel: DELIVERY_STATE_LABELS[delivery.status] ?? delivery.status,
    responderUserId: delivery.responderUserId ?? null,
    responderDisplayName: delivery.responderNameSnapshot ?? null,
    attemptCount: delivery.attemptCount ?? 0,
    nextAttemptAt: delivery.nextAttemptAt ?? null,
    scheduledAt: delivery.scheduledAt ?? null,
    completedAt: delivery.completedAt ?? null,
    lastError: delivery.lastError ?? null,
    destination: delivery.destinationSnapshot ?? {}
  };
}

export async function buildAlertEscalationState({ store, organizationId, alertId, now = new Date().toISOString() }) {
  const [jobs, deliveries] = await Promise.all([
    store.listEscalationJobs(organizationId, alertId),
    store.listAlertDeliveries(organizationId, alertId)
  ]);
  const byJob = new Map();
  for (const delivery of deliveries) {
    if (!delivery.escalationJobId) continue;
    if (!byJob.has(delivery.escalationJobId)) byJob.set(delivery.escalationJobId, []);
    byJob.get(delivery.escalationJobId).push(delivery);
  }
  const steps = jobs.map((job) => ({
    id: job.id,
    position: job.stepPosition,
    afterMinutes: job.afterMinutes,
    dueAt: job.dueAt,
    targetScheduleId: job.targetScheduleId ?? null,
    targetScheduleName: job.targetScheduleNameSnapshot ?? null,
    channels: job.channels ?? [],
    state: job.state,
    stateLabel: ESCALATION_STATE_LABELS[job.state] ?? job.state,
    claimedAt: job.claimedAt ?? null,
    leaseExpiresAt: job.leaseExpiresAt ?? null,
    executedAt: job.executedAt ?? null,
    cancelled: job.state === 'CANCELLED_ACKNOWLEDGED',
    // The responder is the one resolved at execution time, never a prediction
    // made when the alert first arrived.
    resolvedResponder: job.resolvedResponderUserId
      ? { userId: job.resolvedResponderUserId, displayName: job.resolvedResponderNameSnapshot ?? null }
      : null,
    outcome: job.result ?? {},
    deliveries: (byJob.get(job.id) ?? []).map(deliveryView)
  }));
  const policyName = jobs[0]?.policyNameSnapshot ?? null;
  const immediate = deliveries.filter((delivery) => !delivery.escalationJobId).map(deliveryView);
  return {
    policyId: jobs[0]?.policyId ?? null,
    policyName,
    planned: steps.length,
    executed: steps.filter((step) => step.state === 'COMPLETED').length,
    cancelled: steps.filter((step) => step.state === 'CANCELLED_ACKNOWLEDGED').length,
    unresolved: steps.filter((step) => step.state === 'FAILED').length,
    nextDueAt: steps.filter((step) => step.state === 'PENDING').map((step) => step.dueAt).sort()[0] ?? null,
    due: steps.some((step) => step.state === 'PENDING' && new Date(step.dueAt).getTime() <= new Date(now).getTime()),
    immediateDeliveries: immediate,
    steps
  };
}
