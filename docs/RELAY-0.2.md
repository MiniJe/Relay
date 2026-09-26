# Relay 0.2 — Alert Routing & On-Call Foundation

Release 0.2 turns Relay's durable alert intake into a routing system with an
answer to the only question that matters at 03:00: **who is responsible right
now?**

This document describes Relay 0.2 as a two-milestone release:

- **M-001 — Alert Routing & On-Call Foundation**;
- **M-002 — Escalation, Multi-Channel Paging & Durable Delivery**.

Relay 0.2 functional implementation is complete pending Founder integration and
release qualification. "Complete" here means the implementation and its
verification are finished in this repository — every acceptance criterion is
exercised by tests, real-PostgreSQL worker qualification, a production
deployment check and a real-browser pass. It does not mean the release has been
integrated by the Founder or tagged.

## Release purpose

Relay 0.1 proved the incident loop. Relay 0.2 proves the loop *upstream* of the
incident:

```text
Incoming Alert
      ↓
Routing Rules          (org-scoped, explicit priority, first match wins)
      ↓
On-Call Schedule       (team + IANA timezone + deterministic rotation)
      ↓
Current Responder      (rotation, or an active override)
      ↓
Routing Record         (immutable audit trail, one per alert)
      ↓
Durable multi-channel page (Discord, Slack, responder email — M-002 target)
      ↓
No acknowledgement? → Escalation policy (durable, execution-time schedule lookup)
      ↓
Acknowledgement        (authorized responder, first one wins)
      ↓
Incident (optional)    (explicit human escalation only)
```

The invariant that governs the whole milestone:

> **An alert is durable before it is routed.** Routing, schedule resolution and
> notification all happen after the intake transaction commits. A misconfigured
> schedule, a broken webhook or a routing bug can never lose an alert.

## Milestone RLY-0.2-M-001 — Alert Routing & On-Call Foundation

### Responder teams

- organization-scoped responder teams with a name, slug and description;
- team membership restricted to existing organization members;
- membership is idempotent (adding twice is a no-op, not an error);
- a user outside the organization can never be added, at the database level;
- teams expose their member roster and the services they own;
- Services gain an optional owning team, keeping the Service/Component
  separation from 0.1 intact.

### On-call schedules

- a schedule belongs to an organization and a team;
- schedules carry an **IANA timezone** (`Europe/Bucharest`, `UTC`, …) used for
  display, and an absolute rotation anchor used for resolution;
- ordered rotation participants (team members only);
- fixed-duration handoffs expressed unambiguously in **minutes**
  (60 ≤ interval ≤ 525600);
- a schedule can be enabled or disabled without losing its configuration;
- the schedule answers *"who is on call at instant T"* deterministically for any
  T — past, present or future — with no dependence on the server's local
  timezone. See [`ONCALL.md`](./ONCALL.md) for the resolution algorithm and the
  DST policy.

### Overrides

- an override names a replacement responder for a `[startsAt, endsAt)` window,
  with a reason and a recorded creator;
- while an override is active the replacement responder *is* the responder;
  when it ends, the rotation resumes unchanged;
- overlapping overrides for the same schedule are rejected (`OVERRIDE_OVERLAP`),
  serialized per schedule so two concurrent requests cannot both pass the check;
- touching windows are legal because the interval is half-open;
- windows with `startsAt >= endsAt` are rejected.

### Alert routing rules

- organization-scoped rules with a name, enabled flag and an explicit numeric
  priority;
- conditions on **service**, **source** and **severity**; an omitted condition is
  a wildcard, and matching is exact after trimming and case-folding;
- a routing target: an on-call schedule (`targetKind: ONCALL_SCHEDULE`);
- deterministic multi-match resolution: `priority ASC → createdAt ASC → id ASC`,
  first match wins. Two rules with identical configuration always resolve the
  same way;
- rules are never evaluated as code. There is no expression language, no `eval`
  and no user-supplied predicate — conditions are data compared by the server.

### Routing execution

Alert intake was extended, not replaced:

1. receive and authenticate (`x-relay-alert-key`);
2. validate and resolve the organization and optional service identifier;
3. **persist the alert and a `PENDING` routing record in one transaction**, with
   `(organization, source, externalId)` idempotency;
4. evaluate routing rules in deterministic order;
5. resolve the target schedule and the responder on call **at the routing
   instant**;
6. persist the routing result as an immutable audit record;
7. attempt notification over the first channel (Discord).

Steps 4-7 can fail without affecting step 3. A failure is recorded on the
routing record (`resolution`, `notificationStatus`, `notificationError`) and
returned as a warning — the alert is still there and still listable.

