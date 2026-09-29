# Relay 0.3 proposal — Incident operations that survive a handoff

Status: **proposed**, RLY-0.3-M-000. Repository baseline: `b829cfb`,
2026-09-29. This is a product and architecture decision document, not a claim
that 0.3 is implemented, qualified, approved for release, or tagged.

## Decision and release purpose

Choose **Track A — Incident operations**. Relay 0.3 should answer:

> After the page is acknowledged, who owns the incident, what happens next,
> and who will tell customers?

Deliver one continuous workflow: a responder declares an incident, assigns
work, transfers command with explicit acceptance, publishes deliberate customer
updates, resolves impact, and completes a review with owned follow-up work.
Keep all of it attached to the existing canonical incident.

The largest remaining gap, based on repository behavior, is **continuity of
response after paging**. Relay can record a commander and notes, but it cannot
distinguish an accepted handoff from a changed name, an assigned action from a
sentence, or an unfinished review from a saved form. A second responder must
reconstruct that state from prose. Paging more reliably does not close this gap.

This is a product judgment, not a measured claim about customer demand. No
production alert-volume, responder-interview, or abandonment data was supplied.
If operator evidence shows repeated distinct alerts overwhelming response,
reconsider the sequencing before starting M-001. Do not combine both tracks
into a larger release as a compromise.

### Evidence in the current repository

| Existing behavior | Evidence | Remaining gap |
| --- | --- | --- |
| Canonical incident, optional commander, responders, updates, timeline and postmortem | [001 schema](../packages/database/migrations/001_initial.sql), [incident routes](../apps/api/src/app.mjs) | The primitives exist; introducing them again would not define a release. |
| Creator defaults to commander; commander can be replaced by PATCH; joining adds a roster row | `validateCommander`, incident PATCH and responder routes in [app.mjs](../apps/api/src/app.mjs) | Membership alone is accepted, including VIEWER; there is no acceptance, pending transfer, or role-specific responsibility. |
| Incident workspace has lifecycle, affected systems, updates, responder list and timeline | `renderIncident` in [app.js](../apps/web/public/app.js), [Quiet Operations decisions](DESIGN-DECISIONS.md) | No assigned task queue or handoff workflow; public publication already has a review step and must retain it. |
| Postmortem contains narrative fields and a JSON list of follow-up strings | `postmortems`, `upsertPostmortem` in [PostgresStore](../packages/database/postgres-store.mjs) | No action owners, task status, or explicit review completion. |
| Alert identity is unique on organization/source/external ID | [001 schema](../packages/database/migrations/001_initial.sql), [routing](../apps/api/src/routing.mjs) | Retries are deduplicated; distinct event IDs for the same symptom are not grouped. |
| Durable paging and execution-time escalation have a worker and qualification tests | [worker](../apps/api/src/worker.mjs), [worker tests](../tests/worker.qualification.test.mjs), [0.2 definition](RELAY-0.2.md) | No silences, maintenance schedule or semantic grouping. |
| Incident writes read state before the transaction; postmortem update uses the store connection inside a transaction callback | `updateIncident`, `upsertPostmortem` in [PostgresStore](../packages/database/postgres-store.mjs) | Coordination needs transaction-local validation and writes before adding collaborative state. |

Some README/architecture passages still describe M-002 as partial or routing
as synchronous-only. This proposal uses executable code and the later 0.2
release definition as its baseline. It does not independently certify the
0.2 release. Reconcile those passages during release documentation work.

## Two coherent directions

### Track A: coordinated response and customer communication

A useful bounded release is ownership + tasks + communication responsibility +
review closure. Commander is an incident responsibility, responders remain a
roster, and an optional communications owner owns the next public update.
Runbooks are deferred: a library, versioning, template application and execution
would introduce a separate product workflow before task ownership is proven.

### Track B: explainable control of repetitive paging

A coherent alternative would preserve every accepted alert while deciding
whether it deserves a new page. Its minimum vertical slice would be:

- Expiring, exact-match silences and one-off service maintenance windows using
  server-time half-open intervals `[startsAt, endsAt)`.
- An optional explicit fingerprint, scoped to organization, source and service;
  versioned deterministic normalization, never fuzzy title matching. Existing
  external-ID retry identity remains separate from symptom identity.
- Fixed, non-sliding grouping windows: the first occurrence establishes a
  group and page, later matching occurrences link to it and increment counts.
  Window expiry permits a new group. A severity increase requires an explicit
  new-page policy, not accidental reuse of a quieter group.
- A persisted decision explaining `PAGE`, `SILENCED`, `MAINTENANCE` or
  `GROUPED`, with configuration snapshots, matched interval, group and actor.
  Suppression affects future paging decisions, never alert durability or
  canonical incident/public health. Expiry does not release a backlog of pages.
- An operator preview and an inspectable suppressed-alert queue. Silencing
  already queued or in-flight deliveries would be a separate explicit action;
  claiming a provider request can always be recalled would be incorrect.

Flapping suppression and burst budgets would follow only after this slice:
they need explicit recurrence/recovery semantics, fairness between services,
and a policy for what happens when a budget recovers. The current alert input
does not model a firing/resolved signal lifecycle. An ingest HTTP rate limiter
protects the server; it is not a durable paging-noise policy.

### Comparison

