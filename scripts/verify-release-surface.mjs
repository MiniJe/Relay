// Release surface verification.
//
// Points at a running Relay deployment and asserts that the *published* surface
// agrees with the source tree: the reported version, the OpenAPI document's
// Relay 0.2 paths and schemas, and the shipped UI bundle's routes.
//
// This exists because a version bump, a new endpoint or a new UI route can each
// be committed without the others, and none of the unit tests would notice.
//
//   RELAY_VERIFY_BASE_URL  deployment to inspect (default http://127.0.0.1:4000)

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { RELAY_VERSION } from '../packages/shared/version.mjs';

const baseUrl = (process.env.RELAY_VERIFY_BASE_URL ?? 'http://127.0.0.1:4000').replace(/\/$/, '');

/** Every Relay 0.2 path the OpenAPI document must describe. */
const requiredPaths = [
  '/alerts',
  '/organizations/{organizationId}/members',
  '/organizations/{organizationId}/teams',
  '/organizations/{organizationId}/teams/{teamId}',
  '/organizations/{organizationId}/teams/{teamId}/members',
  '/organizations/{organizationId}/teams/{teamId}/members/{userId}',
  '/organizations/{organizationId}/oncall/state',
  '/organizations/{organizationId}/oncall/schedules',
  '/organizations/{organizationId}/oncall/schedules/{scheduleId}',
  '/organizations/{organizationId}/oncall/schedules/{scheduleId}/oncall',
  '/organizations/{organizationId}/oncall/schedules/{scheduleId}/overrides',
  '/organizations/{organizationId}/oncall/overrides/{overrideId}',
  '/organizations/{organizationId}/routing-rules',
  '/organizations/{organizationId}/routing-rules/{ruleId}',
  '/organizations/{organizationId}/escalation-policies',
  '/organizations/{organizationId}/escalation-policies/{policyId}',
  '/organizations/{organizationId}/alerts',
  '/organizations/{organizationId}/alerts/{alertId}',
  '/organizations/{organizationId}/alerts/{alertId}/routing',
  '/organizations/{organizationId}/alerts/{alertId}/acknowledge',
  '/organizations/{organizationId}/alerts/{alertId}/route',
  '/organizations/{organizationId}/alerts/{alertId}/incidents',
  '/organizations/{organizationId}/routings',
  '/organizations/{organizationId}/discord-identities',
  '/organizations/{organizationId}/discord-identities/{userId}'
];

const requiredSchemas = ['AlertIntake', 'AlertRouting', 'ScheduleInput', 'OverrideInput', 'RoutingRuleInput', 'EscalationPolicyInput'];

/** Routes the shipped SPA must handle for the Relay 0.2 surfaces. */
const requiredUiRoutes = ['/app/alerts', '/app/oncall', '/app/teams', '/app/routing'];

/** Strings that must never appear in a shipped asset or a public response. */
const forbiddenInBundle = ['discord.com/api/webhooks/1', 'INTEGRATION_ENCRYPTION_KEY=', 'x-relay-alert-key: relay'];

async function getJson(path) {
  const res = await fetch(`${baseUrl}${path}`);
  assert.equal(res.status, 200, `GET ${path} must return 200, got ${res.status}`);
  return res.json();
}

async function getText(path) {
  const res = await fetch(`${baseUrl}${path}`);
  assert.equal(res.status, 200, `GET ${path} must return 200, got ${res.status}`);
  return res.text();
}

const health = await getJson('/api/v1/health');
assert.equal(health.ok, true, 'health must report ok=true');
assert.equal(health.version, RELAY_VERSION, `health reports ${health.version} but the source tree declares ${RELAY_VERSION}`);

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
assert.equal(manifest.version, RELAY_VERSION, `package.json is ${manifest.version} but RELAY_VERSION is ${RELAY_VERSION}`);

const spec = await getJson('/api/v1/openapi.json');
assert.match(spec.openapi, /^3\./, 'the specification must be OpenAPI 3.x');
assert.equal(spec.info.version, RELAY_VERSION, `the OpenAPI document reports ${spec.info.version}`);
for (const path of requiredPaths) assert.ok(spec.paths[path], `the OpenAPI document must describe ${path}`);
for (const schema of requiredSchemas) assert.ok(spec.components.schemas[schema], `the OpenAPI document must define the ${schema} schema`);
assert.deepEqual(
  spec.components.schemas.AlertRouting.properties.resolution.enum.slice().sort(),
  ['NO_MATCHING_RULE', 'NO_PARTICIPANTS', 'PENDING', 'ROTATION_NOT_STARTED', 'ROUTED', 'RULE_TARGET_MISSING', 'SCHEDULE_DISABLED', 'SCHEDULE_MISSING'],
  'the documented routing resolutions must match the database CHECK constraint'
);
assert.deepEqual(
  spec.components.schemas.AlertRouting.properties.notificationStatus.enum.slice().sort(),
  ['FAILED', 'NOT_ATTEMPTED', 'SENT', 'SKIPPED_DISABLED', 'SKIPPED_NO_INTEGRATION', 'SKIPPED_NO_RESPONDER'],
  'the documented notification statuses must match the database CHECK constraint'
);

const bundle = await getText('/app.js');
for (const route of requiredUiRoutes) assert.ok(bundle.includes(route), `the shipped SPA must handle ${route}`);
for (const forbidden of forbiddenInBundle) assert.equal(bundle.includes(forbidden), false, `the shipped bundle must not contain ${forbidden}`);

const styles = await getText('/styles.css');
assert.ok(styles.includes('oncall-hero') && styles.includes('summary-strip'), 'the shipped stylesheet must carry the Relay 0.2 view styles');
assert.ok(styles.includes('prefers-reduced-motion'), 'the shipped stylesheet must honour prefers-reduced-motion');

// The public boundary must not gain any on-call surface.
const publicMissing = await fetch(`${baseUrl}/api/v1/public/status/definitely-not-a-real-slug-${Date.now()}`);
assert.equal(publicMissing.status, 404, 'an unknown public slug must 404 rather than leak a default page');
const publicBody = await publicMissing.text();
for (const internal of ['oncall', 'schedule', 'rotation', 'responder', 'routing']) {
  assert.equal(publicBody.toLowerCase().includes(internal), false, `the public 404 body must not mention ${internal}`);
}

console.log(`Release surface PASS: Relay ${RELAY_VERSION} — health, package.json and OpenAPI agree; ${requiredPaths.length} documented 0.2 paths; ${requiredSchemas.length} schemas; ${requiredUiRoutes.length} SPA routes; no secrets in shipped assets.`);
