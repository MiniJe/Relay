# RLY-0.2-M-002 qualification evidence

- Workflow run: https://github.com/MiniJe/Relay/actions/runs/36254880425
- Commit under test: `da65bd9e7bcfdbc45f14115d20ba45e98f908655`
- Branch: `arena/01a0de58-relay`
- Recorded at: 2026-09-26T16:17:59Z
- Runner: `Linux` with Docker Compose, `postgres:16-alpine` and a real Google Chrome

Every gate below ran against the real runtime (PostgreSQL, Docker Compose, Chrome);
no gate in this record was skipped.

## 00-versions

```text
node: v22.23.2
npm: 10.9.8
docker: Docker version 28.0.4, build b8034c0
compose: 2.38.2
postgres service image: postgres:16-alpine
google-chrome: Google Chrome 153.0.8010.52 
```

## 01-audit

```text
found 0 vulnerabilities
```

## 02-build

```text

> relay@0.2.0 build
> node scripts/build.mjs

Browser-qualification payloads verified: 51 CDP evaluate expressions parse.
Build verification passed: 31 JavaScript modules parsed; required Relay 0.2 artifacts present.
```

## 03-migrate

```text

> relay@0.2.0 migrate
> node packages/database/migrate.mjs

{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'constraint "integrations_provider_check" of relation "integrations" does not exist, skipping',
  file: 'tablecmds.c',
  line: '12298',
  routine: 'ATExecDropConstraint'
}
Applied migrations: 001_initial.sql, 002_alert_routing_oncall.sql, 003_escalation_delivery.sql
Known migrations: 001_initial.sql, 002_alert_routing_oncall.sql, 003_escalation_delivery.sql
```

## 04-tests-summary

```text
# tests 83
# suites 0
# pass 83
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

## 04-tests

```text

