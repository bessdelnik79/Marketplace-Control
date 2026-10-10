import assert from 'node:assert/strict';
import test from 'node:test';
import {cacheDailyPeriodRows,getCachedDailyPeriodRows,withPublishedPeriodCache} from './published-period-cache.mjs';
import {createPublishedDrilldownRepository} from './drilldown.repository.mjs';

const user='11111111-1111-4111-8111-111111111111',store='22222222-2222-4222-8222-222222222222';
const publication='33333333-3333-4333-8333-333333333333',business='44444444-4444-4444-8444-444444444444';
const generation='55555555-5555-4555-8555-555555555555',method='66666666-6666-4666-8666-666666666666';
const parser='77777777-7777-4777-8777-777777777777';
const key={businessId:business,storeId:store,publicationId:publication,periodStart:'2026-09-14',periodEnd:'2026-09-14'};
const input={...key,publicationSource:'daily'};
const emptyRows=()=>({days:[],lines:[],reasons:[],taxFacts:[]});
function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};}

test('daily rows require a request scope and complete exact publication identity',async()=>{
  assert.equal(cacheDailyPeriodRows(key,emptyRows()),false);
  assert.equal(getCachedDailyPeriodRows(key),null);
  await withPublishedPeriodCache(user,async()=>{
    const rows={...emptyRows(),days:[{accounting_date:key.periodStart}]};
    assert.equal(cacheDailyPeriodRows(key,rows),true);
    for(const field of Object.keys(key)){
      const incomplete={...key};delete incomplete[field];
      assert.equal(cacheDailyPeriodRows(incomplete,rows),false);
      assert.equal(getCachedDailyPeriodRows(incomplete),null);
      const foreign={...key,[field]:field.startsWith('period')?'2026-09-13':'88888888-8888-4888-8888-888888888888'};
      assert.equal(getCachedDailyPeriodRows(foreign),null);
    }
    assert.equal(getCachedDailyPeriodRows({...key,periodEnd:'2026-09-15'}),null);
    const nextPublication={...key,publicationId:'88888888-8888-4888-8888-888888888888'};
    assert.equal(cacheDailyPeriodRows(nextPublication,emptyRows()),true);
    assert.deepEqual(getCachedDailyPeriodRows(key),rows);
    assert.deepEqual(getCachedDailyPeriodRows(nextPublication),emptyRows());
    assert.equal(cacheDailyPeriodRows(key,{days:[]}),false);
  });
  assert.equal(getCachedDailyPeriodRows(key),null);
  await withPublishedPeriodCache(null,async()=>{
    assert.equal(cacheDailyPeriodRows(key,emptyRows()),false);
  });
});

test('stored and returned rows are detached without changing PostgreSQL value types',async()=>{
  await withPublishedPeriodCache(user,async()=>{
    const rows={...emptyRows(),lines:[{id:'line',amount_signed:'9007199254740991.1234',product_id:null,
      received_at:new Date('2026-09-14T00:00:00Z'),evidence:{ids:['source']}}]};
    const expected=structuredClone(rows);
    cacheDailyPeriodRows(key,rows);
    rows.lines[0].amount_signed='0.0000';rows.lines[0].evidence.ids.push('mutated-source');
    const read=getCachedDailyPeriodRows(key);
    assert.deepEqual(read,expected);
    read.lines[0].received_at.setUTCFullYear(2000);read.lines[0].evidence.ids.push('mutated-read');
    read.lines.push({id:'extra'});
    assert.deepEqual(getCachedDailyPeriodRows(key),expected);
  });
});

test('concurrent requests for the same user and period have separate caches',async()=>{
  const firstReady=deferred(),secondReady=deferred();
  await Promise.all([
    withPublishedPeriodCache(user,async()=>{
      cacheDailyPeriodRows(key,{...emptyRows(),lines:[{id:'first'}]});firstReady.resolve();
      await secondReady.promise;
      assert.equal(getCachedDailyPeriodRows(key).lines[0].id,'first');
    }),
    withPublishedPeriodCache(user,async()=>{
      await firstReady.promise;
      assert.equal(getCachedDailyPeriodRows(key),null);
      cacheDailyPeriodRows(key,{...emptyRows(),lines:[{id:'second'}]});secondReady.resolve();
      await Promise.resolve();
      assert.equal(getCachedDailyPeriodRows(key).lines[0].id,'second');
    })
  ]);
  assert.equal(getCachedDailyPeriodRows(key),null);
});

