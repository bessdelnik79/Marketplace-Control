import test from 'node:test';
import assert from 'node:assert/strict';
import {loadSkuOrderHistories} from './sku-order-history.repository.mjs';
import {calculateBuyout} from './sku-buyout.mjs';

test('persisted short history supplies percent immediately, independent of financial rows',async()=>{
  let query;
  const client={query:async(sql,args)=>{query={sql,args};return {rows:[{product_id:'sku',coverage_start:'2026-08-01',coverage_end:'2026-08-31',observed_at:'2026-09-01T00:00:00Z',batch_id:'batch',records:[
    {sku:'sku',srid:'1',orderedAt:'2026-08-10T12:00:00+03:00',outcomeAt:'2026-08-12T12:00:00+03:00',outcome:'retained'},
    {sku:'sku',srid:'2',orderedAt:'2026-08-11T12:00:00+03:00',outcomeAt:'2026-08-13T12:00:00+03:00',outcome:'refused'}
  ]}]};}};
  const histories=await loadSkuOrderHistories(client,{businessId:'tenant',storeId:'store',periodEnd:'2026-08-31',productIds:['sku']});
  const value=calculateBuyout({sku:'sku',periodEnd:'2026-08-31',history:histories.sku});
  assert.equal(value.percent,50);assert.equal(value.sampleSize,2);assert.equal(value.quality,'partial');
  assert.deepEqual(query.args,['tenant','store',['sku'],'2025-08-31','2026-08-17','2026-08-31']);
  assert.match(query.sql,/identity\.ordered_at desc[\s\S]*limit 100[\s\S]*join mc\.sku_order_events/);
  assert.match(query.sql,/Europe\/Moscow/);assert.doesNotMatch(query.sql,/result_lines|fetch|insert|update/);
});
test('empty scope performs no DB query; absent coverage is missing instead of zero',async()=>{
  const client={query:async()=>{throw new Error('unexpected query');}};
  assert.deepEqual(await loadSkuOrderHistories(client,{periodEnd:'2026-08-31',productIds:[]}),{});
  const histories=await loadSkuOrderHistories({query:async()=>({rows:[]})},{businessId:'tenant',storeId:'store',periodEnd:'2026-08-31',productIds:['sku']});
  assert.equal(calculateBuyout({sku:'sku',periodEnd:'2026-08-31',history:histories.sku}).reason,'history_missing');
});
