import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateDailyPublicationPeriod,aggregatePublishedPeriodEnvelopes,blocksLegacyFinancialFallback,classifyNormalizationRecovery,compatibleFinancialParserVersions,getPublishedFinancialPeriodPair,loadDailyPeriodEnvelopes,loadPublishedPeriodEnvelopes,methodUpgradeUpdateStatus,missingNormalizationRanges,prepareFinancialCalculation,reportPeriodsCoverRange,selectFullyNormalizedReportPeriods } from './calculation.repository.mjs';
import { buildFinancialPeriodOverview } from '../overview/financial-overview.mjs';
import { pool } from '../../infrastructure/database/client.mjs';
import { getCachedDailyPeriodRows,withPublishedPeriodCache } from './published-period-cache.mjs';

function envelope(start,end,{quality='complete',missingReasons=[],amount='10.0000',freshness=`${end}T10:00:00Z`,crossBorder=0}={}){
  return{
    period_start:start,period_end:end,quality,missingReasons,source_freshness:freshness,
    totals:{selectedProductsResultBeforeTax:amount,storeLevelResultBeforeTax:'0.0000',availableResultBeforeTax:amount,estimatedUsnTax:'0.6000',availableResultAfterTax:'9.4000',netProfit:'9.4000'},
    cross_border_buyout:{present:crossBorder>0,reportCount:crossBorder},
    lines:[
      {result_scope:'selected_product',product_id:'product-1',accounting_date:start,category_code:'revenue',amount_signed:amount,quality},
      {result_scope:'selected_product',product_id:'product-1',accounting_date:end,category_code:'estimated_usn_tax',amount_signed:'-0.6000',quality}
    ],
    taxReference:{usable:true,includedInResult:true,taxableBase:amount,estimatedTax:'0.6000',products:[{productId:'product-1',taxableBase:amount,estimatedTax:'0.6000'}],segments:[]}
  };
}

test('current financial parser keeps v12 and v11 as compatibility fallbacks',()=>{
  assert.deepEqual(compatibleFinancialParserVersions.slice(0,3),['wb-finance-v13','wb-finance-v12','wb-finance-v11']);
  assert.match(prepareFinancialCalculation.toString(),/target\?36:35/);
});

test('exact-method status keeps loading while v13 inputs are pending but exposes a terminal daily failure when ready',()=>{
  const job={status:'failed',last_error_code:'financial_daily_publication_scope_incompatible',updated_at:'2026-09-29T08:00:00Z',
    affected_from:'2025-11-24',affected_to:'2026-09-27'};
  assert.deepEqual(methodUpgradeUpdateStatus({job,inputsPending:true,publicationId:'old',canRetry:true}),{
    status:'pending',publicationId:'old',updatedAt:job.updated_at,lastErrorCode:null,
    affectedPeriod:{start:job.affected_from,end:job.affected_to},canRetry:false,methodUpgradePending:true
  });
  assert.deepEqual(methodUpgradeUpdateStatus({job,inputsPending:false,publicationId:'old',canRetry:true}),{
    status:'failed',publicationId:'old',updatedAt:job.updated_at,lastErrorCode:job.last_error_code,
    affectedPeriod:{start:job.affected_from,end:job.affected_to},canRetry:true,methodUpgradePending:true
  });
});

test('obsolete daily publication blocks fallback to a legacy calculation outside its mapped range',()=>{
  assert.equal(blocksLegacyFinancialFallback({method_upgrade_pending:true,method_version:'financial-result-v28'}),true);
  assert.equal(blocksLegacyFinancialFallback({method_upgrade_pending:false,method_version:'financial-result-v30'}),false);
  assert.equal(blocksLegacyFinancialFallback(null),false);
});

test('excludes an entire report period when one accepted report lacks current normalization',()=>{
  const reports=[
    {report_id:'report-1',report_version_id:'version-1',period_start:'2026-09-01',period_end:'2026-09-07',normalization_id:'normalization-1'},
    {report_id:'report-2',report_version_id:'version-2',period_start:'2026-09-01',period_end:'2026-09-07',normalization_id:null},
    {report_id:'report-3',report_version_id:'version-3',period_start:'2026-09-08',period_end:'2026-09-14',normalization_id:'normalization-3'}
  ];
  assert.deepEqual(selectFullyNormalizedReportPeriods(reports),[reports[2]]);
});