### Routing records

Every alert has exactly one routing record, enforced by
`UNIQUE (alert_id)` in PostgreSQL. It stores:

- the matched rule, schedule and team — **by id and by snapshotted name**;
- the resolved responder, whether they came from `ROTATION` or an `OVERRIDE`;
- the rotation/override period the responder was resolved from;
- the resolution outcome, including explicit non-routing outcomes
  (`NO_MATCHING_RULE`, `SCHEDULE_DISABLED`, `ROTATION_NOT_STARTED`,
  `NO_PARTICIPANTS`, `RULE_TARGET_MISSING`, `SCHEDULE_MISSING`);
- notification status, provider, a truncated error and timestamp;
- acknowledgement status and acknowledger;
- the linked incident, if a human escalated the alert.

Because names are snapshotted and foreign keys use `ON DELETE SET NULL`, the
record is a genuine historical fact: renaming a schedule, reordering a rotation
or deleting a rule never rewrites who was actually paged.

### Notification (Discord)

- the existing Discord webhook adapter is the first and only channel;
- a routed alert page includes title, severity, source, service, responder,
  routing path and observed/routed timestamps rendered in the schedule's
  timezone;
- the on-call responder is mentioned when an optional Relay-user → Discord-user
  mapping exists, and falls back to their display name otherwise;
- mapping management is admin-only, per organization, requires no OAuth and
  stores only a public Discord snowflake;
- outbound text is sanitized (angle brackets stripped, `@everyone`/`@here`
  defanged, control characters removed) and `allowed_mentions` is pinned to the
  mapped responder only;
- webhook secrets stay encrypted at rest and never appear in a response, a log
  line or a routing record.

### Acknowledgement

- OWNER, ADMIN and RESPONDER may acknowledge a routed alert; VIEWER and
  non-members are rejected server-side;
- the first acknowledgement wins, taken under a row lock, so concurrent
  acknowledgements cannot both be recorded;
- repeating an acknowledgement is an idempotent no-op reported through
  `alreadyAcknowledged`;
- acknowledging an alert is **not** resolving an incident, and resolving an
  incident does not un-acknowledge an alert. They are separate objects with
  separate lifecycles.

### Alert ≠ Incident

Relay never declares an incident automatically. Escalation is an explicit human
action (`POST /alerts/{alertId}/incidents`) that creates a canonical incident
seeded from the alert's service and records `sourceAlertId` on the incident
timeline and `incidentId` on the routing record. Escalating the same alert twice
returns `409`.

### Determinism and concurrency

- idempotent alert retries reuse the original alert and its routing record and
  never page a responder twice;
- re-evaluation (`POST /alerts/{alertId}/route`) is an explicit operator action,
  and an alert already notified is not re-paged unless `renotify: true` is
  supplied;
- the routing instant is the server clock, never the alert's own timestamp, so a
  delayed or hostile `timestamp` cannot choose the responder;
- uniqueness, ordering and overlap constraints are enforced in the database, not
  only in application code.

### Interface

The operator application gained four surfaces in the existing Quiet Operations
style — no redesign, no new visual language:

- **Alerts** — a compact operational table: severity, title, service, responder,
  routing outcome, notification and acknowledgement state;
- **Teams** — roster management and service ownership;
- **On-call** — "who is on call now" per schedule, the next handoff, upcoming
  handoffs and override management, all rendered in the schedule's timezone;
- **Routing** — rule list ordered by effective priority, with inline create and
  edit.

The dashboard shows an on-call strip and unacknowledged alerts; service detail
shows the owning team; settings expose Discord identity mapping. Every view
respects `prefers-reduced-motion`, is keyboard-operable, and qualifies at
1440×900, 1280×800 and 390×844.

### Permissions

| Capability | OWNER | ADMIN | RESPONDER | VIEWER |
| --- | --- | --- | --- | --- |
| Configure teams, schedules, overrides, rules, Discord mapping | ✅ | ✅ | ❌ | ❌ |
| View on-call state, alerts, routing records | ✅ | ✅ | ✅ | ✅ |
| Acknowledge an alert | ✅ | ✅ | ✅ | ❌ |
| Re-evaluate routing / escalate to incident | ✅ | ✅ | ✅ | ❌ |

Every decision is enforced server-side. The UI hiding a control is a courtesy,
never an authorization boundary.

### Persistence