| Dimension | Track A — incident operations | Track B — alert-noise control |
| --- | --- | --- |
| Primary UX | Extend the incident workspace with visible command, pending handoff, assigned work, next update and review state. One place to resume work. | Add noise configuration, preview, grouped alert detail and suppression explanations. Operators need to distinguish received, grouped, acknowledged and suppressed. |
| Schema | Extend `incidents` and `postmortems`; add tasks and handoffs; extend the existing timeline. Most new data belongs to one incident. | Add silence/maintenance configuration, fingerprint/group identity, occurrence links and immutable suppression decisions. Group uniqueness and delivery identity must work across many alerts. |
| API | Incident-scoped commands with revision checks; retain existing publication and postmortem resources. | Intake schema and response additions, noise-policy CRUD/preview, group queries and explicit page-release semantics. Routing and worker paths must consume the same decision. |
| Operational value | Prevents lost responsibility and forgotten actions after acknowledgement; makes customer updates part of the response plan. Useful even for a small number of serious incidents. | Reduces repeated interruptions and makes high-volume intake usable. Greatest value where repeated symptoms dominate pages. |
| Complexity | Moderate: transactional aggregate, handoff state machine and collaborative UI. Avoids new scheduling or provider-delivery paths. | High: event identity versus retries, time boundaries, concurrent group creation, escalation interactions and cancellation races. Basic silences alone are smaller but do not solve repetitive event identity. |
| Security and failure risk | Internal notes/tasks could leak through public serializers; assignment must never grant authority; concurrent writes could lose work. Existing session/RBAC boundary fits. | Suppression is a powerful availability control. Broad matches can hide an outage; hostile fingerprints can collapse unrelated alerts; service/tenant isolation and suppression audit are critical. |
| Combined status-page + response objective | Directly connects response ownership and work to deliberate customer communication and learning from the same incident. | Strengthens the upstream signal-to-responder path. Public status gains indirectly; internal maintenance must not automatically announce maintenance to customers. |
| Fit after 0.2 | Completes the next user journey using existing primitives. | Deepens the area 0.2 just expanded; justified first if alert fatigue is the observed adoption blocker. |

Track A wins on the stated combined product objective and the visible gap after
paging. Track B remains a credible subsequent release, not miscellaneous
maintenance-window features to slip into A. Both have real value; there is no
evidence here to claim a numeric reduction in MTTR or page volume.

## Scope and acceptance journey

1. Ingest and route an alert through unchanged 0.2 behavior. A responder
   acknowledges and explicitly creates the incident.
2. The incident displays its commander, responder roster, communications owner
   and next update deadline. Missing ownership is visible, never inferred from
   the current on-call schedule.
3. Add a response task, assign it, and mark it blocked with a reason. Another
   responder can see the next action without reading every note.
4. Commander proposes a transfer with a handoff note. The current commander
   remains responsible until the named recipient accepts. Acceptance changes
   command and appends history atomically.
5. Communications owner publishes through the existing explicit public review
   flow. The private deadline does not become a public promise automatically.
6. Resolve the incident without forcing every task to be completed. Open tasks
   remain visible. Complete a post-incident review and track follow-ups as tasks.

Success means that this journey survives competing operators, a page reload
and a process restart, and an unauthenticated reader sees only the approved
public projection. Qualification is scenario-based; production improvement
claims require later operator evidence. Useful later measures are time spent
without an eligible commander, overdue update deadlines, and overdue owned
follow-ups. An analytics dashboard is not part of 0.3.

## Release invariants

1. **One incident truth.** No separate public incident, handoff incident or
   review incident. Services remain distinct from public Components.
2. **Paging semantics survive.** Alert intake stays durable before routing;
   acknowledgement, incident ownership and incident resolution remain separate.
   No automatic incident declaration, implicit acknowledgement or extra page
   on task/ownership changes.
3. **Command transfers on acceptance.** At most one pending transfer per
   incident. A proposal never silently removes the current commander. Admin
   recovery is explicit and audited.
4. **Assignments are not permissions.** Only OWNER/ADMIN/RESPONDER organization
   members are eligible for new operational assignments. VIEWER remains
   read-only even if a legacy record names them.
5. **State and evidence commit together.** Each accepted mutation and its
   typed timeline event are one transaction. No event for a rejected write.
6. **No silent conflict recovery in the UI.** Stale edits preserve the draft,
   fetch current state and require a deliberate retry. A pending handoff,
   completed task or review cannot be overwritten by an old screen.
7. **The public boundary never widens.** Tasks, roles, handoffs, notes,
   deadlines, reviews and their audit data stay internal. Only explicit public
   updates and the existing incident/component projection reach public APIs.
8. **Resolution is not administrative completion.** Resolution ends customer
   impact using the existing lifecycle. It does not complete tasks, a review,
   or an alert acknowledgement. RESOLVED stays terminal.
9. **No hidden background actions.** Deadlines are persisted timestamps with
   derived overdue state. 0.3 does not add reminder pages, automatic publication,
   runbook execution or a new job scheduler.

## Schema design

Use PostgreSQL as the system of record and retain the modular monolith. Both
stores must implement the same commands; in-memory behavior is a verification
aid, not evidence of database concurrency correctness. IDs remain TEXT using
the existing ID convention; API fields use camelCase. Dates are TIMESTAMPTZ,
JSON dates are RFC 3339 with an explicit offset, and server time records events.

### Existing tables

