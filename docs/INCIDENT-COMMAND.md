# Incident command foundation (Relay 0.3)

The incident workspace makes current command, communication responsibility,
affected systems, work and linked alerts visible together. It extends the
canonical incident; it does not introduce another public incident or change
alert acknowledgement, on-call resolution or paging semantics.

## Ownership and handoff

New incidents retain the eligible creator as default commander. Only
OWNER/ADMIN/RESPONDER members can receive new command, communication or task
assignments. Assignment never grants authority. Legacy unowned or ineligible
command is visibly flagged and has an administrative recovery action.

The current commander or an administrator proposes a named recipient with a
required handoff note. The current commander remains responsible while the
transfer is PENDING. Only the named, currently eligible recipient can accept
or decline, including when an administrator proposed it. Acceptance changes
command and joins the recipient to the roster atomically. Decline leaves
command unchanged. The proposer, current commander or administrator can cancel
with a reason. At most one transfer can be pending.

Administrative recovery is a separate OWNER/ADMIN action with a mandatory
reason. It explicitly bypasses acceptance and cancels a pending transfer.
Ownership, handoff and task changes append actor/name snapshots and structured
before/after evidence to the internal timeline in the same transaction.

## Work and communication

Tasks have an optional explicit owner, optional due timestamp and a lifecycle:
TODO, IN_PROGRESS, BLOCKED, DONE or CANCELLED. Blocked/cancelled work requires a
reason. Reopening terminal work is explicit, reasoned and returns it to TODO.
There is no delete endpoint. RESPONSE creation requires an active incident;
FOLLOW_UP creation requires a resolved incident. Existing work remains
editable after resolution. Resolution preserves unfinished tasks.

The communications owner and next-public-update target are private planning
fields. Missing ownership and unscheduled updates are visible; elapsed targets
are labeled Overdue using the HTTP server clock. Saving the plan does not
publish, notify, acknowledge an alert or schedule reminders. Any authorized
responder can publish, regardless of the named communications owner.

Public updates retain the internal-default compose → review message, affected
public components and public destination pages → Publish public update flow.
The browser fetches current incident and pages for review; the server checks
the reviewed sets in the publication transaction. Public scope or revision
conflicts retain the compose text and require a fresh review. Publishing alone
preserves the deadline. Resolution clears it and atomically cancels pending
handoff; repeated resolution emits no duplicate audit/notification.

Incident title/severity/lifecycle and affected public components are still part
of the existing public projection before any public message. Creation explains
this; impact/severity/lifecycle changes affecting public status require an
explicit confirmation. Tasks, owners, handoffs, notes, deadlines and audit
metadata never enter public list/detail responses or notification payloads.

## API and compatibility

Paths below are relative to
`/api/v1/organizations/{organizationId}/incidents/{incidentId}`.

| Method/path | Payload | Authority |
| --- | --- | --- |
| GET incident | Complete internal aggregate and strong ETag | All organization roles |
| GET `/tasks`, `/handoffs` | `limit` 1–100 (default 50), optional scoped `cursor`; `page.total`, `page.nextCursor`, `incidentRevision` | All organization roles |
| POST `/tasks` | Client UUID `id`, `kind`, `title`; optional `description`, `assigneeUserId`, `dueAt` | Operational roles |
| PATCH `/tasks/{taskId}` | Supplied title/context/owner/due/state/reason fields | Operational roles |
| POST `/tasks/{taskId}/reopen` | `reason` | Operational roles |
| POST `/handoffs` | Client UUID `id`, `toUserId`, `note` | Commander or administrator |
| POST `/handoffs/{handoffId}/accept` | `{}` | Named eligible recipient |
| POST `/handoffs/{handoffId}/decline` | Optional `reason` | Named eligible recipient |
| POST `/handoffs/{handoffId}/cancel` | Required `reason` | Proposer, commander or administrator |
| POST `/commander/reassign` | `userId`, `reason` | OWNER/ADMIN |
| PATCH `/communication-plan` | Optional `ownerUserId`, `nextUpdateAt`; null clears, omission preserves | Operational roles |

New commands require `If-Match: "incident-{id}-r{revision}"`: omission is 428,
malformed is 400, stale is 412 REVISION_MISMATCH. Revisions are decimal strings.
Each accepted change bumps the aggregate once; no-op commands do not. Only the
original creator can replay the same normalized create payload/UUID, even after
later mutations, with no additional event; a changed payload is 409. UUIDs
cannot overwrite work attached to another tenant or incident.

Existing incident PATCH, responder POST, update POST, resolve POST and
postmortem PUT accept optional If-Match; the browser always sends it. Omission
retains supplied-field last-writer-wins semantics with validation inside the
transaction. **Compatibility exception:** legacy PATCH cannot change or clear
commander; it returns 409 HANDOFF_REQUIRED. Sending the existing commander is
allowed. This restriction prevents bypassing acceptance.

Update POST optionally accepts `reviewedScope: {componentIds,statusPageIds}`
for public publication and `nextPublicUpdateAt` (null clears, omission
preserves). A scope mismatch is 409 PUBLIC_SCOPE_CHANGED. Legacy clients may
omit reviewedScope. Internal notes cannot mutate the plan. OpenAPI describes
the new command schemas, errors, ETags and legacy distinction.

The browser keeps unsaved drafts and focused controls during SSE/focus/30-second
idle refresh. A stale write preserves entered text and offers explicit current
state review before deliberate resubmission; it never automatically retries.
Alert summary counts explicitly cover at most the latest 200 displayed alerts.
Incident command task/alert counts derive from complete incident-scoped lists.

## Persistence and transaction boundaries

PostgreSQL remains authoritative. MemoryStore applies the same pure command
rules synchronously for verification; database races are tested separately on
PostgreSQL. Mutation locks follow membership rows ordered by user ID →
organization scope → incident. The foundation conservatively serializes
commands within an organization, including publication and status-page
creation; this favors correctness over fine-grained throughput. Reads use a
repeatable-read incident snapshot. No provider call occurs inside the command
transaction. SSE is a refresh hint, not durable delivery.

Migration `004_incident_command.sql` is forward-only; 001–003 remain unchanged.
It adds revisions, private communication fields, tenant-safe task/handoff FKs,
a one-pending-handoff index and deterministic timeline ordering. Legacy event
message/metadata/time/actor values are preserved, backfilled at revision 0 by
`occurred_at,id`, with schemaVersion 0 and unknown name snapshots left null.
Existing incident ownership is preserved. Cross-tenant legacy commander
references abort with incident IDs for explicit repair; nothing is silently
deleted or reassigned. Legacy VIEWER assignment remains visible but cannot
authorize any mutation or new assignment.

Postmortem narrative and legacy string follow-ups retain their existing API.
Review completion states, conversion of legacy follow-up strings, reminder
jobs, runbooks and advanced task filters are outside this foundation. No ML
correlation, SSO, billing, native mobile or PicoVolt persistence is added.
