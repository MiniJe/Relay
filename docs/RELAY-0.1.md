# Relay 0.1 — Core Incident Lifecycle Foundation

## Release purpose

Relay 0.1 proves the complete core product loop:

```text
Alert / Manual Trigger
        ↓
     Incident
        ↓
    Responders
        ↓
 Internal Timeline
        ↓
 Public Status
        ↓
    Resolution
        ↓
   Postmortem
```

## Supported

### Identity and tenancy

- local email/password registration and login;
- secure server-side sessions;
- organization/workspace creation;
- OWNER, ADMIN, RESPONDER and VIEWER authorization;
- tenant-isolated reads and mutations.

### Service model

- internal Services;
- independent public Components;
- Component-to-Service mapping;
- component operational states.

### Incident operations

- manual incident declaration;
- SEV1-SEV4 severity;
- INVESTIGATING / IDENTIFIED / MONITORING / RESOLVED lifecycle;
- affected Services and Components;
- creator and commander fields;
- responders;
- actor-attributed timeline;
- internal notes;
- explicit public updates;
- realtime UI refresh through SSE;
- resolution timestamp and public recovery;
- postmortem creation/editing after resolution.

### Public status

- branded public status pages;
- overall effective status;
- component status;
- active incidents;
- recent resolved incidents;
- public incident history/details;
- desktop/tablet/mobile responsive UI.

### Intake and integrations

- durable generic alert intake;
- alert external-ID idempotency;
- Discord webhook adapter;
- incident-created, public-update and resolved Discord notifications.

### Operations

- PostgreSQL schema migrations;
- development seed;
- Dockerfile and Docker Compose;
- documented development/test/build/migrate commands;
- REST/OpenAPI documentation;
- automated tests and CI contract against PostgreSQL.

## Explicitly not implemented

Release 0.1 does not include:

- monitoring/metrics/logs/tracing backends;
- advanced alert correlation/deduplication/routing;
- automatic incident creation from all alerts;
- SMS/phone paging;
- on-call scheduling or escalation policies;
- autonomous remediation or AI investigation;
- MCP, CLI, Terraform or GitOps clients;
- SSO/SAML/SCIM or enterprise RBAC;
- custom status domains/themes;
- billing or Relay Cloud;
- Kubernetes operator;
- incident replay;
- dependency propagation;
- native mobile application.

## Prepared boundaries for future releases

Without implementing future scope, 0.1 preserves extension points for:

- alert-routing workers through the generic alert table/API;
- additional messaging providers through the integration adapter boundary;
- shared realtime/rate-limit infrastructure if multi-instance deployment arrives;
- CLI/MCP/bot clients through versioned REST operations;
- attachment/object storage through a future S3-compatible interface;
- dedicated audit logging separate from incident timeline semantics.

## Release invariant

The public status page does not maintain a parallel incident. It is a presentation of the same canonical incident data, with explicit filtering of internal information.
