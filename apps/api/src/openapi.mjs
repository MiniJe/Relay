import { RELAY_VERSION } from '../../../packages/shared/version.mjs';

const json = (schema) => ({ required: true, content: { 'application/json': { schema } } });
const ok = (description) => ({ '200': { description } });
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });

export const openapi = {
  openapi: '3.1.0',
  info: {
    title: 'Relay API',
    version: RELAY_VERSION,
    description: 'Versioned API for Relay incident operations, alert routing, on-call resolution and status communication.'
  },
  servers: [{ url: '/api/v1' }],
  paths: {
    '/health': { get: { summary: 'Liveness and product version', responses: ok('Health') } },
    '/auth/register': { post: { summary: 'Register a local user', responses: { '201': { description: 'Registered' } } } },
    '/auth/login': { post: { summary: 'Create a secure session', responses: ok('Authenticated') } },
    '/auth/logout': { post: { summary: 'End the current session', responses: { '204': { description: 'Signed out' } } } },
    '/me': { get: { summary: 'Current user and organizations', responses: ok('Session profile') } },
    '/organizations': { get: { summary: 'List organizations' }, post: { summary: 'Create organization' } },
    '/organizations/{organizationId}/services': { get: { summary: 'List services, including the owning responder team' }, post: { summary: 'Create service' } },
    '/organizations/{organizationId}/services/{serviceId}': {
      patch: {
        summary: 'Update a service, including on-call ownership',
        description: 'OWNER/ADMIN only. `ownerTeamId` associates an internal Service with a responder team; `null` clears ownership. A team from another organization is rejected.',
        requestBody: json({ type: 'object', properties: { name: { type: 'string' }, slug: { type: 'string' }, description: { type: 'string' }, operationalState: { type: 'string' }, ownerTeamId: { type: ['string', 'null'] } } }),
        responses: ok('Updated service')
      }
    },
    '/organizations/{organizationId}/components': { get: { summary: 'List public components' }, post: { summary: 'Create component' } },
    '/organizations/{organizationId}/components/{componentId}': { patch: { summary: 'Update a public component' } },
    '/organizations/{organizationId}/status-pages': { get: { summary: 'List status pages' }, post: { summary: 'Create status page' } },
    '/organizations/{organizationId}/incidents': { get: { summary: 'List incidents' }, post: { summary: 'Create incident' } },
    '/organizations/{organizationId}/incidents/{incidentId}': { get: { summary: 'Incident workspace data' }, patch: { summary: 'Change severity, lifecycle state, commander, or affected entities' } },
    '/organizations/{organizationId}/incidents/{incidentId}/responders': { post: { summary: 'Join/add responder' } },
    '/organizations/{organizationId}/incidents/{incidentId}/updates': { post: { summary: 'Create internal or public incident update' } },
    '/organizations/{organizationId}/incidents/{incidentId}/resolve': { post: { summary: 'Resolve incident' } },
    '/organizations/{organizationId}/incidents/{incidentId}/postmortem': { put: { summary: 'Create or edit resolved-incident postmortem' } },

    // ---- Relay 0.2: responder teams ----
    '/organizations/{organizationId}/members': {
      get: { summary: 'List organization members', description: 'Used by the Teams and Discord-mapping surfaces. Never exposed through any public endpoint.' }
    },
    '/organizations/{organizationId}/teams': {
      get: { summary: 'List responder teams', responses: ok('Teams with member and owned-service counts') },
      post: {
        summary: 'Create a responder team',
        description: 'OWNER/ADMIN only.',
        requestBody: json({ type: 'object', required: ['name'], properties: { name: { type: 'string', minLength: 2, maxLength: 120 }, slug: { type: 'string' }, description: { type: 'string', maxLength: 2000 } } }),
        responses: { '201': { description: 'Created team' } }
      }
    },
    '/organizations/{organizationId}/teams/{teamId}': {
      get: { summary: 'Responder team with members and owned services', responses: ok('Team detail') },
      patch: { summary: 'Update a responder team (OWNER/ADMIN)' }
    },
    '/organizations/{organizationId}/teams/{teamId}/members': {
      get: { summary: 'List team members', responses: ok('Members') },
      post: {
        summary: 'Add an organization member to a responder team',
        description: 'OWNER/ADMIN only. Team membership never bypasses organization membership or RBAC: a user who is not a member of this organization is rejected with INVALID_REFERENCE, so a user from another organization cannot be attached through an identifier.',
        requestBody: json({ type: 'object', required: ['userId'], properties: { userId: { type: 'string' } } }),
        responses: { '201': { description: 'Member added' }, '400': { description: 'User is not a member of this organization' } }
      }
    },
    '/organizations/{organizationId}/teams/{teamId}/members/{userId}': {
      delete: { summary: 'Remove a member from a responder team (OWNER/ADMIN). Also removes them from that team\'s rotations.', responses: ok('Removal result') }
    },

    // ---- Relay 0.2: on-call ----
    '/organizations/{organizationId}/oncall/state': {
      get: {
        summary: 'Who is on call right now, for every schedule',
        description: 'Deterministic server-side resolution. `at` accepts an ISO-8601 timestamp for reproducible queries and testing; it defaults to the current instant.',
        parameters: [{ name: 'at', in: 'query', schema: { type: 'string', format: 'date-time' } }],
        responses: ok('Per-schedule current responder, next handoffs and active override')
      }
    },
    '/organizations/{organizationId}/oncall/schedules': {
      get: { summary: 'List on-call schedules with resolved state', parameters: [{ name: 'at', in: 'query', schema: { type: 'string', format: 'date-time' } }] },
      post: {
        summary: 'Create an on-call schedule (OWNER/ADMIN)',
        requestBody: json(ref('ScheduleInput')),
        responses: { '201': { description: 'Created schedule' } }
      }
    },
    '/organizations/{organizationId}/oncall/schedules/{scheduleId}': {
      get: { summary: 'Schedule detail with rotation order, overrides and current responder' },
      patch: { summary: 'Update a schedule, its timezone, enabled state or rotation participants (OWNER/ADMIN)' }
    },
    '/organizations/{organizationId}/oncall/schedules/{scheduleId}/oncall': {
      get: {
        summary: 'Resolve the on-call responder for one schedule',
        description: 'Answers "who is on call for this schedule at timestamp T?" deterministically. Handoff instants are absolute UTC instants derived from `rotationStartsAt + k * rotationIntervalMinutes`; the schedule timezone never affects arithmetic.',
        parameters: [{ name: 'at', in: 'query', schema: { type: 'string', format: 'date-time' } }],
        responses: ok('Resolution result')
      }
    },
    '/organizations/{organizationId}/oncall/schedules/{scheduleId}/overrides': {
      get: { summary: 'List overrides for a schedule' },
      post: {
        summary: 'Create a temporary on-call override (OWNER/ADMIN)',
        description: 'Requires `startsAt < endsAt`. Overlapping overrides for the same schedule are rejected with OVERRIDE_OVERLAP so the resolved responder is never ambiguous. When the override expires the normal rotation resumes unchanged.',
        requestBody: json(ref('OverrideInput')),
        responses: { '201': { description: 'Created override' }, '409': { description: 'Override overlaps an existing window' } }
      }
    },
    '/organizations/{organizationId}/oncall/overrides/{overrideId}': {
      get: { summary: 'Override detail' },
      delete: { summary: 'Delete an override (OWNER/ADMIN); the rotation resumes immediately', responses: { '204': { description: 'Deleted' } } }
    },

    // ---- Relay 0.2: routing rules ----
    '/organizations/{organizationId}/routing-rules': {
      get: { summary: 'List alert routing rules in deterministic evaluation order' },
      post: {
        summary: 'Create an alert routing rule (OWNER/ADMIN)',
        description: 'Rules match on service, alert source and alert severity. Conditions are exact after trimming and case-folding — there is no wildcard or expression language. Rules are evaluated by `priority` ascending, then creation time, then id; the first match wins.',
        requestBody: json(ref('RoutingRuleInput')),
        responses: { '201': { description: 'Created rule' } }
      }
    },
    '/organizations/{organizationId}/routing-rules/{ruleId}': {
      get: { summary: 'Routing rule detail' },
      patch: { summary: 'Update a rule, its enabled state, priority, conditions, notification channels or escalation policy (OWNER/ADMIN)' },
      delete: { summary: 'Delete a routing rule (OWNER/ADMIN)', responses: { '204': { description: 'Deleted' } } }
    },
    '/organizations/{organizationId}/escalation-policies': {
      get: { summary: 'List escalation policies and ordered steps' },
      post: { summary: 'Create an organization-scoped escalation policy with ordered steps (OWNER/ADMIN)', requestBody: json(ref('EscalationPolicyInput')), responses: { '201': { description: 'Created policy' } } }
    },
    '/organizations/{organizationId}/escalation-policies/{policyId}': {
      get: { summary: 'Read escalation policy and steps' },
      put: { summary: 'Replace policy definition and steps (OWNER/ADMIN); existing alert plans are immutable snapshots' },
      patch: { summary: 'Replace policy definition and steps (OWNER/ADMIN)' },
      delete: { summary: 'Delete policy for future routing; existing materialized jobs remain independent', responses: { '204': { description: 'Deleted' } } }
    },

    // ---- Relay 0.2: alerts and routing results ----
    '/organizations/{organizationId}/alerts': {
      get: { summary: 'List ingested alerts with their routing decision, responder and acknowledgement state' }
    },
    '/organizations/{organizationId}/alerts/{alertId}': { get: { summary: 'Alert detail with routing record' } },
    '/organizations/{organizationId}/alerts/{alertId}/routing': {
      get: { summary: 'Auditable routing record for one alert', description: 'Records which rule matched, which schedule was selected, which user was actually on call at routing time, notification status and acknowledgement. Snapshot names mean history never changes when a later rotation or rename happens.' }
    },
    '/organizations/{organizationId}/alerts/{alertId}/acknowledge': {
      post: {
        summary: 'Acknowledge a routed alert',
        description: 'OWNER/ADMIN/RESPONDER only; VIEWER and non-members are rejected. The first acknowledgement wins and is recorded under a row lock, so repeating the call is an idempotent no-op reported through `alreadyAcknowledged`. Alert acknowledgement is not incident resolution.',
        responses: {
          '200': {
            description: 'Acknowledged. `data` is the routing record; `alreadyAcknowledged` is a top-level flag (like `warnings`) so the audit record itself stays pure.',
            content: { 'application/json': { schema: { type: 'object', properties: { data: { $ref: '#/components/schemas/AlertRouting' }, alreadyAcknowledged: { type: 'boolean' } } } } }
          },
          '403': { description: 'Not authorized' }, '409': { description: 'Alert predates alert routing' }
        }
      }
    },
    '/organizations/{organizationId}/alerts/{alertId}/route': {
      post: {
        summary: 'Re-evaluate routing for an alert (explicit operator action)',
        description: 'OWNER/ADMIN/RESPONDER only. An alert whose notification was already SENT is not re-paged unless `renotify: true` is supplied explicitly.',
        requestBody: json({ type: 'object', properties: { renotify: { type: 'boolean', default: false } } }),
        responses: ok('Routing record')
      }
    },
    '/organizations/{organizationId}/alerts/{alertId}/deliveries': {
      get: {
        summary: 'Delivery audit for one alert',
        description: 'Every logical page created for the alert, with its immutable attempt history. Readable by any organization member; provider secrets are never part of a delivery or an attempt.',
        responses: ok('Deliveries plus a compact summary (total, status, label, attempts, nextAttemptAt, providers)')
      }
    },
    '/organizations/{organizationId}/deliveries/{deliveryId}': {
      get: { summary: 'One delivery with its attempt history and the alert it belongs to', responses: { '200': { description: 'Delivery' }, '404': { description: 'Not found in this organization' } } }
    },
    '/organizations/{organizationId}/deliveries/{deliveryId}/retry': {
      post: {
        summary: 'Manually retry a failed page (OWNER/ADMIN/RESPONDER)',
        description: 'A manual retry adds an attempt; it never rewrites history. VIEWER and non-members are rejected, an already delivered page answers 409 DELIVERY_ALREADY_SENT, and a page cancelled by acknowledgement answers 409 DELIVERY_CANCELLED.',
        responses: { '202': { description: 'Retry scheduled and attempted under the same bounded policy' }, '403': { description: 'Not authorized' }, '409': { description: 'Not retryable' } }
      }
    },
    '/organizations/{organizationId}/alerts/{alertId}/escalation': {
      get: {
        summary: 'Escalation plan and execution state for one alert',
        description: 'Reports what was planned, what executed, which responder was resolved at execution time, what was sent or cancelled, and what is still pending. Reading this never re-resolves on-call state.',
        responses: ok('AlertEscalationState')
      }
    },
    '/organizations/{organizationId}/alerts/{alertId}/incidents': {
      post: {
        summary: 'Create an incident from an alert (explicit human action)',
        description: 'Alerts are observed technical signal; incidents are operational lifecycle objects. Relay never declares an incident automatically. Escalating twice for the same alert returns ALERT_ALREADY_ESCALATED, preserving alert → incident traceability.',
        requestBody: json({ type: 'object', properties: { title: { type: 'string' }, summary: { type: 'string' }, severity: { type: 'string', enum: ['SEV1', 'SEV2', 'SEV3', 'SEV4'] }, affectedServiceIds: { type: 'array', items: { type: 'string' } }, affectedComponentIds: { type: 'array', items: { type: 'string' } } } }),
        responses: { '201': { description: 'Created incident, linked back to the alert' }, '409': { description: 'Alert already escalated' } }
      }
    },
    '/organizations/{organizationId}/routings': { get: { summary: 'Routing audit list across recent alerts' } },

    // ---- Relay 0.2: Discord responder mapping ----
    '/organizations/{organizationId}/discord-identities': {
      get: { summary: 'List Relay user → Discord user mappings (OWNER/ADMIN only)', description: 'Personal notification mappings are administrative configuration. They are never exposed to read-only roles, and never through any public status endpoint.' }
    },
    '/organizations/{organizationId}/discord-identities/{userId}': {
      put: {
        summary: 'Map a Relay user to a Discord user id (OWNER/ADMIN)',
        description: 'Optional. No OAuth. The value must be a numeric Discord snowflake, which keeps it inert: it cannot carry Markdown or a mention payload. When no mapping exists the notification still identifies the responder by display name.',
        requestBody: json({ type: 'object', required: ['discordUserId'], properties: { discordUserId: { type: 'string', pattern: '^[0-9]{15,25}$' } } }),
        responses: ok('Stored mapping')
      },
      delete: { summary: 'Remove a Discord mapping (OWNER/ADMIN)', responses: ok('Removal result') }
    },

    '/organizations/{organizationId}/integrations': { get: { summary: 'List configured integrations without secrets' } },
    '/organizations/{organizationId}/integrations/discord': { put: { summary: 'Configure Discord webhook integration (OWNER/ADMIN). The webhook secret is never returned by any read.' } },
    '/organizations/{organizationId}/integrations/slack': {
      put: {
        summary: 'Configure Slack paging with an Incoming Webhook URL (OWNER/ADMIN)',
        description: 'Only https://hooks.slack.com/services/... URLs are accepted, and the stored URL is never returned by any read. Slack bots, slash commands and interactive incident management are deliberately not implemented.',
        requestBody: json(ref('SlackIntegrationInput')),
        responses: ok('Stored integration without its secret')
      },
      delete: { summary: 'Remove the Slack integration (OWNER/ADMIN); queued pages then fail closed rather than being misrouted', responses: ok('Removal result') }
    },
    '/organizations/{organizationId}/integrations/smtp': {
      put: {
        summary: 'Configure responder email paging over SMTP (OWNER/ADMIN)',
        description: 'The password is stored encrypted and is never returned or logged; reads report only whether a credential is configured. A responder is only ever emailed at their own Relay account address.',
        requestBody: json(ref('SmtpIntegrationInput')),
        responses: ok('Stored integration without its secret')
      },
      delete: { summary: 'Remove the SMTP integration (OWNER/ADMIN)', responses: ok('Removal result') }
    },
    '/organizations/{organizationId}/events': { get: { summary: 'SSE stream for organization refresh events (incidents, alert routing, acknowledgement, on-call)' } },
    '/alerts': {
      post: {
        summary: 'Generic durable alert intake with routing',
        description: 'Validates, persists and routes the alert. Matching `(organization, source, externalId)` submissions return the existing alert with `duplicate: true` and never create a second routing record or notification. Routing or delivery failure never rolls the alert back.',
        security: [{ alertKey: [] }],
        requestBody: json(ref('AlertIntake')),
        responses: { '202': { description: 'Alert accepted and routing attempted' } }
      }
    },
    '/public/status/{slug}': { get: { summary: 'Public status page payload. Never exposes on-call schedules, routing rules or notification mappings.' } },
    '/public/status/{slug}/incidents/{incidentId}': { get: { summary: 'Public incident detail. Internal notes and timeline are filtered out.' } }
  },
  components: {
    securitySchemes: {
      cookieSession: { type: 'apiKey', in: 'cookie', name: 'relay_session' },
      alertKey: { type: 'apiKey', in: 'header', name: 'x-relay-alert-key' }
    },
    schemas: {
      EscalationPolicyInput: {
        type: 'object', required: ['name','steps'],
        properties: { name: { type: 'string', minLength: 2, maxLength: 120 }, description: { type: 'string', maxLength: 2000 }, enabled: { type: 'boolean' }, steps: { type: 'array', maxItems: 32, items: { type: 'object', required: ['position','afterMinutes','targetScheduleId','channels'], properties: { position: { type: 'integer', minimum: 0 }, afterMinutes: { type: 'integer', minimum: 1, description: 'Offset from initial routing time, not the previous step.' }, targetScheduleId: { type: 'string' }, channels: { type: 'array', minItems: 1, items: { type: 'string', enum: ['DISCORD','SLACK','EMAIL'] } } } } } }
      },
      AlertIntake: {
        type: 'object',
        required: ['organizationSlug', 'source', 'title', 'severity'],
        properties: {
          organizationSlug: { type: 'string' },
          source: { type: 'string', maxLength: 120 },
          externalId: { type: 'string', maxLength: 200, description: 'Idempotency key, scoped to (organization, source).' },
          title: { type: 'string', maxLength: 200 },
          description: { type: 'string', maxLength: 5000 },
          severity: { type: 'string', maxLength: 40 },
          serviceIdentifier: { type: 'string', description: 'Service id or slug within the organization.' },
          metadata: { type: 'object' },
          timestamp: { type: 'string', format: 'date-time' }
        }
      },
      AlertRouting: {
        type: 'object',
        description: 'Immutable audit record of one routing decision. Names are snapshotted at evaluation time, so a later rename of a rule, schedule or team never rewrites history. Exactly one record exists per alert (UNIQUE alert_id).',
        required: ['id', 'organizationId', 'alertId', 'resolution', 'notificationStatus', 'evaluatedAt'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          organizationId: { type: 'string', format: 'uuid' },
          alertId: { type: 'string', format: 'uuid' },
          ruleId: { type: ['string', 'null'], format: 'uuid', description: 'Nulled if the rule is later deleted; ruleName still records what matched.' },
          ruleName: { type: ['string', 'null'] },
          scheduleId: { type: ['string', 'null'], format: 'uuid' },
          scheduleName: { type: ['string', 'null'] },
          teamId: { type: ['string', 'null'], format: 'uuid' },
          teamName: { type: ['string', 'null'] },
          oncallUserId: { type: ['string', 'null'], format: 'uuid', description: 'The responder who was on call at the routing instant.' },
          oncallDisplayName: { type: ['string', 'null'] },
          responderSource: { type: ['string', 'null'], enum: ['ROTATION', 'OVERRIDE', null] },
          overrideId: { type: ['string', 'null'], format: 'uuid' },
          resolution: {
            type: 'string',
            enum: ['PENDING', 'ROUTED', 'NO_MATCHING_RULE', 'SCHEDULE_DISABLED', 'SCHEDULE_MISSING', 'ROTATION_NOT_STARTED', 'NO_PARTICIPANTS', 'RULE_TARGET_MISSING'],
            description: 'Why the alert did or did not reach a responder. Non-ROUTED values are explicit outcomes, never silent drops.'
          },
          periodStartsAt: { type: ['string', 'null'], format: 'date-time', description: 'Start of the rotation or override period the responder was resolved from.' },
          periodEndsAt: { type: ['string', 'null'], format: 'date-time' },
          notificationStatus: {
            type: 'string',
            enum: ['NOT_ATTEMPTED', 'SENT', 'FAILED', 'SKIPPED_NO_INTEGRATION', 'SKIPPED_DISABLED', 'SKIPPED_NO_RESPONDER']
          },
          notificationProvider: { type: ['string', 'null'], enum: ['DISCORD', null] },
          notificationError: { type: ['string', 'null'], description: 'Truncated delivery error. Never contains webhook secrets.' },
          notifiedAt: { type: ['string', 'null'], format: 'date-time' },
          discordUserId: { type: ['string', 'null'], description: 'The mapped Discord snowflake that was mentioned, if any.' },
          acknowledgedAt: { type: ['string', 'null'], format: 'date-time' },
          acknowledgedByUserId: { type: ['string', 'null'], format: 'uuid' },
          acknowledgedByDisplayName: { type: ['string', 'null'] },
          incidentId: { type: ['string', 'null'], format: 'uuid', description: 'Set only when a human explicitly escalates the alert. Alert acknowledgement is not incident resolution.' },
          evaluatedAt: { type: 'string', format: 'date-time' },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' }
        }
      },
      ScheduleInput: {
        type: 'object',
        required: ['name', 'teamId', 'rotationIntervalMinutes', 'participantUserIds'],
        properties: {
          name: { type: 'string', minLength: 2, maxLength: 120 },
          teamId: { type: 'string' },
          timeZone: { type: 'string', description: 'IANA identifier such as Europe/Bucharest, Europe/London, America/New_York or UTC.', default: 'UTC' },
          enabled: { type: 'boolean', default: true },
          rotationStartsAt: { type: 'string', format: 'date-time', description: 'Absolute instant anchoring every handoff boundary.' },
          rotationIntervalMinutes: { type: 'integer', minimum: 60, maximum: 525600, description: 'Handoff interval, unambiguously in minutes. 1440 = daily, 10080 = weekly.' },
          participantUserIds: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'string' }, description: 'Ordered rotation participants; each must be a member of the team.' }
        }
      },
      OverrideInput: {
        type: 'object',
        required: ['replacementUserId', 'startsAt', 'endsAt'],
        properties: {
          replacementUserId: { type: 'string' },
          startsAt: { type: 'string', format: 'date-time' },
          endsAt: { type: 'string', format: 'date-time' },
          reason: { type: 'string', maxLength: 500 }
        }
      },
      NotificationDelivery: {
        type: 'object',
        description: 'One durable page: the persisted intent to notify one responder over one channel. Created when routing decides to notify or when an escalation step executes.',
        required: ['id', 'provider', 'status', 'attemptCount'],
        properties: {
          id: { type: 'string' },
          alertId: { type: 'string' },
          routingId: { type: ['string', 'null'] },
          escalationJobId: { type: ['string', 'null'], description: 'Null for the immediate page; set when the page came from an escalation step.' },
          provider: { type: 'string', enum: ['DISCORD', 'SLACK', 'EMAIL'] },
          status: { type: 'string', enum: ['PENDING', 'IN_FLIGHT', 'RETRYING', 'SENT', 'FAILED', 'CANCELLED'] },
          statusLabel: { type: 'string', description: 'Operator-readable label; the UI never depends on a raw status token.' },
          responderUserId: { type: ['string', 'null'] },
          responderDisplayName: { type: ['string', 'null'], description: 'Snapshot taken at enqueue time so a later rename never rewrites history.' },
          attemptCount: { type: 'integer', minimum: 0, maximum: 3 },
          nextAttemptAt: { type: ['string', 'null'], format: 'date-time' },
          scheduledAt: { type: ['string', 'null'], format: 'date-time' },
          completedAt: { type: ['string', 'null'], format: 'date-time' },
          lastError: { type: ['string', 'null'], description: 'Operator-readable failure reason. Never contains a webhook URL, token or password.' },
          destination: { type: 'object', description: 'Non-secret description of where the page went (webhook name, integration name, recipient address).' },
          attempts: { type: 'array', items: { $ref: '#/components/schemas/DeliveryAttempt' } }
        }
      },
      DeliveryAttempt: {
        type: 'object',
        description: 'An immutable record of one provider call or one skipped attempt.',
        required: ['attemptNumber', 'outcome'],
        properties: {
          id: { type: 'string' },
          attemptNumber: { type: 'integer', minimum: 1, maximum: 3 },
          outcome: { type: 'string', enum: ['SENT', 'RETRYABLE_FAILURE', 'PERMANENT_FAILURE'] },
          providerStatusCode: { type: ['integer', 'null'] },
          safeError: { type: ['string', 'null'] },
          startedAt: { type: ['string', 'null'], format: 'date-time' },
          completedAt: { type: ['string', 'null'], format: 'date-time' },
          manualRetryByUserId: { type: ['string', 'null'], description: 'Set when the attempt was requested by a person through the retry endpoint.' }
        }
      },
      AlertEscalationState: {
        type: 'object',
        description: 'Read model over the persisted escalation jobs and deliveries of one alert.',
        properties: {
          policyId: { type: ['string', 'null'] },
          policyName: { type: ['string', 'null'] },
          planned: { type: 'integer' },
          executed: { type: 'integer' },
          cancelled: { type: 'integer' },
          unresolved: { type: 'integer', description: 'Steps that executed but resolved no responder; never silently retried into a page for the wrong person.' },
          nextDueAt: { type: ['string', 'null'], format: 'date-time' },
          due: { type: 'boolean' },
          immediateDeliveries: { type: 'array', items: { $ref: '#/components/schemas/NotificationDelivery' } },
          steps: { type: 'array', items: { $ref: '#/components/schemas/EscalationStepState' } }
        }
      },
      EscalationStepState: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          position: { type: 'integer' },
          afterMinutes: { type: 'integer' },
          dueAt: { type: 'string', format: 'date-time' },
          targetScheduleId: { type: ['string', 'null'] },
          targetScheduleName: { type: ['string', 'null'] },
          channels: { type: 'array', items: { type: 'string' } },
          state: { type: 'string', enum: ['PENDING', 'IN_FLIGHT', 'COMPLETED', 'FAILED', 'CANCELLED_ACKNOWLEDGED'] },
          stateLabel: { type: 'string' },
          resolvedResponder: { type: ['object', 'null'], properties: { userId: { type: 'string' }, displayName: { type: ['string', 'null'] } } },
          outcome: { type: 'object' },
          deliveries: { type: 'array', items: { $ref: '#/components/schemas/NotificationDelivery' } }
        }
      },
      SlackIntegrationInput: {
        type: 'object',
        required: ['webhookUrl'],
        properties: {
          name: { type: 'string', maxLength: 80 },
          webhookUrl: { type: 'string', description: 'Must be an https://hooks.slack.com/services/... Incoming Webhook URL; anything else is rejected before storage.' },
          enabled: { type: 'boolean', default: true }
        }
      },
      SmtpIntegrationInput: {
        type: 'object',
        required: ['host', 'port'],
        properties: {
          name: { type: 'string', maxLength: 80 },
          host: { type: 'string', maxLength: 253 },
          port: { type: 'integer', minimum: 1, maximum: 65535 },
          secure: { type: 'boolean', description: 'Implicit TLS. Rejected for ports 25 and 587, which are STARTTLS ports.' },
          username: { type: ['string', 'null'], maxLength: 320 },
          password: { type: 'string', maxLength: 500, description: 'Write-only. Never returned by any read; omit or set keepExistingPassword to retain the stored credential.' },
          keepExistingPassword: { type: 'boolean', description: 'Edit support: keep the stored password instead of supplying a new one.' },
          fromEmail: { type: 'string', description: 'Defaults to the configured username when it is an address.' },
          fromName: { type: 'string', maxLength: 120 },
          enabled: { type: 'boolean', default: true },
          timeoutMs: { type: 'integer', minimum: 1000, maximum: 120000, default: 10000 }
        }
      },
      RoutingRuleInput: {
        type: 'object',
        required: ['name', 'targetScheduleId'],
        properties: {
          name: { type: 'string', minLength: 2, maxLength: 160 },
          enabled: { type: 'boolean', default: true },
          priority: { type: 'integer', minimum: 0, maximum: 100000, default: 100, description: 'Lower number evaluates first. Ties break deterministically on creation time, then id.' },
          matchServiceId: { type: ['string', 'null'], description: 'Null matches any service.' },
          matchSource: { type: ['string', 'null'], description: 'Exact match after trimming and case-folding. Null matches any source.' },
          matchSeverities: { type: 'array', items: { type: 'string' }, description: 'Empty array matches any severity.' },
          targetKind: { type: 'string', enum: ['ONCALL_SCHEDULE'], default: 'ONCALL_SCHEDULE' },
          targetScheduleId: { type: 'string' },
          notificationChannels: { type: 'array', items: { type: 'string', enum: ['DISCORD','SLACK','EMAIL'] }, default: ['DISCORD'] },
          escalationPolicyId: { type: ['string','null'], description: 'Optional organization-scoped escalation policy.' }
        }
      }
    }
  }
};

