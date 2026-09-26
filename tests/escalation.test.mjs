import test from 'node:test';
import assert from 'node:assert/strict';
import { validateEscalationSteps, materializeEscalationPlan, cancelUnexecutedEscalations, dueRetryAt, classifyDeliveryFailure, sanitizeNotificationText } from '../packages/shared/escalation.mjs';
import { MemoryStore } from '../packages/database/memory-store.mjs';

test('escalation steps are deterministic, strictly ordered and reject duplicate positions or times',()=>{
  const steps=[{position:0,afterMinutes:5,targetScheduleId:'a',channels:['DISCORD']},{position:1,afterMinutes:15,targetScheduleId:'b',channels:['EMAIL','SLACK']}];
  assert.deepEqual(validateEscalationSteps(steps),steps);
  for(const invalid of [
    [{...steps[0],position:-1}],
    [steps[0],{...steps[1],position:0}],
    [steps[0],{...steps[1],afterMinutes:5}],
    [{...steps[0],afterMinutes:0}],
    [{...steps[0],channels:['SMS']}],
    [steps[1],steps[0]],
  ]) assert.throws(()=>validateEscalationSteps(invalid));
});

test('plan due times are measured from original route and snapshot names',()=>{
  const plan=materializeEscalationPlan({organizationId:'org',alertId:'alert',routingId:'route',routedAt:'2026-01-01T00:00:00Z',policy:{id:'p',name:'Primary → Lead',enabled:true},steps:[{position:0,afterMinutes:5,targetScheduleId:'s',channels:['EMAIL']}],schedulesById:{s:{id:'s',name:'Engineering',organizationId:'org'}}});
  assert.equal(plan[0].dueAt,'2026-01-01T00:05:00.000Z');
  assert.equal(plan[0].policyNameSnapshot,'Primary → Lead');
  assert.equal(plan[0].targetScheduleNameSnapshot,'Engineering');
  assert.throws(()=>materializeEscalationPlan({organizationId:'org',routedAt:'2026-01-01',policy:{id:'p',name:'p',enabled:true},steps:[{position:0,afterMinutes:1,targetScheduleId:'other',channels:['DISCORD']}],schedulesById:{other:{id:'other',name:'Other',organizationId:'elsewhere'}}}));
});

test('acknowledgement cancels pending work without rewriting completed history',()=>{
  const jobs=[{state:'PENDING'},{state:'IN_FLIGHT'},{state:'COMPLETED',executedAt:'x'}];
  const cancelled=cancelUnexecutedEscalations(jobs,'2026-01-01T00:00:00Z');
  assert.deepEqual(cancelled.map((job)=>job.state),['CANCELLED_ACKNOWLEDGED','CANCELLED_ACKNOWLEDGED','COMPLETED']);
});

test('retry policy is bounded and classifies transient provider failures',()=>{
  assert.equal(dueRetryAt('2026-01-01T00:00:00Z',1),'2026-01-01T00:01:00.000Z');
  assert.equal(dueRetryAt('2026-01-01T00:00:00Z',2),'2026-01-01T00:05:00.000Z');
  assert.equal(dueRetryAt('2026-01-01T00:00:00Z',3),null);
  assert.equal(classifyDeliveryFailure({status:429}),'RETRYABLE_FAILURE');
  assert.equal(classifyDeliveryFailure({status:503}),'RETRYABLE_FAILURE');
  assert.equal(classifyDeliveryFailure({status:400}),'PERMANENT_FAILURE');
});

test('policy edits and deletion do not rewrite an already materialized plan',async()=>{
  const store=new MemoryStore();
  store.schedules.push({id:'sched',organizationId:'org',name:'Primary',enabled:true,participants:[],overrides:[]});
  const policy=await store.saveEscalationPolicy('org',{name:'Escalate',enabled:true,steps:[{position:0,afterMinutes:5,targetScheduleId:'sched',channels:['DISCORD']}]});
  const plan=materializeEscalationPlan({organizationId:'org',alertId:'alert',routingId:'routing',routedAt:'2026-01-01T00:00:00Z',policy,steps:policy.steps,schedulesById:{sched:store.schedules[0]}});
  await store.materializeEscalationJobs(plan);
  await store.saveEscalationPolicy('org',{name:'Changed',enabled:true,steps:[{position:0,afterMinutes:10,targetScheduleId:'sched',channels:['EMAIL']}]},policy.id);
  const beforeDelete=await store.listEscalationJobs('org','alert');
  assert.equal(beforeDelete[0].policyNameSnapshot,'Escalate');
  assert.equal(beforeDelete[0].afterMinutes,5);
  assert.equal(beforeDelete[0].channels[0],'DISCORD');
  await store.deleteEscalationPolicy('org',policy.id);
  assert.equal((await store.listEscalationJobs('org','alert'))[0].targetScheduleNameSnapshot,'Primary');
  await store.materializeEscalationJobs(plan);
  assert.equal((await store.listEscalationJobs('org','alert')).length,1);
});

test('provider text neutralizes mentions, controls and hostile Slack syntax',()=>{ 
  assert.equal(sanitizeNotificationText('Hi @channel <!everyone>\r\nhello'), 'Hi @ channel everyone hello');
});
