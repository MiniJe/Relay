# Relay 0.2

Relay is an open-source incident operations and public status platform. Release 0.1 proved one canonical incident lifecycle from declaration through coordination, public communication, resolution, and postmortem. Release 0.2 adds the layer upstream of the incident: **alert routing and an on-call foundation** that answers "who is responsible right now?" deterministically.

## What works in 0.2

Alert routing and on-call (see [`docs/ONCALL.md`](docs/ONCALL.md)):

- Responder teams with organization-scoped membership, and Services owned by a team.
- On-call schedules with an IANA timezone, an ordered rotation and fixed-duration handoffs expressed in minutes.
- Deterministic resolution of "who is on call at instant T" for any T, computed from absolute UTC instants so the server's timezone can never change the answer.
- Overrides: a named replacement responder for a window, with the rotation resuming unchanged afterwards and overlaps rejected.
- Routing rules matching service, source and severity, resolved by explicit priority with total tie-breaks. First match wins; rules are data, never code.
- An immutable routing record per alert capturing the matched rule, schedule, team, resolved responder, notification outcome and acknowledgement — with names snapshotted so history never drifts.
- Discord as the first notification channel, mentioning the mapped responder and sanitized against forged mentions.
- Alert acknowledgement by authorized responders: first wins, repeats are idempotent, and acknowledging is never the same as resolving an incident.
- Explicit human escalation from an alert to a canonical incident. Relay never declares an incident automatically.
- Operator surfaces for Alerts, Teams, On-call and Routing in the existing Quiet Operations style.

## What works in 0.1

- Local email/password authentication with durable server-side sessions.
- Multi-tenant organizations with OWNER, ADMIN, RESPONDER, and VIEWER role enforcement.
- Internal Services and independently modeled public Components.
- Public Status Pages with effective component health derived from active incident impact.
- Canonical Incidents with severity, lifecycle, responders, affected systems, timeline, internal updates, and public updates.
- Incident resolution and postmortems.
- Durable generic `POST /api/v1/alerts` intake.
- Discord webhook notifications for incident creation, public updates, and resolution.
- Versioned REST API, machine-readable OpenAPI metadata, and SSE refresh events.
- Responsive application and public status UI.
- PostgreSQL migrations, seed command, Dockerfile, and Docker Compose deployment.

Relay Core does **not** impose product limits on users, incidents, services, components, or status pages.

## Quick start with Docker Compose

```bash
git clone https://github.com/MiniJe/Relay.git
cd relay
cp .env.example .env
# Replace the placeholder alert/integration secrets in .env before any non-local use.
docker compose up -d
```

Open `http://localhost:4000` and register an account. To create a pre-populated local workspace instead:

```bash
docker compose exec relay npm run seed
```

Then sign in with `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` from your environment.

## Local development

Requirements: Node.js 22+ and PostgreSQL 16+.

```bash
cp .env.example .env
npm ci
npm run migrate
npm run seed       # optional
npm run dev
```

The runtime intentionally requires PostgreSQL unless `RELAY_STORE=memory` is explicitly selected. Memory mode exists for deterministic verification and is not a production persistence option.

## Commands

```bash
npm run dev                # run Relay
npm run build              # syntax/artifact build verification
npm test                   # unit + integration + E2E + optional PostgreSQL contract
npm run test:unit
npm run test:integration
npm run test:e2e
npm run migrate            # apply database migrations
npm run seed               # seed local development data
npm run check:secrets      # scan repository text for common credential patterns
npm run verify:production  # production PostgreSQL-backed lifecycle verifier
npm run verify:restart     # persistence verifier after Relay restart
npm run verify:migration   # 0.1 -> 0.2 upgrade contract on a populated database
npm run verify:surface     # deployed version/OpenAPI/UI-surface consistency
npm run verify:browser     # real-browser boot, keyboard, responsive and routing pass
npm run verify             # build + tests + secret scan
```

## Release verification

The official repository includes `.github/workflows/release-verification.yml`. On pushes to `main` and on pull requests, it performs clean lockfile installation, a fresh PostgreSQL 16 migration and schema contract, the full automated suite, the 0.1 → 0.2 migration upgrade contract, the timezone-pinned on-call determinism contract, secret scanning, an actual Docker Compose image/startup check, health/UI/API and release-surface checks, a real-browser qualification pass, the PostgreSQL-backed production lifecycle in `scripts/production-e2e.mjs`, a Relay container restart, and persisted-state verification including routing records, schedules and acknowledgements.

The `v0.1.0` tag is immutable and references only the exact commit whose `release-verification` workflow completed successfully. Relay 0.2 is **not** tagged: `v0.2.0` is published only when the Founder decides the release is closed.

## Alert intake example

```bash
curl -X POST http://localhost:4000/api/v1/alerts \
  -H 'content-type: application/json' \
  -H 'x-relay-alert-key: <ALERT_INGEST_KEY>' \
  -d '{
    "organizationSlug": "acme",
    "source": "synthetic-monitor",
    "externalId": "eu-checkout-42",
    "title": "Checkout latency elevated",
    "description": "p95 above threshold",
    "severity": "warning",
    "serviceIdentifier": "checkout-api",
    "metadata": {"region":"eu-central"},
    "timestamp": "2026-09-20T07:00:00Z"
  }'
```

Incoming alerts are persisted durably and idempotent on `(organization, source, externalId)` when `externalId` is supplied.

Since 0.2 the same request also runs the routing pipeline: rules are evaluated in deterministic order, the target schedule is resolved, the responder on call **at the routing instant** is selected, an immutable routing record is written and the first notification channel is attempted. The alert and its `PENDING` routing record are committed *before* any of that runs, so a routing misconfiguration or a Discord outage can never lose an alert. A replayed `externalId` reuses the original record and never pages a responder twice.

The response includes the routing decision:

```json
{"data":{"id":"…","duplicate":false,"routing":{"resolution":"ROUTED","ruleName":"Checkout criticals","scheduleName":"Primary on-call","oncallDisplayName":"Ada Lovelace","notificationStatus":"SENT","acknowledgedAt":null}}}
```

Relay does not automatically create an incident for every alert. Escalation is an explicit human action:

```bash
curl -X POST http://localhost:4000/api/v1/organizations/<orgId>/alerts/<alertId>/incidents \
  -H 'content-type: application/json' -b '<session cookie>' \
  -d '{"title":"Checkout latency breach","severity":"SEV2"}'
```

## Architecture

Relay is a modular monolith with two logical application surfaces:

```text
Browser / API client
        |
        v
Node HTTP application
  |       |        |
  |       |        +--> Discord webhook adapter
  |       +-----------> SSE realtime hub
  +-------------------> PostgreSQL

Static responsive web UI is served by the same process.
```

The repository keeps domain rules, database persistence, API handling, integration adapters, and the web surface separated so future workers, CLI/MCP clients, or split services can be added without replacing the canonical incident model.

See:

- `docs/ARCHITECTURE.md`
- `docs/DEVELOPMENT.md`
- `docs/API.md`
- `docs/SECURITY.md`
- `docs/ONCALL.md`
- `docs/RELAY-0.1.md`
- `docs/RELAY-0.2.md`

## License

MIT.

### Escalation policy work (M-002 partial)

Relay 0.2 M-002 adds organization-scoped escalation policy configuration,
rule-level channel/policy references, deterministic schedule snapshots and the
forward-only migration `003_escalation_delivery.sql`. Durable dispatch/retry
workers and Slack/SMTP delivery are still under implementation and not yet
production-qualified; consult [docs/ESCALATION.md](docs/ESCALATION.md) before
planning a deployment around escalation paging.