| Table | Additions / contract |
| --- | --- |
| `incidents` | `revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0)`; `communications_owner_user_id TEXT NULL`; `next_public_update_at TIMESTAMPTZ NULL`. Keep `commander_user_id` authoritative; do not add a second role-assignment table for commander. Add/ensure `UNIQUE (organization_id, id)` for child FKs. |
| `incident_timeline_events` | Add `organization_id`, `incident_revision`, `event_index`, `actor_display_name_snapshot`, `schema_version SMALLINT DEFAULT 1`. Unique `(incident_id, incident_revision, event_index)`. New writes require a tenant-safe incident FK. Existing message/metadata remain readable. |
| `postmortems` | Add `review_state` (`DRAFT`, `COMPLETE`, default DRAFT), `completed_at`, `completed_by_user_id`, `completed_by_name_snapshot`; CHECK completion fields agree with state. Retain existing narrative and `follow_up_actions` without reinterpretation. |

`revision` is an incident aggregate revision, including tasks, handoffs,
updates, responder additions and review changes. One successful command bumps
it once, regardless of the number of events. A true no-op does not bump it.
The API represents revisions/sequence values as decimal strings to avoid
JavaScript integer precision loss.

### `incident_tasks`

- `id`, `organization_id`, `incident_id`; tenant-safe FK to incident.
- `kind`: `RESPONSE` or `FOLLOW_UP`, immutable after creation.
- `title` (1–200 characters), `description` (0–5000), `state`: `TODO`,
  `IN_PROGRESS`, `BLOCKED`, `DONE`, `CANCELLED` (default TODO).
- Nullable `assignee_user_id`, nullable `due_at`; snapshot of assignee display
  name when assigned. Unassigned is valid and visibly labeled.
- `blocked_reason` (1–1000 when BLOCKED, otherwise null);
  `cancellation_reason` (1–1000 when CANCELLED, otherwise null).
- `created_by_user_id`, `created_by_name_snapshot`, `created_at`, `updated_at`,
  nullable `completed_at` (present exactly when DONE).
- Optional `legacy_follow_up_index` for explicit conversion of a legacy
  postmortem string; unique `(incident_id, legacy_follow_up_index)` when set.
  Store `legacy_follow_up_text_snapshot` as well. Derive title from the first
  200 characters and description from the full source string (legacy strings
  may be 500 characters); retain the original field unchanged. Later edits or
  reordering of legacy strings never rewrite the converted task. If the text
  at a converted index changes, show the old conversion separately and require
  a normal new task for the new text, rather than silently linking it.
- `creation_payload_hash TEXT NOT NULL` for exact create replay comparison.
- Index `(organization_id, incident_id, created_at, id)` and partial index
  `(organization_id, assignee_user_id, due_at, id)` for nonterminal tasks.

TODO/IN_PROGRESS/BLOCKED may move among those states or to DONE/CANCELLED.
Reopening DONE/CANCELLED requires the explicit `reopen` command and goes to
TODO; no hard-delete endpoint. Creation of RESPONSE work requires an active
incident; existing response work can still be edited/completed after resolution.
FOLLOW_UP creation requires a resolved incident. Tasks need not be completed
to resolve an incident or complete its review.

### `incident_handoffs`

- `id`, `organization_id`, `incident_id`; tenant-safe FK to incident.
- `from_user_id` nullable for a legacy unowned incident, `to_user_id` non-null,
  `requested_by_user_id`; display-name snapshots for all three.
- `note` (1–5000), `state`: `PENDING`, `ACCEPTED`, `DECLINED`, `CANCELLED`.
- `created_at`, nullable `decided_at`, `decided_by_user_id`,
  `decided_by_name_snapshot`, `decision_reason` (required for cancellation).
- Partial unique index on `(organization_id, incident_id) WHERE state =
  'PENDING'`; CHECK decision fields absent for PENDING and present otherwise.
- Ordered history index `(organization_id, incident_id, created_at, id)`.
- `creation_payload_hash TEXT NOT NULL` for exact create replay comparison.

Proposals and administrative reassignment require an active incident.
Pending is the only nonterminal state. No implicit expiry or automatic
acceptance. Decline/cancel leaves the commander unchanged. Resolution cancels a
pending handoff in the resolution transaction with reason `INCIDENT_RESOLVED`.
Acceptance after resolution is rejected. Terminal rows are never rewritten.

### Tenant and identity constraints

All new child tables reference `(organization_id, incident_id)`, not an
unscoped incident ID. Live commander, communications owner and task assignee
references use organization membership composite FKs. Eligible *roles* are
checked under membership locks; an FK alone cannot express role eligibility.
Handoff from/to/proposer/decision identities are historical user FKs with the
existing restrictive deletion policy, not permanent membership FKs. Validate
the recipient's tenant membership at creation and again at acceptance under
locks; this permits retaining a terminal handoff after membership removal.
Historical actors store names as facts. Do not attach historical actor identity
to a membership that can later disappear.

Membership removal is not a new 0.3 feature. Any existing/future removal path
must first clear/reassign live responsibility and cancel pending transfers in
the same transaction, preserving snapshots. A role downgrade makes a live
assignment visibly ineligible; authorization always rechecks the current role.
Acceptance by an ineligible recipient returns a conflict. Admin recovery must
remain available. Do not cascade-delete operational history on membership loss.

### Timeline vocabulary

