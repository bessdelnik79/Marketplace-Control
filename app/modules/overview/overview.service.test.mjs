import test from 'node:test';
import assert from 'node:assert/strict';
import { getFinancialOverview, getOverviewState } from './overview.service.mjs';
import { previousFourCalendarPeriods } from './financial-overview.mjs';
import { getPublishedFinancialPeriodPair } from '../calculation/calculation.repository.mjs';
import { pool } from '../../infrastructure/database/client.mjs';

function period(start, end, { quality = 'complete', missingReasons = [] } = {}) {
  return {
    period_start: start,
    period_end: end,
    quality,
    missing_reasons: missingReasons,
    source_freshness: new Date(`${end}T23:00:00Z`),
    covered_period: { start, end },
    lines: [
      { result_scope: 'selected_product', product_id:'product-a', accounting_date: start, category_code: 'revenue', amount_signed: '100.0000', quality },
      { result_scope: 'selected_product', product_id:'product-a', accounting_date: end, category_code: 'commission', amount_signed: '-20.0000', quality },
      { result_scope: 'selected_product', product_id:'product-a', accounting_date: end, category_code: 'estimated_usn_tax', amount_signed: '-6.0000', quality }
    ],
    totals: {
      selectedProductsResultBeforeTax: '80.0000',
      availableResultBeforeTax: '80.0000',
      estimatedUsnTax: '6.0000',
      availableResultAfterTax: '74.0000'
    },
    cross_border_buyout: { present: false, reportCount: 0 },
    taxReference: { scope: 'selected_products', usable: true, includedInResult: true, estimatedTax: '6.0000' }
  };
}

function pair(overrides = {}) {
  const current=overrides.current===undefined?period('2026-09-14','2026-09-20'):overrides.current;
  return {
    publication_id: 'publication-1',
    publication_source: 'daily',
    published_at: new Date('2026-09-21T10:00:00Z'),
    update_status:{status:'pending',updatedAt:new Date('2026-09-21T11:00:00Z'),lastErrorCode:null,affectedPeriod:{start:'2026-09-14',end:'2026-09-20'}},
    method_version: 'financial-result-v5',
    scope: { type: 'selected_products', productIds: ['product-b', 'product-a'] },
    current: period('2026-09-14', '2026-09-20'),
    previous: period('2026-09-07', '2026-09-13'),
    history:current?previousFourCalendarPeriods({start:current.period_start,end:current.period_end}).map((value,index)=>
      index===0&&overrides.previous!==undefined?overrides.previous:period(value.start,value.end)):[],
    ...overrides
  };
}

test('service requests four preceding weeks atomically and exposes publication provenance and exact scope', async () => {
  let request;
  const overview = await getFinancialOverview('user-1', 'store-1', '2026-09-17', {
    loadPeriodPair: async (...args) => { request = args; return pair(); }
  });
  assert.deepEqual(request, ['user-1', 'store-1', {
    periodStart: '2026-09-14', periodEnd: '2026-09-20',
    previousPeriodStart: '2026-09-07', previousPeriodEnd: '2026-09-13',
    comparisonPeriods:previousFourCalendarPeriods({start:'2026-09-14',end:'2026-09-20'})
  }]);
  assert.equal(overview.status, 'available');
  assert.equal(overview.publicationId, 'publication-1');
  assert.equal(overview.publicationSource,'daily');
  assert.equal(overview.updateStatus.status,'pending');
  assert.equal(overview.publishedAt, '2026-09-21T10:00:00.000Z');
  assert.equal(overview.sourceFreshness, '2026-09-20T23:00:00.000Z');
  assert.deepEqual(overview.requestedPeriod, { start: '2026-09-14', end: '2026-09-20', timezone: 'Europe/Moscow' });
  assert.deepEqual(overview.coveredPeriod, { start: '2026-09-14', end: '2026-09-20' });
  assert.deepEqual(overview.scope, { type: 'selected_products', productIds: ['product-a', 'product-b'] });
  assert.equal(overview.comparison.comparable, true);
  assert.equal(overview.publishedExact,true);
  assert.deepEqual(overview.crossBorderBuyout,{present:false,reportCount:0});
});

