import { domainError } from './domain.mjs';

// ---------------------------------------------------------------------------
// Relay 0.2 / RLY-0.2-M-002 — escalation, paging and durable-delivery domain.
//
// Everything in this module is pure: given a clock and a value it always
// answers the same thing. The stores own durability and the worker owns
// execution, which keeps the retry policy, the due-time arithmetic and the
// provider classification directly testable without a database or a network.
// ---------------------------------------------------------------------------

export const NOTIFICATION_CHANNELS = Object.freeze(['DISCORD', 'SLACK', 'EMAIL']);
export const DELIVERY_STATES = Object.freeze(['PENDING', 'IN_FLIGHT', 'RETRYING', 'SENT', 'FAILED', 'CANCELLED']);
export const ESCALATION_STATES = Object.freeze(['PENDING', 'IN_FLIGHT', 'COMPLETED', 'FAILED', 'CANCELLED_ACKNOWLEDGED']);
export const ATTEMPT_OUTCOMES = Object.freeze(['SENT', 'RETRYABLE_FAILURE', 'PERMANENT_FAILURE']);

/** Bounded automatic retries: attempt 1 immediate, attempt 2 +1m, attempt 3 +5m. */
export const MAX_DELIVERY_ATTEMPTS = 3;
export const RETRY_DELAYS_MS = Object.freeze([60_000, 300_000]);

export const PROVIDER_LABELS = Object.freeze({ DISCORD: 'Discord', SLACK: 'Slack', EMAIL: 'Email' });
export const DELIVERY_STATE_LABELS = Object.freeze({
  PENDING: 'Queued', IN_FLIGHT: 'Sending', RETRYING: 'Retry scheduled', SENT: 'Sent', FAILED: 'Delivery failed', CANCELLED: 'Cancelled'
});
export const ATTEMPT_OUTCOME_LABELS = Object.freeze({
  SENT: 'Sent', RETRYABLE_FAILURE: 'Retrying', PERMANENT_FAILURE: 'Permanent failure'
});
export const ESCALATION_STATE_LABELS = Object.freeze({
  PENDING: 'Scheduled', IN_FLIGHT: 'Executing', COMPLETED: 'Executed', FAILED: 'Failed', CANCELLED_ACKNOWLEDGED: 'Cancelled (acknowledged)'
});

const RETRYABLE_SOCKET_CODES = new Set([
  'ECONNECTION', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND', 'ESOCKET', 'EAGAIN', 'EHOSTUNREACH', 'ENETUNREACH'
]);
const PERMANENT_SOCKET_CODES = new Set(['EAUTH', 'EENVELOPE', 'EMESSAGE', 'EADDRESS', 'EINVALIDCONFIG', 'EPROTOCOL']);

function fail(message) { throw domainError('VALIDATION_ERROR', message, 400); }

/** Validate ordered escalation steps; delay is always measured from route time. */
export function validateEscalationSteps(steps) {
  if (!Array.isArray(steps) || steps.length > 32) fail('steps must be an array of at most 32 entries.');
  const positions = new Set();
  const delays = new Set();
  let previousPosition = -1;
  let previousDelay = 0;
  const normalized = steps.map((step) => {
    const position = Number(step.position);
    const afterMinutes = Number(step.afterMinutes);
    if (!Number.isInteger(position) || position < 0 || positions.has(position)) fail('Escalation step positions must be unique non-negative integers.');
    if (!Number.isInteger(afterMinutes) || afterMinutes <= 0 || delays.has(afterMinutes)) fail('Escalation delays must be unique positive integer minutes.');
    if (position <= previousPosition || afterMinutes <= previousDelay) fail('Escalation steps must be strictly ordered by position and afterMinutes.');
    if (typeof step.targetScheduleId !== 'string' || !step.targetScheduleId.trim()) fail('Each escalation step requires a target schedule.');
    if (!Array.isArray(step.channels) || !step.channels.length || step.channels.some((c) => !NOTIFICATION_CHANNELS.includes(c)) || new Set(step.channels).size !== step.channels.length) fail('Each step needs one or more unique supported notification channels.');
    positions.add(position); delays.add(afterMinutes); previousPosition = position; previousDelay = afterMinutes;
    return { position, afterMinutes, targetScheduleId: step.targetScheduleId, channels: [...step.channels] };
  });
  return normalized;
}

