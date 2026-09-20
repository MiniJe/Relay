import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregatePublicStatus, assertIncidentTransition, assertSeverity, canTransitionIncident, worstComponentState } from '../packages/shared/domain.mjs';

test('incident lifecycle permits forward/coordination transitions and makes RESOLVED terminal',()=>{
  assert.equal(canTransitionIncident('INVESTIGATING','IDENTIFIED'),true);
  assert.equal(canTransitionIncident('IDENTIFIED','MONITORING'),true);
  assert.equal(canTransitionIncident('MONITORING','INVESTIGATING'),true);
  assert.equal(canTransitionIncident('MONITORING','RESOLVED'),true);
  assert.equal(canTransitionIncident('RESOLVED','INVESTIGATING'),false);
  assert.throws(()=>assertIncidentTransition('RESOLVED','INVESTIGATING'),/cannot transition/);
});

test('severity validation rejects unknown values',()=>{
  for(const severity of ['SEV1','SEV2','SEV3','SEV4'])assert.doesNotThrow(()=>assertSeverity(severity));
  assert.throws(()=>assertSeverity('CRITICAL'),/Severity/);
});

test('public status aggregation derives incident impact without mutating component source state',()=>{
  const components=[{id:'a',name:'API',operationalState:'OPERATIONAL'},{id:'b',name:'Dashboard',operationalState:'MAINTENANCE'}];
  const result=aggregatePublicStatus(components,[{severity:'SEV1',affectedComponentIds:['a']}]);
  assert.equal(result.overallStatus,'MAJOR_OUTAGE');
  assert.equal(result.components.find((x)=>x.id==='a').effectiveState,'MAJOR_OUTAGE');
  assert.equal(components[0].operationalState,'OPERATIONAL');
  assert.equal(worstComponentState(['OPERATIONAL','PARTIAL_OUTAGE','DEGRADED_PERFORMANCE']),'PARTIAL_OUTAGE');
});
