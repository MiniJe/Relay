// Relay 0.2 — alert routing execution.
//
//   receive → validate → persist/idempotency → evaluate routing rules
//           → resolve schedule → resolve current on-call responder
//           → persist routing result → materialize escalation plan
//           → persist logical delivery tasks → (optionally) kick the worker
//
// Durability rule: the alert is already committed before any of this runs, and
// the page is durable before any provider is contacted. A routing failure, a
// worker crash or a Discord/Slack/SMTP outage can never roll back the alert or
// lose the page; both are recorded as warnings and as persisted state.

import { domainError } from '../../../packages/shared/domain.mjs';
import { resolveOnCall, selectRoutingRule, upcomingHandoffs } from '../../../packages/shared/oncall.mjs';
import { NOTIFICATION_CHANNELS, materializeEscalationPlan } from '../../../packages/shared/escalation.mjs';
import { loadIntegrationFor, normalizeChannels, destinationSnapshot } from './delivery.mjs';

/**
 * Pure-ish rule evaluation: reads the organization's rules and the target
 * schedule, and returns the decision that must be persisted verbatim.
 */
export async function evaluateAlertRouting({ store, organizationId, alert, at }) {
  const rules = await store.listRoutingRules(organizationId);
  const rule = selectRoutingRule(rules, alert);
  if (!rule) {
    return {
      resolution: 'NO_MATCHING_RULE', ruleId: null, ruleName: null, scheduleId: null, scheduleName: null,
      teamId: null, teamName: null, oncallUserId: null, oncallDisplayName: null, responderSource: null,
      notificationChannels: [], escalationPolicyId: null,
      overrideId: null, periodStartsAt: null, periodEndsAt: null, timeZone: null
    };
  }
  const schedule = await store.getSchedule(organizationId, rule.targetScheduleId);
  const base = {
    ruleId: rule.id, ruleName: rule.name,
    notificationChannels: rule.notificationChannels ?? ['DISCORD'], escalationPolicyId: rule.escalationPolicyId ?? null,
    scheduleId: schedule?.id ?? rule.targetScheduleId, scheduleName: schedule?.name ?? null,
    teamId: schedule?.teamId ?? null, teamName: schedule?.teamName ?? null,
    timeZone: schedule?.timeZone ?? 'UTC'
  };
  if (!schedule) {
    return { ...base, resolution: 'RULE_TARGET_MISSING', oncallUserId: null, oncallDisplayName: null, responderSource: null, overrideId: null, periodStartsAt: null, periodEndsAt: null };
  }
  const resolution = resolveOnCall({ schedule, participants: schedule.participants ?? [], overrides: schedule.overrides ?? [] }, at);
  return {
    ...base,
    resolution: resolution.resolved ? 'ROUTED' : resolution.reason,
    oncallUserId: resolution.responderUserId,
    oncallDisplayName: resolution.responderDisplayName,
    responderSource: resolution.source,
    overrideId: resolution.overrideId,
    periodStartsAt: resolution.periodStartsAt ?? null,
    periodEndsAt: resolution.periodEndsAt ?? null
  };
}

/**
 * Immediate (non-escalation) delivery intent for one routed alert.
 *
 * One logical delivery per configured channel. The responder identity, their
 * display name and the resolved destination are snapshotted here so a later
 * rotation change, integration edit or responder rename cannot retarget a page
 * that was already created.
 */
export async function buildImmediateDeliveries({ store, organizationId, alert, decision, routingId, at }) {
  if (!decision.oncallUserId) return [];
  const channels = normalizeChannels(decision.notificationChannels ?? ['DISCORD']);
  const [responderUser, service, discordIdentity] = await Promise.all([
    store.getUserById(decision.oncallUserId),
    alert.serviceId ? store.getService(organizationId, alert.serviceId) : Promise.resolve(undefined),
    store.getDiscordIdentity(organizationId, decision.oncallUserId)
  ]);
  const records = [];
  for (const provider of channels) {
    const { integration } = await loadIntegrationFor({ store, organizationId, provider });
    records.push({
      organizationId,
      alertId: alert.id,
      routingId,
      escalationJobId: null,
      provider,
      responderUserId: decision.oncallUserId,
      responderNameSnapshot: decision.oncallDisplayName ?? responderUser?.displayName ?? null,
      scheduledAt: at,
      nextAttemptAt: at,
      status: 'PENDING',
      attemptCount: 0,
      destinationSnapshot: {
        ...destinationSnapshot({
          provider, integration, responder: responderUser,
          extra: { discordUserId: provider === 'DISCORD' ? discordIdentity?.discordUserId ?? null : null, timeZone: decision.timeZone ?? 'UTC' }
        }),
        serviceName: service?.name ?? null
      }
    });
  }
  return records;
}

