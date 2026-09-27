// Relay 0.2 on-call and alert-routing domain core.
//
// Design rules enforced here:
//   * Every rotation calculation is performed on absolute UTC instants. The
//     server's local timezone and locale never influence a result, so the same
//     inputs always produce the same responder on any machine.
//   * The schedule timezone is an IANA identifier used for (a) validating
//     operator intent and (b) presenting handoff boundaries to humans. It is
//     deliberately NOT used for period arithmetic - see docs/ONCALL.md for the
//     explicit daylight-saving-time contract.
//   * Overrides are additive and temporary. Resolving an override never
//     mutates the underlying rotation.

import { domainError } from './domain.mjs';

/** Rotation handoff interval bounds, expressed unambiguously in minutes. */
export const MIN_ROTATION_INTERVAL_MINUTES = 60; // 1 hour
export const MAX_ROTATION_INTERVAL_MINUTES = 525_600; // 365 days

/** Preset intervals offered by the UI/API. Any value in the bounds is valid. */
export const ROTATION_PRESETS = Object.freeze([
  { minutes: 720, label: '12 hours' },
  { minutes: 1440, label: '24 hours (daily)' },
  { minutes: 10_080, label: '7 days (weekly)' },
  { minutes: 20_160, label: '14 days (biweekly)' }
]);

const timePartsFormatter = new Map();

/**
 * True when `timeZone` is an IANA identifier understood by the runtime.
 * Never depends on the host's configured timezone.
 */
export function isValidTimeZone(timeZone) {
  if (typeof timeZone !== 'string') return false;
  const value = timeZone.trim();
  if (!value || value.length > 64) return false;
  // Reject anything the runtime would silently coerce, and anything that is
  // not a plausible IANA area/location identifier.
  if (!/^[A-Za-z][A-Za-z0-9+._-]*(\/[A-Za-z0-9+._-]+)+$/.test(value) && value.toUpperCase() !== 'UTC') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function assertTimeZone(timeZone) {
  if (!isValidTimeZone(timeZone)) {
    throw domainError('INVALID_TIMEZONE', 'timeZone must be a valid IANA timezone identifier such as Europe/Bucharest or UTC.', 400);
  }
  return timeZone.trim();
}

function partsFormatter(timeZone) {
  const assertKey = assertTimeZone(timeZone);
  let formatter = timePartsFormatter.get(assertKey);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: assertKey,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      weekday: 'short',
      timeZoneName: 'longOffset'
    });
    timePartsFormatter.set(assertKey, formatter);
  }
  return formatter;
}

/**
 * Wall-clock breakdown of an instant in an explicit IANA timezone.
 * Deterministic: fixed locale, fixed hour cycle, explicit zone.
 */
export function wallClockInTimeZone(instant, timeZone) {
  const date = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(date.getTime())) throw domainError('VALIDATION_ERROR', 'A valid timestamp is required.', 400);
  const parts = {};
  for (const part of partsFormatter(timeZone).formatToParts(date)) parts[part.type] = part.value;
  const offsetLabel = String(parts.timeZoneName ?? '').replace(/^GMT/, '') || 'UTC';
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour === '24' ? 0 : parts.hour), minute: Number(parts.minute), second: Number(parts.second),
    weekday: parts.weekday,
    offsetLabel: offsetLabel === '' ? 'UTC' : offsetLabel,
    iso: date.toISOString()
  };
}

const pad = (value) => String(value).padStart(2, '0');

/** Human-readable rendering of an instant in the schedule timezone. */
export function formatInTimeZone(instant, timeZone) {
  const wall = wallClockInTimeZone(instant, timeZone);
  // A zero offset reads as plain UTC; any other offset is shown explicitly so
  // the rendered wall clock can never be mistaken for the server's local time.
  const zone = wall.offsetLabel === '' || wall.offsetLabel === '+00:00' ? 'UTC' : `UTC${wall.offsetLabel}`;
  return `${wall.year}-${pad(wall.month)}-${pad(wall.day)} ${pad(wall.hour)}:${pad(wall.minute)} ${zone}`;
}

export function assertRotationInterval(minutes) {
  if (!Number.isInteger(minutes)) {
    throw domainError('VALIDATION_ERROR', 'rotationIntervalMinutes must be a whole number of minutes.', 400);
  }
  if (minutes < MIN_ROTATION_INTERVAL_MINUTES || minutes > MAX_ROTATION_INTERVAL_MINUTES) {
    throw domainError(
      'VALIDATION_ERROR',
      `rotationIntervalMinutes must be between ${MIN_ROTATION_INTERVAL_MINUTES} and ${MAX_ROTATION_INTERVAL_MINUTES} minutes.`,
      400
    );
  }
  return minutes;
}

