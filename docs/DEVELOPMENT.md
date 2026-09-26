# Relay Development

## Prerequisites

- Node.js 22+
- npm 10+
- PostgreSQL 16+ for production-store development
- Docker + Docker Compose for the self-hosted path

## Environment

Copy `.env.example` to `.env`. Important variables:

- `DATABASE_URL`: PostgreSQL connection URL.
- `APP_ORIGIN`: canonical browser origin used for mutation-origin checks.
- `SESSION_COOKIE_NAME`: session cookie name.
- `SESSION_TTL_HOURS`: session lifetime.
- `COOKIE_SECURE`: set `true` when Relay is served over HTTPS; local Compose defaults to `false`.
- `POSTGRES_PASSWORD`: URL-safe PostgreSQL password used by Docker Compose.
- `ALERT_INGEST_KEY`: secret header value for generic alert intake.
- `INTEGRATION_ENCRYPTION_KEY`: key material used to encrypt integration webhook secrets.

Do not reuse example values outside local development.

## Install dependencies

Use the committed lockfile for reproducible installs:

```bash
npm ci
```

## Database

Apply migrations:

```bash
npm run migrate
```

Seed a local account/workspace:

```bash
npm run seed
```

The migration command is safe to re-run. `schema_migrations` prevents reapplying completed files.

Migrations are discovered from `packages/database/migrations/`, sorted by numeric
filename prefix and applied in order, each in its own transaction with its
`schema_migrations` row. Nothing is hardcoded to a specific release, so adding
`003_*.sql` later requires no code change. `001_initial.sql` is never edited.

To verify that a populated Relay 0.1 database upgrades cleanly to 0.2 without
rewriting any 0.1 data:

```bash
DATABASE_URL=postgres://... npm run verify:migration
```

## Run

```bash
npm run dev
```

The server defaults to port 4000. The API and static web app share an origin, reducing cookie/CORS complexity and keeping self-hosting simple.

For test-only execution without PostgreSQL:

```bash
RELAY_STORE=memory npm run dev
```

This mode is explicit and must not be used for durable deployments.

## Tests

```bash
npm test
```

The suite includes:

- domain lifecycle/status aggregation tests (`domain.test.mjs`);
- password/encryption security tests (`security.test.mjs`);
- on-call determinism unit tests (`oncall.test.mjs`) — timezone validation,
  rotation maths across handoff boundaries, DST transitions, override precedence
  and rule ordering, with the process timezone pinned to `Pacific/Kiritimati`
  (UTC+14) to prove resolution does not depend on it;
- API integration tests covering tenant isolation, updates, status publication,
  Discord and alert intake (`api.integration.test.mjs`, `authz.test.mjs`);
- alert routing integration tests (`routing.integration.test.mjs`) — the full
  pipeline, idempotency, concurrency, notification failure, acknowledgement
  authorization, cross-organization isolation, RBAC, malformed input and
  public-status leakage;
- E2E smoke workflows (`e2e.test.mjs`, `routing.e2e.test.mjs`);
- static-asset routing tests (`static-routing.test.mjs`);
- a 0.1 → 0.2 migration upgrade test (`migration-upgrade.test.mjs`) and a
  PostgreSQL migration/store contract test (`postgres.contract.test.mjs`), both
  active only when `DATABASE_URL` is present.

CI provides PostgreSQL, so the database-backed tests run there rather than
skipping. Focused runs:

```bash
npm run test:unit          # domain + security + on-call determinism
npm run test:integration   # HTTP API integration suites
npm run test:e2e           # end-to-end journeys
```

## Build verification

```bash
npm run build
```

Relay has no transpilation step. The build verifier parses every JavaScript module, verifies required release artifacts are present, and fails if `package.json`'s version disagrees with `RELAY_VERSION` in `packages/shared/version.mjs`. The Docker image installs the locked PostgreSQL driver and runs source directly on Node 22.

## Security check

```bash
npm run check:secrets
```

This is a lightweight guard, not a replacement for repository/CI secret-scanning products.

## Qualification runs

Two verification scripts exercise a real deployment rather than the test harness.

### Browser qualification

```bash
npm run build && RELAY_STORE=memory node apps/api/src/server.mjs &
npm run verify:browser
```

`scripts/browser-smoke.mjs` drives a headless Chromium over CDP with no external
dependencies (set `RELAY_BROWSER` to point at a specific binary). It checks
anonymous boot, MIME and API behaviour, sign-in and registration forms, keyboard
and focus contracts, deep-link recovery, the operator journey including alert
routing surfaces, and the responsive sweep at **1440×900, 1280×800 and 390×844**.

### Production verification

```bash
npm run verify:production   # fresh database: full operator journey
npm run verify:restart      # restart the server and prove durability
```

`scripts/production-e2e.mjs` runs against a real deployment (default
`http://127.0.0.1:4000`, override with `RELAY_VERIFY_BASE_URL`) and walks
registration through on-call configuration, alert routing, acknowledgement,
escalation and public status. `restart` mode re-reads every object from
PostgreSQL after a process restart, so a routing decision that only lived in
memory would fail the run.

## Typical workflow

1. Create a branch.
2. Make one scoped change.
3. Add/modify tests.
4. Run `npm run verify`.
5. If persistence changed, test `npm run migrate` against a clean PostgreSQL database.
6. Review tenant boundaries and public-data filtering before merge.

## Escalation development status

`npm test` includes deterministic domain tests for ordered policy steps,
route-relative due times, snapshot behavior, acknowledgement cancellation and
bounded retry calculation. PostgreSQL qualification for migration 003 requires
a real `DATABASE_URL`; this checkout has no database configured. The current
M-002 implementation remains partial, and worker restart/production/browser
qualification is not available yet. See [ESCALATION.md](ESCALATION.md).