Retain current event types and add `HANDOFF_REQUESTED`, `HANDOFF_ACCEPTED`,
`HANDOFF_DECLINED`, `HANDOFF_CANCELLED`, `COMMANDER_REASSIGNED`,
`COMMUNICATION_PLAN_CHANGED`, `TASK_CREATED`, `TASK_CHANGED`, `TASK_REOPENED`,
`REVIEW_COMPLETED` and `REVIEW_REOPENED`. Each has a typed metadata schema:
entity IDs, before/after values, reason and relevant name snapshots. Clients
cannot submit arbitrary system event types or actor identities.

Order by `(incident_revision, event_index)`, not timestamp alone. Event time is
server-recorded time; this is not a retroactively editable forensic chronology.
The existing internal note route remains the way to add narrative evidence.
Timeline writes are append-only through the application, not advertised as
cryptographically tamper-proof against a database administrator.

## API contracts

All paths below use `/api/v1/organizations/{organizationId}` as the base; `I`
means `/incidents/{incidentId}`. Existing `{data: ...}` and
`{error: {code, message, details?}}` envelopes remain. New request schemas reject
unknown fields, invalid enum values and overlong text. Apply the existing
session, mutation-origin, body-size and tenant checks before mutation.

GET `I` adds `revision`, `communicationsOwnerUserId`, `nextPublicUpdateAt`,
`ownershipState` (`OWNED`, `UNASSIGNED`, `INELIGIBLE`), `pendingHandoff` and
`taskCounts`. `ownershipState` is derived from the commander and membership,
not another stored lifecycle. Return `ETag: "incident-{id}-r{revision}"`.
Keep the existing incident representation fields for compatibility; new task
and handoff collections are paginated separately.

New incident commands and the shipped 0.3 UI send `If-Match` with that exact
strong ETag. Missing precondition on a new command is `428
PRECONDITION_REQUIRED`; stale is `412 REVISION_MISMATCH` with the current
revision. A revision never grants access. New creates use a client-generated
UUID `id`: an exact replay at the same tenant/incident returns the existing
entity (`200`, `replayed: true`) without another event; a changed payload with
that ID returns `409 IDEMPOTENCY_CONFLICT`. Store a canonical creation-payload
hash on each new task/handoff for this comparison, separate from mutable data.
Authenticate/recheck organization mutation authority before honoring a replay;
only the original creator may replay a create. Check that replay before
state-dependent command authority (the proposer may no longer be commander).

| Method/path | Request and behavior | Success |
| --- | --- | --- |
| GET `I/tasks?state=&kind=&assigneeUserId=&limit=&cursor=` | Filters are exact enums/IDs; stable `(createdAt,id)` keyset order; limit default 50, maximum 100. | `200 {data: [...], page: {nextCursor}}` |
| POST `I/tasks` | `{id,kind,title,description?,assigneeUserId?,dueAt?}`. Alternatively provide `legacyFollowUpIndex` for FOLLOW_UP instead of title/description; server derives both and snapshots the indexed string. | `201 {data: {task,revision}}` |
| PATCH `I/tasks/{taskId}` | Partial `{title?,description?,assigneeUserId?,dueAt?,state?,blockedReason?,cancellationReason?}`. Null clears optional assignee/deadline; omission preserves. | `200 {data: {task,revision}}` |
| POST `I/tasks/{taskId}/reopen` | `{reason}` (1–1000). Explicit terminal → TODO transition. | `200 {data: {task,revision}}` |
| GET `I/handoffs?limit=&cursor=` | Same pagination contract. | `200` collection |
| POST `I/handoffs` | `{id,toUserId,note}`. Derive `fromUserId` from current commander; target differs from commander. | `201 {data: {handoff,revision}}` |
| POST `I/handoffs/{handoffId}/accept` | `{}`; only named eligible recipient. Adds them to responder roster if absent. | `200 {data: {handoff,commanderUserId,revision}}` |
| POST `I/handoffs/{handoffId}/decline` | `{reason?}`; only named eligible recipient. | `200 {data: {handoff,revision}}` |
| POST `I/handoffs/{handoffId}/cancel` | `{reason}`; proposer, current commander or admin/owner. | `200 {data: {handoff,revision}}` |
| POST `I/commander/reassign` | `{userId,reason}`; OWNER/ADMIN recovery, including initial assignment when unowned. Cancels pending transfer atomically and records old/new commander and reason. No null target. | `200 {data: {commanderUserId,revision}}` |
| PATCH `I/communication-plan` | `{ownerUserId?,nextUpdateAt?}`; null clears, omission preserves. Reject a non-null deadline on a resolved incident. | `200 {data: {communicationsOwnerUserId,nextPublicUpdateAt,revision}}` |
| POST `I/postmortem/complete` | `{}`; resolved incident and nonblank summary, impact and resolution required. Root cause may be unknown. | `200 {data: {postmortem,revision}}` |
| POST `I/postmortem/reopen` | `{reason}`; returns review to DRAFT, clears completion fields, appends history. | `200 {data: {postmortem,revision}}` |

Response headers for each successful incident mutation include the new incident
ETag. GET lists include `incidentRevision` in the response envelope so the UI
can detect a refresh that crossed an aggregate change. Read each collection
and its revision in one database snapshot. Use the HTTP Date header as the
server clock reference; time-derived labels are not stored aggregate fields.
Reject malformed,
cross-tenant or filter-mismatched cursors. Cursors encode ordering keys and
filter context, never SQL. Pagination is a live ordered view, not a frozen
export; a refresh is required to reconcile records moving between filters.

