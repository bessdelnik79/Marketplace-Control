import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPublishedDrilldownModel, paginatePublishedSkuList } from './drilldown.mjs';

const period={start:'2026-09-21',end:'2026-09-27'};
function line(productId,categoryCode,amountSigned,id,scope='selected_product'){
  return {lineRef:{source:'legacy',runId:'run',periodResultId:'period',resultLineId:id},scope,productId,variantId:null,accountingDate:period.start,categoryCode,amountSigned,quality:'complete'};
}
function input({quality='complete',method='financial-result-v36',lines=[line('a','revenue','100.0000','1'),line('a','logistics','-10.0000','2'),line('b','revenue','50.0000','3'),line(null,'software_services','-5.0000','4','store')],tax=null,before='135.0000',selected='140.0000',store='-5.0000'}={}){
  const missingReasons=quality==='partial'?['cost_missing']:[];
  const totals=quality==='unavailable'?null:{selectedProductsResultBeforeTax:selected,storeLevelResultBeforeTax:store,availableResultBeforeTax:before,estimatedUsnTax:tax,availableResultAfterTax:tax===null?null:(BigInt(before.replace('.',''))-BigInt(tax.replace('.',''))).toString().replace(/(\d{4})$/,'.$1'),netProfit:null};
  return {context:{contractVersion:'p0.5-v1',publication:{source:'legacy',id:'publication'},storeId:'store',period,method:{code:'financial_result',version:method},scope:{type:'selected_products',productIds:['a','b'],includesStoreResult:method==='financial-result-v36'},quality,missingReasons,coverage:{complete:true},resultBasis:tax===null?'before_tax':'after_tax',totals,update:null},
    envelope:{publication_id:'publication',method_version:method,period_start:period.start,period_end:period.end,quality,missing_reasons:missingReasons,coverage:{productIds:['a','b']},totals,lines:lines.map(value=>({result_scope:value.scope,product_id:value.productId,accounting_date:value.accountingDate,category_code:value.categoryCode,amount_signed:value.amountSigned,quality:value.quality})),taxReference:tax===null?null:{usable:true,includedInResult:true,estimatedTax:tax}},
    products:[{productId:'a',name:'Alpha',sellerArticle:'ALPHA'},{productId:'b',name:'Beta',wbArticle:'12345'},{productId:'outside',name:'Never selected'}],lines:lines.map(value=>({...value,quality})),taxFacts:[]};
}

test('published scope and store contribution stay intact across search and pages',()=>{
  const args=input(),model=buildPublishedDrilldownModel(args);
  assert.deepEqual(model.items.map(item=>item.productId),['a','b']);
  assert.equal(model.reconciliation.status,'matched');
  assert.equal(model.items[0].metrics.availableResultBeforeTax.amount,'90.0000');
  assert.equal(model.storeLines[0].amountSigned,'-5.0000');
  assert.equal(model.items[0].metrics.wbExpenses.amount,'10.0000');
  const first=paginatePublishedSkuList(model,{limit:1});
  assert.equal(first.items[0].productId,'b');
  const second=paginatePublishedSkuList(model,{limit:1,cursor:first.nextCursor});
  assert.equal(second.items[0].productId,'a');assert.equal(second.nextCursor,null);
  assert.strictEqual(second.context,model.context);assert.strictEqual(second.storeLines,model.storeLines);assert.strictEqual(second.reconciliation,model.reconciliation);
  const searched=paginatePublishedSkuList(model,{search:'alpha'});
  assert.equal(searched.totalItems,1);assert.equal(searched.scopeItemCount,2);assert.equal(searched.context.totals.availableResultBeforeTax,'135.0000');
});

test('absent categories are unknown for partial publications and confirmed zero only for complete ones',()=>{
  const complete=buildPublishedDrilldownModel(input());
  assert.equal(complete.items[1].metrics.costOfGoods.amount,'0.0000');
  const partial=buildPublishedDrilldownModel(input({quality:'partial'}));
  assert.equal(partial.items[1].metrics.costOfGoods.amount,null);
  assert.equal(partial.items[1].metrics.revenue.amount,'50.0000');
  assert.deepEqual(partial.items[0].missingReasons,[]);
  assert.deepEqual(partial.context.missingReasons,['cost_missing']);
  assert.equal(partial.reconciliation.status,'matched');
});

