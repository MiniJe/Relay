# Escalation and durable delivery (Relay 0.2 M-002)

> **Implementation status: complete in source, pending Founder integration and
> release qualification.** Policy CRUD, deterministic plan materialization, the
> PostgreSQL outbox/attempt schema, the leasing worker with recovery, the
> Discord/Slack/SMTP provider adapters, delivery and escalation REST reads, the
> manual-retry operation and the operator surfaces are implemented and covered
> by the test suite, the PostgreSQL worker qualification, the production
> deployment verification and the browser smoke. Qualification evidence is
> produced by CI on a real PostgreSQL cluster and a real browser; see
> [Verification](#verification).

## Policy semantics

An organization owns an escalation policy; a routing rule may optionally attach
one. Rules choose the immediate schedule and notification channels; a policy adds
ordered steps that run while the alert stays unacknowledged. A policy step has a
`position`, a positive `afterMinutes`, a same-organization schedule and one or
more of `DISCORD`, `SLACK` or `EMAIL`. Positions and delays must both be
strictly increasing and unique. Delays are offsets from the original routing
instant, not from completion of the previous step, so the plan is fixed at
routing time and cannot drift with execution latency.

`POST /api/v1/organizations/{organizationId}/escalation-policies` creates a
policy and its steps, `GET` lists them, `PUT`/`PATCH` replaces the definition and
`DELETE` removes it for future rules/alerts. OWNER/ADMIN may configure; every
readable organization role may read. Rules accept `notificationChannels`
(default `['DISCORD']`) and an optional `escalationPolicyId`.

When a routed alert has an enabled policy, Relay materializes one job row per
step carrying the policy name, step delay, due instant, target schedule id and
the schedule's name **as a snapshot**. Editing or deleting the policy afterwards
never rewrites an in-flight plan. Jobs move through
`PENDING → IN_FLIGHT → COMPLETED | FAILED | CANCELLED_ACKNOWLEDGED`; the same
values are exposed to operators with text labels (`Scheduled`, `Executing`,
`Executed`, `Unresolved`, `Cancelled (acknowledged)`).

The responder for a step is resolved **at execution time**, never predicted at
routing time: if the rotation has moved on between routing and the step's due
instant, the person who is on call when the step runs receives the page. A step
whose schedule resolves nobody is recorded as `FAILED` (shown as *Unresolved*)
with the resolution reason; it is never retried into a page for the wrong
person.

## Delivery model

A page is a durable row in `notification_deliveries` — the logical intent to
notify one responder over one channel. It is created when routing decides to
notify (one row per configured channel) or when an escalation step executes. Its
identity is the `(alert, provider)` pair for immediate pages and
`(escalation job, provider)` for step pages, enforced by partial unique indexes,
so re-evaluating routing can never duplicate a page.

States: `PENDING → IN_FLIGHT → SENT | RETRYING → SENT | FAILED`, plus
`CANCELLED` for a page the acknowledgement stopped before any provider call.
`SENT`, `FAILED` and `CANCELLED` are terminal.

Every provider call writes one immutable row in `notification_attempts` with its
`attempt_number`, `outcome` (`SENT`, `RETRYABLE_FAILURE`, `PERMANENT_FAILURE`),
provider status code, a bounded operator-readable error, timestamps, and — for a
manual retry — the user who asked for it. Attempts are never updated or deleted;
a retry adds history. The delivery carries the attempt count, the next attempt
instant, the last error and a non-secret destination snapshot (integration name,
recipient address, Discord mention id).

### Bounded retries

- maximum **3** attempts per delivery;
- delays of **1 minute** and **5 minutes** for the second and third attempt
  (`RETRY_DELAYS_MS` in `packages/shared/escalation.mjs`);
- HTTP 408/425/429 and 5xx, timeouts, connection failures and SMTP 4xx are
  retryable; HTTP 4xx (other than the above) and SMTP 5xx/authentication
  failures are permanent;
- an unrecognized failure is treated as retryable, because a bounded retry is
  safer than silently dropping a page;
- after the third attempt the delivery is `FAILED` and no further attempt is
  ever scheduled.

### What is guaranteed, and what is not

Delivery cannot be exactly-once in the presence of network ambiguity: a
connection may be lost after the provider accepted a message but before Relay
read the response, in which case Relay retries and the provider may have already
delivered. Relay guarantees the opposite direction: **at most one logical page
per (alert, channel)** and **at most three attempts**, all persisted, plus
idempotent intake so a replayed webhook never pages twice. It never claims to
prove remote acceptance.

## Worker and concurrency

The worker is `apps/api/src/worker.mjs`, started by the server after the database
is ready and stopped on shutdown before the pool closes. It has two layers:
`processDueWork` (deterministic core, explicit clock, no sleeping — what the
qualification tests drive) and `createDeliveryWorker` (polling lifecycle, bounded
batches, clean stop).

- claims happen in a short transaction:
  `SELECT … FOR UPDATE SKIP LOCKED` → `IN_FLIGHT` → lease owner + lease expiry;
- **every provider call happens outside any transaction**, so a slow Discord,
  Slack or SMTP endpoint never holds a row lock or a connection;
- a completed write must present the matching lease token. A worker whose lease
  expired — because it crashed or stalled — has its write refused
  (`staleLease`), so it can never overwrite the outcome recorded by the worker
  that recovered the work;
- expired leases are recovered at the start of each pass, in PostgreSQL, which is
  why a restart needs no in-memory state: abandoned work becomes claimable again
  and is delivered exactly once;
- a request that creates work also performs one latency kick on the same worker
  instance. The kick is an optimization only: the page is already committed, so
  a crash between the commit and the kick loses nothing;
- the database is the source of truth for every state transition. Process
  memory holds no delivery state that a restart would need.

## Providers

| Channel | Transport | Configuration | Secret handling |
| --- | --- | --- | --- |
| `DISCORD` | Discord webhook (`discord.com`/`discordapp.com` HTTPS only) | Settings → Discord webhook | AES-256-GCM at rest; never returned, never logged |
| `SLACK` | Slack **Incoming Webhook** only (`https://hooks.slack.com/services/…`) | Settings → Slack paging | AES-256-GCM at rest; never returned, never logged |
| `EMAIL` | SMTP via `nodemailer` (STARTTLS or implicit TLS) | Settings → Email paging | password AES-256-GCM at rest; reads report only `passwordConfigured` |

Deliberately **not** implemented: Slack bots, slash commands, interactive
incident management, OAuth installation, arbitrary outbound webhooks, SMS or
voice paging.

Defences that apply to every channel:

- the destination is snapshotted from the organization's stored integration or
  the responder's canonical account; alert content can never choose a recipient
  or a URL;
- Slack text is sanitized so `<@U…>`, `<!channel>`, `<!here>`, `<!everyone>` and
  `<!subteam^…>` cannot broadcast a mention, and `parse`/`link_names` is never
  sent;
- email headers are built from header-safe fields; CR, LF and NUL are rejected
  at validation and stripped again when the subject or `From` is formatted;
- provider failures are truncated and stripped of secrets before they reach a
  log line, an attempt row or an API response.

A channel with no integration (or a disabled one) is recorded as
`SKIPPED_NO_INTEGRATION`/`SKIPPED_DISABLED` on the routing summary and as a
terminal `FAILED` delivery carrying the reason. A page is **never** rerouted to
a different provider that the operator did not configure.

## Acknowledgement cancels work, never history

`POST /organizations/{organizationId}/alerts/{alertId}/acknowledge` is
authorized for OWNER/ADMIN/RESPONDER (VIEWER and non-members get `403`) and the
first acknowledgement wins under a row lock.

- pending escalation steps are cancelled (`CANCELLED_ACKNOWLEDGED`) and can no
  longer create a page;
- an escalation job that completes concurrently locks the routing row and re-reads
  the acknowledgement inside the same transaction, so strictly one of the two
  orderings is observed: either the acknowledgement cancels the step, or the page
  was already durably created. A page is never created after an acknowledgement
  has committed;
- deliveries with no provider call yet are `CANCELLED`; a delivery that already
  reached a provider keeps its status and full attempt history;
- acknowledging an alert is **not** resolving an incident and does not create
  one.

## Retry operations

`POST /organizations/{organizationId}/deliveries/{deliveryId}/retry` schedules
and immediately attempts a page that has not been delivered. OWNER, ADMIN and
RESPONDER may use it; VIEWER is rejected. An already delivered page answers
`409 DELIVERY_ALREADY_SENT` and a page cancelled by acknowledgement answers
`409 DELIVERY_CANCELLED` — neither is re-sent. A manual retry records the
requesting user on the new attempt and keeps every previous attempt intact.

## Operational surfaces

- **Alert detail** (`/app/alerts/{alertId}`) — routing record, the immediate page
  per channel with state labels, attempt trails, next attempt, failure reasons, a
  manual retry action where it applies, the escalation plan with per-step state
  and resolved responder, and the acknowledgement state;
- **Escalations** (`/app/escalations`) — due/scheduled and executed/cancelled
  steps for the most recent routed alerts, from persisted jobs only. Reading the
  view never re-resolves who is on call;
- **Routing** — per-rule channel selection (Discord, Slack, Email), the attached
  escalation policy, and an ordered policy editor (steps with delay, schedule and
  channels);
- **Settings** — Slack and SMTP configuration; a stored credential is shown as
  *stored* and is never echoed back into the form.

All three surfaces carry text labels next to colour, follow the existing Quiet
Operations direction, and are keyboard- and reduced-motion-aware.

## Public boundary

Policies, schedules, responders, delivery tasks, attempts and failure details are
private operational data. They are served only by authenticated,
organization-scoped `/api/v1` operations and can never appear in a public
status-page payload. Provider secrets never appear in any response, log line,
delivery row or attempt row.

## Verification

- `tests/durable-delivery.test.mjs` — durable enqueue per channel, one immutable
  attempt per provider call, bounded 1-minute/5-minute retries, permanent
  failures, manual retry history, acknowledgement cancellation, Slack/email
  sanitization and fail-closed channels;
- `tests/providers.test.mjs` — Slack Incoming Webhook URL validation and payload
  sanitization, SMTP message construction, header-injection rejection, SMTP
  error classification and the retry plan;
- `tests/escalation.test.mjs` — deterministic step validation, plan
  materialization and snapshot immutability;
- `tests/worker.qualification.test.mjs` (real PostgreSQL) — disjoint claims
  under concurrent workers, stale-lease refusal, restart recovery of abandoned
  work, and acknowledgement-versus-escalation ordering;
- `tests/postgres.contract.test.mjs` — the delivery/attempt/escalation store
  contract against real PostgreSQL, including the schema CHECK constraints and
  tenant isolation;
- `scripts/production-e2e.mjs` — a real deployment's delivery audit, attempt
  history, manual retry semantics and escalation read model, re-verified after a
  container restart (`verify:restart`);
- `scripts/browser-smoke.mjs` — the alert-detail, escalations, routing-channel,
  policy-editor and settings surfaces in a real browser at three viewports.
