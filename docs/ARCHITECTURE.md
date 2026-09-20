# Relay 0.1 Architecture

## Architectural style

Relay 0.1 is a modular monolith. A single Node.js runtime serves the REST API, SSE stream, and static web application. PostgreSQL is the production system of record. No Redis or external SaaS is required to run the product.

This is intentionally not a microservice design. The major modules are still separated so future releases can split responsibilities if operational scale justifies it.

## Repository map

```text
apps/api/src/          HTTP/API/auth/security/realtime/integration orchestration
apps/web/public/       responsive application + public status UI
packages/shared/       domain state machines and input validation
packages/database/     PostgreSQL + verification stores and migrations
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

PostgreSQL is the permanent source of truth. `001_initial.sql` creates all Release 0.1 tables and constraints. `schema_migrations` tracks applied migrations.

The in-memory store implements the same application contract only for deterministic tests and explicit `RELAY_STORE=memory` verification mode. It is never selected automatically in production.

## Authentication and authorization

Local users authenticate with email/password. Passwords are scrypt hashed. Login creates an opaque random session token; only SHA-256 of the token is persisted. The browser receives the raw token in an HttpOnly, SameSite=Lax cookie.

Every organization-scoped API route resolves membership server-side before reading or mutating tenant data. Roles:

- OWNER: full Release 0.1 authority.
- ADMIN: configuration and incident authority.
- RESPONDER: incident coordination/publication authority.
- VIEWER: read-only organization access.

## Realtime

`GET /api/v1/organizations/:id/events` exposes Server-Sent Events. Incident mutations publish organization-scoped refresh events. The 0.1 hub is process-local, appropriate to the single-process modular-monolith deployment.

A future horizontally scaled deployment can replace the event hub with Redis/pub-sub or another broker without changing API/domain contracts.

## Integration boundary

Integrations are provider adapters. Release 0.1 implements Discord webhooks. Webhook URLs are encrypted with AES-256-GCM using `INTEGRATION_ENCRYPTION_KEY`; API reads never return encrypted secret material.

Discord delivery occurs after the incident transaction commits. An external Discord outage cannot roll back incident truth; the API reports a delivery warning while keeping the authoritative incident action successful.

## Alert intake

`POST /api/v1/alerts` accepts generic monitor events. Intake is authenticated using a deployment-level key in 0.1, rate-limited, persisted in PostgreSQL, and idempotent when source + external ID are supplied.

Automatic incident correlation/creation is intentionally deferred to later mandates.

## Object storage

No 0.1 feature requires binary attachments, so object storage is not instantiated. Future attachment/evidence work should introduce an S3-compatible interface rather than coupling domain logic to a specific cloud provider.
