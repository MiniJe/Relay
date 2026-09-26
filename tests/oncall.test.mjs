import test from 'node:test';
import assert from 'node:assert/strict';

// Every assertion below must hold regardless of the timezone the process runs
// in. Pinning an extreme offset here proves that rotation arithmetic never
// consults the server's local timezone.
process.env.TZ = 'Pacific/Kiritimati';

const {
  isValidTimeZone, assertTimeZone, wallClockInTimeZone, formatInTimeZone,
  resolveRotation, upcomingHandoffs, resolveOnCall, selectActiveOverride,
  overridesOverlap, sortRoutingRules, ruleMatches, selectRoutingRule,
  assertRotationInterval
} = await import('../packages/shared/oncall.mjs');

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

const PARTICIPANTS = [
  { userId: 'u-ada', displayName: 'Ada Lovelace', position: 0 },
  { userId: 'u-grace', displayName: 'Grace Hopper', position: 1 },
  { userId: 'u-linus', displayName: 'Linus Torvalds', position: 2 }
];

// A Monday 09:00 UTC anchor, used by most rotation assertions.
const START = '2026-01-05T09:00:00.000Z';
const weekly = { rotationStartsAt: START, rotationIntervalMinutes: 10_080 };
const daily = { rotationStartsAt: START, rotationIntervalMinutes: 1440 };

const at = (offsetMs) => new Date(new Date(START).getTime() + offsetMs).toISOString();

test('timezone validation accepts IANA identifiers and rejects everything else', () => {
  for (const valid of ['Europe/Bucharest', 'Europe/London', 'America/New_York', 'UTC', 'Asia/Kolkata', 'Australia/Lord_Howe']) {
    assert.equal(isValidTimeZone(valid), true, `${valid} must be accepted`);
    assert.equal(assertTimeZone(valid), valid);
  }
  for (const invalid of ['', '   ', 'Local', 'GMT+3', 'Europe/Bucharest; DROP TABLE users', 'Mars/Olympus_Mons',
    'not a timezone', 'UTC/Extra/Deep', 42, null, undefined, {}, 'Europe/', '/Bucharest']) {
    assert.equal(isValidTimeZone(invalid), false, `${JSON.stringify(invalid)} must be rejected`);
  }
  assert.throws(() => assertTimeZone('Mars/Olympus_Mons'), (error) => error.code === 'INVALID_TIMEZONE' && error.status === 400);
});

test('timezone rendering is explicit and independent of the host timezone', () => {
  // 2026-07-01T12:00:00Z is 15:00 in Europe/Bucharest (EEST, UTC+3) no matter
  // which TZ the process was started with.
  const wall = wallClockInTimeZone('2026-07-01T12:00:00.000Z', 'Europe/Bucharest');
  assert.deepEqual({ year: wall.year, month: wall.month, day: wall.day, hour: wall.hour, minute: wall.minute }, { year: 2026, month: 7, day: 1, hour: 15, minute: 0 });
  assert.equal(wall.offsetLabel, '+03:00');
  assert.equal(formatInTimeZone('2026-07-01T12:00:00.000Z', 'Europe/Bucharest'), '2026-07-01 15:00 UTC+03:00');
  // The same instant in winter is UTC+2, which proves the offset comes from the
  // IANA database rather than a hardcoded value.
  assert.equal(formatInTimeZone('2026-01-01T12:00:00.000Z', 'Europe/Bucharest'), '2026-01-01 14:00 UTC+02:00');
  assert.equal(formatInTimeZone('2026-01-01T12:00:00.000Z', 'UTC'), '2026-01-01 12:00 UTC');
  assert.equal(formatInTimeZone('2026-01-01T12:00:00.000Z', 'America/New_York'), '2026-01-01 07:00 UTC-05:00');
});