/**
 * Deliver one routed alert through the durable outbox and, when a worker is
 * available, drain it once so paging latency stays comparable to a direct call.
 * Returns the M-001 shaped status summary. A configured channel that this build
 * cannot serve is refused outright rather than misrouted to another provider.
 */
export async function deliverAlertNotification({ store, config, organizationId, alert, decision, routingId, fetchImpl = fetch, logger = console, worker = null, at = new Date().toISOString() }) {
  if (!decision.oncallUserId) return { status: 'SKIPPED_NO_RESPONDER', provider: null };
  const channels = decision.notificationChannels ?? ['DISCORD'];
  const unsupported = channels.filter((channel) => !NOTIFICATION_CHANNELS.includes(channel));
  if (unsupported.length) {
    // Fail closed: never silently route a configured channel through a provider
    // the operator did not ask for.
    return { status: 'FAILED', provider: channels.join(','), error: 'One or more configured notification channels are not supported by this build.' };
  }
  if (!store.enqueueDeliveries) {
    // A store without the durable outbox can only report what it knows.
    const [channel] = normalizeChannels(channels);
    const { integration } = await loadIntegrationFor({ store, organizationId, provider: channel });
    if (!integration) return { status: 'SKIPPED_NO_INTEGRATION', provider: channel };
    if (!integration.enabled) return { status: 'SKIPPED_DISABLED', provider: channel };
    return { status: 'NOT_ATTEMPTED', provider: channel };
  }
  const records = await buildImmediateDeliveries({ store, organizationId, alert, decision, routingId, at });
  await store.enqueueDeliveries(records);
  // Low-latency kick: the page is already durable, so a crash here (or in the
  // provider call below) loses nothing — the polling loop or the next process
  // start will pick the same row back up.
  if (worker) await worker.kick(new Date(at), { alertId: alert.id });
  const deliveries = await store.listAlertDeliveries(organizationId, alert.id);
  // The worker owns the M-001 summary now; this result only shapes the response.
  const failedAttempt = deliveries.find((delivery) => delivery.attemptCount > 0 && ['FAILED', 'RETRYING'].includes(delivery.status));
  const sent = deliveries.find((delivery) => delivery.status === 'SENT');
  const providerLabel = failedAttempt?.provider ?? sent?.provider ?? deliveries[0]?.provider ?? channels[0];
  if (failedAttempt) {
    return { status: 'FAILED', provider: providerLabel, error: failedAttempt.lastError ?? 'Delivery failed.', workerOwned: true };
  }
  if (sent) return { status: 'SENT', provider: providerLabel, discordUserId: sent.destinationSnapshot?.discordUserId ?? null, workerOwned: true };
  return { status: 'NOT_ATTEMPTED', provider: providerLabel, workerOwned: true };
}

/**
 * Full routing pass for one newly-ingested alert. Never throws for delivery or
 * evaluation problems; those surface as warnings plus persisted state.
 */
export async function routeAlert({ store, config, organizationId, alert, at = new Date().toISOString(), fetchImpl = fetch, logger = console, notify = true, worker = null }) {
  const warnings = [];
  let decision;
  try {
    decision = await evaluateAlertRouting({ store, organizationId, alert, at });
  } catch (error) {
    logger.error?.('Alert routing evaluation failed:', error.message);
    warnings.push({ code: 'ALERT_ROUTING_FAILED', message: 'Routing evaluation failed; the alert remains durably stored.' });
    const routing = await store.getAlertRouting(organizationId, alert.id);
    return { routing, warnings };
  }

  const routing = await store.recordAlertRouting(organizationId, alert.id, decision);

  // Materialize future work only after the durable alert/routing record exists.
  // The persisted plan snapshots policy and schedule names so later edits do
  // not alter the meaning of an already-routed alert.
  if (decision.resolution === 'ROUTED' && decision.ruleId && store.materializeEscalationJobs) {
    try {
      const rule = await store.getRoutingRule(organizationId, decision.ruleId);
      const policy = rule?.escalationPolicyId ? await store.getEscalationPolicy(organizationId, rule.escalationPolicyId) : null;
      if (policy?.enabled) {
        const schedulesById = {};
        for (const step of policy.steps ?? []) {
          if (!schedulesById[step.targetScheduleId]) schedulesById[step.targetScheduleId] = await store.getSchedule(organizationId, step.targetScheduleId);
        }
        const plan = materializeEscalationPlan({ organizationId, alertId: alert.id, routingId: routing.id, routedAt: at, policy, steps: policy.steps ?? [], schedulesById });
        await store.materializeEscalationJobs(plan);
      }
    } catch (error) {
      logger.error?.('Escalation plan persistence failed:', error.message);
      warnings.push({ code: 'ESCALATION_PLAN_FAILED', message: 'The alert remains stored, but its escalation plan could not be persisted.' });
    }
  }

  if (notify) {
    const delivery = await deliverAlertNotification({ store, config, organizationId, alert, decision, routingId: routing?.id ?? null, at, fetchImpl, logger, worker });
    // The durable worker already recorded the outcome on the routing record.
    // Only the non-outbox fallback needs this write, so a later worker pass can
    // never be clobbered by an older summary.
    if (!delivery.workerOwned) {
      await store.recordRoutingNotification(organizationId, alert.id, {
        status: delivery.status,
        provider: delivery.provider,
        error: delivery.error,
        notifiedAt: delivery.status === 'SENT' ? new Date().toISOString() : null,
        discordUserId: delivery.discordUserId ?? null
      });
    }
    if (delivery.status === 'FAILED') warnings.push({ code: 'ALERT_NOTIFICATION_FAILED', message: 'The alert was routed but the notification could not be delivered.' });
  }

  return { routing: await store.getAlertRouting(organizationId, alert.id), decision, warnings };
}