test('retains a fully normalized latest period despite an older legacy period',()=>{
  const latest={report_id:'report-latest',report_version_id:'version-latest',period_start:'2026-09-08',period_end:'2026-09-14',normalization_id:'normalization-latest'};
  assert.deepEqual(selectFullyNormalizedReportPeriods([
    latest,
    {report_id:'report-legacy',report_version_id:'version-legacy',period_start:'2026-09-01',period_end:'2026-09-07',normalization_id:null}
  ]),[latest]);
});

test('orders fully normalized periods and their reports deterministically',()=>{
  const reports=[
    {report_id:'report-b',report_version_id:'version-b',period_start:'2026-09-08',period_end:'2026-09-14',normalization_id:'normalization-b'},
    {report_id:'report-c',report_version_id:'version-c',period_start:'2026-09-15',period_end:'2026-09-21',normalization_id:'normalization-c'},
    {report_id:'report-a',report_version_id:'version-a',period_start:'2026-09-08',period_end:'2026-09-14',normalization_id:'normalization-a'}
  ];
  assert.deepEqual(selectFullyNormalizedReportPeriods(reports),[reports[2],reports[0],reports[1]]);
});

test('recognizes an arbitrary target range covered across adjacent report periods',()=>{
  const reports=[
    {period_start:'2026-09-07',period_end:'2026-09-13'},
    {period_start:'2026-09-14',period_end:'2026-09-20'}
  ];
  assert.equal(reportPeriodsCoverRange(reports,'2026-09-10','2026-09-19'),true);
  assert.equal(reportPeriodsCoverRange(reports,'2026-09-06','2026-09-19'),false);
  assert.equal(reportPeriodsCoverRange([reports[1]],'2026-09-10','2026-09-19'),false);
});

test('identifies accepted report periods that need the current normalization',()=>{
  const reports=[
    {period_start:'2026-08-10',period_end:'2026-08-16',normalization_id:null},
    {period_start:'2026-08-17',period_end:'2026-08-23',normalization_id:'normalization-current'},
    {period_start:'2026-08-24',period_end:'2026-08-30',normalization_id:null}
  ];
  assert.deepEqual(missingNormalizationRanges(reports,'2026-08-10','2026-08-19'),[
    {periodStart:'2026-08-10',periodEnd:'2026-08-16'}
  ]);
});

test('target normalization recovery stops after a durable failure and ignores stale runs',()=>{
  const ranges=[{periodStart:'2026-08-10',periodEnd:'2026-08-16'}];
  const candidates=[{period_start:'2026-08-10',period_end:'2026-08-16',normalization_id:null,accepted_at:'2026-09-26T10:00:00Z'}];
  assert.deepEqual(classifyNormalizationRecovery(ranges,candidates,[]),{status:'normalization_required',ranges});
  assert.deepEqual(classifyNormalizationRecovery(ranges,candidates,[{
    requested_from:'2026-08-10',requested_to:'2026-08-16',status:'failed',started_at:'2026-09-26T09:00:00Z',error_code:'old_failure'
  }],{now:new Date('2026-09-26T12:00:00Z')}),{status:'normalization_required',ranges});
  assert.deepEqual(classifyNormalizationRecovery(ranges,candidates,[{
    requested_from:'2026-08-10',requested_to:'2026-08-16',status:'failed',started_at:'2026-09-26T11:00:00Z',error_code:'financial_unauthorized'
  }]),{status:'normalization_failed',reason:'financial_unauthorized',ranges});
  assert.deepEqual(classifyNormalizationRecovery(ranges,candidates,[{
    requested_from:'2026-08-10',requested_to:'2026-08-16',status:'running',started_at:'2026-09-26T11:00:00Z',error_code:null
  }],{now:new Date('2026-09-26T12:00:00Z')}),{status:'normalization_running',ranges});
  assert.deepEqual(classifyNormalizationRecovery(ranges,candidates,[{
    requested_from:'2026-08-10',requested_to:'2026-08-16',status:'running',started_at:'2026-09-26T08:00:00Z',error_code:null
  }],{now:new Date('2026-09-26T12:00:00Z')}),{status:'normalization_required',ranges});
});