test('nested scopes restore their parent and failed scopes clear delayed continuations',async()=>{
  await withPublishedPeriodCache(user,async()=>{
    cacheDailyPeriodRows(key,{...emptyRows(),lines:[{id:'outer'}]});
    await withPublishedPeriodCache('other-user',async()=>{
      assert.equal(getCachedDailyPeriodRows(key),null);
      cacheDailyPeriodRows(key,{...emptyRows(),lines:[{id:'inner'}]});
    });
    assert.equal(getCachedDailyPeriodRows(key).lines[0].id,'outer');
  });
  const resume=deferred();let continuation;
  await assert.rejects(withPublishedPeriodCache(user,async()=>{
    cacheDailyPeriodRows(key,emptyRows());
    continuation=resume.promise.then(()=>({read:getCachedDailyPeriodRows(key),stored:cacheDailyPeriodRows(key,emptyRows())}));
    throw new Error('request_failed');
  }),/request_failed/);
  resume.resolve();
  assert.deepEqual(await continuation,{read:null,stored:false});
  await withPublishedPeriodCache(user,async()=>assert.equal(getCachedDailyPeriodRows(key),null));
});

function dailyFixture({role='viewer',hasStore=true,hasPublication=true,hasTariffAccess=true,incompatible=false,mismatch=false,unavailable=false}={}){
  const queries=[];let released=false;
  const days=[{accounting_date:key.periodStart,generation_id:generation,coverage_complete:true,quality:unavailable?'unavailable':'complete',
    tax_usable:true,store_profit_before_tax:'-5.0000',selected_profit_before_tax:mismatch?'-49.0000':'-50.0000',
    available_profit_before_tax:unavailable?null:'-55.0000',parser_method_version_id:parser,result_method_version_id:method}];
  const line=(id,category_code,amount_signed,scope='selected_product')=>({id,generation_id:generation,accounting_date:key.periodStart,
    scope,product_id:scope==='store'?null:user,variant_id:null,category_code,amount_signed,quality:'complete'});
  const financeLines=[line('a','cost_of_goods','-130.0000'),line('b','logistics','-10.0000'),line('c','penalty','-5.0000'),
    line('d','penalty','-5.0000'),line('f','revenue','100.0000'),line('e','penalty','-5.0000','store')];
  const lines=[...financeLines.slice(0,4),financeLines[5],financeLines[4]];
  const fact=id=>({id,generation_id:generation,accounting_date:key.periodStart,product_id:user,tax_setting_version_id:`tax-${id}`,
    tax_base_unrounded:'50.000000000000',tax_numerator_unrounded:'3.000000000000',tax_rate_fraction:'0.060000000000'});
  const facts=[fact('fact-a'),fact('fact-b')];
  const cachedRows={days:days.map(day=>({...day,empty_evidence_revoked:true})),lines:financeLines,reasons:[],taxFacts:[facts[1],facts[0]]};
  const client={async query(sql,args=[]){
    queries.push({sql,args});
    if(sql.includes('from mc.memberships'))return{rows:role?[{business_id:business,role}]:[]};
    if(sql.includes('from mc.stores'))return{rows:hasStore?[{id:store}]:[]};
    if(sql.includes('from mc.financial_daily_publications p join'))return{rows:hasPublication?[{id:publication,
      published_at:'2026-10-04T00:00:00Z',generation_id:generation,watermark_generation:'1',result_method_version_id:method,
      parser_method_version_id:parser,code:'financial_result',implementation_version:'financial-result-v36'}]:[]};
    if(sql.includes('join mc.financial_daily_days'))return{rows:structuredClone(days)};
    if(sql.includes('from mc.financial_daily_generations generation where'))return{rows:[{id:generation,
      parser_method_version_id:parser,result_method_version_id:method,product_ids:[user]},...(incompatible?[{id:'carried',
      parser_method_version_id:'other-parser',result_method_version_id:method,product_ids:[user]}]:[])]};
    if(sql.includes('join mc.financial_daily_results'))return{rows:structuredClone(lines)};
    if(sql.includes('join mc.financial_daily_reasons'))return{rows:[]};
    if(sql.includes('join mc.financial_daily_tax_facts'))return{rows:structuredClone(facts)};
    if(sql.includes('financial_tariff_scope_matches')||sql.includes('financial_daily_publication_tariff_allowed'))return{rows:[{allowed:hasTariffAccess}]};
    if(sql.includes('from mc.products'))return{rows:[{id:user,title:'Товар',status:'active',historical_deleted:false}]};
    if(sql.includes('from mc.financial_daily_current_publications'))return{rows:[{id:publication,watermark_generation:'1'}]};
    return{rows:[]};
  },release(){released=true;}};
  return{repository:createPublishedDrilldownRepository({pool:{async connect(){return client;}}}),queries,cachedRows,get released(){return released;}};
}
function rawReadCount(state){return state.queries.filter(({sql})=>/join mc\.financial_daily_(days|results|reasons|tax_facts)\b/.test(sql)).length;}

