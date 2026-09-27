# Relay On-Call & Alert Routing

This document is the authoritative description of how Relay 0.2 answers
*"who is responsible for this alert?"*. It exists because an on-call system that
cannot be reasoned about is worse than no on-call system: a responder who is
paged unexpectedly, or not paged at all, is an operational failure.

Everything described here is implemented in
[`packages/shared/oncall.mjs`](../packages/shared/oncall.mjs) (pure resolution
maths), [`apps/api/src/routing.mjs`](../apps/api/src/routing.mjs) (pipeline) and
[`packages/database/migrations/002_alert_routing_oncall.sql`](../packages/database/migrations/002_alert_routing_oncall.sql)
(constraints).

---

## 1. The model

```text
Organization
 ├── Responder Team ──── members (organization members only)
 │        └── owns Services
 ├── On-Call Schedule ── team + IANA timezone + rotation anchor + interval
 │        ├── ordered participants (team members)
 │        └── overrides (temporary replacement windows)
 └── Routing Rule ────── conditions (service / source / severity)
          └── target: an On-Call Schedule
```

- **Team** — who can be on call. Membership is a subset of organization
  membership; it is not an authorization role.
- **Schedule** — how responsibility moves between team members over time.
- **Override** — a named human taking a specific window, temporarily.
- **Routing rule** — which alerts go to which schedule.
- **Routing record** — what actually happened, kept forever.

A Service may name an owning team (`ownerTeamId`). This is an ownership
annotation used for orientation and for routing rules that match on service; it
does not change the Service/Component separation from Relay 0.1.

---

## 2. Rotation resolution

Relay implements **fixed-duration rotations**. There is exactly one rotation
type, and it is defined by three values:

| Field | Meaning |
| --- | --- |
| `rotationStartsAt` | An absolute instant (stored as `timestamptz`) anchoring every handoff boundary. |
| `rotationIntervalMinutes` | Handoff length in whole minutes. `60 ≤ interval ≤ 525600`. `1440` = daily, `10080` = weekly. |
| `participants[]` | Ordered list of team members, each with a stable `position` (0-based). |

### The formula

For an instant `T`:

```text
elapsed = T - rotationStartsAt                (absolute milliseconds, signed)
index   = floor(elapsed / intervalMillis)
position = ((index mod N) + N) mod N          (N = participant count)
responder = participants[position]

periodStartsAt = rotationStartsAt + index * intervalMillis
periodEndsAt   = rotationStartsAt + (index + 1) * intervalMillis
```

The period is **half-open**: `[periodStartsAt, periodEndsAt)`. At exactly
`periodEndsAt` the next participant is already on call. There is no instant that
belongs to two periods and no instant that belongs to none.

If `T < rotationStartsAt` the schedule resolves to nothing and reports
`ROTATION_NOT_STARTED`. Relay never guesses a responder for a time before the
rotation exists. If the schedule has no participants it reports
`NO_PARTICIPANTS`.

### Why `intervalMinutes` and not "daily"/"weekly"

Handoff length is expressed in minutes rather than in calendar units because
calendar units are ambiguous. "One week" across a daylight-saving transition is
167 or 169 hours of wall-clock time depending on the zone and the direction of
the change. A minute is always 60 seconds. Expressing the interval in minutes
makes the arithmetic total, exact and independent of any calendar.

### Determinism guarantees

The same `(rotationStartsAt, rotationIntervalMinutes, participants, T)` always
produces the same responder:

- the computation uses only absolute UTC instants — no `Date#getHours`, no local
  calendar arithmetic, no locale formatting;
- the server's `TZ` environment variable and OS timezone have **no effect**. The
  test suite pins the process timezone to `Pacific/Kiritimati` (UTC+14, the
  earliest zone on Earth) and asserts identical results;
- participants are sorted by their stored `position`, never by database row
  order, query plan or insertion timing;
- resolution is a pure read. It never mutates the schedule, and answering "who
  is on call at T" for a past or future T is exactly as valid as for now.

Resolving multiple handoffs into the past or future is just a larger `index`;
the formula is O(1) regardless of how many cycles have elapsed.

---

## 3. Timezone semantics

