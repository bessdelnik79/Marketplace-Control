import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { encryptSecret } from '../../infrastructure/security/secrets.mjs';
import {
  createFinancialPipelineWorker,
  createFinancialReportFetchWorker,
  createFinancialReportNormalizeWorker,
  financialPipelineErrorCode
} from './financial-pipeline-worker.mjs';

const encryptionKey=randomBytes(32);
const sellerId=randomUUID();
const token=()=>`header.${Buffer.from(JSON.stringify({sid:sellerId,exp:2_000_000_000,s:1<<13,acc:1})).toString('base64url')}.signature`;
const encrypted=()=>{
  const value=encryptSecret(token(),encryptionKey);
  return {ciphertext:value.ciphertext,nonce:value.nonce,auth_tag:value.authTag};
};
const job=(overrides={})=>({
  id:randomUUID(),lease_token:randomUUID(),
  payload:{credentialGeneration:3,coverageId:randomUUID(),mode:'by_report_id',reportId:'90071992547409931',periodStart:'2026-09-07',periodEnd:'2026-09-13',inventoryChecksum:'a'.repeat(64)},
  ...overrides
});
const row=(rrdId='90071992547409941')=>({
  reportId:'90071992547409931',rrdId,dateFrom:'2026-09-07',dateTo:'2026-09-13',currency:'RUB',rrDate:'2026-09-08'
});
const rawRows=rows=>JSON.stringify(rows)
  .replace(/"reportId":"(\d+)"/g,'"reportId":$1')
  .replace(/"rrdId":"(\d+)"/g,'"rrdId":$1');

function jobsFor(items=[]){
  const calls={claim:[],heartbeat:[],complete:[],fail:[]};
  return {
    calls,
    async claimJobs(input){calls.claim.push(input);return items.splice(0,1);},
    async heartbeatJob(input){calls.heartbeat.push(input);return true;},
    async completeJob(input){calls.complete.push(input);return true;},
    async failJob(input){calls.fail.push(input);return input;}
  };
}

const context=()=>({
  business_id:randomUUID(),store_id:randomUUID(),seller_id:sellerId,detail_by_id_api:'unknown',...encrypted()
});

test('fetch worker loads one report by exact ID, stores raw pages and persists before completion',async()=>{
  const target=job(),jobs=jobsFor([target]),ctx=context(),events=[],persisted=[];
  const responses=[new Response(rawRows([row()])),new Response(null,{status:204})];
  const repository={
    getFetchContext:async(...args)=>{events.push('context');assert.deepEqual(args,[target.id,3,target.lease_token,'fetch-worker']);return ctx;},
    reserveRequestSlot:async(seller,delay)=>{events.push('reserve');assert.equal(seller,sellerId);assert.equal(delay,65);return {waitMs:12};},
    persistRaw:async(...args)=>{events.push('persist');persisted.push(args);return {superseded:false};},
    fallbackToPeriod:async()=>{throw new Error('unexpected fallback');},
    normalize:async()=>({})
  };
  const storage={
    storeFinancialPages:async input=>{events.push('store');assert.equal(input.pages[0].raw,rawRows([row()]));return {objects:[{storageKey:'safe',partNumber:0}]};},
    removeFinancialDocument:async()=>{throw new Error('unexpected cleanup');}
  };
  const worker=createFinancialReportFetchWorker({
    jobs,repository,storage,encryptionKey,workerId:'fetch-worker',random:()=>0,wait:async ms=>{events.push(`wait:${ms}`);},
    fetchImpl:async()=>responses.shift()
  });
  assert.equal(await worker.runOnce(),true);
  assert.equal(jobs.calls.heartbeat.length,2);
  assert.deepEqual(events,['context','reserve','wait:12','reserve','wait:12','store','persist']);
  assert.equal(persisted[0][0],target.id);
  assert.equal(persisted[0][1],3);
  assert.deepEqual(persisted[0][4].reports.map(report=>report.externalReportId),['90071992547409931']);
  assert.equal(persisted[0][4].objects[0].storageKey,'safe');
  assert.equal(jobs.calls.complete[0].outcome,'completed');
  assert.equal(jobs.calls.fail.length,0);
});

test('fetch worker switches an unsupported detail capability to period fallback without raw storage',async()=>{
  const target=job(),jobs=jobsFor([target]),fallback=[];
  const repository={
    getFetchContext:async()=>context(),reserveRequestSlot:async()=>({waitMs:0}),persistRaw:async()=>{throw new Error('unexpected persist');},
    fallbackToPeriod:async(...args)=>{fallback.push(args);return {superseded:false};},normalize:async()=>({})
  };
  let storageCalls=0;
  const worker=createFinancialReportFetchWorker({
    jobs,repository,encryptionKey,workerId:'fetch-worker',random:()=>0,
    storage:{storeFinancialPages:async()=>{storageCalls++;},removeFinancialDocument:async()=>{}},
    fetchImpl:async()=>new Response(JSON.stringify({detail:'Method is unavailable for your registration country.'}),{status:400})
  });
  await worker.runOnce();
  assert.deepEqual(fallback[0],[target.id,3,target.lease_token,'fetch-worker']);
  assert.equal(storageCalls,0);
  assert.equal(jobs.calls.complete[0].outcome,'completed');
  assert.equal(jobs.calls.fail.length,0);
});