test('service hides a publication produced by an obsolete financial method while exact recalculation is pending',async()=>{
  const overview=await getFinancialOverview('user-1','store-1','2026-09-14',{
    loadPeriodPair:async()=>pair({
      method_version:'financial-result-v28',
      method_upgrade_pending:true,
      update_status:{status:'pending',updatedAt:new Date('2026-09-29T08:00:00Z'),lastErrorCode:null,
        affectedPeriod:{start:'2026-09-14',end:'2026-09-20'},methodUpgradePending:true}
    })
  });
  assert.equal(overview.status,'unavailable');
  assert.equal(overview.quality,'unavailable');
  assert.equal(overview.totals,null);
  assert.equal(overview.displayResult,null);
  assert.deepEqual(overview.missingReasons,['financial_method_upgrade_pending']);
  assert.equal(overview.updateStatus.methodUpgradePending,true);
});

test('service keeps an unmapped period unavailable instead of falling back while the exact method is pending',async()=>{
  const overview=await getFinancialOverview('user-1','store-1','2026-08-03',{
    loadPeriodPair:async()=>pair({method_version:'financial-result-v28',method_upgrade_pending:true,current:null,previous:null,
      update_status:{status:'pending',methodUpgradePending:true,updatedAt:new Date('2026-09-29T08:00:00Z')}})
  });
  assert.equal(overview.status,'unavailable');
  assert.equal(overview.totals,null);
  assert.deepEqual(overview.missingReasons,['financial_method_upgrade_pending']);
  assert.equal(overview.updateStatus.methodUpgradePending,true);
});

test('service requests four exact preceding arbitrary published ranges', async () => {
  let request;
  const current = period('2026-08-19', '2026-09-25');
  const previous = period('2026-07-12', '2026-08-18');
  const overview = await getFinancialOverview('user-1', 'store-1', '2026-08-19', '2026-09-25', {
    loadPeriodPair: async (...args) => { request = args; return pair({ current, previous }); }
  });
  assert.deepEqual(request, ['user-1', 'store-1', {
    periodStart: '2026-08-19', periodEnd: '2026-09-25',
    previousPeriodStart: '2026-07-12', previousPeriodEnd: '2026-08-18',
    comparisonPeriods:previousFourCalendarPeriods({start:'2026-08-19',end:'2026-09-25'})
  }]);
  assert.deepEqual(overview.period, { start: '2026-08-19', end: '2026-09-25', timezone: 'Europe/Moscow' });
  assert.deepEqual(overview.comparison.period, { start: '2026-07-12', end: '2026-08-18', timezone: 'Europe/Moscow' });
});

test('service requires all four history periods and suppresses a partial fourth period',async()=>{
  const data=pair();
  const positive=await getFinancialOverview('user-1','store-1','2026-09-14',{loadPeriodPair:async()=>data});
  assert.equal(positive.comparison.baseline,'median_four_periods');
  assert.equal(positive.comparison.amount,'74.0000');
  assert.equal(positive.comparison.changePercent,'0.0000');
  for(const history of [data.history.slice(0,3),[...data.history.slice(0,3),null]]){
    const overview=await getFinancialOverview('user-1','store-1','2026-09-14',{loadPeriodPair:async()=>pair({history})});
    assert.equal(overview.comparison.changePercent,null);
    assert.equal(overview.comparison.reason,'previous_period_unavailable');
    assert.equal(overview.displayResult.amount,'74.0000');
  }
  const history=[...data.history];
  history[3]=period(history[3].period_start,history[3].period_end,{quality:'partial',missingReasons:['cost_missing']});
  const overview=await getFinancialOverview('user-1','store-1','2026-09-14',{loadPeriodPair:async()=>pair({history})});
  assert.equal(overview.comparison.changePercent,null);
  assert.equal(overview.comparison.reason,'incomparable_coverage');
});