test('successful targeted sync without a current normalization requires manual retry',()=>{
  const ranges=[{periodStart:'2026-08-10',periodEnd:'2026-08-16'}],candidates=[{
    period_start:'2026-08-10',period_end:'2026-08-16',normalization_id:null,accepted_at:'2026-09-26T10:00:00Z'
  }];
  assert.deepEqual(classifyNormalizationRecovery(ranges,candidates,[{
    requested_from:'2026-08-10',requested_to:'2026-08-16',status:'succeeded',started_at:'2026-09-26T11:00:00Z',error_code:null
  }]),{status:'normalization_failed',reason:'financial_target_normalization_missing',ranges});
});

test('aggregates a fully covered arbitrary range using exact scale-4 persisted totals',()=>{
  const result=aggregatePublishedPeriodEnvelopes('2026-08-03','2026-08-16',[
    envelope('2026-08-10','2026-08-16',{amount:'9007199254740991.1234',crossBorder:1}),
    envelope('2026-08-03','2026-08-09',{quality:'partial',missingReasons:['cost_missing'],amount:'0.0001'})
  ]);
  assert.equal(result.quality,'partial');
  assert.deepEqual(result.missing_reasons,['cost_missing']);
  assert.equal(result.totals.availableResultBeforeTax,'9007199254740991.1235');
  assert.deepEqual(result.covered_period,{start:'2026-08-03',end:'2026-08-16'});
  assert.equal(result.lines.length,4);
  assert.deepEqual(result.cross_border_buyout,{present:true,reportCount:1});
  assert.equal(result.taxReference.estimatedTax,'1.2000');
});

test('does not invent totals when requested boundaries are not covered',()=>{
  const result=aggregatePublishedPeriodEnvelopes('2026-08-01','2026-09-25',[
    envelope('2026-08-03','2026-09-13'),
    envelope('2026-09-14','2026-09-20')
  ]);
  assert.equal(result.quality,'unavailable');
  assert.equal(result.totals,null);
  assert.deepEqual(result.lines,[]);
  assert.ok(result.missing_reasons.includes('report_coverage_incomplete'));
  assert.deepEqual(result.covered_period,{start:'2026-08-03',end:'2026-09-20'});
  assert.deepEqual(result.cross_border_buyout,{present:null,reportCount:null});
});

test('a structurally covered range with an unavailable child exposes no values',()=>{
  const unavailable=envelope('2026-08-10','2026-08-16',{quality:'unavailable',missingReasons:['source_unreconciled']});
  unavailable.totals=null;
  unavailable.lines=[];
  unavailable.taxReference={usable:false,includedInResult:false,taxableBase:null,estimatedTax:null,products:[],segments:[]};
  const result=aggregatePublishedPeriodEnvelopes('2026-08-03','2026-08-16',[
    envelope('2026-08-03','2026-08-09'),unavailable
  ]);
  assert.equal(result.quality,'unavailable');
  assert.equal(result.totals,null);
  assert.deepEqual(result.lines,[]);
  assert.doesNotThrow(()=>buildFinancialPeriodOverview({...result,publication_id:'publication-1',method_version:'financial-result-v6',scope:'selected_products'}));
});

test('mixed tax availability removes tax lines and keeps the aggregate before tax',()=>{
  const withoutTax=envelope('2026-08-10','2026-08-16',{quality:'partial',missingReasons:['tax_setting_missing']});
  withoutTax.totals.estimatedUsnTax=null;
  withoutTax.totals.availableResultAfterTax=null;
  withoutTax.totals.netProfit=null;
  withoutTax.lines=withoutTax.lines.filter(line=>line.category_code!=='estimated_usn_tax');
  withoutTax.taxReference={usable:false,includedInResult:false,taxableBase:null,estimatedTax:null,products:[],segments:[]};
  const result=aggregatePublishedPeriodEnvelopes('2026-08-03','2026-08-16',[
    envelope('2026-08-03','2026-08-09'),withoutTax
  ]);
  assert.equal(result.taxReference.usable,false);
  assert.equal(result.totals.availableResultBeforeTax,'20.0000');
  assert.equal(result.totals.availableResultAfterTax,null);
  assert.equal(result.lines.some(line=>line.category_code==='estimated_usn_tax'),false);
  const overview=buildFinancialPeriodOverview({...result,publication_id:'publication-1',method_version:'financial-result-v6',scope:'selected_products'});
  assert.deepEqual(overview.displayResult,{amount:'20.0000',basis:'before_tax'});
});

