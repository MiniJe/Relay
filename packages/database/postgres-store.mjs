import crypto from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { domainError } from '../shared/domain.mjs';
import { validateEscalationSteps } from '../shared/escalation.mjs';
import { isMigrationFileName, sortMigrationNames, splitSqlStatements, stripTransactionWrapper } from './sql.mjs';

const MIGRATIONS_URL = new URL('./migrations/', import.meta.url);

/** All forward migrations shipped with this release, in application order. */
export async function listMigrationFiles() {
  const entries = await readdir(MIGRATIONS_URL);
  return sortMigrationNames(entries.filter(isMigrationFileName));
}

const uid = () => crypto.randomUUID();

function camelKey(key) { return key.replace(/_([a-z])/g, (_, c) => c.toUpperCase()); }
function camel(row) {
  if (!row) return undefined;
  const out = {};
  for (const [key, value] of Object.entries(row)) out[camelKey(key)] = value instanceof Date ? value.toISOString() : value;
  return out;
}
function map(rows) { return rows.map(camel); }
function normalizeDbError(error) {
  if (error?.code === '23505') return domainError('CONFLICT', 'A record with the same unique identifier already exists.', 409);
  if (error?.code === '23503') return domainError('INVALID_REFERENCE', 'A referenced record does not exist or is outside the organization.', 400);
  return error;
}

export async function createPostgresStore(databaseUrl) {
  if (!databaseUrl) throw new Error('DATABASE_URL is required.');
  const { default: postgres } = await import('postgres');
  const sql = postgres(databaseUrl, { max: 10, idle_timeout: 20, connect_timeout: 10, prepare: true });
  return new PostgresStore(sql);
}

/**
 * Apply every shipped forward migration that has not yet been recorded.
 *
 * Each migration runs in its own transaction together with its
 * `schema_migrations` record, so a failure leaves the database at the last
 * fully-applied migration instead of half-migrated. Migrations are ordered by
 * filename; nothing is hardcoded to a single release.
 */
