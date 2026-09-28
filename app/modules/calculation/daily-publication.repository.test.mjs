import assert from 'node:assert/strict';
import test from 'node:test';
import {createFinancialDailyPublicationRepository,publishFinancialDailyGeneration} from './daily-publication.repository.mjs';

test('daily publication repository delegates the lease and generation CAS to one SQL function',async()=>{
  const calls=[];
  const client={query:async(sql,params)=>{
    calls.push([String(sql),params]);
    return{rows:[{id:'publication-1',generation_id:'generation-1',publication_no:'2'}]};
  }};
  const publication=await createFinancialDailyPublicationRepository().publish(client,{
    jobId:'job-1',leaseToken:'lease-1',workerId:'worker-1',generationId:'generation-1',eventGeneration:7
  });
  assert.equal(publication.id,'publication-1');
  assert.match(calls[0][0],/publish_financial_daily_generation/);
  assert.deepEqual(calls[0][1],['job-1','lease-1','worker-1','generation-1',7]);
});

test('daily publication repository rejects incomplete identity and missing SQL output',async()=>{
  await assert.rejects(()=>publishFinancialDailyGeneration({query:async()=>({rows:[]})},{
    jobId:'job-1',leaseToken:'lease-1',workerId:'worker-1',generationId:'generation-1',eventGeneration:7
  }),/financial_daily_publication_missing/);
  await assert.rejects(()=>publishFinancialDailyGeneration({query:async()=>assert.fail('must not query')},{
    jobId:'job-1',leaseToken:'lease-1',workerId:'',generationId:'generation-1',eventGeneration:7
  }),/workerId is required/);
});
