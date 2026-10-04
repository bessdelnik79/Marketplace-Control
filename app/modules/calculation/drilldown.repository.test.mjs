import assert from 'node:assert/strict';
import test from 'node:test';
import { createPublishedDrilldownRepository } from './drilldown.repository.mjs';

const user='11111111-1111-4111-8111-111111111111',store='22222222-2222-4222-8222-222222222222';
const publication='33333333-3333-4333-8333-333333333333',business='44444444-4444-4444-8444-444444444444';
const input={storeId:store,publicationId:publication,publicationSource:'legacy',periodStart:'2026-09-14',periodEnd:'2026-09-20'};
function fixture({role='viewer',hasStore=true,hasPublication=true}={}){
  const queries=[];let released=false;
  const client={async query(sql,args=[]){
    queries.push({sql,args});
    if(sql.includes('from mc.memberships'))return{rows:role?[{business_id:business,role}]:[]};
    if(sql.includes('from mc.stores'))return{rows:hasStore?[{id:store}]:[]};
    if(sql.includes("r.status='succeeded'"))return{rows:hasPublication?[{id:publication,published_at:'2026-10-04T00:00:00Z',run_id:business,request_id:business,
      method_version_id:business,code:'financial_result',implementation_version:'financial-result-v3'}]:[]};
    return{rows:[]};
  },release(){released=true;}};
  return{repository:createPublishedDrilldownRepository({pool:{async connect(){return client;}}}),queries,get released(){return released;}};
}
test('invalid context is rejected before connecting to the database',async()=>{
  let connected=false;
  const repository=createPublishedDrilldownRepository({pool:{async connect(){connected=true;throw new Error('unexpected_connection');}}});
  for(const change of [{publicationId:'bad'},{publicationSource:'current'},{periodStart:'2026-02-30'},{periodEnd:'2026-09-01'}]){
    await assert.rejects(()=>repository.readPublishedSkuList(user,{...input,...change}),/drilldown_invalid_request/);
  }
  assert.equal(connected,false);
});
test('pinned unsupported legacy publication returns unavailable and uses a read-only consistent transaction',async()=>{
  const state=fixture();
  const result=await state.repository.readPublishedSkuList(user,input);
  assert.equal(result.context.publication.id,publication);
  assert.equal(result.context.quality,'unavailable');
  assert.equal(result.context.totals,null);
  assert.ok(result.context.missingReasons.includes('drilldown_source_unsupported'));
  assert.equal(state.queries[0].sql,'begin isolation level repeatable read read only');
  assert.equal(state.queries.at(-1).sql,'commit');
  assert.equal(state.released,true);
  assert.equal(state.queries.some(({sql})=>/^\s*(insert|update|delete|call)\b/i.test(sql)),false);
});
test('membership, store and publication failures have one outward code and release the connection',async()=>{
  for(const options of [{role:null},{role:'unknown'},{hasStore:false},{hasPublication:false}]){
    const state=fixture(options);
    await assert.rejects(()=>state.repository.readPublishedSkuList(user,input),/drilldown_not_found/);
    assert.equal(state.queries.at(-1).sql,'rollback');assert.equal(state.released,true);
  }
});
test('a catalog product cannot be read outside frozen publication scope',async()=>{
  const state=fixture();
  await assert.rejects(()=>state.repository.readPublishedSkuCard(user,{...input,productId:user}),/drilldown_not_found/);
});
