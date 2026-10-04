import test from 'node:test';
import assert from 'node:assert/strict';
import { readContributionPage } from './drilldown-evidence.repository.mjs';

const uuid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
function fixture({daily=false,amount='12.0000'}={}){
  const lineRef=daily?{source:'daily',generationId:uuid(2),accountingDate:'2026-09-21',dailyResultId:uuid(3)}
    :{source:'legacy',runId:uuid(2),periodResultId:uuid(4),resultLineId:uuid(3)};
  const context={publication:{source:daily?'daily':'legacy',id:uuid(1),...(daily?{dayRefs:[{generationId:uuid(2),accountingDate:'2026-09-21'}]}:{runId:uuid(2)})},
    storeId:uuid(5),period:{start:'2026-09-21',end:'2026-09-27'},method:{id:uuid(6),...(daily?{resultMethodVersionId:uuid(6),parserMethodVersionId:uuid(7)}:{})},scope:{productIds:[uuid(8)]}};
  const line={lineRef,scope:'selected_product',productId:uuid(8),variantId:uuid(9),accountingDate:'2026-09-21',categoryCode:'revenue',amountSigned:amount};
  const group={groupKey:'revenue',scope:line.scope,productId:line.productId,categoryCode:line.categoryCode,amountSigned:amount,lineRefs:[lineRef]};
  return {context,lines:[line],group};
}
function mocked({daily=false,frozen=true,amount='12.0000',sourceAmount=amount,extra=false,invalid=0,shape={},operationOverrides={},methodOverrides={}}={}){
  const f=fixture({daily,amount});
  const evidence={id:uuid(10),[daily?'daily_result_id':'result_line_id']:uuid(3),financial_component_id:uuid(11),contribution_amount:amount,...shape};
  const queries=[];
  const client={async query(sql,args){
    queries.push({sql,args});
    if(sql.includes('total_items'))return {rows:[{total_items:extra?2:1,amount,line_count:1,invalid_lines:invalid}]};
    if(sql.includes('select e.*,e.contribution_amount::text'))return {rows:[evidence,...(extra?[{...evidence,id:uuid(12)}]:[])]};
    if(sql.includes('implementation_version from mc.'))return {rows:[{result_method_version_id:uuid(6),...(daily?{parser_method_version_id:uuid(7)}:{}),implementation_version:'financial-result-v30',...methodOverrides}]};
    if(sql.includes('from mc.financial_components'))return {rows:[{id:uuid(11),operation_version_id:uuid(13),category_code:'revenue',source_field:'retailAmount',amount_signed:sourceAmount,rounded_matches:true,method_version_id:uuid(7),result_scope_classification:'selected_product'}]};
    if(sql.includes('from mc.operation_versions o'))return {rows:[{id:uuid(13),product_id:uuid(8),variant_id:uuid(9),operation_type:'sale',quantity:'1.000000',state:'active',accounting_date:'2026-09-21',report_row_id:uuid(14),report_version_id:uuid(15),report_normalization_id:uuid(16),method_version_id:uuid(7),normalization_status:'succeeded',frozen,
      raw:{rrdId:'900719925474099312345',nmId:'123456789',reportId:'9223372036854775808',quantity:'1.000000',docTypeName:'Продажа',sellerOperName:'Продажа',currency:'RUB',srid:'private',phone:'private',storagePath:'private',comment:'private',unsafe:'private'},...operationOverrides}]};
    throw new Error(`Unexpected query ${sql.slice(0,100)}`);
  }};
  return {f,client,queries};
}