### Existing operations and compatibility

- Incident create and alert-to-incident escalation keep their payloads and
  default commander behavior, but new assignments require an eligible role.
- Existing incident PATCH, responder POST, update POST, resolve POST and
  postmortem PUT accept `If-Match`. The 0.3 browser always sends it. For existing
  API clients, omission remains accepted, with transaction-local validation
  and only explicitly provided fields updated. Two legacy writes to the same
  field remain last-writer-wins; do not claim conflict protection for clients
  that omit the precondition. Document this distinction in OpenAPI.
- Commander changes through legacy PATCH are the intentional compatibility
  exception: changing/clearing the value returns `409 HANDOFF_REQUIRED` with
  the handoff/reassignment paths. Sending the existing value is a no-op.
  Otherwise old clients could bypass acceptance. Call this out in upgrade notes.
- Existing POST `I/updates` remains the only publication path. A public update
  optionally accepts `nextPublicUpdateAt` (null clears); absent preserves the
  plan, so overdue responsibility cannot disappear accidentally. Internal notes
  cannot change the plan through this route. A resolved incident can still
  publish a final message, but cannot schedule another deadline.
- For the 0.3 UI, public-update review fetches current incident and current
  destinations, then sends `reviewedScope: {componentIds, statusPageIds}` and
  `If-Match`. The server compares sorted exact sets against current affected
  components and public destination pages in the publication transaction;
  mismatch is `409 PUBLIC_SCOPE_CHANGED`, requiring a fresh review. Legacy
  clients omitting reviewedScope retain current publication behavior. Pages
  are derived, never selected to widen publication via this request.
- Resolve (including status PATCH to RESOLVED) clears the private deadline and
  cancels pending handoff atomically. It preserves communications ownership,
  tasks and review state. A repeated resolve is a no-op without a duplicate
  resolution event or notification. Show remaining work before the user resolves.
- Existing postmortem PUT retains full-replacement narrative semantics and
  legacy follow-up strings. Editing a COMPLETE review automatically reopens it
  with `REVIEW_REOPENED` and reason `CONTENT_CHANGED` in the same transaction.
  Completing an already COMPLETE review with a current revision is a no-op.
  Editing follow-up task progress does not reopen the narrative review.
- GET `I/timeline?limit=&cursor=` adds bounded keyset reads by
  `(incidentRevision,eventIndex)`. Retain the old embedded timeline for old
  clients during 0.3; optimizing/removing that representation is separate work.

Example (IDs abbreviated for readability):

```http
POST /api/v1/organizations/org-a/incidents/inc-a/handoffs
If-Match: "incident-inc-a-r12"
Content-Type: application/json

{"id":"55d795e0-5b4d-4da1-9c3b-222b07e36d67","toUserId":"user-b","note":"Rollback is complete. Watch error rate; customer update due at 14:30Z."}
```

The response is `201`, revision `"13"`, handoff PENDING, with the commander
unchanged. Acceptance by user-b at revision 13 returns revision `"14"` and
changes commander. Another user receives `403`; a competing decision with the
old revision receives `412`; a terminal handoff cannot change to a different
terminal state (`409 HANDOFF_NOT_PENDING`). Repeating the same terminal action
with a current revision is a no-op; a lost-response client refetches and checks
state before retrying. A create replay is checked before the stale-precondition
comparison, but still requires a syntactically valid If-Match header.

Common errors: `401` no session; `403` insufficient organization/action role;
`404` resource absent in the authorized organization (including an ID belonging
elsewhere); `400 INVALID_REFERENCE` for invalid in-tenant assignment,
`400 VALIDATION_ERROR` for malformed input; `409` illegal domain transition,
pending transfer already exists, or target no longer eligible. No response
reveals membership or object details from another organization.

## Permissions and security

| Action | OWNER / ADMIN | RESPONDER | VIEWER / unauthenticated |
| --- | --- | --- | --- |
| Read internal operations | Yes | Yes | VIEWER yes; unauthenticated no |
| Create/edit/assign tasks, communication plan, updates and review | Yes | Yes | No |
| Propose command transfer | Yes | Only current commander | No |
| Accept/decline transfer | Only when named recipient | Only when named recipient | No |
| Cancel transfer | Yes | Proposer or current commander | No |
| Reassign commander without acceptance | Yes, reason required | No | No |
| Configure routing/on-call/integrations | Existing authority | No | No |
| Read public incident projection | Yes | Yes | Yes, on a public page |

Commander and communications owner are responsibility labels, not additional
RBAC roles. Any authorized responder can publish an urgent update or unblock
a task; the named owner does not gain exclusive access or elevated privileges.
Team membership and on-call status do not authorize any new action. An admin
cannot impersonate the recipient's acceptance; recovery has a distinct event.

Render all new prose as escaped plain text. No HTML, script, executable
runbook, arbitrary fetch, user-chosen notification destination or binary
attachment is introduced. Sanitize any text passed through existing providers.
Preserve mutation-origin checks and existing authentication/rate boundaries.
No new operational text or actor IDs enter public SSE, public JSON, provider
payloads or logs by default. Keep `publicIncident` an explicit allowlist and
test both public list and detail, not merely hidden UI controls.