- new forward migration `packages/database/migrations/002_alert_routing_oncall.sql`;
- migrations are discovered from the migrations directory, sorted by filename
  and applied in order, each in its own transaction with its `schema_migrations`
  row. Nothing is hardcoded to `001`;
- `001_initial.sql` is untouched and a populated 0.1 database upgrades to 0.2
  without rewriting a single 0.1 row;
- both `PostgresStore` and `MemoryStore` implement the same 0.2 contract,
  verified by `tests/postgres.contract.test.mjs`.

### API and documentation

- all new operations are versioned REST under `/api/v1`;
- `/api/v1/openapi.json` documents every new path plus the `AlertRouting`,
  `ScheduleInput`, `OverrideInput` and `RoutingRuleInput` schemas;
- `/api/v1/health` reports version `0.2.0`.

### Verification

- `tests/oncall.test.mjs` — 17 deterministic unit tests for timezone handling,
  rotation maths across handoff boundaries, DST transitions, override precedence
  and rule ordering. The process timezone is pinned to `Pacific/Kiritimati`
  (UTC+14) to prove resolution does not depend on it;
- `tests/routing.integration.test.mjs` — 16 integration tests through the real
  HTTP API covering the pipeline, idempotency, concurrency, notification
  failure, acknowledgement authorization, tenant isolation, RBAC, malformed
  input and public-status leakage;
- `tests/routing.e2e.test.mjs` — one end-to-end journey from ingest key to
  escalated incident;
- `tests/migration-upgrade.test.mjs` — a populated 0.1 database upgraded to 0.2;
- `tests/postgres.contract.test.mjs` — the 0.2 store contract against real
  PostgreSQL;
- all 0.1 tests still pass unchanged.

## Milestone RLY-0.2-M-002 — Escalation, Multi-Channel Paging & Durable Delivery

M-001 answered *who is responsible right now*. M-002 makes the page itself
durable, multi-channel and escalation-aware: a delivery that has been decided is
a persisted row with an attempt history, not an HTTP call made while a request
waits.

### Durable delivery outbox

- routing creates one logical delivery per configured channel in the same
  decision that resolves the responder; the row exists before any provider is
  contacted, so a crash can no longer lose a page;
- an escalation step creates its own deliveries when it executes;
- identity is enforced by partial unique indexes — `(alert, provider)` for the
  immediate page and `(escalation job, provider)` for step pages — so
  re-evaluating routing or replaying intake can never page twice;
- states are explicit and finite: `PENDING`, `IN_FLIGHT`, `RETRYING`, `SENT`,
  `FAILED`, `CANCELLED`;
- the destination is snapshotted from the stored integration and the responder's
  canonical account. Alert content can never choose a URL or a recipient.

### Attempt audit

- every provider call writes one immutable `notification_attempts` row with the
  attempt number, outcome (`SENT`, `RETRYABLE_FAILURE`, `PERMANENT_FAILURE`),
  provider status code, bounded error text, timestamps and — for a manual retry —
  the requesting user;
- attempts are append-only: retrying extends the history instead of rewriting
  it, and the delivery keeps its count, next-attempt instant and last error;
- the compact M-001 routing summary (`notificationStatus`, provider, error) is
  still written next to the routing record, so existing clients keep working.

### Bounded retries and manual retry

- at most three attempts per delivery, at 1 minute and 5 minutes after the
  previous attempt;
- HTTP 408/425/429 and 5xx, timeouts, connection failures and SMTP 4xx retry;
  other HTTP 4xx and SMTP 5xx/authentication failures are permanent; unknown
  failures retry, because a bounded retry beats a silently dropped page;
- `POST /organizations/{organizationId}/deliveries/{deliveryId}/retry` lets an
  OWNER, ADMIN or RESPONDER retry a page that was not delivered; a delivered
  page answers `409`, a cancelled one answers `409`, and both keep their
  history. VIEWER is rejected server-side.

### Worker, leasing and restart recovery

- the server starts the worker only after the store is ready and stops it before
  the pool closes; the deterministic core (`processDueWork`) takes an explicit
  clock and performs no sleeping, which is what the qualification tests drive;
- claims happen in a short transaction using `SELECT … FOR UPDATE SKIP LOCKED`
  followed by an `IN_FLIGHT` lease; **every provider call happens outside any
  transaction**;
- a write must present the matching lease token, so a crashed or stalled worker
  whose lease expired can never overwrite the outcome recorded by the worker
  that recovered the work;
- expired leases are recovered in PostgreSQL at the start of each pass, so a
  restart needs no in-memory state: abandoned pages become claimable again and
  are delivered exactly once;
