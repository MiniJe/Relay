# Relay 0.3 incident command foundation

RLY-0.3-M-001 implements the first bounded incident-operations slice from the
research proposal, using the qualified 0.2 worktree. It is an integration
candidate, not a tag, publication or deployment authorization.

- Explicit visible incident commander, accepted handoff and audited admin recovery.
- Assigned operational work with lifecycle, reasons, due times and explicit reopening.
- Private communications ownership and next-update responsibility.
- Compact Quiet Operations command panel with affected systems, tasks and linked alerts.
- Server-side operational eligibility, RBAC, tenant isolation, revision conflicts and audit.
- Public publication review with transaction-checked scope; private fields excluded.

See [incident command semantics and upgrade notes](INCIDENT-COMMAND.md) and
[qualification evidence](qualification/RLY-0.3-M-001.md). Existing 0.2 routing,
delivery, escalation, on-call and acknowledgement behavior is retained.

Authoritative research read without modification:

- `origin/research/rly-0.3-product-direction` at `65f56c0` (`docs/RELAY-0.3.md`).
- `origin/research/rly-operator-ux` at `5cf8a99` (`docs/RESEARCH-OPERATOR-UX.md`).
- `origin/research/rly-picovolt-integration` at `27ecb46`, persistence boundary only.

Review-completion workflow and legacy follow-up conversion are deferred beyond
this first command foundation. PostgreSQL remains the source of truth; no
experimental archive integration is introduced.