The existing public projection includes incident title, severity, status,
timestamps and affected component IDs even before a public update. The UI must
continue explaining that affected public components expose an incident;
private task notes must never be copied into title or publication automatically.
Public updates follow the incident's current component/page associations;
reviewedScope is a concurrency check, not immutable audience history or a
per-page delivery receipt.

## Concurrency and transaction rules

Introduce store-level incident commands shared by all route aliases. Do not
add a new API with strong semantics while leaving legacy routes able to bypass
the same lifecycle or audit rules.

1. Read current authorization; inside the transaction lock relevant membership
   rows in sorted user-ID order and recheck roles. Membership writers must use
   the same ordering if they touch incident assignments.
2. Public publication and changes to public page visibility, page-component
   mappings or affected-component scope additionally lock the organization
   row before incident rows. Lock order is membership rows → organization
   (when needed) → incident → child rows ordered by ID. Configuration writers
   affecting reviewedScope must join this lock protocol. No network calls here.
3. `SELECT ... FOR UPDATE` the incident scoped by organization, then read
   current child state and validate If-Match, lifecycle and assignments.
   Create replays are checked against their saved payload hash under this lock.
4. Update only supplied fields; insert/update child rows; increment revision
   once; insert typed event(s) with indices 0..N-1 at that revision. All SQL,
   including existing postmortem UPDATE, uses the transaction connection.
5. Commit, then publish organization-scoped `incident.updated` (including
   incidentId and revision) and any existing notification side effects. Emit
   no SSE or provider call from an aborted transaction.

The organization scope lock is only for short publication/scope changes, not
all tasks or paging. Test its contention before release; no provider call may
hold it. The incident lock serializes related writes: two different tasks can
still conflict at the aggregate revision. That is an intentional simple
contract for small responder groups, not per-field collaborative editing.

| Race | Required outcome |
| --- | --- |
| Two transfer proposals | One pending row; loser gets revision conflict (or pending-transfer conflict with a fresh revision). |
| Accept versus cancel/admin reassignment | One terminal result; commander and audit agree. No second acceptance event. |
| Accept versus resolve | Accept first may transfer before resolution; resolve first cancels the handoff and prevents acceptance. |
| Two task edits | One succeeds at the supplied revision; other preserves its local draft and refetches. |
| Public publish versus affected-scope/config change | Reviewed scope is validated under shared locks; a stale reviewed scope is rejected, never silently widened by that transaction. Later deliberate configuration changes still affect public visibility. |
| Review save versus completion | Serialized; stale UI gets 412; a subsequent accepted narrative edit reopens COMPLETE. |
| Assignment versus membership downgrade | Eligibility checked in serialization order; after downgrade, role checks deny mutation and UI flags ineligible ownership. |
| Lost successful create response | Same ID/payload returns original entity; no duplicate task/handoff/event. |

SSE is a refresh hint, not a durable event bus. Reconnect and window focus
trigger a canonical GET; a 30-second visible-page refresh bounds staleness if
events are missed. Derived overdue labels use a server-provided current time
and refresh at the deadline. Preserve unsaved drafts and focused controls during
background refresh; do not automatically replay a stale write.

Existing incident Discord notifications remain post-commit and best effort.
0.2's durable outbox is alert-specific; generalizing it to task/reminder/status
delivery is not part of this proposal. Persisted state can succeed while a
notification fails or a process stops before SSE. Do not promise exactly-once
external provider delivery: a provider may accept a request whose response is
lost. This release adds no stronger external-delivery guarantee.

## UI surfaces

Keep the existing Quiet Operations visual system and routes.

- **Incident list / overview:** compact commander, pending handoff, open-task
  count and next-update overdue label. No wall of new metric cards.
- **Incident workspace:** command and communications ownership visible near
  lifecycle controls; a persistent pending-handoff panel names who must accept.
  Task rows show state, title, owner and deadline, with separate Response and
  Follow-up filters. Keyboard-accessible forms replace drag-and-drop dependency.
- **Handoff dialog:** recipient, required note and current open-work/next-update
  context. The recipient sees Accept/Decline. Admin recovery has a reason field
  and plainly says it bypasses acceptance. Null/ineligible legacy ownership has
  a visible admin recovery path.
- **Communication panel:** last public update, owner and optional deadline;
  overdue text is explicit. Keep internal-note default, public compose → review
  message/scope/destinations → **Publish public update**. Ownership or deadline
  edits never publish. On scope conflict, retain message and reopen review.
- **Timeline:** filters for lifecycle, ownership, work, communication and review;
  stable event order and readable before/after labels. Existing free-text notes
  remain available. Load more for the new paginated view.
- **Resolved incident:** existing postmortem editor gains Draft/Complete state,
  completion actor/time and an explicit Complete review action. Show legacy
  follow-up strings as legacy notes with an explicit Convert to task action.
  Converted rows link to their task; no duplicated checklist maintained in sync.
- **Public status:** existing surface and fields. No private deadline, assignee,
  handoff or review widget. Public health still derives from incident impact.

Empty states distinguish no work recorded, completed work, loading failure and
unavailable data. Conflict messages name what changed and preserve entered
text. VIEWER gets readable state without actionable edit controls; API checks
remain authoritative. No top-level runbook, project-management or analytics area.

## Migration and rollout plan

