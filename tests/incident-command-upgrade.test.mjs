import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { splitSqlStatements,stripTransactionWrapper } from '../packages/database/sql.mjs';
import { migratePostgres } from '../packages/database/postgres-store.mjs';

test('populated 0.2 upgrade preserves paging/history and deterministically backfills command audit',{skip:!process.env.DATABASE_URL?'DATABASE_URL required':false},async()=>{
  const {default:postgres}=await import('postgres');const url=new URL(process.env.DATABASE_URL);url.pathname='/postgres';
  const admin=postgres(url.toString(),{max:1});const name='relay_command_upgrade_'+crypto.randomBytes(6).toString('hex');
  await admin.unsafe(`CREATE DATABASE ${name}`);url.pathname='/'+name;const target=url.toString();const sql=postgres(target,{max:1});
  try{
    await sql.unsafe('CREATE TABLE schema_migrations(name TEXT PRIMARY KEY,applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    for(const file of ['001_initial.sql','002_alert_routing_oncall.sql','003_escalation_delivery.sql']){
      const source=await readFile(new URL('../packages/database/migrations/'+file,import.meta.url),'utf8');
      await sql.begin(async(tx)=>{for(const statement of stripTransactionWrapper(splitSqlStatements(source)))await tx.unsafe(statement);await tx.unsafe('INSERT INTO schema_migrations(name) VALUES($1)',[file]);});
    }
    await sql.unsafe("INSERT INTO users(id,email,display_name,password_hash) VALUES ('legacy-user','legacy@example.com','Legacy commander','fixture')");
    await sql.unsafe("INSERT INTO organizations(id,name,slug) VALUES ('legacy-org','Legacy operations','legacy-operations')");
    await sql.unsafe("INSERT INTO organization_memberships(organization_id,user_id,role) VALUES ('legacy-org','legacy-user','OWNER')");
    await sql.unsafe("INSERT INTO incidents(id,organization_id,title,severity,status,creator_user_id,commander_user_id) VALUES ('legacy-incident','legacy-org','Legacy incident','SEV2','INVESTIGATING','legacy-user','legacy-user')");
    await sql.unsafe("INSERT INTO incident_timeline_events(id,incident_id,actor_user_id,event_type,message,occurred_at) VALUES ('event-b','legacy-incident','legacy-user','INTERNAL_NOTE_ADDED','Private legacy evidence','2026-09-01T12:00:00Z'),('event-a','legacy-incident','legacy-user','INCIDENT_CREATED','Legacy incident created','2026-09-01T12:00:00Z')");
    await sql.unsafe("INSERT INTO alerts(id,organization_id,source,external_id,title,severity,observed_at) VALUES ('legacy-alert','legacy-org','legacy-monitor','legacy-external','Legacy signal','critical','2026-09-01T12:00:00Z')");
    await sql.unsafe("INSERT INTO alert_routings(id,organization_id,alert_id,resolution,notification_status,incident_id) VALUES ('legacy-routing','legacy-org','legacy-alert','NO_MATCHING_RULE','NOT_ATTEMPTED','legacy-incident')");
    await sql.unsafe("INSERT INTO notification_deliveries(id,organization_id,alert_id,routing_id,provider,destination_snapshot,status) VALUES ('legacy-delivery','legacy-org','legacy-alert','legacy-routing','DISCORD','{}','FAILED')");
    const preservedTables=['users','organization_memberships','alerts','alert_routings','notification_deliveries'];const before={};
    for(const table of preservedTables)before[table]=await sql.unsafe(`SELECT * FROM ${table} ORDER BY 1`);
    const oldIncident=await sql.unsafe('SELECT id,title,severity,status,commander_user_id,created_at,updated_at FROM incidents');
    const oldEvents=await sql.unsafe('SELECT id,actor_user_id,event_type,message,metadata,occurred_at FROM incident_timeline_events ORDER BY id');
    assert.deepEqual((await migratePostgres(target)).applied,['004_incident_command.sql']);
    for(const table of preservedTables)assert.deepEqual(await sql.unsafe(`SELECT * FROM ${table} ORDER BY 1`),before[table],`${table} preserved byte-for-byte`);
    assert.deepEqual(await sql.unsafe('SELECT id,title,severity,status,commander_user_id,created_at,updated_at FROM incidents'),oldIncident);
    assert.deepEqual(await sql.unsafe('SELECT id,actor_user_id,event_type,message,metadata,occurred_at FROM incident_timeline_events ORDER BY id'),oldEvents);
    const events=await sql.unsafe('SELECT id,organization_id,incident_revision,event_index,schema_version FROM incident_timeline_events ORDER BY incident_revision,event_index');
    assert.deepEqual(events.map((e)=>[e.id,e.organization_id,String(e.incident_revision),e.event_index,e.schema_version]),[['event-a','legacy-org','0',0,0],['event-b','legacy-org','0',1,0]]);
    const incident=(await sql.unsafe('SELECT revision,communications_owner_user_id,next_public_update_at FROM incidents'))[0];assert.equal(String(incident.revision),'1');assert.equal(incident.communications_owner_user_id,null);assert.equal(incident.next_public_update_at,null);
    assert.deepEqual((await migratePostgres(target)).applied,[]);
    // Tenant FKs and reason/state constraints protect direct SQL as well as API.
    await assert.rejects(sql.unsafe("INSERT INTO incident_tasks(id,organization_id,incident_id,kind,title,state,created_by_user_id,created_by_name_snapshot,created_at,updated_at,creation_payload_hash) VALUES ('bad-task','legacy-org','legacy-incident','RESPONSE','Blocked','BLOCKED','legacy-user','Legacy',now(),now(),'hash')"),{code:'23514'});
    await assert.rejects(sql.unsafe("INSERT INTO incident_handoffs(id,organization_id,incident_id,to_user_id,requested_by_user_id,to_name_snapshot,requested_by_name_snapshot,note,state,created_at,creation_payload_hash) VALUES ('bad-handoff','wrong-org','legacy-incident','legacy-user','legacy-user','Legacy','Legacy','handoff','PENDING',now(),'hash')"),{code:'23503'});
  }finally{await sql.end({timeout:5});await admin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`);await admin.end({timeout:5});}
});

test('upgrade rejects a cross-tenant legacy commander without rewriting data',{skip:!process.env.DATABASE_URL?'DATABASE_URL required':false},async()=>{
  const {default:postgres}=await import('postgres');const url=new URL(process.env.DATABASE_URL);url.pathname='/postgres';const admin=postgres(url.toString(),{max:1});const name='relay_command_invalid_'+crypto.randomBytes(6).toString('hex');
  await admin.unsafe(`CREATE DATABASE ${name}`);url.pathname='/'+name;const sql=postgres(url.toString(),{max:1});
  try{
    for(const statement of stripTransactionWrapper(splitSqlStatements(await readFile(new URL('../packages/database/migrations/001_initial.sql',import.meta.url),'utf8'))))await sql.unsafe(statement);
    await sql.unsafe("INSERT INTO users(id,email,display_name,password_hash) VALUES ('outside-user','outside@example.com','Outside','fixture')");
    await sql.unsafe("INSERT INTO organizations(id,name,slug) VALUES ('legacy-org','Legacy','legacy')");
    await sql.unsafe("INSERT INTO incidents(id,organization_id,title,severity,status,creator_user_id,commander_user_id) VALUES ('invalid-legacy-incident','legacy-org','Legacy','SEV3','INVESTIGATING','outside-user','outside-user')");
    const source=await readFile(new URL('../packages/database/migrations/004_incident_command.sql',import.meta.url),'utf8');
    await assert.rejects(sql.begin(async(tx)=>{for(const statement of stripTransactionWrapper(splitSqlStatements(source)))await tx.unsafe(statement);}),/Cross-tenant legacy commanders on incidents: invalid-legacy-incident/);
    assert.equal((await sql.unsafe('SELECT commander_user_id FROM incidents'))[0].commander_user_id,'outside-user');
    assert.equal((await sql.unsafe("SELECT count(*)::int n FROM information_schema.columns WHERE table_name='incidents' AND column_name='revision'"))[0].n,0,'failed upgrade rolls back schema additions');
  }finally{await sql.end({timeout:5});await admin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`);await admin.end({timeout:5});}
});