test('rotation intervals are validated unambiguously in minutes', () => {
  assert.equal(assertRotationInterval(1440), 1440);
  assert.equal(assertRotationInterval(10_080), 10_080);
  for (const invalid of [0, -1440, 59, 1440.5, '1440', 525_601, Number.NaN, null]) {
    assert.throws(() => assertRotationInterval(invalid), `${invalid} must be rejected`);
  }
});

test('rotation selection is deterministic at period boundaries', () => {
  assert.equal(resolveRotation(weekly, PARTICIPANTS, at(0)).responderUserId, 'u-ada', 'exactly at start');
  assert.equal(resolveRotation(weekly, PARTICIPANTS, at(1)).responderUserId, 'u-ada', 'one millisecond after start');
  assert.equal(resolveRotation(weekly, PARTICIPANTS, at(WEEK - 1)).responderUserId, 'u-ada', 'last millisecond of the first period');
  assert.equal(resolveRotation(weekly, PARTICIPANTS, at(WEEK)).responderUserId, 'u-grace', 'handoff is inclusive of the new period');
  assert.equal(resolveRotation(weekly, PARTICIPANTS, at(2 * WEEK)).responderUserId, 'u-linus');
  assert.equal(resolveRotation(weekly, PARTICIPANTS, at(3 * WEEK)).responderUserId, 'u-ada', 'rotation wraps to the first participant');
});

test('rotation resolves correctly across many handoffs', () => {
  for (let index = 0; index < 40; index += 1) {
    const result = resolveRotation(weekly, PARTICIPANTS, at(index * WEEK + 5 * MINUTE));
    assert.equal(result.rotationIndex, index);
    assert.equal(result.responderUserId, PARTICIPANTS[index % PARTICIPANTS.length].userId);
    assert.equal(result.periodStartsAt, at(index * WEEK));
    assert.equal(result.periodEndsAt, at((index + 1) * WEEK));
  }
  // A dense daily rotation with two participants alternates every 24 hours.
  const two = PARTICIPANTS.slice(0, 2);
  for (let index = 0; index < 10; index += 1) {
    assert.equal(resolveRotation(daily, two, at(index * DAY + 12 * HOUR)).responderUserId, two[index % 2].userId);
  }
  // Participant order comes from `position`, not from array order.
  const shuffled = [PARTICIPANTS[2], PARTICIPANTS[0], PARTICIPANTS[1]];
  assert.equal(resolveRotation(weekly, shuffled, at(0)).responderUserId, 'u-ada', 'position 0 wins regardless of array order');
});

test('rotation period boundaries are absolute UTC instants', () => {
  const result = resolveRotation(weekly, PARTICIPANTS, at(2 * WEEK + 3 * HOUR));
  assert.equal(result.periodStartsAt, at(2 * WEEK));
  assert.equal(result.periodEndsAt, at(3 * WEEK));
  assert.equal(new Date(result.periodEndsAt).getTime() - new Date(result.periodStartsAt).getTime(), WEEK,
    'a weekly period is always exactly 168 hours');
});

test('a rotation that has not started yet resolves no responder', () => {
  const result = resolveRotation(weekly, PARTICIPANTS, at(-1));
  assert.equal(result.resolved, false);
  assert.equal(result.reason, 'ROTATION_NOT_STARTED');
  assert.equal(result.nextStartsAt, START);
});

test('an empty rotation resolves no responder rather than guessing', () => {
  const result = resolveRotation(weekly, [], at(DAY));
  assert.equal(result.resolved, false);
  assert.equal(result.reason, 'NO_PARTICIPANTS');
});