test('service preserves an uncovered requested range and exposes it as unavailable',async()=>{
  const requested={start:'2026-08-01',end:'2026-09-25',timezone:'Europe/Moscow'};
  const overview=await getFinancialOverview('user-1','store-1',requested.start,requested.end,{
    loadPeriodPair:async()=>({
      publication_id:'publication-1',published_at:new Date('2026-09-25T10:00:00Z'),method_version:'financial-result-v5',
      scope:{type:'selected_products',productIds:['product-1']},
      current:{period_start:requested.start,period_end:requested.end,quality:'unavailable',missing_reasons:['report_coverage_incomplete'],
        totals:null,lines:[],source_freshness:new Date('2026-09-25T09:00:00Z'),covered_period:{start:'2026-08-03',end:'2026-09-20'},
        cross_border_buyout:{present:null,reportCount:null}},previous:null
    })
  });
  assert.equal(overview.status,'unavailable');
  assert.deepEqual(overview.requestedPeriod,requested);
  assert.deepEqual(overview.coveredPeriod,{start:'2026-08-03',end:'2026-09-20'});
  assert.deepEqual(overview.missingReasons,['report_coverage_incomplete']);
  assert.equal(overview.totals.revenue,null);
  assert.deepEqual(overview.crossBorderBuyout,{present:null,reportCount:null});
  assert.equal(overview.comparison.comparable,false);
});

test('partial periods never show a percentage without proven comparable coverage', async () => {
  const partial = period('2026-09-14', '2026-09-20', { quality: 'partial', missingReasons: ['cost_missing'] });
  const previous = period('2026-09-07', '2026-09-13', { quality: 'partial', missingReasons: ['cost_missing'] });
  const overview = await getFinancialOverview('user-1', 'store-1', '2026-09-14', {
    loadPeriodPair: async () => pair({ current: partial, previous })
  });
  assert.equal(overview.comparison.comparable, false);
  assert.equal(overview.comparison.changePercent, null);
  assert.equal(overview.comparison.reason, 'incomparable_coverage');
});

test('financial overview exposes proven foreign buyout metadata without changing totals',async()=>{
  const current=period('2026-09-14','2026-09-20');
  current.cross_border_buyout={present:true,reportCount:2};
  const overview=await getFinancialOverview('user-1','store-1','2026-09-14',{loadPeriodPair:async()=>pair({current})});
  assert.deepEqual(overview.crossBorderBuyout,{present:true,reportCount:2});
  assert.equal(overview.totals.availableResultAfterTax,'74.0000');
});

test('missing persisted week returns an explicit unavailable model without recalculation', async () => {
  const overview = await getFinancialOverview('user-1', 'store-1', '2026-09-15', {
    loadPeriodPair: async () => pair({ current: null, previous: null })
  });
  assert.equal(overview.status, 'unavailable');
  assert.equal(overview.quality, 'unavailable');
  assert.deepEqual(overview.requestedPeriod, { start: '2026-09-14', end: '2026-09-20', timezone: 'Europe/Moscow' });
  assert.equal(overview.coveredPeriod, null);
  assert.deepEqual(overview.missingReasons, ['published_period_missing']);
  assert.equal(overview.comparison.changePercent, null);
});

test('missing selected week requests the latest publication and four preceding periods once',async()=>{
  const requests=[];
  const overview=await getFinancialOverview('user-1','store-1',null,{loadPeriodPair:async(...args)=>{requests.push(args);return pair();}});
  assert.deepEqual(requests,[['user-1','store-1',{comparisonPeriodCount:4}]]);
  assert.deepEqual(overview.period,{start:'2026-09-14',end:'2026-09-20',timezone:'Europe/Moscow'});
  assert.equal(overview.comparison.comparable,true);
});

test('latest arbitrary period retains the fallback for older injected readers', async () => {
  const requests = [];
  const current = period('2026-08-19', '2026-09-25');
  const previous = period('2026-07-12', '2026-08-18');
  const overview = await getFinancialOverview('user-1', 'store-1', null, {
    loadPeriodPair: async (...args) => {
      requests.push(args);
      return requests.length === 1
        ? pair({ current, history:[], previous: period('2026-08-12', '2026-09-18') })
        : pair({ current, previous });
    }
  });
  assert.equal(requests.length,2);
  assert.deepEqual(requests[0],['user-1','store-1',{comparisonPeriodCount:4}]);
  assert.deepEqual(requests.at(-1), ['user-1', 'store-1', {
    periodStart: '2026-08-19', periodEnd: '2026-09-25',
    previousPeriodStart: '2026-07-12', previousPeriodEnd: '2026-08-18',
    comparisonPeriods:previousFourCalendarPeriods({start:'2026-08-19',end:'2026-09-25'})
  }]);
  assert.deepEqual(overview.comparison.period, { start: '2026-07-12', end: '2026-08-18', timezone: 'Europe/Moscow' });
});

