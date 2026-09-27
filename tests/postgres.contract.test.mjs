import test from 'node:test';
import assert from 'node:assert/strict';
import { createPostgresStore, migratePostgres } from '../packages/database/postgres-store.mjs';
import { hashPassword } from '../apps/api/src/security.mjs';

const databaseUrl=process.env.DATABASE_URL;
const expectedTables=[
  'alert_routings','alert_routing_rules','alerts','component_services','components','discord_identities',
  'incident_components','incident_responders','incident_services','incident_timeline_events','incident_updates',
  'incidents','integrations','oncall_overrides','oncall_schedule_participants','oncall_schedules',
  'organization_memberships','organizations','postmortems','responder_team_members','responder_teams',
  'schema_migrations','services','sessions','status_page_components','status_pages','users'
];

test('PostgreSQL migration/store contract', {skip:!databaseUrl?'DATABASE_URL not available in this environment':false}, async()=>{
  const migration=await migratePostgres(databaseUrl);
  assert.ok(Array.isArray(migration.applied));
  const {default:postgres}=await import('postgres');
  const sql=postgres(databaseUrl,{max:1,connect_timeout:10});
  try{
    const tables=(await sql.unsafe(`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`)).map((r)=>r.tablename);
    for(const table of expectedTables)assert.ok(tables.includes(table),`expected migrated table ${table}`);
    for(const name of ['001_initial.sql','002_alert_routing_oncall.sql']){
      const migrationRows=await sql.unsafe(`SELECT name FROM schema_migrations WHERE name=$1`,[name]);
      assert.equal(migrationRows.length,1,`${name} must be registered exactly once`);
    }

    const constraints=await sql.unsafe(`
      SELECT c.conname, pg_get_constraintdef(c.oid) AS definition
      FROM pg_constraint c
      JOIN pg_class t ON t.oid=c.conrelid
      JOIN pg_namespace n ON n.oid=t.relnamespace
      WHERE n.nspname='public'
        AND t.relname IN ('organization_memberships','incidents','services','components','alert_routings','oncall_schedules','oncall_overrides','alert_routing_rules','discord_identities')
        AND c.contype='c'
    `);
    const definitions=constraints.map((r)=>String(r.definition));
    assert.ok(definitions.some((d)=>d.includes('OWNER')&&d.includes('ADMIN')&&d.includes('RESPONDER')&&d.includes('VIEWER')),'role CHECK constraint must exist');
    assert.ok(definitions.some((d)=>d.includes('SEV1')&&d.includes('SEV4')),'incident severity CHECK constraint must exist');
    assert.ok(definitions.some((d)=>d.includes('INVESTIGATING')&&d.includes('RESOLVED')),'incident lifecycle CHECK constraint must exist');
    assert.ok(definitions.filter((d)=>d.includes('OPERATIONAL')&&d.includes('MAJOR_OUTAGE')).length>=2,'service/component operational-state CHECK constraints must exist');
    // Relay 0.2 invariants enforced in the database itself.
    assert.ok(definitions.some((d)=>d.includes('PENDING')&&d.includes('NO_MATCHING_RULE')),'alert routing resolution CHECK constraint must exist');
    assert.ok(definitions.some((d)=>d.includes('SKIPPED_NO_INTEGRATION')),'alert routing notification-status CHECK constraint must exist');
    assert.ok(definitions.some((d)=>d.includes('ROTATION')&&d.includes('OVERRIDE')),'responder-source CHECK constraint must exist');
    assert.ok(definitions.some((d)=>d.includes('60')&&d.includes('525600')),'rotation interval bounds CHECK constraint must exist');
    assert.ok(definitions.some((d)=>d.includes('starts_at')&&d.includes('ends_at')),'override window ordering CHECK constraint must exist');
    assert.ok(definitions.some((d)=>d.includes('[0-9]{15,25}')),'Discord snowflake format CHECK constraint must exist');
    const routingUnique=await sql.unsafe(`
      SELECT conname FROM pg_constraint
      WHERE contype='u' AND conrelid='alert_routings'::regclass
        AND pg_get_constraintdef(oid) ~* 'alert_id'`);
    assert.ok(routingUnique.length>=1,'alert_routings must carry a UNIQUE constraint on alert_id so retries cannot duplicate a routing record');
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
    // Regression: jsonb parameters must be parsed exactly once, so timeline
    // metadata round-trips as a real object rather than a double-encoded string.
    assert.deepEqual(incident.timeline[0].metadata,{});
    assert.equal(typeof incident.timeline[0].metadata,'object');
    const page=await store.createStatusPage(org.id,{name:'Public Status',slug:`pg-status-${marker}`,isPublic:true,branding:{accent:'#3b82f6',logoUrl:''},componentIds:[component.id]});
    assert.deepEqual(page.branding,{accent:'#3b82f6',logoUrl:''});
    const withPostmortem=await store.upsertPostmortem(org.id,incident.id,{title:'Review',summary:'',impact:'',rootCause:'',resolution:'',followUpActions:['Add a regression test']},user.id);
    assert.deepEqual(withPostmortem.postmortem.followUpActions,['Add a regression test']);
  } finally {await store.close()}
});

