export const openapi = {
  openapi: '3.1.0',
  info: { title: 'Relay API', version: '0.1.0', description: 'Versioned API for Relay incident operations and status communication.' },
  servers: [{ url: '/api/v1' }],
  paths: {
    '/auth/register': { post: { summary: 'Register a local user', responses: { '201': { description: 'Registered' } } } },
    '/auth/login': { post: { summary: 'Create a secure session', responses: { '200': { description: 'Authenticated' } } } },
    '/auth/logout': { post: { summary: 'End the current session', responses: { '204': { description: 'Signed out' } } } },
    '/me': { get: { summary: 'Current user and organizations', responses: { '200': { description: 'Session profile' } } } },
    '/organizations': { get: { summary: 'List organizations' }, post: { summary: 'Create organization' } },
    '/organizations/{organizationId}/services': { get: { summary: 'List services' }, post: { summary: 'Create service' } },
    '/organizations/{organizationId}/components': { get: { summary: 'List public components' }, post: { summary: 'Create component' } },
    '/organizations/{organizationId}/status-pages': { get: { summary: 'List status pages' }, post: { summary: 'Create status page' } },
    '/organizations/{organizationId}/incidents': { get: { summary: 'List incidents' }, post: { summary: 'Create incident' } },
    '/organizations/{organizationId}/incidents/{incidentId}': { get: { summary: 'Incident workspace data' }, patch: { summary: 'Change severity, lifecycle state, commander, or affected entities' } },
    '/organizations/{organizationId}/incidents/{incidentId}/responders': { post: { summary: 'Join/add responder' } },
    '/organizations/{organizationId}/incidents/{incidentId}/updates': { post: { summary: 'Create internal or public incident update' } },
    '/organizations/{organizationId}/incidents/{incidentId}/resolve': { post: { summary: 'Resolve incident' } },
    '/organizations/{organizationId}/incidents/{incidentId}/postmortem': { put: { summary: 'Create or edit resolved-incident postmortem' } },
    '/organizations/{organizationId}/alerts': { get: { summary: 'List ingested alerts' } },
    '/organizations/{organizationId}/integrations': { get: { summary: 'List configured integrations without secrets' } },
    '/organizations/{organizationId}/integrations/discord': { put: { summary: 'Configure Discord webhook integration' } },
    '/organizations/{organizationId}/events': { get: { summary: 'SSE stream for organization incident refresh events' } },
    '/alerts': { post: { summary: 'Generic durable alert intake', security: [{ alertKey: [] }] } },
    '/public/status/{slug}': { get: { summary: 'Public status page payload' } },
    '/public/status/{slug}/incidents/{incidentId}': { get: { summary: 'Public incident detail' } }
  },
  components: { securitySchemes: { cookieSession: { type: 'apiKey', in: 'cookie', name: 'relay_session' }, alertKey: { type: 'apiKey', in: 'header', name: 'x-relay-alert-key' } } }
};
