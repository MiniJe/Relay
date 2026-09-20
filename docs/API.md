# Relay API v1

Base namespace: `/api/v1`

Machine-readable description: `GET /api/v1/openapi.json`.

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

## Services

- `GET /organizations/:organizationId/services`
- `POST /organizations/:organizationId/services`
- `PATCH /organizations/:organizationId/services/:serviceId`

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

Alerts are persisted. Matching `(organization, source, externalId)` submissions return the existing alert.

### Organization alert list

- `GET /organizations/:organizationId/alerts`

## Integrations

- `GET /organizations/:organizationId/integrations`
- `PUT /organizations/:organizationId/integrations/discord`

Discord configuration payload:

```json
{
  "name": "Incident Operations",
  "webhookUrl": "https://discord.com/api/webhooks/...",
  "enabled": true
}
```

The webhook secret is never returned by API reads.

## Realtime

`GET /organizations/:organizationId/events`

Returns `text/event-stream`. Mutation events contain a small refresh envelope, not the entire incident, so clients re-read canonical REST state.