/**
 * Build the operator-facing on-call state for every schedule in an
 * organization: who is on call right now, who is next, and whether a temporary
 * override is in force. Resolution happens server-side so the answer is the
 * same deterministic one the routing engine used.
 */
export async function buildOnCallState({ store, organizationId, at = new Date().toISOString() }) {
  const schedules = await store.listSchedules(organizationId);
  const now = new Date(at).toISOString();
  return schedules.map((schedule) => {
    const resolution = resolveOnCall({ schedule, participants: schedule.participants ?? [], overrides: schedule.overrides ?? [] }, now);
    const activeOverride = (schedule.overrides ?? []).find((override) => override.id === resolution.overrideId) ?? null;
    return {
      schedule: {
        id: schedule.id, organizationId: schedule.organizationId, teamId: schedule.teamId, teamName: schedule.teamName,
        name: schedule.name, timeZone: schedule.timeZone, enabled: schedule.enabled,
        rotationStartsAt: schedule.rotationStartsAt, rotationIntervalMinutes: schedule.rotationIntervalMinutes,
        createdAt: schedule.createdAt, updatedAt: schedule.updatedAt
      },
      participants: schedule.participants ?? [],
      current: {
        resolved: resolution.resolved,
        reason: resolution.reason,
        userId: resolution.responderUserId ?? null,
        displayName: resolution.responderDisplayName ?? null,
        source: resolution.source ?? null,
        periodStartsAt: resolution.periodStartsAt ?? null,
        periodEndsAt: resolution.periodEndsAt ?? null
      },
      next: (resolution.upcoming ?? []).slice(0, 3),
      activeOverride: activeOverride ? {
        id: activeOverride.id, replacementUserId: activeOverride.replacementUserId,
        replacementDisplayName: activeOverride.replacementDisplayName ?? null,
        startsAt: activeOverride.startsAt, endsAt: activeOverride.endsAt, reason: activeOverride.reason
      } : null,
      upcomingOverrides: (schedule.overrides ?? [])
        .filter((override) => new Date(override.startsAt).getTime() > new Date(now).getTime())
        .sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt))
        .slice(0, 5)
        .map((override) => ({
          id: override.id, replacementUserId: override.replacementUserId,
          replacementDisplayName: override.replacementDisplayName ?? null,
          startsAt: override.startsAt, endsAt: override.endsAt, reason: override.reason
        }))
    };
  });
}

/** Resolve a single schedule's on-call state, or 404 when it is not in the organization. */
export async function resolveScheduleOnCall({ store, organizationId, scheduleId, at = new Date().toISOString() }) {
  const schedule = await store.getSchedule(organizationId, scheduleId);
  if (!schedule) throw domainError('SCHEDULE_NOT_FOUND', 'On-call schedule not found.', 404);
  const resolution = resolveOnCall({ schedule, participants: schedule.participants ?? [], overrides: schedule.overrides ?? [] }, at);
  return {
    schedule,
    at,
    resolved: resolution.resolved,
    reason: resolution.reason,
    userId: resolution.responderUserId ?? null,
    displayName: resolution.responderDisplayName ?? null,
    source: resolution.source ?? null,
    overrideId: resolution.overrideId ?? null,
    periodStartsAt: resolution.periodStartsAt ?? null,
    periodEndsAt: resolution.periodEndsAt ?? null,
    nextStartsAt: resolution.nextStartsAt ?? null,
    upcoming: upcomingHandoffs(schedule, schedule.participants ?? [], at, 3),
    rotationOrder: (schedule.participants ?? [])
      .slice()
      .sort((a, b) => a.position - b.position)
      .map((participant) => ({ userId: participant.userId, displayName: participant.displayName ?? null, position: participant.position }))
  };
}
