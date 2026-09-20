# RELAY — EXECUTION MANDATE

## Mandate ID

`RLY-0.1-M-001`

## Product

**Relay**

## Release

**Relay 0.1**

## Mandate Title

**Core Incident Lifecycle Foundation**

## Mandate Status

`AUTHORIZED_FOR_EXECUTION`

## Governing Rule

This mandate is immutable after execution begins.

One mandate = one agent execution session.

The executing agent MUST:

- implement only the work authorized here;
- avoid silently expanding scope;
- document material assumptions;
- stop rather than invent requirements when a blocking ambiguity would materially affect architecture, security, data integrity, or product behavior;
- leave the repository in a working and reviewable state;
- return a formal **Counter-Mandate** at completion.

A new mandate is required for any work outside the defined scope.

---

# 1. Mission

Build the first functional release foundation of Relay.

Relay 0.1 must demonstrate the complete core lifecycle:

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

The goal of this mandate is NOT to build the entire future Relay platform.

The goal is to produce a high-quality, self-hostable, extensible foundation that proves the product architecture and allows a real team to:

1. create an organization;
2. define services and public components;
3. create an incident;
4. coordinate an incident;
5. communicate incident state publicly;
6. resolve the incident;
7. produce a postmortem;
8. perform the above through both the web application and API;
9. run Relay locally using Docker Compose.

---

# 2. Product Principles

The implementation MUST follow these principles.

## 2.1 Open source first

Relay Core must not artificially restrict:

- number of users;
- number of incidents;
- number of status pages;
- number of components;
- number of services.

The architecture should permit a future Relay Cloud product without degrading the self-hosted product into a crippled edition.

---

## 2.2 Incident as the canonical object

An incident must be the central object tying together:

- affected services;
- affected public components;
- severity;
- responders;
- status;
- timeline;
- internal updates;
- public updates;
- timestamps;
- resolution;
- postmortem.

Do not implement separate disconnected incident concepts for the dashboard and public status page.

---

## 2.3 API-first

Important Relay functionality must not exist exclusively inside the UI.

The backend API must expose the underlying operations cleanly enough that future clients can include:

- CLI;
- MCP;
- mobile clients;
- bots;
- integrations;
- automation workers.

---

## 2.4 Self-hosting must be simple

The target developer experience is eventually:

```bash
docker compose up -d

```

A developer should not need an external SaaS dependency merely to run Relay.

---

## 2.5 Modular, not prematurely distributed

Relay 0.1 should be implemented as a modular monolith unless there is a compelling technical reason otherwise.

DO NOT introduce microservices merely because future scale may require them.

Preserve clear internal module boundaries so pieces can be separated later.

---

## 2.6 Human authority

Automation may assist operators, but destructive or high-impact operations must not silently occur without explicit configuration or authorization.

Relay 0.1 does not require autonomous remediation.

---

# 3. Authorized Technology Direction

Use the following default architecture unless repository conditions make a different choice necessary.

## Web

Preferred:

- Next.js
- TypeScript
- Tailwind CSS
- shadcn/ui or equivalent accessible component system

## Backend

Preferred:

- TypeScript
- Hono, Fastify, or another lightweight structured backend framework

The agent may use Next.js server functionality where appropriate if separation remains architecturally clean.

## Database

PostgreSQL.

## Ephemeral / queue infrastructure

Redis may be used where justified.

Redis MUST NOT become the sole source of truth for permanent incident records.

## Realtime

Use:

- WebSockets;
- Server-Sent Events;

or another justified realtime transport.

## Object storage

Design an interface for S3-compatible storage if needed.

Actual extensive object-storage functionality is not required in 0.1.

## Deployment

Docker.

Docker Compose.

---

# 4. Repository Structure

The project should use a maintainable monorepo or similarly coherent layout.

A reasonable target is:

```text
relay/
├─ apps/
│  ├─ web/
│  └─ api/
│
├─ packages/
│  ├─ database/
│  ├─ shared/
│  ├─ ui/
│  ├─ config/
│  └─ integrations/
│
├─ docs/
├─ infra/
├─ docker/
├─ tests/
├─ .github/
├─ docker-compose.yml
├─ README.md
└─ LICENSE

```

This is guidance rather than a requirement if the selected framework strongly favors another structure.

Architecture must remain understandable.

---

# 5. Required Domain Model

Relay 0.1 MUST establish clear persistent models for at least the following.

## Organization

Represents a Relay tenant/workspace.

Minimum concepts:

- ID
- name
- slug
- created timestamp
- updated timestamp

---

## User

Minimum concepts:

- ID
- identity
- display name
- email where applicable
- created timestamp

---

## Organization Membership

Minimum concepts:

- organization
- user
- role

Initial roles may include:

```text
OWNER
ADMIN
RESPONDER
VIEWER

```

Permissions must be enforced server-side.

---

## Service

Represents an internal technical service.

Examples:

```text
Authentication API
Checkout API
Primary Database
Web Application

```

Minimum concepts:

- ID
- organization
- name
- slug
- description
- operational state

---

## Component

Represents something visible on a status page.

Examples:

```text
API
Dashboard
Authentication
Website

```

Components and Services must NOT be assumed to be the same object.

A component may map to one or more services.

---

## Status Page

Minimum concepts:

- organization
- name
- slug
- public visibility state
- associated components
- branding metadata sufficient for 0.1

Custom domains are NOT required by this mandate.

---

## Incident

Minimum concepts:

- ID
- organization
- title
- summary
- severity
- status
- creator
- commander/owner where applicable
- affected services
- affected components
- started timestamp
- acknowledged timestamp where applicable
- resolved timestamp
- created timestamp
- updated timestamp

Suggested lifecycle:

```text
INVESTIGATING
IDENTIFIED
MONITORING
RESOLVED

```

Internal workflow state may additionally include acknowledgment or coordination states if useful.

---

## Incident Timeline Event

Every material incident action must be representable in the timeline.

Examples:

- incident created;
- responder joined;
- severity changed;
- status changed;
- affected service added;
- public update published;
- incident resolved;
- postmortem created.

Minimum concepts:

- incident
- timestamp
- event type
- actor
- structured metadata
- optional human-readable message

---

## Incident Update

Separate internal notes from public communications.

A public incident update must explicitly indicate that it is intended for external publication.

---

## Postmortem

Minimum concepts:

- incident
- title
- summary
- impact
- root cause
- resolution
- follow-up actions
- created timestamp
- updated timestamp

Do NOT attempt to build a full project-management system for action items in 0.1.

---

# 6. Core Incident Workflow

The following workflow MUST function.

## 6.1 Create incident

An authorized user can create an incident and specify:

- title;
- severity;
- description/summary;
- affected services;
- affected components.

Relay records the event in the incident timeline.

---

## 6.2 Incident workspace

The UI must provide a useful incident workspace showing at minimum:

- incident title;
- severity;
- incident status;
- affected services;
- affected public components;
- incident start time;
- responders/owner;
- timeline;
- internal updates;
- public updates.

Updates should appear in realtime where practical.

---

## 6.3 Update incident

Authorized users must be able to:

- change severity;
- change lifecycle state;
- change affected services;
- change affected components;
- add internal notes;
- add public updates.

All material changes MUST generate timeline events.

---

## 6.4 Publish status update

An authorized responder must be able to publish a public update attached to the incident.

The corresponding public status page must show:

- active incident;
- current state;
- incident title;
- public updates;
- affected components;
- timestamps.

---

## 6.5 Resolve incident

An authorized user can resolve an incident.

Resolution must:

- set the resolved timestamp;
- change incident status;
- update the public status page;
- add a timeline event.

---

## 6.6 Postmortem

After resolution, authorized users can create/edit a postmortem tied to the incident.