test('latest arbitrary published range with complete history is read once',async()=>{
  const current=period('2026-08-19','2026-09-25'),previous=period('2026-07-12','2026-08-18');
  const requests=[];
  const overview=await getFinancialOverview('user-1','store-1',null,{
    loadPeriodPair:async(...args)=>{requests.push(args);return pair({current,previous});}
  });
  assert.deepEqual(requests,[['user-1','store-1',{comparisonPeriodCount:4}]]);
  assert.equal(overview.comparison.comparable,true);
  assert.deepEqual(overview.comparison.period,{start:previous.period_start,end:previous.period_end,timezone:'Europe/Moscow'});
});

test('latest missing history remains unavailable without a second publication read',async()=>{
  for(const missingIndex of [0,3]){
    const data=pair();
    data.history[missingIndex]=null;
    if(missingIndex===0)data.previous=null;
    let reads=0;
    const overview=await getFinancialOverview('user-1','store-1',null,{
      loadPeriodPair:async()=>{reads+=1;return data;}
    });
    assert.equal(reads,1);
    assert.equal(overview.publicationId,'publication-1');
    assert.equal(overview.displayResult.amount,'74.0000');
    assert.equal(overview.comparison.changePercent,null);
    assert.equal(overview.comparison.reason,'previous_period_unavailable');
  }
});

test('latest obsolete method is kept unavailable after one history read',async()=>{
  let reads=0;
  const overview=await getFinancialOverview('user-1','store-1',null,{
    loadPeriodPair:async()=>{reads+=1;return pair({method_version:'financial-result-v28',method_upgrade_pending:true});}
  });
  assert.equal(reads,1);
  assert.equal(overview.status,'unavailable');
  assert.equal(overview.displayResult,null);
  assert.deepEqual(overview.missingReasons,['financial_method_upgrade_pending']);
  assert.equal(overview.comparison.changePercent,null);
});

test('latest legacy reader resolves calendar and arbitrary history within its original publication',async t=>{
  let selected,queries;
  const client={release(){},async query(sql,values){
    queries.push([sql,values]);
    if(sql.includes('from mc.memberships'))return{rows:[{business_id:'business-1',role:'owner'}]};
    if(sql.includes('from mc.publications p join mc.calculation_runs r'))return{rows:[{
      publication_id:'legacy-1',run_id:'run-1',request_id:'request-1',method_version:'financial-result-v5',published_at:new Date('2026-09-21T10:00:00Z')
    }]};
    if(sql.includes('from mc.calculation_request_products'))return{rows:[{product_id:'product-a'}]};
    if(sql.includes('mc.financial_tariff_scope_matches'))return{rows:[{allowed:true}]};
    if(sql.includes('order by period_end desc,period_start desc limit 1'))return{rows:[{
      period_start:selected.start,period_end:selected.end
    }]};
    if(sql.includes('select id as period_result_id'))return{rows:[{
      ...period(values[1],values[2]),period_result_id:`${values[1]}:${values[2]}`
    }]};
    return{rows:[]};
  }};
  t.mock.method(pool,'connect',async()=>client);
  for(selected of [{start:'2026-03-01',end:'2026-03-31'},{start:'2026-07-01',end:'2026-09-30'},
    {start:'2024-01-01',end:'2024-12-31'},{start:'2026-08-19',end:'2026-09-25'},
    {start:'2026-03-28',end:'2026-04-26'}]){
    queries=[];
    const data=await getPublishedFinancialPeriodPair('user-1','store-1',{comparisonPeriodCount:4});
    const expected=previousFourCalendarPeriods(selected);
    assert.equal(data.publication_id,'legacy-1');
    assert.equal(data.method_version,'financial-result-v5');
    assert.equal(data.history[0],data.previous);
    assert.deepEqual(data.history.map(value=>[value.period_start,value.period_end]),expected.map(value=>[value.start,value.end]));
    const envelopes=queries.filter(([sql])=>sql.includes('select id as period_result_id'));
    assert.deepEqual(envelopes.map(([,values])=>values),[selected,...expected].map(value=>['run-1',value.start,value.end]));
    assert.equal(queries.filter(([sql])=>sql==='begin').length,1);
  }
  queries=[];
  const original=await getPublishedFinancialPeriodPair('user-1','store-1');
  assert.deepEqual(original.history,[]);
  assert.equal(queries.filter(([sql])=>sql.includes('select id as period_result_id')).length,2);
});

