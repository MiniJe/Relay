// Relay 0.2 — alert routing execution.
//
//   receive → validate → persist/idempotency → evaluate routing rules
//           → resolve schedule → resolve current on-call responder
//           → persist routing result → attempt notification
//
// Durability rule: the alert is already committed before any of this runs. A
// routing failure or a Discord outage can never roll back the alert; both are
// recorded as warnings and as state on the routing audit record.

import { domainError } from '../../../packages/shared/domain.mjs';
import { resolveOnCall, selectRoutingRule, upcomingHandoffs } from '../../../packages/shared/oncall.mjs';
import { sendDiscordAlertNotification } from './discord.mjs';

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
      overrideId: null, periodStartsAt: null, periodEndsAt: null, timeZone: null
    };
  }
  const schedule = await store.getSchedule(organizationId, rule.targetScheduleId);
  const base = {
    ruleId: rule.id, ruleName: rule.name,
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
 * Attempt the first notification channel. Returns a status rather than
 * throwing so the caller can persist the outcome next to the durable alert.
 */
export async function deliverAlertNotification({ store, config, organizationId, alert, decision, fetchImpl = fetch, logger = console }) {
  if (!decision.oncallUserId) return { status: 'SKIPPED_NO_RESPONDER', provider: null };
  const integration = await store.getIntegration(organizationId, 'DISCORD');
  if (!integration) return { status: 'SKIPPED_NO_INTEGRATION', provider: 'DISCORD' };
  if (!integration.enabled) return { status: 'SKIPPED_DISABLED', provider: 'DISCORD' };

  const [identity, service] = await Promise.all([
    store.getDiscordIdentity(organizationId, decision.oncallUserId),
    alert.serviceId ? store.getService(organizationId, alert.serviceId) : Promise.resolve(undefined)
  ]);
  const discordUserId = identity?.discordUserId ?? null;
  try {
    await sendDiscordAlertNotification({
      integration,
      encryptionKey: config.integrationEncryptionKey,
      alert,
      routing: decision,
      service,
      mentionDiscordUserId: discordUserId,
      timeZone: decision.timeZone ?? 'UTC',
      fetchImpl
    });
    return { status: 'SENT', provider: 'DISCORD', discordUserId };
  } catch (error) {
    // Log the message only: the webhook URL and its token are secrets.
    logger.warn?.('Alert notification delivery failed:', error.message);
    return { status: 'FAILED', provider: 'DISCORD', discordUserId, error: error.message };
  }
}

/**
 * Full routing pass for one newly-ingested alert. Never throws for delivery or
 * evaluation problems; those surface as warnings plus persisted state.
 */
export async function routeAlert({ store, config, organizationId, alert, at = new Date().toISOString(), fetchImpl = fetch, logger = console, notify = true }) {
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

  if (notify) {
    const delivery = await deliverAlertNotification({ store, config, organizationId, alert, decision, fetchImpl, logger });
    await store.recordRoutingNotification(organizationId, alert.id, {
      status: delivery.status,
      provider: delivery.provider,
      error: delivery.error,
      notifiedAt: delivery.status === 'SENT' ? new Date().toISOString() : null,
      discordUserId: delivery.discordUserId ?? null
    });
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
