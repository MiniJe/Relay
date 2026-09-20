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

- domain lifecycle/status aggregation tests;
- password/encryption security tests;
- API integration tests covering tenant isolation, updates, status publication, Discord and alert intake;
- an E2E smoke workflow;
- a PostgreSQL migration/store contract test when `DATABASE_URL` is present.

CI provides PostgreSQL, so the contract test runs there rather than skipping.

## Build verification

```bash
npm run build
```

Release 0.1 has no transpilation step. The build verifier parses every JavaScript module and verifies required release artifacts are present. The Docker image installs the locked PostgreSQL driver and runs source directly on Node 22.

## Security check

```bash
npm run check:secrets
```

This is a lightweight guard, not a replacement for repository/CI secret-scanning products.

## Typical workflow

1. Create a branch.
2. Make one scoped change.
3. Add/modify tests.
4. Run `npm run verify`.
5. If persistence changed, test `npm run migrate` against a clean PostgreSQL database.
6. Review tenant boundaries and public-data filtering before merge.