1. Treat 001–003 as immutable when implementing 0.3, regardless of earlier
   branch-era wording about editing 003. Inspect integrated migrations first;
   reserve the next unused number. On this baseline, use
   `004_incident_operations.sql` for aggregate revision/timeline/handoffs,
   `005_incident_tasks.sql` for tasks, and
   `006_incident_communication_review.sql` for plan/review fields.
2. Each migration runs in the existing per-file transaction with its
   `schema_migrations` record. Add tenant columns/keys, backfill from parent
   incidents, then validate constraints. Preflight existing references: report
   invalid cross-tenant commander/child data and abort with IDs for explicit
   repair; do not silently delete or assign it to someone else.
3. Preserve all original incident, responder, update, timeline, alert, routing,
   delivery and attempt values. Backfill old events at `incident_revision=0`,
   with `event_index` assigned deterministically by `(occurred_at,id)` per
   incident. Mark them `schema_version=0`; backfilled actor names are migration-
   time values, not claimed historical snapshots. New incidents/old incidents
   start at revision 1; new events begin with the next successful command.
4. Preserve null or VIEWER commanders; expose UNASSIGNED/INELIGIBLE rather than
   invent acceptance. Existing postmortems become DRAFT, with no inferred
   completion, and all existing follow-up strings remain untouched. Do not
   create tasks automatically. Communications owner/deadline start null.
5. Plan a short single-process maintenance deployment: stop API/worker writes,
   back up, migrate, run checks, deploy 0.3 and restart. Mixed 0.2/0.3 writers
   are unsupported because 0.2 cannot maintain revisions, handoff rules or
   public-scope locking. Do not advertise rolling-upgrade safety.
6. Measure migration lock time on a populated fixture. On failure, the current
   migration rolls back; prior successful migrations remain. Recover with a
   forward fix. Before new 0.3 writes, the operator can restore the pre-upgrade
   backup with downtime. After new writes, restore loses them; a binary-only
   downgrade to 0.2 is not a supported rollback strategy.
7. Update version/OpenAPI/build surfaces to 0.3 only during release integration,
   with upgrade notes for commander PATCH and optional legacy preconditions.
   This M-000 document does not bump runtime/package versions.

## Test and qualification plan

These are future acceptance requirements, not test results from this proposal.

| Layer | Required evidence |
| --- | --- |
| Pure domain tests | Handoff transitions; recipient eligibility; task state/reason rules; review completion/reopening; derived ownership/overdue states; exact deadline boundary; offset/DST display cases. Inject a clock. |
| API + store contract | Every endpoint, optional/null semantics, pagination and replay; all four roles; tenant-mismatched IDs/assignees/cursors; missing/stale If-Match; legacy client behavior; unknown-field validation. Run on both stores. |
| PostgreSQL concurrency | Independent connections with barriers for every race table above; partial pending uniqueness; composite FKs; transaction rollback after child write but before event; no timeline/state divergence. Memory tests alone cannot qualify this. |
| Existing incident regression | All mutation aliases use one command path; resolution remains terminal/idempotent; postmortem update uses tx connection and rolls back with timeline; no stale full-row overwrite of unspecified fields. |
| Public boundary/security | Seed distinctive private strings into every new field and nested metadata; assert absence in both public endpoints, rendered HTML and outbound provider payloads. Exercise public scope changes, CSRF/origin rejection and escaped hostile prose. |
| Migration | Fresh database, populated 0.2 upgrade, populated 0.1→latest chain, null/VIEWER commanders, old postmortems, timeline timestamp ties, failed migration and rerun no-op. Compare old columns byte-for-byte and inspect new constraints/backfill. |
| Production/restart | PostgreSQL Docker deployment: full acceptance journey; restart with pending handoff, blocked task, overdue deadline and draft review; verify durable state. Complete workflow after restart. |
| Paging regression | Existing routing/on-call, provider, escalation, durable-delivery and worker qualification suites pass unchanged in semantics; task/handoff operations enqueue no new deliveries. |
| API/release surface | OpenAPI request/response/error/ETag contracts match shipped paths/UI; health/package/shared version agree at release time. |

Extend `tests/postgres.contract.test.mjs`, `tests/migration-upgrade.test.mjs`,
API/E2E suites and `scripts/production-e2e.mjs`; add focused
`incident-operations` domain/concurrency suites. Extend the existing release
workflow, surface verifier and browser script rather than creating a parallel
qualification system. PostgreSQL-required release jobs must fail if their
database is missing, not pass through skipped tests.

### Browser qualification

Use the deployed PostgreSQL-backed build with real browser input, not an API
test presented as a browser pass. Extend [browser-smoke.mjs](../scripts/browser-smoke.mjs).
Automate Chromium; record a manual Firefox pass for forms, focus and SSE, and
a WebKit/mobile Safari pass if that platform is available. Missing engine
coverage must be explicitly reported, never inferred from Chromium emulation.

- Qualify 1440×900, 1280×800 and 390×844; light/dark, reduced motion and 200%
  zoom. No page-level horizontal overflow; state and errors use text, not color.
- Keyboard-only create/assign/block/reopen task; propose/accept/decline handoff;
  edit communication plan; review/publish update; complete/reopen review.
  Dialogs trap focus, support Escape and restore focus to the invoker.
- Two separate authenticated contexts reproduce stale task edit,
  acceptance-versus-cancel, and publication-scope conflict. Drafts survive SSE,
  conflict responses and reauthentication; focus is not moved by refresh.