The incident page should provide direct access to the postmortem.

---

# 7. Status Page Requirements

Relay 0.1 must include a genuinely usable public status page.

It must not look like a raw developer prototype.

The page must support:

- organization/service branding;
- current overall status;
- component states;
- active incidents;
- recent incidents;
- incident history;
- scheduled maintenance placeholder architecture if appropriate.

Required basic component states:

```text
OPERATIONAL
DEGRADED_PERFORMANCE
PARTIAL_OUTAGE
MAJOR_OUTAGE
MAINTENANCE

```

The UI must work well on:

- desktop;
- tablet;
- mobile.

Dark mode is strongly preferred.

---

# 8. Alert Intake

Relay 0.1 does NOT need to become a monitoring platform.

However, the architecture must establish a generic alert intake pathway.

Minimum required implementation:

```text
POST /api/v1/alerts

```

or equivalent.

An alert payload should be capable of carrying:

- source;
- external ID;
- title;
- description;
- severity;
- service identifier;
- metadata;
- timestamp.

Relay must persist incoming alerts or otherwise maintain sufficient durable traceability.

Manual incident creation remains mandatory.

Automatic incident creation from every alert is NOT required.

---

# 9. Integrations

Relay 0.1 requires a minimal integration architecture.

The implementation must provide a clear adapter/interface concept for future providers.

At least ONE practical messaging integration should be functional.

Preferred order:

1. Discord
2. Slack

Discord is strongly preferred for 0.1 unless there is a technical blocker.

Minimum Discord functionality:

- configure webhook/integration;
- send incident-created notification;
- send public/status update notification;
- send incident-resolved notification.

Do not build an enormous bot framework yet.

---

# 10. REST API

Provide a versioned REST API.

Preferred namespace:

```text
/api/v1

```

Required API coverage should include practical operations for:

- organizations;
- services;
- components;
- status pages;
- incidents;
- incident timeline;
- incident updates;
- incident resolution;
- postmortems;
- alerts.

API responses must use consistent:

- error representation;
- identifiers;
- status codes;
- validation behavior.

Provide API documentation.

OpenAPI is preferred.

---

# 11. Authentication

Relay 0.1 requires functional authentication.

Minimum acceptable solution:

- secure session authentication;
- protected application routes;
- organization membership authorization;
- role checks.

Local email/password authentication is acceptable for 0.1.

OAuth providers may be added if convenient but are NOT required.

Passwords must never be stored in plaintext.

Use an accepted password hashing algorithm.

---

# 12. Auditability

The incident timeline serves part of the audit role, but authentication/admin events should not be conflated blindly with incident timeline events.

At minimum ensure that material incident actions identify:

- actor;
- action;
- timestamp.

Design should permit a dedicated audit log later.

---

# 13. Security Requirements

At minimum:

- validate external input;
- parameterize database access;
- protect privileged routes;
- enforce tenant isolation;
- protect secrets;
- do not commit credentials;
- prevent users from accessing organizations they do not belong to;
- prevent unauthorized incident/status mutations;
- sanitize or safely render user-controlled public content;
- apply basic rate limiting to public or sensitive endpoints where appropriate.

No security-through-obscurity shortcuts.

---

# 14. Database Migrations

Database schema must be managed through migrations.

A fresh deployment must be reproducible without manually editing the database.

Seed functionality for local development is strongly encouraged.

---

# 15. Docker Compose

Provide a working local deployment.

Expected experience:

```bash
git clone <repository>
cd relay
cp .env.example .env
docker compose up -d

```

The deployment should start the required services, such as:

```text
Relay Web/API
PostgreSQL
Redis if required

```

Document any initialization command that remains necessary.

---

# 16. Developer Experience

Provide:

- `.env.example`
- setup instructions;
- development command;
- test command;
- build command;
- migration command;
- seed command if implemented;
- Docker instructions;
- architecture overview.