Every schedule carries an **IANA timezone identifier** (`Europe/Bucharest`,
`America/New_York`, `UTC`). It is validated on write with `isValidTimeZone`:
the value must look like an IANA `Area/Location` identifier (or be exactly
`UTC`) *and* be understood by the runtime's `Intl` implementation. Anything else
is rejected with `INVALID_TIMEZONE` (HTTP 400). This rejects `Local`, `GMT+3`,
`Europe/Bucharest; DROP TABLE users`, empty strings and over-long values before
they reach any formatter or query.

The timezone is used for exactly two things:

1. **Presenting instants to humans.** Handoff boundaries, override windows and
   alert timestamps are rendered in the schedule's zone, always with an explicit
   offset label so a rendered wall clock can never be mistaken for the viewer's
   local time:

   ```text
   2026-03-29 09:00 UTC+02:00     (before a spring-forward)
   2026-03-29 10:00 UTC+03:00     (after it)
   2026-09-26 14:03 UTC           (a zero offset reads as plain UTC)
   ```

2. **Recording operator intent.** A team in Bucharest configures
   `Europe/Bucharest` so that the interface speaks their time.

The timezone is deliberately **not** used for period arithmetic. That is the
single most important design decision in this file, and the next section states
its consequences plainly.

---

## 4. Daylight saving time — explicit contract

**Handoff instants are anchored to absolute UTC time. They do not move when a
timezone's offset changes.**

Concretely, for a daily rotation anchored at `2026-03-28T07:00:00Z` with
participants in `Europe/Bucharest`:

| Handoff | UTC instant | Bucharest wall clock |
| --- | --- | --- |
| k | 2026-03-28 07:00 | 09:00 (UTC+02:00) |
| k+1 | 2026-03-29 07:00 | 10:00 (UTC+03:00) ← spring forward |
| k+2 | 2026-03-30 07:00 | 10:00 (UTC+03:00) |

The rotation is unaffected: every cycle is exactly 24 hours, no cycle is skipped
and no cycle is duplicated. What changes is the **local wall-clock time at which
the handoff appears**. On the day Bucharest springs forward, a 09:00 local
handoff becomes a 10:00 local handoff and stays there until the clocks fall back
in October, when it returns to 09:00.

This is a deliberate trade-off, and both alternatives were rejected:

| Policy | Behaviour across DST | Verdict |
| --- | --- | --- |
| **UTC-anchored (chosen)** | Handoff *duration* is always exact. Local handoff *time* shifts by one hour twice a year. | Total, predictable, testable. |
| Wall-clock anchored | Local handoff time is always 09:00, but the spring-forward cycle is 23 hours and the fall-back cycle is 25 hours. | Requires calendar arithmetic; a 23-hour shift is invisible in an audit record. |
| "Skip the ambiguous hour" | Undefined behaviour for zones where a handoff lands inside a skipped or repeated hour. | Non-deterministic; rejected outright. |

Operators who need a handoff at a fixed *local* time year-round should set the
rotation anchor and, twice a year, adjust `rotationStartsAt` by the DST delta.
Relay will not do this silently, because a silent change to who is on call is
exactly the failure mode an on-call system must never have.

**Fall-back (repeated local hour).** Because arithmetic is on absolute instants,
the repeated local hour simply contains two different UTC instants and the
rotation crosses it normally. No period is repeated and no responder serves
twice.

The test suite exercises a four-week window across the 2026 `Europe/Bucharest`
spring-forward transition and asserts that no handoff is skipped, no handoff is
duplicated, and the participant index advances by exactly one per cycle.

---

## 5. Overrides

An override says: *"for this window, this person is the responder."*

```text
replacementUserId  — must be a member of the organization
startsAt, endsAt   — half-open window [startsAt, endsAt), startsAt < endsAt
reason             — free text, shown to operators
createdByUserId    — recorded; an override is an attributable human action
```

Rules:

- **Precedence.** While an override covers instant `T`, the override's
  replacement is the responder. The rotation is still computed and is reported
  alongside (`rotationResponderUserId`) so the UI can show who *would* have been
  on call, but it does not decide anything.