test('legacy methods exclude store amounts from result while still displaying store groups',()=>{
  const model=buildPublishedDrilldownModel(input({method:'financial-result-v6',before:'140.0000'}));
  assert.equal(model.reconciliation.status,'matched');
  assert.equal(model.context.totals.availableResultBeforeTax,'140.0000');
  assert.equal(model.storeLines.length,1);
});

test('returns, WB corrections, external expenses and unknown categories retain their signs',()=>{
  const lines=[line('a','revenue','100.0000','1'),line('a','revenue_return','-20.0000','2'),line('a','logistics','-10.0000','3'),line('a','return_wb_expense_reversal','2.0000','4'),line('a','packaging','-3.0000','5'),line('a','mystery','-1.0000','6')];
  const model=buildPublishedDrilldownModel(input({lines,before:'68.0000',selected:'68.0000',store:'0.0000'})),item=model.items[0];
  assert.equal(model.reconciliation.status,'matched');assert.equal(item.quality,'partial');
  assert.equal(item.metrics.revenue.amount,'80.0000');assert.equal(item.metrics.wbExpenses.amount,'8.0000');assert.equal(item.metrics.wbExpenses.amountSigned,'-8.0000');
  assert.equal(item.metrics.externalExpenses.amount,'3.0000');assert.equal(item.metrics.availableResultBeforeTax.amount,'68.0000');
  assert.equal(item.groups.find(group=>group.categoryCode==='mystery').amountSigned,'-1.0000');
  assert.equal(model.reconciliation.checks.find(check=>check.code==='overview_wbExpenses').actual,'12.0000');
});

test('daily tax uses exact range numerators then SKU rounding, including negative SKU offsets',()=>{
  const lines=[line('a','revenue','1.0000','1'),line('b','revenue','1.0000','2'),line('a','estimated_usn_tax','-0.0001','t1'),line('b','estimated_usn_tax','0.0001','t2')];
  const args=input({lines,before:'2.0000',selected:'2.0000',store:'0.0000',tax:'0.0000'});
  args.taxFacts=[['a','0.000024000000','0.100000000000','0.00024000'],['a','0.000024000000','0.100000000000','0.00024000'],['b','-0.000048000000','-0.100000000000','0.00048000']].map(([productId,taxNumeratorUnrounded,taxBaseUnrounded,taxRateFraction],index)=>({id:String(index),generationId:'g',accountingDate:period.start,productId,taxSettingVersionId:'setting',taxBaseUnrounded,taxNumeratorUnrounded,taxRateFraction}));
  // The published reader also rounds once per SKU, not each daily fact.
  args.envelope.lines=args.envelope.lines.filter(value=>value.category_code!=='estimated_usn_tax');
  const model=buildPublishedDrilldownModel(args);
  assert.equal(model.reconciliation.status,'matched');
  for(const fact of args.taxFacts)fact.taxRateFraction+='00';
  assert.equal(buildPublishedDrilldownModel(args).reconciliation.status,'matched');
  assert.equal(model.items[0].metrics.tax.amount,'0.0000');assert.equal(model.items[1].metrics.tax.amount,'0.0000');
  const ref=model.items[0].groups.find(group=>group.categoryCode==='estimated_usn_tax').lineRefs[0];
  assert.equal(ref.source,'daily_tax_range');assert.equal(ref.taxFactRefs.length,2);assert.equal('dailyResultId' in ref,false);
  args.taxFacts[0].taxNumeratorUnrounded='0.000026000000';args.taxFacts[2].taxNumeratorUnrounded='-0.000050000000';
  args.taxFacts[0].taxRateFraction='0.00026000';args.taxFacts[2].taxRateFraction='0.00050000';
  const signed=buildPublishedDrilldownModel(args);
  assert.equal(signed.items[0].metrics.tax.amount,'0.0001');assert.equal(signed.items[1].metrics.tax.amount,'-0.0001');assert.equal(signed.reconciliation.status,'matched');
  args.taxFacts[0].taxRateFraction='0.06000000';
  assert.equal(buildPublishedDrilldownModel(args).reconciliation.status,'mismatch');
});

test('unusable tax stays unavailable and financial mismatches retain published totals',()=>{
  const args=input(),model=buildPublishedDrilldownModel(args);
  assert.equal(model.items[0].metrics.tax.amount,null);assert.equal(model.items[0].metrics.availableResultAfterTax.amount,null);
  args.lines[0].amountSigned='999.0000';
  const mismatch=buildPublishedDrilldownModel(args);
  assert.equal(mismatch.reconciliation.status,'mismatch');assert.equal(mismatch.context.totals.availableResultBeforeTax,'135.0000');
  assert.equal(mismatch.items[0].groups[0].evidenceStatus,'unavailable');
});

