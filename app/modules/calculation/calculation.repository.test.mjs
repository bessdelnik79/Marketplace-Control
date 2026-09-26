import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregatePublishedPeriodEnvelopes,compatibleFinancialParserVersions,loadPublishedPeriodEnvelopes } from './calculation.repository.mjs';
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

test('current financial parser keeps v6 as the first compatibility fallback after v7',()=>{
  assert.deepEqual(compatibleFinancialParserVersions.slice(0,3),['wb-finance-v7','wb-finance-v6','wb-finance-v5']);
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