A new contributor should be able to understand how Relay works without reverse engineering the repository.

---

# 17. UI Requirements

The UI must feel like the foundation of a real product.

Required surfaces:

## Application

- sign in;
- organization/workspace;
- dashboard;
- services;
- components;
- incidents list;
- incident detail/workspace;
- status pages;
- postmortem editor;
- basic settings.

## Public

- public status page;
- incident details/history.

The design should favor:

- strong hierarchy;
- modern typography;
- accessible contrast;
- responsive layouts;
- low visual clutter;
- clear incident severity/state signaling.

Avoid spending the majority of implementation time on animations.

Correct behavior comes first.

---

# 18. Testing Requirements

Tests are mandatory.

At minimum provide meaningful coverage for:

## Unit / domain tests

- incident lifecycle transitions;
- severity validation;
- authorization rules;
- status aggregation where applicable.

## Integration tests

- create incident;
- mutate incident;
- publish public update;
- resolve incident;
- create postmortem;
- ingest alert;
- organization isolation.

## End-to-end smoke path

Test the fundamental product flow:

```text
Authenticate
→ Create service
→ Create component
→ Create incident
→ Publish update
→ Observe status page
→ Resolve incident
→ Create postmortem

```

The agent must not claim success if the principal tests do not pass.

---

# 19. Required Documentation

Create at least:

```text
README.md
docs/ARCHITECTURE.md
docs/DEVELOPMENT.md
docs/API.md
docs/SECURITY.md
docs/RELAY-0.1.md

```

`docs/RELAY-0.1.md` must explain what 0.1 supports and what remains intentionally out of scope.

---

# 20. Explicit Non-Goals

DO NOT implement the following unless trivial infrastructure is required to support future development.

### Not part of RLY-0.1-M-001

- full monitoring/observability platform;
- Prometheus replacement;
- log aggregation;
- metrics storage engine;
- tracing backend;
- global monitoring probes;
- SMS paging infrastructure;
- phone-call paging;
- complex on-call scheduling engine;
- escalation policies;
- advanced alert deduplication;
- advanced correlation;
- autonomous remediation;
- AI incident investigation;
- MCP server;
- CLI;
- Terraform provider;
- GitOps reconciliation;
- SSO/SAML;
- SCIM;
- advanced enterprise RBAC;
- custom domains;
- custom React status-page themes;
- billing;
- Relay Cloud;
- Kubernetes operator;
- incident replay;
- advanced service dependency propagation;
- mobile application.

Do not opportunistically build Release 0.2+ features.

---

# 21. Architecture Preparedness

Although the above features are out of scope, avoid architectural decisions that make these future capabilities unnecessarily difficult:

```text
0.2 — Alert routing + on-call
0.3 — Runbooks + automation
0.4 — GitOps
0.5 — Incident Replay
0.6 — Agent / AI operations
1.0 — Complete Incident OS

```

Preparation does not mean implementation.

---

# 22. Definition of Done

This mandate may be reported as `COMPLETED` only if:

- the project builds successfully;
- database migrations work from a clean database;
- authentication works;
- tenant isolation is enforced;
- organization/service/component models work;
- incidents can be created;
- incident state can be updated;
- timeline events are persisted;
- internal and public incident updates are differentiated;
- public status pages work;
- incident resolution works;
- postmortems work;
- generic alert ingestion works;
- at least one messaging integration works;
- REST API exists and is documented;
- Docker Compose deployment works;
- tests covering the principal workflow pass;
- no known critical security defect remains;
- required documentation exists;
- repository contains no known secrets;
- out-of-scope features have not silently expanded the release.

---

# 23. Execution Authority

The executing agent has authority to make ordinary engineering decisions required to accomplish the mandate.

Examples:

- exact library versions;
- file organization;
- schema naming;
- UI component structure;
- test framework;
- ORM/query builder;
- WebSocket vs SSE;
- Redis usage;
- exact REST endpoint design.