test('frozen component keeps decimal source precision and redacts raw data with exact ID strings',async()=>{
  const {f,client}=mocked({sourceAmount:'12.000049999999999'});
  const page=await readContributionPage(client,f);
  assert.equal(page.reconciliation.status,'matched');assert.equal(page.evidenceStatus,'matched');
  assert.equal(page.sourceValidationScope,'page');
  assert.equal(page.items[0].source.sourceAmount,'12.000049999999999');
  assert.deepEqual(page.items[0].source.raw,{reportId:'9223372036854775808',rrdId:'900719925474099312345',nmId:'123456789',quantity:'1.000000',docTypeName:'Продажа',sellerOperName:'Продажа',currency:'RUB'});
  assert.doesNotMatch(JSON.stringify(page),/private|srid|storagePath|comment/);
});
test('missing frozen source preserves persisted money and hides all source details',async()=>{
  const {f,client}=mocked({frozen:false});const page=await readContributionPage(client,f);
  assert.equal(page.items[0].contributionAmount,'12.0000');assert.equal(page.items[0].source,null);
  assert.equal(page.evidenceStatus,'unavailable');assert.deepEqual(page.missingReasons,['drilldown_frozen_source_missing']);
});
test('legacy checks both input IDs separately; daily checks their exact pair',async()=>{
  for(const daily of [false,true]){
    const {f,client,queries}=mocked({daily});await readContributionPage(client,f);
    const sql=queries.find(q=>q.sql.includes('from mc.operation_versions o')).sql;
    assert.match(sql,/report_version_id=rr.report_version_id/);assert.match(sql,/report_normalization_id=o.report_normalization_id/);
    assert.equal((sql.match(/exists\(select 1 from mc\.(?:calculation_inputs|financial_daily_generation_inputs)/g)??[]).length,daily?1:2);
  }
});
test('scope, method, normalization and category mismatches fail closed',async()=>{
  for(const overrides of [{product_id:uuid(99)},{variant_id:uuid(99)},{accounting_date:'2026-09-22'},{normalization_status:'failed'},{state:'withdrawn'}]){
    const {f,client}=mocked({operationOverrides:overrides});assert.equal((await readContributionPage(client,f)).items[0].source,null);
  }
  const {f,client}=mocked({daily:true,methodOverrides:{parser_method_version_id:uuid(99)}});
  assert.equal((await readContributionPage(client,f)).items[0].source,null);
});
test('invalid evidence shape cannot expose a component despite a valid frozen chain',async()=>{
  const {f,client}=mocked({shape:{expense_version_id:uuid(80)}});
  assert.equal((await readContributionPage(client,f)).items[0].source,null);
});
test('full-group reconciliation blocks source when an off-page line does not reconcile',async()=>{
  const {f,client}=mocked({invalid:1,extra:true});
  const page=await readContributionPage(client,{...f,limit:1});
  assert.equal(page.reconciliation.status,'mismatch');assert.equal(page.items[0].source,null);
  assert.equal(page.totalItems,2);assert.equal(page.items.length,1);
});
test('strict cursor binds publication, group, period and line but ignores update state',async()=>{
  const {f,client}=mocked({extra:true});
  const page=await readContributionPage(client,{...f,limit:1});assert.ok(page.nextCursor);assert.equal(page.evidenceStatus,'unchecked');
  await readContributionPage(client,{...f,context:{...f.context,update:{pending:true}},cursor:page.nextCursor,limit:1});
  for(const change of [{context:{...f.context,publication:{...f.context.publication,id:uuid(99)}}},{group:{...f.group,groupKey:'other'}},{lineRef:f.lines[0].lineRef}]){
    await assert.rejects(readContributionPage(client,{...f,...change,cursor:page.nextCursor}),/drilldown_cursor_context_mismatch/);
  }
  for(const cursor of ['!',Buffer.from('{"version":1}').toString('base64url'),Buffer.from(JSON.stringify({...JSON.parse(Buffer.from(page.nextCursor,'base64url')),unexpected:true})).toString('base64url')]){
    await assert.rejects(readContributionPage(client,{...f,cursor}),/drilldown_invalid_request/);
  }
});
test('limit and foreign line validation happen before querying',async()=>{
  const f=fixture();const client={query(){assert.fail('SQL must not execute');}};
  for(const limit of [0,101,1.5,'25'])await assert.rejects(readContributionPage(client,{...f,limit}),/drilldown_invalid_request/);
  await assert.rejects(readContributionPage(client,{...f,lineRef:{...f.lines[0].lineRef,resultLineId:uuid(99)}}),/drilldown_not_found/);
});

test('return cost accepts same-day frozen sale, rejects missing link, wrong method and later cost',async()=>{
  for(const scenario of ['valid','missing_link','wrong_method','cost_after_sale','sale_unfrozen']){
    const {f,client}=mocked({amount:'12.0000',shape:{financial_component_id:null,cost_version_id:uuid(30),source_operation_version_id:uuid(13),operation_link_id:scenario==='missing_link'?null:uuid(31),quantity:'-1.000000'},operationOverrides:{operation_type:'return',quantity:'-1.000000'}});
    f.lines[0].categoryCode='cost_of_goods';f.group.categoryCode='cost_of_goods';
    const original=client.query.bind(client);
    client.query=async(sql,args)=>{
      if(sql.startsWith('select exists('))return {rows:[{frozen:true}]};
      if(sql.includes('from mc.cost_versions'))return {rows:[{id:uuid(30),unit_cost:'12.0000',product_id:uuid(8),variant_id:uuid(9),effective_from:scenario==='cost_after_sale'?'2026-09-22':'2026-09-21',amount_matches:true}]};
      if(sql.includes('from mc.operation_links'))return {rows:[{id:uuid(31),from_operation_version_id:uuid(13),to_operation_version_id:uuid(32),link_type:'return_to_original_sale',status:'confirmed',method_version_id:scenario==='wrong_method'?uuid(99):uuid(6)}]};
      const response=await original(sql,args);
      if(sql.includes('from mc.operation_versions o')&&args[2]===uuid(32))return {rows:[{...response.rows[0],id:uuid(32),operation_type:'sale',quantity:'1.000000',frozen:scenario!=='sale_unfrozen'}]};
      return response;
    };
    const page=await readContributionPage(client,f);
    if(scenario==='valid'){assert.equal(page.items[0].source.sourceKind,'return_cost');assert.equal(page.items[0].source.originalSale.accountingDate,'2026-09-21');}
    else assert.equal(page.items[0].source,null,scenario);
  }
});

test('daily tax exposes separate exact basis and fact, never compares base with rounded tax',async()=>{
  const {f,client}=mocked({daily:true});
  const fact={id:uuid(40),generationId:uuid(2),accountingDate:'2026-09-21',productId:uuid(8),taxSettingVersionId:uuid(41),taxBaseUnrounded:'12.000000000000',taxNumeratorUnrounded:'0.720000000000',taxRateFraction:'0.06000000'};
  f.group.categoryCode='estimated_usn_tax';f.group.amountSigned='-0.7200';f.lines=[];
  f.group.lineRefs=[{source:'daily_tax_range',productId:uuid(8),period:f.context.period,taxFactRefs:[{id:fact.id,generationId:fact.generationId,accountingDate:fact.accountingDate,taxSettingVersionId:fact.taxSettingVersionId}]}];
  const original=client.query.bind(client);
  client.query=async(sql,args)=>{
    if(sql.includes('from mc.tax_setting_versions'))return {rows:[{id:uuid(41),state:'active',regime_code:'usn_income',usn_rate_fraction:'0.06',effective_from:'2026-01-01',latest_frozen:true}]};
    if(sql.startsWith('select exists('))return {rows:[{frozen:true}]};
    const result=await original(sql,args);
    if(sql.includes('total_items'))return {rows:[{...result.rows[0],tax_base:'12.000000000000'}]};
    if(sql.includes('select e.*,e.contribution_amount::text'))return {rows:[{...result.rows[0],tax_fact_id:fact.id,contribution_amount:'12.000000000000'}]};
    return result;
  };
  const page=await readContributionPage(client,{...f,taxFacts:[fact]});
  assert.equal(page.reconciliation.status,'matched');
  assert.equal(page.reconciliation.checks[0].expectedAmount,'12.000000000000');
  assert.equal(page.items[0].basisContributionAmount,'12.000000000000');
  assert.equal(page.items[0].taxFact.taxNumeratorUnrounded,'0.720000000000');
  assert.equal(page.items[0].source.sourceKind,'financial_component');
  assert.equal(page.items[0].contributionAmount,undefined);
});

test('zero legacy tax accepts empty confirmed basis; wrong period and effective bounds hide source',async()=>{
  for(const scenario of ['valid','wrong_period','wrong_bounds']){
    const {f,client}=mocked({amount:'0.0000',shape:{financial_component_id:null,tax_computation_id:uuid(50)}});
    f.lines[0].categoryCode='estimated_usn_tax';f.lines[0].accountingDate='2026-09-27';f.group.categoryCode='estimated_usn_tax';
    const original=client.query.bind(client);
    client.query=async(sql,args)=>{
      if(sql.includes('from mc.tax_computations where'))return {rows:[{id:uuid(50),product_id:uuid(8),method_version_id:uuid(6),taxable_base:'0.0000',tax_amount:'0.0000',period_start:'2026-09-21',period_end:scenario==='wrong_period'?'2026-09-26':'2026-09-27'}]};
      if(sql.includes('from mc.financial_period_results'))return {rows:[{period_start:'2026-09-21',period_end:'2026-09-27'}]};
      if(sql.includes('from mc.tax_computation_segments s'))return {rows:[{id:uuid(51),tax_setting_version_id:uuid(52),segment_start:'2026-09-21',segment_end:'2026-09-27',taxable_base:'0.0000',rate_fraction:'0.06',usn_rate_fraction:'0.06',state:'active',regime_code:'usn_income',effective_from:'2026-01-01',bounds_valid:scenario!=='wrong_bounds'}]};
      if(sql.includes('from mc.tax_basis_evidence'))return {rows:[]};
      if(sql.includes('select sum(taxable_base)'))return {rows:[{base:'0.0000',tax:'0.0000'}]};
      if(sql.startsWith('select exists('))return {rows:[{frozen:true}]};
      return original(sql,args);
    };
    const page=await readContributionPage(client,f);
    if(scenario==='valid'){assert.equal(page.items[0].source.sourceKind,'tax_computation');assert.equal(page.items[0].source.basisEvidenceCount,0);assert.equal(page.items[0].source.basis,undefined);}
    else assert.equal(page.items[0].source,null,scenario);
  }
});

test('model totals mismatch prevents positive source validation',async()=>{
  const {f,client}=mocked();f.group.evidenceStatus='unavailable';f.group.missingReasons=['drilldown_reconciliation_mismatch'];
  const page=await readContributionPage(client,f);assert.equal(page.items[0].source,null);assert.equal(page.evidenceStatus,'unavailable');
});

test('PostgreSQL-shaped SQL computes full group while paginating a single exact line',async t=>{
  let PGlite;try{({PGlite}=await import('../../../db/node_modules/@electric-sql/pglite/dist/index.js'));}catch{t.skip('Optional db test dependency unavailable');return;}
  const db=new PGlite();
  try{
    await db.exec(`create schema mc;
      create table mc.result_lines(id uuid,run_id uuid,store_id uuid,financial_period_result_id uuid,accounting_date date,result_scope text,product_id uuid,category_code text,amount_signed numeric);
      create table mc.result_evidence(id uuid,store_id uuid,result_line_id uuid,financial_component_id uuid,cost_version_id uuid,expense_version_id uuid,tax_computation_id uuid,report_row_id uuid,source_operation_version_id uuid,operation_link_id uuid,quantity numeric,contribution_amount numeric);
      create table mc.calculation_runs(id uuid,store_id uuid,method_version_id uuid);
      create table mc.method_versions(id uuid,implementation_version text);
      create table mc.report_rows(id uuid,store_id uuid,raw_data jsonb);
      create function mc.financial_amounts_match(actual numeric,expected numeric) returns boolean language sql as 'select abs(actual-expected)<=0.005';`);
    const f=fixture();
    await db.query(`insert into mc.result_lines values($1,$2,$3,$4,'2026-09-21','selected_product',$5,'revenue',12)`,[uuid(3),uuid(2),uuid(5),uuid(4),uuid(8)]);
    for(const [id,amount]of [[uuid(10),'5'],[uuid(12),'7']])await db.query(`insert into mc.result_evidence(id,store_id,result_line_id,contribution_amount) values($1,$2,$3,$4)`,[id,uuid(5),uuid(3),amount]);
    const first=await readContributionPage(db,{...f,limit:1});
    assert.equal(first.totalItems,2);assert.equal(first.items.length,1);assert.equal(first.reconciliation.status,'matched');
    assert.equal(first.reconciliation.checks[0].actualAmount,'12');
    const second=await readContributionPage(db,{...f,cursor:first.nextCursor,limit:1});
    assert.equal(second.items[0].id,uuid(12));assert.equal(second.nextCursor,null);
    assert.equal(second.reconciliation.checks[0].actualAmount,'12');
    await db.query(`insert into mc.report_rows values($1,$2,$3::jsonb)`,[uuid(14),uuid(5),JSON.stringify({acquiringFee:'1.0040',retailAmount:'1.0060',forPay:'0'})]);
    const reversal=mocked({amount:'1.0040',methodOverrides:{implementation_version:'financial-result-v30'},shape:{financial_component_id:null,report_row_id:uuid(14),source_operation_version_id:uuid(13),operation_link_id:uuid(31)},operationOverrides:{operation_type:'return',quantity:'-1.000000'}});
    reversal.f.lines[0].categoryCode='return_wb_expense_reversal';reversal.f.group.categoryCode='return_wb_expense_reversal';
    const original=reversal.client.query.bind(reversal.client);
    reversal.client.query=async(sql,args)=>{
      if(sql.startsWith('with raw as('))return db.query(sql,args);
      if(sql.startsWith('select exists('))return {rows:[{frozen:true}]};
      if(sql.includes('from mc.operation_links'))return {rows:[{id:uuid(31),from_operation_version_id:uuid(13),to_operation_version_id:uuid(32),link_type:'return_to_original_sale',status:'confirmed',method_version_id:uuid(6)}]};
      const result=await original(sql,args);
      if(sql.includes('from mc.operation_versions o')&&args[2]===uuid(32))return {rows:[{...result.rows[0],id:uuid(32),operation_type:'sale',quantity:'1.000000'}]};
      return result;
    };
    const reversed=await readContributionPage(reversal.client,reversal.f);
    assert.equal(reversed.items[0].source.sourceKind,'return_wb_expense_reversal');
  }finally{await db.close();}
});

test('legacy basis SQL pages all exact proofs, preserves full tax sum and binds taxBasis mode',async t=>{
  let PGlite;try{({PGlite}=await import('../../../db/node_modules/@electric-sql/pglite/dist/index.js'));}catch{t.skip('Optional db test dependency unavailable');return;}
  const db=new PGlite();
  try{
    await db.exec(`create schema mc;
      create table mc.result_lines(id uuid,run_id uuid,store_id uuid,financial_period_result_id uuid,accounting_date date,result_scope text,product_id uuid,category_code text,amount_signed numeric);
      create table mc.result_evidence(id uuid,store_id uuid,result_line_id uuid,financial_component_id uuid,cost_version_id uuid,expense_version_id uuid,tax_computation_id uuid,report_row_id uuid,source_operation_version_id uuid,operation_link_id uuid,quantity numeric,contribution_amount numeric);
      create table mc.tax_computations(id uuid,store_id uuid,run_id uuid,product_id uuid,method_version_id uuid,taxable_base numeric,tax_amount numeric,period_start date,period_end date);
      create table mc.tax_computation_segments(id uuid,store_id uuid,tax_computation_id uuid,tax_setting_version_id uuid,segment_start date,segment_end date,taxable_base numeric,rate_fraction numeric);
      create table mc.tax_basis_evidence(id uuid,store_id uuid,tax_segment_id uuid,financial_component_id uuid,taxable_contribution numeric,recognition_date date);
      create table mc.tax_setting_versions(id uuid,tax_setting_id uuid,state text,regime_code text,usn_rate_fraction numeric);
      create table mc.tax_settings(id uuid,effective_from date);
      create table mc.calculation_inputs(run_id uuid,store_id uuid,tax_setting_version_id uuid);
      create table mc.financial_period_results(id uuid,run_id uuid,store_id uuid,period_start date,period_end date);`);
    const m=mocked({amount:'-2.1600',sourceAmount:'12.0000'}),f=m.f;
    f.lines[0].categoryCode='estimated_usn_tax';f.lines[0].accountingDate='2026-09-27';f.group.categoryCode='estimated_usn_tax';
    await db.query(`insert into mc.result_lines values($1,$2,$3,$4,'2026-09-27','selected_product',$5,'estimated_usn_tax',-2.16)`,[uuid(3),uuid(2),uuid(5),uuid(4),uuid(8)]);
    await db.query(`insert into mc.result_evidence(id,store_id,result_line_id,tax_computation_id,contribution_amount) values($1,$2,$3,$4,-2.16)`,[uuid(10),uuid(5),uuid(3),uuid(50)]);
    await db.query(`insert into mc.tax_computations values($1,$2,$3,$4,$5,36,2.16,'2026-09-21','2026-09-27')`,[uuid(50),uuid(5),uuid(2),uuid(8),uuid(6)]);
    await db.query(`insert into mc.tax_computation_segments values($1,$2,$3,$4,'2026-09-21','2026-09-27',36,0.06)`,[uuid(51),uuid(5),uuid(50),uuid(52)]);
    await db.query(`insert into mc.tax_setting_versions values($1,$2,'active','usn_income',0.06)`,[uuid(52),uuid(53)]);
    await db.query(`insert into mc.tax_settings values($1,'2026-01-01')`,[uuid(53)]);
    await db.query(`insert into mc.calculation_inputs values($1,$2,$3)`,[uuid(2),uuid(5),uuid(52)]);
    await db.query(`insert into mc.financial_period_results values($1,$2,$3,'2026-09-21','2026-09-27')`,[uuid(4),uuid(2),uuid(5)]);
    for(const id of [60,61,62])await db.query(`insert into mc.tax_basis_evidence values($1,$2,$3,$4,12,'2026-09-21')`,[uuid(id),uuid(5),uuid(51),uuid(11)]);
    const client={query(sql,args){
      if(sql.startsWith('select exists('))return Promise.resolve({rows:[{frozen:true}]});
      if(sql.includes('implementation_version from mc.')||sql.includes('from mc.financial_components')||sql.includes('from mc.operation_versions o'))return m.client.query(sql,args);
      return db.query(sql,args);
    }};
    const first=await readContributionPage(client,{...f,taxBasis:true,limit:2});
    assert.equal(first.items.length,2);assert.equal(first.totalItems,3);assert.ok(first.nextCursor);
    assert.equal(first.evidenceStatus,'unchecked');assert.equal(first.sourceValidationScope,'page');
    assert.equal(first.reconciliation.status,'matched');assert.equal(first.reconciliation.checks[0].actualAmount,'-2.16');
    assert.equal(first.taxSummary[0].source.taxAmount,'2.16');assert.equal(first.taxSummary[0].source.basis,undefined);
    assert.equal(first.items[0].basisContributionAmount,'12');assert.equal(first.items[0].source.sourceKind,'financial_component');
    assert.equal(first.items[0].segment.taxSettingVersionId,uuid(52));
    const next=await readContributionPage(client,{...f,taxBasis:true,limit:2,cursor:first.nextCursor});
    assert.deepEqual(next.items.map(item=>item.id),[uuid(62)]);assert.equal(next.nextCursor,null);assert.equal(next.evidenceStatus,'unchecked');
    assert.equal(next.reconciliation.checks[0].actualAmount,'-2.16');
    for(const extra of [{taxBasis:false},{context:{...f.context,publication:{...f.context.publication,id:uuid(99)}}},{lineRef:f.lines[0].lineRef}]){
      await assert.rejects(readContributionPage(client,{...f,taxBasis:true,limit:2,cursor:first.nextCursor,...extra}),/drilldown_cursor_context_mismatch/);
    }
    await assert.rejects(readContributionPage(client,{...fixture(),taxBasis:true}),/drilldown_invalid_request/);
    await assert.rejects(readContributionPage(client,{...f,taxBasis:'true'}),/drilldown_invalid_request/);
    const narrowed=await readContributionPage(client,{...f,taxBasis:true,lineRef:f.lines[0].lineRef,limit:1});
    assert.equal(narrowed.totalItems,3);assert.equal(narrowed.items.length,1);assert.equal(narrowed.evidenceStatus,'unchecked');
  }finally{await db.close();}
});
