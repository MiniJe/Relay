# Relay Security

Covers Release 0.1 and the Release 0.2 alert-routing and on-call additions.

## Authentication

Passwords are hashed with scrypt using a random per-password salt. Plaintext passwords are never persisted.

Session cookies contain opaque random tokens. The database stores only SHA-256 token hashes, reducing impact if the sessions table is disclosed. Cookies are HttpOnly and SameSite=Lax; production mode adds Secure.

## Authorization and tenant isolation

Organization membership is checked server-side on every organization-scoped API route. Client UI state is not trusted for authorization.

Mutation authority is separated from read access:

- OWNER / ADMIN: workspace configuration plus incident authority.
- RESPONDER: incident authority.
- VIEWER: read-only.

Affected service/component references are validated against the incident organization before persistence.
Incident commander references are also required to resolve to a membership in the same organization.

### Relay 0.2 authorization

| Capability | OWNER | ADMIN | RESPONDER | VIEWER | non-member |
| --- | --- | --- | --- | --- | --- |
| Configure teams, memberships, schedules, overrides, routing rules | ✅ | ✅ | ❌ | ❌ | ❌ |
| Configure Discord webhook and responder identity mapping | ✅ | ✅ | ❌ | ❌ | ❌ |
| Read on-call state, alerts, routing records, audit trail | ✅ | ✅ | ✅ | ✅ | ❌ |
| Acknowledge an alert | ✅ | ✅ | ✅ | ❌ | ❌ |
| Re-evaluate routing (`renotify`) | ✅ | ✅ | ✅ | ❌ | ❌ |
| Escalate an alert into an incident | ✅ | ✅ | ✅ | ❌ | ❌ |

Every one of these decisions is enforced server-side in the route handler before
any store access. Controls hidden in the UI are a courtesy, never a boundary; the
test suite exercises each capability with a VIEWER and with a member of a
different organization and asserts the HTTP status, not the rendered interface.

Team membership grants no authority. It is an operational annotation that
constrains who may appear in a rotation, and it is enforced by a composite
foreign key to `organization_memberships(organization_id, user_id)` — a user
outside the organization cannot be inserted into a team, a rotation or an
override even by a direct database write.

### Cross-tenant references

Every 0.2 reference is validated against the requesting organization before
persistence, and the database repeats the check with composite unique keys and
composite foreign keys:

- a schedule's `teamId` must belong to the organization;
- a rotation participant must be a member of that team *and* the organization
  (`INVALID_PARTICIPANT`);
- an override's `replacementUserId` must be an organization member
  (`INVALID_REFERENCE`);
- a rule's `matchServiceId` and `targetScheduleId` must belong to the
  organization;
- a service's `ownerTeamId` must belong to the organization;
- alert acknowledgement, re-routing and escalation all resolve the alert within
  the organization first, so an identifier from another tenant is a `404`, never
  a `403` that confirms the identifier exists.

## Input/output handling

- JSON bodies have a hard maximum size.
- String lengths and enums are validated.
- PostgreSQL access uses parameterized queries.
- Browser mutation requests with an `Origin` header must match `APP_ORIGIN`.
- Public UI text is escaped before HTML insertion.
- CSP, frame denial, content-type protection, and same-origin referrer headers are set on static responses.

### Relay 0.2 input handling

- **Timezones.** A schedule timezone must match an IANA `Area/Location` shape
  (or be exactly `UTC`), be at most 64 characters, and be accepted by the
  runtime's `Intl` implementation. `Local`, `GMT+3`,
  `Europe/Bucharest; DROP TABLE users` and `<script>…</script>` are all rejected
  with `400 INVALID_TIMEZONE` before reaching a formatter, a query or the UI.
- **Rotation intervals** must be whole minutes within 60-525600, enforced in
  validation *and* by a database CHECK constraint.
- **Override windows** must have `startsAt < endsAt`, enforced in validation and
  by a CHECK constraint.
- **Rule priorities** must be integers within 0-100000, enforced twice.
- **Discord snowflakes** must be 15-25 digits, enforced in validation and by a
  database CHECK constraint, so a mapping can never be stored as an
  `@everyone`-shaped or markup-shaped string.
- **Alert metadata** is validated as a plain JSON object with a serialized size
  cap. Prototype-pollution-shaped keys are inert data: nothing in the routing
  path reads metadata, so it can influence neither rule matching nor resolution.
- **No expression language.** Routing conditions are exact comparisons after
  trimming and case-folding. There is no `eval`, no `new Function`, no regex or
  glob supplied by the operator and no user-programmable predicate, so a rule can
  never become a code-execution surface and alert content can never change how a
  rule is evaluated.

## Integration secrets

Discord webhook URLs are encrypted at rest using AES-256-GCM. The application key is supplied through `INTEGRATION_ENCRYPTION_KEY` and must not be committed.

Only HTTPS webhook URLs hosted on Discord domains are accepted, limiting SSRF exposure through this adapter.

### Relay 0.2 outbound message safety