test('daily publication aggregation uses mapped days and rounds tax once per SKU',()=>{
  const result=aggregateDailyPublicationPeriod('2026-09-01','2026-09-02',{
    days:[
      {accounting_date:'2026-09-01',coverage_complete:true,quality:'complete',tax_usable:true,store_profit_before_tax:'2.0000',selected_profit_before_tax:'10.0000',available_profit_before_tax:'12.0000'},
      {accounting_date:'2026-09-02',coverage_complete:true,quality:'complete',tax_usable:true,store_profit_before_tax:'3.0000',selected_profit_before_tax:'20.0000',available_profit_before_tax:'23.0000'}
    ],
    lines:[
      {accounting_date:'2026-09-01',scope:'selected_products',product_id:'product-a',variant_id:null,category_code:'revenue',amount_signed:'10.0000'},
      {accounting_date:'2026-09-01',scope:'store',product_id:null,variant_id:null,category_code:'storage',amount_signed:'2.0000'},
      {accounting_date:'2026-09-02',scope:'selected_products',product_id:'product-a',variant_id:null,category_code:'revenue',amount_signed:'20.0000'},
      {accounting_date:'2026-09-02',scope:'store',product_id:null,variant_id:null,category_code:'storage',amount_signed:'3.0000'}
    ],reasons:[],taxFacts:[
      {accounting_date:'2026-09-01',product_id:'product-a',tax_base_unrounded:'10.000000000000',tax_numerator_unrounded:'0.333330000000'},
      {accounting_date:'2026-09-02',product_id:'product-a',tax_base_unrounded:'20.000000000000',tax_numerator_unrounded:'0.333330000000'}
    ]
  });
  assert.equal(result.period_result_id,null);
  assert.equal(result.totals.availableResultBeforeTax,'35.0000');
  assert.equal(result.totals.estimatedUsnTax,'0.6667');
  assert.equal(result.taxReference.products[0].estimatedTax,'0.6667');
  assert.equal(result.lines.at(-1).amount_signed,'-0.6667');
});

test('daily publication aggregation fails closed when one requested date is unmapped',()=>{
  const result=aggregateDailyPublicationPeriod('2026-09-01','2026-09-02',{
    days:[{accounting_date:'2026-09-01',coverage_complete:true,quality:'complete',tax_usable:false,store_profit_before_tax:'0.0000',selected_profit_before_tax:'1.0000',available_profit_before_tax:'1.0000'}]
  });
  assert.equal(result.quality,'unavailable');
  assert.equal(result.daily_read_complete,false);
  assert.equal(result.totals,null);
  assert.ok(result.missing_reasons.includes('report_coverage_incomplete'));
});

test('revoked empty-week evidence hides published zero until a report is received',()=>{
  const day={accounting_date:'2026-09-28',coverage_complete:true,quality:'complete',tax_usable:true,
    store_profit_before_tax:'0.0000',selected_profit_before_tax:'0.0000',available_profit_before_tax:'0.0000'};
  const original=aggregateDailyPublicationPeriod(day.accounting_date,day.accounting_date,{days:[day]});
  assert.equal(original.quality,'complete');
  const waiting=aggregateDailyPublicationPeriod(day.accounting_date,day.accounting_date,{days:[{...day,empty_evidence_revoked:true}]});
  assert.equal(waiting.quality,'unavailable');
  assert.equal(waiting.totals,null);
  assert.ok(waiting.missing_reasons.includes('financial_report_waiting'));
  assert.ok(waiting.missing_reasons.includes('report_coverage_incomplete'));
  assert.equal(waiting.taxReference.usable,false);
  assert.equal(buildFinancialPeriodOverview({...waiting,publication_id:'publication-1',method_version:'financial-result-v36',scope:'selected_products'}).displayResult.amount,null);
});