- `SKIP LOCKED` makes concurrent workers take disjoint sets. The qualification
  test runs four workers over eight due pages and asserts eight provider calls,
  eight single-attempt deliveries and no duplicate attempt rows.

### Escalation execution

- materialized jobs run through the worker; the responder is resolved at
  execution time from the step's schedule, so a rotation that moved on between
  routing and the due instant pages the person who is actually on call;
- a step whose schedule resolves nobody is recorded as unresolved with its
  reason and is never retried into a page for the wrong person;
- `completeEscalationJob` locks the routing row and re-reads the acknowledgement
  inside the same transaction that inserts the step's deliveries, so an
  acknowledgement and a step execution are strictly serialized: either the
  acknowledgement is observed (step cancelled, no page created) or the page was
  already durably created before the acknowledgement committed.

### Acknowledgement-driven cancellation

- the first acknowledgement still wins under a row lock;
- pending steps become `CANCELLED_ACKNOWLEDGED` and can no longer create pages;
- deliveries that have not reached a provider become `CANCELLED`; a page that
  was already sent keeps its status, its attempts and its timestamps;
- an executed step is never rewritten by a later acknowledgement, and
  acknowledging an alert still does not create or resolve an incident.

### Channels: Discord, Slack, SMTP

- **Discord** keeps the M-001 adapter and boundary (Discord HTTPS webhooks,
  mention pinning, `allowed_mentions`);
- **Slack** uses Incoming Webhooks only: `https://hooks.slack.com/services/…`,
  HTTPS, exact host and path, no query string or fragment. Slack bots, slash
  commands, interactive incident management and OAuth are deliberately absent.
  Alert text is sanitized so `<@U…>`, `<!channel>`, `<!here>`, `<!everyone>` and
  `<!subteam^…>` cannot broadcast a mention, and `parse`/`link_names` is never
  sent;
- **Email** pages the responder at their own Relay account address over SMTP via
  `nodemailer` (STARTTLS or implicit TLS, TLS 1.2 minimum, bounded timeouts).
  The recipient is resolved server-side, so alert text can never choose who is
  emailed; CR/LF/NUL are rejected at validation and stripped when the subject or
  `From` header is formatted; SMTP 4xx/5xx and authentication errors are
  classified into the shared retry policy;
- a channel that is not configured, or is disabled, fails closed: the routing
  summary reports `SKIPPED_NO_INTEGRATION`/`SKIPPED_DISABLED`, the delivery is
  terminal with an operator-readable reason, and the page is **never** rerouted
  to a different provider the operator did not choose.

### Secrets

- Slack webhook URLs and the SMTP password are stored with AES-256-GCM and are
  never returned by any read, never logged and never written into a delivery or
  attempt row. SMTP reads report `passwordConfigured` as a boolean only;
- provider errors are truncated and sanitized before they reach a log, an attempt
  or a response, so an error can carry `HTTP 503` but never a token.

### Interface

Five operator surfaces were added in the existing Quiet Operations style:

- **Alert detail** (`/app/alerts/{alertId}`) — routing record, per-channel pages
  with state labels, attempt trails, next attempt, failure reasons, a manual
  retry action where it applies, the escalation plan with per-step state and the
  resolved responder, and acknowledgement state;
- **Escalations** (`/app/escalations`) — due/scheduled and executed/cancelled
  steps for the most recent routed alerts, read from persisted jobs only;
- **Routing** — per-rule channel selection, the attached escalation policy, and
  an ordered policy editor (delay, schedule, channels per step);
- **Settings** — Slack and SMTP configuration, where a stored credential is
  shown as *stored* and never echoed into the form;
- **Alerts** — the M-001 table now links each row to its detail page and keeps
  its four-label summary strip (`Routed`, `Unacknowledged`, `Delivery failed`).

State is always communicated with a text label next to the colour, configuration
controls stay hidden for roles the server would reject anyway, and every view
respects `prefers-reduced-motion` and qualifies at 1440×900, 1280×800 and
390×844.

### Permissions

| Capability | OWNER | ADMIN | RESPONDER | VIEWER |
| --- | --- | --- | --- | --- |
| Configure integrations (Discord, Slack, SMTP), policies, rules, mappings | ✅ | ✅ | ❌ | ❌ |
| Read deliveries, attempts and escalation state | ✅ | ✅ | ✅ | ✅ |
| Retry a failed page manually | ✅ | ✅ | ✅ | ❌ |
| Acknowledge an alert (cancels unsent pages) | ✅ | ✅ | ✅ | ❌ |

### Persistence

