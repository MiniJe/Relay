import { domainError } from './domain.mjs';

export const NOTIFICATION_CHANNELS = Object.freeze(['DISCORD', 'SLACK', 'EMAIL']);
export const DELIVERY_STATES = Object.freeze(['PENDING', 'IN_FLIGHT', 'RETRYING', 'SENT', 'FAILED', 'CANCELLED']);
export const ESCALATION_STATES = Object.freeze(['PENDING', 'IN_FLIGHT', 'COMPLETED', 'FAILED', 'CANCELLED_ACKNOWLEDGED']);
export const MAX_DELIVERY_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [60_000, 300_000];

function fail(message) { throw domainError('VALIDATION_ERROR', message, 400); }

/** Validate ordered escalation steps; delay is always measured from route time. */
export function validateEscalationSteps(steps) {
  if (!Array.isArray(steps) || steps.length > 32) fail('steps must be an array of at most 32 entries.');
  const positions = new Set();
  const delays = new Set();
  let previousPosition = -1;
  let previousDelay = 0;
  const normalized = steps.map((step, index) => {
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

export function dueRetryAt(now, attemptNumber) {
  const instant = new Date(now);
  if (Number.isNaN(instant.getTime())) fail('now must be a valid timestamp.');
  if (!Number.isInteger(attemptNumber) || attemptNumber < 1 || attemptNumber >= MAX_DELIVERY_ATTEMPTS) return null;
  return new Date(instant.getTime() + RETRY_DELAYS_MS[attemptNumber - 1]).toISOString();
}

/** Sanitize provider-facing alert text: remove control chars and mention syntax. */
export function sanitizeNotificationText(input, maxLength = 500) {
  return String(input ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/@(?=(?:channel|here|everyone)\b)/gi, '@ ').replace(/<!everyone>/gi, 'everyone').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

export function classifyDeliveryFailure(error) {
  const status = Number(error?.status ?? error?.statusCode);
  if (status === 429 || status >= 500 || error?.code === 'ECONNECTION' || error?.code === 'ETIMEDOUT' || error?.code === 'ECONNRESET' || error?.retryable === true) return 'RETRYABLE_FAILURE';
  return 'PERMANENT_FAILURE';
}