test('daily publication keeps a fully mapped unavailable period authoritative',()=>{
  const result=aggregateDailyPublicationPeriod('2026-09-01','2026-09-01',{
    days:[{accounting_date:'2026-09-01',coverage_complete:true,quality:'unavailable',tax_usable:false,store_profit_before_tax:null,selected_profit_before_tax:null,available_profit_before_tax:null}],
    reasons:[{accounting_date:'2026-09-01',reason_code:'operation_unclassified'}]
  });
  assert.equal(result.daily_read_complete,true);
  assert.equal(result.quality,'unavailable');
  assert.equal(result.totals,null);
});

test('loads a long published range in a constant five SQL queries',async()=>{
  const periods=Array.from({length:53},(_,index)=>({
    period_result_id:`00000000-0000-0000-0000-${String(index).padStart(12,'0')}`,
    period_start:`2026-${String(Math.trunc(index/28)+1).padStart(2,'0')}-${String(index%28+1).padStart(2,'0')}`,
    period_end:`2026-${String(Math.trunc(index/28)+1).padStart(2,'0')}-${String(index%28+1).padStart(2,'0')}`,
    quality:'complete',missing_reasons:[],totals:null
  }));
  const responses=[periods,[],[],[],periods.map(row=>({period_result_id:row.period_result_id,source_freshness:null,covered_start:null,covered_end:null,report_count:0}))];
  const calls=[];
  const client={query:async(sql,params)=>{calls.push([sql,params]);return{rows:responses[calls.length-1]};}};
  const result=await loadPublishedPeriodEnvelopes(client,'run-1','2026-01-01','2026-12-31');
  assert.equal(result.length,53);
  assert.equal(calls.length,5);
});

function persistedDailyRows(date,{amount='10.0000',quality='complete',revoked=false}={}){
  return{
    days:[{accounting_date:date,generation_id:`generation-${date}`,coverage_complete:true,quality,tax_usable:true,
      store_profit_before_tax:'0.0000',selected_profit_before_tax:amount,available_profit_before_tax:quality==='unavailable'?null:amount,
      empty_evidence_revoked:revoked,parser_method_version_id:'parser-13',result_method_version_id:'result-36'}],
    lines:[{id:`line-${date}`,generation_id:`generation-${date}`,accounting_date:date,scope:'selected_product',product_id:'product-a',
      variant_id:null,category_code:'revenue',amount_signed:amount,quality}],
    reasons:quality==='partial'?[{accounting_date:date,reason_code:'operation_unclassified'}]:[],
    taxFacts:[{id:`fact-${date}`,generation_id:`generation-${date}`,accounting_date:date,product_id:'product-a',
      tax_setting_version_id:'tax-1',tax_base_unrounded:'10.000000000000',tax_numerator_unrounded:'0.333330000000',tax_rate_fraction:'0.033333000000'}]
  };
}

function dailyBatchFixture(sources,{reports={},empty={},excluded={}}={}){
  const names=['days','lines','reasons','taxFacts'];
  const data=Object.fromEntries(names.map(name=>[name,sources.flatMap(source=>source[name])]));
  const calls=[];
  const client={async query(sql,params){
    calls.push({sql,params});
    const requested=JSON.parse(params[1]),index=(calls.length-1)%7;
    if(index<4)return{rows:requested.flatMap(period=>data[names[index]]
      .filter(row=>row.accounting_date>=period.period_start&&row.accounting_date<=period.period_end)
      .map(row=>({period_key:period.period_key,...structuredClone(row)})))};
    const metadata=[reports,empty,excluded][index-4];
    return{rows:requested.flatMap(period=>{
      const value=metadata[`${period.period_start}:${period.period_end}`];
      return value?[{period_key:period.period_key,...value}]:[];
    })};
  }};
  return{client,calls,data};
}

