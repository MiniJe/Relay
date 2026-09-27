# Relay Architecture

Covers Release 0.1 (core incident lifecycle) and the Release 0.2 additions
(alert routing and on-call). [`RELAY-0.1.md`](./RELAY-0.1.md) and
[`RELAY-0.2.md`](./RELAY-0.2.md) describe the releases themselves;
[`ONCALL.md`](./ONCALL.md) specifies on-call resolution in full.

## Architectural style

Relay is a modular monolith. A single Node.js runtime serves the REST API, SSE stream, and static web application. PostgreSQL is the production system of record. No Redis or external SaaS is required to run the product.

This is intentionally not a microservice design. The major modules are still separated so future releases can split responsibilities if operational scale justifies it.

Relay 0.2 adds no new process, no queue and no scheduler. Alert routing is a
synchronous pass inside the existing intake request, and on-call resolution is a
pure function over stored configuration. A routing engine that needs a worker
fleet to answer "who is on call now" would not be self-hostable.

## Repository map

```text
apps/api/src/          HTTP/API/auth/security/realtime/integration orchestration
  app.mjs                all versioned REST routes
  routing.mjs            0.2 alert routing pipeline + on-call state assembly
  discord.mjs            Discord webhook adapter (incidents and routed alerts)
apps/web/public/       responsive application + public status UI
packages/shared/       domain state machines and input validation
  domain.mjs             roles, severities, lifecycle transitions, public aggregation
  oncall.mjs             0.2 rotation/override/rule resolution (pure, deterministic)
  validation.mjs         input validators shared by API and tests
  version.mjs            single source of truth for the reported release version
packages/database/     PostgreSQL + verification stores and migrations
  migrations/001_initial.sql              Release 0.1 schema (immutable)
  migrations/002_alert_routing_oncall.sql Release 0.2 forward migration
  sql.mjs                                 migration discovery/ordering/statement split
tests/                 unit, API integration, E2E and PostgreSQL contract tests
docs/                  architecture, API, security and release documentation
```

## Canonical incident model

`incidents` is the only incident concept. Both the authenticated incident workspace and public status surfaces read from the same incident record and its linked entities.

An incident owns or links:

- severity and lifecycle state;
- creator and optional commander;
- affected internal services;
- affected public components;
- responders;
- timeline events;
- internal/public updates;
- resolution timestamp;
- optional postmortem.

Public rendering explicitly filters out internal updates and the internal timeline.

## Service vs Component

A Service is an internal technical system. A Component is a customer-visible status object. `component_services` is a many-to-many mapping; Relay does not assume a service and a public component are the same thing.

## Public status derivation

A component has a configured operational state. Active incidents affecting that component derive a temporary incident state from severity:

- SEV1 -> MAJOR_OUTAGE
- SEV2 -> PARTIAL_OUTAGE
- SEV3 / SEV4 -> DEGRADED_PERFORMANCE

The effective state is the worst of configured and incident-derived state. Resolving the incident therefore restores the component to its configured state without duplicating incident truth in a separate status model.

## Persistence

PostgreSQL is the permanent source of truth. `001_initial.sql` creates all Release 0.1 tables and constraints; `002_alert_routing_oncall.sql` adds the Release 0.2 routing and on-call schema. `schema_migrations` tracks applied migrations.

Migrations are **discovered, not hardcoded**. `packages/database/sql.mjs` reads
the migrations directory, filters to `NNN_name.sql`, and sorts by numeric prefix
then name, so adding `003_*.sql` in a future release requires no code change.
Each migration runs in its own transaction together with its `schema_migrations`
row: a failure leaves the database at the last fully-applied migration rather
than half-migrated. `001_initial.sql` is never edited, and a populated 0.1
database upgrades to 0.2 without rewriting a single 0.1 row
(`tests/migration-upgrade.test.mjs` proves this against real PostgreSQL).

Release 0.2 pushes correctness into the database rather than relying on
application discipline:

- `UNIQUE (alert_id)` on `alert_routings` — one routing record per alert, so an
  idempotent retry or a concurrent delivery cannot produce a second decision;
- composite foreign keys (`organization_id, id`) throughout — a schedule cannot
  reference another organization's team, a participant cannot reference another
  organization's membership;
- `ON DELETE SET NULL` from routing records to rules/schedules/teams/users —
  deleting configuration never erases an audit trail;
- CHECK constraints on rotation interval bounds, override window ordering,
  routing resolution/notification enums, rule priority range and target kind,
  and the Discord snowflake format;
- `SELECT … FOR UPDATE` for acknowledgement and override creation, so
  first-wins and no-overlap hold under concurrency.

The in-memory store implements the same application contract only for deterministic tests and explicit `RELAY_STORE=memory` verification mode. It is never selected automatically in production. Both stores are held to the same 0.2 contract by `tests/postgres.contract.test.mjs`.

## Authentication and authorization

Local users authenticate with email/password. Passwords are scrypt hashed. Login creates an opaque random session token; only SHA-256 of the token is persisted. The browser receives the raw token in an HttpOnly, SameSite=Lax cookie.

Every organization-scoped API route resolves membership server-side before reading or mutating tenant data. Roles:

- OWNER: full authority.
- ADMIN: configuration and incident authority.
- RESPONDER: incident coordination/publication authority, plus alert acknowledgement and explicit escalation.
- VIEWER: read-only organization access.

Release 0.2 reuses these four roles rather than introducing an on-call-specific
permission model. Configuration of teams, schedules, overrides, routing rules
and Discord identity mapping is OWNER/ADMIN; viewing on-call state and routing
records is any member; acknowledging and escalating is OWNER/ADMIN/RESPONDER.
Team membership is an operational annotation, never a grant of authority.

## Realtime

`GET /api/v1/organizations/:id/events` exposes Server-Sent Events. Incident mutations publish organization-scoped refresh events; Relay 0.2 adds `alert.routed` and `alert.acknowledged`. The hub is process-local, appropriate to the single-process modular-monolith deployment.

A future horizontally scaled deployment can replace the event hub with Redis/pub-sub or another broker without changing API/domain contracts.

## Integration boundary

Integrations are provider adapters. Release 0.1 implements Discord webhooks, and Release 0.2 reuses the same adapter as the first alert notification channel instead of adding a parallel one. Webhook URLs are encrypted with AES-256-GCM using `INTEGRATION_ENCRYPTION_KEY`; API reads never return encrypted secret material.

Discord delivery occurs after the incident or alert transaction commits. An external Discord outage cannot roll back incident or alert truth; the API reports a delivery warning while keeping the authoritative action successful, and the routing record stores `notificationStatus: FAILED` with a truncated, secret-free error.

Outbound alert text is sanitized before delivery (`sanitizeDiscordText`: angle
brackets stripped, `@everyone`/`@here` defanged, control characters removed) and
`allowed_mentions` is pinned to the mapped responder, so alert content supplied
by a third-party monitoring system can never forge a mention or an embed.

A second channel (email, SMS, Slack, …) belongs behind this same adapter
boundary, recorded through the existing `notificationProvider` column.

## Alert intake and routing

`POST /api/v1/alerts` accepts generic monitor events. Intake is authenticated using a deployment-level key, rate-limited, persisted in PostgreSQL, and idempotent when source + external ID are supplied.

Release 0.2 extends intake into a routing pipeline:

```text
receive → validate → persist (alert + PENDING routing, one transaction)
        → evaluate rules → resolve schedule → resolve responder
        → persist routing result → attempt notification
```

The design rules that govern it:

- **Durability precedes routing.** Everything after the intake transaction may
  fail without losing the alert. Failures are recorded as routing state and
  returned as warnings.
- **One decision per alert.** `UNIQUE (alert_id)` plus
  `(organization, source, externalId)` idempotency means a retry reuses the
  original record and never re-pages.
- **The routing instant is the server clock.** The alert's own `timestamp` is
  attacker-controlled and is never used to select a responder.
- **Resolution is pure and deterministic.** `packages/shared/oncall.mjs`
  computes rotations from absolute UTC instants only; the schedule's IANA
  timezone is used for validation and presentation, never for period arithmetic.
  See [`ONCALL.md`](./ONCALL.md) §4 for the daylight-saving contract.
- **Rules are data, not code.** Conditions are exact comparisons after trimming
  and case-folding, ordered by explicit priority with total tie-breaks. There is
  no expression language and nothing is `eval`uated.
- **Records are historical facts.** Names are snapshotted and configuration
  references use `ON DELETE SET NULL`, so later edits never rewrite who was
  actually paged.

Automatic incident correlation/creation remains intentionally out of scope.
Alerts are observed technical signal; incidents are operational lifecycle
objects. Only an explicit human action
(`POST /alerts/:alertId/incidents`) converts one into the other.

## On-call resolution

`resolveOnCall(schedule, participants, overrides, at)` is a pure function shared
by the routing pipeline, the on-call API and the UI state endpoint, so all three
always give the same answer. Overrides take precedence over the rotation;
resolving an override never mutates the rotation, which resumes unchanged when
the override window ends. Non-resolving schedules return an explicit reason
(`SCHEDULE_DISABLED`, `ROTATION_NOT_STARTED`, `NO_PARTICIPANTS`) instead of a
guessed responder.

## Object storage

No release to date requires binary attachments, so object storage is not instantiated. Future attachment/evidence work should introduce an S3-compatible interface rather than coupling domain logic to a specific cloud provider.

## Release version

`packages/shared/version.mjs` is the single source of truth for the reported
release version. `GET /api/v1/health`, the OpenAPI `info.version` and the server
startup banner all read it, and `scripts/build.mjs` fails if it disagrees with
`package.json`, so a version cannot drift between the API, the specification,
the logs and the published package.

## M-002 escalation data (partial)

Migration `003_escalation_delivery.sql` adds organization-scoped escalation
policies/steps, rule-level channel/policy fields, immutable escalation-job
snapshots, notification-delivery rows and attempt audit. `packages/shared/escalation.mjs`
contains ordered-step validation, original-route due-time calculation,
acknowledgement cancellation helpers and bounded retry classification. The
PostgreSQL dispatcher/lease loop and provider adapters are not yet qualified;
therefore the schema must not be mistaken for a production durable-delivery
implementation. See [ESCALATION.md](ESCALATION.md).
