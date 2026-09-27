import crypto from 'node:crypto';
import { domainError } from '../shared/domain.mjs';
import { validateEscalationSteps } from '../shared/escalation.mjs';

const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();
const clone = (value) => value === undefined ? undefined : structuredClone(value);

export class MemoryStore {
  constructor() {
    this.users = [];
    this.organizations = [];
    this.memberships = [];
    this.sessions = [];
    this.services = [];
    this.components = [];
    this.componentServices = [];
    this.statusPages = [];
    this.statusPageComponents = [];
    this.incidents = [];
    this.incidentServices = [];
    this.incidentComponents = [];
    this.responders = [];
    this.timeline = [];
    this.updates = [];
    this.postmortems = [];
    this.alerts = [];
    this.integrations = [];
    this.escalationPolicies = [];
    this.escalationPolicySteps = [];
    this.escalationJobs = [];
    this.notificationDeliveries = [];
    this.notificationAttempts = [];
    this.teams = [];
    this.teamMembers = [];
    this.schedules = [];
    this.scheduleParticipants = [];
    this.overrides = [];
    this.routingRules = [];
    this.alertRoutings = [];
    this.discordIdentities = [];
  }

  async createUser({ email, displayName, passwordHash }) {
    if (this.users.some((u) => u.email === email)) throw domainError('EMAIL_IN_USE', 'An account with this email already exists.', 409);
    const user = { id: uid(), email, displayName, passwordHash, createdAt: now() };
    this.users.push(user);
    return clone(user);
  }
  async getUserByEmail(email) { return clone(this.users.find((u) => u.email === email)); }
  async getUserById(id) { return clone(this.users.find((u) => u.id === id)); }

  async createSession({ userId, tokenHash, expiresAt }) {
    const session = { id: uid(), userId, tokenHash, expiresAt, createdAt: now() };
    this.sessions.push(session);
    return clone(session);
  }
  async getSession(tokenHash) {
    const session = this.sessions.find((s) => s.tokenHash === tokenHash && new Date(s.expiresAt).getTime() > Date.now());
    if (!session) return undefined;
    const user = this.users.find((u) => u.id === session.userId);
    return user ? { ...clone(session), user: clone(user) } : undefined;
  }
  async deleteSession(tokenHash) { this.sessions = this.sessions.filter((s) => s.tokenHash !== tokenHash); }

  async createOrganization({ userId, name, slug }) {
    if (this.organizations.some((o) => o.slug === slug)) throw domainError('SLUG_IN_USE', 'Organization slug is already in use.', 409);
    const at = now();
    const org = { id: uid(), name, slug, createdAt: at, updatedAt: at };
    this.organizations.push(org);
    this.memberships.push({ organizationId: org.id, userId, role: 'OWNER', createdAt: at });
    return clone(org);
  }
  async listOrganizationsForUser(userId) {
    return this.memberships.filter((m) => m.userId === userId).map((m) => ({ ...clone(this.organizations.find((o) => o.id === m.organizationId)), role: m.role }));
  }
  async getOrganization(id) { return clone(this.organizations.find((o) => o.id === id)); }
  async getOrganizationBySlug(slug) { return clone(this.organizations.find((o) => o.slug === slug)); }
  async getMembership(organizationId, userId) { return clone(this.memberships.find((m) => m.organizationId === organizationId && m.userId === userId)); }
  async listMemberships(organizationId) {
    return this.memberships.filter((m) => m.organizationId === organizationId).map((m) => ({ ...clone(m), user: clone(this.users.find((u) => u.id === m.userId)) }));
  }

  async createService(organizationId, input) {
    if (this.services.some((s) => s.organizationId === organizationId && s.slug === input.slug)) throw domainError('SLUG_IN_USE', 'Service slug is already in use.', 409);
    const at = now();
    const service = { id: uid(), organizationId, ...input, ownerTeamId: input.ownerTeamId ?? null, createdAt: at, updatedAt: at };
    this.services.push(service);
    return { ...clone(service), ownerTeamName: service.ownerTeamId ? (this.teams.find((t)=>t.id===service.ownerTeamId)?.name ?? null) : null };
  }
  async listServices(organizationId) { return this.services.filter((s) => s.organizationId === organizationId).map((s)=>({ ...clone(s), ownerTeamName: s.ownerTeamId ? (this.teams.find((t)=>t.id===s.ownerTeamId)?.name ?? null) : null })); }
  async getService(organizationId, serviceId) { return clone(this.services.find((s) => s.organizationId === organizationId && s.id === serviceId)); }
  async updateService(organizationId, serviceId, patch) {
    const service = this.services.find((s) => s.organizationId === organizationId && s.id === serviceId);
    if (!service) return undefined;
    if ('ownerTeamId' in patch && patch.ownerTeamId) {
      const team = this.teams.find((t) => t.organizationId === organizationId && t.id === patch.ownerTeamId);
      if (!team) throw domainError('INVALID_REFERENCE', 'The owning responder team must belong to the same organization.', 400);
    }
    const { ownerTeamId, ...rest } = patch;
    Object.assign(service, rest, { updatedAt: now() });
    if ('ownerTeamId' in patch) service.ownerTeamId = ownerTeamId ?? null;
    return { ...clone(service), ownerTeamName: service.ownerTeamId ? (this.teams.find((t)=>t.id===service.ownerTeamId)?.name ?? null) : null };
  }

  async createComponent(organizationId, input) {
    if (this.components.some((c) => c.organizationId === organizationId && c.slug === input.slug)) throw domainError('SLUG_IN_USE', 'Component slug is already in use.', 409);
    const at = now();
    const { serviceIds = [], ...fields } = input;
    const component = { id: uid(), organizationId, ...fields, createdAt: at, updatedAt: at };
    this.components.push(component);
    this.componentServices.push(...serviceIds.map((serviceId) => ({ componentId: component.id, serviceId })));
    return { ...clone(component), serviceIds: clone(serviceIds) };
  }
  async listComponents(organizationId) {
    return this.components.filter((c) => c.organizationId === organizationId).map((c) => ({ ...clone(c), serviceIds: this.componentServices.filter((x) => x.componentId === c.id).map((x) => x.serviceId) }));
  }
  async getComponent(organizationId, componentId) {
    const c = this.components.find((x) => x.organizationId === organizationId && x.id === componentId);
    return c ? { ...clone(c), serviceIds: this.componentServices.filter((x) => x.componentId === c.id).map((x) => x.serviceId) } : undefined;
  }
  async updateComponent(organizationId, componentId, patch) {
    const component = this.components.find((c) => c.organizationId === organizationId && c.id === componentId);
    if (!component) return undefined;
    const { serviceIds, ...fields } = patch;
    Object.assign(component, fields, { updatedAt: now() });
    if (serviceIds) {
      this.componentServices = this.componentServices.filter((x) => x.componentId !== componentId);
      this.componentServices.push(...serviceIds.map((serviceId) => ({ componentId, serviceId })));
    }
    return this.getComponent(organizationId, componentId);
  }