test('daily loader uses seven reads for one or five ranges and reuses duplicate envelopes',async()=>{
  const periods=Array.from({length:5},(_,index)=>({start:`2026-09-0${index+1}`,end:`2026-09-0${index+1}`}));
  const sources=periods.map(period=>persistedDailyRows(period.start));
  const single=dailyBatchFixture(sources),batch=dailyBatchFixture(sources);
  const [one]=await loadDailyPeriodEnvelopes(single.client,{publication_id:'publication-1'},[periods[0]],'business-1','store-1');
  const values=await loadDailyPeriodEnvelopes(batch.client,{publication_id:'publication-1'},[...periods,periods[1]],'business-1','store-1');
  assert.equal(single.calls.length,7);assert.equal(batch.calls.length,7);
  assert.deepEqual(values[0],one);assert.equal(values[1],values[5]);
  for(const call of batch.calls){
    assert.equal(call.params[0],'publication-1');
    assert.equal(call.params[1],batch.calls[0].params[1]);
    assert.deepEqual(JSON.parse(call.params[1]).map(({period_start,period_end})=>({start:period_start,end:period_end})),periods);
    assert.match(call.sql,/jsonb_to_recordset\(\$2::jsonb\)/);
  }
  const [days,lines,reasons,facts,reports,empty,excluded]=batch.calls.map(call=>call.sql);
  for(const sql of [days,lines,reasons,facts]){
    assert.match(sql,/mapped_day\.publication_id=\$1/);
    assert.match(sql,/mapped_day\.accounting_date between period\.period_start and period\.period_end/);
  }
  for(const [sql,alias] of [[days,'day'],[lines,'result'],[reasons,'reason'],[facts,'fact']]){
    assert.ok(sql.includes(`${alias}.generation_id=mapped_day.generation_id and ${alias}.accounting_date=mapped_day.accounting_date`));
  }
  assert.match(reports,/select distinct period\.period_key,period\.period_start,period\.period_end,mapped_day\.generation_id/);
  assert.match(reports,/report_version\.id=input\.report_version_id/);
  assert.match(reports,/report\.period_start<=mapped_generation\.period_end and report\.period_end>=mapped_generation\.period_start/);
  assert.match(empty,/coverage\.week_start<=mapped_generation\.period_end and coverage\.week_end>=mapped_generation\.period_start/);
  assert.match(excluded,/operation\.report_normalization_id=input\.report_normalization_id/);
  assert.match(excluded,/operation\.accounting_date=mapped_day\.accounting_date/);
  assert.match(excluded,/count\(distinct \(report_row\.raw_data->>'nmId'\)\)/);
});