test('upcoming handoffs are chronological and deterministic', () => {
  const next = upcomingHandoffs(weekly, PARTICIPANTS, at(2 * WEEK + HOUR), 3);
  assert.equal(next.length, 3);
  // At two weeks plus an hour the rotation is inside period index 2 (Linus),
  // so the next three handoffs are indexes 3, 4 and 5.
  assert.deepEqual(next.map((x) => x.userId), ['u-ada', 'u-grace', 'u-linus']);
  assert.equal(next[0].startsAt, at(3 * WEEK));
  assert.equal(next[1].startsAt, at(4 * WEEK));
  assert.ok(new Date(next[0].startsAt) < new Date(next[1].startsAt));
  // Before the rotation starts, the first handoff is the first period.
  assert.equal(upcomingHandoffs(weekly, PARTICIPANTS, at(-WEEK), 1)[0].startsAt, START);
});

// ---------------------------------------------------------------------------
// Daylight-saving time. Relay computes handoffs from absolute elapsed UTC
// milliseconds, so a DST transition can never skip, repeat or stretch a shift.
// The observable effect is that the local wall-clock handoff time moves by the
// DST offset - documented behaviour, asserted here so it cannot regress.
// ---------------------------------------------------------------------------
test('daylight saving cannot skip or duplicate a handoff', () => {
  // Europe/Bucharest enters summer time on 2026-03-29 (last Sunday of March).
  const dstStart = '2026-03-23T07:00:00.000Z'; // 09:00 EET, UTC+2
  const schedule = { rotationStartsAt: dstStart, rotationIntervalMinutes: 10_080 };
  const before = resolveRotation(schedule, PARTICIPANTS, new Date(new Date(dstStart).getTime() + WEEK - MINUTE).toISOString());
  const after = resolveRotation(schedule, PARTICIPANTS, new Date(new Date(dstStart).getTime() + WEEK).toISOString());

  assert.equal(before.responderUserId, 'u-ada');
  assert.equal(after.responderUserId, 'u-grace', 'exactly one handoff occurs across the DST transition');
  assert.equal(after.rotationIndex, 1, 'the rotation index advances by exactly one');
  assert.equal(new Date(after.periodStartsAt).getTime() - new Date(dstStart).getTime(), WEEK,
    'the week still lasts exactly 168 hours across the transition');

  // The local wall-clock handoff time shifts by the DST offset: 09:00 -> 10:00.
  const startWall = formatInTimeZone(dstStart, 'Europe/Bucharest');
  const handoffWall = formatInTimeZone(after.periodStartsAt, 'Europe/Bucharest');
  assert.equal(startWall, '2026-03-23 09:00 UTC+02:00');
  assert.equal(handoffWall, '2026-03-30 10:00 UTC+03:00');

  // No instant is evaluated twice and none is skipped.
  const seen = new Set();
  for (let ms = 0; ms < 4 * WEEK; ms += HOUR) {
    const resolved = resolveRotation(schedule, PARTICIPANTS, new Date(new Date(dstStart).getTime() + ms).toISOString());
    seen.add(`${resolved.rotationIndex}:${resolved.responderUserId}`);
  }
  assert.deepEqual([...seen].sort(), ['0:u-ada', '1:u-grace', '2:u-linus', '3:u-ada']);
});

// ---------------------------------------------------------------------------
// Overrides
// ---------------------------------------------------------------------------
const override = (id, userId, startOffset, endOffset) => ({
  id, replacementUserId: userId, replacementDisplayName: userId,
  startsAt: at(startOffset), endsAt: at(endOffset)
});

test('an active override wins over the rotation without rewriting it', () => {
  const overrides = [override('ov-1', 'u-cover', DAY, 3 * DAY)];
  const during = resolveOnCall({ schedule: { ...weekly, enabled: true }, participants: PARTICIPANTS, overrides }, at(2 * DAY));
  assert.equal(during.resolved, true);
  assert.equal(during.source, 'OVERRIDE');
  assert.equal(during.overrideId, 'ov-1');
  assert.equal(during.responderUserId, 'u-cover');
  // The rotation is untouched and still reports what it would have done.
  assert.equal(during.rotationResponderUserId, 'u-ada');
  assert.equal(resolveRotation(weekly, PARTICIPANTS, at(2 * DAY)).responderUserId, 'u-ada');

  const after = resolveOnCall({ schedule: { ...weekly, enabled: true }, participants: PARTICIPANTS, overrides }, at(4 * DAY));
  assert.equal(after.source, 'ROTATION', 'the normal rotation resumes when the override expires');
  assert.equal(after.responderUserId, 'u-ada');
});

