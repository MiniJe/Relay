# Relay 0.2 — Alert Routing & On-Call Foundation

Release 0.2 turns Relay's durable alert intake into a routing system with an
answer to the only question that matters at 03:00: **who is responsible right
now?**

This document describes Relay 0.2 as a two-milestone release. **RLY-0.2-M-001**
provides alert routing and on-call foundations. **RLY-0.2-M-002** adds escalation
policy definitions, policy snapshots and the initial durable-delivery schema.
M-002 remains in progress: provider delivery execution, restart-safe worker
processing, and the operational UI/qualification are not yet complete. Relay
0.2 must not be described as functionally complete until those gates pass.

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

## Milestone RLY-0.2-M-001 — implemented

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

## Milestone RLY-0.2-M-002 — in progress

The repository now contains first-class organization-scoped policy/step storage,
REST policy CRUD, rule channel/policy configuration, deterministic validation
and due-time calculation, policy/schedule snapshot materialization, and the
additive `003_escalation_delivery.sql` schema for escalation jobs, delivery
outbox rows and attempt audit. These are foundations, not a claim that the M-002
acceptance criteria have passed. Durable enqueue-and-dispatch, worker leasing
and recovery, Slack/SMTP adapters, delivery APIs, acknowledgement-driven job
cancellation, and alert/escalation operational surfaces still require
implementation and PostgreSQL/production/browser qualification.

## Beyond Relay 0.2
The following are deliberately future work, not Relay 0.2 release blockers and
must not be implemented as part of M-002:

- SMS paging, phone-call paging and native push notifications;
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