- Deep-link and reload incident pages; disconnect/reconnect SSE, background the
  tab, restart the server and verify state recovery. Unavailable data never
  appears as all work completed or healthy.
- Verify VIEWER UI and direct mutation denial, tenant isolation, and a separate
  unauthenticated public page before/after publication and resolution.
- Record screenshots, viewport/engine versions, console/network errors,
  assertions and exact tested commit in `docs/qualification/0.3-M-004.md`.
  Redact credentials and fixture sessions. A screenshot alone is not evidence
  that concurrency, authorization or persistence passed.

## Milestone decomposition

All identifiers are `RLY-0.3-M-00N`. Implement as reviewable vertical changes;
each milestone includes its own UI, OpenAPI and tests where applicable. No
milestone authorizes merging an unqualified speculative release.

### M-000 — Product and architecture definition (this deliverable)

- Compare both tracks against repository evidence and choose the release.
- Specify invariants, contracts, compatibility, migration and qualification.
- Exit: reviewable proposal and scope decision. No prototype was necessary:
  the hard decisions use PostgreSQL transactions/constraints already present
  in Relay and will be proven with concurrent database tests in M-001.

### M-001 — Accepted ownership and transactional incident history

Depends on M-000 scope acceptance and an integrated 0.2 baseline.

- Migration 004, aggregate revision, deterministic timeline sequencing and
  transaction-local mutation commands across old and new incident routes.
- Handoff/reassignment endpoints, eligible assignments, ownership panel,
  pending-transfer dialog and history; existing commander remains canonical.
- Fix read-before-write lifecycle checks and transaction-connection escape in
  existing incident/postmortem mutations as prerequisites, not unrelated cleanup.
- Exit: two concurrent operators cannot both decide a transfer; resolution
  cannot leave pending command; state/events roll back together; upgrade and
  existing paging/public-boundary tests pass. Document commander-PATCH change.
- Excludes tasks, review completion, communication deadlines and noise control.

### M-002 — Assigned response and follow-up work

Depends on M-001.

- Migration 005, task commands/replay/pagination and task rows/filters.
- Distinct response/follow-up lifecycle, ownership, deadlines, blocked/cancel
  reasons and explicit reopen; legacy postmortem-string conversion.
- Exit: retries create one task, competing edits produce a visible conflict,
  legacy text survives conversion, and open work persists after resolution and
  restart. No additional alert deliveries are generated.
- Excludes runbook libraries, templates, external issue sync and dependencies.

### M-003 — Customer-update responsibility and review completion

Depends on M-001 and M-002.

- Migration 006, communications owner/deadline, explicit review completion and
  reopening, preserving the existing update/postmortem resources.
- Extend publication review with scope preconditions and shared scope locks;
  preserve message drafts on conflict; no automatic public promises.
- Resolved workspace links narrative review to owned follow-up tasks and shows
  unfinished work without blocking impact resolution.
- Exit: scope races cannot bypass a reviewed-scope check; private fields never
  appear publicly; completion cannot swallow a concurrent edit; deadlines and
  review state survive restart. Existing providers remain unchanged.
- Excludes reminder delivery, shared draft editor, public postmortems and new
  subscriber/stakeholder channels.

### M-004 — Release qualification and integration

Depends on M-001 through M-003.

- Full PostgreSQL upgrade/concurrency/security regression, production/restart
  acceptance journey, browser matrix and release-surface consistency.
- Update architecture, API, security, README and development/upgrade guidance;
  reconcile stale 0.2 implementation statements. Record exact evidence and any
  unqualified browser environments. Bump version only with integrated code.
- Exit: the acceptance journey and invariants are evidenced on the candidate
  commit, with no unresolved data-loss, authorization, public-disclosure or
  handoff-concurrency failures. Founder integration/release closure remains
  distinct from passing tests; do not publish a speculative `v0.3.0` tag.

Critical path: M-000 → M-001 → M-002 → M-003 → M-004. M-001 is the highest
architectural risk; M-003 owns the publication/configuration race. Reduce scope
by deferring a whole capability and revising this proposal before implementation,
not by shipping unqualified concurrency or public-boundary behavior. Calendar
estimates require implementation sizing and are not implied by milestone count.

## Explicit non-goals

- Track B features: silences, scheduled maintenance, fingerprints, grouping,
  flapping suppression, and paging rate/burst policies. Existing configured
  MAINTENANCE component state is unchanged and is not scheduled suppression.
- Runbook authoring/versioning/execution, task templates, workflow engines,
  task dependencies, arbitrary incident roles, AI triage or remediation.
- New incident states, auto-declaration/resolution, incident merging, automatic
  ownership from on-call rotation, and silently converting acknowledgements
  into command acceptance.
- Reminder jobs, stakeholder subscriptions, public update scheduling, durable
  incident-notification redesign, Slack bots, SMS, voice or mobile apps.
- Rich-text collaborative drafts, attachments, external issue trackers,
  public postmortems, review approval hierarchies and immutable audience receipts.
- New organization-role systems, SSO/SAML/SCIM, multi-region/worker-platform
  changes, telemetry storage, billing, themes or custom public domains.
- A general project-management backlog or analytics product. Tasks exist to
  operate and learn from a canonical incident.

This definition deliberately spends the release on making a response coherent
after the page succeeds. Noise control is the next decision to revisit with
operator evidence, not an implicit addition to these milestones.
