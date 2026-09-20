# Relay 0.1 Security

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

## Input/output handling

- JSON bodies have a hard maximum size.
- String lengths and enums are validated.
- PostgreSQL access uses parameterized queries.
- Browser mutation requests with an `Origin` header must match `APP_ORIGIN`.
- Public UI text is escaped before HTML insertion.
- CSP, frame denial, content-type protection, and same-origin referrer headers are set on static responses.

## Integration secrets

Discord webhook URLs are encrypted at rest using AES-256-GCM. The application key is supplied through `INTEGRATION_ENCRYPTION_KEY` and must not be committed.

Only HTTPS webhook URLs hosted on Discord domains are accepted, limiting SSRF exposure through this adapter.

## Alert intake

Generic alert intake requires `x-relay-alert-key`; comparison is constant-time. The endpoint is rate-limited and payload-limited. Release 0.1 uses one deployment-level intake key; per-integration scoped ingest credentials are appropriate future work.

## Rate limiting

Release 0.1 applies process-local sliding-window limits to authentication attempts, alert intake, and public status requests. This is suitable for the single-process 0.1 deployment. A shared rate-limit backend is required before multi-instance horizontal scale.

## Public-data boundary

Public status responses include public incident attributes and only updates explicitly marked public. They do not expose:

- internal notes;
- internal timeline entries;
- responder email addresses;
- integration configuration;
- alert payloads.

## Secrets

`.env` is ignored by Git and excluded from the Docker build context. `.env.example` contains placeholders only. `npm run check:secrets` scans application, test, documentation, CI, and deployment text for several common credential patterns. Production deployments should additionally use platform secret stores and repository secret scanning.

## Known 0.1 security limitations

- No MFA, OAuth/OIDC, SAML, or SCIM.
- No dedicated immutable administrative audit log beyond actor-attributed incident timeline actions.
- Process-local rate limiting and SSE hub assume a single Relay application process.
- The alert intake key is deployment-wide rather than per organization/source.
- There is no password reset/email verification workflow in 0.1.

These are disclosed limitations, not authorization to implement future enterprise identity or alert-routing scope.