- **Resumption.** Resolving an override never mutates the rotation. The moment
  `T >= endsAt`, the rotation resumes exactly where the formula says it should,
  with no catch-up, no skipped participant and no realignment.
- **Overlap.** Overlapping overrides for the same schedule are rejected with
  `OVERRIDE_OVERLAP` (HTTP 409). The check runs inside a transaction that locks
  the schedule row (`SELECT … FOR UPDATE`), so two concurrent requests cannot
  both observe a clean schedule and both insert.
- **Touching windows are legal.** `[10:00, 12:00)` and `[12:00, 14:00)` do not
  overlap, because the interval is half-open.
- **Deterministic tie-break.** If overlapping overrides nevertheless exist
  (legacy data, a manual database edit), selection is still total and
  reproducible: earliest `startsAt`, then longest window, then lexicographically
  smallest `id`. The answer never depends on row order.
- **Validity.** `startsAt >= endsAt` is rejected; the replacement must be an
  organization member; deleting an override is admin-only.

---

## 6. Routing rules

A rule maps alerts to a schedule.

```text
name              — operator-facing label
enabled           — disabled rules are never evaluated
priority          — integer 0..100000; lower wins
matchServiceId    — exact service id, or null = any service
matchSource       — exact source string, or null = any source
matchSeverities[] — list of accepted severities, or empty = any severity
targetKind        — ONCALL_SCHEDULE (the only target kind in 0.2)
targetScheduleId  — the schedule to resolve
```

### Matching

A condition that is `null` (or, for severities, an empty list) is a **wildcard**.
Comparison is exact after trimming and lower-casing both sides, so
`Synthetic-Monitor` matches `synthetic-monitor`.

There is no wildcard syntax, no regex, no glob and no expression language. A
`matchSource` of `*` matches only an alert whose source is literally `*`. Rules
are data compared by the server, never code evaluated by it — a hostile alert
payload cannot change how a rule behaves, only whether it matches.

### Ordering and selection

```text
sort by: priority ASC → createdAt ASC → id ASC
select:  the first rule that matches
```

`priority` is the operator's explicit intent. `createdAt` and `id` are
tie-breakers that make the order **total**, so two identically-configured rules
still resolve the same way on every request, on every replica, forever. Ordering
never depends on database row order, query planner choices or insertion timing.

If no rule matches, the alert is stored with resolution `NO_MATCHING_RULE`. That
is a recorded outcome, not a silent drop.

---

## 7. The routing pipeline

Alert intake in Relay 0.2 runs these stages in order:

```text
1. receive            POST /api/v1/alerts with x-relay-alert-key
2. validate           organization slug, source, title, severity, service id
3. persist            alert + PENDING routing record, ONE transaction
4. evaluate rules     deterministic order, first match wins
5. resolve schedule   enabled? participants? rotation started?
6. resolve responder  override, else rotation, at the routing instant
7. persist result     immutable audit record with snapshotted names
8. notify             Discord (one attempt), outcome recorded
```

### Stage 3 is the durability boundary

The alert and a `PENDING` routing record are committed together **before** any
evaluation happens. Stages 4-8 may fail for any reason — a deleted schedule, an
empty rotation, a malformed timezone in legacy data, a Discord outage — and the
alert remains stored, listed and queryable. A failure is recorded on the routing
record and returned to the caller as a warning:

```json
{ "code": "ALERT_NOTIFICATION_FAILED",
  "message": "The alert was routed but the notification could not be delivered." }
```

### The routing instant

Stage 6 resolves the responder **at the moment routing runs** (the server
clock), not at the alert's own `timestamp`/`observedAt`.

This is a security decision as much as a correctness one. Alerts arrive late —
a monitoring system with a stuck queue can deliver an alert hours after it was
observed. Paging whoever was on call six hours ago pages the wrong person. Worse,
`observedAt` is attacker-controlled input: using it to choose the responder would
let anyone who can post an alert decide which employee gets paged. The observed
timestamp is stored and displayed; it never selects a responder.

An explicit human re-evaluation (`POST /alerts/{alertId}/route`) re-runs stages
4-8 at the current instant, which is what an operator means by "route this
again".

### Idempotency

Alerts are deduplicated on `(organizationId, source, externalId)`. A replay:

- returns the original alert with `duplicate: true`;
- reuses the original routing record — `UNIQUE (alert_id)` in PostgreSQL makes a
  second record impossible, even under concurrent delivery;
- **does not notify again.** A responder is never paged twice for the same
  external event by accident. Re-notification requires an explicit
  `renotify: true` on the `route` endpoint from an authorized human.

Eight concurrent deliveries of the same alert were verified to produce exactly
one alert row, one routing record and one Discord page.

---

## 8. Resolution outcomes

Every routing record carries a `resolution`. All values are explicit; none of
them mean "we lost it".

| Resolution | Meaning | Notified |
| --- | --- | --- |
| `PENDING` | Committed with the alert, evaluation not yet finished. | no |
| `ROUTED` | A rule matched, a schedule resolved, a responder was found. | yes |
| `NO_MATCHING_RULE` | No enabled rule matched the alert. | no |
| `RULE_TARGET_MISSING` | The matched rule's target schedule no longer exists. | no |
| `SCHEDULE_MISSING` | The schedule could not be read. | no |
| `SCHEDULE_DISABLED` | The schedule is disabled by an operator. | no |
| `ROTATION_NOT_STARTED` | The queried instant precedes `rotationStartsAt`. | no |
| `NO_PARTICIPANTS` | The rotation has no participants. | no |

Notification outcomes are recorded separately, so "routed but not delivered" is
distinguishable from "not routed":

| `notificationStatus` | Meaning |
| --- | --- |
| `NOT_ATTEMPTED` | Routing did not reach a responder. |
| `SENT` | The channel accepted the message; `notifiedAt` is set. |
| `FAILED` | Delivery was attempted and failed; `notificationError` holds a truncated, secret-free message. |
| `SKIPPED_NO_INTEGRATION` | No Discord integration is configured for the organization. |
| `SKIPPED_DISABLED` | The Discord integration exists but is disabled. |
| `SKIPPED_NO_RESPONDER` | Nothing to page. |

Relay 0.2 makes **one** delivery attempt. There is no retry queue. A `FAILED`
record is visible in the Alerts table and the routing audit, and an operator can
re-page explicitly with `route` + `renotify`. Silent background retries that
page a human being an unknown number of times is a worse failure mode than a
visible, actionable `FAILED`.

---

## 9. Notification content (Discord)

The routed-alert page is an embed containing the operational facts and nothing
else:

| Field | Content |
| --- | --- |
| Title | `Alert routed — <alert title>` |
| Severity | the alert's severity string |
| Source | the alert's source |
| Service | resolved service name, or `Unassigned` |
| Routed via | `<rule name> → <schedule name> → <team name>` |
| On call | `<@snowflake> Display Name` when a mapping exists, else `Display Name` |
| Observed | observed instant rendered in the schedule timezone |
| Routed | routing instant rendered in the schedule timezone |

Safety properties:

- outbound text passes through `sanitizeDiscordText`: angle brackets are
  stripped (so alert text cannot forge embeds, mentions or markdown),
  `@everyone` and `@here` are defanged, and control characters are removed;
- `allowed_mentions` is pinned to `{ parse: [], users: [<mapped id>] }`. An alert
  title can never cause a role ping;
- the webhook URL is encrypted at rest with AES-256-GCM and validated against
  `discord.com`/`discordapp.com` over HTTPS on write;
- the secret never appears in an API response, a log line, a routing record or
  an error message. On delivery failure only `error.message` is logged;
- the Discord mapping stores a public snowflake, requires no OAuth, and is
  admin-only per organization. Without a mapping the responder is named in plain
  text and the page is still delivered.

---

## 10. Acknowledgement

- **Who.** OWNER, ADMIN and RESPONDER of the alert's organization. VIEWER and
  non-members are rejected server-side with 403. Hiding the button in the UI is
  a courtesy, never the control.
- **First wins.** The acknowledgement is taken under a row lock
  (`SELECT … FOR UPDATE`), so concurrent acknowledgements cannot both be
  recorded. Exactly one caller observes `alreadyAcknowledged: false`.
