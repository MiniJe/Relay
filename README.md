# Relay 0.1

Relay is an open-source incident operations and public status platform. Release 0.1 proves one canonical incident lifecycle from declaration through coordination, public communication, resolution, and postmortem.

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
npm run verify             # build + tests + secret scan
```

## Release verification

The official repository includes `.github/workflows/release-verification.yml`. On pushes to `main`, it performs clean lockfile installation, a fresh PostgreSQL 16 migration and schema contract, the full automated suite, secret scanning, an actual Docker Compose image/startup check, health/UI/API checks, the PostgreSQL-backed production lifecycle in `scripts/production-e2e.mjs`, a Relay container restart, and persisted-state verification.

A `v0.1.0` tag should reference only the exact commit whose `release-verification` workflow completed successfully.

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

Incoming alerts are persisted durably and idempotent on `(organization, source, externalId)` when `externalId` is supplied. Relay 0.1 does not automatically create an incident for every alert.

## Architecture

Relay 0.1 is a modular monolith with two logical application surfaces:

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
- `docs/RELAY-0.1.md`

## License

MIT.