The agent should NOT request approval for low-impact implementation choices.

---

# 24. Mandatory Escalation Conditions

The agent MUST report the issue rather than silently choose when encountering a material decision involving:

- fundamental change to product architecture;
- replacement of PostgreSQL;
- abandoning self-hostability;
- introduction of mandatory proprietary services;
- significant security compromise;
- incompatible licensing issue;
- destructive modification of unrelated existing code;
- inability to satisfy core acceptance criteria;
- contradictory mandate requirements.

If execution can continue safely around the issue, continue all unaffected work and report the remaining blocker.

---

# 25. No False Completion

The agent must never return `COMPLETED` merely because code was written.

Completion requires verification.

Where verification is impossible, state exactly what was not verified.

A failing test, failed build, failed migration, inaccessible dependency, or unresolved critical defect must be disclosed.

---

# 26. Required Counter-Mandate

At the end of this execution session, the executing agent MUST return exactly one formal response titled:

# `COUNTER-MANDATE — RLY-0.1-M-001`

The counter-mandate closes this execution cycle.

It is not authorization for additional work.

---

# COUNTER-MANDATE FORMAT

```text
COUNTER-MANDATE — RLY-0.1-M-001

Execution Status:
COMPLETED | COMPLETED_WITH_NOTES | PARTIAL | BLOCKED | QUESTIONS_REQUIRED

Mandate:
Core Incident Lifecycle Foundation

Release:
Relay 0.1

Repository State:
<clean / modified / build state / branch / commit if available>

--------------------------------------------------
1. EXECUTIVE RESULT
--------------------------------------------------

Concise statement of what happened.

Examples:

- Relay 0.1 was successfully implemented and verified.
- Most of Relay 0.1 was implemented, but Discord integration remains blocked.
- Execution could not proceed because the existing repository architecture conflicts with the mandate.

--------------------------------------------------
2. IMPLEMENTED
--------------------------------------------------

List everything materially implemented.

Example:

[PASS] Authentication
[PASS] Organizations
[PASS] RBAC
[PASS] Services
[PASS] Components
[PASS] Incidents
[PASS] Incident timeline
[PASS] Public updates
[PASS] Public status page
[PASS] Resolution flow
[PASS] Postmortems
[PASS] Alert ingestion
[PASS] Discord integration
[PASS] REST API
[PASS] Docker Compose

Do not mark something PASS unless it is genuinely functional.

--------------------------------------------------
3. VERIFICATION
--------------------------------------------------

Report actual commands/results.

Build:
<command>
<result>

Tests:
<command>
<number passed / failed>

Migrations:
<result>

Docker Compose:
<result>

End-to-End Flow:
<result>

Security checks:
<result>

--------------------------------------------------
4. ACCEPTANCE CRITERIA
--------------------------------------------------

For every major Definition of Done requirement:

[PASS]
[FAIL]
[NOT VERIFIED]
[NOT APPLICABLE]

Include explanation for anything other than PASS.

--------------------------------------------------
5. ARCHITECTURE CREATED
--------------------------------------------------

Describe:

- application architecture;
- major modules;
- database structure;
- realtime mechanism;
- API organization;
- integration architecture;
- important technical decisions.

--------------------------------------------------
6. FILES / AREAS CHANGED
--------------------------------------------------

Summarize major repository areas added or modified.

Do not dump every generated file unless useful.

--------------------------------------------------
7. PROBLEMS ENCOUNTERED
--------------------------------------------------

Describe any:

- bugs;
- environmental problems;
- dependency problems;
- architectural conflicts;
- missing credentials;
- external service failures;
- unresolved questions.

Use:

NONE

if there were none.

--------------------------------------------------
8. DEVIATIONS FROM MANDATE
--------------------------------------------------

Describe any place where implementation differed from the mandate and why.

Use:

NONE

if there were none.

--------------------------------------------------
9. UNFINISHED WORK
--------------------------------------------------

List anything required by this mandate that remains incomplete.

Use:

NONE

only if genuinely complete.

--------------------------------------------------
10. QUESTIONS REQUIRING FOUNDER DECISION
--------------------------------------------------

Only include questions that materially require a product or architecture decision.

Use:

NONE

if no founder decision is required.

--------------------------------------------------
11. KNOWN RISKS
--------------------------------------------------

Describe important technical/security/product debt introduced during implementation.

Do not hide technical debt.

--------------------------------------------------
12. OUT-OF-SCOPE WORK OBSERVED
--------------------------------------------------

Mention useful future work discovered during implementation.

DO NOT implement it.

Example:

- advanced alert grouping could improve noisy alert intake;
- service dependency graph will be useful in 0.2+;
- Discord slash commands would fit a future mandate.

--------------------------------------------------
13. FINAL REPOSITORY HEALTH
--------------------------------------------------

Build:
PASS | FAIL | NOT VERIFIED

Tests:
PASS | FAIL | NOT VERIFIED

Migrations:
PASS | FAIL | NOT VERIFIED

Docker:
PASS | FAIL | NOT VERIFIED

Security:
PASS | FAIL | NOT VERIFIED

Core Relay Workflow:
PASS | FAIL | NOT VERIFIED

--------------------------------------------------
14. FINAL DECLARATION
--------------------------------------------------

The agent must choose ONE.

A)

MANDATE SATISFIED

RLY-0.1-M-001 has been implemented and verified within the authorized scope.
No additional authority is assumed.

OR

B)

MANDATE SATISFIED WITH DISCLOSED NOTES

RLY-0.1-M-001 has been implemented with the limitations explicitly disclosed above.
No additional authority is assumed.

OR

C)

MANDATE NOT FULLY SATISFIED

RLY-0.1-M-001 could not be fully completed.
The outstanding requirements, blockers, or required founder decisions are documented above.
No additional authority is assumed.

```