test('cursor binds complete context, search and sort and rejects tampering and invalid limits',()=>{
  const model=buildPublishedDrilldownModel(input()),page=paginatePublishedSkuList(model,{limit:1});
  for(const options of [{search:'alpha'},{sort:'revenue_desc'}])assert.throws(()=>paginatePublishedSkuList(model,{...options,cursor:page.nextCursor}),/drilldown_cursor_context_mismatch/);
  const changed={...model,context:{...model.context,publication:{source:'legacy',id:'next'}}};
  assert.throws(()=>paginatePublishedSkuList(changed,{cursor:page.nextCursor}),/drilldown_cursor_context_mismatch/);
  const updating={...model,context:{...model.context,update:{status:'running',availablePublicationId:'new-publication'}}};
  assert.equal(paginatePublishedSkuList(updating,{cursor:page.nextCursor}).items.length,1);
  const decoded=JSON.parse(Buffer.from(page.nextCursor,'base64url'));decoded.last.productId='a';
  assert.throws(()=>paginatePublishedSkuList(model,{cursor:Buffer.from(JSON.stringify(decoded)).toString('base64url')}),/drilldown_invalid_request/);
  for(const limit of [0,101,1.5,'25',null])assert.throws(()=>paginatePublishedSkuList(model,{limit}),/drilldown_invalid_request/);
  assert.throws(()=>paginatePublishedSkuList(model,{cursor:'invalid!'}),/drilldown_invalid_request/);
});

test('rejects out-of-scope products, duplicate line refs and invalid accounting dates',()=>{
  for(const mutate of [args=>{args.lines[0].productId='outside';},args=>{args.lines.push(args.lines[0]);},args=>{args.lines[0].accountingDate='2026-09-31';},args=>{args.context.publication.id='other';},args=>{args.context.period.end='2026-09-28';}]){
    const args=input();mutate(args);assert.throws(()=>buildPublishedDrilldownModel(args),/drilldown_invalid_request/);
  }
});

test('unavailable publication does not infer zero from absent operations',()=>{
  const model=buildPublishedDrilldownModel(input({quality:'unavailable',lines:[]}));
  assert.equal(model.reconciliation.status,'unavailable');
  assert.equal(model.items[0].metrics.revenue.amount,null);assert.equal(model.items[0].metrics.availableResultBeforeTax.amount,null);
});

test('SKU list hides zero and unknown-only metrics before search and pagination',()=>{
  const model=buildPublishedDrilldownModel(input());
  const zero={...model.items[0],productId:'zero',name:'Zero',metrics:Object.fromEntries(Object.entries(model.items[0].metrics).map(([key,metric])=>[key,{...metric,amount:metric.amount===null?null:'0.0000'}]))};
  model.items.unshift(zero);
  const first=paginatePublishedSkuList(model,{limit:1});
  assert.equal(first.totalItems,2);assert.equal(first.items[0].productId,'b');
  const second=paginatePublishedSkuList(model,{limit:1,cursor:first.nextCursor});
  assert.equal(second.items[0].productId,'a');assert.equal(second.nextCursor,null);
  assert.equal(paginatePublishedSkuList(model,{search:'Zero'}).totalItems,0);
  assert.strictEqual(first.reconciliation,model.reconciliation);
  assert.equal(model.items.length,3);
  const unavailable=buildPublishedDrilldownModel(input({quality:'unavailable',lines:[]}));
  assert.equal(paginatePublishedSkuList(unavailable).totalItems,0);
});

test('zero result with nonzero revenue and tiny or negative metrics remain visible',()=>{
  const model=buildPublishedDrilldownModel(input({lines:[line('a','revenue','10.0000','1'),line('a','cost_of_goods','-10.0000','2'),line('b','logistics','-0.0001','3')],selected:'-0.0001',store:'0.0000',before:'-0.0001'}));
  assert.equal(model.items[0].metrics.availableResultBeforeTax.amount,'0.0000');
  for(const sort of ['result_asc','result_desc','revenue_asc','revenue_desc'])assert.equal(paginatePublishedSkuList(model,{sort}).totalItems,2);
  const complete=buildPublishedDrilldownModel(input({lines:[],selected:'0.0000',store:'0.0000',before:'0.0000'}));
  assert.equal(paginatePublishedSkuList(complete).totalItems,0);
});