Alert content originates from third-party monitoring systems and is treated as
untrusted text all the way to the wire:

- `sanitizeDiscordText` strips angle brackets (so alert text cannot forge an
  embed, a mention or Discord markdown), defangs `@everyone` and `@here`,
  removes control characters, and truncates to a fixed length;
- `allowed_mentions` is pinned to `{parse: [], users: [<mapped responder>]}`.
  Only the resolved responder may be mentioned, and only by a snowflake Relay
  itself stored; no role ping is reachable from alert content;
- the delivery failure path logs `error.message` only. The webhook URL, its
  token and the request body are never logged;
- `alert_routings.notification_error` is truncated to 900 characters and stores
  a message, never a URL, so the audit trail cannot become a secret store.

The Discord responder mapping stores a public snowflake and requires no OAuth
flow, no token and no additional secret. It is admin-only, organization-scoped
and unique per user.

## Alert intake

Generic alert intake requires `x-relay-alert-key`; comparison is constant-time. The endpoint is rate-limited and payload-limited. Relay uses one deployment-level intake key; per-integration scoped ingest credentials are appropriate future work.

### Relay 0.2 routing safety

- **Durability precedes routing.** The alert and its `PENDING` routing record are
  committed before evaluation, so no routing bug, misconfiguration or Discord
  outage can be used to make an accepted alert disappear.
- **The responder is chosen by the server clock.** Resolution happens at the
  routing instant, never at the alert's own `timestamp`. Because `timestamp` is
  caller-controlled, using it would let anyone able to post an alert decide which
  employee is paged, or page somebody who was on call hours ago.
- **No duplicate paging.** `(organization, source, externalId)` idempotency plus
  `UNIQUE (alert_id)` means concurrent or replayed deliveries produce one alert,
  one routing record and one page. Re-notification requires an explicit
  `renotify: true` from an authorized human.
- **No automatic incident creation.** Nothing in the routing path can create an
  incident. Escalation is an explicit, authorized, at-most-once human action, so
  a flood of alerts cannot manufacture operational state or public status
  changes.
- **Failures are visible, not silent.** Non-routing outcomes are first-class
  recorded resolutions (`NO_MATCHING_RULE`, `SCHEDULE_DISABLED`,
  `ROTATION_NOT_STARTED`, `NO_PARTICIPANTS`, `RULE_TARGET_MISSING`,
  `SCHEDULE_MISSING`) and delivery failures are recorded with a status and a
  truncated error, surfaced in the Alerts table and the routing audit.

## Rate limiting

Release 0.1 applies process-local sliding-window limits to authentication attempts, alert intake, and public status requests. This is suitable for the single-process 0.1 deployment. A shared rate-limit backend is required before multi-instance horizontal scale.

## Public-data boundary

Public status responses include public incident attributes and only updates explicitly marked public. They do not expose:

- internal notes;
- internal timeline entries;
- responder email addresses;
- integration configuration;
- alert payloads.

Relay 0.2 widens the internal side without widening the public side. On-call
data is operational and confidential, so **none** of the following may ever
appear in a public response:

- responder teams, rosters or membership;
- on-call schedules, rotations, participants or timezones;
- overrides, their reasons or their creators;
- routing rules, their conditions or their priorities;
- routing records, notification outcomes or acknowledgement state;
- alerts and alert metadata;
- Discord user ids or webhook configuration.

An incident escalated from an alert is published through the same canonical
incident projection as any other incident; the alert it came from is not
reachable publicly. `tests/routing.integration.test.mjs` and
`tests/routing.e2e.test.mjs` assert the absence of each of these strings in the
serialized public payload.

## Secrets

`.env` is ignored by Git and excluded from the Docker build context. `.env.example` contains placeholders only. `npm run check:secrets` scans application, test, documentation, CI, and deployment text for several common credential patterns. Production deployments should additionally use platform secret stores and repository secret scanning.

## Known security limitations

- No MFA, OAuth/OIDC, SAML, or SCIM.
- No dedicated immutable administrative audit log. Relay 0.2's routing records
  are an immutable audit of *routing decisions*, not of configuration changes:
  who edited a schedule, reordered a rotation or deleted a rule is not recorded.
- Process-local rate limiting and SSE hub assume a single Relay application process.
- The alert intake key is deployment-wide rather than per organization/source.
  Anyone holding it can post alerts to any organization in the deployment, which
  can page on-call responders. Protect it accordingly; scoped ingest credentials
  are appropriate future work.
- There is no password reset/email verification workflow.
- Notification delivery makes one attempt with no retry queue. A `FAILED` record
  is visible and re-pageable by a human, but Relay will not autonomously retry.
- There is no escalation policy: if the resolved responder does not acknowledge,
  nothing further happens automatically.
- On-call resolution trusts the server clock. A deployment with a badly skewed
  clock will resolve the wrong rotation position; NTP discipline is an operator
  responsibility.

These are disclosed limitations, not authorization to implement future enterprise
identity, escalation or autonomous-paging scope.