> relay@0.2.0 test
> node --test --test-concurrency=1 tests/*.test.mjs

TAP version 13
# Subtest: principal API workflow persists timeline, separates public updates, delivers Discord, and enforces tenant isolation
ok 1 - principal API workflow persists timeline, separates public updates, delivers Discord, and enforces tenant isolation
  ---
  duration_ms: 121.947599
  type: 'test'
  ...
# Subtest: resolved incidents cannot be silently reopened
ok 2 - resolved incidents cannot be silently reopened
  ---
  duration_ms: 35.153362
  type: 'test'
  ...
# Subtest: Discord delivery failure is non-destructive and does not log webhook secrets
ok 3 - Discord delivery failure is non-destructive and does not log webhook secrets
  ---
  duration_ms: 40.268791
  type: 'test'
  ...
# Subtest: server-side authorization allows only declared organization roles
ok 4 - server-side authorization allows only declared organization roles
  ---
  duration_ms: 0.744285
  type: 'test'
  ...
# Subtest: representative OWNER/ADMIN/RESPONDER/VIEWER permissions and tenant-scoped commander references are enforced by API
ok 5 - representative OWNER/ADMIN/RESPONDER/VIEWER permissions and tenant-scoped commander references are enforced by API
  ---
  duration_ms: 181.86318
  type: 'test'
  ...
# Subtest: incident lifecycle permits forward/coordination transitions and makes RESOLVED terminal
ok 6 - incident lifecycle permits forward/coordination transitions and makes RESOLVED terminal
  ---
  duration_ms: 0.672436
  type: 'test'
  ...
# Subtest: severity validation rejects unknown values
ok 7 - severity validation rejects unknown values
  ---
  duration_ms: 0.142575
  type: 'test'
  ...
# Subtest: public status aggregation derives incident impact without mutating component source state
ok 8 - public status aggregation derives incident impact without mutating component source state
  ---
  duration_ms: 0.191019
  type: 'test'
  ...
# Subtest: routing persists one logical delivery per configured channel before any provider call
ok 9 - routing persists one logical delivery per configured channel before any provider call
  ---
  duration_ms: 158.557512
  type: 'test'
  ...
# Subtest: a retryable failure retries at +1 minute and +5 minutes and then stops forever
ok 10 - a retryable failure retries at +1 minute and +5 minutes and then stops forever
  ---
  duration_ms: 102.854407
  type: 'test'
  ...
# Subtest: a permanent provider failure stops immediately and never retries
ok 11 - a permanent provider failure stops immediately and never retries
  ---
  duration_ms: 87.471601
  type: 'test'
  ...
# Subtest: manual retry keeps earlier attempts, records who asked, and is closed to VIEWER
ok 12 - manual retry keeps earlier attempts, records who asked, and is closed to VIEWER
  ---
  duration_ms: 96.323207
  type: 'test'
  ...
# Subtest: acknowledgement cancels unsent pages and leaves sent pages and attempts intact
ok 13 - acknowledgement cancels unsent pages and leaves sent pages and attempts intact
  ---
  duration_ms: 90.785965
  type: 'test'
  ...
# Subtest: Slack and email pages carry sanitized text and can never choose their own recipient
ok 14 - Slack and email pages carry sanitized text and can never choose their own recipient
  ---
  duration_ms: 88.934412
  type: 'test'
  ...
# Subtest: unusable destinations fail permanently with an operator-readable reason
ok 15 - unusable destinations fail permanently with an operator-readable reason
  ---
  duration_ms: 88.659491
  type: 'test'
  ...
# Subtest: E2E smoke: authenticate → service → component → incident → public page → resolve → postmortem
ok 16 - E2E smoke: authenticate → service → component → incident → public page → resolve → postmortem
  ---
  duration_ms: 71.857847
  type: 'test'
  ...
# Subtest: escalation steps are deterministic, strictly ordered and reject duplicate positions or times
ok 17 - escalation steps are deterministic, strictly ordered and reject duplicate positions or times
  ---
  duration_ms: 0.959871
  type: 'test'
  ...
# Subtest: plan due times are measured from original route and snapshot names
ok 18 - plan due times are measured from original route and snapshot names
  ---
  duration_ms: 0.361206
  type: 'test'
  ...
# Subtest: acknowledgement cancels pending work without rewriting completed history
ok 19 - acknowledgement cancels pending work without rewriting completed history
  ---
  duration_ms: 0.146522
  type: 'test'
  ...
# Subtest: retry policy is bounded and classifies transient provider failures
ok 20 - retry policy is bounded and classifies transient provider failures
  ---
  duration_ms: 0.108694
  type: 'test'
  ...
# Subtest: policy edits and deletion do not rewrite an already materialized plan
ok 21 - policy edits and deletion do not rewrite an already materialized plan
  ---
  duration_ms: 0.778366
  type: 'test'
  ...
# Subtest: unsupported configured channels fail closed instead of being misrouted to a real provider
ok 22 - unsupported configured channels fail closed instead of being misrouted to a real provider
  ---
  duration_ms: 0.180473
  type: 'test'
  ...
# Subtest: a supported but unconfigured channel reports a skip rather than borrowing another transport
ok 23 - a supported but unconfigured channel reports a skip rather than borrowing another transport
  ---
  duration_ms: 0.177097
  type: 'test'
  ...
# Subtest: provider text neutralizes mentions, controls and hostile Slack syntax
ok 24 - provider text neutralizes mentions, controls and hostile Slack syntax
  ---
  duration_ms: 0.242667
  type: 'test'
  ...
# Subtest: migration ordering is derived from filenames, not readdir order
ok 25 - migration ordering is derived from filenames, not readdir order
  ---
  duration_ms: 0.763003
  type: 'test'
  ...
# Subtest: migration runner discovers migration 003 after 001 and 002
ok 26 - migration runner discovers migration 003 after 001 and 002
  ---
  duration_ms: 3.774604
  type: 'test'
  ...
# Subtest: SQL statement splitting survives comments, strings and dollar-quoted bodies
ok 27 - SQL statement splitting survives comments, strings and dollar-quoted bodies
  ---
  duration_ms: 0.237769
  type: 'test'
  ...
# {
#   severity_local: 'NOTICE',
#   severity: 'NOTICE',
#   code: '42P07',
#   message: 'relation "schema_migrations" already exists, skipping',
#   file: 'parse_utilcmd.c',
#   line: '207',
#   routine: 'transformCreateStmt'
# }
# {
#   severity_local: 'NOTICE',
#   severity: 'NOTICE',
#   code: '00000',
#   message: 'constraint "integrations_provider_check" of relation "integrations" does not exist, skipping',
#   file: 'tablecmds.c',
#   line: '12298',
#   routine: 'ATExecDropConstraint'
# }
# {
#   severity_local: 'NOTICE',
#   severity: 'NOTICE',
#   code: '42P07',
#   message: 'relation "schema_migrations" already exists, skipping',
#   file: 'parse_utilcmd.c',
#   line: '207',
#   routine: 'transformCreateStmt'
# }
# Subtest: upgrading a populated Relay 0.1 database applies 002→003 and preserves all 0.1 data
ok 28 - upgrading a populated Relay 0.1 database applies 002→003 and preserves all 0.1 data
  ---
  duration_ms: 521.12657
  type: 'test'
  ...
# Subtest: timezone validation accepts IANA identifiers and rejects everything else
ok 29 - timezone validation accepts IANA identifiers and rejects everything else
  ---
  duration_ms: 10.017648
  type: 'test'
  ...
# Subtest: timezone rendering is explicit and independent of the host timezone
ok 30 - timezone rendering is explicit and independent of the host timezone
  ---
  duration_ms: 1.232663
  type: 'test'
  ...
# Subtest: rotation intervals are validated unambiguously in minutes
ok 31 - rotation intervals are validated unambiguously in minutes
  ---
  duration_ms: 0.191189
  type: 'test'
  ...
# Subtest: rotation selection is deterministic at period boundaries
ok 32 - rotation selection is deterministic at period boundaries
  ---
  duration_ms: 0.203177
  type: 'test'
  ...
# Subtest: rotation resolves correctly across many handoffs
ok 33 - rotation resolves correctly across many handoffs
  ---
  duration_ms: 0.399464
  type: 'test'
  ...
# Subtest: rotation period boundaries are absolute UTC instants
ok 34 - rotation period boundaries are absolute UTC instants
  ---
  duration_ms: 0.076245
  type: 'test'
  ...
# Subtest: a rotation that has not started yet resolves no responder
ok 35 - a rotation that has not started yet resolves no responder
  ---
  duration_ms: 0.058899
  type: 'test'
  ...
# Subtest: an empty rotation resolves no responder rather than guessing
ok 36 - an empty rotation resolves no responder rather than guessing
  ---
  duration_ms: 0.051558
  type: 'test'
  ...
# Subtest: upcoming handoffs are chronological and deterministic
ok 37 - upcoming handoffs are chronological and deterministic
  ---
  duration_ms: 0.290339
  type: 'test'
  ...
# Subtest: daylight saving cannot skip or duplicate a handoff
ok 38 - daylight saving cannot skip or duplicate a handoff
  ---
  duration_ms: 2.485145
  type: 'test'
  ...
# Subtest: an active override wins over the rotation without rewriting it
ok 39 - an active override wins over the rotation without rewriting it
  ---
  duration_ms: 0.285331
  type: 'test'
  ...
# Subtest: override windows are half-open and validated
ok 40 - override windows are half-open and validated
  ---
  duration_ms: 0.104218
  type: 'test'
  ...
# Subtest: overlapping overrides resolve deterministically instead of ambiguously
ok 41 - overlapping overrides resolve deterministically instead of ambiguously
  ---
  duration_ms: 0.527487
  type: 'test'
  ...
# Subtest: schedule state gates resolution
ok 42 - schedule state gates resolution
  ---
  duration_ms: 0.116526
  type: 'test'
  ...
# Subtest: rule ordering is explicit and never depends on row order
ok 43 - rule ordering is explicit and never depends on row order
  ---
  duration_ms: 0.177808
  type: 'test'
  ...
# Subtest: rule matching is exact, case-folded and has no expression language
ok 44 - rule matching is exact, case-folded and has no expression language
  ---
  duration_ms: 0.138609
  type: 'test'
  ...
# Subtest: the first matching rule in deterministic order wins
ok 45 - the first matching rule in deterministic order wins
  ---
  duration_ms: 0.146281
  type: 'test'
  ...
# {
#   severity_local: 'NOTICE',
#   severity: 'NOTICE',
#   code: '42P07',
#   message: 'relation "schema_migrations" already exists, skipping',
#   file: 'parse_utilcmd.c',
#   line: '207',
#   routine: 'transformCreateStmt'
# }
# Subtest: PostgreSQL migration/store contract
ok 46 - PostgreSQL migration/store contract
  ---
  duration_ms: 101.855793
  type: 'test'
  ...
# {
#   severity_local: 'NOTICE',
#   severity: 'NOTICE',
#   code: '42P07',
#   message: 'relation "schema_migrations" already exists, skipping',
#   file: 'parse_utilcmd.c',
#   line: '207',
#   routine: 'transformCreateStmt'
# }
# Subtest: PostgreSQL Relay 0.2 alert routing and on-call store contract
ok 47 - PostgreSQL Relay 0.2 alert routing and on-call store contract
  ---
  duration_ms: 350.310046
  type: 'test'
  ...
# Subtest: only Slack Incoming Webhook endpoints are stored or called
ok 48 - only Slack Incoming Webhook endpoints are stored or called
  ---
  duration_ms: 1.374377
  type: 'test'
  ...
# Subtest: Slack payloads neutralize every alert-controlled mention primitive
ok 49 - Slack payloads neutralize every alert-controlled mention primitive
  ---
  duration_ms: 0.621089
  type: 'test'
  ...
# Subtest: Slack delivery attaches an HTTP status so the retry policy can classify it
ok 50 - Slack delivery attaches an HTTP status so the retry policy can classify it
  ---
  duration_ms: 10.172021
  type: 'test'
  ...
# Subtest: SMTP messages carry a safe recipient, subject and body and never expose the password
ok 51 - SMTP messages carry a safe recipient, subject and body and never expose the password
  ---
  duration_ms: 0.868873
  type: 'test'
  ...
# Subtest: an alert can never choose its own email recipient
ok 52 - an alert can never choose its own email recipient
  ---
  duration_ms: 0.216267
  type: 'test'
  ...
# Subtest: SMTP failures classify temporary, permanent and authentication responses correctly
ok 53 - SMTP failures classify temporary, permanent and authentication responses correctly
  ---
  duration_ms: 0.527097
  type: 'test'
  ...
# Subtest: SMTP configuration is validated without ever echoing secrets back
ok 54 - SMTP configuration is validated without ever echoing secrets back
  ---
  duration_ms: 0.499274
  type: 'test'
  ...
# Subtest: the bounded retry plan is deterministic and terminal at the limit
ok 55 - the bounded retry plan is deterministic and terminal at the limit
  ---
  duration_ms: 0.68178
  type: 'test'
  ...
# Subtest: E2E: alert → routing rule → on-call schedule → responder → notification → acknowledgement → incident
ok 56 - E2E: alert → routing rule → on-call schedule → responder → notification → acknowledgement → incident
  ---
  duration_ms: 258.000494
  type: 'test'
  ...
# Subtest: an ingested alert is routed, resolved to the on-call responder, recorded and notified
ok 57 - an ingested alert is routed, resolved to the on-call responder, recorded and notified
  ---
  duration_ms: 219.84103
  type: 'test'
  ...
# Subtest: a Discord identity mapping adds a real mention and stays inside the allowed list
ok 58 - a Discord identity mapping adds a real mention and stays inside the allowed list
  ---
  duration_ms: 177.32284
  type: 'test'
  ...
# Subtest: the on-call answer is deterministic across handoffs and queryable at any timestamp
ok 59 - the on-call answer is deterministic across handoffs and queryable at any timestamp
  ---
  duration_ms: 178.547607
  type: 'test'
  ...
# Subtest: overrides take precedence, reject overlaps, and the rotation resumes unchanged
ok 60 - overrides take precedence, reject overlaps, and the rotation resumes unchanged
  ---
  duration_ms: 184.246644
  type: 'test'
  ...
# Subtest: rule precedence, non-matching alerts and disabled rules behave deterministically
ok 61 - rule precedence, non-matching alerts and disabled rules behave deterministically
  ---
  duration_ms: 194.543343
  type: 'test'
  ...
# Subtest: a disabled schedule or an empty rotation resolves nobody instead of guessing
ok 62 - a disabled schedule or an empty rotation resolves nobody instead of guessing
  ---
  duration_ms: 171.96074
  type: 'test'
  ...
# Subtest: retried and concurrent intake of the same alert never duplicates routing or notification
ok 63 - retried and concurrent intake of the same alert never duplicates routing or notification
  ---
  duration_ms: 180.926069
  type: 'test'
  ...
# Subtest: notification failure never rolls back the alert and never leaks the webhook secret
ok 64 - notification failure never rolls back the alert and never leaks the webhook secret
  ---
  duration_ms: 173.711234
  type: 'test'
  ...
# Subtest: acknowledgement is authorized, idempotent, and never conflated with incident resolution
ok 65 - acknowledgement is authorized, idempotent, and never conflated with incident resolution
  ---
  duration_ms: 181.208695
  type: 'test'
  ...
# Subtest: alerts that predate routing can be evaluated explicitly, then acknowledged
ok 66 - alerts that predate routing can be evaluated explicitly, then acknowledged
  ---
  duration_ms: 171.224959
  type: 'test'
  ...
# Subtest: historical routing records never change when the rotation, rule or schedule changes later
ok 67 - historical routing records never change when the rotation, rule or schedule changes later
  ---
  duration_ms: 176.416889
  type: 'test'
  ...
# Subtest: cross-organization access to teams, schedules, rules and alerts is refused
ok 68 - cross-organization access to teams, schedules, rules and alerts is refused
  ---
  duration_ms: 212.196302
  type: 'test'
  ...
# Subtest: configuration authority follows the existing role model
ok 69 - configuration authority follows the existing role model
  ---
  duration_ms: 259.6728
  type: 'test'
  ...
# Subtest: malformed timezones, intervals, Discord ids and hostile rule or alert input are rejected
ok 70 - malformed timezones, intervals, Discord ids and hostile rule or alert input are rejected
  ---
  duration_ms: 258.641924
  type: 'test'
  ...
# Subtest: creating an incident from an alert is explicit, traceable and cannot be repeated
ok 71 - creating an incident from an alert is explicit, traceable and cannot be repeated
  ---
  duration_ms: 176.799537
  type: 'test'
  ...
# Subtest: public status surfaces expose none of the internal on-call configuration
ok 72 - public status surfaces expose none of the internal on-call configuration
  ---
  duration_ms: 189.352254
  type: 'test'
  ...
# Subtest: passwords use salted scrypt and verify safely
ok 73 - passwords use salted scrypt and verify safely
  ---
  duration_ms: 93.246027
  type: 'test'
  ...
# Subtest: integration secrets round-trip with AES-GCM and reject tampering
ok 74 - integration secrets round-trip with AES-GCM and reject tampering
  ---
  duration_ms: 1.027431
  type: 'test'
  ...
# Subtest: public renderer escapes representative user-controlled status content before HTML insertion
ok 75 - public renderer escapes representative user-controlled status content before HTML insertion
  ---
  duration_ms: 3.368927
  type: 'test'
  ...
# Subtest: static assets win over application document routes and preserve MIME/body integrity
ok 76 - static assets win over application document routes and preserve MIME/body integrity
  ---
  duration_ms: 23.74538
  type: 'test'
  ...
# Subtest: only supported SPA document routes receive the application shell
ok 77 - only supported SPA document routes receive the application shell
  ---
  duration_ms: 3022.930926
  type: 'test'
  ...
# Subtest: missing assets and unsupported document-like paths return 404 instead of the shell
ok 78 - missing assets and unsupported document-like paths return 404 instead of the shell
  ---
  duration_ms: 17.025818
  type: 'test'
  ...
# Subtest: path traversal never serves files outside the static directory
ok 79 - path traversal never serves files outside the static directory
  ---
  duration_ms: 7.772368
  type: 'test'
  ...
# {
#   severity_local: 'NOTICE',
#   severity: 'NOTICE',
#   code: '42P07',
#   message: 'relation "schema_migrations" already exists, skipping',
#   file: 'parse_utilcmd.c',
#   line: '207',
#   routine: 'transformCreateStmt'
# }
# Subtest: concurrent workers claim disjoint work and never page the same responder twice
ok 80 - concurrent workers claim disjoint work and never page the same responder twice
  ---
  duration_ms: 345.831984
  type: 'test'
  ...
# {
#   severity_local: 'NOTICE',
#   severity: 'NOTICE',
#   code: '42P07',
#   message: 'relation "schema_migrations" already exists, skipping',
#   file: 'parse_utilcmd.c',
#   line: '207',
#   routine: 'transformCreateStmt'
# }
# Subtest: an expired lease is reclaimed after a crash and the dead worker cannot overwrite the new outcome
ok 81 - an expired lease is reclaimed after a crash and the dead worker cannot overwrite the new outcome
  ---
  duration_ms: 96.999087
  type: 'test'
  ...
# {
#   severity_local: 'NOTICE',
#   severity: 'NOTICE',
#   code: '42P07',
#   message: 'relation "schema_migrations" already exists, skipping',
#   file: 'parse_utilcmd.c',
#   line: '207',
#   routine: 'transformCreateStmt'
# }
# Subtest: a restarted worker recovers abandoned work and keeps one immutable attempt per provider call
ok 82 - a restarted worker recovers abandoned work and keeps one immutable attempt per provider call
  ---
  duration_ms: 132.653719
  type: 'test'
  ...
# {
#   severity_local: 'NOTICE',
#   severity: 'NOTICE',
#   code: '42P07',
#   message: 'relation "schema_migrations" already exists, skipping',
#   file: 'parse_utilcmd.c',
#   line: '207',
#   routine: 'transformCreateStmt'
# }
# Subtest: an acknowledgement cancels unexecuted escalation steps and no page is ever created after it commits
ok 83 - an acknowledgement cancels unexecuted escalation steps and no page is ever created after it commits
  ---
  duration_ms: 162.684291
  type: 'test'
  ...
1..83
# tests 83
# suites 0
# pass 83
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 10102.145397
```

## 05-migration-upgrade

```text

> relay@0.2.0 verify:migration
> node --test tests/migration-upgrade.test.mjs

TAP version 13
# Subtest: migration ordering is derived from filenames, not readdir order
ok 1 - migration ordering is derived from filenames, not readdir order
  ---
  duration_ms: 0.844005
  type: 'test'
  ...
# Subtest: migration runner discovers migration 003 after 001 and 002
ok 2 - migration runner discovers migration 003 after 001 and 002
  ---
  duration_ms: 4.52237
  type: 'test'
  ...
# Subtest: SQL statement splitting survives comments, strings and dollar-quoted bodies
ok 3 - SQL statement splitting survives comments, strings and dollar-quoted bodies
  ---
  duration_ms: 0.343349
  type: 'test'
  ...
# {
#   severity_local: 'NOTICE',
#   severity: 'NOTICE',
#   code: '42P07',
#   message: 'relation "schema_migrations" already exists, skipping',
#   file: 'parse_utilcmd.c',
#   line: '207',
#   routine: 'transformCreateStmt'
# }
# {
#   severity_local: 'NOTICE',
#   severity: 'NOTICE',
#   code: '00000',
#   message: 'constraint "integrations_provider_check" of relation "integrations" does not exist, skipping',
#   file: 'tablecmds.c',
#   line: '12298',
#   routine: 'ATExecDropConstraint'
# }
# {
#   severity_local: 'NOTICE',
#   severity: 'NOTICE',
#   code: '42P07',
#   message: 'relation "schema_migrations" already exists, skipping',
#   file: 'parse_utilcmd.c',
#   line: '207',
#   routine: 'transformCreateStmt'
# }
# Subtest: upgrading a populated Relay 0.1 database applies 002→003 and preserves all 0.1 data
ok 4 - upgrading a populated Relay 0.1 database applies 002→003 and preserves all 0.1 data
  ---
  duration_ms: 631.577848
  type: 'test'
  ...
1..4
# tests 4
# suites 0
# pass 4
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 677.764448
```

## 06-worker-qualification

```text
TAP version 13
# {
#   severity_local: 'NOTICE',
#   severity: 'NOTICE',
#   code: '42P07',
#   message: 'relation "schema_migrations" already exists, skipping',
#   file: 'parse_utilcmd.c',
#   line: '207',
#   routine: 'transformCreateStmt'
# }
# Subtest: concurrent workers claim disjoint work and never page the same responder twice
ok 1 - concurrent workers claim disjoint work and never page the same responder twice
  ---
  duration_ms: 365.548477
  type: 'test'
  ...
# {
#   severity_local: 'NOTICE',
#   severity: 'NOTICE',
#   code: '42P07',
#   message: 'relation "schema_migrations" already exists, skipping',
#   file: 'parse_utilcmd.c',
#   line: '207',
#   routine: 'transformCreateStmt'
# }
# Subtest: an expired lease is reclaimed after a crash and the dead worker cannot overwrite the new outcome
ok 2 - an expired lease is reclaimed after a crash and the dead worker cannot overwrite the new outcome
  ---
  duration_ms: 99.739247
  type: 'test'
  ...
# {
#   severity_local: 'NOTICE',
#   severity: 'NOTICE',
#   code: '42P07',
#   message: 'relation "schema_migrations" already exists, skipping',
#   file: 'parse_utilcmd.c',
#   line: '207',
#   routine: 'transformCreateStmt'
# }
# Subtest: a restarted worker recovers abandoned work and keeps one immutable attempt per provider call
ok 3 - a restarted worker recovers abandoned work and keeps one immutable attempt per provider call
  ---
  duration_ms: 136.004123
  type: 'test'
  ...
# {
#   severity_local: 'NOTICE',
#   severity: 'NOTICE',
#   code: '42P07',
#   message: 'relation "schema_migrations" already exists, skipping',
#   file: 'parse_utilcmd.c',
#   line: '207',
#   routine: 'transformCreateStmt'
# }
# Subtest: an acknowledgement cancels unexecuted escalation steps and no page is ever created after it commits
ok 4 - an acknowledgement cancels unexecuted escalation steps and no page is ever created after it commits
  ---
  duration_ms: 126.099639
  type: 'test'
  ...
1..4
# tests 4
# suites 0
# pass 4
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 773.036831
```

## 07-oncall-non-utc

```text
TAP version 13
# Subtest: timezone validation accepts IANA identifiers and rejects everything else
ok 1 - timezone validation accepts IANA identifiers and rejects everything else
  ---
  duration_ms: 9.766676
  type: 'test'
  ...
# Subtest: timezone rendering is explicit and independent of the host timezone
ok 2 - timezone rendering is explicit and independent of the host timezone
  ---
  duration_ms: 1.243899
  type: 'test'
  ...
# Subtest: rotation intervals are validated unambiguously in minutes
ok 3 - rotation intervals are validated unambiguously in minutes
  ---
  duration_ms: 0.22463
  type: 'test'
  ...
# Subtest: rotation selection is deterministic at period boundaries
ok 4 - rotation selection is deterministic at period boundaries
  ---
  duration_ms: 0.208125
  type: 'test'
  ...
# Subtest: rotation resolves correctly across many handoffs
ok 5 - rotation resolves correctly across many handoffs
  ---
  duration_ms: 0.379373
  type: 'test'
  ...
# Subtest: rotation period boundaries are absolute UTC instants
ok 6 - rotation period boundaries are absolute UTC instants
  ---
  duration_ms: 0.077998
  type: 'test'
  ...
# Subtest: a rotation that has not started yet resolves no responder
ok 7 - a rotation that has not started yet resolves no responder
  ---
  duration_ms: 0.077217
  type: 'test'
  ...
# Subtest: an empty rotation resolves no responder rather than guessing
ok 8 - an empty rotation resolves no responder rather than guessing
  ---
  duration_ms: 0.054102
  type: 'test'
  ...
# Subtest: upcoming handoffs are chronological and deterministic
ok 9 - upcoming handoffs are chronological and deterministic
  ---
  duration_ms: 0.289087
  type: 'test'
  ...
# Subtest: daylight saving cannot skip or duplicate a handoff
ok 10 - daylight saving cannot skip or duplicate a handoff
  ---
  duration_ms: 2.539626
  type: 'test'
  ...
# Subtest: an active override wins over the rotation without rewriting it
ok 11 - an active override wins over the rotation without rewriting it
  ---
  duration_ms: 0.295888
  type: 'test'
  ...
# Subtest: override windows are half-open and validated
ok 12 - override windows are half-open and validated
  ---
  duration_ms: 0.101454
  type: 'test'
  ...
# Subtest: overlapping overrides resolve deterministically instead of ambiguously
ok 13 - overlapping overrides resolve deterministically instead of ambiguously
  ---
  duration_ms: 0.558844
  type: 'test'
  ...
# Subtest: schedule state gates resolution
ok 14 - schedule state gates resolution
  ---
  duration_ms: 0.126151
  type: 'test'
  ...
# Subtest: rule ordering is explicit and never depends on row order
ok 15 - rule ordering is explicit and never depends on row order
  ---
  duration_ms: 0.179652
  type: 'test'
  ...
# Subtest: rule matching is exact, case-folded and has no expression language
ok 16 - rule matching is exact, case-folded and has no expression language
  ---
  duration_ms: 0.124428
  type: 'test'
  ...
# Subtest: the first matching rule in deterministic order wins
ok 17 - the first matching rule in deterministic order wins
  ---
  duration_ms: 0.12575
  type: 'test'
  ...
1..17
# tests 17
# suites 0
# pass 17
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 57.566562
```

## 08-secret-scan

```text

> relay@0.2.0 check:secrets
> node scripts/secret-scan.mjs

Secret scan passed: no known credential patterns detected.
```

## 09-image-build

```text
#7 sha256:d39db1cf9caa4f49c5a2e67111fbe6e0d5eea8ede550cb82f3dc2b79712688d6 447B / 447B 0.1s done
#7 sha256:f7f2d304681aaa935c9cfd180850cf616ae843efce7682873d6521ded7268937 55.59MB / 55.59MB 0.4s
#7 sha256:e554276b05e6306c5ad33cd85bfa7f0693083e21f6114db5abf60a20fb413039 1.26MB / 1.26MB 0.3s done
#7 sha256:f7f2d304681aaa935c9cfd180850cf616ae843efce7682873d6521ded7268937 55.59MB / 55.59MB 0.6s done
#7 extracting sha256:f7f2d304681aaa935c9cfd180850cf616ae843efce7682873d6521ded7268937 0.1s
#7 extracting sha256:f7f2d304681aaa935c9cfd180850cf616ae843efce7682873d6521ded7268937 0.8s done
#7 extracting sha256:e554276b05e6306c5ad33cd85bfa7f0693083e21f6114db5abf60a20fb413039
#7 extracting sha256:e554276b05e6306c5ad33cd85bfa7f0693083e21f6114db5abf60a20fb413039 0.0s done
#7 extracting sha256:d39db1cf9caa4f49c5a2e67111fbe6e0d5eea8ede550cb82f3dc2b79712688d6 done
#7 DONE 2.5s

#8 [2/5] WORKDIR /app
#8 DONE 0.0s

#9 [3/5] COPY package.json package-lock.json ./
#9 DONE 0.0s

#10 [4/5] RUN npm ci --omit=dev --no-audit --no-fund
#10 0.563 
#10 0.563 added 2 packages in 425ms
#10 0.564 npm notice
#10 0.564 npm notice New major version of npm available! 10.9.9 -> 12.1.0
#10 0.564 npm notice Changelog: https://github.com/npm/cli/releases/tag/v12.1.0
#10 0.564 npm notice To update run: npm install -g npm@12.1.0
#10 0.564 npm notice
#10 DONE 0.7s

#11 [5/5] COPY . .
#11 DONE 0.0s

#12 exporting to image
#12 exporting layers
#12 exporting layers 0.2s done
#12 writing image sha256:76c05279aba53cccabd8cf3c1db42d24bbfa53b5d594fd023666fd56c4017363 done
#12 naming to docker.io/library/relay-relay done
#12 DONE 0.2s

#13 resolving provenance for metadata file
#13 DONE 0.0s
 relay  Built
```

## 10-compose-up

```text
 Network relay_default  Creating
 Network relay_default  Created
 Volume "relay_relay-postgres"  Creating
 Volume "relay_relay-postgres"  Created
 Container relay-postgres-1  Creating
 Container relay-postgres-1  Created
 Container relay-relay-1  Creating
 Container relay-relay-1  Created
 Container relay-postgres-1  Starting
 Container relay-postgres-1  Started
 Container relay-postgres-1  Waiting
 Container relay-postgres-1  Healthy
 Container relay-relay-1  Starting
 Container relay-relay-1  Started
```

## 11-compose-ps

```text
{"Command":"\"docker-entrypoint.s…\"","CreatedAt":"2026-09-26 16:17:22 +0000 UTC","ExitCode":0,"Health":"healthy","ID":"841f59ae2dff","Image":"postgres:16-alpine","Labels":"com.docker.compose.oneoff=False,com.docker.compose.project=relay,com.docker.compose.project.config_files=/home/runner/work/Relay/Relay/docker-compose.yml,com.docker.compose.project.working_dir=/home/runner/work/Relay/Relay,com.docker.compose.container-number=1,com.docker.compose.depends_on=,com.docker.compose.image=sha256:81bd698b4594e751a3269e4dcd3e03a4a0ec0daf7b72e7aa1abd43cce9887542,com.docker.compose.config-hash=8000c8a4a9b3b3efd8e02388791910a7e8ba601e946815c00428b8ac56634f84,com.docker.compose.service=postgres,com.docker.compose.version=2.38.2","LocalVolumes":"1","Mounts":"relay_relay-po…","Name":"relay-postgres-1","Names":"relay-postgres-1","Networks":"relay_default","Ports":"5432/tcp","Project":"relay","Publishers":[{"URL":"","TargetPort":5432,"PublishedPort":0,"Protocol":"tcp"}],"RunningFor":"6 seconds ago","Service":"postgres","Size":"0B","State":"running","Status":"Up 5 seconds (healthy)"}
{"Command":"\"docker-entrypoint.s…\"","CreatedAt":"2026-09-26 16:17:22 +0000 UTC","ExitCode":0,"Health":"","ID":"dfc5a77c4236","Image":"relay-relay","Labels":"com.docker.compose.project=relay,com.docker.compose.project.config_files=/home/runner/work/Relay/Relay/docker-compose.yml,com.docker.compose.project.working_dir=/home/runner/work/Relay/Relay,com.docker.compose.service=relay,com.docker.compose.version=2.38.2,com.docker.compose.config-hash=a0dd1f2d82cabc3c6cc1725ccc0b39421542635e835eacd8ecc539699b6634c6,com.docker.compose.container-number=1,com.docker.compose.oneoff=False,com.docker.compose.depends_on=postgres:service_healthy:false,com.docker.compose.image=sha256:76c05279aba53cccabd8cf3c1db42d24bbfa53b5d594fd023666fd56c4017363","LocalVolumes":"0","Mounts":"","Name":"relay-relay-1","Names":"relay-relay-1","Networks":"relay_default","Ports":"0.0.0.0:4000-\u003e4000/tcp, [::]:4000-\u003e4000/tcp","Project":"relay","Publishers":[{"URL":"0.0.0.0","TargetPort":4000,"PublishedPort":4000,"Protocol":"tcp"},{"URL":"::","TargetPort":4000,"PublishedPort":4000,"Protocol":"tcp"}],"RunningFor":"6 seconds ago","Service":"relay","Size":"0B","State":"running","Status":"Up Less than a second"}
```

## 12-health

```text
{"ok":true,"version":"0.2.0"}```

## 13-reachability

```text
index.html served; openapi.json 28989 bytes
```

## 14-release-surface

```text

> relay@0.2.0 verify:surface
> node scripts/verify-release-surface.mjs

Release surface PASS: Relay 0.2.0 — health, package.json and OpenAPI agree; 31 documented 0.2 paths; 11 schemas; 6 SPA routes; 5 operator hooks; no secrets in shipped assets.
```

## 15-browser-smoke

```text

> relay@0.2.0 verify:browser
> node scripts/browser-smoke.mjs

Relay browser smoke against http://127.0.0.1:4000
  ok  API health responds ok:true
  ok  root document is HTML

[anonymous] / boots the application shell
  ok  root route replaces the boot placeholder (module script executed)
  ok  module script executed real application code
  ok  JavaScript assets answered with JavaScript MIME type
  ok  CSS assets answered with CSS MIME type
  ok  stylesheet actually applied (font-family resolved)

[anonymous] API reachable from the browser context
  ok  in-page fetch /api/v1/health ok
  ok  in-page fetch /api/v1/openapi.json is a valid OpenAPI document
  ok  root route free of console/exception/MIME/request failures

[anonymous] sign-in and register render usable forms
  ok  /signin renders the sign-in form
  ok  /signin free of console/exception/MIME/request failures
  ok  keyboard Tab reaches the email field
  ok  focused control shows a visible focus indicator
  ok  /register renders the registration form
  ok  /register free of console/exception/MIME/request failures

[anonymous] deep links and missing data degrade safely
  ok  deep link to protected /app recovers to the sign-in view
  ok  /app deep link free of console/exception/MIME/request failures
  ok  missing status slug is not rendered as healthy
  ok  missing status slug shows a recoverable error surface
  ok  missing status slug causes no MIME/network failures

[responsive] viewport sweep
  ok  no page-level horizontal overflow at desktop 1440x900 on /
  ok  no page-level horizontal overflow at desktop 1440x900 on /signin
      screenshot: /tmp/relay-browser-smoke/signin-desktop.png
  ok  no page-level horizontal overflow at laptop 1280x800 on /
  ok  no page-level horizontal overflow at laptop 1280x800 on /signin
      screenshot: /tmp/relay-browser-smoke/signin-laptop.png
  ok  no page-level horizontal overflow at mobile 390x844 on /
  ok  no page-level horizontal overflow at mobile 390x844 on /signin
      screenshot: /tmp/relay-browser-smoke/signin-mobile.png

[operator] authenticated workspace pass
  ok  sign-in form reaches the workspace
  ok  workspace shell renders (sidebar + topbar + content)
  ok  dashboard free of console/exception/MIME/request failures
  ok  operator can provision service, component and status page via API
  ok  create-incident dialog opens
  ok  dialog focus is placed inside the dialog
  ok  dialog closes on Escape
  ok  dialog restores focus to the invoking control
  ok  incident declared through the dialog opens the incident workspace
  ok  incident dialog pass free of console/exception/MIME/request failures
  ok  internal note publishes without a review gate
  ok  public update opens the review dialog instead of publishing
  ok  review dialog shows the composed message
  ok  review dialog shows the truthful destination status page
  ok  review dialog exposes an explicit publish action
  ok  public update is not yet visible in the update history
  ok  explicit publish action posts the public update
  ok  public-update flow free of console/exception/MIME/request failures
  ok  public status page leads with a readable status label (not color alone)
  ok  public status page does not claim all systems operational during impact
  ok  public status page lists the incident with its public update
  ok  every status badge carries a text label
  ok  public status page free of console/exception/MIME/request failures
      screenshot: /tmp/relay-browser-smoke/status-page-desktop.png

[relay-0.2] alert routing and on-call surfaces
  ok  operator can provision team, membership, schedule, override and routing rule via API
  ok  an overlapping override is refused deterministically
  ok  a malformed schedule timezone is rejected before it reaches the UI
  ok  on-call state resolves a responder server-side
  ok  on-call state reports the schedule IANA timezone
  ok  alert ingested through the keyed endpoint is routed to the on-call responder
  ok  the routing response never echoes the ingest key
  ok  the only network noise from provisioning is the two deliberate rejections
  ok  on-call view answers "who is on call now" with a named responder
  ok  on-call view renders handoff times in the schedule timezone, not server-local time
  ok  on-call view surfaces the next handoff
  ok  on-call view renders its hero and one row per schedule
  ok  on-call view exposes rotation detail, override and enable/disable actions
  ok  opening a schedule loads its ordered rotation
  ok  rotation detail lists participants in configured order
  ok  rotation detail renders in the schedule timezone
  ok  rotation detail lists the schedule override with its reason
  ok  rotation detail offers override deletion to an OWNER
  ok  on-call view free of console/exception/MIME/request failures
      screenshot: /tmp/relay-browser-smoke/oncall-desktop.png
  ok  teams view lists the team and its roster
  ok  teams view exposes the create-team form to an OWNER
  ok  teams view free of console/exception/MIME/request failures
  ok  routing view lists configured rules
  ok  routing rule form exposes name, priority, conditions and target
  ok  routing rule form exposes Discord, Slack and Email channels plus an escalation policy
  ok  routing view offers an ordered escalation policy editor
  ok  routing view states that an unconfigured channel fails closed rather than being rerouted
  ok  routing view free of console/exception/MIME/request failures
  ok  alerts view reports routed, unacknowledged and failed-delivery counts
  ok  alerts table scrolls horizontally inside its wrapper rather than the page
  ok  alerts table shows the routed alert, its routing path and its responder
  ok  alerts table exposes acknowledge and escalate actions to a responder
  ok  acknowledging from the alerts table updates the row without a reload
  ok  alerts view free of console/exception/MIME/request failures
      screenshot: /tmp/relay-browser-smoke/alerts-desktop.png
  ok  alert detail renders its routing, delivery and escalation summary
  ok  alert detail lists a durable delivery row per channel
  ok  alert detail shows delivery state as a readable label, never a raw token
  ok  alert detail exposes the escalation plan section
  ok  alert detail links back to the alerts table
  ok  alert detail offers a manual retry for a page that was not delivered
  ok  alert detail free of console/exception/MIME/request failures
  ok  escalations view reports scheduled, executed, cancelled and unresolved steps
  ok  escalations view states that reading it never re-resolves on-call state
  ok  escalations view renders its tables
  ok  escalations view free of console/exception/MIME/request failures
  ok  settings exposes a Slack Incoming Webhook section
  ok  settings exposes an SMTP section with a blank password field
  ok  settings states that a responder is only ever emailed at their own account address
  ok  settings free of console/exception/MIME/request failures
  ok  sidebar exposes Alerts at /app/alerts
  ok  sidebar exposes Escalations at /app/escalations
  ok  sidebar exposes On-call at /app/oncall
  ok  sidebar exposes Teams at /app/teams
  ok  sidebar exposes Routing at /app/routing
  ok  deep link /app/alerts renders its own view
  ok  deep link /app/escalations renders its own view
  ok  deep link /app/oncall renders its own view
  ok  deep link /app/teams renders its own view
  ok  deep link /app/routing renders its own view
  ok  no page-level horizontal overflow at desktop on /app
  ok  no page-level horizontal overflow at desktop on /app/alerts
  ok  no page-level horizontal overflow at desktop on /app/escalations
  ok  no page-level horizontal overflow at desktop on /app/oncall
  ok  no page-level horizontal overflow at desktop on /app/incidents
  ok  no page-level horizontal overflow at desktop on /app/services
  ok  no page-level horizontal overflow at desktop on /app/components
  ok  no page-level horizontal overflow at desktop on /app/teams
  ok  no page-level horizontal overflow at desktop on /app/routing
  ok  no page-level horizontal overflow at desktop on /app/status-pages
      screenshot: /tmp/relay-browser-smoke/dashboard-desktop.png
  ok  no page-level horizontal overflow at mobile on /app
  ok  no page-level horizontal overflow at mobile on /app/alerts
  ok  no page-level horizontal overflow at mobile on /app/escalations
  ok  no page-level horizontal overflow at mobile on /app/oncall
  ok  no page-level horizontal overflow at mobile on /app/incidents
  ok  no page-level horizontal overflow at mobile on /app/services
  ok  no page-level horizontal overflow at mobile on /app/components
  ok  no page-level horizontal overflow at mobile on /app/teams
  ok  no page-level horizontal overflow at mobile on /app/routing
  ok  no page-level horizontal overflow at mobile on /app/status-pages
      screenshot: /tmp/relay-browser-smoke/dashboard-mobile.png
  ok  motion is disabled under prefers-reduced-motion: reduce

[summary]
Browser smoke passed: boot, MIME, routing, keyboard, dialog, publication review, alert routing, durable delivery, escalation, integration, responsive and reduced-motion contracts verified.
```

## 16-production-e2e

```text

> relay@0.2.0 verify:production
> node scripts/production-e2e.mjs initial

Production E2E PASS: {"organizationId":"96d54666-0491-45da-9784-f37a20e80dc3","incidentId":"84471b5a-b3e0-4c7e-b6ba-7a2dcd4b231e","statusSlug":"release-muilfpge-249ae579","teamId":"00ecf3ce-52d0-41d4-a19d-a628b6d3778d","scheduleId":"170d6437-a187-4616-a674-d389affdcb15","alertId":"0db037b3-4390-4502-ac4d-134cf807d814"}
```

## 17-restart

```text
 Container relay-relay-1  Restarting
 Container relay-relay-1  Started
```

## 18-health-after-restart

```text
relay healthy after restart (attempt 2)
```

## 19-restart-verification

```text

> relay@0.2.0 verify:restart
> node scripts/production-e2e.mjs restart

Restart persistence PASS: {"organizationId":"96d54666-0491-45da-9784-f37a20e80dc3","incidentId":"84471b5a-b3e0-4c7e-b6ba-7a2dcd4b231e","teamId":"00ecf3ce-52d0-41d4-a19d-a628b6d3778d","scheduleId":"170d6437-a187-4616-a674-d389affdcb15","alertId":"0db037b3-4390-4502-ac4d-134cf807d814"}
```

## 20-compose-ps-final

```text
{"Command":"\"docker-entrypoint.s…\"","CreatedAt":"2026-09-26 16:17:22 +0000 UTC","ExitCode":0,"Health":"healthy","ID":"841f59ae2dff","Image":"postgres:16-alpine","Labels":"com.docker.compose.project.config_files=/home/runner/work/Relay/Relay/docker-compose.yml,com.docker.compose.version=2.38.2,com.docker.compose.config-hash=8000c8a4a9b3b3efd8e02388791910a7e8ba601e946815c00428b8ac56634f84,com.docker.compose.container-number=1,com.docker.compose.project=relay,com.docker.compose.project.working_dir=/home/runner/work/Relay/Relay,com.docker.compose.service=postgres,com.docker.compose.depends_on=,com.docker.compose.image=sha256:81bd698b4594e751a3269e4dcd3e03a4a0ec0daf7b72e7aa1abd43cce9887542,com.docker.compose.oneoff=False","LocalVolumes":"1","Mounts":"relay_relay-po…","Name":"relay-postgres-1","Names":"relay-postgres-1","Networks":"relay_default","Ports":"5432/tcp","Project":"relay","Publishers":[{"URL":"","TargetPort":5432,"PublishedPort":0,"Protocol":"tcp"}],"RunningFor":"37 seconds ago","Service":"postgres","Size":"0B","State":"running","Status":"Up 37 seconds (healthy)"}
{"Command":"\"docker-entrypoint.s…\"","CreatedAt":"2026-09-26 16:17:22 +0000 UTC","ExitCode":0,"Health":"","ID":"dfc5a77c4236","Image":"relay-relay","Labels":"com.docker.compose.config-hash=a0dd1f2d82cabc3c6cc1725ccc0b39421542635e835eacd8ecc539699b6634c6,com.docker.compose.container-number=1,com.docker.compose.oneoff=False,com.docker.compose.project=relay,com.docker.compose.service=relay,com.docker.compose.depends_on=postgres:service_healthy:false,com.docker.compose.image=sha256:76c05279aba53cccabd8cf3c1db42d24bbfa53b5d594fd023666fd56c4017363,com.docker.compose.project.config_files=/home/runner/work/Relay/Relay/docker-compose.yml,com.docker.compose.project.working_dir=/home/runner/work/Relay/Relay,com.docker.compose.version=2.38.2","LocalVolumes":"0","Mounts":"","Name":"relay-relay-1","Names":"relay-relay-1","Networks":"relay_default","Ports":"0.0.0.0:4000-\u003e4000/tcp, [::]:4000-\u003e4000/tcp","Project":"relay","Publishers":[{"URL":"0.0.0.0","TargetPort":4000,"PublishedPort":4000,"Protocol":"tcp"},{"URL":"::","TargetPort":4000,"PublishedPort":4000,"Protocol":"tcp"}],"RunningFor":"37 seconds ago","Service":"relay","Size":"0B","State":"running","Status":"Up 2 seconds"}
```

## 21-qualification-suite

```text
build: PASS
tests: # pass 83 / # fail 0
migration upgrade contract: 4 ok lines
worker qualification: 4 ok lines
oncall non-UTC: # pass 17 # fail 0 
browser smoke: 0 ok lines, 0 fail lines
production e2e: 0 ok lines, 0 fail lines
restart verification: 0 ok lines, 0 fail lines
```