---

# 27. Question / Trouble Protocol

The executing agent should NOT abandon the entire mandate simply because it encounters one question.

Use the following decision logic.

```text
Problem encountered
        │
        ▼
Can it be resolved safely using normal
engineering judgment within the mandate?
        │
     YES ───────► Resolve it and continue.
        │
       NO
        ▼
Does it block all remaining implementation?
        │
   NO ──────────► Continue unaffected work.
        │          Record blocker.
        │
       YES
        ▼
Stop affected execution.
Return COUNTER-MANDATE with:
QUESTIONS_REQUIRED or BLOCKED.

```

Questions must be precise.

Bad:

> What do you want me to do?

Good:

> The repository currently uses MySQL while the mandate requires PostgreSQL. Migrating would replace an existing persistence layer and could affect unrelated modules. Founder decision required: authorize PostgreSQL migration, or issue a revised mandate allowing MySQL.

---

# 28. Completion Behavior

When the agent believes the mandate is finished:

1. inspect the implementation;
2. run the build;
3. run tests;
4. run migrations against a clean database where feasible;
5. verify Docker deployment;
6. verify the core incident workflow;
7. inspect for accidentally committed secrets;
8. compare implementation against the Definition of Done;
9. identify deviations and unfinished work;
10. return the Counter-Mandate.

The agent MUST NOT begin Release 0.2.

The agent MUST NOT interpret successful completion as authority to continue development.

---

# 29. Founder Handoff

After receiving the Counter-Mandate, the Founder will determine one of:

```text
RATIFIED
RATIFIED_WITH_NOTES
REMEDIATION_REQUIRED
QUESTIONS_ANSWERED
REJECTED

```

Only a subsequent mandate may authorize additional implementation.

---

# END OF MANDATE

**Mandate:** `RLY-0.1-M-001`

**Release:** `Relay 0.1`

**Authority:** Core Incident Lifecycle Foundation only.

**Required response:** `COUNTER-MANDATE — RLY-0.1-M-001`