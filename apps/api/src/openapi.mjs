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
