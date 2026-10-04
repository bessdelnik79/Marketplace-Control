import assert from 'node:assert/strict';
import test from 'node:test';
import {deriveOperationalProgress,operationalRefreshStart,operationalDisplayRange,operationalReturnsRequired} from './operational.repository.mjs';

const now=new Date('2026-10-04T12:00:00Z');
const base={start:'2026-09-30',end:'2026-10-04',pendingDays:5,now};
const run={status:'running',requested_from:'2026-09-30',requested_to:'2026-10-04',started_at:new Date('2026-10-04T11:59:00Z'),progress:{stage:'rate_wait'}};

test('purchased-return coverage is required only within ninety Moscow calendar days',()=>{
  const midnight=new Date('2026-10-03T21:00:00Z');
  assert.equal(operationalReturnsRequired('2026-07-07',midnight),true);
  assert.equal(operationalReturnsRequired('2026-07-06',midnight),false);
  assert.equal(operationalReturnsRequired('2026-10-04',midnight),true);
  assert.throws(()=>operationalReturnsRequired('2026-07-07',new Date('invalid')),/operational_invalid_clock/);
});

test('queued coverage is pending; only live overlapping work is running',()=>{
  assert.equal(deriveOperationalProgress(base).status,'pending');
  const active=deriveOperationalProgress({...base,run});
  assert.equal(active.status,'running');assert.equal(active.runFrom,'2026-09-30');
  assert.deepEqual(active.progress,{stage:'rate_wait'});
  assert.equal(deriveOperationalProgress({...base,run:{...run,requested_from:'2026-09-01',requested_to:'2026-09-07'}}).status,'pending');
  assert.equal(deriveOperationalProgress({...base,run:{...run,started_at:new Date('2026-10-04T11:29:00Z')}}).status,'pending');
});

test('a succeeded run cannot claim missing coverage is current',()=>{
  const succeeded={...run,status:'succeeded',finished_at:now};
  assert.equal(deriveOperationalProgress({...base,run:succeeded}).status,'pending');
  assert.equal(deriveOperationalProgress({...base,run:succeeded,completeDays:5,pendingDays:0}).status,'current');
  assert.equal(deriveOperationalProgress({...base,run:{...run,status:'failed',error_code:'old_failure'}}).status,'pending');
});

test('day counts, failures and global selection/access waits are explicit',()=>{
  const failed=deriveOperationalProgress({...base,completeDays:2,pendingDays:0,failedDays:1});
  assert.deepEqual([failed.totalDays,failed.completeDays,failed.pendingDays,failed.failedDays,failed.missingDays],[5,2,0,1,2]);
  assert.equal(failed.status,'failed');assert.equal(failed.errorCode,'operational_metric_unavailable');
  assert.equal(deriveOperationalProgress({...base,factory:true,selected:false}).status,'waiting_selection');
  assert.equal(deriveOperationalProgress({...base,factory:true,blocked:true}).status,'blocked');
});

test('unqueued missing days are unavailable and planning/read coverage share year clip',()=>{
  const missing=deriveOperationalProgress({...base,pendingDays:0});
  assert.equal(missing.status,'unavailable');assert.equal(missing.missingDays,5);
  assert.equal(operationalRefreshStart(operationalDisplayRange({periodStart:'2026-01-01',periodEnd:'2026-10-04',now})),'2025-10-05');
});

test('scheduled recoverable failures keep failed counts and polling only while eligible',()=>{
  const retry={...base,pendingDays:0,failedDays:5,retryableDays:5,retryEligible:true,nextRunAt:new Date('2026-10-04T12:15:00Z')};
  const state=deriveOperationalProgress(retry);
  assert.equal(state.status,'failed');assert.equal(state.failedDays,5);assert.equal(state.retryScheduled,true);
  assert.equal(deriveOperationalProgress({...retry,retryableDays:0}).retryScheduled,false);
  assert.equal(deriveOperationalProgress({...retry,blocked:true}).retryScheduled,false);
  assert.equal(deriveOperationalProgress({...retry,retryEligible:false}).retryScheduled,false);
  assert.equal(deriveOperationalProgress({...retry,nextRunAt:null}).retryScheduled,false);
  assert.equal(deriveOperationalProgress({...retry,factory:true,selected:false}).retryScheduled,false);
});