test('period-mode fetch uses compatible period transport and cleanup runs only when persist fails',async()=>{
  const target=job({payload:{credentialGeneration:2,coverageId:randomUUID(),mode:'period',periodStart:'2026-09-07',periodEnd:'2026-09-13'}});
  const jobs=jobsFor([target]),removed=[];
  const responses=[new Response(rawRows([row('10')])),new Response(null,{status:204})];
  const repository={
    getFetchContext:async()=>context(),reserveRequestSlot:async()=>({waitMs:0}),
    persistRaw:async()=>{const error=new Error('financial_persist_unavailable');error.retryable=true;throw error;},
    fallbackToPeriod:async()=>({}),normalize:async()=>({})
  };
  const worker=createFinancialReportFetchWorker({
    jobs,repository,encryptionKey,workerId:'fetch-worker',random:()=>0,fetchImpl:async(url)=>{
      assert.equal(url,'https://finance-api.wildberries.ru/api/finance/v1/sales-reports/detailed');
      return responses.shift();
    },
    storage:{
      storeFinancialPages:async input=>({objects:[{storageKey:`${input.documentId}/part`,partNumber:0}]}),
      removeFinancialDocument:async input=>removed.push(input)
    }
  });
  await worker.runOnce();
  assert.equal(removed.length,1);
  assert.equal(removed[0].businessId.length,36);
  assert.deepEqual(jobs.calls.fail.map(({errorCode,retryable})=>({errorCode,retryable})),[
    {errorCode:'financial_persist_unavailable',retryable:true}
  ]);
  assert.equal(jobs.calls.complete.length,0);
});

test('empty period response retries while superseded persistence removes orphan raw',async()=>{
  const empty=job({payload:{credentialGeneration:2,coverageId:randomUUID(),mode:'period',periodStart:'2026-09-07',periodEnd:'2026-09-13'}});
  const stale=job(),jobs=jobsFor([empty,stale]),removed=[];
  let persistCall=0;
  const repository={
    getFetchContext:async()=>context(),reserveRequestSlot:async()=>({waitMs:0}),
    persistRaw:async()=>persistCall++===0?{empty:true}:{superseded:true},
    fallbackToPeriod:async()=>({}),normalize:async()=>({}),recordFailure:async()=>{}
  };
  const responses=[
    new Response(null,{status:204}),
    new Response(rawRows([row()])),new Response(null,{status:204})
  ];
  const worker=createFinancialReportFetchWorker({
    jobs,repository,encryptionKey,workerId:'fetch-worker',random:()=>0,fetchImpl:async()=>responses.shift(),
    storage:{
      storeFinancialPages:async()=>({objects:[{storageKey:'orphan',partNumber:0}]}),
      removeFinancialDocument:async input=>removed.push(input)
    }
  });
  await worker.runOnce();
  await worker.runOnce();
  assert.equal(jobs.calls.fail[0].errorCode,'financial_detail_empty');
  assert.equal(jobs.calls.fail[0].retryable,true);
  assert.equal(jobs.calls.complete[0].outcome,'superseded');
  assert.equal(removed.length,1);
});

test('normalize worker completes local normalization and keeps terminal failures non-retryable',async()=>{
  const success=job(),failure=job(),jobs=jobsFor([success,failure]);
  let call=0;
  const repository={normalize:async(...args)=>{
    assert.deepEqual(args,[call===0?success.id:failure.id,call===0?success.lease_token:failure.lease_token,'normalize-worker']);
    if(call++===0)return {superseded:true};
    throw new Error('financial_normalize_invalid_source');
  }};
  const worker=createFinancialReportNormalizeWorker({jobs,repository,workerId:'normalize-worker',random:()=>0});
  await worker.runOnce();
  await worker.runOnce();
  assert.equal(jobs.calls.complete[0].outcome,'superseded');
  assert.deepEqual(jobs.calls.fail.map(({errorCode,retryable})=>({errorCode,retryable})),[
    {errorCode:'financial_normalize_invalid_source',retryable:false}
  ]);
});

test('combined worker alternates fetch and normalize claims and sanitizes unknown errors',async()=>{
  const jobs=jobsFor([]),repository={
    getFetchContext:async()=>null,reserveRequestSlot:async()=>({waitMs:0}),persistRaw:async()=>({}),fallbackToPeriod:async()=>({}),normalize:async()=>({})
  };
  const worker=createFinancialPipelineWorker({jobs,repository,workerId:'pipeline'});
  assert.equal(await worker.runOnce(),false);
  assert.equal(await worker.runOnce(),false);
  assert.deepEqual(jobs.calls.claim.map(call=>call.jobTypes[0]),[
    'financial_report_fetch','financial_report_normalize','financial_report_normalize','financial_report_fetch'
  ]);
  assert.equal(financialPipelineErrorCode(new Error('token=unsafe value')),'financial_pipeline_internal_error');
  assert.equal(financialPipelineErrorCode(new Error('financial_detail_unavailable')),'financial_detail_unavailable');
});
