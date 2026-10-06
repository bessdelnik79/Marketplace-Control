import assert from 'node:assert/strict';
import test from 'node:test';
import { createPublishedDrilldownRepository } from './drilldown.repository.mjs';

const user='11111111-1111-4111-8111-111111111111',store='22222222-2222-4222-8222-222222222222';
const publication='33333333-3333-4333-8333-333333333333',business='44444444-4444-4444-8444-444444444444';
const input={storeId:store,publicationId:publication,publicationSource:'legacy',periodStart:'2026-09-14',periodEnd:'2026-09-20'};
function fixture({role='viewer',hasStore=true,hasPublication=true,hasTariffAccess=true,complete=false}={}){
  const queries=[];let released=false;
  const lines=[['revenue','100.0000'],['logistics','-15.0000'],['cost_of_goods','-120.0000'],
    ['software_services','-10.0000'],['penalty','-5.0000']].map(([category_code,amount_signed],index)=>({
    id:`line-${index}`,financial_period_result_id:business,result_scope:'selected_product',product_id:user,variant_id:null,
    accounting_date:input.periodStart,category_code,amount_signed,quality:'complete'}));
  const client={async query(sql,args=[]){
    queries.push({sql,args});
    if(sql.includes('financial_tariff_scope_matches')||sql.includes('financial_daily_publication_tariff_allowed'))return{rows:[{allowed:hasTariffAccess}]};
    if(sql.includes('from mc.memberships'))return{rows:role?[{business_id:business,role}]:[]};
    if(sql.includes('from mc.stores'))return{rows:hasStore?[{id:store}]:[]};
    if(sql.includes("r.status='succeeded'"))return{rows:hasPublication?[{id:publication,published_at:'2026-10-04T00:00:00Z',run_id:business,request_id:business,
      method_version_id:business,code:'financial_result',implementation_version:complete?'financial-result-v36':'financial-result-v3'}]:[]};
    if(complete){
      if(sql.includes('from mc.calculation_request_products'))return{rows:[{product_id:user}]};
      if(sql.includes('select id as period_result_id'))return{rows:[{period_result_id:business,
        period_start:input.periodStart,period_end:input.periodEnd,quality:'complete',missing_reasons:[],
        totals:{selectedProductsResultBeforeTax:'-50.0000',storeLevelResultBeforeTax:'0.0000',
          availableResultBeforeTax:'-50.0000',estimatedUsnTax:null,availableResultAfterTax:null,netProfit:null}}]};
      if(sql.includes('from mc.result_lines'))return{rows:lines};
      if(sql.includes('from mc.products'))return{rows:[{id:user,title:'Товар',status:'active',historical_deleted:false}]};
    }
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
  for(const options of [{role:null},{role:'unknown'},{hasStore:false},{hasPublication:false},{hasTariffAccess:false}]){
    const state=fixture(options);
    await assert.rejects(()=>state.repository.readPublishedSkuList(user,input),/drilldown_not_found/);
    assert.equal(state.queries.at(-1).sql,'rollback');assert.equal(state.released,true);
  }
});
test('a catalog product cannot be read outside frozen publication scope',async()=>{
  const state=fixture();
  await assert.rejects(()=>state.repository.readPublishedSkuCard(user,{...input,productId:user}),/drilldown_not_found/);
});

test('unsupported publication has unknown situation count and no invented detail',async()=>{
  const state=fixture();const result=await state.repository.readPublishedSituations(user,input);
  assert.equal(result.status,'unavailable');assert.equal(result.total,null);assert.deepEqual(result.items,[]);
  assert.ok(result.context.missingReasons.includes('drilldown_source_unsupported'));
  await assert.rejects(()=>state.repository.readPublishedSituation(user,{...input,situationId:'penalty'}),/drilldown_not_found/);
  await assert.rejects(()=>state.repository.readPublishedSituation(user,{...input,situationId:'return_growth'}),/drilldown_not_found/);
});

test('product-loss detail reuses canonical SKU metrics and retains its saved before-tax basis',async()=>{
  const state=fixture({complete:true});
  const card=await state.repository.readPublishedSkuCard(user,{...input,productId:user});
  const detail=await state.repository.readPublishedSituation(user,{...input,situationId:`product_loss:${user}`});
  assert.equal(detail.reconciliation.status,'matched');
  assert.deepEqual(detail.item.metrics,card.item.metrics);
  assert.equal(detail.item.quality,card.item.quality);
  assert.deepEqual(detail.item.missingReasons,card.item.missingReasons);
  assert.equal(detail.item.metric.code,'available_result_before_tax');
  assert.equal(detail.item.metric.value,'-50.0000');
  assert.equal(detail.item.metrics.availableResultBeforeTax.amount,detail.item.metric.value);
  assert.equal(detail.item.metrics.availableResultAfterTax.amount,null);
  assert.equal(detail.item.metrics.revenue.amount,'100.0000');
  assert.equal(detail.item.metrics.wbExpenses.amount,'20.0000');
  assert.equal(detail.item.metrics.costOfGoods.amount,'120.0000');
  assert.equal(detail.item.metrics.externalExpenses.amount,'10.0000');
  const penalty=await state.repository.readPublishedSituation(user,{...input,situationId:'penalty'});
  for(const key of ['metrics','quality','missingReasons'])assert.equal(Object.hasOwn(penalty.item,key),false);
  assert.equal(penalty.item.metric.value,'-5.0000');
});
