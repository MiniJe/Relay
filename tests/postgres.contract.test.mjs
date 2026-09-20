import test from 'node:test';
import assert from 'node:assert/strict';
import { createPostgresStore, migratePostgres } from '../packages/database/postgres-store.mjs';
import { hashPassword } from '../apps/api/src/security.mjs';

const databaseUrl=process.env.DATABASE_URL;
const expectedTables=[
  'alerts','component_services','components','incident_components','incident_responders','incident_services',
  'incident_timeline_events','incident_updates','incidents','integrations','organization_memberships','organizations',
  'postmortems','schema_migrations','services','sessions','status_page_components','status_pages','users'
];

test('PostgreSQL migration/store contract', {skip:!databaseUrl?'DATABASE_URL not available in this environment':false}, async()=>{
  const migration=await migratePostgres(databaseUrl);
  assert.ok(Array.isArray(migration.applied));
  const {default:postgres}=await import('postgres');
  const sql=postgres(databaseUrl,{max:1,connect_timeout:10});
  try{
    const tables=(await sql.unsafe(`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`)).map((r)=>r.tablename);
    for(const table of expectedTables)assert.ok(tables.includes(table),`expected migrated table ${table}`);
    const migrationRows=await sql.unsafe(`SELECT name FROM schema_migrations WHERE name='001_initial.sql'`);
    assert.equal(migrationRows.length,1,'001_initial.sql must be registered exactly once');

    const constraints=await sql.unsafe(`
      SELECT c.conname, pg_get_constraintdef(c.oid) AS definition
      FROM pg_constraint c
      JOIN pg_class t ON t.oid=c.conrelid
      JOIN pg_namespace n ON n.oid=t.relnamespace
      WHERE n.nspname='public'
        AND t.relname IN ('organization_memberships','incidents','services','components')
        AND c.contype='c'
    `);
    const definitions=constraints.map((r)=>String(r.definition));
    assert.ok(definitions.some((d)=>d.includes('OWNER')&&d.includes('ADMIN')&&d.includes('RESPONDER')&&d.includes('VIEWER')),'role CHECK constraint must exist');
    assert.ok(definitions.some((d)=>d.includes('SEV1')&&d.includes('SEV4')),'incident severity CHECK constraint must exist');
    assert.ok(definitions.some((d)=>d.includes('INVESTIGATING')&&d.includes('RESOLVED')),'incident lifecycle CHECK constraint must exist');
    assert.ok(definitions.filter((d)=>d.includes('OPERATIONAL')&&d.includes('MAJOR_OUTAGE')).length>=2,'service/component operational-state CHECK constraints must exist');
  } finally { await sql.end({timeout:5}); }

  const store=await createPostgresStore(databaseUrl);
  try{
    const marker=Date.now().toString(36);
    const user=await store.createUser({email:`pg-${marker}@example.com`,displayName:'PG Contract',passwordHash:await hashPassword('relay-password-123')});
    const org=await store.createOrganization({userId:user.id,name:`PG ${marker}`,slug:`pg-${marker}`});
    const service=await store.createService(org.id,{name:'API',slug:'api',description:'Contract test',operationalState:'OPERATIONAL'});
    const component=await store.createComponent(org.id,{name:'Public API',slug:'public-api',description:'',operationalState:'OPERATIONAL',serviceIds:[service.id]});
    const incident=await store.createIncident(org.id,{title:'Contract incident',summary:'',severity:'SEV4',creatorUserId:user.id,commanderUserId:user.id},[service.id],[component.id],{actorUserId:user.id,eventType:'INCIDENT_CREATED',message:'Incident created.',metadata:{}});
    assert.equal(incident.affectedServiceIds[0],service.id);
    assert.equal(incident.affectedComponentIds[0],component.id);
    assert.equal(incident.commanderUserId,user.id);
  } finally {await store.close()}
});
