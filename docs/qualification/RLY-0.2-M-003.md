# RLY-0.2-M-003 — Relay 0.2 release qualification

**Classification: `QUALIFIED_FOR_INTEGRATION`.** This is a release candidate for
review and integration, not a release tag or publication. M-001 and M-002 were
already merged into `main`; this pass did not rebuild either milestone.

## Identity and environment

| Item | Value |
| --- | --- |
| Source baseline | `main` at `b829cfb2dc6a16ce93111010604bb308907a719a` |
| Qualification branch | `release/rly-0.2-qualification` |
| Local run | 2026-09-29, Europe/Bucharest (UTC+03:00) |
| Host | Windows NT 10.0.26200.0; PowerShell 7.6.5 |
| Node / npm | v24.21.0 / 11.19.0 (supported `node >=22`) |
| Docker / Compose | 29.8.0 / v5.5.1 |
| Database | `postgres:16-alpine`, PostgreSQL 16.15, disposable test container and separate Compose database |
| Browser | Microsoft Edge 154.0.4258.37, Chromium CDP in headless mode |
| Product version | `0.2.0` in `package.json`, `package-lock.json`, `packages/shared/version.mjs`, health and OpenAPI |

All commands below ran from the repository root in PowerShell. The values in
the environment block are disposable qualification fixtures, not production
credentials. No live Discord, Slack or SMTP destination was configured.

```powershell
git fetch origin main
git switch -c release/rly-0.2-qualification
npm ci
npm run build
npm run check:secrets
$env:TZ='Pacific/Kiritimati'; node --test tests/oncall.test.mjs

docker run --name relay-qual-pg -e POSTGRES_DB=relay_test -e POSTGRES_USER=relay -e POSTGRES_PASSWORD=relay_test_password -p 127.0.0.1:5432:5432 -d postgres:16-alpine
$env:DATABASE_URL='postgres://relay:relay_test_password@127.0.0.1:5432/relay_test'
npm run migrate
npm test
npm run verify

$env:POSTGRES_PASSWORD='relay_compose_password'
$env:APP_ORIGIN='http://127.0.0.1:4000'
$env:COOKIE_SECURE='false'
$env:ALERT_INGEST_KEY='relay-ci-alert-key-not-production'
$env:INTEGRATION_ENCRYPTION_KEY='0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
$env:SEED_ADMIN_EMAIL='admin@relay.local'
$env:SEED_ADMIN_PASSWORD='relay-ci-seed-password-123'
$env:SEED_ORG_NAME='Relay Qualification'
docker compose build --no-cache relay
docker compose up -d
docker compose ps

$env:RELAY_VERIFY_BASE_URL='http://127.0.0.1:4000'
npm run verify:surface
$env:RELAY_BROWSER='C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$env:RELAY_BROWSER_SCREENSHOT_DIR='E:\Relay\.qualification-artifacts\browser'
npm run verify:browser
$env:RELAY_VERIFY_STATE_FILE='E:\Relay\.qualification-artifacts\production-state.json'
npm run verify:production
docker compose restart relay
npm run verify:restart
```

The Docker Desktop engine was initially stopped; starting the installed engine
made the PostgreSQL and Compose gates available. The initial `npm test` run
without `DATABASE_URL` passed 76 tests and skipped seven PostgreSQL cases. The
database-backed rerun below supersedes it.

## Gate results

