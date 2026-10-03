import assert from 'node:assert/strict';
import test from 'node:test';
import {recoverHistoricalCatalog} from './historical-catalog.repository.mjs';

test('historical recovery requires the caller tenant before writing',async()=>{
  const calls=[];
  const client={query:async(sql)=>{calls.push(sql);return {rows:[{business_id:'other'}]};}};
  await assert.rejects(recoverHistoricalCatalog(client,{businessId:'current',storeId:'store'}),/catalog_context_mismatch/);
  assert.equal(calls.length,1);
});
test('historical recovery passes only persisted version IDs in the existing transaction',async()=>{
  const result={catalogRevision:2,addedProductIds:['product'],changed:true};
  const calls=[];
  const client={query:async(sql,params)=>{calls.push({sql,params});return {rows:[calls.length===1?{business_id:'business'}:{result}]};}};
  assert.equal(await recoverHistoricalCatalog(client,{businessId:'business',storeId:'store',reportVersionId:'version'}),result);
  assert.deepEqual(calls[1].params,['store','version']);
});