// Incident command foundation. The public serializers remain explicit allowlists.
const incidentBase='/organizations/{organizationId}/incidents/{incidentId}';
const shortText={type:'string',minLength:1,maxLength:1000};
const nullableUser={type:['string','null'],description:'Eligible OWNER/ADMIN/RESPONDER member in this organization. Null clears the responsibility.'};
const nullableDate={type:['string','null'],format:'date-time',description:'RFC 3339 with an explicit offset. Private target; no publication or reminders.'};
const commandSchema=(required,properties)=>({type:'object',additionalProperties:false,required,properties});
const commandResponses={
  '200':{description:'Committed aggregate, revision (decimal string), resulting entity and ETag; exact create replay has replayed=true.'},
  '201':{description:'Created task or pending handoff; state and timeline committed together.'},
  '400':{description:'Invalid input or ineligible/cross-tenant assignment.'},
  '401':{description:'Session required.'},'403':{description:'Organization/action authority required.'},
  '404':{description:'Record absent in the authorized organization.'},
  '409':{description:'Illegal transition, pending handoff, or idempotency conflict.'},
  '412':{description:'REVISION_MISMATCH; preserve the draft, fetch current state and deliberately retry.'},
  '428':{description:'PRECONDITION_REQUIRED.'}
};
const command=(summary,schema,description)=>({summary,description,parameters:[{in:'header',name:'If-Match',required:true,schema:{type:'string'},description:'Exact strong ETag from incident GET: "incident-{id}-r{revision}". New commands require it; revision never grants permission.'}],requestBody:json(schema),responses:commandResponses});
const uuid={type:'string',format:'uuid',description:'Client-generated stable create ID. Only original creator can replay identical normalized payload; changed payload conflicts.'};
const taskFields={title:{type:'string',minLength:1,maxLength:200},description:{type:'string',maxLength:5000},assigneeUserId:nullableUser,dueAt:nullableDate};
openapi.paths[incidentBase+'/tasks']={
  get:{summary:'Read private incident tasks',description:'VIEWER can read. Stable createdAt/id keyset pagination; limit 1–100 (default 50), cursor scoped to tenant/incident/resource. Envelope includes incidentRevision and page.nextCursor/page.total.',responses:ok('Tasks')},
  post:command('Create assigned incident work',commandSchema(['id','kind','title'],{id:uuid,kind:{type:'string',enum:['RESPONSE','FOLLOW_UP']},...taskFields}),'OWNER/ADMIN/RESPONDER. Response creation requires active incident; follow-up creation requires resolution. Unassigned work is explicit. No automatic pages.')
};
openapi.paths[incidentBase+'/tasks/{taskId}']={get:{summary:'Read a private task',responses:ok('Task')},patch:command('Update task ownership, due date or lifecycle',commandSchema([],{...taskFields,state:{type:'string',enum:['TODO','IN_PROGRESS','BLOCKED','DONE','CANCELLED']},blockedReason:shortText,cancellationReason:shortText}),'OWNER/ADMIN/RESPONDER. BLOCKED and CANCELLED require their reason. Terminal states require explicit reopen. Existing response work remains editable after resolution; assignments never grant permissions.')};
openapi.paths[incidentBase+'/tasks/{taskId}/reopen']={post:command('Reopen terminal work',commandSchema(['reason'],{reason:shortText}),'OWNER/ADMIN/RESPONDER. DONE/CANCELLED → TODO with audited reason.')};
openapi.paths[incidentBase+'/handoffs']={get:{summary:'Read private handoff history',description:'Stable createdAt/id pagination; limit 1–100 (default 50), scoped cursor; page.total and incidentRevision included.',responses:ok('Handoffs')},post:command('Propose command handoff',commandSchema(['id','toUserId','note'],{id:uuid,toUserId:{type:'string'},note:{type:'string',minLength:1,maxLength:5000}}),'Current commander or OWNER/ADMIN; active incident; one pending transfer. Current commander remains responsible until named eligible recipient accepts.')};
for(const action of ['accept','decline','cancel'])openapi.paths[incidentBase+`/handoffs/{handoffId}/${action}`]={post:command(`${action[0].toUpperCase()+action.slice(1)} handoff`,commandSchema(action==='cancel'?['reason']:[],action==='accept'?{}:{reason:shortText}),action==='cancel'?'Proposer, current commander or OWNER/ADMIN; reason required. Commander unchanged.':'Named eligible recipient only, including administrators. Acceptance transfers command and joins responder roster atomically. Decline keeps current commander. Terminal same-action replay with current ETag is a no-op.')};
openapi.paths[incidentBase+'/commander/reassign']={post:command('Administrative command recovery',commandSchema(['userId','reason'],{userId:{type:'string'},reason:shortText}),'OWNER/ADMIN only; active incident. Explicitly bypasses acceptance, cancels pending transfer and audits the reason.')};
openapi.paths[incidentBase+'/communication-plan']={patch:command('Set private update responsibility',commandSchema([],{ownerUserId:nullableUser,nextUpdateAt:nullableDate}),'OWNER/ADMIN/RESPONDER. Omission preserves; null clears. Resolved incidents cannot schedule another deadline. Responsibility is not exclusive publication authority.')};
openapi.paths[incidentBase].get.description='Canonical internal aggregate: commanderDisplayName, revision as decimal string, private tasks/handoffs/linkedAlerts and communication plan. ETag provided. Public APIs exclude operational data.';
for(const [suffix,method] of [['','patch'],['/responders','post'],['/updates','post'],['/resolve','post'],['/postmortem','put']]){
  const operation=openapi.paths[incidentBase+suffix][method];
  operation.parameters=[{in:'header',name:'If-Match',required:false,schema:{type:'string'},description:'Optional for legacy clients; 0.3 UI always sends it. Omission retains transaction-local, supplied-field last-writer-wins semantics.'}];
  operation.responses={...commandResponses};delete operation.responses['428'];
}
openapi.paths[incidentBase].patch.summary='Change severity, lifecycle, summary or affected entities';
openapi.paths[incidentBase].patch.description='Commander changes/clears return 409 HANDOFF_REQUIRED; unchanged commander is allowed. Use accepted handoff or administrative recovery.';
openapi.paths[incidentBase+'/updates'].post.requestBody=json({type:'object',required:['message'],properties:{message:{type:'string',minLength:1,maxLength:5000},isPublic:{type:'boolean',default:false},nextPublicUpdateAt:nullableDate,reviewedScope:commandSchema(['componentIds','statusPageIds'],{componentIds:{type:'array',items:{type:'string'}},statusPageIds:{type:'array',items:{type:'string'}}})}});
openapi.paths[incidentBase+'/updates'].post.description='Only publication path. Optional reviewedScope compares exact affected components/public page IDs inside the transaction; mismatch is 409 PUBLIC_SCOPE_CHANGED. Legacy clients may omit scope. Internal notes cannot change deadlines. Publication without nextPublicUpdateAt preserves the plan.';