| Gate | Command / evidence | Result |
| --- | --- | --- |
| Clean dependencies | `npm ci` | PASS; two packages installed, zero audit vulnerabilities |
| Source and release artifacts | `npm run build` | PASS; 31 JavaScript modules parsed; 51 browser CDP expressions parsed; version agreement checked |
| Fresh migration | `npm run migrate` with disposable PostgreSQL 16 | PASS; `001_initial.sql`, `002_alert_routing_oncall.sql`, `003_escalation_delivery.sql` applied |
| Complete automated suite | `npm test` with `DATABASE_URL` | PASS; **83 tests, 83 passed, 0 failed, 0 skipped** |
| Final aggregate gate after documentation edits | `npm run verify` with `DATABASE_URL` | PASS; build, 83/83 database-backed tests, and secret scan |
| Unit, auth, tenant and routing | Included in `npm test`: domain, security, authz, API integration, on-call, routing integration and routing E2E | PASS; cross-organization access and role boundaries exercised |
| Durable delivery and providers | Included in `npm test`: `durable-delivery.test.mjs`, `providers.test.mjs`, `escalation.test.mjs` | PASS; retries, permanent failures, manual retry, acknowledgement cancellation and hostile notification text exercised |
| PostgreSQL and migration contracts | Included in `npm test`: `postgres.contract.test.mjs`, `migration-upgrade.test.mjs` | PASS; populated 0.1 upgrade preserves data and 0.2 schema/store constraints hold |
| Concurrent workers and recovery | Included in `npm test`: `worker.qualification.test.mjs` | PASS; disjoint claims, lease reclaim, crash/restart recovery and acknowledgement ordering |
| Timezone independence | `TZ=Pacific/Kiritimati node --test tests/oncall.test.mjs` | PASS; 17/17 |
| Secret scan | `npm run check:secrets` | PASS; no known credential patterns |
| Production image and startup | `docker compose build --no-cache relay`; `docker compose up -d`; `docker compose ps` | PASS; Relay and PostgreSQL containers running, PostgreSQL healthy |
| OpenAPI and shipped surface | `npm run verify:surface` | PASS; health/package/OpenAPI `0.2.0`, 31 paths, 11 schemas, six SPA routes, five operator hooks, no checked secret string in shipped assets |
| Real browser, accessibility contracts and responsive layout | `npm run verify:browser` with Edge CDP | PASS; boot/MIME, keyboard and dialog focus, publication review, routing/delivery/escalation views, desktop 1440×900, laptop 1280×800, mobile 390×844, operator-route overflow and reduced motion |
| Production lifecycle | `npm run verify:production` against Compose | PASS; PostgreSQL-backed incident, status, on-call, routing, durable delivery and escalation journey |
| Restart durability | `docker compose restart relay`; `npm run verify:restart` | PASS; persisted incident, team, schedule, alert and delivery state reverified after process restart |

The full 83-test run is the explicit alert-routing, durable-delivery, provider,
migration, PostgreSQL, security, tenant and worker gate: every corresponding
test file ran with no skip. The browser pass exercised the real deployed app,
including the reduced-motion and keyboard contracts. Test transports simulated
provider acceptance/failure; no message was sent to a third party.

## Release-surface reconciliation

The repository had stale M-001-era prose describing M-002 as partial, with no
worker, retries, escalation or Slack/SMTP. The README, architecture,
development, on-call, escalation, security and 0.2 release docs were aligned to
the merged implementation. No product code or database migration changed.

The `0.2.0` declarations and deployed health/OpenAPI response agree. The
`v0.1.0` tag remains unchanged. No `v0.2.0` tag was created and nothing was
published.

## Deferred external gates

- **Live provider acceptance:** real Discord, Slack and SMTP endpoints were not
  configured. Provider payload validation, sanitization, failure classification
  and retry behavior passed with local test transports; delivery acceptance by
  a third-party service requires deployment-specific credentials and is not an
  automated release gate.
- **Integration decision:** review/merge of the qualification PR and the final
  tag/publication decision belong to the release owner. This ledger authorizes
  neither tagging nor publishing.

The local qualification has no technical blocker. GitHub's
`release-verification` workflow independently repeated the full gate on Linux
with Node 22, PostgreSQL 16, Docker Compose and Chrome.

## PR workflow

- [PR #6](https://github.com/MiniJe/Relay/pull/6), head commit
  `ff39d77a6f7b65858e9dbd0509871e81a899a4c4`.
- [Release-verification run 36614502121](https://github.com/MiniJe/Relay/actions/runs/36614502121):
  **PASS** on 2026-09-29 18:48:27 UTC. Clean install, build, fresh migration,
  complete PostgreSQL test suite, explicit schema/upgrade/timezone/routing
  contracts, secret scan, Docker build/startup, release surface, Chrome browser,
  production E2E and restart persistence all passed.
- [Relay CI run 36614502082](https://github.com/MiniJe/Relay/actions/runs/36614502082):
  **PASS** on the same head commit.

GitHub reported non-blocking runner notices about Node.js 20 action runtime
deprecation and an upcoming `ubuntu-latest` image change. They did not alter
the qualification result; future workflow maintenance can address them.
