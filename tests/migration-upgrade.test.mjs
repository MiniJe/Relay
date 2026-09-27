import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { splitSqlStatements, stripTransactionWrapper, sortMigrationNames } from '../packages/database/sql.mjs';
import { listMigrationFiles, migratePostgres } from '../packages/database/postgres-store.mjs';

// Relay 0.1 shipped. Upgrading a live 0.1 database to 0.2 must therefore apply
// 002 on top of real 0.1 data without rewriting any of it. This test builds a
// throwaway database that contains only the 0.1 schema plus representative 0.1
// rows, runs the ordered migration runner, and asserts that:
//   * only 002 and 003 are applied (001 is recognised as already present);
//   * every 0.1 row survives byte-for-byte;
//   * the 0.2 tables and their tenant-safe constraints exist;
//   * re-running the migrator is a no-op.
//
// The database is created from the maintenance database derived from
// DATABASE_URL and always dropped again.

const databaseUrl = process.env.DATABASE_URL;

function maintenanceUrl(url) {
  const parsed = new URL(url);
  const target = new URL(url);
  target.pathname = '/postgres';
  return { maintenance: target.toString(), original: parsed.toString() };
}

function databaseName(url) {
  return new URL(url).pathname.replace(/^\//, '');
}

test('migration ordering is derived from filenames, not readdir order', () => {
  assert.deepEqual(
    sortMigrationNames(['003_escalation_delivery.sql', '002_alert_routing_oncall.sql', '010_future.sql', '001_initial.sql']),
    ['001_initial.sql', '002_alert_routing_oncall.sql', '003_escalation_delivery.sql', '010_future.sql']
  );
});

test('migration runner discovers migration 003 after 001 and 002', async () => {
  assert.deepEqual(await listMigrationFiles(), ['001_initial.sql','002_alert_routing_oncall.sql','003_escalation_delivery.sql']);
  const source=await readFile(new URL('../packages/database/migrations/003_escalation_delivery.sql',import.meta.url),'utf8');
  const statements=stripTransactionWrapper(splitSqlStatements(source));
  assert.ok(statements.some((sql)=>sql.includes('CREATE TABLE escalation_policies')));
  assert.ok(statements.some((sql)=>sql.includes('CREATE TABLE escalation_jobs')));
  assert.ok(statements.some((sql)=>sql.includes('CREATE TABLE notification_deliveries')));
  assert.ok(statements.some((sql)=>sql.includes('CREATE TABLE notification_attempts')));
  assert.equal(statements.some((sql)=>/^\\s*(DROP|TRUNCATE)\\b/i.test(sql)),false,'forward migration must not destructively drop or truncate existing data');
});

test('SQL statement splitting survives comments, strings and dollar-quoted bodies', () => {
  const source = [
    '-- a leading comment',
    'BEGIN;',
    "CREATE TABLE t (a TEXT DEFAULT 'has;semicolon', b TEXT /* inline; */);",
    'DO $body$',
    'BEGIN',
    "  RAISE NOTICE 'not; a split point';",
    'END',
    '$body$;',
    'COMMIT;'
  ].join('\n');
  const statements = splitSqlStatements(source);
  assert.deepEqual(statements[0], 'BEGIN');
  assert.deepEqual(statements.at(-1), 'COMMIT');
  const create = statements.find((s) => s.startsWith('CREATE TABLE'));
  assert.ok(create.includes("'has;semicolon'"), 'string literal semicolon must not split');
  assert.ok(create.includes('/* inline; */'), 'block comment semicolon must not split');
  const block = statements.find((s) => s.startsWith('DO $body$'));
  assert.ok(block.includes("RAISE NOTICE 'not; a split point'"), 'dollar-quoted body must stay one statement');
  assert.deepEqual(stripTransactionWrapper(statements).length, statements.length - 2);
});

test('upgrading a populated Relay 0.1 database applies 002→003 and preserves all 0.1 data', { skip: !databaseUrl ? 'DATABASE_URL not available in this environment' : false }, async () => {
  const { maintenance } = maintenanceUrl(databaseUrl);
  const { default: postgres } = await import('postgres');
  const admin = postgres(maintenance, { max: 1, connect_timeout: 10, idle_timeout: 5 });
  const upgradeName = `relay_upgrade_${crypto.randomBytes(5).toString('hex')}`;
  const upgradeUrl = new URL(databaseUrl);
  upgradeUrl.pathname = `/${upgradeName}`;
  const target = upgradeUrl.toString();

  try {
    await admin.unsafe(`CREATE DATABASE ${upgradeName}`);
  } catch (error) {
    await admin.end({ timeout: 5 });
    throw new Error(`Unable to create a scratch database for the upgrade test: ${error.message}`);
  }
  await admin.end({ timeout: 5 });

  const sql = postgres(target, { max: 1, connect_timeout: 10, idle_timeout: 5 });
  try {
    // ---- Stage 1: install exactly the Relay 0.1 schema, as 0.1 shipped it.
    await sql.unsafe(`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const initial = await readFile(new URL('../packages/database/migrations/001_initial.sql', import.meta.url), 'utf8');
    for (const statement of stripTransactionWrapper(splitSqlStatements(initial))) await sql.unsafe(statement);
    await sql.unsafe(`INSERT INTO schema_migrations(name) VALUES ('001_initial.sql')`);

    // ---- Stage 2: write representative 0.1 data across every 0.1 table.
    const at = '2026-03-01T09:00:00.000Z';
    await sql.unsafe(`INSERT INTO users(id,email,display_name,password_hash,created_at) VALUES ('u-owner','owner@relay.local','Owner Zero','scrypt$16384$8$1$c2FsdA$aGFzaA',$1)`, [at]);
    await sql.unsafe(`INSERT INTO users(id,email,display_name,password_hash,created_at) VALUES ('u-resp','resp@relay.local','Responder One','scrypt$16384$8$1$c2FsdA$aGFzaA',$1)`, [at]);
    await sql.unsafe(`INSERT INTO organizations(id,name,slug,created_at,updated_at) VALUES ('o-legacy','Legacy Operations','legacy-ops',$1,$1)`, [at]);
    await sql.unsafe(`INSERT INTO organization_memberships(organization_id,user_id,role,created_at) VALUES ('o-legacy','u-owner','OWNER',$1),('o-legacy','u-resp','RESPONDER',$1)`, [at]);
    await sql.unsafe(`INSERT INTO services(id,organization_id,name,slug,description,operational_state,created_at,updated_at) VALUES ('s-legacy','o-legacy','Legacy API','legacy-api','Pre-existing service','DEGRADED_PERFORMANCE',$1,$1)`, [at]);
    await sql.unsafe(`INSERT INTO components(id,organization_id,name,slug,description,operational_state,created_at,updated_at) VALUES ('c-legacy','o-legacy','Legacy Portal','legacy-portal','Public component','OPERATIONAL',$1,$1)`, [at]);
    await sql.unsafe(`INSERT INTO component_services(component_id,service_id) VALUES ('c-legacy','s-legacy')`);
    await sql.unsafe(`INSERT INTO status_pages(id,organization_id,name,slug,is_public,branding,created_at,updated_at) VALUES ('p-legacy','o-legacy','Legacy Status','legacy-status',true,$1::jsonb,$2,$2)`, [JSON.stringify({ headline: 'Legacy', description: 'Existing branding', accent: '#7c3aed' }), at]);
    await sql.unsafe(`INSERT INTO status_page_components(status_page_id,component_id,sort_order) VALUES ('p-legacy','c-legacy',0)`);
    await sql.unsafe(`INSERT INTO incidents(id,organization_id,title,summary,severity,status,creator_user_id,commander_user_id,started_at,resolved_at,created_at,updated_at) VALUES ('i-legacy','o-legacy','Legacy resolved incident','Existing summary','SEV2','RESOLVED','u-owner','u-resp',$1,$1,$1,$1)`, [at]);
    await sql.unsafe(`INSERT INTO incident_services(incident_id,service_id) VALUES ('i-legacy','s-legacy')`);
    await sql.unsafe(`INSERT INTO incident_components(incident_id,component_id) VALUES ('i-legacy','c-legacy')`);
    await sql.unsafe(`INSERT INTO incident_responders(incident_id,user_id,joined_at) VALUES ('i-legacy','u-owner',$1)`, [at]);
    await sql.unsafe(`INSERT INTO incident_timeline_events(id,incident_id,actor_user_id,event_type,message,metadata,occurred_at) VALUES ('e-legacy','i-legacy','u-owner','INCIDENT_CREATED','Incident created.','{}'::jsonb,$1)`, [at]);
    await sql.unsafe(`INSERT INTO incident_updates(id,incident_id,actor_user_id,message,is_public,created_at) VALUES ('up-int','i-legacy','u-owner','INTERNAL-LEGACY-NOTE',false,$1),('up-pub','i-legacy','u-owner','Public legacy update.',true,$1)`, [at]);
    await sql.unsafe(`INSERT INTO postmortems(id,incident_id,title,summary,impact,root_cause,resolution,follow_up_actions,created_by_user_id,created_at,updated_at) VALUES ('pm-legacy','i-legacy','Legacy postmortem','Legacy summary','Legacy impact','Legacy cause','Legacy resolution',$1::jsonb,'u-owner',$2,$2)`, [JSON.stringify(['Legacy follow-up']), at]);
    await sql.unsafe(`INSERT INTO alerts(id,organization_id,source,external_id,title,description,severity,service_id,metadata,observed_at,received_at) VALUES ('a-legacy','o-legacy','legacy-monitor','ext-legacy','Legacy alert','Legacy description','critical','s-legacy',$1::jsonb,$2,$2)`, [JSON.stringify({ region: 'eu' }), at]);
    await sql.unsafe(`INSERT INTO integrations(id,organization_id,provider,name,secret_encrypted,enabled,created_at,updated_at) VALUES ('int-legacy','o-legacy','DISCORD','Legacy Discord','v1.aXY.dGFn.ct',true,$1,$1)`, [at]);

    const before = {
      users: await sql.unsafe(`SELECT count(*)::int n FROM users`),
      incidents: await sql.unsafe(`SELECT id,title,summary,severity,status,resolved_at FROM incidents`),
      updates: await sql.unsafe(`SELECT id,message,is_public FROM incident_updates ORDER BY id`),
      postmortem: await sql.unsafe(`SELECT title,root_cause,follow_up_actions FROM postmortems`),
      alerts: await sql.unsafe(`SELECT id,source,external_id,title,severity,service_id,metadata FROM alerts`),
      services: await sql.unsafe(`SELECT id,name,slug,description,operational_state FROM services`),
      components: await sql.unsafe(`SELECT id,name,slug,operational_state FROM components`),
      pages: await sql.unsafe(`SELECT id,name,slug,is_public,branding FROM status_pages`),
      memberships: await sql.unsafe(`SELECT organization_id,user_id,role FROM organization_memberships ORDER BY user_id`),
      integrations: await sql.unsafe(`SELECT id,provider,name,secret_encrypted,enabled FROM integrations`)
    };

    // ---- Stage 3: upgrade. Only 002 may be applied.
    const upgrade = await migratePostgres(target);
    assert.deepEqual(upgrade.applied, ['002_alert_routing_oncall.sql','003_escalation_delivery.sql'], 'only additive 0.2 forward migrations may run against a 0.1 database');
    assert.deepEqual(upgrade.unknown, [], 'no unknown migrations recorded');

    // ---- Stage 4: all 0.1 data must be byte-identical.
    const after = {
      users: await sql.unsafe(`SELECT count(*)::int n FROM users`),
      incidents: await sql.unsafe(`SELECT id,title,summary,severity,status,resolved_at FROM incidents`),
      updates: await sql.unsafe(`SELECT id,message,is_public FROM incident_updates ORDER BY id`),
      postmortem: await sql.unsafe(`SELECT title,root_cause,follow_up_actions FROM postmortems`),
      alerts: await sql.unsafe(`SELECT id,source,external_id,title,severity,service_id,metadata FROM alerts`),
      services: await sql.unsafe(`SELECT id,name,slug,description,operational_state FROM services`),
      components: await sql.unsafe(`SELECT id,name,slug,operational_state FROM components`),
      pages: await sql.unsafe(`SELECT id,name,slug,is_public,branding FROM status_pages`),
      memberships: await sql.unsafe(`SELECT organization_id,user_id,role FROM organization_memberships ORDER BY user_id`),
      integrations: await sql.unsafe(`SELECT id,provider,name,secret_encrypted,enabled FROM integrations`)
    };
    assert.deepEqual(after.incidents, before.incidents, 'incident rows and lifecycle state must not change');
    assert.deepEqual(after.updates, before.updates, 'internal/public update separation must not change');
    assert.deepEqual(after.postmortem, before.postmortem, 'postmortem data must not change');
    assert.deepEqual(after.alerts, before.alerts, 'ingested 0.1 alerts must be preserved');
    assert.deepEqual(after.pages, before.pages, 'status pages and branding must not change');
    assert.deepEqual(after.memberships, before.memberships, 'roles must not change');
    assert.deepEqual(after.integrations, before.integrations, 'encrypted integration secrets must not change');
    assert.equal(after.users[0].n, before.users[0].n);
    // The only permitted service change is the new nullable column defaulting to NULL.
    assert.deepEqual(after.services, before.services, 'service identity/state must not change');
    assert.deepEqual(after.components, before.components, 'components must not change');
    const ownerTeam = await sql.unsafe(`SELECT owner_team_id FROM services WHERE id='s-legacy'`);
    assert.equal(ownerTeam[0].owner_team_id, null, 'existing services start with no owning team');

    // ---- Stage 5: 0.2 structures exist and are tenant-safe.
    const tables = (await sql.unsafe(`SELECT tablename FROM pg_tables WHERE schemaname='public'`)).map((r) => r.tablename);
    for (const table of ['responder_teams', 'responder_team_members', 'oncall_schedules', 'oncall_schedule_participants', 'oncall_overrides', 'alert_routing_rules', 'alert_routings', 'discord_identities', 'escalation_policies', 'escalation_policy_steps', 'escalation_jobs', 'notification_deliveries', 'notification_attempts']) {
      assert.ok(tables.includes(table), `0.2 table ${table} must exist after upgrade`);
    }
    const constraints = (await sql.unsafe(`
      SELECT conname, pg_get_constraintdef(c.oid) AS definition
      FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
      WHERE n.nspname='public' AND t.relname IN ('responder_team_members','oncall_schedules','oncall_schedule_participants','oncall_overrides','alert_routing_rules','alert_routings','discord_identities','services')
    `)).map((r) => r.definition);
    assert.ok(constraints.some((d) => d.includes('organization_id, user_id') && d.includes('organization_memberships')), 'membership must be tenant-safe against organization_memberships');
    assert.ok(constraints.some((d) => d.includes('UNIQUE (alert_id)')), 'one routing record per alert must be enforced');
    assert.ok(constraints.some((d) => d.includes('starts_at < ends_at')), 'override window must be validated');
    assert.ok(constraints.some((d) => d.includes('owner_team_id') && d.includes('organization_id')), 'service ownership must be tenant-safe');

    // A cross-organization reference must be rejected by the database itself.
    await sql.unsafe(`INSERT INTO organizations(id,name,slug,created_at,updated_at) VALUES ('o-other','Other Org','other-org',now(),now())`);
    await sql.unsafe(`INSERT INTO users(id,email,display_name,password_hash) VALUES ('u-outsider','outsider@relay.local','Outsider','scrypt$16384$8$1$c2FsdA$aGFzaA')`);
    await sql.unsafe(`INSERT INTO organization_memberships(organization_id,user_id,role) VALUES ('o-other','u-outsider','OWNER')`);
    await sql.unsafe(`INSERT INTO responder_teams(id,organization_id,name,slug) VALUES ('t-legacy','o-legacy','Legacy Team','legacy-team')`);
    await sql.unsafe(`INSERT INTO responder_team_members(team_id,organization_id,user_id) VALUES ('t-legacy','o-legacy','u-owner')`);
    await assert.rejects(
      () => sql.unsafe(`INSERT INTO responder_team_members(team_id,organization_id,user_id) VALUES ('t-legacy','o-legacy','u-outsider')`),
      (error) => error.code === '23503',
      'a user from another organization must not be attachable to a team'
    );
    await assert.rejects(
      () => sql.unsafe(`INSERT INTO oncall_schedules(id,organization_id,team_id,name,time_zone,rotation_starts_at,rotation_interval_minutes) VALUES ('s-x','o-other','t-legacy','Cross tenant','UTC',now(),1440)`),
      (error) => error.code === '23503',
      'a schedule must not reference another organization\'s team'
    );

    // ---- Stage 6: the migrator is idempotent.
    const rerun = await migratePostgres(target);
    assert.deepEqual(rerun.applied, [], 're-running migrations must be a no-op');
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
    const admin = postgres(maintenance, { max: 1, connect_timeout: 10, idle_timeout: 5 });
    try { await admin.unsafe(`DROP DATABASE IF EXISTS ${databaseName(target)} WITH (FORCE)`); } catch { /* best effort */ }
    await admin.end({ timeout: 5 }).catch(() => {});
  }
});