test('reader rejects unbounded comparison counts before opening a database transaction',async t=>{
  const connect=t.mock.method(pool,'connect',()=>{throw new Error('unexpected_database_access');});
  for(const count of [-1,5,1.5,'4']){
    await assert.rejects(()=>getPublishedFinancialPeriodPair('user-1','store-1',{comparisonPeriodCount:count}),{
      message:'calculation_invalid_comparison_period_count'
    });
  }
  assert.equal(connect.mock.callCount(),0);
});

test('service rejects invalid date and foreign or missing publication stays absent', async () => {
  await assert.rejects(() => getFinancialOverview('user-1', 'store-1', '2026-02-29', { loadPeriodPair: async () => pair() }), { message: 'overview_invalid_date' });
  assert.equal(await getFinancialOverview('user-1', 'foreign-store', '2026-09-14', { loadPeriodPair: async () => null }), null);
});

test('service rejects reversed and overlong explicit periods before repository access', async () => {
  let reads = 0;
  const loadPeriodPair = async () => { reads += 1; return pair(); };
  await assert.rejects(() => getFinancialOverview('user-1', 'store-1', '2026-09-20', '2026-09-19', { loadPeriodPair }), { message: 'overview_invalid_period' });
  await assert.rejects(() => getFinancialOverview('user-1', 'store-1', '2025-09-01', '2026-09-02', { loadPeriodPair }), { message: 'overview_invalid_period' });
  await assert.rejects(() => getFinancialOverview('user-1', 'store-1', null, '2026-09-02', { loadPeriodPair }), { message: 'overview_invalid_period' });
  assert.equal(reads, 0);
});

test('unified overview keeps independent periods and stable empty situations',async()=>{
  const state=await getOverviewState('user-1',{storeId:'store-1',financialPeriodStart:'2026-09-14'},
    {loadPeriodPair:async()=>pair(),loadOperationalData:async()=>({
      store:{id:'store-1',name:'Основной',status:'active',marketplace_code:'wb',connected:true},
      current:null,rows:[]
    })});
  assert.equal(state.store.name,'Основной');
  assert.equal(state.financial.status,'available');
  assert.equal(state.operational.status,'unavailable');
  assert.equal(state.situations.status,'partial');
  assert.equal(state.situations.total,0);
  assert.deepEqual(state.situations.disabledRules,['return_growth']);
});

test('unified overview returns null for a foreign store without reading finance',async()=>{
  let financeRead=false;
  const state=await getOverviewState('user-1',{storeId:'foreign',financialPeriodStart:'2026-09-14'},
    {loadOperationalData:async()=>null,loadPeriodPair:async()=>{financeRead=true;return pair();}});
  assert.equal(state,null);
  assert.equal(financeRead,false);
});

test('unified overview keeps a stable unavailable financial envelope',async()=>{
  const state=await getOverviewState('user-1',{storeId:'store-1',financialPeriodStart:'2026-09-14'},
    {loadPeriodPair:async()=>null,loadOperationalData:async()=>({
      store:{id:'store-1',name:'Основной',status:'active',marketplace_code:'wb',connected:true},current:null,rows:[]
    })});
  assert.equal(state.financial.status,'unavailable');
  assert.equal(state.financial.publicationId,null);
  assert.equal(state.financial.totals,null);
  assert.deepEqual(state.financial.crossBorderBuyout,{present:null,reportCount:null});
  assert.equal(state.situations.total,null);
});
