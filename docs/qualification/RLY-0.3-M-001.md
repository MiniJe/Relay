# RLY-0.3-M-001 — Incident command foundation qualification

Local qualification: **PASS**, 2026-09-30 (Europe/Bucharest). Integration
readiness also requires the dedicated PR checks; no merge/tag/publication or
production deployment was performed by this mandate.

Dedicated [PR #7](https://github.com/MiniJe/Relay/pull/7) targets
`release/rly-0.2-qualification`. Implementation commit `4575094` passed both
[relay-ci](https://github.com/MiniJe/Relay/actions/runs/36633688445) and the full
[release-verification](https://github.com/MiniJe/Relay/actions/runs/36633688519)
on Linux, including Docker, browser, command E2E and restart persistence.
The final display-separator cleanup and refreshed captures are checked again
by the same PR workflows; current results are available on the PR checks.

## Baseline and scope

- Repository: `MiniJe/Relay`.
- Dedicated worktree: `C:/Users/minij/CodexSwarm/A17-relay-03`.
- Dedicated branch: `codex/a17-rly-03-m001`.
- Starting ref: `origin/release/rly-0.2-qualification`.
- Starting SHA: `ea0d6b7d779eaec68292901d5dba2afde399d7af` (clean worktree).
- Repository-local identity verified before committing: Simon Paul,
  `80901645+MiniJe@users.noreply.github.com`; global identity unchanged.
- Research refs and boundaries are recorded in [RELAY-0.3.md](../RELAY-0.3.md).

This foundation implements visible command, acceptance-based handoff,
audited recovery, assigned operational tasks, communication owner/deadline,
linked alert context, reviewed publication, revision conflicts and private
audit history. [Semantics and upgrade notes](../INCIDENT-COMMAND.md) include
the intentional legacy commander-PATCH compatibility exception.

## Executed qualification

| Check | Evidence/result |
| --- | --- |
| Clean lockfile install | `npm ci`; Node 24.21.0 on Windows; no dependency vulnerabilities reported |
| Build | All 33 application/package/script modules parse; 66 CDP evaluation payloads parse; required artifacts and version agree |
| Automated suite | `DATABASE_URL=... npm run verify`: 87 tests, 87 pass, 0 fail, 0 skip; PostgreSQL 16 enabled |
| Secret scan | PASS; fixture credentials/state remain in ignored local artifacts or temporary container storage |
| Store parity | Same HTTP command scenario against MemoryStore and PostgreSQL |
| Concurrency | Competing task edits and handoff proposals; accept versus cancel; accept versus resolve: one committed result, one 412, correct command/audit |
| Replay and eligibility | Original-creator replay; changed payload conflicts; cross-incident ID collision rollback; viewer/outsider and downgraded-member denial |
| Tenant isolation | Wrong-tenant incident IDs yield 404 within an authorized tenant; foreign/ineligible assignment rejected; relational child FKs tested |
| Public boundary | Both unauthenticated list and detail exclude tasks, handoffs, notes, actor IDs and private deadlines; reviewed scope mismatch rejected |
| Migration | Fresh 001→004; populated 0.1→current and populated 0.2→004 preservation; deterministic legacy timeline backfill; rerun no-op |
| Invalid legacy upgrade | Cross-tenant commander reports exact incident ID, rolls back additions and preserves original ownership; required reason constraints tested directly |
| Docker build/runtime | Isolated `relay-a17-command` Compose project; application on host port 4417, PostgreSQL on 55417; Node 22.23.3 / PostgreSQL 16 |
| Existing production E2E | PASS: canonical lifecycle/public projection plus routing, on-call, delivery/escalation and acknowledgement |
| Command production E2E | PASS: alert escalation/link, assigned blocked task, accepted handoff, communication plan and deliberate publication |
| Restart persistence | Existing production verifier PASS; command verifier compares entire internal aggregate unchanged, including revision, command, task, handoff, deadline, updates and timeline |
| Release surface | Health/package/OpenAPI all report 0.3.0; existing and command paths checked; no secrets in shipped assets |
| Browser | Edge/Chromium headless CDP against Docker deployment; desktop 1440×900, laptop 1280×800, mobile 390×844; no page-level horizontal overflow |
| Keyboard / motion | Focus enters command/task dialogs, Escape restores invoking focus; existing modal Tab-cycle contract retained; reduced-motion disables animation/transition |
| Browser operations | Task creation/blocking, private communications/overdue target, competing-write draft preservation, explicit review/retry, recovery explanation and existing public review flow PASS |

Browser captures from the final image:

- [Desktop incident command](rly-0.3/incident-command-desktop.png)
- [Laptop incident command](rly-0.3/incident-command-laptop.png)
- [Mobile incident command](rly-0.3/incident-command-mobile.png)

Local detailed logs and fixture state are under ignored
`.qualification-artifacts/`. The deployed database and all accounts are
isolated qualification fixtures; no real responders/providers were contacted.
The CI workflow reproduces the tests, Docker and restart scenarios on Linux.
`release-verification` now also applies to PRs targeting the qualified 0.2
branch; existing checks remain and command E2E/restart checks are added.

## Defects fixed and limits

- Commander was invisible in the workspace and could be silently reassigned;
  explicit command and accepted transfer now replace that behavior.
- Collaborative incident writes read state before acquiring a transaction;
  command validation, eligibility, aggregate state and audit now commit under
  common locks. Legacy supplied-field writes no longer clobber unrelated fields.
- Duplicate resolution could add audit/notification; repeat resolution is a no-op.
- Alert summaries could imply global counts/health from a bounded list; labels
  explicitly describe the displayed subset.
- Public review could publish against changed component/page scope; reviewed
  scope is checked in the publication transaction.
- MemoryStore nested incident users included password hashes; serializers now
  expose only safe user fields.
- Cross-incident create-ID reuse is rejected without overwriting another record.

The simple organization lock favors correctness and serializes command writes
within a tenant. Aggregate revisions deliberately conflict even across different
tasks. Legacy API clients omitting If-Match retain last-writer-wins for the
same field; no conflict guarantee is claimed for those clients. Embedded
incident lists are retained for compatibility; high-volume read optimization
is outside this slice. No current external credential or human-decision gate
was encountered locally; CI/PR results are tracked on the dedicated branch.

Excluded: review-completion lifecycle, legacy follow-up conversion, advanced
task filters, runbooks, reminder scheduling, alert-noise control/ML correlation,
SSO, billing, native mobile apps, PicoVolt integration/replacement, merge,
tagging, publication and deployment.