- **Idempotent.** Re-acknowledging returns the unchanged record with
  `alreadyAcknowledged: true`. It is not an error and it does not reassign the
  acknowledgement to the second person.
- **Not resolution.** Acknowledging an alert means *"a human has seen this"*. It
  does not create an incident, does not resolve one, and resolving an incident
  does not un-acknowledge an alert. They are separate objects with separate
  lifecycles and separate audit trails.
- **Pre-0.2 alerts.** An alert row with no routing record cannot be
  acknowledged; the API returns `ROUTING_NOT_EVALUATED` (409) and points the
  operator at explicit re-evaluation rather than fabricating a routing decision.

---

## 11. Routing records are historical facts

A routing record snapshots the **names** of the rule, schedule and team that were
in effect, in addition to their identifiers. Foreign keys to those objects use
`ON DELETE SET NULL`.

Consequences:

- renaming a schedule, team or rule does not rewrite history;
- deleting a rule nulls `ruleId` but preserves `ruleName`;
- advancing the rotation changes who is on call *now* and never changes who was
  paged *then*;
- the record answers "why was Ada paged at 03:12 on the 14th?" the same way a
  year later as it did that morning.

The audit trail is queryable at `GET /organizations/{id}/routings`.

---

## 12. Operator guide

### Setting up on-call from scratch

1. **Create a team** (Teams → New team) and add the responders who will rotate.
   Only existing organization members can be added.
2. **Create a schedule** (On-call → New schedule): pick the team, an IANA
   timezone, a rotation anchor and an interval. `1440` minutes is a daily
   rotation; `10080` is weekly. Order the participants the way you want them to
   rotate — position 0 is on call from the anchor instant.
3. **Point services at the team** (Services → edit → owning team) so rules can
   match on service and operators can see ownership at a glance.
4. **Create a routing rule** (Routing → New rule). Start with a specific rule at
   a low priority number (e.g. `priority: 10` matching your checkout service and
   `critical` severity) and, if you want a safety net, a catch-all rule at a high
   priority number (e.g. `900`) with no conditions. Lower number wins.
5. **Configure Discord** (Settings → Discord) and optionally map responders to
   their Discord user ids so pages actually mention them.
6. **Check the answer.** On-call shows who is on call now, who is next and when
   the next three handoffs happen — in the schedule's timezone.

### Reading the On-call page

- **Now** — the current responder, whether they came from the rotation or an
  override, and the exact period they cover;
- **Next** — the following three handoffs with their UTC instants and local
  renderings;
- **Overrides** — active and upcoming windows with their reason and creator;
- **Not resolving** — the page says why (`SCHEDULE_DISABLED`,
  `ROTATION_NOT_STARTED`, `NO_PARTICIPANTS`) instead of showing a blank or a
  guessed name.

### Choosing a rotation anchor

Set `rotationStartsAt` to the instant you want position 0 to begin, in UTC. A
daily rotation anchored at `07:00Z` hands off at `07:00Z` every day, which is
`09:00` in Bucharest in winter and `10:00` in summer (see §4). Anchoring at a
local-looking time is fine — just remember the anchor is an absolute instant and
the local rendering will move with DST.

---

## 13. Known limitations (0.2)

These are boundaries, not defects, and each is recorded as deferred in
[`RELAY-0.2.md`](./RELAY-0.2.md):

- one rotation type (fixed duration). No weekly layering, no per-person weights,
  no shift swaps, no self-service handover;
- no escalation policies. One responder is paged once; if they do not
  acknowledge, a human must act;
- one notification channel (Discord). No email, SMS, push or Slack;
- one delivery attempt, no retry queue;
- no calendar import/export;
- one rule target kind (an on-call schedule). No webhook or queue targets;
- no alert grouping, correlation, silencing or maintenance windows beyond
  `externalId` idempotency;
- DST shifts the local handoff time rather than the handoff duration (§4).

## Escalation policy definitions (M-002 partial)

Policies are organization scoped and attach to routing rules, not schedules.
Their steps are strictly ordered by position and delay; `afterMinutes` is
measured from the initial route. The current implementation provides policy
configuration and snapshot materialization, but not yet the durable execution
worker or channel delivery completion. See [ESCALATION.md](ESCALATION.md).