test('overlapping daily ranges aggregate tax, quality, metadata and missing dates independently',async()=>{
  const current={start:'2026-09-01',end:'2026-09-02'},previous={start:'2026-09-01',end:'2026-09-01'};
  const periods=[current,previous,{start:'2026-09-04',end:'2026-09-04'},
    {start:'2026-09-03',end:'2026-09-03'},{start:'2026-09-05',end:'2026-09-05'},current,
    {start:'2026-09-06',end:'2026-09-06'},{start:'2026-09-01',end:'2026-09-04'}];
  const fixture=dailyBatchFixture([
    persistedDailyRows('2026-09-01'),persistedDailyRows('2026-09-02'),persistedDailyRows('2026-09-03',{quality:'partial'}),
    persistedDailyRows('2026-09-05',{revoked:true}),persistedDailyRows('2026-09-06',{quality:'unavailable'})
  ],{reports:{
    '2026-09-01:2026-09-02':{source_freshness:new Date('2026-09-02T10:00:00Z'),cross_border_report_count:2},
    '2026-09-01:2026-09-01':{source_freshness:new Date('2026-09-01T10:00:00Z'),cross_border_report_count:1}
  },empty:{'2026-09-01:2026-09-02':{source_freshness:new Date('2026-09-02T11:00:00Z')}},
  excluded:{'2026-09-01:2026-09-02':{count:3},'2026-09-01:2026-09-01':{count:1}}});
  const result=await withPublishedPeriodCache('user-1',async()=>{
    const values=await loadDailyPeriodEnvelopes(fixture.client,{publication_id:'publication-1'},periods,'business-1','store-1');
    const cached=getCachedDailyPeriodRows({businessId:'business-1',storeId:'store-1',publicationId:'publication-1',
      periodStart:current.start,periodEnd:current.end});
    for(const name of ['days','lines','reasons','taxFacts']){
      assert.deepEqual(cached[name],fixture.data[name].filter(row=>row.accounting_date<=current.end));
      assert.equal(cached[name].some(row=>Object.hasOwn(row,'period_key')),false);
    }
    assert.equal(getCachedDailyPeriodRows({businessId:'business-1',storeId:'store-1',publicationId:'publication-1',
      periodStart:'2026-09-04',periodEnd:'2026-09-04'}),null);
    assert.equal(getCachedDailyPeriodRows({businessId:'business-1',storeId:'store-1',publicationId:'publication-1',
      periodStart:previous.start,periodEnd:previous.end}),null);
    return values;
  });
  assert.equal(fixture.calls.length,7);
  assert.equal(result[0],result[5]);
  assert.equal(result[0].totals.availableResultBeforeTax,'20.0000');
  assert.equal(result[0].totals.estimatedUsnTax,'0.6667');assert.equal(result[1].totals.estimatedUsnTax,'0.3333');
  assert.deepEqual(result[0].cross_border_buyout,{present:true,reportCount:2});
  assert.deepEqual(result[1].cross_border_buyout,{present:true,reportCount:1});
  assert.deepEqual(result[0].source_freshness,new Date('2026-09-02T11:00:00Z'));
  assert.deepEqual(result[1].source_freshness,new Date('2026-09-01T10:00:00Z'));
  assert.equal(result[0].excluded_product_count,3);assert.equal(result[1].excluded_product_count,1);
  assert.equal(result[2],null);
  assert.equal(result[3].quality,'partial');assert.deepEqual(result[3].missing_reasons,['operation_unclassified']);
  assert.equal(result[3].source_freshness,null);assert.deepEqual(result[3].cross_border_buyout,{present:false,reportCount:0});
  assert.equal(result[4].quality,'unavailable');assert.equal(result[4].totals,null);
  assert.ok(result[4].missing_reasons.includes('financial_report_waiting'));
  assert.equal(result[6].quality,'unavailable');assert.equal(result[6].daily_read_complete,true);
  assert.equal(result[7].quality,'unavailable');assert.equal(result[7].daily_read_complete,false);
  assert.ok(result[7].missing_reasons.includes('report_coverage_incomplete'));
  assert.equal(result[0].lines.some(row=>['id','generation_id','period_key','businessId','storeId'].some(field=>Object.hasOwn(row,field))),false);
});

test('daily batching keeps exact money strings and per-range year limits without limiting the union',async()=>{
  const periods=[{start:'2022-01-01',end:'2022-01-01'},{start:'2026-01-01',end:'2026-01-01'}];
  const fixture=dailyBatchFixture(periods.map(period=>persistedDailyRows(period.start,{amount:'9007199254740991.1234'})));
  const result=await loadDailyPeriodEnvelopes(fixture.client,{publication_id:'publication-1'},periods);
  assert.equal(result[0].totals.availableResultBeforeTax,'9007199254740991.1234');
  assert.equal(result[1].totals.availableResultBeforeTax,'9007199254740991.1234');
  const oversized=dailyBatchFixture([persistedDailyRows('2025-01-01')]);
  await assert.rejects(loadDailyPeriodEnvelopes(oversized.client,{publication_id:'publication-1'},[
    {start:'2025-01-01',end:'2026-01-02'}]),/daily_generation_invalid_period/);
  const missing=dailyBatchFixture([]);
  assert.deepEqual(await loadDailyPeriodEnvelopes(missing.client,{publication_id:'publication-1'},periods),[null,null]);
  assert.equal(missing.calls.length,1);
  const unused={query(){assert.fail('empty ranges must not query');}};
  assert.deepEqual(await loadDailyPeriodEnvelopes(unused,{publication_id:'publication-1'},[]),[]);
});