openapi.components.schemas.IncidentTask={type:'object',required:['id','organizationId','incidentId','kind','title','state','createdAt','updatedAt'],properties:{id:{type:'string'},organizationId:{type:'string'},incidentId:{type:'string'},kind:{type:'string',enum:['RESPONSE','FOLLOW_UP']},...taskFields,state:{type:'string',enum:['TODO','IN_PROGRESS','BLOCKED','DONE','CANCELLED']},assigneeNameSnapshot:{type:['string','null']},blockedReason:{type:['string','null']},cancellationReason:{type:['string','null']},createdByUserId:{type:'string'},createdByNameSnapshot:{type:'string'},createdAt:{type:'string',format:'date-time'},updatedAt:{type:'string',format:'date-time'},completedAt:nullableDate}};
openapi.components.schemas.IncidentHandoff={type:'object',required:['id','organizationId','incidentId','toUserId','state','note'],properties:{id:{type:'string'},organizationId:{type:'string'},incidentId:{type:'string'},fromUserId:{type:['string','null']},toUserId:{type:'string'},requestedByUserId:{type:'string'},note:{type:'string'},fromNameSnapshot:{type:['string','null']},toNameSnapshot:{type:'string'},requestedByNameSnapshot:{type:'string'},state:{type:'string',enum:['PENDING','ACCEPTED','DECLINED','CANCELLED']},createdAt:{type:'string',format:'date-time'},decidedAt:nullableDate,decidedByUserId:{type:['string','null']},decidedByNameSnapshot:{type:['string','null']},decisionReason:{type:['string','null']}}};
openapi.components.schemas.IncidentCommandResult={type:'object',required:['revision','incident'],properties:{revision:{type:'string',pattern:'^[1-9][0-9]*$'},task:ref('IncidentTask'),handoff:ref('IncidentHandoff'),incident:{type:'object',description:'Complete internal incident aggregate; includes tasks, handoffs, linkedAlerts, communicationsOwnerUserId and nextPublicUpdateAt.'}}};
for(const suffix of ['/tasks','/tasks/{taskId}','/tasks/{taskId}/reopen','/handoffs','/handoffs/{handoffId}/accept','/handoffs/{handoffId}/decline','/handoffs/{handoffId}/cancel','/commander/reassign','/communication-plan']){
  for(const operation of Object.values(openapi.paths[incidentBase+suffix]))if(operation.requestBody)for(const status of ['200','201'])operation.responses[status]={...operation.responses[status],headers:{ETag:{schema:{type:'string'},description:'Current strong incident ETag.'}},content:{'application/json':{schema:{type:'object',required:['data'],properties:{data:ref('IncidentCommandResult'),replayed:{type:'boolean'}}}}}};
}
