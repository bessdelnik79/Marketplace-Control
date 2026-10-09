import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {createOrderOutcomeRepository,orderOutcomeSignature} from './order-outcomes.repository.mjs';
const target={user_id:'u',business_id:'b',store_id:'s'};
function harness({role='owner',generation='1',conflict=false,verify=async()=>true,batchPresent=false}={}){
  const queries=[],client=new EventEmitter();let released=0;
  client.release=()=>released++;
  client.query=async(sql,args)=>{
    queries.push({sql,args});
    if(sql.includes('pg_try_advisory_lock'))return {rows:[{locked:true}]};
    if(sql.includes('pg_advisory_unlock'))return {rows:[{unlocked:true}]};
    if(sql.includes('select role'))return {rows:[{role:typeof role==='function'?role():role}]};
    if(sql.includes('select c.credential_generation'))return {rows:[{credential_generation:typeof generation==='function'?generation():generation,scopes:['statistics'],seller_id:'seller'}]};
    if(sql.includes('select p.id product_id'))return {rows:[{product_id:'p',nm_id:'42'}]};
    if(sql.includes('select * from mc.sku_order_sync_state'))return {rows:[]};
    if(sql.includes('returning greatest'))return {rows:[{wait_ms:0}]};
    if(sql.includes('select exists(select 1 from mc.sku_order_batches'))return {rows:[{present:batchPresent}]};
    if(sql.includes('select exists'))return {rows:[{conflict:typeof conflict==='function'?conflict(sql):conflict}]};
    return {rows:[]};
  };
  const pool={connect:async()=>client,query:client.query};
  return {repo:createOrderOutcomeRepository({pool,verify}),queries,released:()=>released,client};
}
const payload={batchId:'batch',sourceFrom:'2026-07-13',coverageEnd:'2026-10-10',objects:[{endpoint:'orders',partNumber:0,checksum:'a'.repeat(64)}],result:{complete:true,pages:[{endpoint:'https://statistics-api.wildberries.ru/api/v1/supplier/orders',checksum:'a'.repeat(64)}],observedThrough:'2026-10-10T12:00:00Z',cursors:{orders:'o',sales:'s'},orders:[{srid:'001',nmId:42,orderedAt:'2026-08-01T00:00:00Z'}],events:[{srid:'001',nmId:42,sourceKey:'sale:S001',changedAt:'2026-08-10T00:00:00Z',outcome:'retained',outcomeAt:'2026-08-10T00:00:00Z'}]}};
test('fresh scope signature includes generation and selection, independent of product ordering',()=>{
  const a={credential_generation:'1',products:[{productId:'a',nmId:1},{productId:'b',nmId:2}]};
  assert.equal(orderOutcomeSignature(a),orderOutcomeSignature({...a,products:[...a.products].reverse()}));
  assert.notEqual(orderOutcomeSignature(a),orderOutcomeSignature({...a,credential_generation:'2'}));
});
test('lease session stays held across transactions; membership/selection check precedes immutable writes',async()=>{
  const {repo,queries,released}=harness();const lease=await repo.acquire(target),job=await repo.begin(lease,target,new Date());
  assert.equal(job.reset,true);assert.equal(released(),0);
  await repo.complete(lease,job,payload);assert.equal(released(),0);
  const writes=queries.filter(q=>q.sql.startsWith('insert into mc.sku_order_'));
  assert.ok(writes.some(q=>q.sql.includes('sku_order_identities')&&q.sql.includes('on conflict do nothing')));
  assert.ok(writes.some(q=>q.sql.includes('sku_order_events')&&q.sql.includes('on conflict do nothing')));
  assert.equal(queries.filter(q=>q.sql.includes('select role')).length,2);
  const fence=queries.findIndex(q=>q.sql.includes('pg_advisory_xact_lock'));
  assert.ok(fence<queries.findIndex(q=>q.sql.includes('select role')));
  assert.match(queries.find(q=>q.sql.includes('select c.credential_generation')).sql,/c\.scopes \? 'statistics'/);
  await lease.release();assert.equal(released(),1);assert.match(queries.at(-1).sql,/pg_advisory_unlock/);
});
test('viewer or revoked membership blocks begin before secrets and network reservation',async()=>{
  const {repo,queries}=harness({role:'viewer'});const lease=await repo.acquire(target);
  await assert.rejects(repo.begin(lease,target,new Date()),/refresh_forbidden/);
  assert.ok(!queries.some(q=>q.sql.includes('select c.credential_generation')));await lease.release();
});
test('shared sales rate-key and independent orders key reserve 65 seconds',async()=>{
  const {repo,queries}=harness(),lease=await repo.acquire(target),job=await repo.begin(lease,target,new Date());
  await repo.reserve(lease,job,'https://statistics-api.wildberries.ru/api/v1/supplier/sales');
  await repo.reserve(lease,job,'https://statistics-api.wildberries.ru/api/v1/supplier/orders');
  const writes=queries.filter(q=>q.sql.includes('insert into mc.wb_api_request_slots'));
  assert.equal(writes[0].args[0],createHash('sha256').update('wb:statistics:sales:seller').digest('hex'));
  assert.notEqual(writes[0].args[0],writes[1].args[0]);assert.match(writes[0].sql,/65 seconds/);await lease.release();
});
test('conflicting immutable records rollback all refs and leave prior coverage untouched',async()=>{
  const {repo,queries}=harness({conflict:true}),lease=await repo.acquire(target),job=await repo.begin(lease,target,new Date());
  await assert.rejects(repo.complete(lease,job,payload),/duplicate_conflict/);
  assert.equal(queries.at(-1).sql,'rollback');assert.ok(!queries.some(q=>q.sql.includes('insert into mc.sku_order_coverage')));await lease.release();
});
test('tampered storage never begins a write transaction; stale credential fails before batch insert',async()=>{
  const bad=harness({verify:async()=>{throw new Error('operational_storage_checksum_mismatch');}}),lease=await bad.repo.acquire(target),job=await bad.repo.begin(lease,target,new Date());
  await assert.rejects(bad.repo.complete(lease,job,payload),/checksum_mismatch/);
  assert.ok(!bad.queries.some(q=>q.sql.includes('insert into mc.sku_order_batches')));await lease.release();
  const stale=harness(),other=await stale.repo.acquire(target),old=await stale.repo.begin(other,target,new Date());
  await assert.rejects(stale.repo.complete(other,{...old,signature:'stale'},payload),/sync_superseded/);await other.release();
});
test('role revocation and credential rotation after API fetch reject publication',async()=>{
  let role='owner',generation='1';
  const state=harness({role:()=>role,generation:()=>generation}),lease=await state.repo.acquire(target),job=await state.repo.begin(lease,target,new Date());
  role='viewer';await assert.rejects(state.repo.complete(lease,job,payload),/refresh_forbidden/);
  role='owner';generation='2';await assert.rejects(state.repo.complete(lease,job,payload),/sync_superseded/);
  assert.ok(!state.queries.some(q=>q.sql.includes('insert into mc.sku_order_batches')));await lease.release();
});
test('lost session invalidates its lease before database writes',async()=>{
  const state=harness(),lease=await state.repo.acquire(target);
  state.client.emit('error',new Error('private failure'));assert.throws(()=>lease.assertActive(),/sync_superseded/);
  await assert.rejects(state.repo.begin(lease,target,new Date()),/sync_superseded/);await lease.release();
  assert.equal(state.released(),1);
});
test('source objects must match the page checksum, index and endpoint before persistence',async()=>{
  const state=harness(),lease=await state.repo.acquire(target),job=await state.repo.begin(lease,target,new Date());
  for(const patch of [{checksum:'b'.repeat(64)},{partNumber:1},{endpoint:'sales'}]){
    await assert.rejects(state.repo.complete(lease,job,{...payload,objects:[{...payload.objects[0],...patch}]}),/invalid_result/);
  }
  assert.ok(!state.queries.some(q=>q.sql.includes('insert into mc.sku_order_batches')));await lease.release();
});
test('joined event/order identity or chronology conflict rolls back coverage and refs',async()=>{
  const state=harness({conflict:sql=>sql.includes('join mc.sku_order_identities o')&&sql.includes('mc.sku_order_events e')}),lease=await state.repo.acquire(target),job=await state.repo.begin(lease,target,new Date());
  await assert.rejects(state.repo.complete(lease,job,payload),/duplicate_conflict/);
  const guard=state.queries.find(q=>q.sql.includes('union all select 1 from mc.sku_order_events'));
  assert.match(guard.sql,/e\.product_id<>o\.product_id or e\.outcome_at<o\.ordered_at/);
  assert.equal(state.queries.at(-1).sql,'rollback');assert.ok(!state.queries.some(q=>q.sql.includes('insert into mc.sku_order_coverage')));await lease.release();
});
test('selection or credential reset preserves per-SKU continuous accumulated coverage; only a gap resets',async()=>{
  const state=harness(),lease=await state.repo.acquire(target),job=await state.repo.begin(lease,target,new Date());
  assert.equal(job.reset,true);
  await state.repo.complete(lease,job,payload);
  const coverage=state.queries.find(q=>q.sql.includes('insert into mc.sku_order_coverage'));
  assert.equal(coverage.args.length,6);
  assert.match(coverage.sql,/case when excluded\.coverage_start>mc\.sku_order_coverage\.coverage_end\+1 then excluded\.coverage_start else least\(mc\.sku_order_coverage\.coverage_start,excluded\.coverage_start\)/);
  assert.doesNotMatch(coverage.sql,/\$7/);
  // The conflict branch is per product: an existing year survives an overlapping
  // 90-day refetch, while a new product is inserted with its own sourceFrom.
  assert.match(coverage.sql,/on conflict\(business_id,store_id,product_id\)/);
  assert.equal(coverage.args[3],payload.sourceFrom);
  await lease.release();
});
test('fresh batch existence check returns true/false and unknown for revoked or failed access',async()=>{
  for(const present of [true,false]){
    const state=harness({batchPresent:present});
    assert.equal(await state.repo.hasBatch(target,'batch'),present);
    assert.equal(state.released(),1);
    assert.ok(state.queries.findIndex(q=>q.sql.includes('for update'))<state.queries.findIndex(q=>q.sql.includes('from mc.sku_order_batches')));
    assert.equal(state.queries.at(-1).sql,'commit');
  }
  const denied=harness({role:'viewer'});assert.equal(await denied.repo.hasBatch(target,'batch'),null);
  assert.equal(denied.queries.at(-1).sql,'rollback');
  const failed=createOrderOutcomeRepository({pool:{connect:async()=>{throw new Error('offline');}}});
  assert.equal(await failed.hasBatch(target,'batch'),null);
});