  async createStatusPage(organizationId, input) {
    if (this.statusPages.some((p) => p.slug === input.slug)) throw domainError('SLUG_IN_USE', 'Status page slug is already in use.', 409);
    const at = now();
    const { componentIds, ...fields } = input;
    const page = { id: uid(), organizationId, ...fields, createdAt: at, updatedAt: at };
    this.statusPages.push(page);
    this.statusPageComponents.push(...componentIds.map((componentId, sortOrder) => ({ statusPageId: page.id, componentId, sortOrder })));
    return { ...clone(page), componentIds: clone(componentIds) };
  }
  async listStatusPages(organizationId) {
    return this.statusPages.filter((p) => p.organizationId === organizationId).map((p) => ({ ...clone(p), componentIds: this.statusPageComponents.filter((x) => x.statusPageId === p.id).sort((a,b)=>a.sortOrder-b.sortOrder).map((x)=>x.componentId) }));
  }
  async getPublicStatusPage(slug) {
    const page = this.statusPages.find((p) => p.slug === slug && p.isPublic);
    if (!page) return undefined;
    const componentIds = this.statusPageComponents.filter((x) => x.statusPageId === page.id).sort((a,b)=>a.sortOrder-b.sortOrder).map((x) => x.componentId);
    const components = this.components.filter((c) => componentIds.includes(c.id));
    const incidents = this.incidents.filter((i) => i.organizationId === page.organizationId && this.incidentComponents.some((x) => x.incidentId === i.id && componentIds.includes(x.componentId)))
      .sort((a,b)=>new Date(b.startedAt)-new Date(a.startedAt))
      .slice(0, 30)
      .map((i) => this.#incidentView(i));
    return { page: clone(page), components: clone(components), incidents: clone(incidents) };
  }

  #incidentView(i) {
    return {
      ...clone(i),
      affectedServiceIds: this.incidentServices.filter((x) => x.incidentId === i.id).map((x) => x.serviceId),
      affectedComponentIds: this.incidentComponents.filter((x) => x.incidentId === i.id).map((x) => x.componentId),
      responders: this.responders.filter((x) => x.incidentId === i.id).map((x) => ({ ...clone(x), user: clone(this.users.find((u)=>u.id===x.userId)) })),
      timeline: this.timeline.filter((x) => x.incidentId === i.id).sort((a,b)=>new Date(a.occurredAt)-new Date(b.occurredAt)).map((x)=>({ ...clone(x), actor: clone(this.users.find((u)=>u.id===x.actorUserId)) })),
      updates: this.updates.filter((x) => x.incidentId === i.id).sort((a,b)=>new Date(a.createdAt)-new Date(b.createdAt)).map((x)=>({ ...clone(x), actor: clone(this.users.find((u)=>u.id===x.actorUserId)) })),
      postmortem: clone(this.postmortems.find((x) => x.incidentId === i.id))
    };
  }

