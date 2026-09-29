import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateDailyPublicationPeriod,aggregatePublishedPeriodEnvelopes,blocksLegacyFinancialFallback,classifyNormalizationRecovery,compatibleFinancialParserVersions,loadPublishedPeriodEnvelopes,methodUpgradeUpdateStatus,missingNormalizationRanges,prepareFinancialCalculation,reportPeriodsCoverRange,selectFullyNormalizedReportPeriods } from './calculation.repository.mjs';
import { buildFinancialPeriodOverview } from '../overview/financial-overview.mjs';

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
  assert.match(prepareFinancialCalculation.toString(),/target\?30:29/);
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