/** Materialize immutable policy/schedule name snapshots for an alert's route instant. */
export function materializeEscalationPlan({ policy, steps, schedulesById, routingId, alertId, organizationId, routedAt }) {
  const routeTime = new Date(routedAt);
  if (Number.isNaN(routeTime.getTime())) fail('routedAt must be a valid timestamp.');
  if (!policy?.id || !policy.enabled) return [];
  return validateEscalationSteps(steps).map((step) => {
    const schedule = schedulesById instanceof Map ? schedulesById.get(step.targetScheduleId) : schedulesById?.[step.targetScheduleId];
    if (!schedule || schedule.organizationId !== organizationId) fail('Escalation target schedule must belong to the policy organization.');
    return {
      organizationId, alertId, routingId, policyId: policy.id, policyNameSnapshot: policy.name,
      stepPosition: step.position, afterMinutes: step.afterMinutes,
      dueAt: new Date(routeTime.getTime() + step.afterMinutes * 60_000).toISOString(),
      targetScheduleId: schedule.id, targetScheduleNameSnapshot: schedule.name,
      channels: [...step.channels], state: 'PENDING'
    };
  });
}

export function cancelUnexecutedEscalations(jobs, acknowledgedAt) {
  return jobs.map((job) => ['PENDING', 'IN_FLIGHT'].includes(job.state)
    ? { ...job, state: 'CANCELLED_ACKNOWLEDGED', updatedAt: acknowledgedAt }
    : job);
}

/** Absolute instant of the next automatic attempt, or null when retries are exhausted. */
export function dueRetryAt(now, attemptNumber) {
  const instant = new Date(now);
  if (Number.isNaN(instant.getTime())) fail('now must be a valid timestamp.');
  if (!Number.isInteger(attemptNumber) || attemptNumber < 1 || attemptNumber >= MAX_DELIVERY_ATTEMPTS) return null;
  return new Date(instant.getTime() + RETRY_DELAYS_MS[attemptNumber - 1]).toISOString();
}

/**
 * Decide what happens after one finished attempt.
 *
 * `attemptNumber` is the attempt that just completed (1-based). A failed
 * attempt consumes one of the bounded retries; the last failure is terminal so
 * a page can never be retried forever.
 */
export function planAfterAttempt({ now, attemptNumber, outcome }) {
  const instant = new Date(now);
  if (Number.isNaN(instant.getTime())) fail('now must be a valid timestamp.');
  if (!Number.isInteger(attemptNumber) || attemptNumber < 1) fail('attemptNumber must be a positive integer.');
  if (!ATTEMPT_OUTCOMES.includes(outcome)) fail('outcome must be one of: SENT, RETRYABLE_FAILURE, PERMANENT_FAILURE.');
  if (outcome === 'SENT') return { status: 'SENT', nextAttemptAt: null, terminal: true };
  if (outcome === 'PERMANENT_FAILURE') return { status: 'FAILED', nextAttemptAt: null, terminal: true };
  const nextAttemptAt = attemptNumber < MAX_DELIVERY_ATTEMPTS ? dueRetryAt(instant, attemptNumber) : null;
  return nextAttemptAt ? { status: 'RETRYING', nextAttemptAt, terminal: false } : { status: 'FAILED', nextAttemptAt: null, terminal: true };
}