test('override windows are half-open and validated', () => {
  const overrides = [override('ov-1', 'u-cover', DAY, 3 * DAY)];
  assert.equal(selectActiveOverride(overrides, at(DAY))?.id, 'ov-1', 'start is inclusive');
  assert.equal(selectActiveOverride(overrides, at(3 * DAY)), undefined, 'end is exclusive');
  assert.equal(selectActiveOverride(overrides, at(DAY - 1)), undefined);
  assert.equal(overridesOverlap({ startsAt: at(DAY), endsAt: at(3 * DAY) }, { startsAt: at(2 * DAY), endsAt: at(4 * DAY) }), true);
  assert.equal(overridesOverlap({ startsAt: at(DAY), endsAt: at(3 * DAY) }, { startsAt: at(3 * DAY), endsAt: at(4 * DAY) }), false, 'touching windows do not overlap');
  assert.equal(overridesOverlap({ startsAt: at(DAY), endsAt: at(3 * DAY) }, { startsAt: at(0), endsAt: at(DAY) }), false);
});

test('overlapping overrides resolve deterministically instead of ambiguously', () => {
  const overlaps = [
    override('ov-late-long', 'u-late', 2 * DAY, 9 * DAY),
    override('ov-early-short', 'u-early', DAY, 3 * DAY),
    override('ov-early-long', 'u-early-long', DAY, 8 * DAY)
  ];
  // Earliest start wins; then the longest-running; then the smallest id.
  assert.equal(selectActiveOverride(overlaps, at(2 * DAY + HOUR)).replacementUserId, 'u-early-long');
  assert.equal(selectActiveOverride([overlaps[0], overlaps[1]], at(2 * DAY + HOUR)).replacementUserId, 'u-early');
  assert.equal(selectActiveOverride([override('b', 'u-b', DAY, 5 * DAY), override('a', 'u-a', DAY, 5 * DAY)], at(2 * DAY)).replacementUserId, 'u-a');
  assert.equal(selectActiveOverride([], at(DAY)), undefined);
});

test('schedule state gates resolution', () => {
  const context = { participants: PARTICIPANTS, overrides: [] };
  assert.equal(resolveOnCall({ ...context, schedule: null }, at(DAY)).reason, 'SCHEDULE_MISSING');
  assert.equal(resolveOnCall({ ...context, schedule: { ...weekly, enabled: false } }, at(DAY)).reason, 'SCHEDULE_DISABLED');
  assert.equal(resolveOnCall({ schedule: { ...weekly, enabled: false }, participants: PARTICIPANTS, overrides: [override('ov-1', 'u-cover', 0, 5 * DAY)] }, at(DAY)).reason, 'SCHEDULE_DISABLED',
    'a disabled schedule resolves nobody, even with an override');
  assert.equal(resolveOnCall({ ...context, schedule: { ...weekly, enabled: true } }, at(DAY)).reason, 'ROUTED');
  assert.equal(resolveOnCall({ schedule: { ...weekly, enabled: true }, participants: [], overrides: [] }, at(DAY)).reason, 'NO_PARTICIPANTS');
});

// ---------------------------------------------------------------------------
// Routing rule precedence
// ---------------------------------------------------------------------------
const rule = (id, priority, conditions = {}, extra = {}) => ({
  id, priority, enabled: true, createdAt: '2026-01-01T00:00:00.000Z',
  matchServiceId: null, matchSource: null, matchSeverities: [], ...conditions, ...extra
});