  async createIncident(organizationId, record, affectedServiceIds, affectedComponentIds, event) {
    const at = now();
    const incident = { id: uid(), organizationId, ...record, status: 'INVESTIGATING', startedAt: at, acknowledgedAt: null, resolvedAt: null, createdAt: at, updatedAt: at };
    this.incidents.push(incident);
    this.incidentServices.push(...affectedServiceIds.map((serviceId)=>({incidentId:incident.id,serviceId})));
    this.incidentComponents.push(...affectedComponentIds.map((componentId)=>({incidentId:incident.id,componentId})));
    this.responders.push({ incidentId: incident.id, userId: record.creatorUserId, joinedAt: at });
    this.timeline.push({ id: uid(), incidentId: incident.id, occurredAt: at, ...event });
    return this.getIncident(organizationId, incident.id);
  }
  async listIncidents(organizationId) {
    return this.incidents.filter((i)=>i.organizationId===organizationId).sort((a,b)=>new Date(b.startedAt)-new Date(a.startedAt)).map((i)=>this.#incidentView(i));
  }
  async getIncident(organizationId, incidentId) {
    const incident = this.incidents.find((i)=>i.organizationId===organizationId && i.id===incidentId);
    return incident ? this.#incidentView(incident) : undefined;
  }
  async updateIncident(organizationId, incidentId, patch, { affectedServiceIds, affectedComponentIds, events = [] } = {}) {
    const incident = this.incidents.find((i)=>i.organizationId===organizationId && i.id===incidentId);
    if (!incident) return undefined;
    Object.assign(incident, patch, { updatedAt: now() });
    if (patch.status === 'RESOLVED' && !incident.resolvedAt) incident.resolvedAt = now();
    if (affectedServiceIds) {
      this.incidentServices = this.incidentServices.filter((x)=>x.incidentId!==incidentId);
      this.incidentServices.push(...affectedServiceIds.map((serviceId)=>({incidentId,serviceId})));
    }
    if (affectedComponentIds) {
      this.incidentComponents = this.incidentComponents.filter((x)=>x.incidentId!==incidentId);
      this.incidentComponents.push(...affectedComponentIds.map((componentId)=>({incidentId,componentId})));
    }
    for (const event of events) this.timeline.push({ id: uid(), incidentId, occurredAt: now(), ...event });
    return this.getIncident(organizationId, incidentId);
  }
  async addIncidentUpdate(organizationId, incidentId, { actorUserId, message, isPublic }, event) {
    const incident = this.incidents.find((i)=>i.organizationId===organizationId && i.id===incidentId);
    if (!incident) return undefined;
    const update = { id: uid(), incidentId, actorUserId, message, isPublic, createdAt: now() };
    this.updates.push(update);
    this.timeline.push({ id: uid(), incidentId, occurredAt: now(), ...event });
    incident.updatedAt = now();
    return { update: clone(update), incident: await this.getIncident(organizationId, incidentId) };
  }
  async addResponder(organizationId, incidentId, userId, actorUserId) {
    const incident = this.incidents.find((i)=>i.organizationId===organizationId && i.id===incidentId);
    if (!incident) return undefined;
    if (!this.responders.some((x)=>x.incidentId===incidentId && x.userId===userId)) {
      this.responders.push({ incidentId, userId, joinedAt: now() });
      this.timeline.push({ id: uid(), incidentId, actorUserId, eventType: 'RESPONDER_JOINED', message: 'Responder joined the incident.', metadata: { userId }, occurredAt: now() });
    }
    return this.getIncident(organizationId, incidentId);
  }
  async upsertPostmortem(organizationId, incidentId, input, userId) {
    const incident = this.incidents.find((i)=>i.organizationId===organizationId && i.id===incidentId);
    if (!incident) return undefined;
    const existing = this.postmortems.find((p)=>p.incidentId===incidentId);
    if (existing) Object.assign(existing, input, { updatedAt: now() });
    else this.postmortems.push({ id: uid(), incidentId, ...input, createdByUserId:userId, createdAt:now(), updatedAt:now() });
    this.timeline.push({ id: uid(), incidentId, actorUserId:userId, eventType: existing ? 'POSTMORTEM_UPDATED' : 'POSTMORTEM_CREATED', message: existing ? 'Postmortem updated.' : 'Postmortem created.', metadata:{}, occurredAt:now() });
    return this.getIncident(organizationId, incidentId);
  }

  // ---------------------------------------------------------------------
  // Relay 0.2 — alert intake, routing audit records and acknowledgement.
  // Mirrors the PostgreSQL contract: one routing record per alert, created
  // atomically with the alert, and an idempotent first-wins acknowledgement.
  // ---------------------------------------------------------------------
  async ingestAlert(organizationId, input) {
    const existing = input.externalId
      ? this.alerts.find((a) => a.organizationId === organizationId && a.source === input.source && a.externalId === input.externalId)
      : undefined;
    if (existing) return { alert: clone(existing), created: false, routing: clone(this.alertRoutings.find((r) => r.alertId === existing.id)) };
    // Normalise the same defaults as PostgresStore so both stores answer the
    // store contract identically for partially-specified alert input.
    const alert = {
      id: uid(), organizationId, source: input.source, externalId: input.externalId ?? null,
      title: input.title, description: input.description ?? '', severity: input.severity,
      serviceId: input.serviceId ?? null, metadata: input.metadata ?? {},
      observedAt: input.observedAt ?? now(), receivedAt: now()
    };
    this.alerts.push(alert);
    const routing = {
      id: uid(), organizationId, alertId: alert.id, ruleId: null, ruleName: null, scheduleId: null, scheduleName: null,
      teamId: null, teamName: null, oncallUserId: null, oncallDisplayName: null, responderSource: null, overrideId: null,
      resolution: 'PENDING', periodStartsAt: null, periodEndsAt: null, notificationStatus: 'NOT_ATTEMPTED',
      notificationProvider: null, notificationError: null, notifiedAt: null, discordUserId: null,
      acknowledgedAt: null, acknowledgedByUserId: null, acknowledgedByDisplayName: null, incidentId: null,
      evaluatedAt: null, createdAt: now(), updatedAt: now()
    };
    this.alertRoutings.push(routing);
    return { alert: clone(alert), created: true, routing: clone(routing) };
  }
  async listAlerts(organizationId) { return clone(this.alerts.filter((a)=>a.organizationId===organizationId).sort((a,b)=>new Date(b.receivedAt)-new Date(a.receivedAt))); }
  async getAlert(organizationId, alertId) { return clone(this.alerts.find((a)=>a.organizationId===organizationId && a.id===alertId)); }

  #routingRecord(routing) {
    if (!routing) return undefined;
    const alert = this.alerts.find((a) => a.id === routing.alertId);
    const ackUser = this.users.find((u) => u.id === routing.acknowledgedByUserId);
    return {
      ...clone(routing),
      acknowledgedByDisplayName: routing.acknowledgedByDisplayName ?? ackUser?.displayName ?? null,
      alertSource: alert?.source ?? null, alertTitle: alert?.title ?? null,
      alertSeverity: alert?.severity ?? null, alertReceivedAt: alert?.receivedAt ?? null
    };
  }
  async listAlertsWithRouting(organizationId, { limit = 200 } = {}) {
    const size = Math.max(1, Math.min(500, Number(limit) || 200));
    return this.alerts
      .filter((a) => a.organizationId === organizationId)
      .sort((a, b) => new Date(b.receivedAt) - new Date(a.receivedAt) || String(b.id).localeCompare(String(a.id)))
      .slice(0, size)
      .map((alert) => {
        const routing = this.alertRoutings.find((r) => r.alertId === alert.id);
        const service = this.services.find((s) => s.id === alert.serviceId);
        return {
          ...clone(alert),
          serviceName: service?.name ?? null,
          routing: routing ? clone(routing) : null
        };
      });
  }
  async getAlertRouting(organizationId, alertId) {
    const routing = this.alertRoutings.find((r) => r.organizationId === organizationId && r.alertId === alertId);
    return this.#routingRecord(routing);
  }
  async recordAlertRouting(organizationId, alertId, decision) {
    let routing = this.alertRoutings.find((r) => r.organizationId === organizationId && r.alertId === alertId);
    if (!routing) {
      if (!this.alerts.some((a) => a.organizationId === organizationId && a.id === alertId)) return undefined;
      routing = { id: uid(), organizationId, alertId, createdAt: now() };
      this.alertRoutings.push(routing);
    }
    Object.assign(routing, {
      ruleId: decision.ruleId ?? null, ruleName: decision.ruleName ?? null,
      scheduleId: decision.scheduleId ?? null, scheduleName: decision.scheduleName ?? null,
      teamId: decision.teamId ?? null, teamName: decision.teamName ?? null,
      oncallUserId: decision.oncallUserId ?? null, oncallDisplayName: decision.oncallDisplayName ?? null,
      responderSource: decision.responderSource ?? null, overrideId: decision.overrideId ?? null,
      resolution: decision.resolution, periodStartsAt: decision.periodStartsAt ?? null,
      periodEndsAt: decision.periodEndsAt ?? null, evaluatedAt: now(), updatedAt: now()
    });
    return this.#routingRecord(routing);
  }
  async recordRoutingNotification(organizationId, alertId, { status, provider, error, notifiedAt, discordUserId }) {
    const routing = this.alertRoutings.find((r) => r.organizationId === organizationId && r.alertId === alertId);
    if (!routing) return undefined;
    Object.assign(routing, {
      notificationStatus: status, notificationProvider: provider ?? null,
      notificationError: error ? String(error).slice(0, 900) : null,
      notifiedAt: notifiedAt ?? null, discordUserId: discordUserId ?? null, updatedAt: now()
    });
    return this.#routingRecord(routing);
  }
  async acknowledgeAlertRouting(organizationId, alertId, { userId, displayName }) {
    const routing = this.alertRoutings.find((r) => r.organizationId === organizationId && r.alertId === alertId);
    if (!routing) return undefined;
    if (routing.acknowledgedAt) return { routing: this.#routingRecord(routing), alreadyAcknowledged: true };
    const acknowledgedAt=now();
    Object.assign(routing, { acknowledgedAt, acknowledgedByUserId: userId, acknowledgedByDisplayName: displayName ?? null, updatedAt: acknowledgedAt });
    this.escalationJobs=this.escalationJobs.map((job)=>job.organizationId===organizationId&&job.alertId===alertId&&['PENDING','IN_FLIGHT'].includes(job.state)?{...job,state:'CANCELLED_ACKNOWLEDGED',updatedAt:acknowledgedAt}:job);
    // Deliveries that were never attempted are still "future pages": once the
    // alert is acknowledged they are cancelled. Anything that already reached a
    // provider keeps its immutable attempt history and is left alone.
    for(const delivery of this.notificationDeliveries){
      if(delivery.organizationId!==organizationId||delivery.alertId!==alertId)continue;
      if(['PENDING','RETRYING','IN_FLIGHT'].includes(delivery.status)&&delivery.attemptCount===0){
        Object.assign(delivery,{status:'CANCELLED',completedAt:acknowledgedAt,nextAttemptAt:acknowledgedAt,leaseOwner:null,leaseExpiresAt:null,updatedAt:acknowledgedAt});
      }
    }
    return { routing: this.#routingRecord(routing), alreadyAcknowledged: false };
  }
  async linkRoutingIncident(organizationId, alertId, incidentId) {
    const routing = this.alertRoutings.find((r) => r.organizationId === organizationId && r.alertId === alertId);
    if (!routing) return undefined;
    routing.incidentId = incidentId; routing.updatedAt = now();
    return this.#routingRecord(routing);
  }

  // ---------------------------------------------------------------------
  // Relay 0.2 — responder teams and membership
  // ---------------------------------------------------------------------
  async createTeam(organizationId, input) {
    if (this.teams.some((t) => t.organizationId === organizationId && t.slug === input.slug)) throw domainError('SLUG_IN_USE', 'Responder team slug is already in use.', 409);
    const at = now();
    const team = { id: uid(), organizationId, name: input.name, slug: input.slug, description: input.description ?? '', createdAt: at, updatedAt: at };
    this.teams.push(team); return clone(team);
  }
  async listTeams(organizationId) {
    return this.teams.filter((t) => t.organizationId === organizationId).sort((a, b) => a.name.localeCompare(b.name)).map((t) => ({
      ...clone(t),
      memberCount: this.teamMembers.filter((m) => m.teamId === t.id).length,
      serviceCount: this.services.filter((s) => s.ownerTeamId === t.id).length
    }));
  }
  async getTeam(organizationId, teamId) {
    const team = this.teams.find((t) => t.organizationId === organizationId && t.id === teamId);
    if (!team) return undefined;
    return {
      ...clone(team),
      members: this.teamMembers.filter((m) => m.teamId === teamId).map((m) => {
        const user = this.users.find((u) => u.id === m.userId);
        const membership = this.memberships.find((x) => x.organizationId === organizationId && x.userId === m.userId);
        return { userId: m.userId, displayName: user?.displayName ?? null, email: user?.email ?? null, role: membership?.role ?? null, joinedAt: m.joinedAt };
      }).sort((a, b) => new Date(a.joinedAt) - new Date(b.joinedAt)),
      services: this.services.filter((s) => s.organizationId === organizationId && s.ownerTeamId === teamId).map((s) => ({ id: s.id, name: s.name, slug: s.slug }))
    };
  }
  async updateTeam(organizationId, teamId, patch) {
    const team = this.teams.find((t) => t.organizationId === organizationId && t.id === teamId);
    if (!team) return undefined;
    if (patch.slug && patch.slug !== team.slug && this.teams.some((t) => t.organizationId === organizationId && t.slug === patch.slug)) throw domainError('SLUG_IN_USE', 'Responder team slug is already in use.', 409);
    Object.assign(team, { name: patch.name ?? team.name, slug: patch.slug ?? team.slug, description: patch.description ?? team.description, updatedAt: now() });
    return clone(team);
  }
  async addTeamMember(organizationId, teamId, userId) {
    const team = this.teams.find((t) => t.organizationId === organizationId && t.id === teamId);
    if (!team) throw domainError('TEAM_NOT_FOUND', 'Responder team not found.', 404);
    // Organization membership is the authority; a user from another
    // organization can never be attached through an identifier trick.
    if (!this.memberships.some((m) => m.organizationId === organizationId && m.userId === userId)) return false;
    if (this.teamMembers.some((m) => m.teamId === teamId && m.userId === userId)) return false;
    this.teamMembers.push({ teamId, organizationId, userId, joinedAt: now() });
    return true;
  }
  async removeTeamMember(organizationId, teamId, userId) {
    const before = this.teamMembers.length;
    this.teamMembers = this.teamMembers.filter((m) => !(m.teamId === teamId && m.userId === userId && m.organizationId === organizationId));
    // Removing a team member also removes them from that team's rotations,
    // matching ON DELETE CASCADE in PostgreSQL.
    const teamIds = new Set(this.teams.filter((t) => t.organizationId === organizationId && t.id === teamId).map((t) => t.id));
    this.scheduleParticipants = this.scheduleParticipants.filter((p) => !(p.userId === userId && teamIds.has(p.teamId)));
    for (const schedule of this.schedules.filter((s) => teamIds.has(s.teamId))) {
      this.scheduleParticipants = this.scheduleParticipants
        .filter((p) => p.scheduleId !== schedule.id)
        .sort((a, b) => a.position - b.position)
        .map((p, index) => ({ ...p, position: index }));
    }
    return this.teamMembers.length < before;
  }

  // ---------------------------------------------------------------------
  // Relay 0.2 — on-call schedules, rotations and overrides
  // ---------------------------------------------------------------------
  #scheduleView(schedule) {
    const team = this.teams.find((t) => t.id === schedule.teamId);
    return {
      ...clone(schedule),
      teamName: team?.name ?? null,
      participants: this.scheduleParticipants.filter((p) => p.scheduleId === schedule.id).sort((a, b) => a.position - b.position)
        .map((p) => ({ ...clone(p), displayName: this.users.find((u) => u.id === p.userId)?.displayName ?? null })),
      overrides: this.overrides.filter((o) => o.scheduleId === schedule.id).sort((a, b) => new Date(b.startsAt) - new Date(a.startsAt))
        .map((o) => ({ ...clone(o), replacementDisplayName: this.users.find((u) => u.id === o.replacementUserId)?.displayName ?? null }))
    };
  }
  async createSchedule(organizationId, input) {
    const team = this.teams.find((t) => t.organizationId === organizationId && t.id === input.teamId);
    if (!team) throw domainError('INVALID_REFERENCE', 'The schedule team must belong to the same organization.', 400);
    const at = now();
    const schedule = {
      id: uid(), organizationId, teamId: team.id, name: input.name, timeZone: input.timeZone,
      enabled: input.enabled !== false, rotationStartsAt: input.rotationStartsAt,
      rotationIntervalMinutes: input.rotationIntervalMinutes, createdAt: at, updatedAt: at
    };
    for (const userId of input.participantUserIds ?? []) {
      if (!this.teamMembers.some((m) => m.teamId === team.id && m.userId === userId)) throw domainError('INVALID_PARTICIPANT', 'Every rotation participant must be a member of the schedule team and organization.', 400);
    }
    this.schedules.push(schedule);
    (input.participantUserIds ?? []).forEach((userId, position) => this.scheduleParticipants.push({ scheduleId: schedule.id, organizationId, teamId: team.id, position, userId, addedAt: at }));
    return this.#scheduleView(schedule);
  }
  async listSchedules(organizationId) {
    return this.schedules.filter((s) => s.organizationId === organizationId).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)).map((s) => this.#scheduleView(s));
  }
  async getSchedule(organizationId, scheduleId) {
    const schedule = this.schedules.find((s) => s.organizationId === organizationId && s.id === scheduleId);
    return schedule ? this.#scheduleView(schedule) : undefined;
  }
  async updateSchedule(organizationId, scheduleId, patch) {
    const schedule = this.schedules.find((s) => s.organizationId === organizationId && s.id === scheduleId);
    if (!schedule) return undefined;
    if (patch.participantUserIds) {
      for (const userId of patch.participantUserIds) {
        if (!this.teamMembers.some((m) => m.teamId === schedule.teamId && m.userId === userId)) throw domainError('INVALID_PARTICIPANT', 'Every rotation participant must be a member of the schedule team and organization.', 400);
      }
      this.scheduleParticipants = this.scheduleParticipants.filter((p) => p.scheduleId !== scheduleId);
      patch.participantUserIds.forEach((userId, position) => this.scheduleParticipants.push({ scheduleId, organizationId, teamId: schedule.teamId, position, userId, addedAt: now() }));
    }
    Object.assign(schedule, {
      name: patch.name ?? schedule.name, timeZone: patch.timeZone ?? schedule.timeZone,
      enabled: patch.enabled === undefined ? schedule.enabled : patch.enabled,
      rotationStartsAt: patch.rotationStartsAt ?? schedule.rotationStartsAt,
      rotationIntervalMinutes: patch.rotationIntervalMinutes ?? schedule.rotationIntervalMinutes, updatedAt: now()
    });
    return this.#scheduleView(schedule);
  }
  async createOverride(organizationId, scheduleId, input, createdByUserId) {
    const schedule = this.schedules.find((s) => s.organizationId === organizationId && s.id === scheduleId);
    if (!schedule) throw domainError('SCHEDULE_NOT_FOUND', 'On-call schedule not found.', 404);
    if (!this.memberships.some((m) => m.organizationId === organizationId && m.userId === input.replacementUserId)) throw domainError('INVALID_REFERENCE', 'The replacement responder must be a member of the organization.', 400);
    const start = new Date(input.startsAt).getTime();
    const end = new Date(input.endsAt).getTime();
    const clash = this.overrides.find((o) => o.scheduleId === scheduleId && new Date(o.startsAt).getTime() < end && start < new Date(o.endsAt).getTime());
    if (clash) throw domainError('OVERRIDE_OVERLAP', 'An override already covers part of this window. Adjust the window or delete the existing override.', 409);
    const at = now();
    const override = {
      id: uid(), organizationId, scheduleId, replacementUserId: input.replacementUserId,
      startsAt: input.startsAt, endsAt: input.endsAt, reason: input.reason ?? '',
      createdByUserId, createdAt: at, updatedAt: at
    };
    this.overrides.push(override);
    return { ...clone(override), scheduleName: schedule.name, replacementDisplayName: this.users.find((u) => u.id === override.replacementUserId)?.displayName ?? null };
  }
  async listOverrides(organizationId, scheduleId) {
    return this.overrides
      .filter((o) => o.organizationId === organizationId && (!scheduleId || o.scheduleId === scheduleId))
      .sort((a, b) => new Date(b.startsAt) - new Date(a.startsAt))
      .map((o) => ({ ...clone(o), replacementDisplayName: this.users.find((u) => u.id === o.replacementUserId)?.displayName ?? null }));
  }
  async getOverride(organizationId, overrideId) {
    const override = this.overrides.find((o) => o.organizationId === organizationId && o.id === overrideId);
    return override ? { ...clone(override), replacementDisplayName: this.users.find((u) => u.id === override.replacementUserId)?.displayName ?? null } : undefined;
  }
  async deleteOverride(organizationId, overrideId) {
    const before = this.overrides.length;
    this.overrides = this.overrides.filter((o) => !(o.organizationId === organizationId && o.id === overrideId));
    return this.overrides.length < before;
  }