test('daily situation reuse skips exactly four raw reads and preserves the public result and tax order',async()=>{
  const miss=dailyFixture(),hit=dailyFixture();
  const expected=await miss.repository.readPublishedSituations(user,input);
  const actual=await withPublishedPeriodCache(user,async()=>{
    cacheDailyPeriodRows(key,hit.cachedRows);
    const result=await hit.repository.readPublishedSituations(user,input);
    assert.deepEqual(getCachedDailyPeriodRows(key),hit.cachedRows);
    return result;
  });
  assert.equal(JSON.stringify(actual),JSON.stringify(expected));
  assert.equal(actual.context.quality,'complete');assert.equal(actual.reconciliation.status,'matched');
  assert.deepEqual(actual.reconciliation.checks.filter(row=>row.code==='tax_fact_numerator').map(row=>row.scope.taxFactId),['fact-a','fact-b']);
  assert.equal(rawReadCount(miss),4);assert.equal(rawReadCount(hit),0);
  assert.equal(miss.queries.length-hit.queries.length,4);
  assert.equal(hit.queries.some(({sql})=>sql.includes('from mc.financial_daily_generations generation where')),true);
  assert.equal(hit.queries.some(({sql})=>sql.includes('from mc.products')),true);
  assert.equal(hit.queries.some(({sql})=>sql.includes('from mc.jobs')),true);
  assert.equal(hit.queries[0].sql,'begin isolation level repeatable read read only');
  assert.equal(hit.queries.at(-1).sql,'commit');assert.equal(hit.released,true);
});

test('cached daily rows keep access, full-map compatibility, reconciliation and unavailable guards',async()=>{
  for(const options of [{role:null},{hasStore:false},{hasPublication:false},{hasTariffAccess:false}]){
    const state=dailyFixture(options);
    await withPublishedPeriodCache(user,async()=>{
      cacheDailyPeriodRows(key,state.cachedRows);
      await assert.rejects(state.repository.readPublishedSituations(user,input),/drilldown_not_found/);
    });
    assert.equal(state.queries.at(-1).sql,'rollback');assert.equal(state.released,true);
  }
  for(const options of [{incompatible:true},{mismatch:true},{unavailable:true}]){
    const miss=dailyFixture(options),hit=dailyFixture(options);
    const expected=await miss.repository.readPublishedSituations(user,input);
    const actual=await withPublishedPeriodCache(user,async()=>{
      cacheDailyPeriodRows(key,hit.cachedRows);
      return hit.repository.readPublishedSituations(user,input);
    });
    assert.equal(JSON.stringify(actual),JSON.stringify(expected));
    assert.equal(actual.status,'unavailable');
    if(options.incompatible)assert.ok(actual.context.missingReasons.includes('drilldown_publication_incompatible'));
    if(options.mismatch)assert.equal(actual.reconciliation.status,'mismatch');
    if(options.unavailable)assert.equal(actual.context.totals,null);
    assert.equal(rawReadCount(hit),0);
  }
});
