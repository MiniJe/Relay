# Escalation and durable delivery (Relay 0.2 M-002)

> **Implementation status: partial.** Policy CRUD and deterministic plan
> materialization exist. The database outbox/job schema is present, but a
> production dispatcher, provider adapters (Slack/SMTP), worker leasing/recovery,
> delivery/attempt REST operations, and the operational UI remain incomplete.
> Do not use the current state as a production paging guarantee.

## Policy semantics

An organization owns an escalation policy; a routing rule may optionally attach
one. Rules continue to choose the immediate schedule and notification channel
configuration (legacy rules default to `DISCORD`). A policy has ordered steps
with `position`, positive `afterMinutes`, a same-organization schedule and one
or more of `DISCORD`, `SLACK`, or `EMAIL`. Position and delay must both be
strictly increasing and unique. Delays are offsets from the original routing
instant, not from completion of a previous step.

`POST /api/v1/organizations/{organizationId}/escalation-policies` creates a
policy and its steps. `GET` lists them. `PUT`/`PATCH` replaces the definition;
`DELETE` removes it for future rules/alerts. OWNER/ADMIN permissions apply to
configuration; operational reads use the existing readable organization roles.
Rules accept `notificationChannels` (default `['DISCORD']`) and an optional
`escalationPolicyId`.

When a routed alert has an enabled policy, Relay materializes job rows with the
policy name, step delay, due instant, target schedule id/name and channels. This
snapshot is independent of later policy edits or deletion. The schema also
contains notification-delivery and attempt-history tables with explicit finite
states. Their worker-driven lifecycle is not yet implemented.

## Delivery and external provider semantics

The target is a PostgreSQL-backed outbox and bounded retries (initial proposal:
1 minute, then 5 minutes, maximum three attempts). Provider delivery cannot be
universally exactly-once: a connection may be lost after the remote service
accepted a message but before Relay received its response. Relay can record one
logical task and its attempt sequence, not prove remote acceptance in every
ambiguous network failure.

No arbitrary outbound webhook URLs are supported. Discord retains its existing
validated HTTPS webhook boundary and AES-256-GCM secret storage. Slack and SMTP
provider configuration and delivery are not available yet; never put their
secrets in policy configuration or expose secret material in API responses.

## Public boundary

Policies, schedules, responders, delivery tasks, attempts and failure details
are private operational data. They must only be served by authenticated,
organization-scoped `/api/v1` operations and must never be included in public
status-page payloads. Acknowledging an alert is not incident resolution and
must not implicitly create or resolve an incident.