  // ---------------------------------------------------------------------
  // Relay 0.2 — alert routing rules
  // ---------------------------------------------------------------------
  #ruleView(rule) {
    return { ...clone(rule), scheduleName: this.schedules.find((s) => s.id === rule.targetScheduleId)?.name ?? null };
  }
  async createRoutingRule(organizationId, input) {
    const schedule = this.schedules.find((s) => s.organizationId === organizationId && s.id === input.targetScheduleId);
    if (!schedule) throw domainError('INVALID_REFERENCE', 'The routing target schedule must belong to the same organization.', 400);
    if (input.matchServiceId && !this.services.some((s) => s.organizationId === organizationId && s.id === input.matchServiceId)) throw domainError('INVALID_REFERENCE', 'The matched service must belong to the same organization.', 400);
    if (input.escalationPolicyId && !this.escalationPolicies.some((p)=>p.organizationId===organizationId&&p.id===input.escalationPolicyId)) throw domainError('INVALID_REFERENCE','The escalation policy must belong to the same organization.',400);
    const at = now();
    const rule = {
      id: uid(), organizationId, name: input.name, enabled: input.enabled !== false, priority: input.priority,
      matchServiceId: input.matchServiceId ?? null, matchSource: input.matchSource ?? null,
      matchSeverities: input.matchSeverities ?? [], targetKind: input.targetKind ?? 'ONCALL_SCHEDULE',
      targetScheduleId: schedule.id, notificationChannels: input.notificationChannels??['DISCORD'], escalationPolicyId: input.escalationPolicyId??null, createdAt: at, updatedAt: at
    };
    this.routingRules.push(rule);
    return this.#ruleView(rule);
  }
  async listRoutingRules(organizationId) {
    return this.routingRules
      .filter((r) => r.organizationId === organizationId)
      .sort((a, b) => a.priority - b.priority || new Date(a.createdAt) - new Date(b.createdAt) || String(a.id).localeCompare(String(b.id)))
      .map((r) => ({ ...this.#ruleView(r), matchServiceName: this.services.find((s) => s.id === r.matchServiceId)?.name ?? null }));
  }
  async getRoutingRule(organizationId, ruleId) {
    const rule = this.routingRules.find((r) => r.organizationId === organizationId && r.id === ruleId);
    return rule ? this.#ruleView(rule) : undefined;
  }
  async updateRoutingRule(organizationId, ruleId, patch) {
    const rule = this.routingRules.find((r) => r.organizationId === organizationId && r.id === ruleId);
    if (!rule) return undefined;
    const targetScheduleId = patch.targetScheduleId ?? rule.targetScheduleId;
    if (!this.schedules.some((s) => s.organizationId === organizationId && s.id === targetScheduleId)) throw domainError('INVALID_REFERENCE', 'The routing target schedule must belong to the same organization.', 400);
    const matchServiceId = 'matchServiceId' in patch ? (patch.matchServiceId ?? null) : rule.matchServiceId;
    if (matchServiceId && !this.services.some((s) => s.organizationId === organizationId && s.id === matchServiceId)) throw domainError('INVALID_REFERENCE', 'The matched service must belong to the same organization.', 400);
    const escalationPolicyId='escalationPolicyId' in patch?(patch.escalationPolicyId??null):rule.escalationPolicyId;
    if(escalationPolicyId&&!this.escalationPolicies.some((p)=>p.organizationId===organizationId&&p.id===escalationPolicyId))throw domainError('INVALID_REFERENCE','The escalation policy must belong to the same organization.',400);
    Object.assign(rule, {
      name: patch.name ?? rule.name, enabled: patch.enabled === undefined ? rule.enabled : patch.enabled,
      priority: patch.priority ?? rule.priority, matchServiceId,
      matchSource: 'matchSource' in patch ? (patch.matchSource ?? null) : rule.matchSource,
      matchSeverities: patch.matchSeverities ?? rule.matchSeverities, targetScheduleId,
      notificationChannels:patch.notificationChannels??rule.notificationChannels??['DISCORD'], escalationPolicyId, updatedAt: now()
    });
    return this.#ruleView(rule);
  }
  async deleteRoutingRule(organizationId, ruleId) {
    const before = this.routingRules.length;
    this.routingRules = this.routingRules.filter((r) => !(r.organizationId === organizationId && r.id === ruleId));
    return this.routingRules.length < before;
  }

  // ---------------------------------------------------------------------
  // Relay 0.2 — organization-scoped escalation policies
  // ---------------------------------------------------------------------
  async listEscalationPolicies(organizationId) {
    return this.escalationPolicies.filter((p)=>p.organizationId===organizationId).map((p)=>({...clone(p),steps:this.escalationPolicySteps.filter((s)=>s.policyId===p.id).sort((a,b)=>a.position-b.position).map(clone)}));
  }
  async getEscalationPolicy(organizationId,policyId) { return (await this.listEscalationPolicies(organizationId)).find((p)=>p.id===policyId); }
  async saveEscalationPolicy(organizationId,input,policyId) {
    const steps=validateEscalationSteps(input.steps??[]);
    for(const step of steps) if(!this.schedules.some((s)=>s.organizationId===organizationId&&s.id===step.targetScheduleId)) throw domainError('INVALID_REFERENCE','Escalation schedules must belong to the same organization.',400);
    let policy=policyId?this.escalationPolicies.find((p)=>p.organizationId===organizationId&&p.id===policyId):undefined;
    if(policyId&&!policy)return undefined;
    if(this.escalationPolicies.some((p)=>p.organizationId===organizationId&&p.name===input.name&&p.id!==policy?.id))throw domainError('CONFLICT','Escalation policy name already exists.',409);
    if(policy)Object.assign(policy,{name:input.name,description:input.description??'',enabled:input.enabled!==false,updatedAt:now()});
    else {policy={id:uid(),organizationId,name:input.name,description:input.description??'',enabled:input.enabled!==false,createdAt:now(),updatedAt:now()};this.escalationPolicies.push(policy);}
    this.escalationPolicySteps=this.escalationPolicySteps.filter((s)=>s.policyId!==policy.id);
    this.escalationPolicySteps.push(...steps.map((step)=>({...clone(step),id:uid(),organizationId,policyId:policy.id,createdAt:now()})));
    return this.getEscalationPolicy(organizationId,policy.id);
  }
  async deleteEscalationPolicy(organizationId,policyId) {
    const count=this.escalationPolicies.length;this.escalationPolicies=this.escalationPolicies.filter((p)=>!(p.organizationId===organizationId&&p.id===policyId));
    if(this.escalationPolicies.length===count)return false;this.escalationPolicySteps=this.escalationPolicySteps.filter((s)=>s.policyId!==policyId);for(const rule of this.routingRules)if(rule.organizationId===organizationId&&rule.escalationPolicyId===policyId)rule.escalationPolicyId=null;return true;
  }
  async materializeEscalationJobs(plan) {
    const inserted=[];for(const item of plan){if(this.escalationJobs.some((j)=>j.routingId===item.routingId&&j.stepPosition===item.stepPosition))continue;const job={id:uid(),...clone(item),createdAt:now(),updatedAt:now()};this.escalationJobs.push(job);inserted.push(clone(job));}return inserted;
  }
  async listEscalationJobs(organizationId,alertId) {return this.escalationJobs.filter((j)=>j.organizationId===organizationId&&j.alertId===alertId).sort((a,b)=>a.stepPosition-b.stepPosition).map(clone);}

  // ---------------------------------------------------------------------
  // Relay 0.2 — optional Discord responder mapping
  // ---------------------------------------------------------------------
  async upsertDiscordIdentity(organizationId, userId, discordUserId) {
    if (!this.memberships.some((m) => m.organizationId === organizationId && m.userId === userId)) throw domainError('INVALID_REFERENCE', 'The mapped user must be a member of the organization.', 400);
    let identity = this.discordIdentities.find((d) => d.organizationId === organizationId && d.userId === userId);
    if (identity) Object.assign(identity, { discordUserId, updatedAt: now() });
    else { identity = { id: uid(), organizationId, userId, discordUserId, createdAt: now(), updatedAt: now() }; this.discordIdentities.push(identity); }
    return clone(identity);
  }
  async getDiscordIdentity(organizationId, userId) { return clone(this.discordIdentities.find((d) => d.organizationId === organizationId && d.userId === userId)); }
  async listDiscordIdentities(organizationId) {
    return this.discordIdentities.filter((d) => d.organizationId === organizationId)
      .map((d) => ({ ...clone(d), displayName: this.users.find((u) => u.id === d.userId)?.displayName ?? null }))
      .sort((a, b) => String(a.displayName ?? '').localeCompare(String(b.displayName ?? '')));
  }
  async deleteDiscordIdentity(organizationId, userId) {
    const before = this.discordIdentities.length;
    this.discordIdentities = this.discordIdentities.filter((d) => !(d.organizationId === organizationId && d.userId === userId));
    return this.discordIdentities.length < before;
  }

  async upsertIntegration(organizationId, { provider, name, secretEncrypted, config, enabled }) {
    let integration = this.integrations.find((x)=>x.organizationId===organizationId && x.provider===provider);
    if (integration) Object.assign(integration, {name,secretEncrypted,config:config??integration.config??{},enabled,updatedAt:now()});
    else { integration={id:uid(),organizationId,provider,name,secretEncrypted,config:config??{},enabled,createdAt:now(),updatedAt:now()}; this.integrations.push(integration); }
    return clone(integration);
  }
  async getIntegration(organizationId, provider) { return clone(this.integrations.find((x)=>x.organizationId===organizationId && x.provider===provider)); }
  async listIntegrations(organizationId) { return this.integrations.filter((x)=>x.organizationId===organizationId).map(({secretEncrypted,...rest})=>clone(rest)); }
  async deleteIntegration(organizationId, provider) {
    const before=this.integrations.length;
    this.integrations=this.integrations.filter((x)=>!(x.organizationId===organizationId&&x.provider===provider));
    return this.integrations.length<before;
  }

  // ---------------------------------------------------------------------
  // Relay 0.2 — durable notification deliveries and immutable attempts.
  //
  // The in-process store mirrors the PostgreSQL contract exactly: deliveries
  // are claimed by lease token, an attempt is written for every provider call,
  // and no update may overwrite history written by another lease.
  // ---------------------------------------------------------------------
  #deliveryView(delivery) { return clone(delivery); }
  async enqueueDeliveries(records) {
    const inserted=[];
    for(const record of records){
      const duplicate=this.notificationDeliveries.find((d)=>d.organizationId===record.organizationId&&d.routingId===record.routingId
        &&(record.escalationJobId?d.escalationJobId===record.escalationJobId:d.escalationJobId===null)
        &&d.provider===record.provider);
      if(duplicate)continue;
      const at=now();
      const delivery={
        id:record.id??uid(),organizationId:record.organizationId,alertId:record.alertId,routingId:record.routingId,
        escalationJobId:record.escalationJobId??null,provider:record.provider,
        destinationSnapshot:record.destinationSnapshot??{},responderUserId:record.responderUserId??null,
        responderNameSnapshot:record.responderNameSnapshot??null,status:record.status??'PENDING',
        scheduledAt:record.scheduledAt??at,attemptCount:record.attemptCount??0,nextAttemptAt:record.nextAttemptAt??record.scheduledAt??at,
        leaseOwner:null,leaseExpiresAt:null,lastAttemptAt:null,completedAt:null,lastError:null,
        manualRetryByUserId:null,createdAt:at,updatedAt:at
      };
      this.notificationDeliveries.push(delivery);
      inserted.push(clone(delivery));
    }
    return inserted;
  }
  async listAlertDeliveries(organizationId, alertId) {
    return this.notificationDeliveries.filter((d)=>d.organizationId===organizationId&&d.alertId===alertId)
      .sort((a,b)=>new Date(a.createdAt)-new Date(b.createdAt)||String(a.id).localeCompare(String(b.id))).map((d)=>this.#deliveryView(d));
  }
  async listDeliveries(organizationId, { limit = 200 } = {}) {
    const size=Math.max(1,Math.min(500,Number(limit)||200));
    return this.notificationDeliveries.filter((d)=>d.organizationId===organizationId)
      .sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)).slice(0,size).map((d)=>this.#deliveryView(d));
  }
  async getDelivery(organizationId, deliveryId) { return this.#deliveryView(this.notificationDeliveries.find((d)=>d.organizationId===organizationId&&d.id===deliveryId)); }
  async listDeliveryAttempts(organizationId, deliveryId) {
    return this.notificationAttempts.filter((a)=>a.organizationId===organizationId&&a.deliveryId===deliveryId)
      .sort((a,b)=>a.attemptNumber-b.attemptNumber).map(clone);
  }
  /** Deliveries that are due now, or whose lease expired, ordered deterministically. */
  #dueDeliveries(at, { alertId = null } = {}) {
    const instant=new Date(at).getTime();
    return this.notificationDeliveries
      .filter((d)=>(!alertId||d.alertId===alertId))
      .filter((d)=>(['PENDING','RETRYING'].includes(d.status)&&new Date(d.nextAttemptAt).getTime()<=instant)
        ||(d.status==='IN_FLIGHT'&&new Date(d.leaseExpiresAt??0).getTime()<instant))
      .sort((a,b)=>new Date(a.nextAttemptAt)-new Date(b.nextAttemptAt)||String(a.id).localeCompare(String(b.id)));
  }
  async listDueDeliveries(organizationId, { now: at = now(), limit = 200, alertId = null } = {}) {
    return this.#dueDeliveries(at,{alertId}).filter((d)=>d.organizationId===organizationId).slice(0,limit).map((d)=>this.#deliveryView(d));
  }
  async claimDueDeliveries({ now: at = now(), leaseOwner, leaseSeconds = 120, limit = 20, alertId = null }) {
    const claimed=[];
    for(const delivery of this.#dueDeliveries(at,{alertId})){
      if(claimed.length>=limit)break;
      delivery.status='IN_FLIGHT';
      delivery.leaseOwner=leaseOwner;
      delivery.leaseExpiresAt=new Date(new Date(at).getTime()+leaseSeconds*1000).toISOString();
      delivery.updatedAt=now();
      claimed.push(clone(delivery));
    }
    return claimed;
  }
  async recoverExpiredDeliveryLeases(at = now(), { limit = 100 } = {}) {
    const instant=new Date(at).getTime();let recovered=0;
    for(const delivery of this.notificationDeliveries){
      if(recovered>=limit)break;
      if(delivery.status!=='IN_FLIGHT'||new Date(delivery.leaseExpiresAt??0).getTime()>=instant)continue;
      delivery.status=delivery.attemptCount>0?'RETRYING':'PENDING';
      delivery.nextAttemptAt=new Date(at).toISOString();
      delivery.leaseOwner=null;delivery.leaseExpiresAt=null;delivery.updatedAt=now();
      recovered+=1;
    }
    return recovered;
  }
  /**
   * Persist one attempt and move the logical delivery forward. `skipAttempt`
   * records a configuration gap (no provider call was made) without inventing
   * an attempt row. A stale lease cannot write here at all.
   */
  async completeDelivery({ deliveryId, organizationId, leaseOwner, attemptNumber, startedAt, completedAt, outcome, status, nextAttemptAt = null, safeError = null, providerStatusCode = null, manualRetryByUserId = null, skipAttempt = false }) {
    const delivery=this.notificationDeliveries.find((d)=>d.organizationId===organizationId&&d.id===deliveryId);
    if(!delivery)return undefined;
    if(delivery.leaseOwner!==leaseOwner)return {staleLease:true,delivery:this.#deliveryView(delivery)};
    let attempt;
    if(!skipAttempt){
      attempt={id:uid(),organizationId,deliveryId,attemptNumber,startedAt,completedAt,outcome,providerStatusCode,safeError,
        manualRetryByUserId:manualRetryByUserId??null,manual:Boolean(manualRetryByUserId),createdAt:now()};
      this.notificationAttempts.push(attempt);
    }
    Object.assign(delivery,{
      status,attemptCount:skipAttempt?delivery.attemptCount:attemptNumber,
      lastAttemptAt:skipAttempt?delivery.lastAttemptAt:completedAt,
      nextAttemptAt:nextAttemptAt??new Date(completedAt).toISOString(),
      completedAt:['SENT','FAILED','CANCELLED'].includes(status)?(completedAt??now()):null,
      lastError:safeError?String(safeError).slice(0,900):(['SENT'].includes(status)?null:delivery.lastError),
      leaseOwner:null,leaseExpiresAt:null,manualRetryByUserId:null,updatedAt:now()
    });
    return {staleLease:false,delivery:this.#deliveryView(delivery),attempt:attempt?clone(attempt):undefined};
  }
  async scheduleManualRetry({ organizationId, deliveryId, userId, now: at = now() }) {
    const delivery=this.notificationDeliveries.find((d)=>d.organizationId===organizationId&&d.id===deliveryId);
    if(!delivery)return undefined;
    // Attempts are never erased. The manual retry schedules another attempt and
    // records who asked for it; the original FAILED history stays readable.
    delivery.status='RETRYING';
    delivery.nextAttemptAt=new Date(at).toISOString();
    delivery.manualRetryByUserId=userId;
    delivery.leaseOwner=null;delivery.leaseExpiresAt=null;
    delivery.completedAt=null;
    delivery.updatedAt=now();
    return this.#deliveryView(delivery);
  }
  async claimDueEscalationJobs({ now: at = now(), leaseOwner, leaseSeconds = 120, limit = 20 }) {
    const instant=new Date(at).getTime();const claimed=[];
    for(const job of this.escalationJobs){
      if(claimed.length>=limit)break;
      const due=(job.state==='PENDING'&&new Date(job.dueAt).getTime()<=instant)
        ||(job.state==='IN_FLIGHT'&&new Date(job.leaseExpiresAt??0).getTime()<instant);
      if(!due)continue;
      job.state='IN_FLIGHT';job.leaseOwner=leaseOwner;job.claimedAt=new Date(at).toISOString();
      job.leaseExpiresAt=new Date(instant+leaseSeconds*1000).toISOString();job.updatedAt=now();
      claimed.push(clone(job));
    }
    return claimed;
  }
  async recoverExpiredEscalationLeases(at = now(), { limit = 100 } = {}) {
    const instant=new Date(at).getTime();let recovered=0;
    for(const job of this.escalationJobs){
      if(recovered>=limit)break;
      if(job.state!=='IN_FLIGHT'||new Date(job.leaseExpiresAt??0).getTime()>=instant)continue;
      job.state='PENDING';job.leaseOwner=null;job.leaseExpiresAt=null;job.updatedAt=now();
      recovered+=1;
    }
    return recovered;
  }
  async completeEscalationJob({ organizationId, jobId, leaseOwner, state, responderUserId = null, responderNameSnapshot = null, result = {}, deliveries = [] }) {
    const job=this.escalationJobs.find((j)=>j.organizationId===organizationId&&j.id===jobId);
    if(!job)return undefined;
    if(job.leaseOwner!==leaseOwner)return {staleLease:true,job:clone(job)};
    const at=now();
    if(deliveries.length)await this.enqueueDeliveries(deliveries);
    Object.assign(job,{
      state,resolvedResponderUserId:responderUserId,resolvedResponderNameSnapshot:responderNameSnapshot,
      result:{...clone(result),deliveryCount:deliveries.length},executedAt:state==='COMPLETED'?at:(job.executedAt??null),
      leaseOwner:null,leaseExpiresAt:null,updatedAt:at
    });
    return {staleLease:false,job:clone(job)};
  }
}