/**
 * Relay 0.2 store contract — teams, schedules, overrides, routing rules,
 * alert ingestion, routing records, acknowledgement and Discord mapping,
 * exercised against real PostgreSQL rather than the in-memory store.
 */
test('PostgreSQL Relay 0.2 alert routing and on-call store contract', {skip:!databaseUrl?'DATABASE_URL not available in this environment':false}, async()=>{
  await migratePostgres(databaseUrl);
  const {default:postgres}=await import('postgres');
  const sql=postgres(databaseUrl,{max:4,connect_timeout:10});
  const store=await createPostgresStore(databaseUrl);
  const marker=Date.now().toString(36)+Math.random().toString(36).slice(2,7);
  try{
    const hash=await hashPassword('relay-password-123');
    const mkUser=async(label)=>store.createUser({email:`pg2-${marker}-${label}@example.com`,displayName:label,passwordHash:hash});
    const owner=await mkUser('Owner');
    const ada=await mkUser('Ada');
    const grace=await mkUser('Grace');
    const outsider=await mkUser('Outsider');
    const org=await store.createOrganization({userId:owner.id,name:`PG2 ${marker}`,slug:`pg2-${marker}`});
    const other=await store.createOrganization({userId:outsider.id,name:`PG2 Other ${marker}`,slug:`pg2-other-${marker}`});

    // Relay 0.1 has no invitation API, so additional memberships are written
    // directly — the store contract cares about what happens after they exist.
    for(const [userId,role] of [[ada.id,'RESPONDER'],[grace.id,'RESPONDER']]){
      await sql.unsafe(`INSERT INTO organization_memberships(organization_id,user_id,role) VALUES($1,$2,$3)`,[org.id,userId,role]);
    }

    // ---- responder teams -------------------------------------------------
    const team=await store.createTeam(org.id,{name:'Core Platform',slug:'core-platform',description:'Owns checkout'});
    assert.equal(team.organizationId,org.id);
    assert.equal(team.slug,'core-platform');
    assert.equal((await store.listTeams(org.id)).length,1);
    assert.equal((await store.getTeam(org.id,team.id)).members.length,0);
    assert.equal(await store.addTeamMember(org.id,team.id,owner.id),true);
    assert.equal(await store.addTeamMember(org.id,team.id,ada.id),true);
    assert.equal(await store.addTeamMember(org.id,team.id,grace.id),true);
    assert.equal(await store.addTeamMember(org.id,team.id,ada.id),false,'adding an existing member is an idempotent no-op');
    assert.equal(await store.addTeamMember(org.id,team.id,outsider.id),false,'a user outside the organization can never join a team');
    const members=(await store.getTeam(org.id,team.id)).members;
    assert.equal(members.length,3);
    assert.ok(members.some((m)=>m.userId===ada.id&&m.role==='RESPONDER'));

    // ---- on-call schedules ------------------------------------------------
    const rotationStartsAt=new Date(Date.now()-3600_000).toISOString();
    await assert.rejects(
      ()=>store.createSchedule(org.id,{name:'Bad roster',teamId:team.id,timeZone:'UTC',rotationStartsAt,rotationIntervalMinutes:1440,participantUserIds:[outsider.id]}),
      (error)=>error.code==='INVALID_PARTICIPANT','a rotation participant must be a team member');
    const schedule=await store.createSchedule(org.id,{name:'Primary on-call',teamId:team.id,timeZone:'Europe/Bucharest',rotationStartsAt,rotationIntervalMinutes:1440,participantUserIds:[ada.id,grace.id]});
    assert.equal(schedule.teamName,'Core Platform');
    assert.deepEqual(schedule.participants.map((p)=>p.userId),[ada.id,grace.id],'participants keep the configured rotation order');
    assert.deepEqual(schedule.participants.map((p)=>p.position),[0,1]);
    const reordered=await store.updateSchedule(org.id,schedule.id,{participantUserIds:[grace.id,ada.id]});
    assert.deepEqual(reordered.participants.map((p)=>p.userId),[grace.id,ada.id]);
    await store.updateSchedule(org.id,schedule.id,{participantUserIds:[ada.id,grace.id]});
    assert.equal((await store.listSchedules(org.id))[0].participants.length,2);

    // ---- overrides --------------------------------------------------------
    const starts=new Date(Date.now()+3600_000).toISOString();
    const ends=new Date(Date.now()+7200_000).toISOString();
    const overlap=await store.createOverride(org.id,schedule.id,{replacementUserId:grace.id,startsAt:new Date(Date.now()+1800_000).toISOString(),endsAt:ends,reason:'Conference'},owner.id);
    assert.equal(overlap.replacementUserId,grace.id);
    await assert.rejects(
      ()=>store.createOverride(org.id,schedule.id,{replacementUserId:ada.id,startsAt:starts,endsAt:ends,reason:'Clash'},owner.id),
      (error)=>error.code==='OVERRIDE_OVERLAP','overlapping overrides are refused deterministically');
    assert.equal(await store.deleteOverride(org.id,overlap.id),true);
    assert.equal(await store.deleteOverride(org.id,overlap.id),false);

    // ---- routing rules ----------------------------------------------------
    const later=await store.createRoutingRule(org.id,{name:'Catch all',priority:900,targetScheduleId:schedule.id});
    const first=await store.createRoutingRule(org.id,{name:'Checkout criticals',priority:10,matchServiceId:null,matchSource:'synthetic-monitor',matchSeverities:['critical'],targetScheduleId:schedule.id});
    assert.deepEqual((await store.listRoutingRules(org.id)).map((r)=>r.name),['Checkout criticals','Catch all'],'rules are ordered by explicit priority');
    assert.equal(first.scheduleName,'Primary on-call');
    assert.deepEqual(first.matchSeverities,['critical'],'rule severity conditions are stored as a real jsonb array');
    assert.deepEqual((await sql.unsafe(`SELECT jsonb_typeof(match_severities) AS t FROM alert_routing_rules WHERE id=$1`,[first.id])).map((r)=>r.t),['array']);
    assert.equal((await store.updateRoutingRule(org.id,later.id,{priority:1})).priority,1);
    assert.deepEqual((await store.listRoutingRules(org.id)).map((r)=>r.name),['Catch all','Checkout criticals']);
    await store.updateRoutingRule(org.id,later.id,{priority:900});

    // ---- alert ingestion, idempotency and routing --------------------------
    const service=await store.createService(org.id,{name:'Checkout API',slug:`checkout-${marker}`,description:'',operationalState:'OPERATIONAL'});
    const firstIngest=await store.ingestAlert(org.id,{source:'synthetic-monitor',externalId:`ext-${marker}`,title:'Checkout p95 latency',description:'',severity:'critical',serviceId:service.id,metadata:{region:'eu'},observedAt:new Date().toISOString()});
    assert.equal(firstIngest.created,true);
    assert.deepEqual(firstIngest.alert.metadata,{region:'eu'},'alert metadata is stored as real jsonb, not a double-encoded string');
    assert.equal(firstIngest.routing.resolution,'PENDING','the routing record is created in the same transaction as the alert');
    const replay=await store.ingestAlert(org.id,{source:'synthetic-monitor',externalId:`ext-${marker}`,title:'Checkout p95 latency',severity:'critical',serviceId:service.id,metadata:{},observedAt:new Date().toISOString()});
    assert.equal(replay.created,false);
    assert.equal(replay.alert.id,firstIngest.alert.id,'an idempotent retry resolves to the original alert');
    assert.equal(replay.routing.id,firstIngest.routing.id,'and never creates a second routing record');

    const alertId=firstIngest.alert.id;
    const routed=await store.recordAlertRouting(org.id,alertId,{ruleId:first.id,ruleName:'Checkout criticals',scheduleId:schedule.id,scheduleName:'Primary on-call',teamId:team.id,teamName:'Core Platform',oncallUserId:ada.id,oncallDisplayName:'Ada',responderSource:'ROTATION',resolution:'ROUTED',periodStartsAt:rotationStartsAt,periodEndsAt:new Date(Date.now()+86_400_000).toISOString()});
    assert.equal(routed.resolution,'ROUTED');
    assert.equal(routed.oncallUserId,ada.id);
    await store.recordRoutingNotification(org.id,alertId,{status:'SENT',provider:'DISCORD',notifiedAt:new Date().toISOString(),discordUserId:'223344556677889900'});

    // A retry storm must not duplicate the routing audit record.
    await Promise.all(Array.from({length:8},()=>store.recordAlertRouting(org.id,alertId,{ruleId:first.id,ruleName:'Checkout criticals',scheduleId:schedule.id,scheduleName:'Primary on-call',teamId:team.id,teamName:'Core Platform',oncallUserId:ada.id,oncallDisplayName:'Ada',responderSource:'ROTATION',resolution:'ROUTED'})));
    const routingRows=await sql.unsafe(`SELECT count(*)::int AS n FROM alert_routings WHERE alert_id=$1`,[alertId]);
    assert.equal(routingRows[0].n,1,'exactly one routing record survives concurrent re-evaluation');

    const persisted=await store.getAlertRouting(org.id,alertId);
    assert.equal(persisted.resolution,'ROUTED');
    assert.equal(persisted.notificationStatus,'SENT');
    assert.equal(persisted.discordUserId,'223344556677889900');
    assert.equal(persisted.alertTitle,'Checkout p95 latency');

    // ---- acknowledgement --------------------------------------------------
    const ack=await store.acknowledgeAlertRouting(org.id,alertId,{userId:grace.id,displayName:'Grace'});
    assert.equal(ack.alreadyAcknowledged,false);
    assert.equal(ack.routing.acknowledgedByUserId,grace.id);
    const again=await store.acknowledgeAlertRouting(org.id,alertId,{userId:ada.id,displayName:'Ada'});
    assert.equal(again.alreadyAcknowledged,true,'re-acknowledging is idempotent and does not change the record');
    assert.equal(again.routing.acknowledgedByUserId,grace.id,'the first responder to acknowledge keeps the acknowledgement');
    const secondAlert=await store.ingestAlert(org.id,{source:'synthetic-monitor',externalId:`ext2-${marker}`,title:'Second alert',severity:'warning',observedAt:new Date().toISOString()});
    await store.recordAlertRouting(org.id,secondAlert.alert.id,{resolution:'ROUTED',oncallUserId:ada.id,scheduleId:schedule.id,scheduleName:'Primary on-call'});
    const raced=await Promise.all(Array.from({length:6},()=>store.acknowledgeAlertRouting(org.id,secondAlert.alert.id,{userId:ada.id,displayName:'Ada'})));
    assert.equal(raced.filter((r)=>r.alreadyAcknowledged===false).length,1,'exactly one concurrent acknowledgement wins');

    // ---- alert -> incident linkage ---------------------------------------
    const incident=await store.createIncident(org.id,{title:'From alert',summary:'',severity:'SEV3',creatorUserId:owner.id,commanderUserId:owner.id},[service.id],[],{actorUserId:owner.id,eventType:'INCIDENT_CREATED',message:'Escalated from an alert.',metadata:{sourceAlertId:alertId}});
    assert.equal((await store.linkRoutingIncident(org.id,alertId,incident.id)).incidentId,incident.id);
    assert.equal((await store.getAlertRouting(org.id,alertId)).incidentId,incident.id);

    // ---- Discord identity mapping ----------------------------------------
    const identity=await store.upsertDiscordIdentity(org.id,ada.id,'223344556677889900');
    assert.equal(identity.discordUserId,'223344556677889900');
    const replaced=await store.upsertDiscordIdentity(org.id,ada.id,'223344556677889901');
    assert.equal(replaced.id,identity.id,'mapping is unique per organization and user');
    assert.equal(replaced.discordUserId,'223344556677889901');
    assert.equal((await store.listDiscordIdentities(org.id)).find((d)=>d.userId===ada.id).displayName,'Ada');
    await assert.rejects(()=>store.upsertDiscordIdentity(org.id,outsider.id,'223344556677889900'),(error)=>error.code==='INVALID_REFERENCE');
    await assert.rejects(()=>store.upsertDiscordIdentity(org.id,ada.id,'not-a-snowflake'),(error)=>error.code==='23514','the database rejects a malformed Discord snowflake even if the API layer is bypassed');
    assert.equal(await store.deleteDiscordIdentity(org.id,ada.id),true);
    assert.equal(await store.getDiscordIdentity(org.id,ada.id),undefined);

    // ---- historical immutability ------------------------------------------
    await store.updateSchedule(org.id,schedule.id,{name:'Renamed schedule'});
    await store.updateTeam(org.id,team.id,{name:'Renamed team'});
    assert.equal(await store.deleteRoutingRule(org.id,first.id),true);
    const historical=await store.getAlertRouting(org.id,alertId);
    assert.equal(historical.scheduleName,'Primary on-call','the audit record keeps the name that was in effect');
    assert.equal(historical.teamName,'Core Platform');
    assert.equal(historical.ruleName,'Checkout criticals');
    assert.equal(historical.ruleId,null,'the dangling rule reference is nulled without erasing the record');

    // ---- a Relay 0.1 alert row reports no routing decision ----------------
    await sql.unsafe(`INSERT INTO alerts(id,organization_id,source,external_id,title,description,severity,metadata,observed_at)
      VALUES($1,$2,'legacy-monitor',$3,'Legacy alert','','critical','{}'::jsonb,now())`,[`legacy-${marker}`,org.id,`legacy-${marker}`]);
    const listed=await store.listAlertsWithRouting(org.id);
    const legacyRow=listed.find((a)=>a.id===`legacy-${marker}`);
    assert.equal(legacyRow.routing,null);
    assert.equal(listed.find((a)=>a.id===alertId).serviceName,'Checkout API');
    assert.equal(listed.find((a)=>a.id===alertId).routing.resolution,'ROUTED');

    // ---- tenant isolation at the store layer ------------------------------
    assert.equal(await store.getTeam(other.id,team.id),undefined);
    assert.equal(await store.getSchedule(other.id,schedule.id),undefined);
    assert.equal(await store.getRoutingRule(other.id,later.id),undefined);
    assert.equal(await store.getAlert(other.id,alertId),undefined);
    assert.equal(await store.getAlertRouting(other.id,alertId),undefined);
    assert.equal((await store.listAlertsWithRouting(other.id)).length,0);
    assert.equal((await store.listTeams(other.id)).length,0);
    assert.equal((await store.listSchedules(other.id)).length,0);
    assert.equal((await store.listRoutingRules(other.id)).length,0);
    assert.equal(await store.addTeamMember(other.id,team.id,outsider.id),false);
    assert.equal(await store.removeTeamMember(other.id,team.id,ada.id),false,'another organization cannot mutate this team roster');
    assert.equal(await store.deleteRoutingRule(other.id,later.id),false);
    assert.equal(await store.acknowledgeAlertRouting(other.id,alertId,{userId:outsider.id,displayName:'Outsider'}),undefined,'another organization cannot acknowledge this alert');
    await assert.rejects(()=>store.createOverride(other.id,schedule.id,{replacementUserId:outsider.id,startsAt:new Date(Date.now()+60_000).toISOString(),endsAt:new Date(Date.now()+120_000).toISOString()},outsider.id),(error)=>error.code==='SCHEDULE_NOT_FOUND','another organization cannot see or modify this schedule');
  } finally {
    await store.close();
    await sql.end({timeout:5});
  }
});
