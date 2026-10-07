import test from 'node:test';
import assert from 'node:assert/strict';
import { createSituationOperationalCountsReader } from './situation-counts.mjs';

const input={storeId:'store', productId:'product', periodStart:'2026-09-14', periodEnd:'2026-09-15'};
function row(date, product='product', extra={}) {
  return {product_id:product, metric_date:date, available:true, currency:'RUB', snapshot_id:'snapshot',
    order_count:'3', order_amount:'30.0000', buyout_count:'2', buyout_amount:'20.0000',
    fetched_at:'2026-09-16T01:00:00Z', ...extra};
}
function envelope(extra={}) {
  return {store:{id:'store'}, current:{period_start:input.periodStart, period_end:input.periodEnd,
    quality:'complete', missing_reasons:[], product_ids:['product','other']},
    rows:[row(input.periodStart), row(input.periodEnd), row(input.periodStart,'other',{order_count:'999'})], ...extra};
}
function reader(data=envelope()) {
  const calls=[];
  const read=createSituationOperationalCountsReader({readOperationalData:async(...args)=>{calls.push(args); return data;}});
  return {read, calls};
}
test('reads the exact period and selected product only, with order-date provenance',async()=>{
  const s=reader(), result=await s.read('viewer',input);
  assert.deepEqual(s.calls,[['viewer','store',{periodStart:input.periodStart,periodEnd:input.periodEnd}]]);
  assert.deepEqual(result.period,{start:input.periodStart,end:input.periodEnd});
  assert.deepEqual(result.orders,{count:'6',availability:'complete'});
  assert.deepEqual(result.buyouts,{count:'4',availability:'complete'});
  assert.equal(result.source.dateBasis,'order_date');
  assert.equal(result.source.scope,'current_active_product');
  assert.equal(result.productId,'product');
  assert.equal(result.storeId,'store');
  assert.deepEqual(result.snapshotIds,['snapshot']);
  assert.equal(result.updatedAt,'2026-09-16T01:00:00.000Z');
});
test('complete zero counts remain zero',async()=>{
  const s=reader(envelope({rows:[row(input.periodStart,'product',{order_count:'0',buyout_count:'0'}),
    row(input.periodEnd,'product',{order_count:'0',buyout_count:'0'})]}));
  const result=await s.read('viewer',input);
  assert.deepEqual(result.orders,{count:'0',availability:'complete'});
  assert.deepEqual(result.buyouts,{count:'0',availability:'complete'});
});
test('facts outside the pinned period cannot fill its missing day or affect its counts',async()=>{
  const result=await reader(envelope({rows:[row(input.periodStart),row(input.periodEnd),
    row('2026-09-13','product',{order_count:'999'}),row('2026-09-16','product',{order_count:'999'})]})).read('viewer',input);
  assert.deepEqual(result.orders,{count:'6',availability:'complete'});
  const missing=await reader(envelope({rows:[row(input.periodStart),row('2026-09-16')]})).read('viewer',input);
  assert.equal(missing.orders.count,null);
});
test('a partial current envelope without a complete saved replacement cannot publish totals',async()=>{
  const data=envelope();data.current.quality='partial';data.current.missing_reasons=['source_partial'];
  const result=await reader(data).read('viewer',input);
  assert.equal(result.orders.count,null);assert.equal(result.buyouts.count,null);
  assert.deepEqual(result.missingReasons,['source_partial']);
});
test('missing and unavailable product days withhold the entire period total',async()=>{
  for (const rows of [[],[row(input.periodStart)],
    [row(input.periodStart),row(input.periodEnd,'product',{available:false,missing_reasons:['metric_date_missing']})],
    [row(input.periodStart,'other'),row(input.periodEnd,'other')]]) {
    const result=await reader(envelope({rows})).read('viewer',input);
    assert.deepEqual(result.orders,{count:null,availability:'unavailable'});
    assert.deepEqual(result.buyouts,{count:null,availability:'unavailable'});
    assert.ok(result.missingReasons.includes('operational_metric_unavailable'));
  }
});
test('saved accepted complete days preserve counts through an incomplete refresh',async()=>{
  const result=await reader(envelope({rows:[row(input.periodStart)],
    savedRows:[row(input.periodEnd,'product',{snapshot_id:'saved',order_count:'7'})]})).read('viewer',input);
  assert.deepEqual(result.orders,{count:'10',availability:'complete'});
  assert.equal(result.source.savedDataUsed,true);
  assert.deepEqual(result.snapshotIds,['saved','snapshot']);
});
test('foreign, inactive, missing and mismatched scopes fail closed',async()=>{
  for(const data of [null,envelope({store:{id:'foreign'}}),envelope({current:null}),
    envelope({current:{...envelope().current,product_ids:['other']}}),
    envelope({current:{...envelope().current,period_end:'2026-09-16'}})]) {
    const result=await reader(data).read('viewer',input);
    assert.equal(result.orders.count,null);
    assert.equal(result.buyouts.count,null);
    assert.equal(result.orders.availability,'unavailable');
    assert.ok(result.missingReasons.length);
    assert.deepEqual(result.snapshotIds,[]);
  }
});
test('invalid, implicit, future or unsupported long periods do not use default or partial ranges',async()=>{
  for(const changes of [{periodStart:null},{periodEnd:'2026-02-30'},
    {periodStart:'2025-01-01',periodEnd:'2026-09-15'},
    {periodStart:'2999-01-01',periodEnd:'2999-01-02'}]) {
    const s=reader(), result=await s.read('viewer',{...input,...changes});
    assert.equal(s.calls.length,0);
    assert.equal(result.orders.count,null);
    assert.deepEqual(result.missingReasons,['operational_period_unavailable']);
  }
});
test('membership and unexpected database errors are not converted into counts',async()=>{
  for(const message of ['business_not_found','unexpected database error']) {
    const read=createSituationOperationalCountsReader({readOperationalData:async()=>{throw new Error(message);}});
    await assert.rejects(read('viewer',input),{message});
  }
});
