import assert from 'node:assert/strict';
import test from 'node:test';
import {createFinancialDailyGenerationWorker,financialDailyErrorCode} from './daily-generation-worker.mjs';

const job={id:'11111111-1111-4111-8111-111111111111',lease_token:'22222222-2222-4222-8222-222222222222',attempt_count:1,max_attempts:5};

test('daily worker claims only local recalculation and completes a built generation',async()=>{
  const calls=[];
  const jobs={
    claimJobs:async input=>(calls.push(['claim',input]),[job]),heartbeatJob:async input=>(calls.push(['heartbeat',input]),true),
    completeJob:async input=>calls.push(['complete',input]),failJob:async()=>assert.fail('must not fail')
  };
  const worker=createFinancialDailyGenerationWorker({jobs,repository:{build:async(...args)=>(calls.push(['build',args]),{superseded:false})},workerId:'daily-worker'});
  assert.equal(await worker.runOnce(),true);
  assert.deepEqual(calls[0][1].jobTypes,['financial_dates_recalculate']);
  assert.deepEqual(calls[2],['build',[job.id,job.lease_token,'daily-worker']]);
  assert.equal(calls[3][1].outcome,'completed');
});

test('daily worker completes an obsolete event as superseded',async()=>{
  let outcome;
  const jobs={claimJobs:async()=>[job],heartbeatJob:async()=>true,completeJob:async input=>{outcome=input.outcome;},failJob:async()=>assert.fail('must not fail')};
  const worker=createFinancialDailyGenerationWorker({jobs,repository:{build:async()=>({superseded:true})}});
  await worker.runOnce();
  assert.equal(outcome,'superseded');
});

test('daily worker retries transient errors and terminates invalid inputs',async()=>{
  const decisions=[];
  for(const error of [Object.assign(new Error('connection lost'),{code:'08006'}),new Error('financial_daily_coverage_incomplete'),new Error('daily_generation_invalid_tax_rate'),Object.assign(new Error('constraint'),{code:'23514'}),new Error('financial_daily_publication_shadow_incompatible')]){
    const jobs={claimJobs:async()=>[job],heartbeatJob:async()=>true,completeJob:async()=>assert.fail('must not complete'),failJob:async input=>decisions.push(input)};
    await createFinancialDailyGenerationWorker({jobs,repository:{build:async()=>{throw error;}},random:()=>0,workerId:'daily-worker'}).runOnce();
  }
  assert.equal(decisions[0].errorCode,'financial_daily_db_08006');
  assert.equal(decisions[0].retryable,true);
  assert.equal(decisions[1].errorCode,'financial_daily_coverage_incomplete');
  assert.equal(decisions[1].retryable,false);
  assert.equal(decisions[2].errorCode,'daily_generation_invalid_tax_rate');
  assert.equal(decisions[2].retryable,false);
  assert.equal(decisions[3].errorCode,'financial_daily_db_23514');
  assert.equal(decisions[3].retryable,false);
  assert.equal(decisions[4].errorCode,'financial_daily_publication_shadow_incompatible');
  assert.equal(decisions[4].retryable,true);
  assert.equal(decisions[4].retryDelaySeconds,30);
  assert.equal(financialDailyErrorCode(new Error('secret path')), 'financial_daily_internal_error');
});

test('daily worker keeps a long build lease alive until completion',async()=>{
  let heartbeats=0;
  const jobs={claimJobs:async()=>[job],heartbeatJob:async()=>{heartbeats+=1;return true;},completeJob:async()=>{},failJob:async()=>assert.fail('must not fail')};
  const worker=createFinancialDailyGenerationWorker({jobs,repository:{build:async()=>{await new Promise(resolve=>setTimeout(resolve,35));return{superseded:false};}}});
  await worker.runOnce({heartbeatIntervalMs:10});
  assert.ok(heartbeats>=3);
});