test('rule ordering is explicit and never depends on row order', () => {
  const shuffled = [rule('r-b', 100), rule('r-a', 10), rule('r-c', 100)];
  assert.deepEqual(sortRoutingRules(shuffled).map((r) => r.id), ['r-a', 'r-b', 'r-c'],
    'priority ascending, then creation time, then id');
  const samePriority = [rule('z', 5), rule('a', 5), rule('m', 5)];
  assert.deepEqual(sortRoutingRules(samePriority).map((r) => r.id), ['a', 'm', 'z'], 'ties break on id');
  const byCreated = [
    { ...rule('late', 5), createdAt: '2026-05-01T00:00:00.000Z' },
    { ...rule('early', 5), createdAt: '2026-02-01T00:00:00.000Z' }
  ];
  assert.deepEqual(sortRoutingRules(byCreated).map((r) => r.id), ['early', 'late'], 'ties break on creation time before id');
});

test('rule matching is exact, case-folded and has no expression language', () => {
  const alert = { source: 'grafana-webhook', severity: 'critical', serviceId: 'svc-1' };
  assert.equal(ruleMatches(rule('any', 1), alert), true, 'a rule with no conditions matches everything');
  assert.equal(ruleMatches(rule('svc', 1, { matchServiceId: 'svc-1' }), alert), true);
  assert.equal(ruleMatches(rule('svc-other', 1, { matchServiceId: 'svc-2' }), alert), false);
  assert.equal(ruleMatches(rule('src', 1, { matchSource: 'GRAFANA-WEBHOOK' }), alert), true, 'source matching is case-insensitive');
  assert.equal(ruleMatches(rule('src-padded', 1, { matchSource: '  grafana-webhook  ' }), alert), true);
  assert.equal(ruleMatches(rule('src-other', 1, { matchSource: 'prometheus' }), alert), false);
  assert.equal(ruleMatches(rule('sev', 1, { matchSeverities: ['CRITICAL', 'page'] }), alert), true);
  assert.equal(ruleMatches(rule('sev-other', 1, { matchSeverities: ['warning'] }), alert), false);
  assert.equal(ruleMatches(rule('sev-empty', 1, { matchSeverities: [] }), alert), true, 'empty severities match any severity');
  assert.equal(ruleMatches(rule('disabled', 1, { enabled: false }), alert), false, 'disabled rules never match');
  // Wildcard-ish and hostile values are treated as literal text, never as syntax.
  assert.equal(ruleMatches(rule('star', 1, { matchSource: '*' }), alert), false);
  assert.equal(ruleMatches(rule('regex', 1, { matchSource: '.*' }), alert), false);
  assert.equal(ruleMatches(rule('proto', 1, { matchSource: '__proto__' }), { ...alert, source: '__proto__' }), true);
});

test('the first matching rule in deterministic order wins', () => {
  const alert = { source: 'grafana-webhook', severity: 'critical', serviceId: 'svc-1' };
  const rules = [
    rule('specific', 10, { matchServiceId: 'svc-1', matchSeverities: ['critical'] }),
    rule('catch-all', 900),
    rule('also-matches', 50, { matchSource: 'grafana-webhook' })
  ];
  assert.equal(selectRoutingRule(rules, alert).id, 'specific');
  assert.equal(selectRoutingRule([...rules].reverse(), alert).id, 'specific', 'input order is irrelevant');
  assert.equal(selectRoutingRule([rule('catch-all', 900)], alert).id, 'catch-all');
  assert.equal(selectRoutingRule([rule('off', 1, { enabled: false }), rule('on', 2)], alert).id, 'on');
  assert.equal(selectRoutingRule([], alert), null, 'no rules means no match');
  assert.equal(selectRoutingRule([rule('other-service', 1, { matchServiceId: 'svc-9' })], alert), null);
  assert.equal(selectRoutingRule([rule('other-source', 1, { matchSource: 'nagios' })], alert), null);
});