/** Sanitize provider-facing alert text: remove control chars and mention syntax. */
export function sanitizeNotificationText(input, maxLength = 500) {
  return String(input ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/@(?=(?:channel|here|everyone)\b)/gi, '@ ').replace(/<!everyone>/gi, 'everyone').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

/**
 * Neutralize Slack's broadcast and user mention syntax in operator-supplied
 * text. `<@U123>`/`<!channel>` are stripped of their angle brackets so they
 * render as inert text and can never notify a channel or a person that Relay
 * did not deliberately choose.
 */
export function sanitizeSlackText(input, maxLength = 2800) {
  return String(input ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/<!(channel|here|everyone|subteam\^[^>]*)>/gi, '$1')
    .replace(/<@[^>]*>/g, 'user')
    .replace(/<#[^>]*>/g, 'channel')
    .replace(/<(https?:[^>|]*)(\|[^>]*)?>/gi, '$1')
    .replace(/[<>]/g, '')
    .replace(/@(channel|here|everyone)\b/gi, '@ $1')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

/**
 * Classify a provider failure. Explicit flags win, then HTTP status, then the
 * transport error code. Anything unrecognized is retryable: a bounded retry of
 * an unknown failure is safer than silently dropping a page.
 */
export function classifyDeliveryFailure(error) {
  if (error?.permanent === true) return 'PERMANENT_FAILURE';
  if (error?.retryable === true) return 'RETRYABLE_FAILURE';
  const status = Number(error?.status ?? error?.statusCode ?? error?.responseCode);
  if (Number.isInteger(status) && status > 0) {
    if (status === 408 || status === 425 || status === 429 || status >= 500) return 'RETRYABLE_FAILURE';
    if (status >= 400) return 'PERMANENT_FAILURE';
    return 'SENT';
  }
  const code = String(error?.code ?? '').toUpperCase();
  if (PERMANENT_SOCKET_CODES.has(code)) return 'PERMANENT_FAILURE';
  if (RETRYABLE_SOCKET_CODES.has(code)) return 'RETRYABLE_FAILURE';
  return 'RETRYABLE_FAILURE';
}

/** Plain-text page body shared by Slack and email so both read identically. */
export function buildPageText({ alert, service, routing, escalation, responderDisplayName } = {}) {
  const lines = [];
  lines.push(`[${sanitizeNotificationText(alert?.severity ?? 'unknown', 60)}] ${sanitizeNotificationText(alert?.title ?? 'Untitled alert', 200)}`);
  const context = [];
  context.push(`Source: ${sanitizeNotificationText(alert?.source ?? 'unknown', 120)}`);
  if (service?.name) context.push(`Service: ${sanitizeNotificationText(service.name, 120)}`);
  if (responderDisplayName) context.push(`On call: ${sanitizeNotificationText(responderDisplayName, 120)}`);
  const via = [routing?.ruleName, routing?.scheduleName, routing?.teamName].filter(Boolean).join(' -> ');
  if (via) context.push(`Routed via: ${sanitizeNotificationText(via, 200)}`);
  if (escalation?.policyNameSnapshot) context.push(`Escalation: step ${Number(escalation.stepPosition ?? 0) + 1} of ${sanitizeNotificationText(escalation.policyNameSnapshot, 120)} (${escalation.afterMinutes} min)`);
  lines.push(context.join('\n'));
  const description = sanitizeNotificationText(alert?.description ?? '', 1200);
  if (description) lines.push(description);
  if (alert?.observedAt) lines.push(`Observed: ${sanitizeNotificationText(alert.observedAt, 40)}`);
  lines.push('Acknowledge this alert in the Relay alerts workspace.');
  return lines.join('\n\n');
}

/** Compact operational summary used by the API, the UI and the routing record. */
export function summarizeDeliveries(deliveries = []) {
  const states = deliveries.map((d) => d.status);
  const label = states.includes('FAILED') ? 'FAILED'
    : states.includes('RETRYING') ? 'RETRYING'
      : states.includes('IN_FLIGHT') ? 'IN_FLIGHT'
        : states.includes('PENDING') ? 'PENDING'
          : states.includes('SENT') ? 'SENT'
            : states.includes('CANCELLED') ? 'CANCELLED'
              : 'NONE';
  return {
    total: deliveries.length,
    status: label,
    label: DELIVERY_STATE_LABELS[label] ?? 'No delivery',
    attempts: deliveries.reduce((sum, d) => sum + Number(d.attemptCount ?? 0), 0),
    nextAttemptAt: deliveries.map((d) => d.nextAttemptAt).filter(Boolean).sort()[0] ?? null,
    providers: [...new Set(deliveries.map((d) => d.provider))]
  };
}
