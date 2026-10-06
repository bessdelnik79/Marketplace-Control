import assert from 'node:assert/strict';
import test from 'node:test';
import {nextTariffCheck,startTariffScheduler} from './tariff-scheduler.mjs';
test('expiry runs daily at 00:10 Moscow across month/year boundaries',()=>{
  assert.equal(nextTariffCheck(new Date('2026-12-31T21:11:00Z')).toISOString(),'2027-01-01T21:10:00.000Z');
  assert.equal(nextTariffCheck(new Date('2026-10-06T20:00:00Z')).toISOString(),'2026-10-06T21:10:00.000Z');
});
test('startup catches up; failed pass schedules next day and shutdown cancels',async()=>{
  const callbacks=[],errors=[];let runs=0,cancelled=false;
  const stop=startTariffScheduler({expireDue:async()=>{runs++;throw new Error('database unavailable');},
    now:()=>new Date('2026-10-06T21:11:00Z'),onError:error=>errors.push(error.message),
    setTimer:(fn,delay)=>{callbacks.push({fn,delay});return 1;},clearTimer:()=>{cancelled=true;}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(runs,1);assert.deepEqual(errors,['database unavailable']);assert.equal(callbacks[0].delay,86340000);
  stop();assert.equal(cancelled,true);
});
