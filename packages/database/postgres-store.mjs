import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { domainError } from '../shared/domain.mjs';

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

export async function migratePostgres(databaseUrl) {
  const { default: postgres } = await import('postgres');
  const sql = postgres(databaseUrl, { max: 1, connect_timeout: 10 });
  try {
    await sql.unsafe(`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const name = '001_initial.sql';
    const existing = await sql.unsafe('SELECT name FROM schema_migrations WHERE name = $1', [name]);
    if (!existing.length) {
      const contents = await readFile(new URL('./migrations/001_initial.sql', import.meta.url), 'utf8');
      const statements = contents
        .replace(/^\s*BEGIN;\s*/i, '')
        .replace(/\s*COMMIT;\s*$/i, '')
        .split(';')
        .map((statement) => statement.trim())
        .filter(Boolean);
      await sql.begin(async (tx) => {
        for (const statement of statements) await tx.unsafe(statement);
        await tx.unsafe('INSERT INTO schema_migrations(name) VALUES ($1)', [name]);
      });
    }
    return { applied: existing.length ? [] : [name] };
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
  async listServices(organizationId){return this.#many(`SELECT * FROM services WHERE organization_id=$1 ORDER BY name`,[organizationId]);}
  async getService(organizationId,serviceId){return this.#one(`SELECT * FROM services WHERE organization_id=$1 AND id=$2`,[organizationId,serviceId]);}
  async updateService(organizationId,serviceId,patch){
    const current=await this.getService(organizationId,serviceId); if(!current)return undefined;
    return this.#one(`UPDATE services SET name=$3,slug=$4,description=$5,operational_state=$6,updated_at=now() WHERE organization_id=$1 AND id=$2 RETURNING *`,[organizationId,serviceId,patch.name??current.name,patch.slug??current.slug,patch.description??current.description,patch.operationalState??current.operationalState]);
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
      const page=await this.#one(`INSERT INTO status_pages(id,organization_id,name,slug,is_public,branding) VALUES($1,$2,$3,$4,$5,$6::jsonb) RETURNING *`,[uid(),organizationId,input.name,input.slug,input.isPublic,JSON.stringify(input.branding)],tx);
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
      await tx.unsafe(`INSERT INTO incident_timeline_events(id,incident_id,actor_user_id,event_type,message,metadata) VALUES($1,$2,$3,$4,$5,$6::jsonb)`,[uid(),incidentId,event.actorUserId,event.eventType,event.message??null,JSON.stringify(event.metadata??{})]);
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
      for(const event of events) await tx.unsafe(`INSERT INTO incident_timeline_events(id,incident_id,actor_user_id,event_type,message,metadata) VALUES($1,$2,$3,$4,$5,$6::jsonb)`,[uid(),incidentId,event.actorUserId,event.eventType,event.message??null,JSON.stringify(event.metadata??{})]);
      return this.#incidentView(organizationId,incidentId,tx);
    });
  }
  async addIncidentUpdate(organizationId,incidentId,{actorUserId,message,isPublic},event){
    const existing=await this.#one(`SELECT id FROM incidents WHERE organization_id=$1 AND id=$2`,[organizationId,incidentId]);if(!existing)return undefined;
    return this.sql.begin(async(tx)=>{
      const update=await this.#one(`INSERT INTO incident_updates(id,incident_id,actor_user_id,message,is_public) VALUES($1,$2,$3,$4,$5) RETURNING *`,[uid(),incidentId,actorUserId,message,isPublic],tx);
      await tx.unsafe(`INSERT INTO incident_timeline_events(id,incident_id,actor_user_id,event_type,message,metadata) VALUES($1,$2,$3,$4,$5,$6::jsonb)`,[uid(),incidentId,event.actorUserId,event.eventType,event.message??null,JSON.stringify(event.metadata??{})]);
      await tx.unsafe(`UPDATE incidents SET updated_at=now() WHERE id=$1`,[incidentId]);
      return {update,incident:await this.#incidentView(organizationId,incidentId,tx)};
    });
  }
  async addResponder(organizationId,incidentId,userId,actorUserId){
    const existing=await this.#one(`SELECT id FROM incidents WHERE organization_id=$1 AND id=$2`,[organizationId,incidentId]);if(!existing)return undefined;
    return this.sql.begin(async(tx)=>{
      const inserted=await tx.unsafe(`INSERT INTO incident_responders(incident_id,user_id) SELECT $1,m.user_id FROM organization_memberships m WHERE m.organization_id=$2 AND m.user_id=$3 ON CONFLICT DO NOTHING RETURNING user_id`,[incidentId,organizationId,userId]);
      if(inserted.length) await tx.unsafe(`INSERT INTO incident_timeline_events(id,incident_id,actor_user_id,event_type,message,metadata) VALUES($1,$2,$3,'RESPONDER_JOINED','Responder joined the incident.',$4::jsonb)`,[uid(),incidentId,actorUserId,JSON.stringify({userId})]);
      return this.#incidentView(organizationId,incidentId,tx);
    });
  }
  async upsertPostmortem(organizationId,incidentId,input,userId){
    const incident=await this.#one(`SELECT id FROM incidents WHERE organization_id=$1 AND id=$2`,[organizationId,incidentId]);if(!incident)return undefined;
    return this.sql.begin(async(tx)=>{
      const existing=await this.#one(`SELECT id FROM postmortems WHERE incident_id=$1`,[incidentId],tx);
      if(existing) await tx.unsafe(`UPDATE postmortems SET title=$2,summary=$3,impact=$4,root_cause=$5,resolution=$6,follow_up_actions=$7::jsonb,updated_at=now() WHERE incident_id=$1`,[incidentId,input.title,input.summary,input.impact,input.rootCause,input.resolution,JSON.stringify(input.followUpActions)]);
      else await tx.unsafe(`INSERT INTO postmortems(id,incident_id,title,summary,impact,root_cause,resolution,follow_up_actions,created_by_user_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`,[uid(),incidentId,input.title,input.summary,input.impact,input.rootCause,input.resolution,JSON.stringify(input.followUpActions),userId]);
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

  async createAlert(organizationId,input){
    if(input.externalId){const existing=await this.#one(`SELECT * FROM alerts WHERE organization_id=$1 AND source=$2 AND external_id=$3`,[organizationId,input.source,input.externalId]);if(existing)return existing;}
    return this.#one(`INSERT INTO alerts(id,organization_id,source,external_id,title,description,severity,service_id,metadata,observed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10) RETURNING *`,[uid(),organizationId,input.source,input.externalId??null,input.title,input.description,input.severity,input.serviceId??null,JSON.stringify(input.metadata??{}),input.observedAt]);
  }
  async listAlerts(organizationId){return this.#many(`SELECT * FROM alerts WHERE organization_id=$1 ORDER BY received_at DESC LIMIT 200`,[organizationId]);}

  async upsertIntegration(organizationId,{provider,name,secretEncrypted,enabled}){
    return this.#one(`INSERT INTO integrations(id,organization_id,provider,name,secret_encrypted,enabled) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(organization_id,provider) DO UPDATE SET name=excluded.name,secret_encrypted=excluded.secret_encrypted,enabled=excluded.enabled,updated_at=now() RETURNING *`,[uid(),organizationId,provider,name,secretEncrypted,enabled]);
  }
  async getIntegration(organizationId,provider){return this.#one(`SELECT * FROM integrations WHERE organization_id=$1 AND provider=$2`,[organizationId,provider]);}
  async listIntegrations(organizationId){return this.#many(`SELECT id,organization_id,provider,name,enabled,created_at,updated_at FROM integrations WHERE organization_id=$1 ORDER BY provider`,[organizationId]);}
}