test('published daily pair batches current and ordered history once and shares the previous envelope',async(t)=>{
  const fixture=dailyBatchFixture([persistedDailyRows('2026-09-01'),persistedDailyRows('2026-09-02')]);
  const client={async query(sql,args){
    if(sql.includes('jsonb_to_recordset'))return fixture.client.query(sql,args);
    if(sql.includes('from mc.memberships'))return{rows:[{business_id:'business-1',role:'viewer'}]};
    if(sql.includes('publication.id as publication_id'))return{rows:[{publication_id:'publication-1',watermark_generation:'1',
      method_version:'financial-result-v36',expected_method_version:'financial-result-v36'}]};
    if(sql.includes('select distinct product.product_id'))return{rows:[{product_id:'product-a'}]};
    if(sql.includes('financial_tariff_scope_matches')||sql.includes('financial_daily_publication_tariff_allowed'))return{rows:[{allowed:true}]};
    return{rows:[]};
  },release(){}};
  t.mock.method(pool,'connect',async()=>client);
  const pair=await getPublishedFinancialPeriodPair('user-1','store-1',{
    periodStart:'2026-09-02',periodEnd:'2026-09-02',previousPeriodStart:'2026-09-01',previousPeriodEnd:'2026-09-01',
    comparisonPeriods:[{start:'2026-09-01',end:'2026-09-01'},{start:'2026-09-02',end:'2026-09-02'},
      {start:'2026-09-01',end:'2026-09-01'},{start:'2026-09-03',end:'2026-09-03'}]
  });
  assert.equal(fixture.calls.length,7);
  assert.equal(JSON.parse(fixture.calls[0].params[1]).length,3);
  assert.equal(pair.previous,pair.history[0]);assert.equal(pair.previous,pair.history[2]);
  assert.equal(pair.current,pair.history[1]);assert.equal(pair.history[3],null);
  assert.deepEqual(pair.history.map(row=>row?.period_start??null),['2026-09-01','2026-09-02','2026-09-01',null]);
});

test('missing current daily ranges retain fallback and method-upgrade shape while mapped unavailable stays authoritative',async(t)=>{
  for(const mode of ['missing','upgrade','unavailable']){
    const fixture=dailyBatchFixture([persistedDailyRows('2026-09-01'),
      ...(mode==='unavailable'?[persistedDailyRows('2026-09-02',{quality:'unavailable'})]:[])]);
    const client={async query(sql,args){
      if(sql.includes('jsonb_to_recordset'))return fixture.client.query(sql,args);
      if(sql.includes('from mc.memberships'))return{rows:[{business_id:'business-1',role:'viewer'}]};
      if(sql.includes('publication.id as publication_id'))return{rows:[{publication_id:'publication-1',watermark_generation:'1',
        method_version:mode==='upgrade'?'financial-result-v28':'financial-result-v36',expected_method_version:'financial-result-v36'}]};
      if(sql.includes('select distinct product.product_id'))return{rows:[{product_id:'product-a'}]};
      if(sql.includes('financial_tariff_scope_matches')||sql.includes('financial_daily_publication_tariff_allowed'))return{rows:[{allowed:true}]};
      return{rows:[]};
    },release(){}};
    t.mock.method(pool,'connect',async()=>client);
    const pair=await getPublishedFinancialPeriodPair('user-1','store-1',{
      periodStart:'2026-09-02',periodEnd:'2026-09-02',previousPeriodStart:'2026-09-01',previousPeriodEnd:'2026-09-01',
      comparisonPeriods:[{start:'2026-09-01',end:'2026-09-01'}]
    });
    if(mode==='missing')assert.equal(pair,null);
    if(mode==='upgrade'){
      assert.equal(pair.current,null);assert.equal(pair.previous,null);assert.equal(Object.hasOwn(pair,'history'),false);
      assert.equal(pair.update_status.methodUpgradePending,true);
    }
    if(mode==='unavailable'){
      assert.equal(pair.current.quality,'unavailable');assert.equal(pair.current.daily_read_complete,true);
      assert.equal(pair.current.totals,null);assert.equal(pair.previous,pair.history[0]);
    }
    t.mock.restoreAll();
  }
});