function toMs(instant, name) {
  const ms = instant instanceof Date ? instant.getTime() : new Date(instant).getTime();
  if (Number.isNaN(ms)) throw domainError('VALIDATION_ERROR', `${name} must be a valid timestamp.`, 400);
  return ms;
}

/**
 * Deterministic fixed-duration rotation.
 *
 * Handoff instants are `rotationStartsAt + k * interval` measured in absolute
 * elapsed milliseconds. Because no calendar or local-time arithmetic is
 * involved, a 7 day rotation always lasts exactly 168 hours and can never be
 * skipped, duplicated or stretched by a daylight-saving transition. The
 * observable consequence is that the *local wall-clock* handoff time shifts by
 * the DST offset for the remainder of the current cycle - this is documented
 * behaviour, not a defect.
 */
export function resolveRotation({ rotationStartsAt, rotationIntervalMinutes }, participants, at) {
  const ordered = [...(participants ?? [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  if (!ordered.length) return { resolved: false, reason: 'NO_PARTICIPANTS' };
  const startMs = toMs(rotationStartsAt, 'rotationStartsAt');
  const intervalMs = assertRotationInterval(Number(rotationIntervalMinutes)) * 60_000;
  const atMs = toMs(at, 'at');
  if (atMs < startMs) return { resolved: false, reason: 'ROTATION_NOT_STARTED', participants: ordered, nextStartsAt: new Date(startMs).toISOString() };

  const index = Math.floor((atMs - startMs) / intervalMs);
  const position = ((index % ordered.length) + ordered.length) % ordered.length;
  return {
    resolved: true,
    reason: 'ROTATION',
    participants: ordered,
    rotationIndex: index,
    participantPosition: position,
    responderUserId: ordered[position].userId,
    responderDisplayName: ordered[position].displayName ?? null,
    periodStartsAt: new Date(startMs + index * intervalMs).toISOString(),
    periodEndsAt: new Date(startMs + (index + 1) * intervalMs).toISOString()
  };
}

/**
 * Next `count` deterministic handoffs after `at`. Returned in chronological
 * order so the UI can answer "who is next, and when does it change?" without
 * recomputing anything client-side.
 */
export function upcomingHandoffs(schedule, participants, at, count = 3) {
  const ordered = [...(participants ?? [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  if (!ordered.length) return [];
  const startMs = toMs(schedule.rotationStartsAt, 'rotationStartsAt');
  const intervalMs = assertRotationInterval(Number(schedule.rotationIntervalMinutes)) * 60_000;
  const atMs = toMs(at, 'at');
  const firstIndex = atMs < startMs ? 0 : Math.floor((atMs - startMs) / intervalMs) + 1;
  const out = [];
  for (let i = 0; i < Math.max(0, Math.min(count, ordered.length * 4)); i += 1) {
    const index = firstIndex + i;
    const participant = ordered[((index % ordered.length) + ordered.length) % ordered.length];
    out.push({
      rotationIndex: index,
      userId: participant.userId,
      displayName: participant.displayName ?? null,
      startsAt: new Date(startMs + index * intervalMs).toISOString(),
      endsAt: new Date(startMs + (index + 1) * intervalMs).toISOString()
    });
  }
  return out;
}

/**
 * Deterministic override selection.
 *
 * Overlapping overrides are rejected at creation time, so in practice at most
 * one override covers an instant. Legacy or concurrently-created data is still
 * resolved without ambiguity: earliest start wins, then the longest-running,
 * then the lexicographically smallest identifier.
 */
export function selectActiveOverride(overrides, at) {
  const atMs = toMs(at, 'at');
  const active = (overrides ?? []).filter((override) => toMs(override.startsAt, 'startsAt') <= atMs && atMs < toMs(override.endsAt, 'endsAt'));
  if (!active.length) return undefined;
  const sorted = [...active].sort((a, b) => {
    const byStart = toMs(a.startsAt, 'startsAt') - toMs(b.startsAt, 'startsAt');
    if (byStart !== 0) return byStart;
    const byEnd = toMs(b.endsAt, 'endsAt') - toMs(a.endsAt, 'endsAt');
    if (byEnd !== 0) return byEnd;
    return String(a.id).localeCompare(String(b.id));
  });
  return sorted[0];
}

export function overridesOverlap(a, b) {
  const aStart = toMs(a.startsAt, 'startsAt');
  const aEnd = toMs(a.endsAt, 'endsAt');
  const bStart = toMs(b.startsAt, 'startsAt');
  const bEnd = toMs(b.endsAt, 'endsAt');
  return aStart < bEnd && bStart < aEnd;
}

/** Reasons a schedule may fail to yield a responder. All are persisted verbatim. */
export const ROUTING_RESOLUTIONS = Object.freeze([
  'ROUTED',
  'NO_MATCHING_RULE',
  'SCHEDULE_DISABLED',
  'SCHEDULE_MISSING',
  'ROTATION_NOT_STARTED',
  'NO_PARTICIPANTS',
  'RULE_TARGET_MISSING'
]);

/**
 * Full on-call resolution for a schedule at an instant.
 * Overrides take precedence over the rotation; the rotation is never rewritten.
 */
export function resolveOnCall({ schedule, participants, overrides }, at) {
  if (!schedule) return { resolved: false, reason: 'SCHEDULE_MISSING', responderUserId: null, responderDisplayName: null, source: null, overrideId: null, periodStartsAt: null, periodEndsAt: null };
  if (schedule.enabled === false) return { resolved: false, reason: 'SCHEDULE_DISABLED', responderUserId: null, responderDisplayName: null, source: null, overrideId: null, periodStartsAt: null, periodEndsAt: null };

  const override = selectActiveOverride(overrides, at);
  const rotation = resolveRotation(schedule, participants, at);
  const upcoming = rotation.resolved || rotation.reason === 'ROTATION_NOT_STARTED' ? upcomingHandoffs(schedule, participants, at, 3) : [];

  if (override) {
    return {
      resolved: true,
      reason: 'ROUTED',
      source: 'OVERRIDE',
      overrideId: override.id ?? null,
      responderUserId: override.replacementUserId,
      responderDisplayName: override.replacementDisplayName ?? null,
      periodStartsAt: override.startsAt,
      periodEndsAt: override.endsAt,
      rotationIndex: rotation.rotationIndex ?? null,
      rotationResponderUserId: rotation.responderUserId ?? null,
      rotationResponderDisplayName: rotation.responderDisplayName ?? null,
      upcoming
    };
  }

  if (!rotation.resolved) {
    return {
      resolved: false,
      reason: rotation.reason,
      source: null,
      overrideId: null,
      responderUserId: null,
      responderDisplayName: null,
      periodStartsAt: rotation.periodStartsAt ?? null,
      periodEndsAt: rotation.periodEndsAt ?? null,
      nextStartsAt: rotation.nextStartsAt ?? null,
      upcoming
    };
  }

  return {
    resolved: true,
    reason: 'ROUTED',
    source: 'ROTATION',
    overrideId: null,
    responderUserId: rotation.responderUserId,
    responderDisplayName: rotation.responderDisplayName,
    periodStartsAt: rotation.periodStartsAt,
    periodEndsAt: rotation.periodEndsAt,
    rotationIndex: rotation.rotationIndex,
    participantPosition: rotation.participantPosition,
    upcoming
  };
}

/**
 * Deterministic rule ordering. Explicit `priority` first; ties broken by
 * creation time and then identifier so ordering never depends on database row
 * order, plan choice, or insertion timing.
 */
export function sortRoutingRules(rules) {
  return [...(rules ?? [])].sort((a, b) => {
    const byPriority = (a.priority ?? 0) - (b.priority ?? 0);
    if (byPriority !== 0) return byPriority;
    const byCreated = toMs(a.createdAt ?? 0, 'createdAt') - toMs(b.createdAt ?? 0, 'createdAt');
    if (byCreated !== 0) return byCreated;
    return String(a.id).localeCompare(String(b.id));
  });
}

const normalizeMatch = (value) => String(value ?? '').trim().toLowerCase();

/**
 * Match evaluation for one rule against one alert.
 *
 * A `null`/absent condition means "matches anything". Comparison is exact
 * after trimming and case-folding - there is no wildcard, regex, or expression
 * language, so rule behaviour is fully predictable and cannot be weaponised by
 * alert metadata.
 */
export function ruleMatches(rule, alert) {
  if (!rule || rule.enabled === false) return false;
  if (rule.matchServiceId != null && String(rule.matchServiceId) !== String(alert.serviceId ?? '')) return false;
  if (rule.matchSource != null && normalizeMatch(rule.matchSource) !== normalizeMatch(alert.source)) return false;
  const severities = rule.matchSeverities ?? [];
  if (severities.length && !severities.some((severity) => normalizeMatch(severity) === normalizeMatch(alert.severity))) return false;
  return true;
}

/** First matching enabled rule in deterministic order, or null. */
export function selectRoutingRule(rules, alert) {
  for (const rule of sortRoutingRules(rules)) if (ruleMatches(rule, alert)) return rule;
  return null;
}