export async function migratePostgres(databaseUrl) {
  const { default: postgres } = await import('postgres');
  const sql = postgres(databaseUrl, { max: 1, connect_timeout: 10 });
  try {
    await sql.unsafe(`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const available = await listMigrationFiles();
    const appliedAlready = new Set((await sql.unsafe('SELECT name FROM schema_migrations')).map((row) => row.name));
    const applied = [];
    for (const name of available) {
      if (appliedAlready.has(name)) continue;
      const contents = await readFile(new URL(name, MIGRATIONS_URL), 'utf8');
      const statements = stripTransactionWrapper(splitSqlStatements(contents));
      await sql.begin(async (tx) => {
        for (const statement of statements) await tx.unsafe(statement);
        await tx.unsafe('INSERT INTO schema_migrations(name) VALUES ($1)', [name]);
      });
      applied.push(name);
    }
    const unknown = [...appliedAlready].filter((name) => !available.includes(name));
    return { applied, available, unknown };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export class PostgresStore {
  constructor(sql) { this.sql = sql; }
  async close() { await this.sql.end({ timeout: 5 }); }
  async #one(text, params = [], sql = this.sql) { return camel((await sql.unsafe(text, params))[0]); }
  async #many(text, params = [], sql = this.sql) { return map(await sql.unsafe(text, params)); }

  async createUser({ email, displayName, passwordHash }) {
    try { return await this.#one(`INSERT INTO users(id,email,display_name,password_hash) VALUES($1,$2,$3,$4) RETURNING *`, [uid(), email, displayName, passwordHash]); }
    catch (error) { throw normalizeDbError(error); }
  }
  async getUserByEmail(email) { return this.#one(`SELECT * FROM users WHERE email=$1`, [email]); }
  async getUserById(id) { return this.#one(`SELECT * FROM users WHERE id=$1`, [id]); }

  async createSession({ userId, tokenHash, expiresAt }) {
    return this.#one(`INSERT INTO sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,$4) RETURNING *`, [uid(), userId, tokenHash, expiresAt]);
  }
  async getSession(tokenHash) {
    const rows = await this.sql.unsafe(`SELECT s.*, u.email, u.display_name, u.created_at AS user_created_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now()`, [tokenHash]);
    if (!rows[0]) return undefined;
    const r = rows[0];
    return {
      id:r.id,userId:r.user_id,tokenHash:r.token_hash,expiresAt:r.expires_at.toISOString(),createdAt:r.created_at.toISOString(),
      user:{id:r.user_id,email:r.email,displayName:r.display_name,createdAt:r.user_created_at.toISOString()}
    };
  }
  async deleteSession(tokenHash) { await this.sql.unsafe(`DELETE FROM sessions WHERE token_hash=$1`, [tokenHash]); }

  async createOrganization({ userId, name, slug }) {
    try {
      return await this.sql.begin(async (tx) => {
        const org = await this.#one(`INSERT INTO organizations(id,name,slug) VALUES($1,$2,$3) RETURNING *`, [uid(),name,slug],tx);
        await tx.unsafe(`INSERT INTO organization_memberships(organization_id,user_id,role) VALUES($1,$2,'OWNER')`, [org.id,userId]);
        return org;
      });
    } catch (error) { throw normalizeDbError(error); }
  }
  async listOrganizationsForUser(userId) {
    return this.#many(`SELECT o.*, m.role FROM organizations o JOIN organization_memberships m ON m.organization_id=o.id WHERE m.user_id=$1 ORDER BY o.created_at`,[userId]);
  }
  async getOrganization(id) { return this.#one(`SELECT * FROM organizations WHERE id=$1`,[id]); }
  async getOrganizationBySlug(slug) { return this.#one(`SELECT * FROM organizations WHERE slug=$1`,[slug]); }
  async getMembership(organizationId,userId) { return this.#one(`SELECT * FROM organization_memberships WHERE organization_id=$1 AND user_id=$2`,[organizationId,userId]); }
  async listMemberships(organizationId) {
    const rows=await this.sql.unsafe(`SELECT m.*,u.email,u.display_name,u.created_at AS user_created_at FROM organization_memberships m JOIN users u ON u.id=m.user_id WHERE m.organization_id=$1 ORDER BY m.created_at`,[organizationId]);
    return rows.map((r)=>({organizationId:r.organization_id,userId:r.user_id,role:r.role,createdAt:r.created_at.toISOString(),user:{id:r.user_id,email:r.email,displayName:r.display_name,createdAt:r.user_created_at.toISOString()}}));
  }

  async createService(organizationId,input) {
    try { return await this.#one(`INSERT INTO services(id,organization_id,name,slug,description,operational_state) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[uid(),organizationId,input.name,input.slug,input.description,input.operationalState]); }
    catch(error){throw normalizeDbError(error)}
  }
  async listServices(organizationId){return this.#many(`SELECT s.*, t.name AS owner_team_name FROM services s LEFT JOIN responder_teams t ON t.id=s.owner_team_id AND t.organization_id=s.organization_id WHERE s.organization_id=$1 ORDER BY s.name`,[organizationId]);}
  async getService(organizationId,serviceId){return this.#one(`SELECT * FROM services WHERE organization_id=$1 AND id=$2`,[organizationId,serviceId]);}
  async updateService(organizationId,serviceId,patch){
    const current=await this.getService(organizationId,serviceId); if(!current)return undefined;
    const ownerTeamId='ownerTeamId' in patch?(patch.ownerTeamId??null):(current.ownerTeamId??null);
    if(ownerTeamId){
      const team=await this.#one(`SELECT id FROM responder_teams WHERE organization_id=$1 AND id=$2`,[organizationId,ownerTeamId]);
      if(!team)throw domainError('INVALID_REFERENCE','The owning responder team must belong to the same organization.',400);
    }
    try{
      const updated=await this.#one(`UPDATE services SET name=$3,slug=$4,description=$5,operational_state=$6,owner_team_id=$7,updated_at=now() WHERE organization_id=$1 AND id=$2 RETURNING *`,[organizationId,serviceId,patch.name??current.name,patch.slug??current.slug,patch.description??current.description,patch.operationalState??current.operationalState,ownerTeamId]);
      const teamName=updated.ownerTeamId?await this.#one(`SELECT name FROM responder_teams WHERE organization_id=$1 AND id=$2`,[organizationId,updated.ownerTeamId]):undefined;
      return {...updated,ownerTeamName:teamName?.name??null};
    }catch(error){throw normalizeDbError(error)}
  }

  async createComponent(organizationId,input){
    try{return await this.sql.begin(async(tx)=>{
      const component=await this.#one(`INSERT INTO components(id,organization_id,name,slug,description,operational_state) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[uid(),organizationId,input.name,input.slug,input.description,input.operationalState],tx);
      for(const serviceId of input.serviceIds??[]) await tx.unsafe(`INSERT INTO component_services(component_id,service_id) SELECT $1,s.id FROM services s WHERE s.id=$2 AND s.organization_id=$3`,[component.id,serviceId,organizationId]);
      return {...component,serviceIds:input.serviceIds??[]};
    })}catch(error){throw normalizeDbError(error)}
  }
  async listComponents(organizationId){
    const components=await this.#many(`SELECT * FROM components WHERE organization_id=$1 ORDER BY name`,[organizationId]);
    const links=await this.#many(`SELECT cs.* FROM component_services cs JOIN components c ON c.id=cs.component_id WHERE c.organization_id=$1`,[organizationId]);
    return components.map((c)=>({...c,serviceIds:links.filter((x)=>x.componentId===c.id).map((x)=>x.serviceId)}));
  }
  async getComponent(organizationId,componentId){const all=await this.listComponents(organizationId);return all.find((c)=>c.id===componentId);}
  async updateComponent(organizationId,componentId,patch){
    const current=await this.getComponent(organizationId,componentId);if(!current)return undefined;
    return this.sql.begin(async(tx)=>{
      const component=await this.#one(`UPDATE components SET name=$3,slug=$4,description=$5,operational_state=$6,updated_at=now() WHERE organization_id=$1 AND id=$2 RETURNING *`,[organizationId,componentId,patch.name??current.name,patch.slug??current.slug,patch.description??current.description,patch.operationalState??current.operationalState],tx);
      const serviceIds=patch.serviceIds??current.serviceIds;
      if(patch.serviceIds){await tx.unsafe(`DELETE FROM component_services WHERE component_id=$1`,[componentId]);for(const serviceId of serviceIds)await tx.unsafe(`INSERT INTO component_services(component_id,service_id) SELECT $1,s.id FROM services s WHERE s.id=$2 AND s.organization_id=$3`,[componentId,serviceId,organizationId]);}
      return {...component,serviceIds};
    });
  }

  async createStatusPage(organizationId,input){
    try{return await this.sql.begin(async(tx)=>{
      const page=await this.#one(`INSERT INTO status_pages(id,organization_id,name,slug,is_public,branding) VALUES($1,$2,$3,$4,$5,$6::text::jsonb) RETURNING *`,[uid(),organizationId,input.name,input.slug,input.isPublic,JSON.stringify(input.branding)],tx);
      for(let i=0;i<input.componentIds.length;i++) await tx.unsafe(`INSERT INTO status_page_components(status_page_id,component_id,sort_order) SELECT $1,c.id,$3 FROM components c WHERE c.id=$2 AND c.organization_id=$4`,[page.id,input.componentIds[i],i,organizationId]);
      return {...page,componentIds:input.componentIds};
    })}catch(error){throw normalizeDbError(error)}
  }
  async listStatusPages(organizationId){
    const pages=await this.#many(`SELECT * FROM status_pages WHERE organization_id=$1 ORDER BY created_at`,[organizationId]);
    const links=await this.#many(`SELECT spc.* FROM status_page_components spc JOIN status_pages sp ON sp.id=spc.status_page_id WHERE sp.organization_id=$1 ORDER BY spc.sort_order`,[organizationId]);
    return pages.map((p)=>({...p,componentIds:links.filter((x)=>x.statusPageId===p.id).map((x)=>x.componentId)}));
  }

  async #incidentView(organizationId,incidentId,sql=this.sql){
    const incident=await this.#one(`SELECT * FROM incidents WHERE organization_id=$1 AND id=$2`,[organizationId,incidentId],sql);if(!incident)return undefined;
    const [serviceLinks,componentLinks,responderRows,timelineRows,updateRows,postmortemRows]=await Promise.all([
      sql.unsafe(`SELECT service_id FROM incident_services WHERE incident_id=$1`,[incidentId]),
      sql.unsafe(`SELECT component_id FROM incident_components WHERE incident_id=$1`,[incidentId]),
      sql.unsafe(`SELECT r.*,u.email,u.display_name,u.created_at AS user_created_at FROM incident_responders r JOIN users u ON u.id=r.user_id WHERE r.incident_id=$1 ORDER BY r.joined_at`,[incidentId]),
      sql.unsafe(`SELECT e.*,u.email,u.display_name FROM incident_timeline_events e LEFT JOIN users u ON u.id=e.actor_user_id WHERE e.incident_id=$1 ORDER BY e.occurred_at`,[incidentId]),
      sql.unsafe(`SELECT x.*,u.email,u.display_name FROM incident_updates x JOIN users u ON u.id=x.actor_user_id WHERE x.incident_id=$1 ORDER BY x.created_at`,[incidentId]),
      sql.unsafe(`SELECT * FROM postmortems WHERE incident_id=$1`,[incidentId])
    ]);
    return {
      ...incident,
      affectedServiceIds:serviceLinks.map((r)=>r.service_id),affectedComponentIds:componentLinks.map((r)=>r.component_id),
      responders:responderRows.map((r)=>({incidentId:r.incident_id,userId:r.user_id,joinedAt:r.joined_at.toISOString(),user:{id:r.user_id,email:r.email,displayName:r.display_name,createdAt:r.user_created_at.toISOString()}})),
      timeline:timelineRows.map((r)=>({id:r.id,incidentId:r.incident_id,actorUserId:r.actor_user_id,eventType:r.event_type,message:r.message,metadata:r.metadata,occurredAt:r.occurred_at.toISOString(),actor:r.actor_user_id?{id:r.actor_user_id,email:r.email,displayName:r.display_name}:undefined})),
      updates:updateRows.map((r)=>({id:r.id,incidentId:r.incident_id,actorUserId:r.actor_user_id,message:r.message,isPublic:r.is_public,createdAt:r.created_at.toISOString(),actor:{id:r.actor_user_id,email:r.email,displayName:r.display_name}})),
      postmortem:camel(postmortemRows[0])
    };
  }
  async createIncident(organizationId,record,affectedServiceIds,affectedComponentIds,event){
    try{return await this.sql.begin(async(tx)=>{
      const incidentId=uid();
      await tx.unsafe(`INSERT INTO incidents(id,organization_id,title,summary,severity,status,creator_user_id,commander_user_id) VALUES($1,$2,$3,$4,$5,'INVESTIGATING',$6,$7)`,[incidentId,organizationId,record.title,record.summary,record.severity,record.creatorUserId,record.commanderUserId??null]);
      for(const serviceId of affectedServiceIds) await tx.unsafe(`INSERT INTO incident_services(incident_id,service_id) SELECT $1,s.id FROM services s WHERE s.id=$2 AND s.organization_id=$3`,[incidentId,serviceId,organizationId]);
      for(const componentId of affectedComponentIds) await tx.unsafe(`INSERT INTO incident_components(incident_id,component_id) SELECT $1,c.id FROM components c WHERE c.id=$2 AND c.organization_id=$3`,[incidentId,componentId,organizationId]);
      await tx.unsafe(`INSERT INTO incident_responders(incident_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING`,[incidentId,record.creatorUserId]);
      await tx.unsafe(`INSERT INTO incident_timeline_events(id,incident_id,actor_user_id,event_type,message,metadata) VALUES($1,$2,$3,$4,$5,$6::text::jsonb)`,[uid(),incidentId,event.actorUserId,event.eventType,event.message??null,JSON.stringify(event.metadata??{})]);
      return this.#incidentView(organizationId,incidentId,tx);
    })}catch(error){throw normalizeDbError(error)}
  }
  async listIncidents(organizationId){const rows=await this.sql.unsafe(`SELECT id FROM incidents WHERE organization_id=$1 ORDER BY started_at DESC`,[organizationId]);return Promise.all(rows.map((r)=>this.#incidentView(organizationId,r.id)));}
  async getIncident(organizationId,incidentId){return this.#incidentView(organizationId,incidentId);}
  async updateIncident(organizationId,incidentId,patch,{affectedServiceIds,affectedComponentIds,events=[]}={}){
    const current=await this.getIncident(organizationId,incidentId);if(!current)return undefined;
    return this.sql.begin(async(tx)=>{
      await tx.unsafe(`UPDATE incidents SET summary=$3,severity=$4,status=$5,commander_user_id=$6,resolved_at=CASE WHEN $5='RESOLVED' THEN COALESCE(resolved_at,now()) ELSE resolved_at END,updated_at=now() WHERE organization_id=$1 AND id=$2`,[organizationId,incidentId,patch.summary??current.summary,patch.severity??current.severity,patch.status??current.status,patch.commanderUserId===undefined?current.commanderUserId:patch.commanderUserId]);
      if(affectedServiceIds){await tx.unsafe(`DELETE FROM incident_services WHERE incident_id=$1`,[incidentId]);for(const serviceId of affectedServiceIds)await tx.unsafe(`INSERT INTO incident_services(incident_id,service_id) SELECT $1,s.id FROM services s WHERE s.id=$2 AND s.organization_id=$3`,[incidentId,serviceId,organizationId]);}
      if(affectedComponentIds){await tx.unsafe(`DELETE FROM incident_components WHERE incident_id=$1`,[incidentId]);for(const componentId of affectedComponentIds)await tx.unsafe(`INSERT INTO incident_components(incident_id,component_id) SELECT $1,c.id FROM components c WHERE c.id=$2 AND c.organization_id=$3`,[incidentId,componentId,organizationId]);}
      for(const event of events) await tx.unsafe(`INSERT INTO incident_timeline_events(id,incident_id,actor_user_id,event_type,message,metadata) VALUES($1,$2,$3,$4,$5,$6::text::jsonb)`,[uid(),incidentId,event.actorUserId,event.eventType,event.message??null,JSON.stringify(event.metadata??{})]);
      return this.#incidentView(organizationId,incidentId,tx);
    });
  }
  async addIncidentUpdate(organizationId,incidentId,{actorUserId,message,isPublic},event){
    const existing=await this.#one(`SELECT id FROM incidents WHERE organization_id=$1 AND id=$2`,[organizationId,incidentId]);if(!existing)return undefined;
    return this.sql.begin(async(tx)=>{
      const update=await this.#one(`INSERT INTO incident_updates(id,incident_id,actor_user_id,message,is_public) VALUES($1,$2,$3,$4,$5) RETURNING *`,[uid(),incidentId,actorUserId,message,isPublic],tx);
      await tx.unsafe(`INSERT INTO incident_timeline_events(id,incident_id,actor_user_id,event_type,message,metadata) VALUES($1,$2,$3,$4,$5,$6::text::jsonb)`,[uid(),incidentId,event.actorUserId,event.eventType,event.message??null,JSON.stringify(event.metadata??{})]);
      await tx.unsafe(`UPDATE incidents SET updated_at=now() WHERE id=$1`,[incidentId]);
      return {update,incident:await this.#incidentView(organizationId,incidentId,tx)};
    });
  }
  async addResponder(organizationId,incidentId,userId,actorUserId){
    const existing=await this.#one(`SELECT id FROM incidents WHERE organization_id=$1 AND id=$2`,[organizationId,incidentId]);if(!existing)return undefined;
    return this.sql.begin(async(tx)=>{
      const inserted=await tx.unsafe(`INSERT INTO incident_responders(incident_id,user_id) SELECT $1,m.user_id FROM organization_memberships m WHERE m.organization_id=$2 AND m.user_id=$3 ON CONFLICT DO NOTHING RETURNING user_id`,[incidentId,organizationId,userId]);
      if(inserted.length) await tx.unsafe(`INSERT INTO incident_timeline_events(id,incident_id,actor_user_id,event_type,message,metadata) VALUES($1,$2,$3,'RESPONDER_JOINED','Responder joined the incident.',$4::text::jsonb)`,[uid(),incidentId,actorUserId,JSON.stringify({userId})]);
      return this.#incidentView(organizationId,incidentId,tx);
    });
  }
  async upsertPostmortem(organizationId,incidentId,input,userId){
    const incident=await this.#one(`SELECT id FROM incidents WHERE organization_id=$1 AND id=$2`,[organizationId,incidentId]);if(!incident)return undefined;
    return this.sql.begin(async(tx)=>{
      const existing=await this.#one(`SELECT id FROM postmortems WHERE incident_id=$1`,[incidentId],tx);
      if(existing) await tx.unsafe(`UPDATE postmortems SET title=$2,summary=$3,impact=$4,root_cause=$5,resolution=$6,follow_up_actions=$7::text::jsonb,updated_at=now() WHERE incident_id=$1`,[incidentId,input.title,input.summary,input.impact,input.rootCause,input.resolution,JSON.stringify(input.followUpActions)]);
      else await tx.unsafe(`INSERT INTO postmortems(id,incident_id,title,summary,impact,root_cause,resolution,follow_up_actions,created_by_user_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8::text::jsonb,$9)`,[uid(),incidentId,input.title,input.summary,input.impact,input.rootCause,input.resolution,JSON.stringify(input.followUpActions),userId]);
      await tx.unsafe(`INSERT INTO incident_timeline_events(id,incident_id,actor_user_id,event_type,message,metadata) VALUES($1,$2,$3,$4,$5,'{}'::jsonb)`,[uid(),incidentId,userId,existing?'POSTMORTEM_UPDATED':'POSTMORTEM_CREATED',existing?'Postmortem updated.':'Postmortem created.']);
      return this.#incidentView(organizationId,incidentId,tx);
    });
  }

  async getPublicStatusPage(slug){
    const page=await this.#one(`SELECT * FROM status_pages WHERE slug=$1 AND is_public=true`,[slug]);if(!page)return undefined;
    const components=await this.#many(`SELECT c.* FROM components c JOIN status_page_components spc ON spc.component_id=c.id WHERE spc.status_page_id=$1 ORDER BY spc.sort_order`,[page.id]);
    const componentIds=components.map((c)=>c.id);if(!componentIds.length)return{page,components,incidents:[]};
    const rows=await this.sql.unsafe(`SELECT DISTINCT i.id FROM incidents i JOIN incident_components ic ON ic.incident_id=i.id JOIN status_page_components spc ON spc.component_id=ic.component_id WHERE spc.status_page_id=$1 ORDER BY i.id`,[page.id]);
    const incidents=[];for(const row of rows)incidents.push(await this.#incidentView(page.organizationId,row.id));
    incidents.sort((a,b)=>new Date(b.startedAt)-new Date(a.startedAt));
    return{page,components,incidents:incidents.slice(0,30)};
  }

  // ---------------------------------------------------------------------
  // Relay 0.2 — durable alert intake with an atomic routing record.
  //
  // The alert and its (initially PENDING) routing row are written in one
  // transaction, and `alert_routings.alert_id` is unique. A retried or
  // concurrent intake of the same `(organization, source, externalId)` alert
  // therefore cannot produce a second routing decision or a second
  // notification: the loser of the race observes `created: false`.
  // ---------------------------------------------------------------------
  async ingestAlert(organizationId,input){
    const routingSelect=`SELECT * FROM alert_routings WHERE organization_id=$1 AND alert_id=$2`;
    const findExisting=async(sqlx)=>input.externalId
      ? this.#one(`SELECT * FROM alerts WHERE organization_id=$1 AND source=$2 AND external_id=$3`,[organizationId,input.source,input.externalId],sqlx)
      : undefined;
    try{
      return await this.sql.begin(async(tx)=>{
        const existing=await findExisting(tx);
        if(existing)return{alert:existing,created:false,routing:await this.#one(routingSelect,[organizationId,existing.id],tx)};
        const alertId=uid();
        const alert=await this.#one(`INSERT INTO alerts(id,organization_id,source,external_id,title,description,severity,service_id,metadata,observed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::text::jsonb,$10) RETURNING *`,[alertId,organizationId,input.source,input.externalId??null,input.title,input.description??'',input.severity,input.serviceId??null,JSON.stringify(input.metadata??{}),input.observedAt??new Date().toISOString()],tx);
        const routing=await this.#one(`INSERT INTO alert_routings(id,organization_id,alert_id,resolution) VALUES($1,$2,$3,'PENDING') RETURNING *`,[uid(),organizationId,alertId],tx);
        return{alert,created:true,routing};
      });
    }catch(error){
      if(error?.code==='23505'&&input.externalId){
        const existing=await findExisting(this.sql);
        if(existing)return{alert:existing,created:false,routing:await this.#one(routingSelect,[organizationId,existing.id])};
      }
      throw normalizeDbError(error);
    }
  }
  async listAlerts(organizationId){return this.#many(`SELECT * FROM alerts WHERE organization_id=$1 ORDER BY received_at DESC LIMIT 200`,[organizationId]);}
  async getAlert(organizationId,alertId){return this.#one(`SELECT * FROM alerts WHERE organization_id=$1 AND id=$2`,[organizationId,alertId]);}

  /**
   * Alerts joined with their routing decision, service name and acknowledger,
   * shaped for the compact operational alert table. Alerts that predate Relay
   * 0.2 have no routing row and are reported with `routing: null`.
   */
  async listAlertsWithRouting(organizationId,{limit=200}={}){
    const rows=await this.sql.unsafe(`
      SELECT a.id AS alert_id, a.source, a.external_id, a.title, a.description, a.severity,
             a.service_id, a.metadata, a.observed_at, a.received_at,
             s.name AS service_name,
             r.id AS routing_id, r.resolution, r.notification_status, r.notification_error,
             r.notified_at, r.evaluated_at, r.period_starts_at, r.period_ends_at,
             r.rule_id, r.rule_name, r.schedule_id, r.schedule_name, r.team_id, r.team_name,
             r.oncall_user_id, r.oncall_display_name, r.responder_source, r.override_id,
             r.acknowledged_at, r.acknowledged_by_user_id, r.acknowledged_by_display_name, r.incident_id
      FROM alerts a
      LEFT JOIN alert_routings r ON r.alert_id=a.id AND r.organization_id=a.organization_id
      LEFT JOIN services s ON s.id=a.service_id
      WHERE a.organization_id=$1
      ORDER BY a.received_at DESC, a.id DESC
      LIMIT $2`,[organizationId,Math.max(1,Math.min(500,Number(limit)||200))]);
    return rows.map((r)=>({
      id:r.alert_id,source:r.source,externalId:r.external_id,title:r.title,description:r.description,
      severity:r.severity,serviceId:r.service_id,serviceName:r.service_name??null,metadata:r.metadata,
      observedAt:r.observed_at?.toISOString?.()??r.observed_at,receivedAt:r.received_at?.toISOString?.()??r.received_at,
      routing:r.routing_id?{
        id:r.routing_id,resolution:r.resolution,notificationStatus:r.notification_status,notificationError:r.notification_error,
        notifiedAt:r.notified_at?.toISOString?.()??null,evaluatedAt:r.evaluated_at?.toISOString?.()??null,
        periodStartsAt:r.period_starts_at?.toISOString?.()??null,periodEndsAt:r.period_ends_at?.toISOString?.()??null,
        ruleId:r.rule_id,ruleName:r.rule_name,scheduleId:r.schedule_id,scheduleName:r.schedule_name,
        teamId:r.team_id,teamName:r.team_name,oncallUserId:r.oncall_user_id,oncallDisplayName:r.oncall_display_name,
        responderSource:r.responder_source,overrideId:r.override_id,
        acknowledgedAt:r.acknowledged_at?.toISOString?.()??null,acknowledgedByUserId:r.acknowledged_by_user_id,
        acknowledgedByDisplayName:r.acknowledged_by_display_name,incidentId:r.incident_id
      }:null
    }));
  }
  async getAlertRouting(organizationId,alertId){
    const rows=await this.sql.unsafe(`
      SELECT r.*, a.source AS alert_source, a.title AS alert_title, a.severity AS alert_severity,
             a.received_at AS alert_received_at, u.display_name AS acknowledged_by_name
      FROM alert_routings r
      JOIN alerts a ON a.id=r.alert_id AND a.organization_id=r.organization_id
      LEFT JOIN users u ON u.id=r.acknowledged_by_user_id
      WHERE r.organization_id=$1 AND r.alert_id=$2`,[organizationId,alertId]);
    if(!rows[0])return undefined;
    const r=rows[0];
    return {...camel(r),acknowledgedByDisplayName:r.acknowledged_by_display_name??r.acknowledged_by_name??null};
  }

  /**
   * Persist a routing decision. Upsert keyed on the unique alert_id: an alert
   * can only ever have one routing record, so re-evaluation overwrites rather
   * than duplicates. Names are snapshotted so history never drifts when a rule,
   * schedule, team or rotation changes later.
   */
  async recordAlertRouting(organizationId,alertId,decision){
    try{
      return await this.#one(`
        INSERT INTO alert_routings(id,organization_id,alert_id,rule_id,rule_name,schedule_id,schedule_name,team_id,team_name,
          oncall_user_id,oncall_display_name,responder_source,override_id,resolution,period_starts_at,period_ends_at,evaluated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,now())
        ON CONFLICT (alert_id) DO UPDATE SET
          rule_id=EXCLUDED.rule_id, rule_name=EXCLUDED.rule_name,
          schedule_id=EXCLUDED.schedule_id, schedule_name=EXCLUDED.schedule_name,
          team_id=EXCLUDED.team_id, team_name=EXCLUDED.team_name,
          oncall_user_id=EXCLUDED.oncall_user_id, oncall_display_name=EXCLUDED.oncall_display_name,
          responder_source=EXCLUDED.responder_source, override_id=EXCLUDED.override_id,
          resolution=EXCLUDED.resolution, period_starts_at=EXCLUDED.period_starts_at,
          period_ends_at=EXCLUDED.period_ends_at, evaluated_at=now(), updated_at=now()
        RETURNING *`,[uid(),organizationId,alertId,decision.ruleId??null,decision.ruleName??null,decision.scheduleId??null,
          decision.scheduleName??null,decision.teamId??null,decision.teamName??null,decision.oncallUserId??null,
          decision.oncallDisplayName??null,decision.responderSource??null,decision.overrideId??null,decision.resolution,
          decision.periodStartsAt??null,decision.periodEndsAt??null]);
    }catch(error){throw normalizeDbError(error)}
  }

  async recordRoutingNotification(organizationId,alertId,{status,provider,error,notifiedAt,discordUserId}){
    return this.#one(`UPDATE alert_routings SET notification_status=$3,notification_provider=$4,notification_error=$5,
      notified_at=$6,discord_user_id=$7,updated_at=now() WHERE organization_id=$1 AND alert_id=$2 RETURNING *`,
      [organizationId,alertId,status,provider??null,error?String(error).slice(0,900):null,notifiedAt??null,discordUserId??null]);
  }

  /**
   * First acknowledgement wins and is recorded under a row lock, so concurrent
   * acknowledgements cannot both be persisted. Repeating an acknowledgement is
   * an idempotent no-op reported through `alreadyAcknowledged`.
   */
  async acknowledgeAlertRouting(organizationId,alertId,{userId,displayName}){
    return this.sql.begin(async(tx)=>{
      const current=await this.#one(`SELECT * FROM alert_routings WHERE organization_id=$1 AND alert_id=$2 FOR UPDATE`,[organizationId,alertId],tx);
      if(!current)return undefined;
      if(current.acknowledgedAt)return{routing:current,alreadyAcknowledged:true};
      const routing=await this.#one(`UPDATE alert_routings SET acknowledged_at=now(),acknowledged_by_user_id=$3,
        acknowledged_by_display_name=$4,updated_at=now() WHERE organization_id=$1 AND alert_id=$2 RETURNING *`,
        [organizationId,alertId,userId,displayName??null],tx);
      await tx.unsafe(`UPDATE escalation_jobs SET state='CANCELLED_ACKNOWLEDGED',updated_at=now() WHERE organization_id=$1 AND alert_id=$2 AND state IN ('PENDING','IN_FLIGHT')`,[organizationId,alertId]);
      // A delivery that never reached a provider is still a future page: once
      // the alert is acknowledged it is cancelled. Deliveries with attempts keep
      // their immutable history and continue to be retried/observed as recorded.
      await tx.unsafe(`UPDATE notification_deliveries SET status='CANCELLED',completed_at=now(),next_attempt_at=now(),
        lease_owner=NULL,lease_expires_at=NULL,updated_at=now()
        WHERE organization_id=$1 AND alert_id=$2 AND status IN ('PENDING','RETRYING','IN_FLIGHT') AND attempt_count=0`,[organizationId,alertId]);
      return{routing,alreadyAcknowledged:false};
    });
  }

  async linkRoutingIncident(organizationId,alertId,incidentId){
    return this.#one(`UPDATE alert_routings SET incident_id=$3,updated_at=now() WHERE organization_id=$1 AND alert_id=$2 RETURNING *`,[organizationId,alertId,incidentId]);
  }

  // ---------------------------------------------------------------------
  // Relay 0.2 — responder teams
  // ---------------------------------------------------------------------
  async createTeam(organizationId,input){
    try{
      return await this.#one(`INSERT INTO responder_teams(id,organization_id,name,slug,description) VALUES($1,$2,$3,$4,$5) RETURNING *`,
        [uid(),organizationId,input.name,input.slug,input.description??'']);
    }catch(error){throw normalizeDbError(error)}
  }
  async listTeams(organizationId){
    return this.#many(`SELECT t.*, (SELECT count(*)::int FROM responder_team_members m WHERE m.team_id=t.id) AS member_count,
      (SELECT count(*)::int FROM services s WHERE s.owner_team_id=t.id) AS service_count
      FROM responder_teams t WHERE t.organization_id=$1 ORDER BY t.name`,[organizationId]);
  }
  async getTeam(organizationId,teamId){
    const team=await this.#one(`SELECT * FROM responder_teams WHERE organization_id=$1 AND id=$2`,[organizationId,teamId]);
    if(!team)return undefined;
    const members=await this.#many(`SELECT tm.user_id, tm.joined_at, m.role, u.display_name, u.email
      FROM responder_team_members tm
      JOIN organization_memberships m ON m.organization_id=tm.organization_id AND m.user_id=tm.user_id
      JOIN users u ON u.id=tm.user_id
      WHERE tm.organization_id=$1 AND tm.team_id=$2 ORDER BY tm.joined_at, u.display_name`,[organizationId,teamId]);
    const services=await this.#many(`SELECT id,name,slug FROM services WHERE organization_id=$1 AND owner_team_id=$2 ORDER BY name`,[organizationId,teamId]);
    return{...team,members:members.map((m)=>({userId:m.userId,displayName:m.displayName,email:m.email,role:m.role,joinedAt:m.joinedAt})),services};
  }
  async updateTeam(organizationId,teamId,patch){
    const current=await this.#one(`SELECT * FROM responder_teams WHERE organization_id=$1 AND id=$2`,[organizationId,teamId]);
    if(!current)return undefined;
    try{
      return await this.#one(`UPDATE responder_teams SET name=$3,slug=$4,description=$5,updated_at=now() WHERE organization_id=$1 AND id=$2 RETURNING *`,
        [organizationId,teamId,patch.name??current.name,patch.slug??current.slug,patch.description??current.description]);
    }catch(error){throw normalizeDbError(error)}
  }
  async addTeamMember(organizationId,teamId,userId){
    try{
      return await this.sql.begin(async(tx)=>{
        const inserted=await tx.unsafe(`INSERT INTO responder_team_members(team_id,organization_id,user_id)
          SELECT t.id,t.organization_id,m.user_id FROM responder_teams t
          JOIN organization_memberships m ON m.organization_id=t.organization_id AND m.user_id=$3
          WHERE t.organization_id=$1 AND t.id=$2
          ON CONFLICT (team_id,user_id) DO NOTHING RETURNING user_id`,[organizationId,teamId,userId]);
        return inserted.length>0;
      });
    }catch(error){throw normalizeDbError(error)}
  }
  async removeTeamMember(organizationId,teamId,userId){
    const rows=await this.sql.unsafe(`DELETE FROM responder_team_members WHERE team_id IN (SELECT id FROM responder_teams WHERE organization_id=$1 AND id=$2) AND user_id=$3 RETURNING user_id`,[organizationId,teamId,userId]);
    return rows.length>0;
  }

  // ---------------------------------------------------------------------
  // Relay 0.2 — on-call schedules
  // ---------------------------------------------------------------------
  async createSchedule(organizationId,input){
    try{
      return await this.sql.begin(async(tx)=>{
        const team=await this.#one(`SELECT id,name FROM responder_teams WHERE organization_id=$1 AND id=$2`,[organizationId,input.teamId],tx);
        if(!team)throw domainError('INVALID_REFERENCE','The schedule team must belong to the same organization.',400);
        const scheduleId=uid();
        const schedule=await this.#one(`INSERT INTO oncall_schedules(id,organization_id,team_id,name,time_zone,enabled,rotation_starts_at,rotation_interval_minutes)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
          [scheduleId,organizationId,input.teamId,input.name,input.timeZone,input.enabled!==false,input.rotationStartsAt,input.rotationIntervalMinutes],tx);
        await this.#insertParticipants(organizationId,scheduleId,input.teamId,input.participantUserIds??[],tx);
        return{...schedule,teamName:team.name,participants:await this.#participants(organizationId,scheduleId,tx),overrides:[]};
      });
    }catch(error){throw normalizeDbError(error)}
  }
  async #insertParticipants(organizationId,scheduleId,teamId,userIds,tx){
    for(let position=0;position<userIds.length;position+=1){
      const inserted=await tx.unsafe(`INSERT INTO oncall_schedule_participants(schedule_id,organization_id,team_id,position,user_id)
        SELECT $1,$2,$3,$4,m.user_id FROM responder_team_members m WHERE m.team_id=$3 AND m.user_id=$5
        ON CONFLICT DO NOTHING RETURNING user_id`,[scheduleId,organizationId,teamId,position,userIds[position]]);
      if(!inserted.length)throw domainError('INVALID_PARTICIPANT','Every rotation participant must be a member of the schedule team and organization.',400);
    }
  }
  async #participants(organizationId,scheduleId,tx){
    return this.#many(`SELECT p.position,p.user_id,u.display_name,u.email,p.added_at
      FROM oncall_schedule_participants p JOIN users u ON u.id=p.user_id
      WHERE p.organization_id=$1 AND p.schedule_id=$2 ORDER BY p.position`,[organizationId,scheduleId],tx);
  }
  async listSchedules(organizationId){
    const schedules=await this.#many(`SELECT s.*, t.name AS team_name FROM oncall_schedules s
      LEFT JOIN responder_teams t ON t.id=s.team_id AND t.organization_id=s.organization_id
      WHERE s.organization_id=$1 ORDER BY s.created_at, s.name`,[organizationId]);
    const participants=await this.#many(`SELECT p.*, u.display_name FROM oncall_schedule_participants p
      JOIN users u ON u.id=p.user_id WHERE p.organization_id=$1 ORDER BY p.schedule_id,p.position`,[organizationId]);
    const overrides=await this.#many(`SELECT o.*, u.display_name AS replacement_display_name FROM oncall_overrides o
      LEFT JOIN users u ON u.id=o.replacement_user_id WHERE o.organization_id=$1 ORDER BY o.starts_at`,[organizationId]);
    return schedules.map((schedule)=>({
      ...schedule,
      participants:participants.filter((p)=>p.scheduleId===schedule.id),
      overrides:overrides.filter((o)=>o.scheduleId===schedule.id)
    }));
  }
  async getSchedule(organizationId,scheduleId){
    const schedule=await this.#one(`SELECT s.*, t.name AS team_name FROM oncall_schedules s
      LEFT JOIN responder_teams t ON t.id=s.team_id AND t.organization_id=s.organization_id
      WHERE s.organization_id=$1 AND s.id=$2`,[organizationId,scheduleId]);
    if(!schedule)return undefined;
    return{...schedule,participants:await this.#participants(organizationId,scheduleId,this.sql),overrides:await this.listOverrides(organizationId,scheduleId)};
  }
  async updateSchedule(organizationId,scheduleId,patch){
    const current=await this.#one(`SELECT * FROM oncall_schedules WHERE organization_id=$1 AND id=$2`,[organizationId,scheduleId]);
    if(!current)return undefined;
    try{
      return await this.sql.begin(async(tx)=>{
        const schedule=await this.#one(`UPDATE oncall_schedules SET name=$3,time_zone=$4,enabled=$5,rotation_starts_at=$6,
          rotation_interval_minutes=$7,updated_at=now() WHERE organization_id=$1 AND id=$2 RETURNING *`,
          [organizationId,scheduleId,patch.name??current.name,patch.timeZone??current.timeZone,
           patch.enabled===undefined?current.enabled:patch.enabled,patch.rotationStartsAt??current.rotationStartsAt,
           patch.rotationIntervalMinutes??current.rotationIntervalMinutes],tx);
        if(patch.participantUserIds){
          await tx.unsafe(`DELETE FROM oncall_schedule_participants WHERE schedule_id=$1 AND organization_id=$2`,[scheduleId,organizationId]);
          await this.#insertParticipants(organizationId,scheduleId,current.teamId,patch.participantUserIds,tx);
        }
        const team=await this.#one(`SELECT name FROM responder_teams WHERE organization_id=$1 AND id=$2`,[organizationId,current.teamId],tx);
        return{...schedule,teamName:team?.name??null,participants:await this.#participants(organizationId,scheduleId,tx),overrides:await this.listOverrides(organizationId,scheduleId,tx)};
      });
    }catch(error){throw normalizeDbError(error)}
  }

  // ---------------------------------------------------------------------
  // Relay 0.2 — on-call overrides
  // ---------------------------------------------------------------------
  async createOverride(organizationId,scheduleId,input,createdByUserId){
    try{
      return await this.sql.begin(async(tx)=>{
        // Serialise per schedule so two concurrent overrides cannot both pass
        // the overlap check.
        const schedule=await this.#one(`SELECT id,name,team_id FROM oncall_schedules WHERE organization_id=$1 AND id=$2 FOR UPDATE`,[organizationId,scheduleId],tx);
        if(!schedule)throw domainError('SCHEDULE_NOT_FOUND','On-call schedule not found.',404);
        const member=await this.#one(`SELECT user_id FROM organization_memberships WHERE organization_id=$1 AND user_id=$2`,[organizationId,input.replacementUserId],tx);
        if(!member)throw domainError('INVALID_REFERENCE','The replacement responder must be a member of the organization.',400);
        const clash=await this.#many(`SELECT id,starts_at,ends_at FROM oncall_overrides WHERE schedule_id=$1 AND organization_id=$2 AND starts_at < $4::timestamptz AND ends_at > $3::timestamptz`,
          [scheduleId,organizationId,input.startsAt,input.endsAt],tx);
        if(clash.length)throw domainError('OVERRIDE_OVERLAP','An override already covers part of this window. Adjust the window or delete the existing override.',409);
        const override=await this.#one(`INSERT INTO oncall_overrides(id,organization_id,schedule_id,replacement_user_id,starts_at,ends_at,reason,created_by_user_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
          [uid(),organizationId,scheduleId,input.replacementUserId,input.startsAt,input.endsAt,input.reason??'',createdByUserId],tx);
        return{...override,scheduleName:schedule.name};
      });
    }catch(error){throw normalizeDbError(error)}
  }
  async listOverrides(organizationId,scheduleId,tx){
    return this.#many(`SELECT o.*, u.display_name AS replacement_display_name FROM oncall_overrides o
      LEFT JOIN users u ON u.id=o.replacement_user_id
      WHERE o.organization_id=$1 AND ($2::text IS NULL OR o.schedule_id=$2) ORDER BY o.starts_at DESC, o.id`,[organizationId,scheduleId??null],tx??this.sql);
  }
  async getOverride(organizationId,overrideId){
    return this.#one(`SELECT o.*, u.display_name AS replacement_display_name FROM oncall_overrides o
      LEFT JOIN users u ON u.id=o.replacement_user_id WHERE o.organization_id=$1 AND o.id=$2`,[organizationId,overrideId]);
  }
  async deleteOverride(organizationId,overrideId){
    const rows=await this.sql.unsafe(`DELETE FROM oncall_overrides WHERE organization_id=$1 AND id=$2 RETURNING id`,[organizationId,overrideId]);
    return rows.length>0;
  }

  // ---------------------------------------------------------------------
  // Relay 0.2 — alert routing rules
  // ---------------------------------------------------------------------
  async createRoutingRule(organizationId,input){
    try{
      const rule=await this.#one(`INSERT INTO alert_routing_rules(id,organization_id,name,enabled,priority,match_service_id,match_source,match_severities,target_kind,target_schedule_id,notification_channels,escalation_policy_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::text::jsonb,$9,$10,$11::text::jsonb,$12) RETURNING *`,
        [uid(),organizationId,input.name,input.enabled!==false,input.priority,input.matchServiceId??null,input.matchSource??null,
         JSON.stringify(input.matchSeverities??[]),input.targetKind??'ONCALL_SCHEDULE',input.targetScheduleId,JSON.stringify(input.notificationChannels??['DISCORD']),input.escalationPolicyId??null]);
      return{...rule,scheduleName:(await this.#one(`SELECT name FROM oncall_schedules WHERE organization_id=$1 AND id=$2`,[organizationId,rule.targetScheduleId]))?.name??null};
    }catch(error){throw normalizeDbError(error)}
  }
  async listRoutingRules(organizationId){
    return this.#many(`SELECT r.*, s.name AS schedule_name, sv.name AS match_service_name
      FROM alert_routing_rules r
      LEFT JOIN oncall_schedules s ON s.id=r.target_schedule_id AND s.organization_id=r.organization_id
      LEFT JOIN services sv ON sv.id=r.match_service_id
      WHERE r.organization_id=$1 ORDER BY r.priority, r.created_at, r.id`,[organizationId]);
  }
  async getRoutingRule(organizationId,ruleId){
    return this.#one(`SELECT r.*, s.name AS schedule_name FROM alert_routing_rules r
      LEFT JOIN oncall_schedules s ON s.id=r.target_schedule_id AND s.organization_id=r.organization_id
      WHERE r.organization_id=$1 AND r.id=$2`,[organizationId,ruleId]);
  }
  async updateRoutingRule(organizationId,ruleId,patch){
    const current=await this.#one(`SELECT * FROM alert_routing_rules WHERE organization_id=$1 AND id=$2`,[organizationId,ruleId]);
    if(!current)return undefined;
    try{
      const rule=await this.#one(`UPDATE alert_routing_rules SET name=$3,enabled=$4,priority=$5,match_service_id=$6,match_source=$7,
        match_severities=$8::text::jsonb,target_schedule_id=$9,notification_channels=$10::text::jsonb,escalation_policy_id=$11,updated_at=now() WHERE organization_id=$1 AND id=$2 RETURNING *`,
        [organizationId,ruleId,patch.name??current.name,patch.enabled===undefined?current.enabled:patch.enabled,
         patch.priority??current.priority,'matchServiceId' in patch?(patch.matchServiceId??null):current.matchServiceId,
         'matchSource' in patch?(patch.matchSource??null):current.matchSource,
         JSON.stringify(patch.matchSeverities??current.matchSeverities??[]),patch.targetScheduleId??current.targetScheduleId,
         JSON.stringify(patch.notificationChannels??current.notificationChannels??['DISCORD']),
         'escalationPolicyId' in patch?(patch.escalationPolicyId??null):current.escalationPolicyId]);
      return{...rule,scheduleName:(await this.#one(`SELECT name FROM oncall_schedules WHERE organization_id=$1 AND id=$2`,[organizationId,rule.targetScheduleId]))?.name??null};
    }catch(error){throw normalizeDbError(error)}
  }
  async deleteRoutingRule(organizationId,ruleId){
    const rows=await this.sql.unsafe(`DELETE FROM alert_routing_rules WHERE organization_id=$1 AND id=$2 RETURNING id`,[organizationId,ruleId]);
    return rows.length>0;
  }

  // ---------------------------------------------------------------------
  // Relay 0.2 — organization-scoped escalation policies
  // ---------------------------------------------------------------------
  async listEscalationPolicies(organizationId){
    const policies=await this.#many(`SELECT * FROM escalation_policies WHERE organization_id=$1 ORDER BY name,id`,[organizationId]);
    for(const policy of policies) policy.steps=await this.#many(`SELECT * FROM escalation_policy_steps WHERE organization_id=$1 AND policy_id=$2 ORDER BY position`,[organizationId,policy.id]);
    return policies;
  }
  async getEscalationPolicy(organizationId,policyId){return (await this.listEscalationPolicies(organizationId)).find((p)=>p.id===policyId);}
  async saveEscalationPolicy(organizationId,input,policyId){
    const steps=validateEscalationSteps(input.steps??[]);
    try{return await this.sql.begin(async(tx)=>{
      let policy;
      if(policyId){
        policy=await this.#one(`UPDATE escalation_policies SET name=$3,description=$4,enabled=$5,updated_at=now() WHERE organization_id=$1 AND id=$2 RETURNING *`,[organizationId,policyId,input.name,input.description??'',input.enabled!==false],tx);
        if(!policy)return undefined;
        await tx.unsafe(`DELETE FROM escalation_policy_steps WHERE organization_id=$1 AND policy_id=$2`,[organizationId,policyId]);
      }else policy=await this.#one(`INSERT INTO escalation_policies(id,organization_id,name,description,enabled) VALUES($1,$2,$3,$4,$5) RETURNING *`,[uid(),organizationId,input.name,input.description??'',input.enabled!==false],tx);
      for(const step of steps) await tx.unsafe(`INSERT INTO escalation_policy_steps(id,organization_id,policy_id,position,after_minutes,target_schedule_id,channels) VALUES($1,$2,$3,$4,$5,$6,$7::text::jsonb)`,[uid(),organizationId,policy.id,step.position,step.afterMinutes,step.targetScheduleId,JSON.stringify(step.channels)]);
      return {...policy,steps:await this.#many(`SELECT * FROM escalation_policy_steps WHERE organization_id=$1 AND policy_id=$2 ORDER BY position`,[organizationId,policy.id],tx)};
    })}catch(error){throw normalizeDbError(error)}
  }
  async deleteEscalationPolicy(organizationId,policyId){const rows=await this.sql.unsafe(`DELETE FROM escalation_policies WHERE organization_id=$1 AND id=$2 RETURNING id`,[organizationId,policyId]);return rows.length>0;}
  async materializeEscalationJobs(plan){
    return this.sql.begin(async(tx)=>{
      const result=[];
      for(const job of plan){const row=await this.#one(`INSERT INTO escalation_jobs(id,organization_id,alert_id,routing_id,policy_id,policy_name_snapshot,step_position,after_minutes,due_at,target_schedule_id,target_schedule_name_snapshot,channels,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::text::jsonb,'PENDING') ON CONFLICT(routing_id,step_position) DO NOTHING RETURNING *`,[uid(),job.organizationId,job.alertId,job.routingId,job.policyId,job.policyNameSnapshot,job.stepPosition,job.afterMinutes,job.dueAt,job.targetScheduleId,job.targetScheduleNameSnapshot,JSON.stringify(job.channels)],tx);if(row)result.push(row);}
      return result;
    });
  }
  async listEscalationJobs(organizationId,alertId){return this.#many(`SELECT * FROM escalation_jobs WHERE organization_id=$1 AND alert_id=$2 ORDER BY step_position`,[organizationId,alertId]);}

  // ---------------------------------------------------------------------
  // Relay 0.2 — Discord responder mapping
  // ---------------------------------------------------------------------
  async upsertDiscordIdentity(organizationId,userId,discordUserId){
    try{
      return await this.#one(`INSERT INTO discord_identities(id,organization_id,user_id,discord_user_id) VALUES($1,$2,$3,$4)
        ON CONFLICT (organization_id,user_id) DO UPDATE SET discord_user_id=EXCLUDED.discord_user_id,updated_at=now() RETURNING *`,
        [uid(),organizationId,userId,discordUserId]);
    }catch(error){throw normalizeDbError(error)}
  }
  async getDiscordIdentity(organizationId,userId){
    return this.#one(`SELECT * FROM discord_identities WHERE organization_id=$1 AND user_id=$2`,[organizationId,userId]);
  }
  async listDiscordIdentities(organizationId){
    return this.#many(`SELECT d.id,d.organization_id,d.user_id,d.discord_user_id,d.created_at,d.updated_at,u.display_name
      FROM discord_identities d JOIN users u ON u.id=d.user_id WHERE d.organization_id=$1 ORDER BY u.display_name`,[organizationId]);
  }
  async deleteDiscordIdentity(organizationId,userId){
    const rows=await this.sql.unsafe(`DELETE FROM discord_identities WHERE organization_id=$1 AND user_id=$2 RETURNING id`,[organizationId,userId]);
    return rows.length>0;
  }
  async upsertIntegration(organizationId,{provider,name,secretEncrypted,config,enabled}){
    return this.#one(`INSERT INTO integrations(id,organization_id,provider,name,secret_encrypted,config,enabled) VALUES($1,$2,$3,$4,$5,$6::text::jsonb,$7)
      ON CONFLICT(organization_id,provider) DO UPDATE SET name=excluded.name,secret_encrypted=excluded.secret_encrypted,config=excluded.config,enabled=excluded.enabled,updated_at=now() RETURNING *`,
      [uid(),organizationId,provider,name,secretEncrypted,JSON.stringify(config??{}),enabled]);
  }
  async getIntegration(organizationId,provider){return this.#one(`SELECT * FROM integrations WHERE organization_id=$1 AND provider=$2`,[organizationId,provider]);}
  async listIntegrations(organizationId){return this.#many(`SELECT id,organization_id,provider,name,config,enabled,created_at,updated_at FROM integrations WHERE organization_id=$1 ORDER BY provider`,[organizationId]);}
  async deleteIntegration(organizationId,provider){
    const rows=await this.sql.unsafe(`DELETE FROM integrations WHERE organization_id=$1 AND provider=$2 RETURNING id`,[organizationId,provider]);
    return rows.length>0;
  }

  // ---------------------------------------------------------------------
  // Relay 0.2 — durable notification deliveries and immutable attempts.
  //
  // The claim is the only place a lease is handed out, and it is the only
  // place that may move a row into IN_FLIGHT. `FOR UPDATE SKIP LOCKED` lets N
  // workers claim disjoint work concurrently without blocking each other, and
  // the lease token makes every later write idempotent and stale-writer safe.
  // ---------------------------------------------------------------------
  async enqueueDeliveries(records){
    if(!records.length)return[];
    return this.sql.begin(async(tx)=>{
      const inserted=[];
      for(const record of records){
        const row=await this.#one(`INSERT INTO notification_deliveries(id,organization_id,alert_id,routing_id,escalation_job_id,provider,destination_snapshot,
          responder_user_id,responder_name_snapshot,status,scheduled_at,attempt_count,next_attempt_at)
          VALUES($1,$2,$3,$4,$5,$6,$7::text::jsonb,$8,$9,$10,$11,$12,$13)
          ON CONFLICT DO NOTHING RETURNING *`,
          [record.id??uid(),record.organizationId,record.alertId,record.routingId,record.escalationJobId??null,record.provider,
           JSON.stringify(record.destinationSnapshot??{}),record.responderUserId??null,record.responderNameSnapshot??null,
           record.status??'PENDING',record.scheduledAt??new Date().toISOString(),record.attemptCount??0,
           record.nextAttemptAt??record.scheduledAt??new Date().toISOString()],tx);
        if(row)inserted.push(row);
      }
      return inserted;
    });
  }
  async listAlertDeliveries(organizationId,alertId){
    return this.#many(`SELECT * FROM notification_deliveries WHERE organization_id=$1 AND alert_id=$2 ORDER BY created_at, id`,[organizationId,alertId]);
  }
  async listDeliveries(organizationId,{limit=200}={}){
    return this.#many(`SELECT * FROM notification_deliveries WHERE organization_id=$1 ORDER BY created_at DESC, id DESC LIMIT $2`,[organizationId,Math.max(1,Math.min(500,Number(limit)||200))]);
  }
  async getDelivery(organizationId,deliveryId){
    return this.#one(`SELECT * FROM notification_deliveries WHERE organization_id=$1 AND id=$2`,[organizationId,deliveryId]);
  }
  async listDeliveryAttempts(organizationId,deliveryId){
    return this.#many(`SELECT * FROM notification_attempts WHERE organization_id=$1 AND delivery_id=$2 ORDER BY attempt_number`,[organizationId,deliveryId]);
  }
  async listDueDeliveries(organizationId,{now:at=new Date().toISOString(),limit=200,alertId=null}={}){
    return this.#many(`SELECT * FROM notification_deliveries d
      WHERE d.organization_id=$1 AND ($4::text IS NULL OR d.alert_id=$4)
        AND ((d.status IN ('PENDING','RETRYING') AND d.next_attempt_at <= $2::timestamptz)
          OR (d.status='IN_FLIGHT' AND d.lease_expires_at IS NOT NULL AND d.lease_expires_at < $2::timestamptz))
      ORDER BY d.next_attempt_at, d.id LIMIT $3`,[organizationId,at,Math.max(1,Math.min(500,Number(limit)||200)),alertId]);
  }
  /**
   * Claim due work. The inner SELECT takes row locks with SKIP LOCKED, so
   * concurrent workers take disjoint sets and never wait on each other; the
   * UPDATE stamps the lease inside the same short transaction.
   */
  async claimDueDeliveries({now:at=new Date().toISOString(),leaseOwner,leaseSeconds=120,limit=20,alertId=null}){
    return this.sql.begin(async(tx)=>{
      const rows=await tx.unsafe(`
        UPDATE notification_deliveries SET status='IN_FLIGHT', lease_owner=$1,
          lease_expires_at=$2::timestamptz + ($3 || ' seconds')::interval, updated_at=now()
        WHERE id IN (
          SELECT id FROM notification_deliveries
          WHERE ($4::text IS NULL OR alert_id=$4)
            AND ((status IN ('PENDING','RETRYING') AND next_attempt_at <= $2::timestamptz)
              OR (status='IN_FLIGHT' AND lease_expires_at IS NOT NULL AND lease_expires_at < $2::timestamptz))
          ORDER BY next_attempt_at, id
          FOR UPDATE SKIP LOCKED
          LIMIT $5
        ) RETURNING *`,[leaseOwner,at,String(Math.max(1,Number(leaseSeconds)||120)),alertId,Math.max(1,Math.min(200,Number(limit)||20))]);
      return map(rows);
    });
  }
  async recoverExpiredDeliveryLeases(at=new Date().toISOString(),{limit=100}={}){
    const rows=await this.sql.unsafe(`UPDATE notification_deliveries
      SET status=CASE WHEN attempt_count>0 THEN 'RETRYING' ELSE 'PENDING' END,
          next_attempt_at=$1::timestamptz, lease_owner=NULL, lease_expires_at=NULL, updated_at=now()
      WHERE id IN (SELECT id FROM notification_deliveries
        WHERE status='IN_FLIGHT' AND lease_expires_at IS NOT NULL AND lease_expires_at < $1::timestamptz
        ORDER BY lease_expires_at FOR UPDATE SKIP LOCKED LIMIT $2)
      RETURNING id`,[at,Math.max(1,Number(limit)||100)]);
    return rows.length;
  }
  /**
   * Persist the attempt and advance the lease. The `lease_owner` predicate is
   * the guard that stops a worker whose lease already expired (and whose work
   * was reclaimed) from writing over the new owner's outcome.
   */
  async completeDelivery({deliveryId,organizationId,leaseOwner,attemptNumber,startedAt,completedAt,outcome,status,nextAttemptAt=null,safeError=null,providerStatusCode=null,manualRetryByUserId=null,skipAttempt=false}){
    return this.sql.begin(async(tx)=>{
      const current=await this.#one(`SELECT * FROM notification_deliveries WHERE organization_id=$1 AND id=$2 FOR UPDATE`,[organizationId,deliveryId],tx);
      if(!current)return undefined;
      if(current.leaseOwner!==leaseOwner)return{staleLease:true,delivery:current};
      let attempt;
      if(!skipAttempt){
        attempt=await this.#one(`INSERT INTO notification_attempts(id,organization_id,delivery_id,attempt_number,outcome,started_at,completed_at,safe_error,provider_status_code,manual,manual_retry_by_user_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
          [uid(),organizationId,deliveryId,attemptNumber,outcome,startedAt,completedAt,safeError?String(safeError).slice(0,900):null,
           providerStatusCode===null||providerStatusCode===undefined?null:Number(providerStatusCode),Boolean(manualRetryByUserId),manualRetryByUserId],tx);
      }
      const delivery=await this.#one(`UPDATE notification_deliveries SET status=$3,attempt_count=$4,last_attempt_at=$5,next_attempt_at=$6,
        completed_at=$7,last_error=$8,lease_owner=NULL,lease_expires_at=NULL,manual_retry_by_user_id=NULL,updated_at=now()
        WHERE organization_id=$1 AND id=$2 RETURNING *`,
        [organizationId,deliveryId,status,skipAttempt?current.attemptCount:attemptNumber,
         skipAttempt?current.lastAttemptAt:completedAt,nextAttemptAt??completedAt,
         ['SENT','FAILED','CANCELLED'].includes(status)?completedAt:null,
         safeError?String(safeError).slice(0,900):(status==='SENT'?null:current.lastError)],tx);
      return{staleLease:false,delivery,attempt};
    });
  }
  /** Manual retry keeps every earlier attempt and records who asked for it. */
  async scheduleManualRetry({organizationId,deliveryId,userId,now:at=new Date().toISOString()}){
    return this.#one(`UPDATE notification_deliveries SET status='RETRYING',next_attempt_at=$3::timestamptz,
      manual_retry_by_user_id=$4,lease_owner=NULL,lease_expires_at=NULL,completed_at=NULL,updated_at=now()
      WHERE organization_id=$1 AND id=$2 AND status NOT IN ('SENT','CANCELLED') RETURNING *`,[organizationId,deliveryId,at,userId]);
  }
  async claimDueEscalationJobs({now:at=new Date().toISOString(),leaseOwner,leaseSeconds=120,limit=20}){
    return this.sql.begin(async(tx)=>{
      const rows=await tx.unsafe(`UPDATE escalation_jobs SET state='IN_FLIGHT', lease_owner=$1, claimed_at=$2::timestamptz,
        lease_expires_at=$2::timestamptz + ($3 || ' seconds')::interval, updated_at=now()
        WHERE id IN (
          SELECT id FROM escalation_jobs
          WHERE (state='PENDING' AND due_at <= $2::timestamptz)
             OR (state='IN_FLIGHT' AND lease_expires_at IS NOT NULL AND lease_expires_at < $2::timestamptz)
          ORDER BY due_at, id FOR UPDATE SKIP LOCKED LIMIT $4
        ) RETURNING *`,[leaseOwner,at,String(Math.max(1,Number(leaseSeconds)||120)),Math.max(1,Math.min(200,Number(limit)||20))]);
      return map(rows);
    });
  }
  async recoverExpiredEscalationLeases(at=new Date().toISOString(),{limit=100}={}){
    const rows=await this.sql.unsafe(`UPDATE escalation_jobs SET state='PENDING', lease_owner=NULL, lease_expires_at=NULL, updated_at=now()
      WHERE id IN (SELECT id FROM escalation_jobs
        WHERE state='IN_FLIGHT' AND lease_expires_at IS NOT NULL AND lease_expires_at < $1::timestamptz
        ORDER BY lease_expires_at FOR UPDATE SKIP LOCKED LIMIT $2)
      RETURNING id`,[at,Math.max(1,Number(limit)||100)]);
    return rows.length;
  }
  /**
   * Finish a claimed escalation step.
   *
   * The routing row is locked FIRST and re-read inside this transaction. An
   * acknowledgement also locks that row, so the two orderings are strictly
   * serialized: whichever commits first is observed by the other, and Relay can
   * never create a new page after it has transactionally observed the alert as
   * acknowledged.
   */
  async completeEscalationJob({organizationId,jobId,leaseOwner,state,responderUserId=null,responderNameSnapshot=null,result={},deliveries=[]}){
    return this.sql.begin(async(tx)=>{
      const job=await this.#one(`SELECT * FROM escalation_jobs WHERE organization_id=$1 AND id=$2 FOR UPDATE`,[organizationId,jobId],tx);
      if(!job)return undefined;
      if(job.leaseOwner!==leaseOwner)return{staleLease:true,job};
      const routing=await this.#one(`SELECT * FROM alert_routings WHERE organization_id=$1 AND id=$2 FOR UPDATE`,[organizationId,job.routingId],tx);
      if(routing?.acknowledgedAt&&state!=='CANCELLED_ACKNOWLEDGED'&&state!=='FAILED'){
        state='CANCELLED_ACKNOWLEDGED';
        result={...result,reason:'ACKNOWLEDGED',acknowledgedAt:routing.acknowledgedAt};
        deliveries=[];responderUserId=null;responderNameSnapshot=null;
      }
      if(state==='CANCELLED_ACKNOWLEDGED')deliveries=[];
      const inserted=[];
      for(const record of deliveries){
        const row=await this.#one(`INSERT INTO notification_deliveries(id,organization_id,alert_id,routing_id,escalation_job_id,provider,destination_snapshot,
          responder_user_id,responder_name_snapshot,status,scheduled_at,attempt_count,next_attempt_at)
          VALUES($1,$2,$3,$4,$5,$6,$7::text::jsonb,$8,$9,$10,$11,$12,$13)
          ON CONFLICT DO NOTHING RETURNING id`,
          [record.id??uid(),record.organizationId,record.alertId,record.routingId,record.escalationJobId??jobId,record.provider,
           JSON.stringify(record.destinationSnapshot??{}),record.responderUserId??null,record.responderNameSnapshot??null,
           record.status??'PENDING',record.scheduledAt??new Date().toISOString(),record.attemptCount??0,
           record.nextAttemptAt??record.scheduledAt??new Date().toISOString()],tx);
        if(row)inserted.push(row.id);
      }
      const updated=await this.#one(`UPDATE escalation_jobs SET state=$3,resolved_responder_user_id=$4,resolved_responder_name_snapshot=$5,
        result=$6::text::jsonb, executed_at=CASE WHEN $3='COMPLETED' THEN now() ELSE executed_at END,
        lease_owner=NULL,lease_expires_at=NULL,updated_at=now()
        WHERE organization_id=$1 AND id=$2 RETURNING *`,
        [organizationId,jobId,state,responderUserId,responderNameSnapshot,JSON.stringify({...result,deliveryCount:inserted.length})],tx);
      return{staleLease:false,job:updated};
    });
  }
}