- `packages/database/migrations/003_escalation_delivery.sql` was **extended in
  place** rather than superseded by a `004`: the branch carrying it is unmerged,
  so no external environment has applied the earlier revision, and an in-place
  extension keeps the schema readable as one unit. Anything already released
  (000/001/002) is untouched. The migration adds lease/retry/snapshot columns,
  partial lease indexes, the two idempotency unique indexes and the
  `provider_status_code` CHECK;
- `001_initial.sql` and `002_alert_routing_oncall.sql` are unchanged, and a
  populated 0.2 database upgrades to the M-002 schema without rewriting a row
  (`tests/migration-upgrade.test.mjs`);
- `PostgresStore` and `MemoryStore` implement the same delivery/attempt/
  escalation contract; PostgreSQL is the qualification target.

### Verification

- `tests/durable-delivery.test.mjs` — durable enqueue per channel, one immutable
  attempt per call, bounded retries, permanent failures, manual-retry history,
  acknowledgement cancellation, Slack/email sanitization and fail-closed
  channels, all through the real HTTP API with injected provider transports (no
  real Discord/Slack/SMTP traffic);
- `tests/providers.test.mjs` — Slack URL validation and payload sanitization,
  SMTP message construction, header-injection rejection, SMTP classification and
  the retry plan;
- `tests/worker.qualification.test.mjs` — real PostgreSQL: disjoint claims under
  four concurrent workers, stale-lease refusal, restart recovery, and
  acknowledgement-versus-escalation ordering;
- `tests/postgres.contract.test.mjs` — schema constraints and the store contract
  (including first-acknowledgement-wins and tenant isolation) on real
  PostgreSQL;
- `scripts/production-e2e.mjs` (`verify:production`, `verify:restart`) — a real
  Docker deployment: delivery audit, attempt history, manual-retry semantics and
  the escalation read model, then the same records re-verified after a container
  restart, including that a delivered page is never re-sent;
- `scripts/browser-smoke.mjs` (`verify:browser`) — a real browser at three
  viewports: alert detail, escalations, routing channels, the policy editor and
  the integration settings, plus the existing boot, MIME, keyboard, dialog,
  responsive and reduced-motion contracts;
- `scripts/verify-release-surface.mjs` (`verify:surface`) — the published
  OpenAPI document, the shipped SPA routes/hooks and the pinned notification and
  delivery status enums agree with the source tree.

## Beyond Relay 0.2
The following are deliberately future work, not Relay 0.2 release blockers and
must not be implemented as part of M-002:

- SMS paging, phone-call paging and native push notifications (only Discord,
  Slack Incoming Webhooks and SMTP email are in scope for 0.2);
- a native mobile application;
- complex follow-the-sun/layered schedules, weighted/fractional rotations and
  self-service shift swaps;
- Google Calendar synchronization and calendar import;
- advanced alert correlation, ML grouping and flapping detection;
- sophisticated silencing/maintenance windows;
- SSO/SAML/SCIM and granular enterprise RBAC;
- Relay Cloud, billing, multi-region operation and a Kubernetes operator.

## Explicitly not implemented (product-wide non-goals)

Relay 0.2 does not include, and no milestone in this release may add:

- monitoring, metrics, logs or tracing backends — Relay is not a telemetry store;
- PagerDuty/Opsgenie/VictorOps feature parity;
- machine-learning alert correlation, anomaly detection, AI investigation or
  autonomous remediation;
- MCP servers, GitOps controllers, Terraform providers or infrastructure clients;
- a JavaScript/`eval`-based or otherwise user-programmable rule engine;
- native mobile applications;
- incident replay or dependency-failure propagation;
- custom public status domains or themes beyond 0.1 branding.

## Release invariants

Two invariants govern this release and must survive every future change:

1. **Alert durability precedes routing.** No routing, schedule or notification
   failure may prevent an accepted alert from being stored and listed.
2. **The public boundary never widens.** On-call rosters, responder identities,
   routing rules, schedules, timezones and Discord mappings are internal
   operational data. The public status page presents canonical incident data
   only, and none of the above may appear in a public response.

## Prepared boundaries

Without implementing future scope, 0.2 preserves extension points for:

- additional notification providers through the existing integration adapter and
  the `notificationProvider` column;
- escalation policies through `alert_routings.notification_status` plus an
  explicit re-notification path;
- richer rotations through the ordered `oncall_schedule_participants` table;
- additional rule targets through the `target_kind` enum;
- a future audit log separate from routing-record semantics;
- CLI/MCP/bot clients through the same versioned REST operations the UI uses.
