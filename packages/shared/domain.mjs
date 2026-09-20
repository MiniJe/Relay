export const ROLES = Object.freeze(['OWNER', 'ADMIN', 'RESPONDER', 'VIEWER']);
export const INCIDENT_STATUSES = Object.freeze(['INVESTIGATING', 'IDENTIFIED', 'MONITORING', 'RESOLVED']);
export const SEVERITIES = Object.freeze(['SEV1', 'SEV2', 'SEV3', 'SEV4']);
export const COMPONENT_STATES = Object.freeze([
  'OPERATIONAL',
  'DEGRADED_PERFORMANCE',
  'PARTIAL_OUTAGE',
  'MAJOR_OUTAGE',
  'MAINTENANCE'
]);

const transitions = Object.freeze({
  INVESTIGATING: new Set(['IDENTIFIED', 'MONITORING', 'RESOLVED']),
  IDENTIFIED: new Set(['INVESTIGATING', 'MONITORING', 'RESOLVED']),
  MONITORING: new Set(['INVESTIGATING', 'IDENTIFIED', 'RESOLVED']),
  RESOLVED: new Set([])
});

export function canTransitionIncident(from, to) {
  if (from === to) return true;
  return Boolean(transitions[from]?.has(to));
}

export function assertIncidentTransition(from, to) {
  if (!INCIDENT_STATUSES.includes(from) || !INCIDENT_STATUSES.includes(to)) {
    throw domainError('INVALID_INCIDENT_STATUS', 'Invalid incident status.', 400);
  }
  if (!canTransitionIncident(from, to)) {
    throw domainError('INVALID_INCIDENT_TRANSITION', `Incident cannot transition from ${from} to ${to}.`, 409);
  }
}

export function assertSeverity(value) {
  if (!SEVERITIES.includes(value)) throw domainError('INVALID_SEVERITY', 'Severity must be SEV1, SEV2, SEV3, or SEV4.', 400);
}

export function incidentSeverityToComponentState(severity) {
  switch (severity) {
    case 'SEV1': return 'MAJOR_OUTAGE';
    case 'SEV2': return 'PARTIAL_OUTAGE';
    case 'SEV3':
    case 'SEV4': return 'DEGRADED_PERFORMANCE';
    default: return 'DEGRADED_PERFORMANCE';
  }
}

const stateRank = Object.freeze({
  OPERATIONAL: 0,
  MAINTENANCE: 1,
  DEGRADED_PERFORMANCE: 2,
  PARTIAL_OUTAGE: 3,
  MAJOR_OUTAGE: 4
});

export function worstComponentState(states) {
  if (!states?.length) return 'OPERATIONAL';
  return states.reduce((worst, current) => (stateRank[current] ?? -1) > (stateRank[worst] ?? -1) ? current : worst, 'OPERATIONAL');
}

export function aggregatePublicStatus(components, activeIncidents) {
  const incidentByComponent = new Map();
  for (const incident of activeIncidents ?? []) {
    const derived = incidentSeverityToComponentState(incident.severity);
    for (const componentId of incident.affectedComponentIds ?? []) {
      const existing = incidentByComponent.get(componentId) ?? 'OPERATIONAL';
      incidentByComponent.set(componentId, worstComponentState([existing, derived]));
    }
  }
  const effectiveComponents = (components ?? []).map((component) => {
    const incidentState = incidentByComponent.get(component.id) ?? 'OPERATIONAL';
    return { ...component, effectiveState: worstComponentState([component.operationalState, incidentState]) };
  });
  return {
    overallStatus: worstComponentState(effectiveComponents.map((component) => component.effectiveState)),
    components: effectiveComponents
  };
}

export function hasRole(actualRole, allowedRoles) {
  return allowedRoles.includes(actualRole);
}

export function slugify(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export function domainError(code, message, status = 400, details = undefined) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  if (details !== undefined) error.details = details;
  return error;
}
