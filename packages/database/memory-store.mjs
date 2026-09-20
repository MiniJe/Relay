import crypto from 'node:crypto';
import { domainError } from '../shared/domain.mjs';

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
    const service = { id: uid(), organizationId, ...input, createdAt: at, updatedAt: at };
    this.services.push(service); return clone(service);
  }
  async listServices(organizationId) { return clone(this.services.filter((s) => s.organizationId === organizationId)); }
  async getService(organizationId, serviceId) { return clone(this.services.find((s) => s.organizationId === organizationId && s.id === serviceId)); }
  async updateService(organizationId, serviceId, patch) {
    const service = this.services.find((s) => s.organizationId === organizationId && s.id === serviceId);
    if (!service) return undefined;
    Object.assign(service, patch, { updatedAt: now() }); return clone(service);
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

  async createAlert(organizationId, input) {
    if (input.externalId && this.alerts.some((a)=>a.organizationId===organizationId && a.source===input.source && a.externalId===input.externalId)) {
      return clone(this.alerts.find((a)=>a.organizationId===organizationId && a.source===input.source && a.externalId===input.externalId));
    }
    const alert = { id:uid(), organizationId, ...input, receivedAt:now() };
    this.alerts.push(alert); return clone(alert);
  }
  async listAlerts(organizationId) { return clone(this.alerts.filter((a)=>a.organizationId===organizationId).sort((a,b)=>new Date(b.receivedAt)-new Date(a.receivedAt))); }

  async upsertIntegration(organizationId, { provider, name, secretEncrypted, enabled }) {
    let integration = this.integrations.find((x)=>x.organizationId===organizationId && x.provider===provider);
    if (integration) Object.assign(integration, {name,secretEncrypted,enabled,updatedAt:now()});
    else { integration={id:uid(),organizationId,provider,name,secretEncrypted,enabled,createdAt:now(),updatedAt:now()}; this.integrations.push(integration); }
    return clone(integration);
  }
  async getIntegration(organizationId, provider) { return clone(this.integrations.find((x)=>x.organizationId===organizationId && x.provider===provider)); }
  async listIntegrations(organizationId) { return this.integrations.filter((x)=>x.organizationId===organizationId).map(({secretEncrypted,...rest})=>clone(rest)); }
}
