# Relay API v1

Base namespace: `/api/v1`

Machine-readable description: `GET /api/v1/openapi.json`.
Version: `GET /api/v1/health` reports `{"ok":true,"version":"0.2.0"}`.

Relay 0.2 adds responder teams, on-call schedules, overrides, routing rules,
routing records, alert acknowledgement and Discord responder mapping. The
semantics of on-call resolution are specified in [`ONCALL.md`](./ONCALL.md);
this page documents the HTTP surface only.

## Response shape

Successful endpoints return either `204 No Content` or:

```json
{"data": {}}
```

Non-fatal external integration failures may add:

```json
{"warnings":[{"code":"DISCORD_DELIVERY_FAILED","message":"..."}]}
```

Errors use:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Human-readable explanation",
    "requestId": "uuid"
  }
}
```

The same request ID is returned in the `x-request-id` header.

## Authentication

Browser/API session authentication uses the HttpOnly `relay_session` cookie. Registration/login endpoints create the cookie; logout invalidates the server-side session.

### Auth

- `POST /auth/register`
- `POST /auth/login`
- `POST /auth/logout`
- `GET /me`

## Organizations

- `GET /organizations`
- `POST /organizations`
- `GET /organizations/:organizationId`

All child resources verify membership server-side.

### Members

- `GET /organizations/:organizationId/members`

Returns the organization roster (`userId`, `displayName`, `email`, `role`,
`joinedAt`) for any member. Used by the team, schedule and routing-rule editors
to offer only valid participants. Relay 0.2 has no invitation API, so this is a
read-only view of existing membership.

## Services

- `GET /organizations/:organizationId/services`
- `POST /organizations/:organizationId/services`
- `PATCH /organizations/:organizationId/services/:serviceId`

`PATCH` accepts `ownerTeamId` (or `null` to clear it) in addition to the 0.1
fields. Service ownership associates a Service with the responder team that
operates it; the Service/Component separation is unchanged.

## Components

- `GET /organizations/:organizationId/components`
- `POST /organizations/:organizationId/components`
- `PATCH /organizations/:organizationId/components/:componentId`

Component payloads may include `serviceIds` to express many-to-many internal mapping.

## Status Pages

- `GET /organizations/:organizationId/status-pages`
- `POST /organizations/:organizationId/status-pages`
- `GET /public/status/:slug`
- `GET /public/status/:slug/incidents/:incidentId`

Public endpoints never expose internal notes or internal incident timeline entries.

## Incidents

- `GET /organizations/:organizationId/incidents`
- `POST /organizations/:organizationId/incidents`
- `GET /organizations/:organizationId/incidents/:incidentId`
- `PATCH /organizations/:organizationId/incidents/:incidentId`
- `POST /organizations/:organizationId/incidents/:incidentId/responders`
- `POST /organizations/:organizationId/incidents/:incidentId/updates`
- `POST /organizations/:organizationId/incidents/:incidentId/resolve`
- `PUT /organizations/:organizationId/incidents/:incidentId/postmortem`

Lifecycle states:

```text
INVESTIGATING
IDENTIFIED
MONITORING
RESOLVED
```

`RESOLVED` is terminal in 0.1. Reopening requires a future product decision/mandate rather than silently changing historical behavior.

When `commanderUserId` is supplied during incident creation or mutation, the referenced user must be a member of the same organization.

Severities:

```text
SEV1 SEV2 SEV3 SEV4
```

### Incident update

```json
{
  "message": "We are monitoring recovery.",
  "isPublic": true
}
```

`isPublic: false` creates an internal note.

## Alerts

### Generic intake

`POST /alerts`

Header:

```text
x-relay-alert-key: <ALERT_INGEST_KEY>
```

Payload:

```json
{
  "organizationSlug": "acme",
  "source": "grafana-webhook",
  "externalId": "alert-123",
  "title": "Checkout latency",
  "description": "p95 threshold exceeded",
  "severity": "warning",
  "serviceIdentifier": "checkout-api",
  "metadata": {"region":"eu"},
  "timestamp": "2026-09-20T07:00:00Z"
}
```

Always responds `202 Accepted`. The alert and a `PENDING` routing record are
committed in one transaction; routing evaluation, on-call resolution and
notification happen afterwards and can never roll the alert back. Non-fatal
routing problems are reported as warnings:

```json
{"warnings":[{"code":"ALERT_NOTIFICATION_FAILED","message":"..."}]}
```

Matching `(organization, source, externalId)` submissions return the existing
alert with `"duplicate": true`. A duplicate is never re-evaluated and never
pages a responder a second time.

The response body is the alert plus its routing record:

```json
{
  "data": {
    "id": "…", "source": "grafana-webhook", "title": "Checkout latency",
    "severity": "critical", "serviceId": "…", "duplicate": false,
    "routing": {
      "resolution": "ROUTED",
      "ruleName": "Checkout criticals",
      "scheduleName": "Primary on-call",
      "teamName": "Core Platform",
      "oncallUserId": "…", "oncallDisplayName": "Ada Lovelace",
      "responderSource": "ROTATION",
      "periodStartsAt": "2026-09-26T07:00:00.000Z",
      "periodEndsAt": "2026-09-27T07:00:00.000Z",
      "notificationStatus": "SENT", "notificationProvider": "DISCORD",
      "notifiedAt": "2026-09-26T07:04:11.512Z",
      "acknowledgedAt": null, "incidentId": null
    }
  }
}
```

`timestamp` is stored and displayed but never selects the responder: routing
always resolves the on-call responder at the instant routing runs, so a delayed
or hostile observed timestamp cannot choose who gets paged.

### Organization alert list and detail

- `GET /organizations/:organizationId/alerts` — compact operational list, each
  alert joined with its routing record, service name and acknowledger. Alerts
  that predate Relay 0.2 report `"routing": null` rather than a fabricated
  decision.
- `GET /organizations/:organizationId/alerts/:alertId`
- `GET /organizations/:organizationId/alerts/:alertId/routing` — the immutable
  audit record. Snapshotted names never follow a later rename, and deleting a
  rule nulls `ruleId` while preserving `ruleName`.

### Alert acknowledgement

`POST /organizations/:organizationId/alerts/:alertId/acknowledge`

OWNER/ADMIN/RESPONDER only; VIEWER and non-members receive `403`. The first
acknowledgement wins under a row lock. Repeating the call is an idempotent no-op:

```json
{"data": { /* routing record */ }, "alreadyAcknowledged": true}
```

`alreadyAcknowledged` is a top-level flag (like `warnings`) so the audit record
itself stays pure. Acknowledging an alert is not resolving an incident.

An alert with no routing record returns `409 ROUTING_NOT_EVALUATED`.

### Explicit re-routing

`POST /organizations/:organizationId/alerts/:alertId/route`

OWNER/ADMIN/RESPONDER only. Re-runs rule evaluation, on-call resolution and
notification at the current instant. An alert whose notification was already
`SENT` is **not** re-paged unless the body contains `{"renotify": true}`.

### Escalate an alert to an incident

`POST /organizations/:organizationId/alerts/:alertId/incidents`

OWNER/ADMIN/RESPONDER only. Relay never creates an incident automatically; this
is the explicit human action. The incident body is the normal incident payload,
with `affectedServiceIds` defaulting to the alert's service. Responds `201` with
the canonical incident, records `sourceAlertId` on the incident timeline and
`incidentId` on the routing record. Escalating the same alert twice returns
`409 ALERT_ALREADY_ESCALATED`.

### Routing audit trail

- `GET /organizations/:organizationId/routings`

Every routing decision in the organization, newest first, including
non-`ROUTED` outcomes and notification failures.

## Responder Teams

- `GET /organizations/:organizationId/teams`
- `POST /organizations/:organizationId/teams` (OWNER/ADMIN)
- `GET /organizations/:organizationId/teams/:teamId`
- `PATCH /organizations/:organizationId/teams/:teamId` (OWNER/ADMIN)
- `GET /organizations/:organizationId/teams/:teamId/members`
- `POST /organizations/:organizationId/teams/:teamId/members` (OWNER/ADMIN)
- `DELETE /organizations/:organizationId/teams/:teamId/members/:userId` (OWNER/ADMIN)

Create/update payload:

```json
{"name": "Core Platform", "description": "Owns checkout"}
```

Membership payload: `{"userId": "…"}`. Only existing organization members can be
added; adding twice is an idempotent no-op, and a user outside the organization
can never be added. Team detail returns the roster and the services the team
owns.

## On-Call

- `GET /organizations/:organizationId/oncall/state?at=<iso>` — who is on call
  now for every schedule, plus the next handoffs, any active override and
  upcoming overrides. Resolution happens server-side, so the answer is the same
  deterministic one the routing engine used.
- `GET /organizations/:organizationId/oncall/schedules`
- `POST /organizations/:organizationId/oncall/schedules` (OWNER/ADMIN)
- `GET /organizations/:organizationId/oncall/schedules/:scheduleId`
- `PATCH /organizations/:organizationId/oncall/schedules/:scheduleId` (OWNER/ADMIN)
- `GET /organizations/:organizationId/oncall/schedules/:scheduleId/oncall?at=<iso>`
- `POST /organizations/:organizationId/oncall/schedules/:scheduleId/overrides` (OWNER/ADMIN)
- `DELETE /organizations/:organizationId/oncall/overrides/:overrideId` (OWNER/ADMIN)

Schedule payload:

```json
{
  "name": "Primary on-call",
  "teamId": "…",
  "timeZone": "Europe/Bucharest",
  "enabled": true,
  "rotationStartsAt": "2026-09-26T07:00:00.000Z",
  "rotationIntervalMinutes": 1440,
  "participantUserIds": ["…", "…", "…"]
}
```

`timeZone` must be a valid IANA identifier or `UTC`; anything else returns
`400 INVALID_TIMEZONE`. `rotationIntervalMinutes` is a whole number between 60
and 525600. Every participant must be a member of the schedule's team
(`400 INVALID_PARTICIPANT` otherwise). `at` is optional and defaults to now; a
malformed `at` returns `400`.

On-call resolution payload:

```json
{
  "resolved": true, "reason": "ROUTED", "source": "ROTATION",
  "userId": "…", "displayName": "Ada Lovelace",
  "periodStartsAt": "2026-09-26T07:00:00.000Z",
  "periodEndsAt": "2026-09-27T07:00:00.000Z",
  "upcoming": [{"userId": "…", "displayName": "Grace Hopper", "startsAt": "…", "endsAt": "…"}],
  "rotationOrder": [{"userId": "…", "position": 0}]
}
```

Unresolved schedules report the reason rather than a guessed responder:
`SCHEDULE_DISABLED`, `ROTATION_NOT_STARTED`, `NO_PARTICIPANTS`,
`SCHEDULE_MISSING`.

Override payload:

```json
{
  "replacementUserId": "…",
  "startsAt": "2026-09-27T07:00:00.000Z",
  "endsAt": "2026-09-28T07:00:00.000Z",
  "reason": "Ada unavailable"
}
```

Windows are half-open and `startsAt` must precede `endsAt`. Overlapping
overrides for the same schedule return `409 OVERRIDE_OVERLAP`; touching windows
are legal. While an override is active its replacement is the responder
(`"source": "OVERRIDE"`); when it ends the rotation resumes unchanged.

## Routing Rules

- `GET /organizations/:organizationId/routing-rules` — ordered by effective
  priority.
- `POST /organizations/:organizationId/routing-rules` (OWNER/ADMIN)
- `GET /organizations/:organizationId/routing-rules/:ruleId`
- `PATCH /organizations/:organizationId/routing-rules/:ruleId` (OWNER/ADMIN)
- `DELETE /organizations/:organizationId/routing-rules/:ruleId` (OWNER/ADMIN)

Payload:

```json
{
  "name": "Checkout criticals",
  "enabled": true,
  "priority": 10,
  "matchServiceId": "…",
  "matchSource": "synthetic-monitor",
  "matchSeverities": ["critical"],
  "targetKind": "ONCALL_SCHEDULE",
  "targetScheduleId": "…"
}
```

`priority` is an integer 0-100000; **lower wins**. An omitted or `null`
condition is a wildcard; `matchSeverities: []` matches any severity. Comparison
is exact after trimming and case-folding — there is no wildcard syntax, regex or
expression language, so `matchSource: "*"` matches only a literal `*`. Selection
is deterministic: `priority ASC → createdAt ASC → id ASC`, first match wins.

Deleting a rule does not affect existing routing records.

## Discord Responder Mapping

- `GET /organizations/:organizationId/discord-identities` (OWNER/ADMIN)
- `PUT /organizations/:organizationId/discord-identities/:userId` (OWNER/ADMIN)
- `DELETE /organizations/:organizationId/discord-identities/:userId` (OWNER/ADMIN)

Payload: `{"discordUserId": "223344556677889900"}` — a 15-25 digit Discord
snowflake. One mapping per organization and user; `PUT` is an upsert. No OAuth
and no secrets: a snowflake is a public identifier used only to mention the
responder in an alert page. Without a mapping the responder's display name is
used instead.

## Integrations

- `GET /organizations/:organizationId/integrations`
- `PUT /organizations/:organizationId/integrations/discord`
- `PUT|DELETE /organizations/:organizationId/integrations/slack` (OWNER/ADMIN)
- `PUT|DELETE /organizations/:organizationId/integrations/smtp` (OWNER/ADMIN)

Discord configuration payload:

```json
{
  "name": "Incident Operations",
  "webhookUrl": "https://discord.com/api/webhooks/...",
  "enabled": true
}
```

Slack accepts **only** an Incoming Webhook URL on `hooks.slack.com` with a
`/services/…` path and no query string or fragment:

```json
{
  "name": "Paging",
  "webhookUrl": "https://hooks.slack.com/services/T000/B000/secret",
  "enabled": true
}
```

SMTP configuration payload (write-only password):

```json
{
  "name": "Email",
  "host": "smtp.example.com",
  "port": 587,
  "secure": false,
  "username": "relay@example.com",
  "password": "…",
  "keepExistingPassword": false,
  "fromEmail": "relay@example.com",
  "fromName": "Relay Paging",
  "enabled": true,
  "timeoutMs": 10000
}
```

`secure: true` (implicit TLS) is rejected on ports 25 and 587, which are STARTTLS
ports. On an edit, omitting `password` keeps the stored credential. No read ever
returns a webhook URL or a password: SMTP reads report `config.passwordConfigured`
as a boolean.

## Realtime

`GET /organizations/:organizationId/events`

Returns `text/event-stream`. Mutation events contain a small refresh envelope, not the entire incident, so clients re-read canonical REST state.

Relay 0.2 adds `alert.routed` (`alertId`, `resolution`) and
`alert.acknowledged` (`alertId`) to the existing incident events.

## Escalation policies

- `GET /api/v1/organizations/{organizationId}/escalation-policies`
- `POST /api/v1/organizations/{organizationId}/escalation-policies`
- `GET|PUT|PATCH|DELETE /api/v1/organizations/{organizationId}/escalation-policies/{policyId}`

Policy create/replace bodies contain `name`, optional `description`/`enabled`, and
`steps`: ordered objects with `position`, positive `afterMinutes`,
`targetScheduleId`, and `channels` (`DISCORD`, `SLACK`, `EMAIL`). Delays are
measured from initial routing time. Routing-rule inputs accept
`notificationChannels` (default `['DISCORD']`) and optional `escalationPolicyId`.
The service validates organization ownership and snapshots policy/schedule names
onto existing jobs. See [ESCALATION.md](ESCALATION.md) for execution semantics,
the delivery state machine and the retry policy.

## Deliveries and escalation state

- `GET /organizations/:organizationId/alerts/:alertId/deliveries` — every
  logical page created for the alert plus a compact summary
  (`total`, `status`, `label`, `attempts`, `nextAttemptAt`, `providers`);
- `GET /organizations/:organizationId/deliveries/:deliveryId` — one delivery with
  its immutable attempt history and the alert it belongs to;
- `POST /organizations/:organizationId/deliveries/:deliveryId/retry`
  (OWNER/ADMIN/RESPONDER) — schedules and immediately attempts a page that has
  not been delivered. `202` on success, `409 DELIVERY_ALREADY_SENT` for a
  delivered page, `409 DELIVERY_CANCELLED` for one cancelled by an
  acknowledgement;
- `GET /organizations/:organizationId/alerts/:alertId/escalation` — the
  escalation read model: policy, planned/executed/cancelled/unresolved counts,
  next due instant, `due`, the immediate deliveries and one entry per step with
  its state, resolved responder at execution time, outcome and pages.

Delivery reads always expose operator-readable labels (`Sent`, `Delivery failed`,
`Retry scheduled`, `Queued`, `Sending`, `Cancelled` / `Scheduled`, `Executing`,
`Executed`, `Unresolved`, `Cancelled (acknowledged)`) and never a secret. A
delivery carries a non-secret destination snapshot: integration id and name,
recipient email for email pages, and the Discord mention id when one was used.
