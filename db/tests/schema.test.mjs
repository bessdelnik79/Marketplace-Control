import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../../', import.meta.url));
const modulePath = process.env.PGLITE_MODULE;
const { PGlite } = modulePath
  ? await import(pathToFileURL(path.resolve(modulePath)).href)
  : await import('@electric-sql/pglite');
const db = new PGlite();
let count = 0;
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const one = async (sql, params = []) => (await q(sql, params))[0];
const pass = label => { count++; console.log(`ok ${count} - ${label}`); };
async function rejects(sql, params, pattern, label) {
  await assert.rejects(() => db.query(sql, params), pattern);
  pass(label);
}
async function context(business, user) {
  await q("select set_config('app.business_id',$1,false),set_config('app.user_id',$2,false)", [business, user]);
}
async function insert(table, values) {
  const keys = Object.keys(values);
  return one(`insert into mc.${table} (${keys.join(',')}) values (${keys.map((_,i)=>'$'+(i+1)).join(',')}) returning *`, Object.values(values));
}

try {
  const migrations=(await readdir(path.join(root,'db/migrations'))).filter(name=>/^\d+_.+\.sql$/.test(name)).sort();
  for(const migration of migrations)await db.exec(await readFile(path.join(root,'db/migrations',migration),'utf8'));
  pass('all migrations apply atomically to empty PostgreSQL');
  const version = (await one('select version()')).version;
  console.log(version);
  const tables = await q("select table_name from information_schema.tables where table_schema='mc' and table_type='BASE TABLE' order by table_name");
  const user = await insert('users',{display_name:'Owner'});
  await insert('auth_identities',{user_id:user.id,provider:'password',subject:'owner@example.test'});
  await insert('auth_password_credentials',{user_id:user.id,password_hash:'scrypt$16384$8$1$salt$hash'});
  await insert('auth_sessions',{user_id:user.id,token_hash:'a'.repeat(64),expires_at:new Date(Date.now()+86400000)});
  assert.equal((await one('select max(version)::int as version from mc.schema_migrations')).version,59);
  const transportRoundingDefinition=(await one(
  `select pg_get_functiondef(
    'mc.expected_wb_row_rounding_adjustment(uuid,uuid,uuid)'::regprocedure
  ) as definition`
)).definition;

assert.match(
  transportRoundingDefinition,
  /round\(coalesce\(sum\(amount_signed\),\s*0\),\s*2\)\s*=\s*0/
);
  assert.deepEqual((await q("select table_name from information_schema.tables where table_schema='mc' and table_name in ('financial_input_events','financial_store_event_state') order by table_name")).map(row=>row.table_name),['financial_input_events','financial_store_event_state']);
  assert.equal((await one("select relforcerowsecurity as forced from pg_class join pg_namespace on pg_namespace.oid=pg_class.relnamespace where nspname='mc' and relname='financial_input_events'")).forced,true);
  assert.ok(await one("select 1 as ok from pg_proc where oid='mc.establish_financial_pipeline_context(uuid,bigint,uuid,text,text)'::regprocedure"));
  pass('financial report pipeline keeps accepted evidence and append-only date events behind tenant RLS');
  assert.deepEqual((await q(`select table_name from information_schema.tables where table_schema='mc' and table_name in (
    'financial_daily_generations','financial_daily_generation_inputs','financial_daily_generation_products',
    'financial_daily_days','financial_daily_results','financial_daily_reasons','financial_daily_evidence',
    'financial_daily_tax_facts','financial_daily_tax_evidence','financial_daily_shadow_comparisons') order by table_name`)).map(row=>row.table_name),[
    'financial_daily_days','financial_daily_evidence','financial_daily_generation_inputs',
    'financial_daily_generation_products','financial_daily_generations','financial_daily_reasons',
    'financial_daily_results','financial_daily_shadow_comparisons','financial_daily_tax_evidence','financial_daily_tax_facts'
  ]);
  for(const table of ['financial_daily_generations','financial_daily_days','financial_daily_results','financial_daily_evidence','financial_daily_tax_facts','financial_daily_tax_evidence','financial_daily_shadow_comparisons']) {
    assert.equal((await one(`select relforcerowsecurity as forced from pg_class join pg_namespace on pg_namespace.oid=pg_class.relnamespace where nspname='mc' and relname=$1`,[table])).forced,true);
  }
  for(const signature of [
    'mc.emit_financial_input_event(uuid,text,text,date,date,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid)',
    'mc.emit_financial_empty_week_event(uuid)',
    'mc.establish_financial_daily_context(uuid,uuid,text)',
    'mc.start_financial_daily_generation(uuid,uuid,text,bigint,text,uuid,uuid)',
    'mc.finalize_financial_daily_generation(uuid,uuid,text,uuid,bigint,text,text,text)',
    'mc.publish_financial_daily_generation(uuid,uuid,text,uuid,bigint)',
    'mc.financial_daily_shadow_day_compatible(uuid,date)',
    'mc.retry_financial_daily_job(uuid,date,date)',
    'mc.wake_financial_daily_after_compatibility(uuid)',
    'mc.request_financial_inventory_refresh(uuid,timestamp with time zone)'
  ]) {
    assert.equal((await one(`select has_function_privilege('public',$1::regprocedure,'execute') as allowed`,[signature])).allowed,false);
  }
  const taxPrecision=await q(`select table_name,column_name,numeric_precision,numeric_scale from information_schema.columns
    where table_schema='mc' and ((table_name='financial_daily_tax_facts' and column_name in ('tax_base_unrounded','tax_numerator_unrounded'))
      or (table_name='financial_daily_tax_evidence' and column_name='contribution_amount')) order by table_name,column_name`);
  assert.equal(taxPrecision.length,3);
  assert.ok(taxPrecision.every(column=>column.numeric_precision===30&&column.numeric_scale===12));
  const eventColumns=(await q(`select column_name from information_schema.columns where table_schema='mc' and table_name='financial_input_events'`)).map(row=>row.column_name);
  for(const column of ['actor_user_id','source_cost_version_id','source_expense_version_id','source_tax_setting_version_id','source_selection_id','source_parser_method_version_id','source_result_method_version_id','source_financial_week_coverage_id','source_empty_confirmation_job_id']) assert.ok(eventColumns.includes(column));
  const dailyInputColumns=(await q(`select column_name from information_schema.columns where table_schema='mc' and table_name='financial_daily_generation_inputs'`)).map(row=>row.column_name);
  assert.ok(dailyInputColumns.includes('financial_week_coverage_id'));
  assert.ok(dailyInputColumns.includes('empty_confirmation_job_id'));
  const selectionTrigger=await one(`select pg_get_triggerdef(oid) as definition from pg_trigger where tgrelid='mc.product_selection_items'::regclass and tgname='financial_selection_event'`);
  assert.match(selectionTrigger.definition,/FOR EACH STATEMENT/);
  pass('daily shadow schema has exact tax facts, immutable tenant rows and private worker CAS helpers');
  const dispatchColumns=(await q(`select column_name from information_schema.columns where table_schema='mc' and table_name='job_dispatch'`)).map(row=>row.column_name);
  assert.ok(dispatchColumns.includes('recency_date'));
  const claimJobsFunction=(await one(`select pg_get_functiondef('mc.claim_jobs(text,text[],integer,integer)'::regprocedure) definition`)).definition;
  const enqueueJobFunction=(await one(`select pg_get_functiondef('mc.enqueue_job(uuid,text,text,jsonb,timestamp with time zone,integer,integer)'::regprocedure) definition`)).definition;
  const wakeDailyFunction=(await one(`select pg_get_functiondef('mc.wake_financial_daily_after_compatibility(uuid)'::regprocedure) definition`)).definition;
  assert.match(claimJobsFunction,/recency_date.*DESC NULLS LAST/s);
  assert.match(enqueueJobFunction,/financial_report_fetch/);
  assert.match(enqueueJobFunction,/recency_date/);
  assert.match(wakeDailyFunction,/financial_daily_publication_shadow_incompatible/);
  assert.match(wakeDailyFunction,/UPDATE mc\.job_dispatch/);
  pass('financial bootstrap prioritizes recent reports and wakes a shadow retry after compatibility is saved');
  assert.deepEqual((await q(`select table_name from information_schema.tables where table_schema='mc' and table_name in (
    'financial_daily_publications','financial_daily_publication_days','financial_daily_current_publications') order by table_name`)).map(row=>row.table_name),[
    'financial_daily_current_publications','financial_daily_publication_days','financial_daily_publications'
  ]);
  for(const table of ['financial_daily_publications','financial_daily_publication_days','financial_daily_current_publications']){
    assert.equal((await one(`select relforcerowsecurity as forced from pg_class join pg_namespace on pg_namespace.oid=pg_class.relnamespace where nspname='mc' and relname=$1`,[table])).forced,true);
  }
  const publicationFunction=(await one(`select pg_get_functiondef('mc.publish_financial_daily_generation(uuid,uuid,text,uuid,bigint)'::regprocedure) definition`)).definition;
  const shadowDayFunction=(await one(`select pg_get_functiondef('mc.financial_daily_shadow_day_compatible(uuid,date)'::regprocedure) definition`)).definition;
  const pointerGuard=(await one(`select pg_get_functiondef('mc.guard_financial_daily_current_publication()'::regprocedure) definition`)).definition;
  assert.match(publicationFunction,/status<>'succeeded'/);
  assert.match(publicationFunction,/current_watermark IS DISTINCT FROM generation.watermark_generation/);
  assert.match(publicationFunction,/financial_daily_shadow_day_compatible/);
  assert.match(shadowDayFunction,/comparison.status='matched'/);
  assert.match(shadowDayFunction,/legacy_method.code='financial_result'/);
  assert.match(shadowDayFunction,/legacy_method.version_no BETWEEN 9 AND 30/);
  assert.match(shadowDayFunction,/legacy_method.implementation_version='financial-result-v'\|\|legacy_method.version_no/);
  assert.match(shadowDayFunction,/p_accounting_date BETWEEN comparison.period_start AND comparison.period_end/);
  assert.match(shadowDayFunction,/day\.quality IN \('complete','partial'\)/);
  assert.match(shadowDayFunction,/financial_empty_week_evidence_valid/);
  assert.match(publicationFunction,/financial_daily_publication_scope_incompatible/);
  assert.match(shadowDayFunction,/EXCEPT/);
  assert.match(pointerGuard,/mapped_day\.generation_id\s*<>\s*generation\.id/);
  assert.match(pointerGuard,/prior_day\.accounting_date\s*=\s*mapped_day\.accounting_date/);
  assert.match(pointerGuard,/prior_day\.generation_id\s*=\s*mapped_day\.generation_id/);
  assert.match(publicationFunction,/ON CONFLICT\(business_id,store_id\) DO UPDATE/);
  pass('daily publication schema atomically gates first cutover and maps one current store history');
  for (const signature of [
    'mc.get_financial_inventory_context(uuid,bigint,uuid,text)',
    'mc.apply_financial_inventory(uuid,bigint,uuid,text,jsonb)',
    'mc.apply_financial_period_fallback(uuid,bigint,uuid,text)'
  ]) {
    const definition=(await one('select pg_get_functiondef($1::regprocedure) as definition',[signature])).definition;
    const contextWrite=definition.indexOf("set_config('app.business_id'");
    const tenantJobRead=definition.indexOf('FROM mc.jobs j');
    assert.ok(contextWrite>=0&&tenantJobRead>=0&&contextWrite<tenantJobRead);
  }
  pass('financial inventory functions establish tenant context before reading FORCE-RLS jobs');
  pass('password identity and expiring session are stored by migration 2');
  const financialMethod=await one("select implementation_version from mc.method_versions where code='wb_finance_import' and version_no=1");
  assert.equal(financialMethod.implementation_version,'wb-finance-v1');
  assert.deepEqual((await q("select code from mc.financial_categories where code in ('acquiring','deduction','additional_payment','commission_adjustment','estimated_usn_tax','wb_reward_without_vat','wb_reward_vat','pickup_reward','rebill_logistic_compensation') order by code")).map(row=>row.code),['acquiring','additional_payment','commission_adjustment','deduction','estimated_usn_tax','pickup_reward','rebill_logistic_compensation','wb_reward_vat','wb_reward_without_vat']);
  const resultMethod=await one("select parameters from mc.method_versions where code='financial_result' and version_no=1");
  assert.deepEqual(resultMethod.parameters,{classificationVerified:false,taxMethodVerified:false,returnCostLinkVerified:false,wbReconciliationsVerified:false});
  const resultMethodV2=await one("select implementation_version,parameters from mc.method_versions where code='financial_result' and version_no=2");
  assert.equal(resultMethodV2.implementation_version,'financial-result-v2');
  assert.equal(resultMethodV2.parameters.verifiedComponents,'field-operation-name-v1');
  const financeMethodV3=await one("select implementation_version from mc.method_versions where code='wb_finance_import' and version_no=3");
  assert.equal(financeMethodV3.implementation_version,'wb-finance-v3');
  const financeMethodV4=await one("select implementation_version,parameters from mc.method_versions where code='wb_finance_import' and version_no=4");
  assert.equal(financeMethodV4.implementation_version,'wb-finance-v4');
  assert.equal(financeMethodV4.parameters.dataIssueLifecycle,true);
  const financeMethodV5=await one("select implementation_version,parameters from mc.method_versions where code='wb_finance_import' and version_no=5");
  assert.equal(financeMethodV5.implementation_version,'wb-finance-v5');
  assert.equal(financeMethodV5.parameters.promotion,'wb-bonus-type-v1');
  const financeMethodV6=await one("select implementation_version,parameters from mc.method_versions where code='wb_finance_import' and version_no=6");
  assert.equal(financeMethodV6.implementation_version,'wb-finance-v6');
  assert.equal(financeMethodV6.parameters.storeScope,'catalog-identifiers-v2');
  const financeMethodV7=await one("select implementation_version,parameters from mc.method_versions where code='wb_finance_import' and version_no=7");
  assert.equal(financeMethodV7.implementation_version,'wb-finance-v7');
  assert.equal(financeMethodV7.parameters.ppvzReward,'absolute-expense-v1');
  const financeMethodV8=await one("select implementation_version,parameters from mc.method_versions where code='wb_finance_import' and version_no=8");
  assert.equal(financeMethodV8.implementation_version,'wb-finance-v8');
  assert.equal(financeMethodV8.parameters.rebillLogisticCost,'reconciliation-v1');
  const financeMethodV9=await one("select implementation_version,parameters from mc.method_versions where code='wb_finance_import' and version_no=9");
  assert.equal(financeMethodV9.implementation_version,'wb-finance-v9');
  assert.equal(financeMethodV9.parameters.storeScope,'missing-product-identifiers-v1');
  const resultMethodV3=await one("select implementation_version from mc.method_versions where code='financial_result' and version_no=3");
  assert.equal(resultMethodV3.implementation_version,'financial-result-v3');
  const resultMethodV4=await one("select implementation_version,parameters from mc.method_versions where code='financial_result' and version_no=4");
  assert.equal(resultMethodV4.implementation_version,'financial-result-v4');
  assert.equal(resultMethodV4.parameters.rounding,'once-per-selected-product');
  const resultMethodV6=await one("select implementation_version,parameters from mc.method_versions where code='financial_result' and version_no=6");
  assert.equal(resultMethodV6.implementation_version,'financial-result-v6');
  assert.equal(resultMethodV6.parameters.zeroSaleTaxBase,'complete-coverage-v1');
  const resultMethodV7=await one("select implementation_version,parameters from mc.method_versions where code='financial_result' and version_no=7");
  assert.equal(resultMethodV7.implementation_version,'financial-result-v7');
  assert.equal(resultMethodV7.parameters.availableResult,'selected-plus-store-v1');
  const resultMethodV8=await one("select implementation_version,parameters from mc.method_versions where code='financial_result' and version_no=8");
  assert.equal(resultMethodV8.implementation_version,'financial-result-v8');
  assert.equal(resultMethodV8.parameters.rebillLogisticCost,'reconciliation-only-v1');
  const resultMethodV9=await one("select implementation_version,parameters from mc.method_versions where code='financial_result' and version_no=9");
  assert.equal(resultMethodV9.implementation_version,'financial-result-v9');
  assert.equal(resultMethodV9.parameters.storeScope,'missing-product-identifiers-v1');
  const resultMethodV10=await one("select implementation_version,parameters from mc.method_versions where code='financial_result' and version_no=10");
  assert.equal(resultMethodV10.implementation_version,'financial-result-v10');
  const financeMethodV10=await one("select implementation_version,parameters from mc.method_versions where code='wb_finance_import' and version_no=10");
  assert.equal(financeMethodV10.implementation_version,'wb-finance-v10');
  assert.equal(financeMethodV10.parameters.loyaltyCompensation,'exact-operation-signed-income-v1');
  assert.deepEqual(await one("select class,is_promotion from mc.financial_categories where code='loyalty_compensation'"),{class:'income',is_promotion:false});
  const resultMethodV11=await one("select implementation_version,parameters from mc.method_versions where code='financial_result' and version_no=11");
  const resultMethodV12=await one("select implementation_version,parameters from mc.method_versions where code='financial_result' and version_no=12");
  const financeMethodV11=await one("select implementation_version,parameters from mc.method_versions where code='wb_finance_import' and version_no=11");
  const resultMethodV13=await one("select implementation_version,parameters from mc.method_versions where code='financial_result' and version_no=13");
  const resultMethodV14=await one("select implementation_version,parameters from mc.method_versions where code='financial_result' and version_no=14");
  const resultMethodV17=await one("select implementation_version,parameters from mc.method_versions where code='financial_result' and version_no=17");
  const resultMethodV18=await one("select implementation_version,parameters from mc.method_versions where code='financial_result' and version_no=18");
  const resultMethodV19=await one("select implementation_version,parameters from mc.method_versions where code='financial_result' and version_no=19");
  const resultMethodV20=await one("select implementation_version,parameters from mc.method_versions where code='financial_result' and version_no=20");
  const financeMethodV12=await one("select implementation_version,parameters from mc.method_versions where code='wb_finance_import' and version_no=12");
  const financeMethodV13=await one("select implementation_version,parameters from mc.method_versions where code='wb_finance_import' and version_no=13");
  const resultMethodV21=await one("select implementation_version,parameters from mc.method_versions where code='financial_result' and version_no=21");
  const resultMethodV22=await one("select implementation_version,parameters from mc.method_versions where code='financial_result' and version_no=22");
  const resultMethodV23=await one("select implementation_version,parameters from mc.method_versions where code='financial_result' and version_no=23");
  const resultMethodV24=await one("select implementation_version,parameters from mc.method_versions where code='financial_result' and version_no=24");
  const resultMethodV25=await one("select implementation_version,parameters from mc.method_versions where code='financial_result' and version_no=25");
  const resultMethodV26=await one("select implementation_version,parameters from mc.method_versions where code='financial_result' and version_no=26");
  const resultMethodV27=await one("select implementation_version,parameters from mc.method_versions where code='financial_result' and version_no=27");
  const resultMethodV28=await one("select implementation_version,parameters from mc.method_versions where code='financial_result' and version_no=28");
  const resultMethodV29=await one("select implementation_version,parameters from mc.method_versions where code='financial_result' and version_no=29");
  const resultMethodV30=await one("select implementation_version,parameters from mc.method_versions where code='financial_result' and version_no=30");
  assert.equal(resultMethodV11.implementation_version,'financial-result-v11');
  assert.equal(resultMethodV12.implementation_version,'financial-result-v12');
  assert.equal(financeMethodV11.implementation_version,'wb-finance-v11');
  assert.equal(financeMethodV11.parameters.loyaltyCompensation,'reference-only-v1');
  assert.equal(resultMethodV13.implementation_version,'financial-result-v13');
  assert.equal(resultMethodV14.implementation_version,'financial-result-v14');
  assert.equal(resultMethodV17.implementation_version,'financial-result-v17');
  assert.equal(resultMethodV17.parameters.transportReimbursement,'reference-only-v1');
  assert.equal(resultMethodV18.implementation_version,'financial-result-v18');
  assert.equal(resultMethodV18.parameters.targetPeriod,true);
  assert.equal(resultMethodV19.implementation_version,'financial-result-v19');
  assert.equal(resultMethodV19.parameters.negativeSkuTax,'signed-offset-v1');
  assert.equal(resultMethodV20.implementation_version,'financial-result-v20');
  assert.equal(resultMethodV20.parameters.targetPeriod,true);
  assert.equal(resultMethodV20.parameters.negativeSkuTax,'signed-offset-v1');
  assert.equal(financeMethodV12.implementation_version,'wb-finance-v12');
  assert.equal(financeMethodV12.parameters.deliveryServiceReversal,'signed-expense-reversal-v1');
  assert.equal(financeMethodV13.implementation_version,'wb-finance-v13');
  assert.equal(financeMethodV13.parameters.exactSourcePrecision,true);
  assert.equal(resultMethodV21.implementation_version,'financial-result-v21');
  assert.equal(resultMethodV21.parameters.deliveryServiceReversal,'signed-expense-reversal-v1');
  assert.equal(resultMethodV22.implementation_version,'financial-result-v22');
  assert.equal(resultMethodV22.parameters.targetPeriod,true);
  assert.equal(resultMethodV23.implementation_version,'financial-result-v23');
  assert.equal(resultMethodV23.parameters.returnExpenseReversal,'raw-signed-four-fields-round-sum-v1');
  assert.equal(resultMethodV23.parameters.selectedSkuOnly,true);
  assert.equal(resultMethodV24.implementation_version,'financial-result-v24');
  assert.equal(resultMethodV24.parameters.targetPeriod,true);
  assert.equal(resultMethodV24.parameters.excludedProductNotice,'count-only-v1');
  assert.equal(resultMethodV25.implementation_version,'financial-result-v25');
  assert.equal(resultMethodV25.parameters.returnExpenseReversal,'raw-signed-four-fields-retain-acquiring-v2');
  assert.equal(resultMethodV26.implementation_version,'financial-result-v26');
  assert.equal(resultMethodV26.parameters.targetPeriod,true);
  assert.equal(resultMethodV26.parameters.returnExpenseReversal,'raw-signed-four-fields-retain-acquiring-v2');
  assert.equal(resultMethodV27.implementation_version,'financial-result-v27');
  assert.equal(resultMethodV27.parameters.returnExpenseReversal,'raw-signed-four-fields-single-count-v3');
  assert.equal(resultMethodV28.implementation_version,'financial-result-v28');
  assert.equal(resultMethodV28.parameters.targetPeriod,true);
  assert.equal(resultMethodV28.parameters.returnExpenseReversal,'raw-signed-four-fields-single-count-v3');
  assert.equal(resultMethodV29.implementation_version,'financial-result-v29');
  assert.equal(resultMethodV29.parameters.rowResult,'exact-source-final-operation-round-v1');
  assert.equal(resultMethodV30.implementation_version,'financial-result-v30');
  assert.equal(resultMethodV30.parameters.targetPeriod,true);
  assert.equal(resultMethodV30.parameters.rowRoundingAdjustment,'evidenced-scale4-v1');
  assert.equal(resultMethodV14.parameters.targetPeriod,true);
  assert.equal(resultMethodV12.parameters.targetPeriod,true);
  assert.equal(resultMethodV10.parameters.targetPeriod,true);
  assert.deepEqual(await q("select code,class from mc.financial_categories where code in ('loyalty_compensation','loyalty_discount_reference') order by code"),[
    {code:'loyalty_compensation',class:'income'},{code:'loyalty_discount_reference',class:'informational'}
  ]);
  assert.deepEqual(await q("select code,class from mc.financial_categories where code in ('pickup_reward','rebill_logistic_compensation','wb_reward_without_vat','wb_reward_vat') order by code"),[
    {code:'pickup_reward',class:'expense'},{code:'rebill_logistic_compensation',class:'expense'},{code:'wb_reward_vat',class:'expense'},{code:'wb_reward_without_vat',class:'expense'}
  ]);
  assert.deepEqual(await one("select code,class from mc.financial_categories where code='return_wb_expense_reversal'"),
    {code:'return_wb_expense_reversal',class:'expense'});
  assert.deepEqual(await one("select code,class from mc.financial_categories where code='wb_row_rounding_adjustment'"),
    {code:'wb_row_rounding_adjustment',class:'expense'});
  assert.deepEqual(await one("select numeric_precision,numeric_scale from information_schema.columns where table_schema='mc' and table_name='financial_components' and column_name='amount_signed'"),
    {numeric_precision:null,numeric_scale:null});
  const guards=(await q("select proname,pg_get_functiondef(p.oid) as definition from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='mc' and proname in ('guard_period_result','guard_selected_tax_artifact','guard_selected_tax_finish','guard_run_finish') order by proname"));
  assert.equal(guards.length,4);
  for(const guard of guards){assert.match(guard.definition,/financial-result-v9/,guard.proname);assert.match(guard.definition,/financial-result-v11/,guard.proname);assert.match(guard.definition,/financial-result-v13/,guard.proname);}
  const targetGuard=(await one("select pg_get_functiondef('mc.guard_target_period_finish()'::regprocedure) as definition")).definition;
  assert.match(targetGuard,/financial-result-v10/);
  assert.match(targetGuard,/financial-result-v12/);
  assert.match(targetGuard,/wb-finance-v10/);
  assert.match(targetGuard,/financial-result-v14/);
  assert.match(targetGuard,/financial-result-v18/);
  assert.match(targetGuard,/financial-result-v20/);
  assert.match(targetGuard,/wb-finance-v11/);
  assert.match(targetGuard,/financial-result-v22/);
  assert.match(targetGuard,/wb-finance-v12/);
  assert.match(targetGuard,/financial-result-v24/);
  assert.match(targetGuard,/financial-result-v26/);
  assert.match(targetGuard,/financial-result-v28/);
  assert.match(targetGuard,/WHEN 'financial-result-v28'.*THEN 'wb-finance-v12'/s);
  assert.match(targetGuard,/financial-result-v30/);
  assert.match(targetGuard,/WHEN 'financial-result-v30'.*THEN 'wb-finance-v13'/s);
  assert.match((await one("select pg_get_functiondef('mc.guard_confirmed_return_link()'::regprocedure) as definition")).definition,/sold\.accounting_date\s*>\s*returned\.accounting_date/);
  assert.match((await one("select pg_get_functiondef('mc.guard_evidence_source()'::regprocedure) as definition")).definition,/return_wb_expense_reversal/);
  const dailyCompatibility=(await one("select pg_get_functiondef('mc.financial_daily_shadow_day_compatible(uuid,date)'::regprocedure) as definition")).definition;
  assert.match(dailyCompatibility,/generation_method\.version_no\s*=\s*30/g);
  assert.doesNotMatch(dailyCompatibility,/generation_method\.version_no\s*=\s*28/);
  assert.match(dailyCompatibility,/BETWEEN 9 AND 30/);
  const taxComputationColumns=(await q("select column_name from information_schema.columns where table_schema='mc' and table_name='tax_computations' order by column_name")).map(row=>row.column_name);
  assert.ok(taxComputationColumns.includes('product_id'));
  assert.ok(!taxComputationColumns.includes('tax_year')&&!taxComputationColumns.includes('tax_setting_version_id')&&!taxComputationColumns.includes('rate_fraction'));
  assert.equal((await one("select count(*)::int as n from information_schema.columns where table_schema='mc' and table_name='tax_computation_segments' and column_name='tax_amount'")).n,0);
  assert.equal((await one("select count(*)::int as n from pg_constraint where conrelid='mc.tax_computations'::regclass and contype='c' and pg_get_constraintdef(oid) ilike '%tax_amount%>=%'")).n,0);
  assert.match((await one("select pg_get_functiondef('mc.guard_signed_tax_period_finish()'::regprocedure) as definition")).definition,/sum\(c\.tax_amount\)\s*<\s*0/);
  assert.equal((await one("select is_nullable,column_default from information_schema.columns where table_schema='mc' and table_name='sync_runs' and column_name='progress'")).is_nullable,'NO');
  pass('financial report importer method, categories and progress state are installed');
  const rateKey='a'.repeat(64);
  const firstSlot=await one(`insert into mc.wb_api_request_slots(rate_key,next_allowed_at) values($1,clock_timestamp()+make_interval(secs=>65)) returning next_allowed_at-make_interval(secs=>65) as scheduled_at,next_allowed_at`,[rateKey]);
  const secondSlot=await one(`insert into mc.wb_api_request_slots(rate_key,next_allowed_at) values($1,clock_timestamp()+make_interval(secs=>75)) on conflict(rate_key) do update set next_allowed_at=greatest(mc.wb_api_request_slots.next_allowed_at,clock_timestamp())+make_interval(secs=>75),updated_at=clock_timestamp() returning next_allowed_at-make_interval(secs=>75) as scheduled_at,next_allowed_at`,[rateKey]);
  assert.equal(new Date(secondSlot.scheduled_at).getTime(),new Date(firstSlot.next_allowed_at).getTime());
  assert.ok(new Date(secondSlot.next_allowed_at)>new Date(secondSlot.scheduled_at));
  pass('database request slot serializes WB finance calls across workers');
  const b = await insert('businesses',{name:'Business A'});
  await insert('memberships',{business_id:b.id,user_id:user.id});
  await context(b.id,user.id);
  const plans = await q('select p.code,v.* from mc.billing_plans p join mc.billing_plan_versions v on v.plan_id=p.id');
  const byCode = Object.fromEntries(plans.map(x=>[x.code,x]));
  const subscription = await one('select * from mc.subscriptions where business_id=$1',[b.id]);
  assert.equal(subscription.plan_version_id, byCode.free.id);
  assert.equal(byCode.free.product_limit,3);
  assert.equal(byCode.minimum.product_limit,10);
  assert.equal(byCode.plus.store_limit,2);
  assert.equal(byCode.pro.product_limit,1000);
  assert.equal(byCode.plus.price,null);
  pass('new business receives free plan; paid prices remain unconfigured');
  const store = await insert('stores',{business_id:b.id,external_account_id:null,name:'A',status:'paused'});
  assert.equal(store.external_account_id,null);
  await q("update mc.stores set external_account_id='cabinet-a',status='active' where id=$1",[store.id]);
  const connection=await insert('connections',{business_id:b.id,store_id:store.id,secret_ref:'database:test-secret',scopes:['content','analytics','statistics','finance'],status:'active'});
  await q("insert into mc.connection_secrets(business_id,connection_id,ciphertext,nonce,auth_tag) values($1,$2,decode('abcd','hex'),decode(repeat('01',12),'hex'),decode(repeat('02',16),'hex'))",[b.id,connection.id]);
  assert.equal((await one('select count(*)::int as n from mc.connection_secrets where connection_id=$1',[connection.id])).n,1);
  await rejects("insert into mc.connections(business_id,store_id,secret_ref) values($1,$2,'database:duplicate')",[b.id,store.id],/unique constraint/,'store has only one replaceable encrypted connection');
  await rejects("update mc.stores set external_account_id='cabinet-other' where id=$1",[store.id],/cannot be changed/,'assigned marketplace account is immutable');
  await rejects("insert into mc.stores(business_id,external_account_id,name) values($1,'extra','Extra')",[b.id],/store limit/,'free plan blocks second store');
  const product = async (s,n) => insert('products',{business_id:s.business_id,store_id:s.id,wb_article:n,seller_article:'Seller-'+n});
  const products = [];
  for(let i=1;i<=4;i++) products.push(await product(store,123450+i));
  const variant = async (p,n) => insert('variants',{business_id:p.business_id,store_id:p.store_id,product_id:p.id,external_variant_id:n,size_label:n});
  const small = await variant(products[0],'S');
  const medium = await variant(products[0],'M');
  const doc = await insert('source_documents',{business_id:b.id,store_id:store.id,origin:'wb_api',document_type:'catalog',checksum:'catalog-a',completeness:'complete'});
  const selectSql = 'select mc.confirm_product_selection($1,$2,$3::uuid[]) as id';
  await rejects(selectSql,[store.id,doc.id,products.map(p=>p.id)],/product limit/,'four products rejected on free plan');
  assert.equal((await one('select count(*)::int as n from mc.product_selections')).n,0);
  pass('failed selection rolls back header and every item');
  await rejects(selectSql,[store.id,doc.id,[products[0].id,products[0].id]],/distinct/,'duplicate products rejected');
  await rejects(selectSql,[store.id,doc.id,[]],/nonempty/,'empty selection rejected');
  const selection = await one(selectSql,[store.id,doc.id,products.slice(0,3).map(p=>p.id)]);
  assert.equal((await one('select count(*)::int as n from mc.product_selection_items')).n,3);
  pass('three articles selected; variant count does not consume quota');
  await rejects(selectSql,[store.id,doc.id,[products[3].id]],/already selected/,'selection cannot be replaced');
  await rejects('delete from mc.product_selection_items where product_id=$1',[products[0].id],/immutable/,'selected product cannot be removed');
  await rejects('update mc.product_selection_items set product_id=$1 where product_id=$2',[products[3].id,products[0].id],/immutable/,'selected product cannot be swapped');
  await rejects('insert into mc.product_selection_items(business_id,store_id,selection_id,product_id) values($1,$2,$3,$4)',[b.id,store.id,selection.id,products[3].id],/unavailable/,'confirmed selection cannot be extended outside the guarded function');
  await rejects('delete from mc.product_selections where id=$1',[selection.id],/immutable/,'selection cannot be reset by deleting header');
  await q('update mc.stores set status=$1 where id=$2',['archived',store.id]);
  await q('update mc.stores set status=$1 where id=$2',['active',store.id]);
  await rejects(selectSql,[store.id,doc.id,[products[3].id]],/already selected/,'reconnecting same store retains selection');

  await rejects("insert into mc.sync_streams(business_id,store_id,source_type) values($1,$2,'unknown')",[b.id,store.id],/check constraint/,'unknown operational source type is rejected');
  const operationalStream=await insert('sync_streams',{business_id:b.id,store_id:store.id,source_type:'operational_sales_funnel'});
  assert.deepEqual((await q('select user_id,store_id from mc.list_operational_sync_candidates(10) where store_id=$1',[store.id]))[0],{user_id:user.id,store_id:store.id});
  await q("update mc.sync_streams set status='paused' where id=$1",[operationalStream.id]);
  assert.equal((await one('select count(*)::int as n from mc.list_operational_sync_candidates(10) where store_id=$1',[store.id])).n,0);
  await q("update mc.sync_streams set status='active' where id=$1",[operationalStream.id]);
  await q("update mc.connections set status='invalid' where id=$1",[connection.id]);
  await q('update mc.sync_streams set next_run_at=clock_timestamp() where id=$1',[operationalStream.id]);
  assert.equal((await one('select count(*)::int as n from mc.list_operational_sync_candidates(10) where store_id=$1',[store.id])).n,0);
  await q("update mc.connections set status='active' where id=$1",[connection.id]);
  pass('operational scheduler finds only due connected stores with a confirmed selection');
  const operationalRun=await insert('sync_runs',{business_id:b.id,store_id:store.id,stream_id:operationalStream.id,requested_from:'2026-09-14',requested_to:'2026-09-20',status:'running',started_at:new Date()});
  await q('update mc.sync_streams set next_run_at=null where id=$1',[operationalStream.id]);
  assert.equal((await one('select count(*)::int as n from mc.list_operational_sync_candidates(10) where store_id=$1',[store.id])).n,0);
  pass('operational scheduler does not duplicate a recent running job');
  const operationalDocument=await insert('source_documents',{business_id:b.id,store_id:store.id,sync_run_id:operationalRun.id,origin:'wb_api',document_type:'operational_sales_funnel',checksum:'b'.repeat(64),completeness:'complete'});
  await rejects('insert into mc.operational_periods(business_id,store_id,period_start,period_end) values($1,$2,$3,$4)',[b.id,store.id,'2026-09-14','2026-09-21'],/check constraint/,'operational period is limited to seven inclusive days');
  const operationalPeriod=await insert('operational_periods',{business_id:b.id,store_id:store.id,period_start:'2026-09-14',period_end:'2026-09-20'});
  await rejects('insert into mc.operational_snapshots(business_id,store_id,operational_period_id,document_id,version_no,checksum,parser_version,fetched_at,quality,status,accepted_at) values($1,$2,$3,$4,2,$5,$6,now(),\'complete\',\'accepted\',now())',[b.id,store.id,operationalPeriod.id,operationalDocument.id,'d'.repeat(64),'test-v1'],/must start received/,'operational snapshot cannot bypass validation on insert');
  const operationalSnapshot=await insert('operational_snapshots',{business_id:b.id,store_id:store.id,operational_period_id:operationalPeriod.id,document_id:operationalDocument.id,version_no:1,checksum:'c'.repeat(64),parser_version:'test-v1',fetched_at:new Date(),quality:'complete'});
  await insert('source_objects',{business_id:b.id,store_id:store.id,document_id:operationalDocument.id,storage_key:`${b.id}/${store.id}/operational-snapshots/${operationalSnapshot.id}/part-0000.json.gz.enc`,part_number:0,byte_size:64,checksum:'e'.repeat(64),content_type:'application/json+gzip+aes-256-gcm'});
  for(const [position,selectedProduct] of products.slice(0,3).entries()){
    await insert('operational_snapshot_products',{business_id:b.id,store_id:store.id,snapshot_id:operationalSnapshot.id,product_id:selectedProduct.id,request_position:position+1});
    for(let day=14;day<=20;day++)await insert('operational_daily_metrics',{business_id:b.id,store_id:store.id,snapshot_id:operationalSnapshot.id,product_id:selectedProduct.id,metric_date:`2026-09-${day}`,currency:'RUB',order_count:day,order_amount:String(day*100),buyout_count:day-1,buyout_amount:String((day-1)*100),row_checksum:String(position+1).repeat(64)});
  }
  await q("update mc.operational_snapshots set status='validated' where id=$1",[operationalSnapshot.id]);
  await q("update mc.operational_snapshots set status='accepted',accepted_at=now() where id=$1",[operationalSnapshot.id]);
  await insert('operational_snapshot_activations',{business_id:b.id,store_id:store.id,operational_period_id:operationalPeriod.id,snapshot_id:operationalSnapshot.id,document_id:operationalDocument.id,fetched_at:new Date()});
  await q('update mc.operational_periods set current_snapshot_id=$1 where id=$2',[operationalSnapshot.id,operationalPeriod.id]);
  assert.equal((await one('select quality from mc.operational_snapshots where id=$1',[operationalSnapshot.id])).quality,'complete');
  pass('complete operational snapshot freezes selected scope and switches accepted current version');
  await rejects('update mc.operational_daily_metrics set order_count=0 where snapshot_id=$1',[operationalSnapshot.id],/immutable/,'accepted operational daily metrics are immutable');
  await rejects('update mc.operational_periods set current_snapshot_id=null where id=$1',[operationalPeriod.id],/cannot be cleared/,'accepted operational current pointer cannot be cleared');

  const b2 = await insert('businesses',{name:'Business B'});
  await insert('memberships',{business_id:b2.id,user_id:user.id});
  const store2 = await insert('stores',{business_id:b2.id,external_account_id:'cabinet-b',name:'B',status:'active'});
  const foreign = await product(store2,123451);
  await rejects('insert into mc.variants(business_id,store_id,product_id,external_variant_id) values($1,$2,$3,$4)',[b.id,store.id,foreign.id,'X'],/foreign key/,'foreign store product cannot be linked');
  pass('same WB article is allowed in a different store');
  await rejects(selectSql,[store2.id,doc.id,[foreign.id]],/store not available/,'selection function checks tenant and store');

  const base = {business_id:b.id,store_id:store.id};
  const cost = await insert('variant_costs',{...base,product_id:products[0].id,variant_id:small.id,effective_from:'2026-09-01'});
  const costV1 = await insert('cost_versions',{...base,cost_id:cost.id,version_no:1,unit_cost:'450',origin:'manual',changed_by:user.id});
  await q('update mc.variant_costs set current_version_id=$1 where id=$2',[costV1.id,cost.id]);
  const costM = await insert('variant_costs',{...base,product_id:products[0].id,variant_id:medium.id,effective_from:'2026-09-01'});
  const costMV = await insert('cost_versions',{...base,cost_id:costM.id,version_no:1,unit_cost:'470',origin:'manual',changed_by:user.id});
  await q('update mc.variant_costs set current_version_id=$1 where id=$2',[costMV.id,costM.id]);
  assert.equal(Number(costV1.unit_cost)*2+Number(costMV.unit_cost)*3,2310);
  pass('different variant costs are stored exactly');
  await rejects('update mc.variant_costs set current_version_id=$1 where id=$2',[costMV.id,cost.id],/foreign key/,'cost pointer cannot point to another variant cost');
  await rejects('update mc.cost_versions set unit_cost=999 where id=$1',[costV1.id],/immutable/,'historical cost cannot be overwritten');
  const costV2 = await insert('cost_versions',{...base,cost_id:cost.id,version_no:2,unit_cost:'480',origin:'manual',changed_by:user.id});
  await q('update mc.variant_costs set current_version_id=$1 where id=$2',[costV2.id,cost.id]);
  assert.equal(Number((await one('select unit_cost from mc.cost_versions where id=$1',[costV1.id])).unit_cost),450);
  pass('correction changes current pointer and retains old value');
  const otherVariant = await variant(products[3],'S');
  await rejects('insert into mc.variant_costs(business_id,store_id,product_id,variant_id,effective_from) values($1,$2,$3,$4,$5)',[b.id,store.id,products[3].id,otherVariant.id,'2026-09-01'],/foreign key/,'unselected product cannot receive analytical costs');
  const wrongVariant = await variant(products[1],'L');
  await rejects('insert into mc.variant_costs(business_id,store_id,product_id,variant_id,effective_from) values($1,$2,$3,$4,$5)',[b.id,store.id,products[0].id,wrongVariant.id,'2026-09-01'],/foreign key/,'variant must belong to specified product');
  await rejects('insert into mc.cost_versions(business_id,store_id,cost_id,version_no,unit_cost,origin,changed_by) values($1,$2,$3,3,-1,$4,$5)',[b.id,store.id,cost.id,'manual',user.id],/check constraint/,'negative unit cost rejected');

  const expense = await insert('expenses',{...base,product_id:products[0].id,external_entry_key:'promo-1'});
  const expenseV = await insert('expense_versions',{...base,expense_id:expense.id,version_no:1,amount:5000,period_start:'2026-09-01',period_end:'2026-09-07',recognition_method:'evenly_over_period',origin:'manual',changed_by:user.id});
  await q('update mc.expenses set current_version_id=$1 where id=$2',[expenseV.id,expense.id]);
  await rejects('insert into mc.expenses(business_id,store_id,product_id,external_entry_key) values($1,$2,$3,$4)',[b.id,store.id,products[0].id,'promo-1'],/unique constraint/,'stable expense key prevents duplicate import');
  await rejects('update mc.expense_versions set amount=100 where id=$1',[expenseV.id],/immutable/,'expense versions are immutable');

  const storeExpense = await insert('expenses',{...base,external_entry_key:'store-1'});
  assert.equal(storeExpense.product_id,null);
  const expenseValues={...base,expense_id:storeExpense.id,version_no:1,amount:'123.4567',period_start:'2026-09-01',period_end:'2026-09-01',recognition_method:'on_date',origin:'manual',changed_by:user.id};
  for(const [i,category] of ['external_promotion','agency_services','other_external','packaging','software_services'].entries()) {
    await insert('expense_versions',{...expenseValues,version_no:i+1,category});
  }
  pass('store-wide expenses retain exact amounts and support old and new categories');
  await rejects('insert into mc.expenses(business_id,store_id) values($1,$2)',[b.id,store2.id],/foreign key/,'store-wide expense cannot link a foreign tenant store');
  await rejects('insert into mc.expenses(business_id,store_id) values($1,gen_random_uuid())',[b.id],/foreign key/,'store-wide expense must reference an existing store');
  await rejects('insert into mc.expenses(business_id,store_id,product_id) values($1,$2,$3)',[b.id,store.id,products[3].id],/foreign key/,'product expense still requires a selected product');
  await rejects('insert into mc.expenses(business_id,store_id,product_id) values($1,$2,$3)',[b.id,store.id,foreign.id],/foreign key/,'product expense rejects foreign tenant product');
  await rejects('update mc.expenses set product_id=$1 where id=$2',[products[0].id,storeExpense.id],/immutable/,'store-wide expense cannot silently change to product scope');
  await rejects('update mc.expenses set current_version_id=$1 where id=$2',[expenseV.id,storeExpense.id],/foreign key/,'expense pointer must reference its own version');
  await assert.rejects(()=>insert('expense_versions',{...expenseValues,version_no:6,category:'wb_commission'}),/check constraint/);
  pass('unsupported expense categories are rejected');
  for(const kind of ['promotion_expenses','expenses']) {
    await insert('import_batches',{...base,document_id:doc.id,kind,uploaded_by:user.id});
  }
  pass('generic expense imports coexist with legacy promotion expense imports');

  const tax = await insert('tax_settings',{business_id:b.id,effective_from:'2026-01-01'});
  const taxValues={business_id:b.id,tax_setting_id:tax.id,version_no:1,regime_code:'usn_income',usn_rate_fraction:'0.0600000000000000001',vat_mode:'exempt',changed_by:user.id};
  const taxV1=await insert('tax_setting_versions',taxValues);
  assert.equal(taxV1.usn_rate_fraction,'0.0600000000000000001');
  await q('update mc.tax_settings set current_version_id=$1 where id=$2',[taxV1.id,tax.id]);
  const taxV2=await insert('tax_setting_versions',{...taxValues,version_no:2,usn_rate_fraction:'0.05',vat_mode:'special'});
  await q('update mc.tax_settings set current_version_id=$1 where id=$2',[taxV2.id,tax.id]);
  assert.equal((await one('select usn_rate_fraction from mc.tax_setting_versions where id=$1',[taxV1.id])).usn_rate_fraction,taxValues.usn_rate_fraction);
  pass('tax correction switches current version and preserves exact historical rate');
  const laterTax=await insert('tax_settings',{business_id:b.id,effective_from:'2026-10-01'});
  const laterTaxV=await insert('tax_setting_versions',{...taxValues,tax_setting_id:laterTax.id,usn_rate_fraction:'0.06',vat_mode:'general'});
  await q('update mc.tax_settings set current_version_id=$1 where id=$2',[laterTaxV.id,laterTax.id]);
  assert.equal((await one(`select v.id from mc.tax_settings s join mc.tax_setting_versions v on v.id=s.current_version_id where s.business_id=$1 and s.effective_from<=$2::date order by s.effective_from desc limit 1`,[b.id,'2026-09-30'])).id,taxV2.id);
  assert.equal((await one(`select v.id from mc.tax_settings s join mc.tax_setting_versions v on v.id=s.current_version_id where s.business_id=$1 and s.effective_from<=$2::date order by s.effective_from desc limit 1`,[b.id,'2026-10-01'])).id,laterTaxV.id);
  pass('tax effective dates preserve independent pre- and post-change settings');
  await rejects('insert into mc.tax_settings(business_id,effective_from) values($1,$2)',[b.id,'2026-01-01'],/unique constraint/,'tax effective date is unique per business');
  await rejects('update mc.tax_settings set current_version_id=$1 where id=$2',[laterTaxV.id,tax.id],/foreign key/,'tax pointer cannot reference another effective date');
  await rejects('update mc.tax_settings set effective_from=$1 where id=$2',['2026-02-01',tax.id],/immutable/,'tax effective date cannot be overwritten');
  await rejects('update mc.tax_settings set business_id=$1 where id=$2',[b2.id,tax.id],/immutable/,'tax identity cannot move to another tenant');
  await rejects('delete from mc.tax_settings where id=$1',[tax.id],/immutable/,'tax identity cannot be deleted');
  await rejects('update mc.tax_setting_versions set usn_rate_fraction=0.07 where id=$1',[taxV1.id],/immutable/,'historical tax rate cannot be overwritten');
  await rejects('delete from mc.tax_setting_versions where id=$1',[taxV1.id],/immutable/,'historical tax version cannot be deleted');
  await assert.rejects(()=>insert('tax_setting_versions',{...taxValues,business_id:b2.id,version_no:3}),/foreign key/);
  pass('tax version parent is tenant-bound even for database owner');
  await context(b2.id,user.id);
  const foreignTax=await insert('tax_settings',{business_id:b2.id,effective_from:'2026-01-01'});
  const foreignTaxV=await insert('tax_setting_versions',{...taxValues,business_id:b2.id,tax_setting_id:foreignTax.id});
  await context(b.id,user.id);
  await rejects('update mc.tax_settings set current_version_id=$1 where id=$2',[foreignTaxV.id,tax.id],/foreign key/,'tax pointer cannot reference a foreign tenant version');
  for(const invalid of [
    {usn_rate_fraction:null},{usn_rate_fraction:'-0.01'},{usn_rate_fraction:'1.01'},
    {usn_rate_fraction:'NaN'},{usn_rate_fraction:'Infinity'},
    {regime_code:'osno',usn_rate_fraction:'0.06'},
    {regime_code:'usn_income_expenses',usn_rate_fraction:null},
    {regime_code:'unknown'},{vat_mode:'unknown'},{state:'deleted'},{currency:'USD'},{version_no:0}
  ]) {
    await assert.rejects(()=>insert('tax_setting_versions',{...taxValues,version_no:3,...invalid}),/check constraint/);
  }
  const noRate={...taxValues,version_no:3};
  delete noRate.usn_rate_fraction;
  await assert.rejects(()=>insert('tax_setting_versions',noRate),/check constraint/);
  await assert.rejects(()=>insert('tax_setting_versions',{...taxValues,version_no:3,vat_mode:null}),/not-null constraint/);
  pass('tax regime, finite rate, VAT mode, state and currency constraints reject invalid inputs and missing rate');
  for(const [i,values] of [
    {regime_code:'usn_income',usn_rate_fraction:'0',vat_mode:'unmodeled'},
    {regime_code:'usn_income_expenses',usn_rate_fraction:'1',vat_mode:'exempt'},
    {regime_code:'usn_income_expenses',usn_rate_fraction:'0.15',vat_mode:'special'},
    {regime_code:'osno',usn_rate_fraction:null,vat_mode:'general'},
    {regime_code:'osno',usn_rate_fraction:null,vat_mode:'exempt',state:'voided'}
  ].entries()) await insert('tax_setting_versions',{...taxValues,version_no:i+3,...values});
  pass('all planned tax regimes, independent VAT modes and explicit zero USN rate are representable');
  const voidedTax=await insert('tax_setting_versions',{...taxValues,version_no:8,state:'voided'});
  await q('update mc.tax_settings set current_version_id=$1 where id=$2',[voidedTax.id,tax.id]);
  assert.equal((await one('select count(*)::int as n from mc.tax_setting_versions where tax_setting_id=$1',[tax.id])).n,8);
  pass('voiding a tax setting appends history instead of deleting it');
  const taxAudit=await q("select * from mc.audit_events where entity_type in ('tax_settings','tax_setting_versions') and business_id=$1",[b.id]);
  assert.ok(taxAudit.some(row=>row.action==='created'&&row.entity_id===taxV1.id));
  assert.ok(taxAudit.some(row=>row.action==='updated'&&row.safe_details.after.current_version_id===voidedTax.id));
  assert.ok(taxAudit.every(row=>row.store_id===null&&row.actor_user_id===user.id));
  pass('business-level tax creation, versions and pointer changes produce actor-attributed audit events');

  const reportDoc = await insert('source_documents',{...base,origin:'wb_api',document_type:'financial_report',checksum:'report-content',completeness:'complete'});
  const report = await insert('reports',{...base,external_report_id:'report-1',period_start:'2026-08-31',period_end:'2026-09-06'});
  const rv = await insert('report_versions',{...base,report_id:report.id,document_id:reportDoc.id,version_no:1,checksum:'hash-1',parser_version:'test'});
  const rr = await insert('report_rows',{...base,report_version_id:rv.id,external_row_key:'row-1',row_number:1,raw_data:{test:true},row_checksum:'h1'});
  await rejects('insert into mc.report_rows(business_id,store_id,report_version_id,external_row_key,row_number,raw_data,row_checksum) values($1,$2,$3,$4,2,$5,$6)',[b.id,store.id,rv.id,'row-1',{},'h2'],/unique constraint/,'report row identity prevents duplicate import');
  await rejects('update mc.reports set current_version_id=$1 where id=$2',[rv.id,report.id],/accepted/,'unvalidated report cannot be current');
  await q("update mc.report_versions set status='validated' where id=$1",[rv.id]);
  await q("update mc.report_versions set status='accepted',accepted_at=now() where id=$1",[rv.id]);
  await q('update mc.reports set current_version_id=$1 where id=$2',[rv.id,report.id]);
  await rejects('update mc.report_rows set raw_data=$1 where id=$2',[{changed:true},rr.id],/immutable/,'raw financial row cannot be edited');
  await rejects('insert into mc.report_rows(business_id,store_id,report_version_id,external_row_key,row_number,raw_data,row_checksum) values($1,$2,$3,$4,2,$5,$6)',[b.id,store.id,rv.id,'row-2',{},'h2'],/before validation/,'accepted report cannot gain extra rows');
  await rejects('insert into mc.report_versions(business_id,store_id,report_id,document_id,version_no,checksum,parser_version) values($1,$2,$3,$4,2,$5,$6)',[b.id,store.id,report.id,reportDoc.id,'hash-1','test'],/unique constraint/,'identical report payload is not a new version');

  const method = await insert('method_versions',{code:'test_only',version_no:1,description:'Test fixture, not WB methodology',implementation_version:'test'});
  const wbFinanceV2=await one("select id from mc.method_versions where code='wb_finance_import' and version_no=2");
  const normalization=await insert('report_normalizations',{...base,report_version_id:rv.id,method_version_id:wbFinanceV2.id,normalization_key:`wb-finance-v2:${rv.id}`,status:'succeeded'});
  const op = await insert('operations',{...base,source_code:'wb',source_operation_key:'report-1/row-1'});
  const ov = await insert('operation_versions',{...base,operation_id:op.id,report_row_id:rr.id,report_normalization_id:normalization.id,version_no:1,srid:'shared-srid',operation_type:'sale',product_id:products[0].id,variant_id:small.id,accounting_date:'2026-09-01',quantity:2});
  const component = await insert('financial_components',{...base,operation_version_id:ov.id,component_key:'revenue',category_code:'revenue',amount_signed:2000,method_version_id:wbFinanceV2.id,result_scope_classification:'selected_product'});
  const op2 = await insert('operations',{...base,source_code:'wb',source_operation_key:'another-row'});
  await insert('operation_versions',{...base,operation_id:op2.id,report_row_id:rr.id,version_no:1,srid:'shared-srid',operation_type:'service_charge',accounting_date:'2026-09-01'});
  pass('multiple operations may share srid');
  const resultMethodV1=await one("select id from mc.method_versions where code='financial_result' and version_no=1");
  const invalidation=await one('select requested_by,reason,generation_token from mc.calculation_invalidations where store_id=$1',[store.id]);
  assert.equal(invalidation.requested_by,user.id);
  assert.ok(invalidation.reason);
  assert.equal((await one('select count(*)::int as n from mc.list_calculation_invalidations() where store_id=$1',[store.id])).n,1);
  assert.equal((await one(`select mc.ack_calculation_invalidation($1,$2,'00000000-0000-4000-8000-000000000001') as ok`,[user.id,store.id])).ok,false);
  assert.equal((await one('select mc.ack_calculation_invalidation($1,$2,$3) as ok',[user.id,store.id,invalidation.generation_token])).ok,true);
  pass('financial input changes leave a durable scoped invalidation with token-safe acknowledgement');
  const request=await insert('calculation_requests',{...base,generation_no:1,selection_id:selection.id,method_version_id:resultMethodV1.id,period_start:'2026-08-31',period_end:'2026-09-06',input_fingerprint:'p03-inputs-1'});
  await insert('calculation_request_products',{...base,request_id:request.id,product_id:products[0].id});
  await insert('calculation_request_inputs',{...base,request_id:request.id,report_normalization_id:normalization.id});
  await insert('calculation_request_inputs',{...base,request_id:request.id,cost_version_id:costV1.id});
  const attempt=await insert('calculation_runs',{...base,selection_id:selection.id,method_version_id:resultMethodV1.id,period_start:'2026-08-31',period_end:'2026-09-06',input_fingerprint:'p03-inputs-1',request_id:request.id,attempt_no:1});
  await rejects('insert into mc.calculation_request_products(business_id,store_id,request_id,product_id) values($1,$2,$3,$4)',[b.id,store.id,request.id,products[1].id],/snapshot is frozen/,'calculation snapshot freezes when an attempt starts');
  await insert('calculation_inputs',{...base,run_id:attempt.id,report_normalization_id:normalization.id});
  await insert('calculation_inputs',{...base,run_id:attempt.id,cost_version_id:costV1.id});
  await rejects('insert into mc.result_lines(business_id,store_id,run_id,accounting_date,category_code,amount_signed,quality,result_scope) values($1,$2,$3,$4,$5,$6,$7,$8)',[b.id,store.id,attempt.id,'2026-09-01','revenue',1,'partial','selected_product'],/outside frozen request snapshot/,'selected-product result requires a frozen product');
  const p03CostLine=await insert('result_lines',{...base,run_id:attempt.id,product_id:products[0].id,variant_id:small.id,accounting_date:'2026-09-01',category_code:'cost_of_goods',amount_signed:-900,quality:'partial',result_scope:'selected_product'});
  await rejects('insert into mc.result_evidence(business_id,store_id,result_line_id,cost_version_id,source_operation_version_id,quantity,contribution_amount) values($1,$2,$3,$4,$5,1,-450)',[b.id,store.id,p03CostLine.id,costV1.id,ov.id],/quantity/,'P0.3 cost evidence quantity must equal its frozen operation');
  await insert('result_evidence',{...base,result_line_id:p03CostLine.id,cost_version_id:costV1.id,source_operation_version_id:ov.id,quantity:2,contribution_amount:-900});
  await q("update mc.calculation_runs set status='succeeded',quality='partial',missing_reasons='[\"tax_method_unsupported\"]',finished_at=now() where id=$1",[attempt.id]);
  pass('P0.3 request freezes products and normalization while cost evidence proves quantity');
  const resultMethodV4Id=(await one("select id from mc.method_versions where code='financial_result' and version_no=4")).id;
  const taxRequest=await insert('calculation_requests',{...base,generation_no:2,selection_id:selection.id,method_version_id:resultMethodV4Id,period_start:'2026-08-31',period_end:'2026-09-06',input_fingerprint:'p03-tax-inputs',is_latest:false});
  await insert('calculation_request_products',{...base,request_id:taxRequest.id,product_id:products[0].id});
  await insert('calculation_request_inputs',{...base,request_id:taxRequest.id,report_normalization_id:normalization.id});
  await insert('calculation_request_inputs',{...base,request_id:taxRequest.id,tax_setting_version_id:taxV2.id});
  const taxRun=await insert('calculation_runs',{...base,selection_id:selection.id,method_version_id:resultMethodV4Id,period_start:'2026-08-31',period_end:'2026-09-06',input_fingerprint:'p03-tax-inputs',request_id:taxRequest.id,attempt_no:1});
  await insert('calculation_inputs',{...base,run_id:taxRun.id,report_normalization_id:normalization.id});
  await insert('calculation_inputs',{...base,run_id:taxRun.id,tax_setting_version_id:taxV2.id});
  await rejects('insert into mc.tax_computations(business_id,store_id,run_id,product_id,period_start,period_end,taxable_base,tax_amount,method_version_id) values($1,$2,$3,$4,$5,$6,2000,100,$7)',[b.id,store.id,taxRun.id,products[1].id,'2026-08-31','2026-09-06',resultMethodV4Id],/outside frozen request/,'tax computation requires a frozen selected product');
  const taxComputation=await insert('tax_computations',{...base,run_id:taxRun.id,product_id:products[0].id,period_start:'2026-08-31',period_end:'2026-09-06',taxable_base:2000,tax_amount:100,method_version_id:resultMethodV4Id});
  await rejects('insert into mc.tax_computation_segments(business_id,store_id,tax_computation_id,tax_setting_version_id,segment_start,segment_end,taxable_base,rate_fraction) values($1,$2,$3,$4,$5,$6,2000,0.05)',[b.id,store.id,taxComputation.id,taxV2.id,'2026-09-01','2026-09-06'],/effective setting bounds/,'tax segment must cover exact effective bounds');
  const taxSegment=await insert('tax_computation_segments',{...base,tax_computation_id:taxComputation.id,tax_setting_version_id:taxV2.id,segment_start:'2026-08-31',segment_end:'2026-09-06',taxable_base:2000,rate_fraction:'0.05'});
  const taxComponent=await insert('financial_components',{...base,operation_version_id:ov.id,component_key:'tax-retail',category_code:'revenue',amount_signed:2000,method_version_id:wbFinanceV2.id,source_field:'retailAmount',result_scope_classification:'selected_product'});
  await rejects('insert into mc.tax_basis_evidence(business_id,store_id,tax_segment_id,financial_component_id,taxable_contribution,recognition_date) values($1,$2,$3,$4,1999,$5)',[b.id,store.id,taxSegment.id,taxComponent.id,'2026-09-01'],/verified frozen retailAmount/,'tax basis must equal its signed retailAmount component');
  await insert('tax_basis_evidence',{...base,tax_segment_id:taxSegment.id,financial_component_id:taxComponent.id,taxable_contribution:2000,recognition_date:'2026-09-01'});
  const taxLine=await insert('result_lines',{...base,run_id:taxRun.id,product_id:products[0].id,accounting_date:'2026-09-06',category_code:'estimated_usn_tax',amount_signed:-100,quality:'complete',result_scope:'selected_product'});
  await insert('result_evidence',{...base,result_line_id:taxLine.id,tax_computation_id:taxComputation.id,contribution_amount:-100});
  await rejects('insert into mc.result_evidence(business_id,store_id,result_line_id,tax_computation_id,contribution_amount) values($1,$2,$3,$4,-100)',[b.id,store.id,taxLine.id,taxComputation.id],/unique|duplicate/i,'tax computation can be deducted only once');
  await q("update mc.calculation_runs set status='succeeded',quality='complete',missing_reasons='[]',finished_at=now() where id=$1",[taxRun.id]);
  await rejects('insert into mc.tax_computation_segments(business_id,store_id,tax_computation_id,tax_setting_version_id,segment_start,segment_end,taxable_base,rate_fraction) values($1,$2,$3,$4,$5,$6,0,0.05)',[b.id,store.id,taxComputation.id,taxV2.id,'2026-08-31','2026-09-06'],/calculation|running/,'successful run seals persisted tax artifacts');
  pass('selected-SKU tax artifacts enforce frozen inputs, exact basis and reconciled result evidence');
  const resultMethodV19Id=(await one("select id from mc.method_versions where code='financial_result' and version_no=19")).id;
  const signedRequest=await insert('calculation_requests',{...base,generation_no:210,selection_id:selection.id,method_version_id:resultMethodV19Id,period_start:'2026-08-31',period_end:'2026-09-06',input_fingerprint:'signed-tax-positive-period',is_latest:false});
  await insert('calculation_request_products',{...base,request_id:signedRequest.id,product_id:products[0].id});
  await insert('calculation_request_products',{...base,request_id:signedRequest.id,product_id:products[1].id});
  await insert('calculation_request_inputs',{...base,request_id:signedRequest.id,report_normalization_id:normalization.id});
  const signedRun=await insert('calculation_runs',{...base,selection_id:selection.id,method_version_id:resultMethodV19Id,period_start:'2026-08-31',period_end:'2026-09-06',input_fingerprint:'signed-tax-positive-period',request_id:signedRequest.id,attempt_no:1});
  await insert('financial_period_results',{...base,run_id:signedRun.id,period_start:'2026-08-31',period_end:'2026-09-06',quality:'partial',missing_reasons:['operation_unclassified'],totals:{selectedProductsResultBeforeTax:'0.0000',storeLevelResultBeforeTax:'0.0000',availableResultBeforeTax:'0.0000',estimatedUsnTax:'64.0000',availableResultAfterTax:null,netProfit:null}});
  await insert('tax_computations',{...base,run_id:signedRun.id,product_id:products[0].id,period_start:'2026-08-31',period_end:'2026-09-06',taxable_base:1000,tax_amount:80,method_version_id:resultMethodV19Id});
  await insert('tax_computations',{...base,run_id:signedRun.id,product_id:products[1].id,period_start:'2026-08-31',period_end:'2026-09-06',taxable_base:-200,tax_amount:-16,method_version_id:resultMethodV19Id});
  await q('create temporary table signed_tax_guard_probe(id uuid primary key,status text not null,method_version_id uuid not null)');
  await q('create trigger signed_tax_guard_probe before update on signed_tax_guard_probe for each row execute function mc.guard_signed_tax_period_finish()');
  await q("insert into signed_tax_guard_probe values($1,'running',$2)",[signedRun.id,resultMethodV19Id]);
  await q("update signed_tax_guard_probe set status='succeeded' where id=$1",[signedRun.id]);

  const negativeRequest=await insert('calculation_requests',{...base,generation_no:211,selection_id:selection.id,method_version_id:resultMethodV19Id,period_start:'2026-09-07',period_end:'2026-09-13',input_fingerprint:'signed-tax-negative-period',is_latest:false});
  await insert('calculation_request_products',{...base,request_id:negativeRequest.id,product_id:products[0].id});
  await insert('calculation_request_inputs',{...base,request_id:negativeRequest.id,report_normalization_id:normalization.id});
  const negativeRun=await insert('calculation_runs',{...base,selection_id:selection.id,method_version_id:resultMethodV19Id,period_start:'2026-09-07',period_end:'2026-09-13',input_fingerprint:'signed-tax-negative-period',request_id:negativeRequest.id,attempt_no:1});
  await insert('financial_period_results',{...base,run_id:negativeRun.id,period_start:'2026-09-07',period_end:'2026-09-13',quality:'partial',missing_reasons:['operation_unclassified'],totals:{selectedProductsResultBeforeTax:'0.0000',storeLevelResultBeforeTax:'0.0000',availableResultBeforeTax:'0.0000',estimatedUsnTax:null,availableResultAfterTax:null,netProfit:null}});
  await insert('tax_computations',{...base,run_id:negativeRun.id,product_id:products[0].id,period_start:'2026-09-07',period_end:'2026-09-13',taxable_base:-100,tax_amount:-8,method_version_id:resultMethodV19Id});
  await q("insert into signed_tax_guard_probe values($1,'running',$2)",[negativeRun.id,resultMethodV19Id]);
  await rejects("update signed_tax_guard_probe set status='succeeded' where id=$1",[negativeRun.id],/signed tax period total/,'signed tax methodology rejects a negative aggregate period');

  const legacySignedRequest=await insert('calculation_requests',{...base,generation_no:212,selection_id:selection.id,method_version_id:resultMethodV4Id,period_start:'2026-09-14',period_end:'2026-09-20',input_fingerprint:'legacy-negative-product-tax',is_latest:false});
  await insert('calculation_request_products',{...base,request_id:legacySignedRequest.id,product_id:products[0].id});
  await insert('calculation_request_inputs',{...base,request_id:legacySignedRequest.id,report_normalization_id:normalization.id});
  const legacySignedRun=await insert('calculation_runs',{...base,selection_id:selection.id,method_version_id:resultMethodV4Id,period_start:'2026-09-14',period_end:'2026-09-20',input_fingerprint:'legacy-negative-product-tax',request_id:legacySignedRequest.id,attempt_no:1});
  await insert('tax_computations',{...base,run_id:legacySignedRun.id,product_id:products[0].id,period_start:'2026-09-14',period_end:'2026-09-20',taxable_base:-100,tax_amount:-8,method_version_id:resultMethodV4Id});
  await q("insert into signed_tax_guard_probe values($1,'running',$2)",[legacySignedRun.id,resultMethodV4Id]);
  await rejects("update signed_tax_guard_probe set status='succeeded' where id=$1",[legacySignedRun.id],/signed tax methodology/,'legacy methodology rejects a negative product tax');
  pass('signed tax is limited to v19-v20 and requires a non-negative total for every period');
  const resultMethodV5Id=(await one("select id from mc.method_versions where code='financial_result' and version_no=5")).id;
  const periodRequest=await insert('calculation_requests',{...base,generation_no:90,selection_id:selection.id,method_version_id:resultMethodV5Id,period_start:'2026-08-31',period_end:'2026-09-06',input_fingerprint:'p03-period-tampering',is_latest:false});
  await insert('calculation_request_products',{...base,request_id:periodRequest.id,product_id:products[0].id});
  await insert('calculation_request_inputs',{...base,request_id:periodRequest.id,report_version_id:rv.id});
  await insert('calculation_request_inputs',{...base,request_id:periodRequest.id,report_normalization_id:normalization.id});
  const periodRun=await insert('calculation_runs',{...base,selection_id:selection.id,method_version_id:resultMethodV5Id,period_start:'2026-08-31',period_end:'2026-09-06',input_fingerprint:'p03-period-tampering',request_id:periodRequest.id,attempt_no:1});
  await insert('calculation_inputs',{...base,run_id:periodRun.id,report_version_id:rv.id});
  await insert('calculation_inputs',{...base,run_id:periodRun.id,report_normalization_id:normalization.id});
  const falsePeriod=await insert('financial_period_results',{...base,run_id:periodRun.id,period_start:'2026-08-31',period_end:'2026-09-06',quality:'complete',missing_reasons:[],totals:{selectedProductsResultBeforeTax:'999.0000',storeLevelResultBeforeTax:'0.0000',availableResultBeforeTax:'999.0000',estimatedUsnTax:'0.0000',availableResultAfterTax:null,netProfit:null}});
  const periodLine=await insert('result_lines',{...base,run_id:periodRun.id,financial_period_result_id:falsePeriod.id,product_id:products[0].id,variant_id:small.id,accounting_date:'2026-09-01',category_code:'revenue',amount_signed:2000,quality:'complete',result_scope:'selected_product'});
  await insert('result_evidence',{...base,result_line_id:periodLine.id,financial_component_id:component.id,contribution_amount:2000});
  await rejects("update mc.calculation_runs set status='succeeded',quality='complete',missing_reasons='[]',finished_at=now() where id=$1",[periodRun.id],/period result totals/,'persisted weekly totals cannot be sealed when they disagree with evidence');
  const resultMethodV8Id=(await one("select id from mc.method_versions where code='financial_result' and version_no=8")).id;
  const storeExpenseVersion=await one('select id,category,amount::text from mc.expense_versions where expense_id=$1 order by version_no limit 1',[storeExpense.id]);
  const wrongCombinedRequest=await insert('calculation_requests',{...base,generation_no:91,selection_id:selection.id,method_version_id:resultMethodV8Id,period_start:'2026-08-31',period_end:'2026-09-06',input_fingerprint:'p03-v8-wrong-combined-total',is_latest:false});
  await insert('calculation_request_products',{...base,request_id:wrongCombinedRequest.id,product_id:products[0].id});
  await insert('calculation_request_inputs',{...base,request_id:wrongCombinedRequest.id,report_version_id:rv.id});
  await insert('calculation_request_inputs',{...base,request_id:wrongCombinedRequest.id,report_normalization_id:normalization.id});
  await insert('calculation_request_inputs',{...base,request_id:wrongCombinedRequest.id,expense_version_id:storeExpenseVersion.id});
  const wrongCombinedRun=await insert('calculation_runs',{...base,selection_id:selection.id,method_version_id:resultMethodV8Id,period_start:'2026-08-31',period_end:'2026-09-06',input_fingerprint:'p03-v8-wrong-combined-total',request_id:wrongCombinedRequest.id,attempt_no:1});
  await insert('calculation_inputs',{...base,run_id:wrongCombinedRun.id,report_version_id:rv.id});
  await insert('calculation_inputs',{...base,run_id:wrongCombinedRun.id,report_normalization_id:normalization.id});
  await insert('calculation_inputs',{...base,run_id:wrongCombinedRun.id,expense_version_id:storeExpenseVersion.id});
  const wrongCombinedPeriod=await insert('financial_period_results',{...base,run_id:wrongCombinedRun.id,period_start:'2026-08-31',period_end:'2026-09-06',quality:'complete',missing_reasons:[],totals:{selectedProductsResultBeforeTax:'2000.0000',storeLevelResultBeforeTax:'-123.4567',availableResultBeforeTax:'2000.0000',estimatedUsnTax:'0.0000',availableResultAfterTax:null,netProfit:null}});
  const wrongCombinedSelectedLine=await insert('result_lines',{...base,run_id:wrongCombinedRun.id,financial_period_result_id:wrongCombinedPeriod.id,product_id:products[0].id,variant_id:small.id,accounting_date:'2026-09-01',category_code:'revenue',amount_signed:2000,quality:'complete',result_scope:'selected_product'});
  await insert('result_evidence',{...base,result_line_id:wrongCombinedSelectedLine.id,financial_component_id:component.id,contribution_amount:2000});
  const wrongCombinedStoreLine=await insert('result_lines',{...base,run_id:wrongCombinedRun.id,financial_period_result_id:wrongCombinedPeriod.id,accounting_date:'2026-09-01',category_code:storeExpenseVersion.category,amount_signed:'-123.4567',quality:'complete',result_scope:'store'});
  await insert('result_evidence',{...base,result_line_id:wrongCombinedStoreLine.id,expense_version_id:storeExpenseVersion.id,contribution_amount:'-123.4567'});
  await rejects("update mc.calculation_runs set status='succeeded',quality='complete',missing_reasons='[]',finished_at=now() where id=$1",[wrongCombinedRun.id],/period result totals/,'financial-result-v8 rejects a total that omits store scope');
  const combinedRequest=await insert('calculation_requests',{...base,generation_no:92,selection_id:selection.id,method_version_id:resultMethodV8Id,period_start:'2026-08-31',period_end:'2026-09-06',input_fingerprint:'p03-v8-combined-total',is_latest:false});
  await insert('calculation_request_products',{...base,request_id:combinedRequest.id,product_id:products[0].id});
  await insert('calculation_request_inputs',{...base,request_id:combinedRequest.id,report_version_id:rv.id});
  await insert('calculation_request_inputs',{...base,request_id:combinedRequest.id,report_normalization_id:normalization.id});
  await insert('calculation_request_inputs',{...base,request_id:combinedRequest.id,expense_version_id:storeExpenseVersion.id});
  const combinedRun=await insert('calculation_runs',{...base,selection_id:selection.id,method_version_id:resultMethodV8Id,period_start:'2026-08-31',period_end:'2026-09-06',input_fingerprint:'p03-v8-combined-total',request_id:combinedRequest.id,attempt_no:1});
  await insert('calculation_inputs',{...base,run_id:combinedRun.id,report_version_id:rv.id});
  await insert('calculation_inputs',{...base,run_id:combinedRun.id,report_normalization_id:normalization.id});
  await insert('calculation_inputs',{...base,run_id:combinedRun.id,expense_version_id:storeExpenseVersion.id});
  const combinedPeriod=await insert('financial_period_results',{...base,run_id:combinedRun.id,period_start:'2026-08-31',period_end:'2026-09-06',quality:'complete',missing_reasons:[],totals:{selectedProductsResultBeforeTax:'2000.0000',storeLevelResultBeforeTax:'-123.4567',availableResultBeforeTax:'1876.5433',estimatedUsnTax:'0.0000',availableResultAfterTax:null,netProfit:null}});
  const combinedSelectedLine=await insert('result_lines',{...base,run_id:combinedRun.id,financial_period_result_id:combinedPeriod.id,product_id:products[0].id,variant_id:small.id,accounting_date:'2026-09-01',category_code:'revenue',amount_signed:2000,quality:'complete',result_scope:'selected_product'});
  await insert('result_evidence',{...base,result_line_id:combinedSelectedLine.id,financial_component_id:component.id,contribution_amount:2000});
  const combinedStoreLine=await insert('result_lines',{...base,run_id:combinedRun.id,financial_period_result_id:combinedPeriod.id,accounting_date:'2026-09-01',category_code:storeExpenseVersion.category,amount_signed:'-123.4567',quality:'complete',result_scope:'store'});
  await insert('result_evidence',{...base,result_line_id:combinedStoreLine.id,expense_version_id:storeExpenseVersion.id,contribution_amount:'-123.4567'});
  await q("update mc.calculation_runs set status='succeeded',quality='complete',missing_reasons='[]',finished_at=now() where id=$1",[combinedRun.id]);
  pass('financial-result-v8 seals selected plus store totals without weakening evidence guards');
  const run = await insert('calculation_runs',{...base,selection_id:selection.id,method_version_id:method.id,period_start:'2026-08-31',period_end:'2026-09-06',input_fingerprint:'inputs-1'});
  await insert('calculation_inputs',{...base,run_id:run.id,report_version_id:rv.id});
  await insert('calculation_inputs',{...base,run_id:run.id,cost_version_id:costV1.id});
  const line = await insert('result_lines',{...base,run_id:run.id,product_id:products[0].id,variant_id:small.id,accounting_date:'2026-09-01',category_code:'revenue',amount_signed:2000,quality:'complete'});
  await rejects("update mc.calculation_runs set status='succeeded',finished_at=now() where id=$1",[run.id],/reconcile/,'cannot finish a result without evidence');
  await insert('result_evidence',{...base,result_line_id:line.id,financial_component_id:component.id,contribution_amount:2000});
  const costLine = await insert('result_lines',{...base,run_id:run.id,product_id:products[0].id,variant_id:small.id,accounting_date:'2026-09-01',category_code:'cost_of_goods',amount_signed:-900,quality:'complete'});
  await rejects('insert into mc.result_evidence(business_id,store_id,result_line_id,cost_version_id,quantity,contribution_amount) values($1,$2,$3,$4,2,-940)',[b.id,store.id,costLine.id,costMV.id],/match product, variant/,'cannot use another size cost in financial evidence');
  await insert('result_evidence',{...base,result_line_id:costLine.id,cost_version_id:costV1.id,quantity:2,contribution_amount:-900});
  await rejects('insert into mc.result_lines(business_id,store_id,run_id,product_id,accounting_date,category_code,amount_signed,quality) values($1,$2,$3,$4,$5,$6,1,$7)',[b.id,store.id,run.id,products[3].id,'2026-09-01','revenue','complete'],/foreign key/,'results cannot include unselected products');
  await rejects('insert into mc.result_lines(business_id,store_id,run_id,product_id,accounting_date,category_code,amount_signed,quality) values($1,$2,$3,$4,$5,$6,1,$7)',[b.id,store.id,run.id,products[0].id,'2026-10-01','revenue','complete'],/outside/,'result date must be within run');
  await rejects('insert into mc.result_lines(business_id,store_id,run_id,product_id,accounting_date,category_code,amount_signed,quality) values($1,$2,$3,$4,$5,$6,1,$7)',[b.id,store.id,run.id,products[0].id,'2026-09-01','payout','complete'],/cannot be profit/,'settlements cannot be counted as profit');
  await q("update mc.calculation_runs set status='succeeded',finished_at=now(),quality='partial',missing_reasons=$2 where id=$1",[run.id,JSON.stringify(['Only selected products; external costs not calculated in fixture'])]);
  await insert('publications',{...base,run_id:run.id});
  assert.equal(Number((await one('select sum(amount_signed) as n from mc.current_daily_results')).n),1100);
  pass('publication exposes reconciled result for selected products');
  await rejects('insert into mc.result_lines(business_id,store_id,run_id,product_id,accounting_date,category_code,amount_signed,quality) values($1,$2,$3,$4,$5,$6,1,$7)',[b.id,store.id,run.id,products[0].id,'2026-09-01','revenue','complete'],/sealed/,'successful calculation cannot receive more rows');

  const rv2 = await insert('report_versions',{...base,report_id:report.id,document_id:reportDoc.id,version_no:2,checksum:'hash-2',parser_version:'test'});
  await q("update mc.report_versions set status='validated' where id=$1",[rv2.id]);
  await q("update mc.report_versions set status='accepted',accepted_at=now() where id=$1",[rv2.id]);
  const run2 = await insert('calculation_runs',{...base,selection_id:selection.id,method_version_id:method.id,period_start:'2026-08-31',period_end:'2026-09-06',input_fingerprint:'inputs-2'});
  await insert('calculation_inputs',{...base,run_id:run2.id,report_version_id:rv.id});
  await rejects('insert into mc.calculation_inputs(business_id,store_id,run_id,report_version_id) values($1,$2,$3,$4)',[b.id,store.id,run2.id,rv2.id],/two versions/,'one calculation cannot include two revisions of same report');
  await rejects('insert into mc.publications(business_id,store_id,run_id) values($1,$2,$3)',[b.id,store.id,run2.id],/successful/,'unfinished calculation cannot be published');
  for(let i=0;i<2;i++) {
    const duplicate = await insert('result_lines',{...base,run_id:run2.id,product_id:products[0].id,accounting_date:'2026-09-01',category_code:'revenue',amount_signed:2000,quality:'complete'});
    await insert('result_evidence',{...base,result_line_id:duplicate.id,financial_component_id:component.id,contribution_amount:2000});
  }
  await rejects("update mc.calculation_runs set status='succeeded',finished_at=now() where id=$1",[run2.id],/more than once/,'duplicate financial contribution prevents publication');

  await insert('billing_payment_events',{business_id:b.id,provider:'test',external_event_id:'event-1',event_type:'payment',safe_payload:{}});
  await rejects('insert into mc.billing_payment_events(business_id,provider,external_event_id,event_type,safe_payload) values($1,$2,$3,$4,$5)',[b.id,'test','event-1','payment',{}],/unique constraint/,'duplicate provider event rejected');
  const job = await insert('jobs',{...base,job_type:'sync',deduplication_key:'sync-1'});
  await rejects('insert into mc.jobs(business_id,store_id,job_type,deduplication_key) values($1,$2,$3,$4)',[b.id,store.id,'sync','sync-1'],/unique constraint/,'active background job deduplicated');
  await q("update mc.jobs set status='succeeded',outcome='completed',finished_at=clock_timestamp() where id=$1",[job.id]);
  await insert('jobs',{...base,job_type:'sync',deduplication_key:'sync-1'});
  pass('completed job does not block next scheduled sync');

  const queueColumns=(await q("select column_name from information_schema.columns where table_schema='mc' and table_name='jobs' order by column_name")).map(row=>row.column_name);
  assert.ok(queueColumns.includes('available_at')&&!queueColumns.includes('scheduled_at'));
  for(const column of ['priority','lease_token','heartbeat_at','updated_at','finished_at','last_error_code','outcome']) assert.ok(queueColumns.includes(column));
  pass('durable queue migration installs the version 34 lifecycle columns');

  const queueOutsider=await insert('users',{display_name:'Queue outsider'});
  await context(b.id,queueOutsider.id);
  await rejects("select * from mc.enqueue_job($1,$2,$3,'{}'::jsonb,clock_timestamp(),0,5)",[store.id,'financial_recalculation','calc:outsider'],/owned business context/,'enqueue requires current business membership');
  await context(b.id,user.id);
  const queued=await one("select * from mc.enqueue_job($1,$2,$3,$4::jsonb,clock_timestamp(),$5,$6)",[store.id,'financial_recalculation','calc:week:1',JSON.stringify({period:'2026-W36'}),10,2]);
  const duplicateQueued=await one("select * from mc.enqueue_job($1,$2,$3,$4::jsonb,clock_timestamp(),$5,$6)",[store.id,'financial_recalculation','calc:week:1',JSON.stringify({period:'changed'}),50,9]);
  assert.equal(duplicateQueued.id,queued.id);
  assert.deepEqual(duplicateQueued.payload,{period:'2026-W36'});
  await one("select * from mc.enqueue_job($1,$2,$3,$4::jsonb,clock_timestamp(),$5,$6)",[store.id,'report_sync','sync:week:1','{}',100,3]);
  await one("select * from mc.enqueue_job($1,$2,$3,$4::jsonb,clock_timestamp(),$5,$6)",[store.id,'financial_recalculation','calc:week:2','{}',20,3]);
  await rejects("select * from mc.enqueue_job($1,$2,$3,$4::jsonb)",[store.id,'x'.repeat(101),'too-long-type','{}'],/required/,'enqueue rejects oversized job types');
  const claimed=await q("select * from mc.claim_jobs($1,$2::text[],$3,$4)",['worker-a',['financial_recalculation'],60,2]);
  assert.deepEqual(claimed.map(row=>row.deduplication_key),['calc:week:2','calc:week:1']);
  assert.ok(claimed.every(row=>row.status==='running'&&row.attempt_count===1&&row.lease_token));
  assert.equal((await one("select count(*)::int as n from mc.jobs where deduplication_key='sync:week:1' and status='pending'")).n,1);
  pass('claim filters job types and orders ready jobs by priority');

  const olderFetch=await one("select * from mc.enqueue_job($1,'financial_report_fetch',$2,$3::jsonb,clock_timestamp(),300,3)",[
    store.id,'fetch:older',JSON.stringify({periodStart:'2026-01-05',periodEnd:'2026-01-11'})
  ]);
  const newerFetch=await one("select * from mc.enqueue_job($1,'financial_report_fetch',$2,$3::jsonb,clock_timestamp(),300,3)",[
    store.id,'fetch:newer',JSON.stringify({periodStart:'2026-09-21',periodEnd:'2026-09-27'})
  ]);
  const newestFirst=await one("select * from mc.claim_jobs($1,$2::text[],60,1)",['fetch-recency-worker',['financial_report_fetch']]);
  assert.equal(newestFirst.id,newerFetch.id);
  await one("select * from mc.complete_job($1,$2,$3,'completed')",[newestFirst.id,newestFirst.lease_token,'fetch-recency-worker']);
  const oldestSecond=await one("select * from mc.claim_jobs($1,$2::text[],60,1)",['fetch-recency-worker',['financial_report_fetch']]);
  assert.equal(oldestSecond.id,olderFetch.id);
  await one("select * from mc.complete_job($1,$2,$3,'completed')",[oldestSecond.id,oldestSecond.lease_token,'fetch-recency-worker']);
  pass('equal-priority financial report fetches are claimed from the newest closed week to the oldest');

  await rejects("select * from mc.heartbeat_job($1,$2,$3,$4)",[claimed[0].id,claimed[1].lease_token,'worker-a',60],/not owned/,'heartbeat rejects a foreign lease token');
  const heartbeat=await one("select * from mc.heartbeat_job($1,$2,$3,$4)",[claimed[0].id,claimed[0].lease_token,'worker-a',120]);
  assert.ok(new Date(heartbeat.lease_until)>new Date(claimed[0].lease_until));
  const completed=await one("select * from mc.complete_job($1,$2,$3,$4)",[claimed[0].id,claimed[0].lease_token,'worker-a','superseded']);
  assert.equal(completed.status,'succeeded');
  assert.equal(completed.outcome,'superseded');
  assert.equal(completed.lease_token,null);
  pass('heartbeat and completion require the current lease token');

  await rejects("select * from mc.fail_job($1,$2,$3,$4,$5,$6)",[claimed[1].id,claimed[1].lease_token,'worker-a','unsafe error',true,60],/invalid/,'failure rejects unsafe error codes');
  const retried=await one("select * from mc.fail_job($1,$2,$3,$4,$5,$6)",[claimed[1].id,claimed[1].lease_token,'worker-a','temporary',true,60]);
  assert.equal(retried.status,'pending');
  assert.equal(retried.last_error_code,'temporary');
  assert.equal(retried.finished_at,null);
  await q("update mc.jobs set available_at=clock_timestamp()-interval '1 second' where id=$1",[retried.id]);
  await q("update mc.job_dispatch set available_at=clock_timestamp()-interval '1 second' where job_id=$1",[retried.id]);
  const retryClaim=await one("select * from mc.claim_jobs($1,$2::text[],$3,$4)",['worker-b',['financial_recalculation'],60,1]);
  assert.equal(retryClaim.id,retried.id);
  assert.equal(retryClaim.attempt_count,2);
  const terminal=await one("select * from mc.fail_job($1,$2,$3,$4,$5,$6)",[retryClaim.id,retryClaim.lease_token,'worker-b','still_failing',true,60]);
  assert.equal(terminal.status,'failed');
  assert.ok(terminal.finished_at);
  pass('failure retries with backoff and becomes terminal at max attempts');

  for(;;){
    const existingDaily=await one("select * from mc.claim_jobs($1,$2::text[],60,1)",['pre-shadow-drain',['financial_dates_recalculate']]);
    if(!existingDaily)break;
    await one("select * from mc.complete_job($1,$2,$3,'superseded')",[existingDaily.id,existingDaily.lease_token,'pre-shadow-drain']);
  }
  const exhaustedShadow=await one("select * from mc.enqueue_job($1,'financial_dates_recalculate',$2,'{}'::jsonb,clock_timestamp(),500,1)",[
    store.id,'daily-shadow:exhausted'
  ]);
  const exhaustedShadowClaim=await one("select * from mc.claim_jobs($1,$2::text[],60,1)",['shadow-exhaust-worker',['financial_dates_recalculate']]);
  assert.equal(exhaustedShadowClaim.id,exhaustedShadow.id);
  const exhaustedShadowFailure=await one("select * from mc.fail_job($1,$2,$3,$4,true,30)",[
    exhaustedShadowClaim.id,exhaustedShadowClaim.lease_token,'shadow-exhaust-worker','financial_daily_publication_shadow_incompatible'
  ]);
  assert.equal(exhaustedShadowFailure.status,'failed');
  const recoveredShadow=await one("select * from mc.wake_financial_daily_after_compatibility($1)",[store.id]);
  assert.equal(recoveredShadow.id,exhaustedShadow.id);
  assert.equal(recoveredShadow.status,'pending');
  assert.equal(recoveredShadow.attempt_count,0);
  assert.equal((await one('select count(*)::int n from mc.job_dispatch where job_id=$1',[exhaustedShadow.id])).n,1);
  const recoveredShadowClaim=await one("select * from mc.claim_jobs($1,$2::text[],60,1)",['shadow-recovered-worker',['financial_dates_recalculate']]);
  await one("select * from mc.complete_job($1,$2,$3,'completed')",[
    recoveredShadowClaim.id,recoveredShadowClaim.lease_token,'shadow-recovered-worker'
  ]);
  pass('successful compatibility work safely reopens only an exhausted shadow publication wait');

  const historicalShadow=await one("select * from mc.enqueue_job($1,'financial_dates_recalculate',$2,'{}'::jsonb,clock_timestamp(),500,1)",[
    store.id,'daily-shadow:historical-failed'
  ]);
  const historicalClaim=await one("select * from mc.claim_jobs($1,$2::text[],60,1)",['historical-shadow-worker',['financial_dates_recalculate']]);
  await one("select * from mc.fail_job($1,$2,$3,$4,true,30)",[
    historicalClaim.id,historicalClaim.lease_token,'historical-shadow-worker','financial_daily_publication_shadow_incompatible'
  ]);
  const currentDaily=await one("select * from mc.enqueue_job($1,'financial_dates_recalculate',$2,'{}'::jsonb,clock_timestamp(),500,3)",[
    store.id,'daily-shadow:current-active'
  ]);
  assert.equal((await one('select * from mc.wake_financial_daily_after_compatibility($1)',[store.id])).id,null);
  assert.equal((await one('select status from mc.jobs where id=$1',[historicalShadow.id])).status,'failed');
  const currentClaim=await one("select * from mc.claim_jobs($1,$2::text[],60,1)",['current-daily-worker',['financial_dates_recalculate']]);
  assert.equal(currentClaim.id,currentDaily.id);
  await one("select * from mc.complete_job($1,$2,$3,'completed')",[currentClaim.id,currentClaim.lease_token,'current-daily-worker']);
  const reopenedHistorical=await one('select * from mc.wake_financial_daily_after_compatibility($1)',[store.id]);
  assert.equal(reopenedHistorical.id,historicalShadow.id);
  const reopenedHistoricalClaim=await one("select * from mc.claim_jobs($1,$2::text[],60,1)",['historical-recovery-worker',['financial_dates_recalculate']]);
  await one("select * from mc.complete_job($1,$2,$3,'completed')",[
    reopenedHistoricalClaim.id,reopenedHistoricalClaim.lease_token,'historical-recovery-worker'
  ]);
  pass('compatibility wake never reopens historical shadow work beside an active daily job');

  const queueAuditActions=(await q("select action from mc.audit_events where entity_type='jobs' and entity_id in ($1,$2) order by created_at,id",[claimed[0].id,claimed[1].id])).map(row=>row.action);
  for(const action of ['job_enqueued','job_claimed','job_succeeded','job_retry_scheduled','job_failed']) assert.ok(queueAuditActions.includes(action),action);
  assert.equal(queueAuditActions.filter(action=>action==='job_enqueued').length,2);
  pass('queue lifecycle writes only bounded audit metadata');

  const recoverable=await one("select * from mc.enqueue_job($1,$2,$3,'{}'::jsonb,clock_timestamp(),0,2)",[store.id,'lease_test','lease:recover']);
  const firstLease=await one("select * from mc.claim_jobs($1,$2::text[],60,1)",['worker-old',['lease_test']]);
  await q("update mc.jobs set lease_until=clock_timestamp()-interval '1 second' where id=$1",[recoverable.id]);
  await q("update mc.job_dispatch set lease_until=clock_timestamp()-interval '1 second' where job_id=$1",[recoverable.id]);
  const recovered=await one("select * from mc.claim_jobs($1,$2::text[],60,1)",['worker-new',['lease_test']]);
  assert.equal(recovered.id,firstLease.id);
  assert.notEqual(recovered.lease_token,firstLease.lease_token);
  assert.equal(recovered.attempt_count,2);
  await q("update mc.jobs set lease_until=clock_timestamp()-interval '1 second' where id=$1",[recovered.id]);
  await q("update mc.job_dispatch set lease_until=clock_timestamp()-interval '1 second' where job_id=$1",[recovered.id]);
  assert.equal((await q("select * from mc.claim_jobs($1,$2::text[],60,1)",['worker-third',['lease_test']])).length,0);
  const exhausted=await one('select status,last_error_code,finished_at from mc.jobs where id=$1',[recovered.id]);
  assert.equal(exhausted.status,'failed');
  assert.equal(exhausted.last_error_code,'max_attempts_exhausted');
  assert.ok(exhausted.finished_at);
  pass('expired leases recover once and exhausted leases become terminal failures');

  const exhaustedBatch=[];
  for(const suffix of ['a','b']) await one("select * from mc.enqueue_job($1,$2,$3,'{}'::jsonb,clock_timestamp(),0,1)",[store.id,'lease_batch',`lease:batch:${suffix}`]);
  const runningBatch=await q("select * from mc.claim_jobs($1,$2::text[],60,2)",['batch-workers',['lease_batch']]);
  for(const running of runningBatch){
    await q("update mc.jobs set lease_until=clock_timestamp()-interval '1 second' where id=$1",[running.id]);
    await q("update mc.job_dispatch set lease_until=clock_timestamp()-interval '1 second' where job_id=$1",[running.id]);
    exhaustedBatch.push(running.id);
  }
  await q("select * from mc.claim_jobs($1,$2::text[],60,1)",['batch-cleaner',['lease_batch']]);
  assert.equal((await one("select count(*)::int n from mc.jobs where id=any($1::uuid[]) and status='failed'",[exhaustedBatch])).n,1);
  assert.equal((await one("select count(*)::int n from mc.job_dispatch where job_id=any($1::uuid[])",[exhaustedBatch])).n,1);
  pass('claim bounds expired exhausted cleanup by the requested limit');

  const publicQueuePrivileges=await q("select p.oid::regprocedure::text as signature,has_function_privilege('public',p.oid,'execute') as executable from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='mc' and p.proname in ('enqueue_job','claim_jobs','heartbeat_job','complete_job','fail_job') order by signature");
  assert.equal(publicQueuePrivileges.length,5);
  assert.ok(publicQueuePrivileges.every(row=>row.executable===false));
  assert.equal((await one("select has_table_privilege('public','mc.job_dispatch','select') as allowed")).allowed,false);
  pass('durable queue functions are not executable by public');

  const dailyEvent=await one(`select * from mc.emit_financial_input_event($1,$2,'selection_updated',$3,$4,
    p_source_selection_id=>$5)`,[store.id,'schema-test:selection-daily','2026-08-31','2026-09-06',selection.id]);
  const widenedDailyEvent=await one(`select * from mc.emit_financial_input_event($1,$2,'selection_updated',$3,$4,
    p_source_selection_id=>$5)`,[store.id,'schema-test:selection-daily-next','2026-09-07','2026-09-13',selection.id]);
  assert.equal(dailyEvent.actor_user_id,user.id);
  assert.equal(dailyEvent.allows_wb_api,false);
  assert.equal(widenedDailyEvent.dispatch_job_id,dailyEvent.dispatch_job_id);
  await rejects(`select * from mc.emit_financial_input_event($1,$2,'selection_updated',$3,$4,p_source_selection_id=>$5)`,
    [store.id,'schema-test:selection-daily','2026-08-30','2026-09-06',selection.id],/event key collision/,
    'event idempotency key cannot hide different content');
  const dailyClaims=await q(`select * from mc.claim_jobs($1,$2::text[],60,100)`,['daily-schema-worker',['financial_dates_recalculate']]);
  const dailyClaim=dailyClaims.find(job=>job.id===dailyEvent.dispatch_job_id);
  assert.ok(dailyClaim);
  assert.equal(dailyClaim.payload.affectedFrom,'2026-08-31');
  assert.equal(dailyClaim.payload.affectedTo,'2026-09-13');
  const dailyContext=await one(`select * from mc.establish_financial_daily_context($1,$2,$3)`,[dailyClaim.id,dailyClaim.lease_token,'daily-schema-worker']);
  assert.equal(dailyContext.actor_user_id,user.id);
  assert.equal(Number(dailyContext.event_generation),Number(widenedDailyEvent.event_generation));
  assert.equal(dailyContext.payload.allowsWbApi,false);
  const parserMethodId=(await one(`select id from mc.method_versions where code='wb_finance_import' order by version_no desc limit 1`)).id;
  const dailyResultMethodId=(await one(`select id from mc.method_versions where code='financial_result' and version_no=20`)).id;
  const dailyGeneration=await one(`select * from mc.start_financial_daily_generation($1,$2,$3,$4,$5,$6,$7)`,[
    dailyClaim.id,dailyClaim.lease_token,'daily-schema-worker',widenedDailyEvent.event_generation,'schema-test-inputs',parserMethodId,dailyResultMethodId
  ]);
  const failedDailyGeneration=await one(`select * from mc.finalize_financial_daily_generation($1,$2,$3,$4,$5,'failed','unavailable',$6)`,[
    dailyClaim.id,dailyClaim.lease_token,'daily-schema-worker',dailyGeneration.id,widenedDailyEvent.event_generation,'schema_test_failure'
  ]);
  assert.equal(failedDailyGeneration.status,'failed');
  await rejects(`select * from mc.publish_financial_daily_generation($1,$2,$3,$4,$5)`,[
    dailyClaim.id,dailyClaim.lease_token,'daily-schema-worker',failedDailyGeneration.id,widenedDailyEvent.event_generation
  ],/financial_daily_publication_generation_not_succeeded/,'failed daily generation cannot be published');
  assert.equal((await one(`select count(*)::int n from mc.financial_daily_current_publications where store_id=$1`,[store.id])).n,0);
  await rejects(`update mc.financial_daily_generations set failure_code='changed' where id=$1`,[dailyGeneration.id],/transition is invalid/,
    'daily generation lifecycle is immutable after terminal state');
  await one(`select * from mc.complete_job($1,$2,$3,'completed')`,[dailyClaim.id,dailyClaim.lease_token,'daily-schema-worker']);
  pass('daily worker context validates local jobs and seals one immutable generation');

  await q(`update mc.connections set scopes='["finance"]'::jsonb,credential_generation=1,status='active' where id=$1`,[connection.id]);
  await q(`update mc.connection_secrets set credential_fingerprint=$2 where connection_id=$1`,[connection.id,'a'.repeat(64)]);
  const annualPlan=await one(`select * from mc.plan_financial_credential_refresh($1,1,$2)`,[store.id,'2026-09-27T21:00:00Z']);
  assert.equal(annualPlan.week_count,53);
  assert.ok(annualPlan.job_id);
  assert.equal((await one(`select count(*)::int as n from mc.financial_week_coverage where store_id=$1 and credential_generation=1`,[store.id])).n,53);
  assert.deepEqual(await one(`select min(week_start)::text as first,max(week_end)::text as last from mc.financial_week_coverage where store_id=$1 and credential_generation=1`,[store.id]),{first:'2025-09-22',last:'2026-09-27'});
  await q(`update mc.jobs set status='running',attempt_count=attempt_count+1,worker_id='schema-empty-confirmation',
    lease_token='77777777-7777-4777-8777-777777777777',lease_until=clock_timestamp()+interval '5 minutes',
    heartbeat_at=clock_timestamp(),updated_at=clock_timestamp() where id=$1`,[annualPlan.job_id]);
  await q(`update mc.job_dispatch set status='running',attempt_count=attempt_count+1,
    lease_until=clock_timestamp()+interval '5 minutes' where job_id=$1`,[annualPlan.job_id]);
  const emptyCoverages=await q(`update mc.financial_week_coverage set
      coverage_status='empty',inventory_confirmed_at=clock_timestamp(),empty_confirmed_by_job_id=$2,
      last_checked_at=clock_timestamp(),next_retry_at=null,last_error_code=null,updated_at=clock_timestamp()
    where store_id=$1 and credential_generation=1 and week_start in ('2025-09-29','2025-10-06')
    returning id,week_start::text as week_start,week_end::text as week_end,empty_confirmed_by_job_id`,[store.id,annualPlan.job_id]);
  assert.equal(emptyCoverages.length,2);
  const emptyEvents=await q(`select event_generation,event_type,affected_from::text as affected_from,
      affected_to::text as affected_to,source_financial_week_coverage_id,source_empty_confirmation_job_id,dispatch_job_id
    from mc.financial_input_events where source_financial_week_coverage_id=any($1::uuid[]) order by event_generation`,
    [emptyCoverages.map(coverage=>coverage.id)]);
  assert.equal(emptyEvents.length,2);
  assert.ok(emptyEvents.every(event=>event.event_type==='report_empty_confirmed'
    && event.source_empty_confirmation_job_id===annualPlan.job_id
    && event.dispatch_job_id===emptyEvents[0].dispatch_job_id));
  assert.deepEqual([emptyEvents[0].affected_from,emptyEvents[1].affected_to],['2025-09-29','2025-10-12']);
  await q(`update mc.financial_week_coverage set updated_at=clock_timestamp()
    where id=any($1::uuid[])`,[emptyCoverages.map(coverage=>coverage.id)]);
  assert.equal((await one(`select count(*)::int n from mc.financial_input_events
    where source_financial_week_coverage_id=any($1::uuid[])`,[emptyCoverages.map(coverage=>coverage.id)])).n,2);
  await one(`select * from mc.complete_job($1,$2,$3,'completed')`,[
    annualPlan.job_id,'77777777-7777-4777-8777-777777777777','schema-empty-confirmation'
  ]);
  const [emptyDailyClaim]=await q(`select * from mc.claim_jobs($1,$2::text[],60,1)`,['empty-week-worker',['financial_dates_recalculate']]);
  assert.equal(emptyDailyClaim.id,emptyEvents[0].dispatch_job_id);
  assert.deepEqual(emptyDailyClaim.payload.affectedFrom,'2025-09-29');
  assert.deepEqual(emptyDailyClaim.payload.affectedTo,'2025-10-12');
  const emptyDailyContext=await one(`select * from mc.establish_financial_daily_context($1,$2,$3)`,[
    emptyDailyClaim.id,emptyDailyClaim.lease_token,'empty-week-worker'
  ]);
  const emptyDailyGeneration=await one(`select * from mc.start_financial_daily_generation($1,$2,$3,$4,$5,$6,$7)`,[
    emptyDailyClaim.id,emptyDailyClaim.lease_token,'empty-week-worker',emptyDailyContext.event_generation,
    'schema-test-empty-week-inputs',parserMethodId,dailyResultMethodId
  ]);
  for(const coverage of emptyCoverages)await q(`insert into mc.financial_daily_generation_inputs(
      business_id,store_id,generation_id,source_kind,financial_week_coverage_id,empty_confirmation_job_id
    ) values($1,$2,$3,'empty_week',$4,$5)`,[
    b.id,store.id,emptyDailyGeneration.id,coverage.id,coverage.empty_confirmed_by_job_id
  ]);
  assert.equal((await one(`select count(*)::int n from mc.financial_daily_generation_inputs
    where generation_id=$1 and source_kind='empty_week'`,[emptyDailyGeneration.id])).n,2);
  await rejects(`insert into mc.financial_daily_generation_inputs(
      business_id,store_id,generation_id,source_kind,financial_week_coverage_id,empty_confirmation_job_id
    ) values($1,$2,$3,'empty_week',$4,$5)`,[
    b.id,store.id,emptyDailyGeneration.id,emptyCoverages[0].id,dailyClaim.id
  ],/financial empty week evidence is invalid/,'daily input rejects a mismatched empty-week confirmation job');
  await one(`select * from mc.finalize_financial_daily_generation($1,$2,$3,$4,$5,'failed','unavailable',$6)`,[
    emptyDailyClaim.id,emptyDailyClaim.lease_token,'empty-week-worker',emptyDailyGeneration.id,
    emptyDailyContext.event_generation,'schema_test_complete'
  ]);
  await one(`select * from mc.complete_job($1,$2,$3,'completed')`,[
    emptyDailyClaim.id,emptyDailyClaim.lease_token,'empty-week-worker'
  ]);
  pass('confirmed empty weeks emit idempotent recalculation events and remain audited daily inputs');
  const mondayScheduled=await q(`select store_id,credential_generation,schedule_boundary::text as schedule_boundary,job_id from mc.schedule_financial_inventory($1,100)`,['2026-10-04T21:05:00Z']);
  assert.equal(mondayScheduled.length,1);
  assert.equal(mondayScheduled[0].schedule_boundary,'2026-10-05');
  assert.equal((await q(`select * from mc.schedule_financial_inventory($1,100)`,['2026-10-04T21:06:00Z'])).length,0);
  assert.equal((await one(`select count(*)::int as n from mc.jobs where job_type='financial_inventory_refresh' and store_id=$1`,[store.id])).n,2);
  const manualRefresh=await one(`select * from mc.request_financial_inventory_refresh($1,$2)`,[store.id,'2026-10-05T09:00:00Z']);
  const duplicateManualRefresh=await one(`select * from mc.request_financial_inventory_refresh($1,$2)`,[store.id,'2026-10-05T09:01:00Z']);
  assert.equal(duplicateManualRefresh.id,manualRefresh.id);
  assert.equal(manualRefresh.payload.reason,'manual_refresh');
  assert.deepEqual(manualRefresh.payload.window,{dateFrom:'2026-08-31',dateTo:'2026-10-04'});
  assert.equal((await one(`select count(*)::int as n from mc.financial_week_coverage
    where store_id=$1 and credential_generation=1 and 'manual_refresh'=any(check_reasons)`,[store.id])).n,5);
  await q(`update mc.financial_week_coverage set coverage_status='unavailable',last_error_code='financial_inventory_not_confirmed'
    where store_id=$1 and credential_generation=1 and week_start in ('2025-09-22','2026-09-28')`,[store.id]);
  const recoveryRefresh=await one(`select * from mc.request_financial_inventory_refresh($1,$2)`,[store.id,'2026-10-12T09:00:00Z']);
  const duplicateRecovery=await one(`select * from mc.request_financial_inventory_refresh($1,$2)`,[store.id,'2026-10-12T09:01:00Z']);
  assert.equal(duplicateRecovery.id,recoveryRefresh.id);
  assert.equal(recoveryRefresh.payload.reason,'manual_recovery');
  assert.equal(recoveryRefresh.payload.recoveryWeeks,2);
  assert.deepEqual(recoveryRefresh.payload.window,{dateFrom:'2025-09-22',dateTo:'2026-10-04'});
  assert.deepEqual(await q(`select coverage_status,last_error_code from mc.financial_week_coverage
    where store_id=$1 and credential_generation=1 and week_start in ('2025-09-22','2026-09-28') order by week_start`,[store.id]),[
    {coverage_status:'pending',last_error_code:null},{coverage_status:'pending',last_error_code:null}
  ]);
  await q(`update mc.financial_week_coverage set coverage_status='unavailable',last_error_code='financial_inventory_not_confirmed'
    where store_id=$1 and credential_generation=1 and week_start='2026-09-21'`,[store.id]);
  const coveringRecovery=await one(`select * from mc.request_financial_inventory_refresh($1,$2)`,[store.id,'2026-10-12T09:02:00Z']);
  assert.equal(coveringRecovery.id,recoveryRefresh.id);
  assert.equal((await one(`select coverage_status from mc.financial_week_coverage
    where store_id=$1 and credential_generation=1 and week_start='2026-09-21'`,[store.id])).coverage_status,'pending');
  await q(`update mc.jobs set status='running',attempt_count=attempt_count+1,worker_id='manual-running-race',
    lease_token='99999999-9999-4999-8999-999999999999',lease_until=clock_timestamp()+interval '5 minutes',
    heartbeat_at=clock_timestamp(),updated_at=clock_timestamp() where id=$1`,[recoveryRefresh.id]);
  await q(`update mc.job_dispatch set status='running',attempt_count=attempt_count+1,
    lease_until=clock_timestamp()+interval '5 minutes' where job_id=$1`,[recoveryRefresh.id]);
  await q(`update mc.financial_week_coverage set coverage_status='unavailable',last_error_code='financial_inventory_not_confirmed'
    where store_id=$1 and credential_generation=1 and week_start='2026-09-14'`,[store.id]);
  const runningFollowup=await one(`select * from mc.request_financial_inventory_refresh($1,$2)`,[store.id,'2026-10-12T09:03:00Z']);
  assert.notEqual(runningFollowup.id,recoveryRefresh.id);
  assert.deepEqual(runningFollowup.payload.window,{dateFrom:'2026-09-14',dateTo:'2026-09-20'});
  await q(`update mc.jobs set status='succeeded',outcome='completed',finished_at=clock_timestamp(),
    worker_id=null,lease_token=null,lease_until=null,heartbeat_at=null where id in ($1,$2)`,[recoveryRefresh.id,runningFollowup.id]);
  await q(`delete from mc.job_dispatch where job_id in ($1,$2)`,[recoveryRefresh.id,runningFollowup.id]);
  await q(`update mc.financial_week_coverage set coverage_status='complete'
    where store_id=$1 and credential_generation=1 and week_start in ('2025-09-22','2026-09-14','2026-09-21','2026-09-28')`,[store.id]);
  await q(`update mc.financial_week_coverage set coverage_status='unavailable',last_error_code='financial_inventory_not_confirmed'
    where store_id=$1 and credential_generation=1 and week_start='2026-09-28'`,[store.id]);
  const narrowRecovery=await one(`select * from mc.request_financial_inventory_refresh($1,$2)`,[store.id,'2026-10-19T09:00:00Z']);
  await q(`insert into mc.financial_week_inventory(
      business_id,store_id,coverage_id,external_report_id,inventory_checksum,fetch_status,period_start,period_end
    ) select business_id,store_id,id,'1234567890',$2,'failed',week_start,week_end
      from mc.financial_week_coverage where store_id=$1 and credential_generation=1 and week_start='2025-09-22'`,[store.id,'e'.repeat(64)]);
  await q(`update mc.financial_week_coverage set coverage_status='unavailable',
    inventory_confirmed_at='2026-10-19T08:00:00Z',last_error_code='financial_inventory_not_confirmed'
    where store_id=$1 and credential_generation=1 and week_start='2025-09-22'`,[store.id]);
  const widenedRecovery=await one(`select * from mc.request_financial_inventory_refresh($1,$2)`,[store.id,'2026-10-19T09:01:00Z']);
  assert.notEqual(widenedRecovery.id,narrowRecovery.id);
  assert.deepEqual(widenedRecovery.payload.window,{dateFrom:'2025-09-22',dateTo:'2025-09-28'});
  assert.equal((await one(`select inventory_confirmed_at from mc.financial_week_coverage
    where store_id=$1 and credential_generation=1 and week_start='2025-09-22'`,[store.id])).inventory_confirmed_at,null);
  await q(`update mc.jobs set status='running',attempt_count=attempt_count+1,worker_id='manual-empty-list',
    lease_token='88888888-8888-4888-8888-888888888888',lease_until=clock_timestamp()+interval '5 minutes',
    heartbeat_at=clock_timestamp(),updated_at=clock_timestamp() where id=$1`,[widenedRecovery.id]);
  await q(`update mc.job_dispatch set status='running',attempt_count=attempt_count+1,
    lease_until=clock_timestamp()+interval '5 minutes' where job_id=$1`,[widenedRecovery.id]);
  const emptyRecovery=await one(`select * from mc.apply_financial_inventory($1,1,$2,$3,'[]'::jsonb)`,[
    widenedRecovery.id,'88888888-8888-4888-8888-888888888888','manual-empty-list'
  ]);
  assert.equal(emptyRecovery.uncovered_weeks,1);
  assert.deepEqual(await one(`select coverage_status,last_error_code,empty_confirmed_by_job_id from mc.financial_week_coverage
    where store_id=$1 and credential_generation=1 and week_start='2025-09-22'`,[store.id]),
    {coverage_status:'retry',last_error_code:'financial_inventory_not_confirmed',empty_confirmed_by_job_id:null});
  await one(`select * from mc.complete_job($1,$2,$3,'completed')`,[
    widenedRecovery.id,'88888888-8888-4888-8888-888888888888','manual-empty-list'
  ]);
  await context(b.id,queueOutsider.id);
  await rejects(`select * from mc.request_financial_inventory_refresh($1,$2)`,[store.id,'2026-10-05T09:02:00Z'],/owned business context/,
    'manual financial refresh denies a user outside the owned business context');
  await context(b.id,user.id);
  await q(`update mc.financial_schedule_targets set requested_by=$2 where store_id=$1`,[store.id,queueOutsider.id]);
  assert.equal((await q(`select * from mc.schedule_financial_inventory($1,100)`,['2026-10-11T21:01:00Z'])).length,1);
  pass('credential and Monday scheduler seed closed-week coverage exactly once');

  const schedulerPrivileges=await q("select p.proname,has_function_privilege('public',p.oid,'execute') as executable from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='mc' and p.proname in ('plan_financial_credential_refresh','schedule_financial_inventory','get_financial_inventory_context','apply_financial_inventory','apply_financial_period_fallback','list_financial_credential_backfill','defer_financial_credential_backfill','request_financial_inventory_refresh','mark_financial_inventory_coverage_terminal') order by p.proname");
  assert.equal(schedulerPrivileges.length,9);
  assert.ok(schedulerPrivileges.every(row=>row.executable===false));
  assert.equal((await one("select has_table_privilege('public','mc.financial_schedule_targets','select') as allowed")).allowed,false);
  assert.equal((await one("select has_table_privilege('public','mc.financial_credential_backfill_targets','select') as allowed")).allowed,false);
  pass('financial scheduler discovery and worker functions stay closed to public');

  // Deliberately use a non-owner role: superusers bypass row-level security.
  await db.exec('create role mc_test_reader; grant usage on schema mc to mc_test_reader; grant select on all tables in schema mc to mc_test_reader; grant execute on function mc.context_business_id(),mc.context_user_id() to mc_test_reader; set role mc_test_reader;');
  await context(b.id,user.id);
  assert.equal((await one('select count(*)::int as n from mc.stores')).n,1);
  assert.equal((await one('select count(*)::int as n from mc.products where store_id=$1',[store2.id])).n,0);
  assert.equal((await one('select count(*)::int as n from mc.selected_products')).n,3);
  assert.equal((await one('select count(*)::int as n from mc.operational_periods')).n,1);
  assert.equal((await one('select count(*)::int as n from mc.current_operational_daily_metrics')).n,21);
  pass('non-owner role sees only current business, including views');
  assert.equal((await one('select count(*)::int as n from mc.tax_settings')).n,2);
  assert.equal((await one('select count(*)::int as n from mc.tax_setting_versions where business_id=$1',[b2.id])).n,0);
  pass('tax settings and versions enforce tenant-scoped reads');
  await context('',user.id);
  assert.equal((await one('select count(*)::int as n from mc.memberships where user_id=$1',[user.id])).n,2);
  pass('authenticated user can discover own business before tenant context is set');
  assert.equal((await one('select count(*)::int as n from mc.products')).n,0);
  for(const table of ['expenses','expense_versions','tax_settings','tax_setting_versions','operational_periods','operational_snapshots','operational_snapshot_activations','operational_snapshot_products','operational_daily_metrics']) {
    assert.equal((await one(`select count(*)::int as n from mc.${table}`)).n,0);
  }
  pass('missing tenant context fails closed');
  await db.exec('reset role;');
  const taxRls=await q("select relrowsecurity,relforcerowsecurity from pg_class where oid in ('mc.tax_settings'::regclass,'mc.tax_setting_versions'::regclass)");
  assert.ok(taxRls.length===2&&taxRls.every(row=>row.relrowsecurity&&row.relforcerowsecurity));
  const operationalRls=await q("select relrowsecurity,relforcerowsecurity from pg_class where oid in ('mc.operational_periods'::regclass,'mc.operational_snapshots'::regclass,'mc.operational_snapshot_activations'::regclass,'mc.operational_snapshot_products'::regclass,'mc.operational_daily_metrics'::regclass)");
  assert.ok(operationalRls.length===5&&operationalRls.every(row=>row.relrowsecurity&&row.relforcerowsecurity));
  pass('operational tables enforce tenant RLS and the current-day view inherits it');
  await db.exec('grant insert,update on mc.tax_settings,mc.tax_setting_versions,mc.expenses,mc.expense_versions,mc.operational_periods,mc.audit_events to mc_test_reader; set role mc_test_reader;');
  await rejects('insert into mc.tax_settings(business_id,effective_from) values($1,$2)',[b.id,'2027-01-01'],/row-level security/,'missing tenant context prevents tax writes');
  await context(b.id,user.id);
  await rejects('insert into mc.tax_settings(business_id,effective_from) values($1,$2)',[b2.id,'2027-01-01'],/row-level security/,'non-owner cannot create tax identity in another tenant');
  await assert.rejects(()=>insert('tax_setting_versions',{...taxValues,business_id:b2.id,tax_setting_id:foreignTax.id,version_no:2}),/row-level security/);
  await rejects('insert into mc.expenses(business_id,store_id) values($1,$2)',[b2.id,store2.id],/row-level security/,'non-owner cannot create expense in another tenant');
  await rejects('insert into mc.operational_periods(business_id,store_id,period_start,period_end) values($1,$2,$3,$4)',[b2.id,store2.id,'2026-09-14','2026-09-20'],/row-level security/,'non-owner cannot create an operational period in another tenant');
  assert.equal((await q('update mc.tax_settings set current_version_id=null where id=$1 returning id',[foreignTax.id])).length,0);
  const roleTax=await insert('tax_settings',{business_id:b.id,effective_from:'2027-01-01'});
  const roleTaxVersion=await insert('tax_setting_versions',{...taxValues,tax_setting_id:roleTax.id});
  await q('update mc.tax_settings set current_version_id=$1 where id=$2',[roleTaxVersion.id,roleTax.id]);
  assert.equal((await one('select current_version_id from mc.tax_settings where id=$1',[roleTax.id])).current_version_id,roleTaxVersion.id);
  const roleExpense=await insert('expenses',{...base,external_entry_key:'role-store-expense'});
  const roleExpenseVersion=await insert('expense_versions',{...expenseValues,expense_id:roleExpense.id,category:'packaging'});
  await q('update mc.expenses set current_version_id=$1 where id=$2',[roleExpenseVersion.id,roleExpense.id]);
  pass('forced RLS permits valid non-owner tax and expense workflows with audit while isolating foreign writes');
  await db.exec('reset role;');
  await context(b.id,user.id);
  await q("update mc.subscriptions set status='ended' where business_id=$1",[b.id]);
  assert.equal((await one('select count(*)::int as n from mc.selected_products')).n,0);
  assert.equal((await one('select count(*)::int as n from mc.current_daily_results')).n,0);
  assert.equal((await one('select count(*)::int as n from mc.product_selection_items where business_id=$1',[b.id])).n,3);
  pass('ended subscription hides analytical views without deleting selected history');
  await q("update mc.subscriptions set status='active' where business_id=$1",[b.id]);
  assert.equal((await one('select count(*)::int as n from mc.selected_products')).n,3);
  pass('reactivation restores the same selection');

  // A new plan proves counts are data, not hardcoded tariff names.
  const custom = await insert('billing_plans',{code:'test_four',name:'Four products / two stores'});
  const customV = await insert('billing_plan_versions',{plan_id:custom.id,version_no:1,product_limit:4,store_limit:2,price:123,billing_period:'month'});
  await q('update mc.subscriptions set plan_version_id=$1 where business_id=$2',[customV.id,b.id]);
  const extra = await insert('stores',{business_id:b.id,external_account_id:'a-second',name:'A second',status:'active'});
  const ep1 = await product(extra,9991), ep2 = await product(extra,9992);
  const extraDoc = await insert('source_documents',{business_id:b.id,store_id:extra.id,origin:'wb_api',document_type:'catalog',checksum:'cat-extra',completeness:'partial'});
  await rejects(selectSql,[extra.id,extraDoc.id,[ep1.id]],/complete WB catalog/,'selection waits for complete initial catalog');
  await q("update mc.source_documents set completeness='complete' where id=$1",[extraDoc.id]);
  await rejects(selectSql,[extra.id,extraDoc.id,[ep1.id,ep2.id]],/product limit/,'product quota is shared across stores');
  await one(selectSql,[extra.id,extraDoc.id,[ep1.id]]);
  pass('new plan permits another store with remaining product allowance');
  await rejects('insert into mc.expenses(business_id,store_id,product_id) values($1,$2,$3)',[b.id,store.id,ep1.id],/foreign key/,'expense cannot use a selected product from another store of the same business');
  await rejects('update mc.subscriptions set plan_version_id=$1 where business_id=$2',[byCode.free.id,b.id],/downgrade/,'unresolved downgrade cannot silently remove selected products');
  await rejects('update mc.billing_plan_versions set product_limit=999 where id=$1',[byCode.free.id],/immutable/,'published plan conditions require a new version');

  const extensionBusiness = await insert('businesses',{name:'Selection extension test'});
  await insert('memberships',{business_id:extensionBusiness.id,user_id:user.id});
  await context(extensionBusiness.id,user.id);
  const extensionStore = await insert('stores',{business_id:extensionBusiness.id,external_account_id:'extension',name:'Extension',status:'active'});
  await insert('connections',{business_id:extensionBusiness.id,store_id:extensionStore.id,secret_ref:'database:extension',scopes:['analytics'],status:'active'});
  const extensionDoc = await insert('source_documents',{business_id:extensionBusiness.id,store_id:extensionStore.id,origin:'wb_api',document_type:'catalog',checksum:'extension',completeness:'complete'});
  const extensionProducts=[];
  for(let i=1;i<=4;i++) extensionProducts.push(await product(extensionStore,880000+i));
  await one(selectSql,[extensionStore.id,extensionDoc.id,extensionProducts.slice(0,3).map(p=>p.id)]);
  await q('update mc.subscriptions set plan_version_id=$1 where business_id=$2',[byCode.minimum.id,extensionBusiness.id]);
  const extensionOperationalStream=await insert('sync_streams',{business_id:extensionBusiness.id,store_id:extensionStore.id,source_type:'operational_sales_funnel',next_run_at:new Date(Date.now()+3600000)});
  await one('select mc.add_products_to_selection($1,$2::uuid[]) as id',[extensionStore.id,[extensionProducts[3].id]]);
  assert.equal((await one('select count(*)::int as n from mc.product_selection_items where business_id=$1',[extensionBusiness.id])).n,4);
  assert.ok(new Date((await one('select next_run_at from mc.sync_streams where id=$1',[extensionOperationalStream.id])).next_run_at)<=new Date(Date.now()+5000));
  assert.ok(new Date((await one('select next_run_at from mc.operational_sync_targets where store_id=$1',[extensionStore.id])).next_run_at)<=new Date(Date.now()+5000));
  pass('upgraded plan can extend a confirmed selection without replacing prior products');
  await rejects('select mc.add_products_to_selection($1,$2::uuid[])',[extensionStore.id,[extensionProducts[3].id]],/already selected/,'selected product cannot be added twice');

  const isolated = await insert('businesses',{name:'Deferred selection test'});
  await insert('memberships',{business_id:isolated.id,user_id:user.id});
  const isolatedStore = await insert('stores',{business_id:isolated.id,external_account_id:'isolated',name:'isolated',status:'active'});
  const isolatedDoc = await insert('source_documents',{business_id:isolated.id,store_id:isolatedStore.id,origin:'wb_api',document_type:'catalog',checksum:'isolated',completeness:'complete'});
  await rejects('insert into mc.product_selections(business_id,store_id,plan_version_id,catalog_document_id,confirmed_by,product_limit_snapshot) values($1,$2,$3,$4,$5,3)',[isolated.id,isolatedStore.id,byCode.free.id,isolatedDoc.id,user.id],/nonempty and confirmed/,'cannot commit an unfinished selection header');

  const upgradeDb=new PGlite();
  try{
    for(const migration of migrations.filter(name=>Number(name.split('_')[0])<=17))await upgradeDb.exec(await readFile(path.join(root,'db/migrations',migration),'utf8'));
    const uq=async(sql,params=[])=>(await upgradeDb.query(sql,params)).rows;
    const uone=async(sql,params=[])=>(await uq(sql,params))[0];
    const upgradeUser=await uone(`insert into mc.users(display_name) values('Upgrade owner') returning id`);
    const upgradeBusiness=await uone(`insert into mc.businesses(name) values('Upgrade business') returning id`);
    await uq(`insert into mc.memberships(business_id,user_id) values($1,$2)`,[upgradeBusiness.id,upgradeUser.id]);
    await uq(`select set_config('app.user_id',$1,false),set_config('app.business_id',$2,false)`,[upgradeUser.id,upgradeBusiness.id]);
    const upgradeStore=await uone(`insert into mc.stores(business_id,external_account_id,name,status) values($1,'upgrade-store','Upgrade','active') returning id`,[upgradeBusiness.id]);
    const upgradeDocument=await uone(`insert into mc.source_documents(business_id,store_id,origin,document_type,checksum,completeness) values($1,$2,'wb_api','weekly_realization','upgrade-document','complete') returning id`,[upgradeBusiness.id,upgradeStore.id]);
    const upgradeReport=await uone(`insert into mc.reports(business_id,store_id,external_report_id,period_start,period_end) values($1,$2,'upgrade-report','2026-09-01','2026-09-07') returning id`,[upgradeBusiness.id,upgradeStore.id]);
    const upgradeVersion=await uone(`insert into mc.report_versions(business_id,store_id,report_id,document_id,version_no,checksum,parser_version) values($1,$2,$3,$4,1,'upgrade-version','test') returning id`,[upgradeBusiness.id,upgradeStore.id,upgradeReport.id,upgradeDocument.id]);
    const upgradeRow=await uone(`insert into mc.report_rows(business_id,store_id,report_version_id,external_row_key,row_number,raw_data,row_checksum) values($1,$2,$3,'1',1,'{}','upgrade-row') returning id`,[upgradeBusiness.id,upgradeStore.id,upgradeVersion.id]);
    const upgradeMethods=await uq(`select id,implementation_version from mc.method_versions where code='wb_finance_import' and implementation_version in('wb-finance-v2','wb-finance-v3') order by version_no`);
    for(const upgradeMethod of upgradeMethods)await uq(`insert into mc.report_normalizations(business_id,store_id,report_version_id,method_version_id,normalization_key,status) values($1,$2,$3,$4,$5,'succeeded')`,[upgradeBusiness.id,upgradeStore.id,upgradeVersion.id,upgradeMethod.id,`${upgradeMethod.implementation_version}:${upgradeVersion.id}`]);
    await uq(`insert into mc.data_issues(business_id,store_id,document_id,report_row_id,code,severity) values($1,$2,$3,$4,'duplicate_issue','blocking'),($1,$2,$3,$4,'duplicate_issue','blocking')`,[upgradeBusiness.id,upgradeStore.id,upgradeDocument.id,upgradeRow.id]);
    await upgradeDb.exec(await readFile(path.join(root,'db/migrations/018_data_issue_lifecycle.sql'),'utf8'));
    const upgradedIssues=await uq(`select status,count(*)::int as n from mc.data_issues where code='duplicate_issue' group by status order by status`);
    assert.deepEqual(upgradedIssues,[{status:'open',n:1},{status:'resolved',n:1}]);
    pass('migration 18 resolves duplicate legacy issues instead of failing upgrade');
  }finally{await upgradeDb.close();}

  const v26UpgradeDb=new PGlite();
  try{
    for(const migration of migrations.filter(name=>Number(name.split('_')[0])<=25))await v26UpgradeDb.exec(await readFile(path.join(root,'db/migrations',migration),'utf8'));
    const vq=async(sql,params=[])=>(await v26UpgradeDb.query(sql,params)).rows;
    const vone=async(sql,params=[])=>(await vq(sql,params))[0];
    const upgradeUser=await vone(`insert into mc.users(display_name) values('V26 owner') returning id`);
    const upgradeBusiness=await vone(`insert into mc.businesses(name) values('V26 business') returning id`);
    await vq(`insert into mc.memberships(business_id,user_id,role) values($1,$2,'owner')`,[upgradeBusiness.id,upgradeUser.id]);
    await vq(`select set_config('app.user_id',$1,false),set_config('app.business_id',$2,false)`,[upgradeUser.id,upgradeBusiness.id]);
    const upgradeStore=await vone(`insert into mc.stores(business_id,external_account_id,name,status) values($1,'v26-store','V26 store','active') returning id`,[upgradeBusiness.id]);
    const catalog=await vone(`insert into mc.source_documents(business_id,store_id,origin,document_type,checksum,completeness) values($1,$2,'wb_api','catalog','v26-catalog','complete') returning id`,[upgradeBusiness.id,upgradeStore.id]);
    const selectedProduct=await vone(`insert into mc.products(business_id,store_id,wb_article,seller_article) values($1,$2,260001,'V26') returning id`,[upgradeBusiness.id,upgradeStore.id]);
    await vone(`select mc.confirm_product_selection($1,$2,$3::uuid[]) as id`,[upgradeStore.id,catalog.id,[selectedProduct.id]]);
    const document=await vone(`insert into mc.source_documents(business_id,store_id,origin,document_type,checksum,completeness) values($1,$2,'wb_api','weekly_realization','v26-report','complete') returning id`,[upgradeBusiness.id,upgradeStore.id]);
    const report=await vone(`insert into mc.reports(business_id,store_id,external_report_id,period_start,period_end) values($1,$2,'v26-report','2026-09-07','2026-09-13') returning id`,[upgradeBusiness.id,upgradeStore.id]);
    const reportVersion=await vone(`insert into mc.report_versions(business_id,store_id,report_id,document_id,version_no,checksum,parser_version) values($1,$2,$3,$4,1,'v26-version','wb-finance-v7') returning id`,[upgradeBusiness.id,upgradeStore.id,report.id,document.id]);
    await vq(`update mc.report_versions set status='validated' where id=$1`,[reportVersion.id]);
    await vq(`update mc.report_versions set status='accepted',accepted_at=now() where id=$1`,[reportVersion.id]);
    await vq(`update mc.reports set current_version_id=$1 where id=$2`,[reportVersion.id,report.id]);
    const before=await vone(`insert into mc.calculation_invalidations(business_id,store_id,requested_by,reason) values($1,$2,$3,'before_v26')
      on conflict(store_id) do update set requested_by=excluded.requested_by,reason=excluded.reason,generation_token=gen_random_uuid() returning generation_token`,[upgradeBusiness.id,upgradeStore.id,upgradeUser.id]);
    await vq(`select set_config('app.user_id','',false),set_config('app.business_id','',false)`);
    await v26UpgradeDb.exec(await readFile(path.join(root,'db/migrations/026_rebill_reconciliation_method.sql'),'utf8'));
    await vq(`select set_config('app.user_id',$1,false),set_config('app.business_id',$2,false)`,[upgradeUser.id,upgradeBusiness.id]);
    const after=await vone(`select reason,generation_token from mc.calculation_invalidations where store_id=$1`,[upgradeStore.id]);
    assert.equal(after.reason,'rebill_reconciliation_method_v8');
    assert.notEqual(after.generation_token,before.generation_token);
    assert.equal((await vone(`select class from mc.financial_categories where code='rebill_logistic_compensation'`)).class,'expense');
    assert.deepEqual(await vq(`select relname,relforcerowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='mc' and relname in('stores','memberships','product_selections','reports') order by relname`),[
      {relname:'memberships',relforcerowsecurity:true},{relname:'product_selections',relforcerowsecurity:true},
      {relname:'reports',relforcerowsecurity:true},{relname:'stores',relforcerowsecurity:true}
    ]);
    pass('migration 26 upgrades populated v25 state, refreshes invalidation and restores FORCE RLS');
  }finally{await v26UpgradeDb.close();}

  const v27UpgradeDb=new PGlite();
  try{
    for(const migration of migrations.filter(name=>Number(name.split('_')[0])<=26))await v27UpgradeDb.exec(await readFile(path.join(root,'db/migrations',migration),'utf8'));
    const vq=async(sql,params=[])=>(await v27UpgradeDb.query(sql,params)).rows;
    const vone=async(sql,params=[])=>(await vq(sql,params))[0];
    const upgradeUser=await vone(`insert into mc.users(display_name) values('V27 owner') returning id`);
    const upgradeBusiness=await vone(`insert into mc.businesses(name) values('V27 business') returning id`);
    await vq(`insert into mc.memberships(business_id,user_id,role) values($1,$2,'owner')`,[upgradeBusiness.id,upgradeUser.id]);
    await vq(`select set_config('app.user_id',$1,false),set_config('app.business_id',$2,false)`,[upgradeUser.id,upgradeBusiness.id]);
    const upgradeStore=await vone(`insert into mc.stores(business_id,external_account_id,name,status) values($1,'v27-store','V27 store','active') returning id`,[upgradeBusiness.id]);
    const catalog=await vone(`insert into mc.source_documents(business_id,store_id,origin,document_type,checksum,completeness) values($1,$2,'wb_api','catalog','v27-catalog','complete') returning id`,[upgradeBusiness.id,upgradeStore.id]);
    const product=await vone(`insert into mc.products(business_id,store_id,wb_article,seller_article) values($1,$2,270001,'V27') returning id`,[upgradeBusiness.id,upgradeStore.id]);
    await vone(`select mc.confirm_product_selection($1,$2,$3::uuid[]) as id`,[upgradeStore.id,catalog.id,[product.id]]);
    const document=await vone(`insert into mc.source_documents(business_id,store_id,origin,document_type,checksum,completeness) values($1,$2,'wb_api','weekly_realization','v27-report','complete') returning id`,[upgradeBusiness.id,upgradeStore.id]);
    const report=await vone(`insert into mc.reports(business_id,store_id,external_report_id,period_start,period_end) values($1,$2,'v27-report','2026-09-07','2026-09-13') returning id`,[upgradeBusiness.id,upgradeStore.id]);
    const version=await vone(`insert into mc.report_versions(business_id,store_id,report_id,document_id,version_no,checksum,parser_version) values($1,$2,$3,$4,1,'v27-version','wb-finance-v8') returning id`,[upgradeBusiness.id,upgradeStore.id,report.id,document.id]);
    await vq(`update mc.report_versions set status='validated' where id=$1`,[version.id]);
    await vq(`update mc.report_versions set status='accepted',accepted_at=now() where id=$1`,[version.id]);
    await vq(`update mc.reports set current_version_id=$1 where id=$2`,[version.id,report.id]);
    const before=await vone(`insert into mc.calculation_invalidations(business_id,store_id,requested_by,reason) values($1,$2,$3,'before_v27')
      on conflict(store_id) do update set requested_by=excluded.requested_by,reason=excluded.reason,generation_token=gen_random_uuid() returning generation_token`,[upgradeBusiness.id,upgradeStore.id,upgradeUser.id]);
    await vq(`select set_config('app.user_id','',false),set_config('app.business_id','',false)`);
    await v27UpgradeDb.exec(await readFile(path.join(root,'db/migrations/027_store_rows_without_product_method.sql'),'utf8'));
    await vq(`select set_config('app.user_id',$1,false),set_config('app.business_id',$2,false)`,[upgradeUser.id,upgradeBusiness.id]);
    const after=await vone(`select reason,generation_token from mc.calculation_invalidations where store_id=$1`,[upgradeStore.id]);
    assert.equal(after.reason,'store_rows_without_product_method_v9');
    assert.notEqual(after.generation_token,before.generation_token);
    assert.deepEqual(await vq(`select relname,relforcerowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='mc' and relname in('stores','memberships','product_selections','reports') order by relname`),[
      {relname:'memberships',relforcerowsecurity:true},{relname:'product_selections',relforcerowsecurity:true},
      {relname:'reports',relforcerowsecurity:true},{relname:'stores',relforcerowsecurity:true}
    ]);
    pass('migration 27 upgrades populated v26 state, refreshes invalidation and restores FORCE RLS');
  }finally{await v27UpgradeDb.close();}

  const v29UpgradeDb=new PGlite();
  try{
    for(const migration of migrations.filter(name=>Number(name.split('_')[0])<=28))await v29UpgradeDb.exec(await readFile(path.join(root,'db/migrations',migration),'utf8'));
    const vq=async(sql,params=[])=>(await v29UpgradeDb.query(sql,params)).rows;
    const vone=async(sql,params=[])=>(await vq(sql,params))[0];
    const upgradeUser=await vone(`insert into mc.users(display_name) values('V29 owner') returning id`);
    const upgradeBusiness=await vone(`insert into mc.businesses(name) values('V29 business') returning id`);
    await vq(`insert into mc.memberships(business_id,user_id,role) values($1,$2,'owner')`,[upgradeBusiness.id,upgradeUser.id]);
    await vq(`select set_config('app.user_id',$1,false),set_config('app.business_id',$2,false)`,[upgradeUser.id,upgradeBusiness.id]);
    const upgradeStore=await vone(`insert into mc.stores(business_id,external_account_id,name,status) values($1,'v29-store','V29 store','active') returning id`,[upgradeBusiness.id]);
    const catalog=await vone(`insert into mc.source_documents(business_id,store_id,origin,document_type,checksum,completeness) values($1,$2,'wb_api','catalog','v29-catalog','complete') returning id`,[upgradeBusiness.id,upgradeStore.id]);
    const product=await vone(`insert into mc.products(business_id,store_id,wb_article,seller_article) values($1,$2,290001,'V29') returning id`,[upgradeBusiness.id,upgradeStore.id]);
    await vone(`select mc.confirm_product_selection($1,$2,$3::uuid[]) as id`,[upgradeStore.id,catalog.id,[product.id]]);
    const document=await vone(`insert into mc.source_documents(business_id,store_id,origin,document_type,checksum,completeness) values($1,$2,'wb_api','weekly_realization','v29-report','complete') returning id`,[upgradeBusiness.id,upgradeStore.id]);
    const report=await vone(`insert into mc.reports(business_id,store_id,external_report_id,period_start,period_end) values($1,$2,'v29-report','2026-08-17','2026-08-23') returning id`,[upgradeBusiness.id,upgradeStore.id]);
    const version=await vone(`insert into mc.report_versions(business_id,store_id,report_id,document_id,version_no,checksum,parser_version) values($1,$2,$3,$4,1,'v29-version','wb-finance-v9') returning id`,[upgradeBusiness.id,upgradeStore.id,report.id,document.id]);
    await vq(`update mc.report_versions set status='validated' where id=$1`,[version.id]);
    await vq(`update mc.report_versions set status='accepted',accepted_at=now() where id=$1`,[version.id]);
    await vq(`update mc.reports set current_version_id=$1 where id=$2`,[version.id,report.id]);
    const before=await vone(`insert into mc.calculation_invalidations(business_id,store_id,requested_by,reason) values($1,$2,$3,'before_v29')
      on conflict(store_id) do update set requested_by=excluded.requested_by,reason=excluded.reason,generation_token=gen_random_uuid() returning generation_token`,[upgradeBusiness.id,upgradeStore.id,upgradeUser.id]);
    await vq(`select set_config('app.user_id','',false),set_config('app.business_id','',false)`);
    await v29UpgradeDb.exec(await readFile(path.join(root,'db/migrations/029_loyalty_compensation_method.sql'),'utf8'));
    await vq(`select set_config('app.user_id',$1,false),set_config('app.business_id',$2,false)`,[upgradeUser.id,upgradeBusiness.id]);
    const after=await vone(`select reason,generation_token from mc.calculation_invalidations where store_id=$1`,[upgradeStore.id]);
    assert.equal(after.reason,'loyalty_compensation_method_v10');
    assert.notEqual(after.generation_token,before.generation_token);
    assert.deepEqual(await vone(`select class,is_promotion from mc.financial_categories where code='loyalty_compensation'`),{class:'income',is_promotion:false});
    assert.deepEqual(await vq(`select relname,relforcerowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='mc' and relname in('stores','memberships','product_selections','reports') order by relname`),[
      {relname:'memberships',relforcerowsecurity:true},{relname:'product_selections',relforcerowsecurity:true},
      {relname:'reports',relforcerowsecurity:true},{relname:'stores',relforcerowsecurity:true}
    ]);
    pass('migration 29 upgrades populated v28 state, refreshes invalidation and restores FORCE RLS');
  }finally{await v29UpgradeDb.close();}

  const v30UpgradeDb=new PGlite();
  try{
    for(const migration of migrations.filter(name=>Number(name.split('_')[0])<=29))await v30UpgradeDb.exec(await readFile(path.join(root,'db/migrations',migration),'utf8'));
    const vq=async(sql,params=[])=>(await v30UpgradeDb.query(sql,params)).rows;
    const vone=async(sql,params=[])=>(await vq(sql,params))[0];
    const upgradeUser=await vone(`insert into mc.users(display_name) values('V30 owner') returning id`);
    const upgradeBusiness=await vone(`insert into mc.businesses(name) values('V30 business') returning id`);
    await vq(`insert into mc.memberships(business_id,user_id,role) values($1,$2,'owner')`,[upgradeBusiness.id,upgradeUser.id]);
    await vq(`select set_config('app.user_id',$1,false),set_config('app.business_id',$2,false)`,[upgradeUser.id,upgradeBusiness.id]);
    const upgradeStore=await vone(`insert into mc.stores(business_id,external_account_id,name,status) values($1,'v30-store','V30 store','active') returning id`,[upgradeBusiness.id]);
    const catalog=await vone(`insert into mc.source_documents(business_id,store_id,origin,document_type,checksum,completeness) values($1,$2,'wb_api','catalog','v30-catalog','complete') returning id`,[upgradeBusiness.id,upgradeStore.id]);
    const product=await vone(`insert into mc.products(business_id,store_id,wb_article,seller_article) values($1,$2,300001,'V30') returning id`,[upgradeBusiness.id,upgradeStore.id]);
    await vone(`select mc.confirm_product_selection($1,$2,$3::uuid[]) as id`,[upgradeStore.id,catalog.id,[product.id]]);
    const document=await vone(`insert into mc.source_documents(business_id,store_id,origin,document_type,checksum,completeness) values($1,$2,'wb_api','weekly_realization','v30-report','complete') returning id`,[upgradeBusiness.id,upgradeStore.id]);
    const report=await vone(`insert into mc.reports(business_id,store_id,external_report_id,period_start,period_end) values($1,$2,'v30-report','2026-08-17','2026-08-23') returning id`,[upgradeBusiness.id,upgradeStore.id]);
    const version=await vone(`insert into mc.report_versions(business_id,store_id,report_id,document_id,version_no,checksum,parser_version) values($1,$2,$3,$4,1,'v30-version','wb-finance-v10') returning id`,[upgradeBusiness.id,upgradeStore.id,report.id,document.id]);
    await vq(`update mc.report_versions set status='validated' where id=$1`,[version.id]);
    await vq(`update mc.report_versions set status='accepted',accepted_at=now() where id=$1`,[version.id]);
    await vq(`update mc.reports set current_version_id=$1 where id=$2`,[version.id,report.id]);
    const before=await vone(`insert into mc.calculation_invalidations(business_id,store_id,requested_by,reason) values($1,$2,$3,'before_v30')
      on conflict(store_id) do update set requested_by=excluded.requested_by,reason=excluded.reason,generation_token=gen_random_uuid() returning generation_token`,[upgradeBusiness.id,upgradeStore.id,upgradeUser.id]);
    await vq(`select set_config('app.user_id','',false),set_config('app.business_id','',false)`);
    await v30UpgradeDb.exec(await readFile(path.join(root,'db/migrations/030_loyalty_reference_method.sql'),'utf8'));
    await vq(`select set_config('app.user_id',$1,false),set_config('app.business_id',$2,false)`,[upgradeUser.id,upgradeBusiness.id]);
    const after=await vone(`select reason,generation_token from mc.calculation_invalidations where store_id=$1`,[upgradeStore.id]);
    assert.equal(after.reason,'loyalty_compensation_reference_v11');
    assert.notEqual(after.generation_token,before.generation_token);
    assert.deepEqual(await vq(`select code,class from mc.financial_categories where code in('loyalty_compensation','loyalty_discount_reference') order by code`),[
      {code:'loyalty_compensation',class:'income'},{code:'loyalty_discount_reference',class:'informational'}
    ]);
    assert.deepEqual(await vq(`select relname,relforcerowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='mc' and relname in('stores','memberships','product_selections','reports') order by relname`),[
      {relname:'memberships',relforcerowsecurity:true},{relname:'product_selections',relforcerowsecurity:true},
      {relname:'reports',relforcerowsecurity:true},{relname:'stores',relforcerowsecurity:true}
    ]);
    pass('migration 30 preserves legacy loyalty semantics, refreshes invalidation and restores FORCE RLS');
  }finally{await v30UpgradeDb.close();}

  const v31UpgradeDb=new PGlite();
  try{
    for(const migration of migrations.filter(name=>Number(name.split('_')[0])<=30))await v31UpgradeDb.exec(await readFile(path.join(root,'db/migrations',migration),'utf8'));
    const vq=async(sql,params=[])=>(await v31UpgradeDb.query(sql,params)).rows;
    const vone=async(sql,params=[])=>(await vq(sql,params))[0];
    const upgradeUser=await vone(`insert into mc.users(display_name) values('V31 owner') returning id`);
    const upgradeBusiness=await vone(`insert into mc.businesses(name) values('V31 business') returning id`);
    await vq(`insert into mc.memberships(business_id,user_id,role) values($1,$2,'owner')`,[upgradeBusiness.id,upgradeUser.id]);
    await vq(`select set_config('app.user_id',$1,false),set_config('app.business_id',$2,false)`,[upgradeUser.id,upgradeBusiness.id]);
    const upgradeStore=await vone(`insert into mc.stores(business_id,external_account_id,name,status) values($1,'v31-store','V31 store','active') returning id`,[upgradeBusiness.id]);
    const catalog=await vone(`insert into mc.source_documents(business_id,store_id,origin,document_type,checksum,completeness) values($1,$2,'wb_api','catalog','v31-catalog','complete') returning id`,[upgradeBusiness.id,upgradeStore.id]);
    const product=await vone(`insert into mc.products(business_id,store_id,wb_article,seller_article) values($1,$2,310001,'V31') returning id`,[upgradeBusiness.id,upgradeStore.id]);
    await vone(`select mc.confirm_product_selection($1,$2,$3::uuid[]) as id`,[upgradeStore.id,catalog.id,[product.id]]);
    const document=await vone(`insert into mc.source_documents(business_id,store_id,origin,document_type,checksum,completeness) values($1,$2,'wb_api','weekly_realization','v31-report','complete') returning id`,[upgradeBusiness.id,upgradeStore.id]);
    const report=await vone(`insert into mc.reports(business_id,store_id,external_report_id,period_start,period_end) values($1,$2,'v31-report','2026-08-17','2026-08-23') returning id`,[upgradeBusiness.id,upgradeStore.id]);
    const version=await vone(`insert into mc.report_versions(business_id,store_id,report_id,document_id,version_no,checksum,parser_version) values($1,$2,$3,$4,1,'v31-version','wb-finance-v11') returning id`,[upgradeBusiness.id,upgradeStore.id,report.id,document.id]);
    await vq(`update mc.report_versions set status='validated' where id=$1`,[version.id]);
    await vq(`update mc.report_versions set status='accepted',accepted_at=now() where id=$1`,[version.id]);
    await vq(`update mc.reports set current_version_id=$1 where id=$2`,[version.id,report.id]);
    const before=await vone(`insert into mc.calculation_invalidations(business_id,store_id,requested_by,reason) values($1,$2,$3,'before_v31')
      on conflict(store_id) do update set requested_by=excluded.requested_by,reason=excluded.reason,generation_token=gen_random_uuid() returning generation_token`,[upgradeBusiness.id,upgradeStore.id,upgradeUser.id]);
    await vq(`select set_config('app.user_id','',false),set_config('app.business_id','',false)`);
    await v31UpgradeDb.exec(await readFile(path.join(root,'db/migrations/031_resolved_unclassified_quality.sql'),'utf8'));
    await vq(`select set_config('app.user_id',$1,false),set_config('app.business_id',$2,false)`,[upgradeUser.id,upgradeBusiness.id]);
    const after=await vone(`select reason,generation_token from mc.calculation_invalidations where store_id=$1`,[upgradeStore.id]);
    assert.equal(after.reason,'resolved_unclassified_quality_v15');
    assert.notEqual(after.generation_token,before.generation_token);
    assert.deepEqual(await vq(`select version_no,implementation_version from mc.method_versions where code='financial_result' and version_no in(15,16) order by version_no`),[
      {version_no:15,implementation_version:'financial-result-v15'},{version_no:16,implementation_version:'financial-result-v16'}
    ]);
    assert.deepEqual(await vq(`select relname,relforcerowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='mc' and relname in('stores','memberships','product_selections','reports') order by relname`),[
      {relname:'memberships',relforcerowsecurity:true},{relname:'product_selections',relforcerowsecurity:true},
      {relname:'reports',relforcerowsecurity:true},{relname:'stores',relforcerowsecurity:true}
    ]);
    pass('migration 31 upgrades populated v30 state, refreshes calculation and restores FORCE RLS');
  }finally{await v31UpgradeDb.close();}

  const operationalUpgradeDb=new PGlite();
  try{
    for(const migration of migrations.filter(name=>Number(name.split('_')[0])<=19))await operationalUpgradeDb.exec(await readFile(path.join(root,'db/migrations',migration),'utf8'));
    const oq=async(sql,params=[])=>(await operationalUpgradeDb.query(sql,params)).rows;
    const oone=async(sql,params=[])=>(await oq(sql,params))[0];
    const upgradeUser=await oone(`insert into mc.users(display_name) values('Operational upgrade owner') returning id`);
    const upgradeBusiness=await oone(`insert into mc.businesses(name) values('Operational upgrade business') returning id`);
    await oq(`insert into mc.memberships(business_id,user_id) values($1,$2)`,[upgradeBusiness.id,upgradeUser.id]);
    await oq(`select set_config('app.user_id',$1,false),set_config('app.business_id',$2,false)`,[upgradeUser.id,upgradeBusiness.id]);
    const upgradeStore=await oone(`insert into mc.stores(business_id,external_account_id,name,status) values($1,'operational-upgrade','Operational upgrade','active') returning id`,[upgradeBusiness.id]);
    await oq(`insert into mc.connections(business_id,store_id,secret_ref,status) values($1,$2,'database:upgrade','active')`,[upgradeBusiness.id,upgradeStore.id]);
    await oq(`select set_config('app.user_id','',false),set_config('app.business_id','',false)`);
    await operationalUpgradeDb.exec(await readFile(path.join(root,'db/migrations/020_operational_sales_funnel.sql'),'utf8'));
    await oq(`select set_config('app.user_id',$1,false),set_config('app.business_id',$2,false)`,[upgradeUser.id,upgradeBusiness.id]);
    assert.equal((await oone(`select count(*)::int as n from mc.sync_streams where store_id=$1 and source_type='operational_sales_funnel'`,[upgradeStore.id])).n,1);
    pass('migration 20 backfills an existing connected WB store without tenant context leakage');
  }finally{await operationalUpgradeDb.close();}

  const queueUpgradeDb=new PGlite();
  try{
    for(const migration of migrations.filter(name=>Number(name.split('_')[0])<=33))await queueUpgradeDb.exec(await readFile(path.join(root,'db/migrations',migration),'utf8'));
    const jq=async(sql,params=[])=>(await queueUpgradeDb.query(sql,params)).rows;
    const jone=async(sql,params=[])=>(await jq(sql,params))[0];
    const queueUser=await jone(`insert into mc.users(display_name) values('Queue upgrade owner') returning id`);
    const queueBusiness=await jone(`insert into mc.businesses(name) values('Queue upgrade business') returning id`);
    await jq(`insert into mc.memberships(business_id,user_id) values($1,$2)`,[queueBusiness.id,queueUser.id]);
    await jq(`select set_config('app.user_id',$1,false),set_config('app.business_id',$2,false)`,[queueUser.id,queueBusiness.id]);
    const queueStore=await jone(`insert into mc.stores(business_id,external_account_id,name,status) values($1,'queue-upgrade','Queue upgrade','active') returning id`,[queueBusiness.id]);
    for(const status of ['queued','cancelled','running','succeeded','failed']) {
      await jq(`insert into mc.jobs(business_id,store_id,job_type,deduplication_key,status,worker_id,lease_until,last_error)
        values($1,$2,'legacy',$3,$4,$5,$6,$7)`,[
        queueBusiness.id,queueStore.id,`legacy:${status}`,status,
        status==='running'?'old-worker':null,status==='running'?new Date(Date.now()+60000):null,
        status==='failed'?'legacy failure':null
      ]);
    }
    await queueUpgradeDb.exec(await readFile(path.join(root,'db/migrations/034_financial_event_queue.sql'),'utf8'));
    const upgraded=await jq(`select deduplication_key,status,worker_id,lease_until,finished_at,last_error_code,outcome
      from mc.jobs order by deduplication_key`);
    const byKey=Object.fromEntries(upgraded.map(row=>[row.deduplication_key,row]));
    assert.equal(byKey['legacy:queued'].status,'pending');
    assert.equal(byKey['legacy:running'].status,'pending');
    assert.equal(byKey['legacy:running'].worker_id,null);
    assert.equal(byKey['legacy:running'].lease_until,null);
    assert.equal(byKey['legacy:cancelled'].status,'failed');
    assert.equal(byKey['legacy:cancelled'].last_error_code,'legacy_cancelled');
    assert.ok(byKey['legacy:cancelled'].finished_at);
    assert.equal(byKey['legacy:succeeded'].outcome,'completed');
    assert.ok(byKey['legacy:succeeded'].finished_at);
    assert.equal(byKey['legacy:failed'].status,'failed');
    assert.equal(byKey['legacy:failed'].last_error_code,'legacy_failed');
    assert.equal((await jone(`select max(version)::int as version from mc.schema_migrations`)).version,34);
    pass('migration 34 safely maps legacy queue states and releases legacy running leases');
  }finally{await queueUpgradeDb.close();}

  const credentialUpgradeDb=new PGlite();
  try{
    for(const migration of migrations.filter(name=>Number(name.split('_')[0])<=35))await credentialUpgradeDb.exec(await readFile(path.join(root,'db/migrations',migration),'utf8'));
    const cq=async(sql,params=[])=>(await credentialUpgradeDb.query(sql,params)).rows;
    const cone=async(sql,params=[])=>(await cq(sql,params))[0];
    const legacyUser=await cone(`insert into mc.users(display_name) values('Legacy credential owner') returning id`);
    const legacyBusiness=await cone(`insert into mc.businesses(name) values('Legacy credential business') returning id`);
    await cq(`insert into mc.memberships(business_id,user_id,role) values($1,$2,'owner')`,[legacyBusiness.id,legacyUser.id]);
    await cq(`select set_config('app.user_id',$1,false),set_config('app.business_id',$2,false)`,[legacyUser.id,legacyBusiness.id]);
    const legacyStore=await cone(`insert into mc.stores(business_id,external_account_id,name,status) values($1,'legacy-cabinet','Legacy','active') returning id`,[legacyBusiness.id]);
    const legacyConnection=await cone(`insert into mc.connections(business_id,store_id,secret_ref,scopes,status) values($1,$2,'database:legacy','["finance"]','active') returning id`,[legacyBusiness.id,legacyStore.id]);
    await cq(`insert into mc.connection_secrets(business_id,connection_id,ciphertext,nonce,auth_tag) values($1,$2,$3,$4,$5)`,[legacyBusiness.id,legacyConnection.id,Buffer.from('encrypted'),Buffer.alloc(12),Buffer.alloc(16)]);
    await credentialUpgradeDb.exec(await readFile(path.join(root,'db/migrations/036_financial_coverage_scheduler.sql'),'utf8'));
    await credentialUpgradeDb.exec(await readFile(path.join(root,'db/migrations/037_financial_inventory_rls_lease.sql'),'utf8'));
    const backfill=await cq(`select connection_id,user_id,store_id,seller_id,scopes from mc.list_financial_credential_backfill(10)`);
    assert.deepEqual(backfill,[{connection_id:legacyConnection.id,user_id:legacyUser.id,store_id:legacyStore.id,seller_id:'legacy-cabinet',scopes:['finance']}]);
    assert.equal(await cone(`select mc.defer_financial_credential_backfill($1,60) as deferred`,[legacyConnection.id]).then(row=>row.deferred),true);
    assert.equal((await cq(`select * from mc.list_financial_credential_backfill(10)`)).length,0);
    assert.equal((await cone(`select count(*)::int as n from mc.financial_schedule_targets`)).n,0);
    assert.equal((await cone(`select max(version)::int as version from mc.schema_migrations`)).version,37);
    pass('migrations 36-37 expose legacy credentials and repair tenant-safe inventory leases');
  }finally{await credentialUpgradeDb.close();}

  const dailyUpgradeDb=new PGlite();
  try{
    for(const migration of migrations.filter(name=>Number(name.split('_')[0])<=38))await dailyUpgradeDb.exec(await readFile(path.join(root,'db/migrations',migration),'utf8'));
    const dq=async(sql,params=[])=>(await dailyUpgradeDb.query(sql,params)).rows;
    const done=async(sql,params=[])=>(await dq(sql,params))[0];
    const dailyUser=await done(`insert into mc.users(display_name) values('Daily upgrade owner') returning id`);
    const dailyBusiness=await done(`insert into mc.businesses(name) values('Daily upgrade business') returning id`);
    await dq(`insert into mc.memberships(business_id,user_id,role) values($1,$2,'owner')`,[dailyBusiness.id,dailyUser.id]);
    await dq(`select set_config('app.user_id',$1,false),set_config('app.business_id',$2,false)`,[dailyUser.id,dailyBusiness.id]);
    const dailyStore=await done(`insert into mc.stores(business_id,external_account_id,name,status) values($1,'daily-upgrade','Daily upgrade','active') returning id`,[dailyBusiness.id]);
    const dailyDocument=await done(`insert into mc.source_documents(business_id,store_id,origin,document_type,checksum,completeness) values($1,$2,'wb_api','weekly_realization','daily-upgrade-doc','complete') returning id`,[dailyBusiness.id,dailyStore.id]);
    const dailyReport=await done(`insert into mc.reports(business_id,store_id,external_report_id,period_start,period_end) values($1,$2,'daily-upgrade-report','2026-09-07','2026-09-13') returning id`,[dailyBusiness.id,dailyStore.id]);
    const dailyVersion=await done(`insert into mc.report_versions(business_id,store_id,report_id,document_id,version_no,checksum,parser_version) values($1,$2,$3,$4,1,'daily-upgrade-version','wb-finance-v11') returning id`,[dailyBusiness.id,dailyStore.id,dailyReport.id,dailyDocument.id]);
    await dq(`update mc.report_versions set status='validated' where id=$1`,[dailyVersion.id]);
    await dq(`update mc.report_versions set status='accepted',accepted_at=clock_timestamp() where id=$1`,[dailyVersion.id]);
    const dailyMethod=await done(`select id from mc.method_versions where code='wb_finance_import' and version_no=11`);
    const dailyNormalization=await done(`insert into mc.report_normalizations(business_id,store_id,report_version_id,method_version_id,normalization_key,status) values($1,$2,$3,$4,'daily-upgrade-normalization','succeeded') returning id`,[dailyBusiness.id,dailyStore.id,dailyVersion.id,dailyMethod.id]);
    const dailyJob=await done(`select * from mc.enqueue_job($1,'financial_dates_recalculate','daily-upgrade-job','{"schemaVersion":1,"eventGeneration":1,"affectedFrom":"2026-09-07","affectedTo":"2026-09-13","allowsWbApi":false}'::jsonb,clock_timestamp(),200,20)`,[dailyStore.id]);
    await dq(`insert into mc.financial_store_event_state(business_id,store_id,next_generation) values($1,$2,2)`,[dailyBusiness.id,dailyStore.id]);
    const legacyEvent=await done(`insert into mc.financial_input_events(business_id,store_id,event_generation,event_key,event_type,affected_from,affected_to,source_report_version_id,source_normalization_id,dispatch_job_id) values($1,$2,1,'daily-upgrade-event','report_accepted','2026-09-07','2026-09-13',$3,$4,$5) returning id`,[dailyBusiness.id,dailyStore.id,dailyVersion.id,dailyNormalization.id,dailyJob.id]);
    await dq(`delete from mc.memberships where business_id=$1 and user_id=$2`,[dailyBusiness.id,dailyUser.id]);
    await dq(`select set_config('app.user_id','',false),set_config('app.business_id','',false)`);
    await dailyUpgradeDb.exec(await readFile(path.join(root,'db/migrations/039_financial_daily_generations.sql'),'utf8'));
    assert.equal((await done(`select actor_user_id from mc.financial_input_events where id=$1`,[legacyEvent.id])).actor_user_id,dailyUser.id);
    assert.equal((await done(`select relforcerowsecurity forced from pg_class where oid='mc.report_normalizations'::regclass`)).forced,true);
    await assert.rejects(()=>dq(`update mc.financial_input_events set event_key='changed' where id=$1`,[legacyEvent.id]),/immutable record/);
    assert.equal((await done(`select max(version)::int version from mc.schema_migrations`)).version,39);
    pass('migration 39 upgrades populated immutable financial events and restores their mutation guard');
  }finally{await dailyUpgradeDb.close();}

  const emptyCoverageUpgradeDb=new PGlite();
  try{
    for(const migration of migrations.filter(name=>Number(name.split('_')[0])<=46))await emptyCoverageUpgradeDb.exec(await readFile(path.join(root,'db/migrations',migration),'utf8'));
    const eq=async(sql,params=[])=>(await emptyCoverageUpgradeDb.query(sql,params)).rows;
    const eone=async(sql,params=[])=>(await eq(sql,params))[0];
    const emptyUser=await eone(`insert into mc.users(display_name) values('Empty coverage upgrade owner') returning id`);
    const emptyBusiness=await eone(`insert into mc.businesses(name) values('Empty coverage upgrade business') returning id`);
    await eq(`insert into mc.memberships(business_id,user_id,role) values($1,$2,'owner')`,[emptyBusiness.id,emptyUser.id]);
    await eq(`select set_config('app.user_id',$1,false),set_config('app.business_id',$2,false)`,[emptyUser.id,emptyBusiness.id]);
    const emptyStore=await eone(`insert into mc.stores(business_id,external_account_id,name,status)
      values($1,'empty-upgrade','Empty upgrade','active') returning id`,[emptyBusiness.id]);
    await eq(`insert into mc.connections(business_id,store_id,secret_ref,scopes,status,credential_generation)
      values($1,$2,'database:empty-upgrade','["finance"]','active',1)`,[emptyBusiness.id,emptyStore.id]);
    const confirmationJob=await eone(`select * from mc.enqueue_job($1,'financial_inventory_refresh','empty-upgrade-confirmation',
      '{"schemaVersion":1,"credentialGeneration":1,"window":{"dateFrom":"2026-09-07","dateTo":"2026-09-13"}}'::jsonb,
      clock_timestamp(),100,3)`,[emptyStore.id]);
    await eq(`update mc.jobs set status='succeeded',outcome='completed',finished_at=clock_timestamp() where id=$1`,[confirmationJob.id]);
    const legacyEmpty=await eone(`insert into mc.financial_week_coverage(
      business_id,store_id,credential_generation,week_start,week_end,check_reasons,coverage_status,
      inventory_confirmed_at,last_checked_at,empty_confirmed_by_job_id
    ) values($1,$2,1,'2026-09-07','2026-09-13','{annual_backfill}','empty',
      clock_timestamp(),clock_timestamp(),$3) returning id`,[emptyBusiness.id,emptyStore.id,confirmationJob.id]);
    const staleConfirmationJob=await eone(`select * from mc.enqueue_job($1,'financial_inventory_refresh','stale-empty-upgrade-confirmation',
      '{"schemaVersion":1,"credentialGeneration":2,"window":{"dateFrom":"2026-08-31","dateTo":"2026-09-06"}}'::jsonb,
      clock_timestamp(),100,3)`,[emptyStore.id]);
    await eq(`update mc.jobs set status='succeeded',outcome='completed',finished_at=clock_timestamp() where id=$1`,[staleConfirmationJob.id]);
    const staleLegacyEmpty=await eone(`insert into mc.financial_week_coverage(
      business_id,store_id,credential_generation,week_start,week_end,check_reasons,coverage_status,
      inventory_confirmed_at,last_checked_at,empty_confirmed_by_job_id
    ) values($1,$2,2,'2026-08-31','2026-09-06','{annual_backfill}','empty',
      clock_timestamp(),clock_timestamp(),$3) returning id`,[emptyBusiness.id,emptyStore.id,staleConfirmationJob.id]);
    const inactiveUser=await eone(`insert into mc.users(display_name) values('Inactive empty coverage owner') returning id`);
    const inactiveBusiness=await eone(`insert into mc.businesses(name) values('Inactive empty coverage business') returning id`);
    await eq(`insert into mc.memberships(business_id,user_id,role) values($1,$2,'owner')`,[inactiveBusiness.id,inactiveUser.id]);
    await eq(`select set_config('app.user_id',$1,false),set_config('app.business_id',$2,false)`,[inactiveUser.id,inactiveBusiness.id]);
    const inactiveStore=await eone(`insert into mc.stores(business_id,external_account_id,name,status)
      values($1,'inactive-empty-upgrade','Inactive empty upgrade','active') returning id`,[inactiveBusiness.id]);
    await eq(`insert into mc.connections(business_id,store_id,secret_ref,scopes,status,credential_generation)
      values($1,$2,'database:inactive-empty-upgrade','["finance"]','active',1)`,[inactiveBusiness.id,inactiveStore.id]);
    const inactiveConfirmationJob=await eone(`select * from mc.enqueue_job($1,'financial_inventory_refresh','inactive-empty-upgrade-confirmation',
      '{"schemaVersion":1,"credentialGeneration":1,"window":{"dateFrom":"2026-09-07","dateTo":"2026-09-13"}}'::jsonb,
      clock_timestamp(),100,3)`,[inactiveStore.id]);
    await eq(`update mc.jobs set status='succeeded',outcome='completed',finished_at=clock_timestamp() where id=$1`,[inactiveConfirmationJob.id]);
    const inactiveLegacyEmpty=await eone(`insert into mc.financial_week_coverage(
      business_id,store_id,credential_generation,week_start,week_end,check_reasons,coverage_status,
      inventory_confirmed_at,last_checked_at,empty_confirmed_by_job_id
    ) values($1,$2,1,'2026-09-07','2026-09-13','{annual_backfill}','empty',
      clock_timestamp(),clock_timestamp(),$3) returning id`,[inactiveBusiness.id,inactiveStore.id,inactiveConfirmationJob.id]);
    await eq(`update mc.stores set status='archived' where id=$1`,[inactiveStore.id]);
    await eq(`select set_config('app.user_id','',false),set_config('app.business_id','',false)`);
    await emptyCoverageUpgradeDb.exec(await readFile(path.join(root,'db/migrations/047_financial_empty_week_calculation.sql'),'utf8'));
    await eq(`select set_config('app.user_id',$1,false),set_config('app.business_id',$2,false)`,[emptyUser.id,emptyBusiness.id]);
    assert.deepEqual(await eone(`select event_type,affected_from::text as affected_from,affected_to::text as affected_to,
        source_financial_week_coverage_id,source_empty_confirmation_job_id
      from mc.financial_input_events where source_financial_week_coverage_id=$1`,[legacyEmpty.id]),{
      event_type:'report_empty_confirmed',affected_from:'2026-09-07',affected_to:'2026-09-13',
      source_financial_week_coverage_id:legacyEmpty.id,source_empty_confirmation_job_id:confirmationJob.id
    });
    assert.deepEqual(await eone(`select payload->>'affectedFrom' affected_from,payload->>'affectedTo' affected_to,
        payload->>'allowsWbApi' allows_wb_api
      from mc.jobs where store_id=$1 and job_type='financial_dates_recalculate' and status='pending'`,[emptyStore.id]),{
      affected_from:'2026-09-07',affected_to:'2026-09-13',allows_wb_api:'false'
    });
    assert.equal((await eone(`select count(*)::int n from mc.financial_input_events
      where source_financial_week_coverage_id=$1`,[staleLegacyEmpty.id])).n,0);
    const wrongTypeJob=await eone(`select * from mc.enqueue_job($1,'financial_dates_recalculate','empty-evidence-wrong-type',
      '{"schemaVersion":1,"credentialGeneration":1,"window":{"dateFrom":"2026-09-07","dateTo":"2026-09-13"}}'::jsonb,
      clock_timestamp(),100,3)`,[emptyStore.id]);
    const wrongWindowJob=await eone(`select * from mc.enqueue_job($1,'financial_inventory_refresh','empty-evidence-wrong-window',
      '{"schemaVersion":1,"credentialGeneration":1,"window":{"dateFrom":"2026-09-08","dateTo":"2026-09-13"}}'::jsonb,
      clock_timestamp(),100,3)`,[emptyStore.id]);
    const wrongGenerationJob=await eone(`select * from mc.enqueue_job($1,'financial_inventory_refresh','empty-evidence-wrong-generation',
      '{"schemaVersion":1,"credentialGeneration":2,"window":{"dateFrom":"2026-09-07","dateTo":"2026-09-13"}}'::jsonb,
      clock_timestamp(),100,3)`,[emptyStore.id]);
    await eq(`update mc.jobs set status='running',worker_id='invalid-evidence-test',
      lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '5 minutes',heartbeat_at=clock_timestamp()
      where id=any($1::uuid[])`,[[wrongTypeJob.id,wrongWindowJob.id,wrongGenerationJob.id]]);
    assert.equal((await eone(`select mc.financial_empty_week_evidence_valid($1,$2) valid`,[legacyEmpty.id,confirmationJob.id])).valid,true);
    for(const invalidJob of [wrongTypeJob,wrongWindowJob,wrongGenerationJob]){
      await assert.rejects(()=>eq(`update mc.financial_week_coverage set empty_confirmed_by_job_id=$2
        where id=$1`,[legacyEmpty.id,invalidJob.id]),/confirmed empty financial week is required/);
      assert.equal((await eone(`select mc.financial_empty_week_evidence_valid($1,$2) valid`,[legacyEmpty.id,invalidJob.id])).valid,false);
    }
    await eq(`select set_config('app.user_id',$1,false),set_config('app.business_id',$2,false)`,[inactiveUser.id,inactiveBusiness.id]);
    assert.equal((await eone(`select count(*)::int n from mc.financial_input_events
      where source_financial_week_coverage_id=$1`,[inactiveLegacyEmpty.id])).n,0);
    assert.equal((await eone(`select count(*)::int n from mc.jobs
      where store_id=$1 and job_type='financial_dates_recalculate'`,[inactiveStore.id])).n,0);
    await eq(`select set_config('app.user_id',$1,false),set_config('app.business_id',$2,false)`,[emptyUser.id,emptyBusiness.id]);
    assert.equal((await eone(`select max(version)::int version from mc.schema_migrations`)).version,47);
    pass('migration 47 validates empty evidence and backfills only current active finance coverage');

    const v20Method=await eone(`select id from mc.method_versions
      where code='financial_result' and version_no=20`);
    await eone(`select * from mc.emit_financial_input_event(
      $1::uuid,'daily-publication-cutover:v1:store:'||($1::uuid)::text,'shadow_backfill','2026-09-07','2026-09-13',
      p_source_result_method_version_id=>$2
    )`,[emptyStore.id,v20Method.id]);
    await eq(`select set_config('app.user_id','',false),set_config('app.business_id','',false)`);
    await emptyCoverageUpgradeDb.exec(await readFile(path.join(root,'db/migrations/048_financial_legacy_shadow_recovery.sql'),'utf8'));
    await eq(`select set_config('app.user_id',$1,false),set_config('app.business_id',$2,false)`,[emptyUser.id,emptyBusiness.id]);
    assert.deepEqual(await eone(`select event_type,affected_from::text affected_from,affected_to::text affected_to,
        source_result_method_version_id
      from mc.financial_input_events
      where event_key='daily-publication-legacy-shadow-recovery:v1:store:'||$1`,[emptyStore.id]),{
      event_type:'shadow_backfill',affected_from:'2026-09-07',affected_to:'2026-09-13',
      source_result_method_version_id:v20Method.id
    });
    assert.equal((await eone(`select count(*)::int n from mc.financial_input_events
      where event_key='daily-publication-legacy-shadow-recovery:v1:store:'||$1`,[emptyStore.id])).n,1);
    assert.equal((await eone(`select payload->>'allowsWbApi' allows_wb_api from mc.jobs
      where id=(select dispatch_job_id from mc.financial_input_events
        where event_key='daily-publication-legacy-shadow-recovery:v1:store:'||$1)`,[emptyStore.id])).allows_wb_api,'false');
    assert.equal((await eone(`select count(*)::int n from mc.financial_input_events
      where event_key='daily-publication-legacy-shadow-recovery:v1:store:'||$1`,[inactiveStore.id])).n,0);
    assert.equal((await eone(`select max(version)::int version from mc.schema_migrations`)).version,48);
    pass('migration 48 replays a no-pointer cutover without WB API and skips archived stores');
  }finally{await emptyCoverageUpgradeDb.close();}

  const transportUpgradeDb=new PGlite();
  try{
    for(const migration of migrations.filter(name=>Number(name.split('_')[0])<=49))await transportUpgradeDb.exec(await readFile(path.join(root,'db/migrations',migration),'utf8'));
    const tq=async(sql,params=[])=>(await transportUpgradeDb.query(sql,params)).rows;
    const tone=async(sql,params=[])=>(await tq(sql,params))[0];
    const owner=await tone(`insert into mc.users(display_name) values('Transport upgrade owner') returning id`);
    const business=await tone(`insert into mc.businesses(name) values('Transport upgrade business') returning id`);
    await tq(`insert into mc.memberships(business_id,user_id,role) values($1,$2,'owner')`,[business.id,owner.id]);
    await tq(`select set_config('app.user_id',$1,false),set_config('app.business_id',$2,false)`,[owner.id,business.id]);
    const fixturePlan=await tone(`insert into mc.billing_plans(code,name) values('transport_fixture','Transport fixture') returning id`);
    const fixturePlanVersion=await tone(`insert into mc.billing_plan_versions(
        plan_id,version_no,product_limit,store_limit,price,billing_period
      ) values($1,1,100,4,0,'none') returning id`,[fixturePlan.id]);
    await tq(`update mc.subscriptions set plan_version_id=$1 where business_id=$2`,[fixturePlanVersion.id,business.id]);
    const parser=await tone(`select id from mc.method_versions where code='wb_finance_import' and version_no=11`);
    const resultMethod=await tone(`select id from mc.method_versions where code='financial_result' and version_no=20`);
    const createTransportStore=async(suffix,{pointer=false,archived=false,deliveryIssues=[]}={})=>{
      const externalReportId=String({affected:91001,'no-pointer':91002,archived:91003,unaffected:91004}[suffix]);
      const inventoryChecksum=({affected:'a','no-pointer':'b',archived:'c',unaffected:'d'}[suffix]).repeat(64);
      const store=await tone(`insert into mc.stores(business_id,external_account_id,name,status)
        values($1,$2,$3,'active') returning id`,[business.id,`transport-${suffix}`,`Transport ${suffix}`]);
      const document=await tone(`insert into mc.source_documents(business_id,store_id,origin,document_type,checksum,completeness)
        values($1,$2,'wb_api','weekly_realization',$3,'complete') returning id`,[business.id,store.id,`transport-document-${suffix}`]);
      const report=await tone(`insert into mc.reports(business_id,store_id,external_report_id,period_start,period_end)
        values($1,$2,$3,'2026-09-21','2026-09-27') returning id`,[business.id,store.id,externalReportId]);
      const version=await tone(`insert into mc.report_versions(business_id,store_id,report_id,document_id,version_no,checksum,parser_version)
        values($1,$2,$3,$4,1,$5,'wb-finance-v11') returning id`,[business.id,store.id,report.id,document.id,`transport-version-${suffix}`]);
      const raw={rrdId:0,docTypeName:'',sellerOperName:'Изменяемое название WB',rrDate:'2026-09-24',rebillLogisticCost:'18.97501',vw:'-15.547',vwNds:'-3.42801'};
      const row=await tone(`insert into mc.report_rows(business_id,store_id,report_version_id,external_row_key,row_number,raw_data,row_checksum)
        values($1,$2,$3,$4,1,$5::jsonb,$6) returning id`,[business.id,store.id,version.id,`transport-row-${suffix}`,JSON.stringify(raw),`transport-row-checksum-${suffix}`]);
      const normalization=await tone(`insert into mc.report_normalizations(business_id,store_id,report_version_id,method_version_id,normalization_key,status)
        values($1,$2,$3,$4,$5,'succeeded') returning id`,[business.id,store.id,version.id,parser.id,`transport-normalization-${suffix}`]);
      const operation=await tone(`insert into mc.operations(business_id,store_id,source_code,source_operation_key)
        values($1,$2,'wb',$3) returning id`,[business.id,store.id,`transport-operation-${suffix}`]);
      const operationVersion=await tone(`insert into mc.operation_versions(
          business_id,store_id,operation_id,report_row_id,version_no,operation_type,accounting_date,report_normalization_id
        ) values($1,$2,$3,$4,1,'other','2026-09-24',$5) returning id`,[business.id,store.id,operation.id,row.id,normalization.id]);
      for(const [field,category,amount,scope] of [
        ['rebillLogisticCost','rebill_logistic_compensation','-18.9800','reconciliation'],
        ['vw','wb_reward_without_vat','15.5500','selected_product'],
        ['vwNds','wb_reward_vat','3.4300','selected_product']
      ])await tq(`insert into mc.financial_components(
          business_id,store_id,operation_version_id,component_key,category_code,amount_signed,method_version_id,source_field,result_scope_classification
        ) values($1,$2,$3,$4,$5,$6,$7,$4,$8)`,[business.id,store.id,operationVersion.id,field,category,amount,parser.id,scope]);
      const deliveryIssueIds=[];
      for(const [index,sourceFields] of deliveryIssues.entries()){
        const deliveryRaw={rrdId:0,docTypeName:'Изменяемый текст',sellerOperName:'Новое название WB',rrDate:'2026-09-24',deliveryService:'-14.64'};
        const deliveryRow=await tone(`insert into mc.report_rows(
            business_id,store_id,report_version_id,external_row_key,row_number,raw_data,row_checksum
          ) values($1,$2,$3,$4,$5,$6::jsonb,$7) returning id`,[business.id,store.id,version.id,
          `delivery-row-${suffix}-${index}`,index+2,JSON.stringify(deliveryRaw),`delivery-row-checksum-${suffix}-${index}`]);
        const deliveryOperation=await tone(`insert into mc.operations(business_id,store_id,source_code,source_operation_key)
          values($1,$2,'wb',$3) returning id`,[business.id,store.id,`delivery-operation-${suffix}-${index}`]);
        const deliveryVersion=await tone(`insert into mc.operation_versions(
            business_id,store_id,operation_id,report_row_id,version_no,operation_type,accounting_date,report_normalization_id
          ) values($1,$2,$3,$4,1,'service_charge','2026-09-17',$5) returning id`,
          [business.id,store.id,deliveryOperation.id,deliveryRow.id,normalization.id]);
        await tq(`insert into mc.financial_components(
            business_id,store_id,operation_version_id,component_key,category_code,amount_signed,method_version_id,source_field,result_scope_classification
          ) values($1,$2,$3,'deliveryService','logistics','14.6400',$4,'deliveryService','selected_product')`,
          [business.id,store.id,deliveryVersion.id,parser.id]);
        deliveryIssueIds.push((await tone(`insert into mc.data_issues(
            business_id,store_id,document_id,report_row_id,report_normalization_id,code,severity,details
          ) values($1,$2,$3,$4,$5,'financial_components_unverified','blocking',$6::jsonb) returning id`,
          [business.id,store.id,document.id,deliveryRow.id,normalization.id,JSON.stringify({sourceFields})])).id);
      }
      await tq(`update mc.report_versions set status='validated' where id=$1`,[version.id]);
      await tq(`update mc.report_versions set status='accepted',accepted_at=clock_timestamp() where id=$1`,[version.id]);
      await tq(`update mc.reports set current_version_id=$1 where id=$2`,[version.id,report.id]);
      await tq(`insert into mc.connections(business_id,store_id,secret_ref,scopes,status,credential_generation)
        values($1,$2,$3,'["finance"]','active',$4)`,[business.id,store.id,`database:transport-${suffix}`,suffix==='no-pointer'?2:1]);
      const coverage=await tone(`insert into mc.financial_week_coverage(
          business_id,store_id,credential_generation,week_start,week_end,check_reasons,coverage_status,inventory_confirmed_at,last_checked_at
        ) values($1,$2,1,'2026-09-21','2026-09-27','{annual_backfill}','complete',clock_timestamp(),clock_timestamp()) returning id`,
        [business.id,store.id]);
      await tq(`insert into mc.financial_week_inventory(
          business_id,store_id,coverage_id,external_report_id,inventory_checksum,period_start,period_end,fetch_status,
          report_version_id,accepted_normalization_id,accepted_inventory_checksum,accepted_at
        ) values($1,$2,$3,$4,$5,'2026-09-21','2026-09-27','accepted',$6,$7,$5,clock_timestamp())`,
        [business.id,store.id,coverage.id,externalReportId,inventoryChecksum,version.id,normalization.id]);
      if(pointer){
        const job=await tone(`select * from mc.enqueue_job($1,'financial_dates_recalculate',$2,
          '{"schemaVersion":1,"eventGeneration":1,"affectedFrom":"2026-09-21","affectedTo":"2026-09-27","allowsWbApi":false}'::jsonb,
          clock_timestamp(),200,20)`,[store.id,`transport-generation-${suffix}`]);
        const generation=await tone(`insert into mc.financial_daily_generations(
            business_id,store_id,generation_no,source_event_generation,watermark_generation,job_id,affected_from,affected_to,
            parser_method_version_id,result_method_version_id,frozen_input_fingerprint,status,quality,finished_at
          ) values($1,$2,1,1,1,$3,'2026-09-21','2026-09-27',$4,$5,$6,'succeeded','partial',clock_timestamp()) returning id`,
          [business.id,store.id,job.id,parser.id,resultMethod.id,`transport-fingerprint-${suffix}`]);
        const publication=await tone(`insert into mc.financial_daily_publications(
            business_id,store_id,publication_no,generation_id,affected_from,affected_to,source_event_generation,watermark_generation
          ) values($1,$2,1,$3,'2026-09-21','2026-09-27',1,1) returning id`,[business.id,store.id,generation.id]);
        await tq(`alter table mc.financial_daily_current_publications disable trigger user`);
        await tq(`insert into mc.financial_daily_current_publications(business_id,store_id,publication_id) values($1,$2,$3)`,[business.id,store.id,publication.id]);
        await tq(`alter table mc.financial_daily_current_publications enable trigger user`);
      }
      if(archived)await tq(`update mc.stores set status='archived' where id=$1`,[store.id]);
      return{...store,deliveryIssueIds};
    };
    const affectedStore=await createTransportStore('affected',{pointer:true,deliveryIssues:[['deliveryService'],['deliveryService','agencyVat']]});
    const noPointerStore=await createTransportStore('no-pointer',{deliveryIssues:[['deliveryService']]});
    const archivedStore=await createTransportStore('archived',{pointer:true,archived:true,deliveryIssues:[['deliveryService']]});
    const unaffectedStore=await createTransportStore('unaffected',{pointer:true});
    await tq(`select set_config('app.user_id','',false),set_config('app.business_id','',false)`);
    await transportUpgradeDb.exec(await readFile(path.join(root,'db/migrations/050_transport_reimbursement_source_row.sql'),'utf8'));
    await tq(`select set_config('app.user_id',$1,false),set_config('app.business_id',$2,false)`,[owner.id,business.id]);
    assert.deepEqual(await tone(`select event_type,affected_from::text affected_from,affected_to::text affected_to,
        source_result_method_version_id,allows_wb_api
      from mc.financial_input_events where event_key='transport-zero-bundle-v20-fix:v1:store:'||$1`,[affectedStore.id]),{
      event_type:'shadow_backfill',affected_from:'2026-09-21',affected_to:'2026-09-27',
      source_result_method_version_id:resultMethod.id,allows_wb_api:false
    });
    assert.equal((await tone(`select count(*)::int n from mc.financial_input_events
      where event_key='transport-zero-bundle-v20-fix:v1:store:'||$1`,[noPointerStore.id])).n,0);
    assert.equal((await tone(`select count(*)::int n from mc.financial_input_events
      where event_key='transport-zero-bundle-v20-fix:v1:store:'||$1`,[archivedStore.id])).n,0);
    assert.equal((await tone(`select payload->>'allowsWbApi' allows_wb_api from mc.jobs
      where id=(select dispatch_job_id from mc.financial_input_events
        where event_key='transport-zero-bundle-v20-fix:v1:store:'||$1)`,[affectedStore.id])).allows_wb_api,'false');
    await tone(`select mc.emit_financial_input_event($1::uuid,'transport-zero-bundle-v20-fix:v1:store:'||($1::uuid)::text,
      'shadow_backfill','2026-09-21','2026-09-27',p_source_result_method_version_id=>$2)`,[affectedStore.id,resultMethod.id]);
    assert.equal((await tone(`select count(*)::int n from mc.financial_input_events
      where event_key='transport-zero-bundle-v20-fix:v1:store:'||$1`,[affectedStore.id])).n,1);
    assert.deepEqual(await tq(`select relname,relforcerowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='mc' and relname in('stores','memberships','financial_daily_current_publications') order by relname`),[
      {relname:'financial_daily_current_publications',relforcerowsecurity:true},
      {relname:'memberships',relforcerowsecurity:true},{relname:'stores',relforcerowsecurity:true}
    ]);
    assert.equal((await tone(`select max(version)::int version from mc.schema_migrations`)).version,50);
    pass('migration 50 backfills only active published transport bundles without WB API');

    const [resolvedIssue,mixedIssue]=affectedStore.deliveryIssueIds;
    const [noPointerIssue]=noPointerStore.deliveryIssueIds;
    const [archivedIssue]=archivedStore.deliveryIssueIds;
    await tq(`select set_config('app.user_id','',false),set_config('app.business_id','',false)`);
    await transportUpgradeDb.exec(await readFile(path.join(root,'db/migrations/051_delivery_service_reversal.sql'),'utf8'));
    await tq(`select set_config('app.user_id',$1,false),set_config('app.business_id',$2,false)`,[owner.id,business.id]);
    const upgradedMethods=await tq(`select code,version_no,implementation_version,parameters->>'deliveryServiceReversal' rule
      from mc.method_versions where (code='wb_finance_import' and version_no=12)
        or (code='financial_result' and version_no in(21,22)) order by code,version_no`);
    assert.deepEqual(upgradedMethods,[
      {code:'financial_result',version_no:21,implementation_version:'financial-result-v21',rule:'signed-expense-reversal-v1'},
      {code:'financial_result',version_no:22,implementation_version:'financial-result-v22',rule:'signed-expense-reversal-v1'},
      {code:'wb_finance_import',version_no:12,implementation_version:'wb-finance-v12',rule:'signed-expense-reversal-v1'}
    ]);
    for(const store of [affectedStore,noPointerStore,unaffectedStore]){
      const job=await tone(`select job_type,priority,payload->>'reportVersionId' report_version_id,
          (payload->>'credentialGeneration')::int credential_generation
        from mc.jobs where store_id=$1 and deduplication_key like '%:wb-finance-v12:%'`,[store.id]);
      assert.equal(job.job_type,'financial_report_normalize');
      assert.equal(job.priority,275);
      assert.ok(job.report_version_id);
      assert.equal(job.credential_generation,store.id===noPointerStore.id?2:1);
    }
    assert.equal((await tone(`select count(*)::int n from mc.jobs
      where store_id=$1 and deduplication_key like '%:wb-finance-v12:%'`,[archivedStore.id])).n,0);
    for(const issue of [resolvedIssue,mixedIssue,noPointerIssue,archivedIssue])
      assert.equal((await tone(`select status from mc.data_issues where id=$1`,[issue])).status,'open');
    assert.equal((await tone(`select count(*)::int n from mc.financial_input_events
      where event_key like 'financial-method-upgrade:v22:%'`)).n,0);
    const parserV12=await tone(`select id from mc.method_versions where code='wb_finance_import' and version_no=12`);
    const resultV22=await tone(`select id from mc.method_versions where code='financial_result' and version_no=22`);
    const parserEvent=await tone(`select id,dispatch_job_id from mc.emit_financial_input_event(
      $1,$2,'parser_method_updated','2026-09-21','2026-09-27',p_source_parser_method_version_id=>$3)`,
      [noPointerStore.id,`financial-parser-upgrade:v12:store:${noPointerStore.id}`,parserV12.id]);
    const resultEvent=await tone(`select id,dispatch_job_id from mc.emit_financial_input_event(
      $1,$2,'result_method_updated','2026-09-21','2026-09-27',p_source_result_method_version_id=>$3)`,
      [noPointerStore.id,`financial-result-upgrade:v22:store:${noPointerStore.id}`,resultV22.id]);
    assert.equal(parserEvent.dispatch_job_id,resultEvent.dispatch_job_id);
    assert.deepEqual(await tq(`select event_type,source_parser_method_version_id,source_result_method_version_id,allows_wb_api
      from mc.financial_input_events where id=any($1::uuid[]) order by event_type`,[[parserEvent.id,resultEvent.id]]),[
      {event_type:'parser_method_updated',source_parser_method_version_id:parserV12.id,source_result_method_version_id:null,allows_wb_api:false},
      {event_type:'result_method_updated',source_parser_method_version_id:null,source_result_method_version_id:resultV22.id,allows_wb_api:false}
    ]);
    assert.deepEqual(await tq(`select relname,relforcerowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='mc' and relname in('stores','memberships','financial_daily_current_publications') order by relname`),[
      {relname:'financial_daily_current_publications',relforcerowsecurity:true},
      {relname:'memberships',relforcerowsecurity:true},{relname:'stores',relforcerowsecurity:true}
    ]);
    assert.equal((await tone(`select max(version)::int version from mc.schema_migrations`)).version,51);
    pass('migration 51 versions the global delivery reversal and queues local renormalization before cutover');

    const returnCatalog=await tone(`insert into mc.source_documents(business_id,store_id,origin,document_type,checksum,completeness)
      values($1,$2,'wb_api','catalog','return-upgrade-catalog','complete') returning id`,[business.id,affectedStore.id]);
    const returnProduct=await tone(`insert into mc.products(business_id,store_id,wb_article,seller_article)
      values($1,$2,520001,'RETURN-UPGRADE') returning id`,[business.id,affectedStore.id]);
    const returnSelection=await tone(`select mc.confirm_product_selection($1,$2,$3::uuid[]) id`,[affectedStore.id,returnCatalog.id,[returnProduct.id]]);
    await tq(`select set_config('app.user_id','',false),set_config('app.business_id','',false)`);
    await transportUpgradeDb.exec(await readFile(path.join(root,'db/migrations/052_return_expense_reversal.sql'),'utf8'));
    await tq(`select set_config('app.user_id',$1,false),set_config('app.business_id',$2,false)`,[owner.id,business.id]);
    const returnMethods=await tq(`select version_no,implementation_version,parameters->>'returnExpenseReversal' rule
      from mc.method_versions where code='financial_result' and version_no in(23,24) order by version_no`);
    assert.deepEqual(returnMethods,[
      {version_no:23,implementation_version:'financial-result-v23',rule:'raw-signed-four-fields-round-sum-v1'},
      {version_no:24,implementation_version:'financial-result-v24',rule:'raw-signed-four-fields-round-sum-v1'}
    ]);
    const returnVariant=await tone(`insert into mc.variants(business_id,store_id,product_id,external_variant_id)
      values($1,$2,$3,'return-variant') returning id`,[business.id,affectedStore.id,returnProduct.id]);
    const returnDocument=await tone(`insert into mc.source_documents(business_id,store_id,origin,document_type,checksum,completeness)
      values($1,$2,'wb_api','weekly_realization','return-link-document','complete') returning id`,[business.id,affectedStore.id]);
    const returnReport=await tone(`insert into mc.reports(business_id,store_id,external_report_id,period_start,period_end)
      values($1,$2,'return-link-report','2026-05-11','2026-05-17') returning id`,[business.id,affectedStore.id]);
    const returnVersion=await tone(`insert into mc.report_versions(business_id,store_id,report_id,document_id,version_no,checksum,parser_version)
      values($1,$2,$3,$4,1,'return-link-version','wb-finance-v12') returning id`,[business.id,affectedStore.id,returnReport.id,returnDocument.id]);
    const returnParserV12=await tone(`select id from mc.method_versions where code='wb_finance_import' and version_no=12`);
    const returnNormalization=await tone(`insert into mc.report_normalizations(
        business_id,store_id,report_version_id,method_version_id,normalization_key,status)
      values($1,$2,$3,$4,'return-link-normalization','succeeded') returning id`,
      [business.id,affectedStore.id,returnVersion.id,returnParserV12.id]);
    const insertReturnOperation=async(key,rowNumber,operationType,quantity,shkId,{srid='same-srid',rawFields={}}={})=>{
      const raw={rrdId:0,nmId:520001,shkId,orderDt:'2026-05-11T10:00:00Z',rrDate:'2026-05-12',
        docTypeName:operationType==='sale'?'Продажа':'Возврат',sellerOperName:operationType==='sale'?'Продажа':'Возврат',...rawFields};
      const row=await tone(`insert into mc.report_rows(business_id,store_id,report_version_id,external_row_key,row_number,raw_data,row_checksum)
        values($1,$2,$3,$4,$5,$6::jsonb,$7) returning id`,[business.id,affectedStore.id,returnVersion.id,key,rowNumber,JSON.stringify(raw),`${key}-checksum`]);
      const operation=await tone(`insert into mc.operations(business_id,store_id,source_code,source_operation_key)
        values($1,$2,'wb',$3) returning id`,[business.id,affectedStore.id,key]);
      return tone(`insert into mc.operation_versions(business_id,store_id,operation_id,report_row_id,version_no,srid,operation_type,
          product_id,variant_id,accounting_date,quantity,report_normalization_id)
        values($1,$2,$3,$4,1,$5,$6,$7,$8,'2026-05-12',$9,$10) returning id,report_row_id`,
        [business.id,affectedStore.id,operation.id,row.id,srid,operationType,returnProduct.id,returnVariant.id,quantity,returnNormalization.id]);
    };
    const exactSale=await insertReturnOperation('return-link-sale',1,'sale','1','same-shk');
    const exactReturn=await insertReturnOperation('return-link-return',2,'return','-1','same-shk',{
      rawFields:{acquiringFee:'31.33',vw:'208.84754',vwNds:'45.95',ppvzReward:'25.206',retailAmount:'642.00',forPay:'330.67'}
    });
    const mismatchReturn=await insertReturnOperation('return-link-mismatch',3,'return','-1','other-shk');
    const excessReturn=await insertReturnOperation('return-link-excess',4,'return','-1','same-shk');
    const resultV23=await tone(`select id from mc.method_versions where code='financial_result' and version_no=23`);
    assert.ok((await tone(`insert into mc.operation_links(business_id,store_id,from_operation_version_id,to_operation_version_id,
        link_type,status,method_version_id,evidence) values($1,$2,$3,$4,'return_to_original_sale','confirmed',$5,'{}') returning id`,
      [business.id,affectedStore.id,exactReturn.id,exactSale.id,resultV23.id])).id);
    await assert.rejects(()=>tq(`insert into mc.operation_links(business_id,store_id,from_operation_version_id,to_operation_version_id,
        link_type,status,method_version_id,evidence) values($1,$2,$3,$4,'return_to_original_sale','confirmed',$5,'{}')`,
      [business.id,affectedStore.id,mismatchReturn.id,exactSale.id,resultV23.id]),/confirmed return link does not match/);
    await assert.rejects(()=>tq(`insert into mc.operation_links(business_id,store_id,from_operation_version_id,to_operation_version_id,
        link_type,status,method_version_id,evidence) values($1,$2,$3,$4,'return_to_original_sale','confirmed',$5,'{}')`,
      [business.id,affectedStore.id,excessReturn.id,exactSale.id,resultV23.id]),/confirmed returns exceed original sale quantity/);
    assert.equal((await tone(`select count(*)::int n from mc.financial_input_events
      where event_key='financial-result-upgrade:v24:store:'||$1`,[affectedStore.id])).n,1);
    assert.equal((await tone(`select max(version)::int version from mc.schema_migrations`)).version,52);
    assert.match((await tone(`select pg_get_functiondef('mc.guard_confirmed_return_link()'::regprocedure) definition`)).definition,
      /sold\.accounting_date\s*>\s*returned\.accounting_date/);
    assert.match((await tone(`select pg_get_functiondef('mc.guard_daily_return_expense_evidence()'::regprocedure) definition`)).definition,
      /return_wb_expense_reversal/);
    pass('migration 52 versions selected-SKU return expense reversal and queues local recalculation');

    const negativeSale=await insertReturnOperation('return-link-negative-sale',5,'sale','1','negative-shk',{srid:'negative-srid'});
    const negativeReturn=await insertReturnOperation('return-link-negative-return',6,'return','-1','negative-shk',{
      srid:'negative-srid',rawFields:{acquiringFee:'1.00',vw:'-5.73',vwNds:'0',ppvzReward:'0',retailAmount:'100.00',forPay:'104.73'}
    });
    await tq(`select set_config('app.user_id','',false),set_config('app.business_id','',false)`);
    await transportUpgradeDb.exec(await readFile(path.join(root,'db/migrations/053_signed_return_expense_reversal.sql'),'utf8'));
    await tq(`select set_config('app.user_id',$1,false),set_config('app.business_id',$2,false)`,[owner.id,business.id]);
    const signedReturnMethods=await tq(`select version_no,implementation_version,parameters->>'returnExpenseReversal' rule
      from mc.method_versions where code='financial_result' and version_no in(25,26) order by version_no`);
    assert.deepEqual(signedReturnMethods,[
      {version_no:25,implementation_version:'financial-result-v25',rule:'raw-signed-four-fields-retain-acquiring-v2'},
      {version_no:26,implementation_version:'financial-result-v26',rule:'raw-signed-four-fields-retain-acquiring-v2'}
    ]);
    const resultV25=await tone(`select id from mc.method_versions where code='financial_result' and version_no=25`);
    const resultV26=await tone(`select id from mc.method_versions where code='financial_result' and version_no=26`);
    const positiveLink=await tone(`insert into mc.operation_links(business_id,store_id,from_operation_version_id,to_operation_version_id,
        link_type,status,method_version_id,evidence) values($1,$2,$3,$4,'return_to_original_sale','confirmed',$5,'{}') returning id`,
      [business.id,affectedStore.id,exactReturn.id,exactSale.id,resultV25.id]);
    const negativeLink=await tone(`insert into mc.operation_links(business_id,store_id,from_operation_version_id,to_operation_version_id,
        link_type,status,method_version_id,evidence) values($1,$2,$3,$4,'return_to_original_sale','confirmed',$5,'{}') returning id`,
      [business.id,affectedStore.id,negativeReturn.id,negativeSale.id,resultV25.id]);
    const signedRequest=await tone(`insert into mc.calculation_requests(
        business_id,store_id,generation_no,selection_id,method_version_id,period_start,period_end,input_fingerprint,is_latest
      ) values($1,$2,53,$3,$4,'2026-05-11','2026-05-17','signed-return-v25-fixture',false) returning id`,
      [business.id,affectedStore.id,returnSelection.id,resultV25.id]);
    await tq(`insert into mc.calculation_request_products(business_id,store_id,request_id,product_id) values($1,$2,$3,$4)`,
      [business.id,affectedStore.id,signedRequest.id,returnProduct.id]);
    await tq(`insert into mc.calculation_request_inputs(business_id,store_id,request_id,report_normalization_id) values($1,$2,$3,$4)`,
      [business.id,affectedStore.id,signedRequest.id,returnNormalization.id]);
    for(const link of [positiveLink,negativeLink])await tq(`insert into mc.calculation_request_inputs(
        business_id,store_id,request_id,operation_link_id) values($1,$2,$3,$4)`,
      [business.id,affectedStore.id,signedRequest.id,link.id]);
    const signedRun=await tone(`insert into mc.calculation_runs(
        business_id,store_id,selection_id,method_version_id,period_start,period_end,input_fingerprint,request_id,attempt_no
      ) values($1,$2,$3,$4,'2026-05-11','2026-05-17','signed-return-v25-fixture',$5,1) returning id`,
      [business.id,affectedStore.id,returnSelection.id,resultV25.id,signedRequest.id]);
    const signedPeriod=await tone(`insert into mc.financial_period_results(
        business_id,store_id,run_id,period_start,period_end,quality,missing_reasons,totals
      ) values($1,$2,$3,'2026-05-11','2026-05-17','partial','["operation_unclassified"]',
        '{"selectedProductsResultBeforeTax":"0.0000","storeLevelResultBeforeTax":"0.0000","availableResultBeforeTax":"0.0000","estimatedUsnTax":"0.0000","availableResultAfterTax":null,"netProfit":null}') returning id`,
      [business.id,affectedStore.id,signedRun.id]);
    await tq(`insert into mc.calculation_inputs(business_id,store_id,run_id,report_normalization_id) values($1,$2,$3,$4)`,
      [business.id,affectedStore.id,signedRun.id,returnNormalization.id]);
    for(const link of [positiveLink,negativeLink])await tq(`insert into mc.calculation_inputs(
        business_id,store_id,run_id,operation_link_id) values($1,$2,$3,$4)`,
      [business.id,affectedStore.id,signedRun.id,link.id]);
    const reversalLine=await tone(`insert into mc.result_lines(
        business_id,store_id,run_id,product_id,variant_id,accounting_date,category_code,amount_signed,quality,result_scope,financial_period_result_id
      ) values($1,$2,$3,$4,$5,'2026-05-12','return_wb_expense_reversal',306.60,'complete','selected_product',$6) returning id`,
      [business.id,affectedStore.id,signedRun.id,returnProduct.id,returnVariant.id,signedPeriod.id]);
    await tq(`insert into mc.result_evidence(
        business_id,store_id,result_line_id,report_row_id,source_operation_version_id,operation_link_id,contribution_amount
      ) values($1,$2,$3,$4,$5,$6,311.33)`,
      [business.id,affectedStore.id,reversalLine.id,exactReturn.report_row_id,exactReturn.id,positiveLink.id]);
    await tq(`insert into mc.result_evidence(
        business_id,store_id,result_line_id,report_row_id,source_operation_version_id,operation_link_id,contribution_amount
      ) values($1,$2,$3,$4,$5,$6,-4.73)`,
      [business.id,affectedStore.id,reversalLine.id,negativeReturn.report_row_id,negativeReturn.id,negativeLink.id]);
    const acquiringComponent=await tone(`insert into mc.financial_components(
        business_id,store_id,operation_version_id,component_key,category_code,amount_signed,method_version_id,source_field,result_scope_classification
      ) values($1,$2,$3,'acquiringFee','acquiring',31.33,$4,'acquiringFee','selected_product') returning id`,
      [business.id,affectedStore.id,exactReturn.id,returnParserV12.id]);
    const acquiringLine=await tone(`insert into mc.result_lines(
        business_id,store_id,run_id,product_id,variant_id,accounting_date,category_code,amount_signed,quality,result_scope,financial_period_result_id
      ) values($1,$2,$3,$4,$5,'2026-05-12','acquiring',31.33,'complete','selected_product',$6) returning id`,
      [business.id,affectedStore.id,signedRun.id,returnProduct.id,returnVariant.id,signedPeriod.id]);
    await tq(`insert into mc.result_evidence(
        business_id,store_id,result_line_id,financial_component_id,contribution_amount
      ) values($1,$2,$3,$4,31.33)`,[business.id,affectedStore.id,acquiringLine.id,acquiringComponent.id]);
    assert.equal((await tone(`select count(*)::int n from mc.financial_input_events
      where event_key='financial-result-upgrade:v26:store:'||$1 and source_result_method_version_id=$2`,[affectedStore.id,resultV26.id])).n,1);
    assert.equal((await tone(`select count(*)::int n from mc.financial_input_events
      where event_key='financial-result-upgrade:v26:store:'||$1 and source_result_method_version_id=$2`,[noPointerStore.id,resultV26.id])).n,0);
    assert.equal((await tone(`select count(*)::int n from mc.financial_input_events
      where event_key='financial-result-upgrade:v26:store:'||$1`,[archivedStore.id])).n,0);
    assert.equal((await tone(`select max(version)::int version from mc.schema_migrations`)).version,53);
    const signedEvidenceGuard=(await tone(`select pg_get_functiondef('mc.guard_evidence_source()'::regprocedure) definition`)).definition;
    assert.match(signedEvidenceGuard,/financial-result-v25/);
    assert.match(signedEvidenceGuard,/reversal\s*=\s*0/);
    assert.doesNotMatch(signedEvidenceGuard,/reversal\s*<=\s*0/);
    pass('migration 53 keeps acquiring and accepts exact positive and negative signed return reversals');

    await tq(`select set_config('app.user_id','',false),set_config('app.business_id','',false)`);
    await transportUpgradeDb.exec(await readFile(path.join(root,'db/migrations/054_single_count_return_expense_reversal.sql'),'utf8'));
    await tq(`select set_config('app.user_id',$1,false),set_config('app.business_id',$2,false)`,[owner.id,business.id]);
    assert.deepEqual(await tq(`select version_no,implementation_version,parameters->>'returnExpenseReversal' rule
      from mc.method_versions where code='financial_result' and version_no in(27,28) order by version_no`),[
      {version_no:27,implementation_version:'financial-result-v27',rule:'raw-signed-four-fields-single-count-v3'},
      {version_no:28,implementation_version:'financial-result-v28',rule:'raw-signed-four-fields-single-count-v3'}
    ]);
    const resultV27=await tone(`select id from mc.method_versions where code='financial_result' and version_no=27`);
    const resultV28=await tone(`select id from mc.method_versions where code='financial_result' and version_no=28`);
    const singlePositiveLink=await tone(`insert into mc.operation_links(business_id,store_id,from_operation_version_id,to_operation_version_id,
        link_type,status,method_version_id,evidence) values($1,$2,$3,$4,'return_to_original_sale','confirmed',$5,'{}') returning id`,
      [business.id,affectedStore.id,exactReturn.id,exactSale.id,resultV27.id]);
    const singleNegativeLink=await tone(`insert into mc.operation_links(business_id,store_id,from_operation_version_id,to_operation_version_id,
        link_type,status,method_version_id,evidence) values($1,$2,$3,$4,'return_to_original_sale','confirmed',$5,'{}') returning id`,
      [business.id,affectedStore.id,negativeReturn.id,negativeSale.id,resultV27.id]);
    const singleRequest=await tone(`insert into mc.calculation_requests(
        business_id,store_id,generation_no,selection_id,method_version_id,period_start,period_end,input_fingerprint,is_latest
      ) values($1,$2,54,$3,$4,'2026-05-11','2026-05-17','single-count-return-v27-fixture',false) returning id`,
      [business.id,affectedStore.id,returnSelection.id,resultV27.id]);
    await tq(`insert into mc.calculation_request_products(business_id,store_id,request_id,product_id) values($1,$2,$3,$4)`,
      [business.id,affectedStore.id,singleRequest.id,returnProduct.id]);
    await tq(`insert into mc.calculation_request_inputs(business_id,store_id,request_id,report_normalization_id) values($1,$2,$3,$4)`,
      [business.id,affectedStore.id,singleRequest.id,returnNormalization.id]);
    for(const link of [singlePositiveLink,singleNegativeLink])await tq(`insert into mc.calculation_request_inputs(
        business_id,store_id,request_id,operation_link_id) values($1,$2,$3,$4)`,
      [business.id,affectedStore.id,singleRequest.id,link.id]);
    const singleRun=await tone(`insert into mc.calculation_runs(
        business_id,store_id,selection_id,method_version_id,period_start,period_end,input_fingerprint,request_id,attempt_no
      ) values($1,$2,$3,$4,'2026-05-11','2026-05-17','single-count-return-v27-fixture',$5,1) returning id`,
      [business.id,affectedStore.id,returnSelection.id,resultV27.id,singleRequest.id]);
    const singlePeriod=await tone(`insert into mc.financial_period_results(
        business_id,store_id,run_id,period_start,period_end,quality,missing_reasons,totals
      ) values($1,$2,$3,'2026-05-11','2026-05-17','partial','["operation_unclassified"]',
        '{"selectedProductsResultBeforeTax":"0.0000","storeLevelResultBeforeTax":"0.0000","availableResultBeforeTax":"0.0000","estimatedUsnTax":"0.0000","availableResultAfterTax":null,"netProfit":null}') returning id`,
      [business.id,affectedStore.id,singleRun.id]);
    await tq(`insert into mc.calculation_inputs(business_id,store_id,run_id,report_normalization_id) values($1,$2,$3,$4)`,
      [business.id,affectedStore.id,singleRun.id,returnNormalization.id]);
    for(const link of [singlePositiveLink,singleNegativeLink])await tq(`insert into mc.calculation_inputs(
        business_id,store_id,run_id,operation_link_id) values($1,$2,$3,$4)`,
      [business.id,affectedStore.id,singleRun.id,link.id]);
    const singleReversalLine=await tone(`insert into mc.result_lines(
        business_id,store_id,run_id,product_id,variant_id,accounting_date,category_code,amount_signed,quality,result_scope,financial_period_result_id
      ) values($1,$2,$3,$4,$5,'2026-05-12','return_wb_expense_reversal',306.60,'complete','selected_product',$6) returning id`,
      [business.id,affectedStore.id,singleRun.id,returnProduct.id,returnVariant.id,singlePeriod.id]);
    await tq(`insert into mc.result_evidence(
        business_id,store_id,result_line_id,report_row_id,source_operation_version_id,operation_link_id,contribution_amount
      ) values($1,$2,$3,$4,$5,$6,311.33)`,
      [business.id,affectedStore.id,singleReversalLine.id,exactReturn.report_row_id,exactReturn.id,singlePositiveLink.id]);
    await tq(`insert into mc.result_evidence(
        business_id,store_id,result_line_id,report_row_id,source_operation_version_id,operation_link_id,contribution_amount
      ) values($1,$2,$3,$4,$5,$6,-4.73)`,
      [business.id,affectedStore.id,singleReversalLine.id,negativeReturn.report_row_id,negativeReturn.id,singleNegativeLink.id]);
    const prohibitedAcquiringLine=await tone(`insert into mc.result_lines(
        business_id,store_id,run_id,product_id,variant_id,accounting_date,category_code,amount_signed,quality,result_scope,financial_period_result_id
      ) values($1,$2,$3,$4,$5,'2026-05-12','acquiring',31.33,'complete','selected_product',$6) returning id`,
      [business.id,affectedStore.id,singleRun.id,returnProduct.id,returnVariant.id,singlePeriod.id]);
    await assert.rejects(()=>tq(`insert into mc.result_evidence(
        business_id,store_id,result_line_id,financial_component_id,contribution_amount
      ) values($1,$2,$3,$4,31.33)`,[business.id,affectedStore.id,prohibitedAcquiringLine.id,acquiringComponent.id]),
      /linked return individual expense component/);
    assert.equal((await tone(`select count(*)::int n from mc.financial_input_events
      where event_key='financial-result-upgrade:v28:store:'||$1 and source_result_method_version_id=$2`,[affectedStore.id,resultV28.id])).n,1);
    assert.equal((await tone(`select count(*)::int n from mc.financial_input_events
      where event_key='financial-result-upgrade:v28:store:'||$1`,[noPointerStore.id])).n,0);
    assert.equal((await tone(`select count(*)::int n from mc.financial_input_events
      where event_key='financial-result-upgrade:v28:store:'||$1`,[archivedStore.id])).n,0);
    assert.equal((await tone(`select reason from mc.calculation_invalidations where store_id=$1`,[affectedStore.id])).reason,
      'single_count_return_expense_reversal_v27');
    assert.equal((await tone(`select max(version)::int version from mc.schema_migrations`)).version,54);
    const singleEvidenceGuard=(await tone(`select pg_get_functiondef('mc.guard_evidence_source()'::regprocedure) definition`)).definition;
    assert.match(singleEvidenceGuard,/financial-result-v27/);
    assert.match(singleEvidenceGuard,/linked return individual expense component/);
    const singleDailyGuard=(await tone(`select pg_get_functiondef('mc.guard_daily_return_expense_evidence()'::regprocedure) definition`)).definition;
    assert.match(singleDailyGuard,/financial-result-v28/);
    assert.match(singleDailyGuard,/linked daily return individual expense component/);
    pass('migration 54 single-counts all four exact linked return fields and backfills only selected active stores');

    await tq(`select set_config('app.user_id','',false),set_config('app.business_id','',false)`);
    await transportUpgradeDb.exec(await readFile(path.join(root,'db/migrations/055_exact_wb_row_result.sql'),'utf8'));
    await tq(`select set_config('app.user_id',$1,false),set_config('app.business_id',$2,false)`,[owner.id,business.id]);
    assert.deepEqual(await tq(`select code,version_no,implementation_version from mc.method_versions
      where (code='wb_finance_import' and version_no=13) or (code='financial_result' and version_no in(29,30))
      order by code,version_no`),[
      {code:'financial_result',version_no:29,implementation_version:'financial-result-v29'},
      {code:'financial_result',version_no:30,implementation_version:'financial-result-v30'},
      {code:'wb_finance_import',version_no:13,implementation_version:'wb-finance-v13'}
    ]);
    assert.equal((await tone(`select count(*)::int n from mc.jobs where store_id=$1
      and job_type='financial_report_fetch' and deduplication_key like '%:wb-finance-v13'`,[affectedStore.id])).n,1);
    assert.equal((await tone(`select count(*)::int n from mc.jobs where store_id=$1
      and job_type='financial_report_fetch' and deduplication_key like '%:wb-finance-v13'`,[archivedStore.id])).n,0);
    assert.equal((await tone(`select fetch_status from mc.financial_week_inventory where store_id=$1`,[affectedStore.id])).fetch_status,'pending');
    assert.equal((await tone(`select max(version)::int version from mc.schema_migrations`)).version,55);
    const exactEvidenceGuard=(await tone(`select pg_get_functiondef('mc.guard_evidence_source()'::regprocedure) definition`)).definition;
    assert.match(exactEvidenceGuard,/wb_row_rounding_adjustment/);
    assert.match(exactEvidenceGuard,/round\(source_amount, 4\)|round\(source_amount,4\)/);
    const exactDailyGuard=(await tone(`select pg_get_functiondef('mc.guard_daily_return_expense_evidence()'::regprocedure) definition`)).definition;
    assert.match(exactDailyGuard,/daily WB row rounding evidence is invalid/);
    assert.match(await readFile(path.join(root,'db/migrations/055_exact_wb_row_result.sql'),'utf8'),
      /coverage\.credential_generation=connection\.credential_generation/);
    const cutoverRecovery=await readFile(path.join(root,'db/migrations/056_exact_wb_cutover_recovery.sql'),'utf8');
    assert.match(cutoverRecovery,/financial-result-upgrade:v30:store:/);
    assert.match(cutoverRecovery,/normalization_method\.implementation_version='wb-finance-v13'/);
    assert.match(cutoverRecovery,/current_method\.version_no<30/);
    const parserV13=await tone(`select id from mc.method_versions where code='wb_finance_import' and version_no=13`);
    const resultV29=await tone(`select id from mc.method_versions where code='financial_result' and version_no=29`);
    const exactDocument=await tone(`insert into mc.source_documents(business_id,store_id,origin,document_type,checksum,completeness)
      values($1,$2,'wb_api','weekly_realization','exact-row-document','complete') returning id`,[business.id,affectedStore.id]);
    const exactReport=await tone(`insert into mc.reports(business_id,store_id,external_report_id,period_start,period_end)
      values($1,$2,'exact-row-report','2026-09-21','2026-09-27') returning id`,[business.id,affectedStore.id]);
    const exactVersion=await tone(`insert into mc.report_versions(business_id,store_id,report_id,document_id,version_no,checksum,parser_version)
      values($1,$2,$3,$4,1,'exact-row-version','wb-finance-v13') returning id`,[business.id,affectedStore.id,exactReport.id,exactDocument.id]);
    const exactNormalization=await tone(`insert into mc.report_normalizations(
      business_id,store_id,report_version_id,method_version_id,normalization_key,status)
      values($1,$2,$3,$4,'exact-row-normalization','succeeded') returning id`,[business.id,affectedStore.id,exactVersion.id,parserV13.id]);
    const exactRow=await tone(`insert into mc.report_rows(business_id,store_id,report_version_id,external_row_key,row_number,raw_data,row_checksum)
      values($1,$2,$3,'3135408992540',1,$4::jsonb,'exact-row-checksum') returning id`,[business.id,affectedStore.id,exactVersion.id,
      JSON.stringify({rrdId:'3135408992540',retailAmount:'500',vw:'56.5360655737704918',vwNds:'12.108',forPay:'431.36'})]);
    const exactOperationIdentity=await tone(`insert into mc.operations(business_id,store_id,source_code,source_operation_key)
      values($1,$2,'wb_finance','exact-row-sale') returning id`,[business.id,affectedStore.id]);
    const exactOperation=await tone(`insert into mc.operation_versions(business_id,store_id,operation_id,report_row_id,version_no,
      operation_type,product_id,variant_id,accounting_date,quantity,report_normalization_id)
      values($1,$2,$3,$4,1,'sale',$5,$6,'2026-09-21',1,$7) returning id`,
      [business.id,affectedStore.id,exactOperationIdentity.id,exactRow.id,returnProduct.id,returnVariant.id,exactNormalization.id]);
    for(const [key,category,amount,field,scope] of [
      ['retailAmount','revenue','500','retailAmount','selected_product'],
      ['vw','wb_reward_without_vat','-56.5360655737704918','vw','selected_product'],
      ['vwNds','wb_reward_vat','-12.108','vwNds','selected_product'],
      ['forPay','payout','431.36','forPay','reconciliation']
    ])await tq(`insert into mc.financial_components(business_id,store_id,operation_version_id,component_key,category_code,
      amount_signed,method_version_id,source_field,result_scope_classification) values($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [business.id,affectedStore.id,exactOperation.id,key,category,amount,parserV13.id,field,scope]);
    assert.equal((await tone(`select mc.expected_wb_row_rounding_adjustment($1,$2,null)::text value`,
      [exactOperation.id,resultV29.id])).value,'0.0041');
    const exactRow2=await tone(`insert into mc.report_rows(business_id,store_id,report_version_id,external_row_key,row_number,raw_data,row_checksum)
      values($1,$2,$3,'3135408992541',2,$4::jsonb,'exact-row-checksum-2') returning id`,[business.id,affectedStore.id,exactVersion.id,
      JSON.stringify({rrdId:'3135408992541',retailAmount:'500',vw:'56.5360655737704918',vwNds:'12.108',forPay:'431.36'})]);
    const exactOperationIdentity2=await tone(`insert into mc.operations(business_id,store_id,source_code,source_operation_key)
      values($1,$2,'wb_finance','exact-row-sale-2') returning id`,[business.id,affectedStore.id]);
    const exactOperation2=await tone(`insert into mc.operation_versions(business_id,store_id,operation_id,report_row_id,version_no,
      operation_type,product_id,variant_id,accounting_date,quantity,report_normalization_id)
      values($1,$2,$3,$4,1,'sale',$5,$6,'2026-09-21',1,$7) returning id`,
      [business.id,affectedStore.id,exactOperationIdentity2.id,exactRow2.id,returnProduct.id,returnVariant.id,exactNormalization.id]);
    for(const [key,category,amount,field,scope] of [
      ['retailAmount','revenue','500','retailAmount','selected_product'],
      ['vw','wb_reward_without_vat','-56.5360655737704918','vw','selected_product'],
      ['vwNds','wb_reward_vat','-12.108','vwNds','selected_product'],
      ['forPay','payout','431.36','forPay','reconciliation']
    ])await tq(`insert into mc.financial_components(business_id,store_id,operation_version_id,component_key,category_code,
      amount_signed,method_version_id,source_field,result_scope_classification) values($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [business.id,affectedStore.id,exactOperation2.id,key,category,amount,parserV13.id,field,scope]);
    const exactRequest=await tone(`insert into mc.calculation_requests(business_id,store_id,generation_no,selection_id,method_version_id,
      period_start,period_end,input_fingerprint,is_latest) values($1,$2,55,$3,$4,'2026-09-21','2026-09-27','exact-row-v29-fixture',false) returning id`,
      [business.id,affectedStore.id,returnSelection.id,resultV29.id]);
    await tq(`insert into mc.calculation_request_products(business_id,store_id,request_id,product_id) values($1,$2,$3,$4)`,
      [business.id,affectedStore.id,exactRequest.id,returnProduct.id]);
    await tq(`insert into mc.calculation_request_inputs(business_id,store_id,request_id,report_normalization_id) values($1,$2,$3,$4)`,
      [business.id,affectedStore.id,exactRequest.id,exactNormalization.id]);
    const exactRun=await tone(`insert into mc.calculation_runs(business_id,store_id,selection_id,method_version_id,period_start,period_end,
      input_fingerprint,request_id,attempt_no) values($1,$2,$3,$4,'2026-09-21','2026-09-27','exact-row-v29-fixture',$5,1) returning id`,
      [business.id,affectedStore.id,returnSelection.id,resultV29.id,exactRequest.id]);
    const exactPeriod=await tone(`insert into mc.financial_period_results(business_id,store_id,run_id,period_start,period_end,quality,missing_reasons,totals)
      values($1,$2,$3,'2026-09-21','2026-09-27','complete','[]','{"selectedProductsResultBeforeTax":"0.0082","storeLevelResultBeforeTax":"0.0000","availableResultBeforeTax":"0.0082","estimatedUsnTax":"0.0000","availableResultAfterTax":"0.0082","netProfit":"0.0082"}') returning id`,
      [business.id,affectedStore.id,exactRun.id]);
    await tq(`insert into mc.calculation_inputs(business_id,store_id,run_id,report_normalization_id) values($1,$2,$3,$4)`,
      [business.id,affectedStore.id,exactRun.id,exactNormalization.id]);
    const aggregateAdjustmentLine=await tone(`insert into mc.result_lines(business_id,store_id,run_id,product_id,variant_id,accounting_date,
      category_code,amount_signed,quality,result_scope,financial_period_result_id) values($1,$2,$3,$4,$5,'2026-09-21',
      'wb_row_rounding_adjustment',0.0082,'complete','selected_product',$6) returning id`,
      [business.id,affectedStore.id,exactRun.id,returnProduct.id,returnVariant.id,exactPeriod.id]);
    for(const [operation,row] of [[exactOperation,exactRow],[exactOperation2,exactRow2]])await tq(`insert into mc.result_evidence(
      business_id,store_id,result_line_id,report_row_id,source_operation_version_id,contribution_amount)
      values($1,$2,$3,$4,$5,0.0041)`,[business.id,affectedStore.id,aggregateAdjustmentLine.id,row.id,operation.id]);
    await assert.rejects(()=>tq(`insert into mc.result_evidence(business_id,store_id,result_line_id,report_row_id,
      source_operation_version_id,contribution_amount) values($1,$2,$3,$4,$5,0.0040)`,
      [business.id,affectedStore.id,aggregateAdjustmentLine.id,exactRow.id,exactOperation.id]),/WB row rounding evidence is invalid/);
    const returnSaleRow=await tone(`insert into mc.report_rows(business_id,store_id,report_version_id,external_row_key,row_number,raw_data,row_checksum)
      values($1,$2,$3,'3135408992600',3,$4::jsonb,'exact-return-sale-row') returning id`,[business.id,affectedStore.id,exactVersion.id,
      JSON.stringify({rrdId:'3135408992600',shkId:'9001',orderDt:'2026-09-20T10:00:00Z',retailAmount:'642',forPay:'642'})]);
    const returnRow=await tone(`insert into mc.report_rows(business_id,store_id,report_version_id,external_row_key,row_number,raw_data,row_checksum)
      values($1,$2,$3,'3135408992601',4,$4::jsonb,'exact-return-row') returning id`,[business.id,affectedStore.id,exactVersion.id,
      JSON.stringify({rrdId:'3135408992601',shkId:'9001',orderDt:'2026-09-20T10:00:00Z',retailAmount:'642',forPay:'330.67',
        acquiringFee:'31.33',vw:'208.8475409836065574',vwNds:'45.95',ppvzReward:'25.206'})]);
    const returnSaleIdentity=await tone(`insert into mc.operations(business_id,store_id,source_code,source_operation_key)
      values($1,$2,'wb_finance','exact-return-sale') returning id`,[business.id,affectedStore.id]);
    const returnIdentity=await tone(`insert into mc.operations(business_id,store_id,source_code,source_operation_key)
      values($1,$2,'wb_finance','exact-return') returning id`,[business.id,affectedStore.id]);
    const returnSale=await tone(`insert into mc.operation_versions(business_id,store_id,operation_id,report_row_id,version_no,srid,operation_type,
      product_id,variant_id,accounting_date,quantity,report_normalization_id) values($1,$2,$3,$4,1,'exact-return-srid','sale',$5,$6,'2026-09-21',1,$7) returning id`,
      [business.id,affectedStore.id,returnSaleIdentity.id,returnSaleRow.id,returnProduct.id,returnVariant.id,exactNormalization.id]);
    const exactReturnV13=await tone(`insert into mc.operation_versions(business_id,store_id,operation_id,report_row_id,version_no,srid,operation_type,
      product_id,variant_id,accounting_date,quantity,report_normalization_id) values($1,$2,$3,$4,1,'exact-return-srid','return',$5,$6,'2026-09-22',-1,$7) returning id`,
      [business.id,affectedStore.id,returnIdentity.id,returnRow.id,returnProduct.id,returnVariant.id,exactNormalization.id]);
    for(const [key,category,amount,field,scope] of [
      ['retailAmount','revenue_return','-642','retailAmount','selected_product'],['forPay','payout','-330.67','forPay','reconciliation'],
      ['acquiringFee','acquiring','31.33','acquiringFee','selected_product'],['vw','wb_reward_without_vat','-208.8475409836065574','vw','selected_product'],
      ['vwNds','wb_reward_vat','-45.95','vwNds','selected_product'],['ppvzReward','pickup_reward','-25.206','ppvzReward','selected_product']
    ])await tq(`insert into mc.financial_components(business_id,store_id,operation_version_id,component_key,category_code,
      amount_signed,method_version_id,source_field,result_scope_classification) values($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [business.id,affectedStore.id,exactReturnV13.id,key,category,amount,parserV13.id,field,scope]);
    const exactReturnLink=await tone(`insert into mc.operation_links(business_id,store_id,from_operation_version_id,to_operation_version_id,
      link_type,status,method_version_id,evidence) values($1,$2,$3,$4,'return_to_original_sale','confirmed',$5,'{}') returning id`,
      [business.id,affectedStore.id,exactReturnV13.id,returnSale.id,resultV29.id]);
    const returnRequestV29=await tone(`insert into mc.calculation_requests(business_id,store_id,generation_no,selection_id,method_version_id,
      period_start,period_end,input_fingerprint,is_latest) values($1,$2,56,$3,$4,'2026-09-21','2026-09-27','exact-return-v29-fixture',false) returning id`,
      [business.id,affectedStore.id,returnSelection.id,resultV29.id]);
    await tq(`insert into mc.calculation_request_products(business_id,store_id,request_id,product_id) values($1,$2,$3,$4)`,
      [business.id,affectedStore.id,returnRequestV29.id,returnProduct.id]);
    await tq(`insert into mc.calculation_request_inputs(business_id,store_id,request_id,report_normalization_id) values($1,$2,$3,$4)`,
      [business.id,affectedStore.id,returnRequestV29.id,exactNormalization.id]);
    await tq(`insert into mc.calculation_request_inputs(business_id,store_id,request_id,operation_link_id) values($1,$2,$3,$4)`,
      [business.id,affectedStore.id,returnRequestV29.id,exactReturnLink.id]);
    const returnRunV29=await tone(`insert into mc.calculation_runs(business_id,store_id,selection_id,method_version_id,period_start,period_end,
      input_fingerprint,request_id,attempt_no) values($1,$2,$3,$4,'2026-09-21','2026-09-27','exact-return-v29-fixture',$5,1) returning id`,
      [business.id,affectedStore.id,returnSelection.id,resultV29.id,returnRequestV29.id]);
    const returnPeriodV29=await tone(`insert into mc.financial_period_results(business_id,store_id,run_id,period_start,period_end,quality,missing_reasons,totals)
      values($1,$2,$3,'2026-09-21','2026-09-27','complete','[]','{"selectedProductsResultBeforeTax":"-330.6700","storeLevelResultBeforeTax":"0.0000","availableResultBeforeTax":"-330.6700","estimatedUsnTax":"0.0000","availableResultAfterTax":"-330.6700","netProfit":"-330.6700"}') returning id`,
      [business.id,affectedStore.id,returnRunV29.id]);
    await tq(`insert into mc.calculation_inputs(business_id,store_id,run_id,report_normalization_id) values($1,$2,$3,$4)`,
      [business.id,affectedStore.id,returnRunV29.id,exactNormalization.id]);
    await tq(`insert into mc.calculation_inputs(business_id,store_id,run_id,operation_link_id) values($1,$2,$3,$4)`,
      [business.id,affectedStore.id,returnRunV29.id,exactReturnLink.id]);
    assert.equal((await tone(`select mc.expected_wb_row_rounding_adjustment($1,$2,$3)::text value`,
      [exactReturnV13.id,resultV29.id,exactReturnLink.id])).value,'-0.0035');
    assert.equal((await tone(`select mc.expected_wb_row_rounding_adjustment($1,$2,null)::text value`,
      [exactReturnV13.id,resultV29.id])).value,null);
    const exactReversalLine=await tone(`insert into mc.result_lines(business_id,store_id,run_id,product_id,variant_id,accounting_date,category_code,
      amount_signed,quality,result_scope,financial_period_result_id) values($1,$2,$3,$4,$5,'2026-09-22','return_wb_expense_reversal',
      311.3335,'complete','selected_product',$6) returning id`,[business.id,affectedStore.id,returnRunV29.id,returnProduct.id,returnVariant.id,returnPeriodV29.id]);
    await tq(`insert into mc.result_evidence(business_id,store_id,result_line_id,report_row_id,source_operation_version_id,operation_link_id,
      contribution_amount) values($1,$2,$3,$4,$5,$6,311.3335)`,
      [business.id,affectedStore.id,exactReversalLine.id,returnRow.id,exactReturnV13.id,exactReturnLink.id]);
    const returnAdjustmentLine=await tone(`insert into mc.result_lines(business_id,store_id,run_id,product_id,variant_id,accounting_date,category_code,
      amount_signed,quality,result_scope,financial_period_result_id) values($1,$2,$3,$4,$5,'2026-09-22','wb_row_rounding_adjustment',
      -0.0035,'complete','selected_product',$6) returning id`,[business.id,affectedStore.id,returnRunV29.id,returnProduct.id,returnVariant.id,returnPeriodV29.id]);
    await tq(`insert into mc.result_evidence(business_id,store_id,result_line_id,report_row_id,source_operation_version_id,operation_link_id,
      contribution_amount) values($1,$2,$3,$4,$5,$6,-0.0035)`,
      [business.id,affectedStore.id,returnAdjustmentLine.id,returnRow.id,exactReturnV13.id,exactReturnLink.id]);
    pass('migration 55 preserves exact WB precision and refetches accepted reports newest-first before v30 cutover');

    await tq(`insert into mc.report_normalizations(business_id,store_id,report_version_id,method_version_id,normalization_key,status)
      select report.business_id,report.store_id,version.id,$3,'cutover-ready-v13:'||version.id,'succeeded'
        from mc.reports report join mc.report_versions version on version.id=report.current_version_id
       where report.business_id=$1 and report.store_id=$2 and version.status='accepted'
      on conflict(report_version_id,method_version_id) do nothing`,[business.id,affectedStore.id,parserV13.id]);
    const resultV30=await tone(`select id from mc.method_versions where code='financial_result' and version_no=30`);
    await tq(`select id from mc.emit_financial_input_event($1,$2,'result_method_updated','2026-05-12','2026-05-12',
      p_source_result_method_version_id=>$3)`,[affectedStore.id,`financial-result-upgrade:v30:store:${affectedStore.id}`,resultV30.id]);
    const cutoverPreconditions=await tone(`select method.version_no current_method_version,
      (select count(*)::int from mc.reports report join mc.report_versions version on version.id=report.current_version_id
        where report.store_id=$1 and version.status='accepted' and not exists(
          select 1 from mc.report_normalizations normalization join mc.method_versions parser on parser.id=normalization.method_version_id
           where normalization.report_version_id=version.id and normalization.status='succeeded' and parser.implementation_version='wb-finance-v13')) missing_v13,
      exists(select 1 from mc.product_selections selection where selection.store_id=$1 and selection.status='confirmed') selection_ready
      from mc.financial_daily_current_publications pointer join mc.financial_daily_publications publication on publication.id=pointer.publication_id
      join mc.financial_daily_generations generation on generation.id=publication.generation_id
      join mc.method_versions method on method.id=generation.result_method_version_id where pointer.store_id=$1`,[affectedStore.id]);
    assert.deepEqual(cutoverPreconditions,{current_method_version:20,missing_v13:0,selection_ready:true});
    const cutoverReadyCount=await tone(`select count(distinct store.id)::int n from mc.stores store
      join mc.financial_daily_current_publications pointer on pointer.business_id=store.business_id and pointer.store_id=store.id
      join mc.financial_daily_publications publication on publication.id=pointer.publication_id
      join mc.financial_daily_generations generation on generation.id=publication.generation_id
      join mc.method_versions current_method on current_method.id=generation.result_method_version_id
      left join mc.financial_daily_publication_days day on day.publication_id=publication.id
      join mc.reports report on report.business_id=store.business_id and report.store_id=store.id
      join mc.report_versions version on version.id=report.current_version_id and version.status='accepted'
      join mc.method_versions parser on parser.code='wb_finance_import' and parser.implementation_version='wb-finance-v13'
      join mc.method_versions result on result.code='financial_result' and result.implementation_version='financial-result-v30'
      where store.id=$1 and store.status='active' and current_method.version_no<30
        and not exists(select 1 from mc.reports pending_report join mc.report_versions pending_version on pending_version.id=pending_report.current_version_id
          where pending_report.store_id=store.id and pending_version.status='accepted' and not exists(
            select 1 from mc.report_normalizations normalization join mc.method_versions normalization_method on normalization_method.id=normalization.method_version_id
            where normalization.report_version_id=pending_version.id and normalization.status='succeeded'
              and normalization_method.implementation_version='wb-finance-v13'))`,[affectedStore.id]);
    assert.equal(cutoverReadyCount.n,1);
    await tq(`select set_config('app.user_id','',false),set_config('app.business_id','',false)`);
    await transportUpgradeDb.exec(await readFile(path.join(root,'db/migrations/056_exact_wb_cutover_recovery.sql'),'utf8'));
    await tq(`select set_config('app.user_id',$1,false),set_config('app.business_id',$2,false)`,[owner.id,business.id]);
    const repairedCutover=await tone(`select affected_from::text,affected_to::text,allows_wb_api from mc.financial_input_events
      where event_key='financial-result-upgrade:v30:cutover-repair:v1:store:'||$1`,[affectedStore.id]);
    const v30CutoverEvents=await tq(`select event_key,affected_from::text,affected_to::text from mc.financial_input_events
      where store_id=$1 and event_key like 'financial-result-upgrade:v30:%' order by event_key`,[affectedStore.id]);
    const expectedCutover=await tone(`select least((select min(day.accounting_date) from mc.financial_daily_current_publications pointer
        join mc.financial_daily_publication_days day on day.publication_id=pointer.publication_id where pointer.store_id=$1),
        (select min(report.period_start) from mc.reports report join mc.report_versions version on version.id=report.current_version_id
          where report.store_id=$1 and version.status='accepted'))::text affected_from,
      greatest((select max(day.accounting_date) from mc.financial_daily_current_publications pointer
        join mc.financial_daily_publication_days day on day.publication_id=pointer.publication_id where pointer.store_id=$1),
        (select max(report.period_end) from mc.reports report join mc.report_versions version on version.id=report.current_version_id
          where report.store_id=$1 and version.status='accepted'))::text affected_to`,[affectedStore.id]);
    assert.deepEqual(repairedCutover,{...expectedCutover,allows_wb_api:false},JSON.stringify(v30CutoverEvents));
    assert.equal((await tone(`select reason from mc.calculation_invalidations where store_id=$1`,[affectedStore.id])).reason,
      'exact_wb_row_result_v30');
    assert.equal((await tone(`select max(version)::int version from mc.schema_migrations`)).version,56);
    pass('migration 56 repairs a narrow v30 cutover with one full-range local successor');

    await tq(`update mc.report_versions set status='validated' where id=$1`,[exactVersion.id]);
    await tq(`update mc.report_versions set status='accepted',accepted_at=clock_timestamp() where id=$1`,[exactVersion.id]);
    await tq(`update mc.reports set current_version_id=$1 where id=$2`,[exactVersion.id,exactReport.id]);
    const exactComponent=await tone(`select id from mc.financial_components
      where operation_version_id=$1 and source_field='vw'`,[exactOperation.id]);
    const finishRequest=await tone(`insert into mc.calculation_requests(business_id,store_id,generation_no,selection_id,method_version_id,
      period_start,period_end,input_fingerprint,is_latest) values($1,$2,57,$3,$4,'2026-09-21','2026-09-27','exact-finish-v29-fixture',false) returning id`,
      [business.id,affectedStore.id,returnSelection.id,resultV29.id]);
    await tq(`insert into mc.calculation_request_products(business_id,store_id,request_id,product_id) values($1,$2,$3,$4)`,
      [business.id,affectedStore.id,finishRequest.id,returnProduct.id]);
    await tq(`insert into mc.calculation_request_inputs(business_id,store_id,request_id,report_normalization_id) values($1,$2,$3,$4)`,
      [business.id,affectedStore.id,finishRequest.id,exactNormalization.id]);
    await tq(`insert into mc.calculation_request_inputs(business_id,store_id,request_id,report_version_id) values($1,$2,$3,$4)`,
      [business.id,affectedStore.id,finishRequest.id,exactVersion.id]);
    const finishRun=await tone(`insert into mc.calculation_runs(business_id,store_id,selection_id,method_version_id,period_start,period_end,
      input_fingerprint,request_id,attempt_no) values($1,$2,$3,$4,'2026-09-21','2026-09-27','exact-finish-v29-fixture',$5,1) returning id`,
      [business.id,affectedStore.id,returnSelection.id,resultV29.id,finishRequest.id]);
    const finishPeriod=await tone(`insert into mc.financial_period_results(business_id,store_id,run_id,period_start,period_end,quality,missing_reasons,totals)
      values($1,$2,$3,'2026-09-21','2026-09-27','partial','["operation_unclassified"]',
      '{"selectedProductsResultBeforeTax":"-56.5361","storeLevelResultBeforeTax":"0.0000","availableResultBeforeTax":"-56.5361","estimatedUsnTax":"0.0000","availableResultAfterTax":null,"netProfit":null}') returning id`,
      [business.id,affectedStore.id,finishRun.id]);
    await tq(`insert into mc.calculation_inputs(business_id,store_id,run_id,report_normalization_id) values($1,$2,$3,$4)`,
      [business.id,affectedStore.id,finishRun.id,exactNormalization.id]);
    await tq(`insert into mc.calculation_inputs(business_id,store_id,run_id,report_version_id) values($1,$2,$3,$4)`,
      [business.id,affectedStore.id,finishRun.id,exactVersion.id]);
    const finishLine=await tone(`insert into mc.result_lines(business_id,store_id,run_id,product_id,variant_id,accounting_date,category_code,
      amount_signed,quality,result_scope,financial_period_result_id) values($1,$2,$3,$4,$5,'2026-09-21','wb_reward_without_vat',
      -56.5361,'partial','selected_product',$6) returning id`,
      [business.id,affectedStore.id,finishRun.id,returnProduct.id,returnVariant.id,finishPeriod.id]);
    await tq(`insert into mc.result_evidence(business_id,store_id,result_line_id,financial_component_id,contribution_amount)
      values($1,$2,$3,$4,-56.5361)`,[business.id,affectedStore.id,finishLine.id,exactComponent.id]);
    await tq(`create temporary table exact_finish_guard_probe(
      id uuid primary key,status text not null,quality text,missing_reasons jsonb,finished_at timestamptz,
      request_id uuid,method_version_id uuid not null)`);
    await tq(`create trigger exact_finish_guard_probe_trigger before update on exact_finish_guard_probe
      for each row execute function mc.guard_run_finish()`);
    await tq(`insert into exact_finish_guard_probe(id,status,quality,missing_reasons,request_id,method_version_id)
      values($1,'running',null,'[]',$2,$3)`,[finishRun.id,finishRequest.id,resultV29.id]);
    await assert.rejects(()=>tq(`update exact_finish_guard_probe set status='succeeded',quality='partial',
      missing_reasons='["operation_unclassified"]',finished_at=clock_timestamp() where id=$1`,[finishRun.id]),
      /source amount counted more than once/);
    await tq(`select set_config('app.user_id','',false),set_config('app.business_id','',false)`);
    await transportUpgradeDb.exec(await readFile(path.join(root,'db/migrations/057_exact_wb_evidence_finish_guard.sql'),'utf8'));
    await tq(`select set_config('app.user_id',$1,false),set_config('app.business_id',$2,false)`,[owner.id,business.id]);
    await tq(`update exact_finish_guard_probe set status='succeeded',quality='partial',
      missing_reasons='["operation_unclassified"]',finished_at=clock_timestamp() where id=$1`,[finishRun.id]);
    const exactFinishGuard=(await tone(`select pg_get_functiondef('mc.guard_run_finish()'::regprocedure) definition`)).definition;
    assert.match(exactFinishGuard,/financial-result-v29/);
    assert.match(exactFinishGuard,/abs\(round\(f\.amount_signed,\s*4\)\)/);
    assert.equal((await tone(`select max(version)::int version from mc.schema_migrations`)).version,57);
    pass('migration 57 accepts exact-source four-decimal evidence without weakening legacy source limits');

    const rowFinishRequest=await tone(`insert into mc.calculation_requests(business_id,store_id,generation_no,selection_id,method_version_id,
      period_start,period_end,input_fingerprint,is_latest) values($1,$2,58,$3,$4,'2026-09-21','2026-09-27','exact-row-finish-v29-fixture',false) returning id`,
      [business.id,affectedStore.id,returnSelection.id,resultV29.id]);
    await tq(`insert into mc.calculation_request_products(business_id,store_id,request_id,product_id) values($1,$2,$3,$4)`,
      [business.id,affectedStore.id,rowFinishRequest.id,returnProduct.id]);
    await tq(`insert into mc.calculation_request_inputs(business_id,store_id,request_id,report_normalization_id) values($1,$2,$3,$4)`,
      [business.id,affectedStore.id,rowFinishRequest.id,exactNormalization.id]);
    await tq(`insert into mc.calculation_request_inputs(business_id,store_id,request_id,report_version_id) values($1,$2,$3,$4)`,
      [business.id,affectedStore.id,rowFinishRequest.id,exactVersion.id]);
    const rowFinishRun=await tone(`insert into mc.calculation_runs(business_id,store_id,selection_id,method_version_id,period_start,period_end,
      input_fingerprint,request_id,attempt_no) values($1,$2,$3,$4,'2026-09-21','2026-09-27','exact-row-finish-v29-fixture',$5,1) returning id`,
      [business.id,affectedStore.id,returnSelection.id,resultV29.id,rowFinishRequest.id]);
    const rowFinishPeriod=await tone(`insert into mc.financial_period_results(business_id,store_id,run_id,period_start,period_end,quality,missing_reasons,totals)
      values($1,$2,$3,'2026-09-21','2026-09-27','partial','["operation_unclassified"]',
      '{"selectedProductsResultBeforeTax":"0.0041","storeLevelResultBeforeTax":"0.0000","availableResultBeforeTax":"0.0041","estimatedUsnTax":"0.0000","availableResultAfterTax":null,"netProfit":null}') returning id`,
      [business.id,affectedStore.id,rowFinishRun.id]);
    await tq(`insert into mc.calculation_inputs(business_id,store_id,run_id,report_normalization_id) values($1,$2,$3,$4)`,
      [business.id,affectedStore.id,rowFinishRun.id,exactNormalization.id]);
    await tq(`insert into mc.calculation_inputs(business_id,store_id,run_id,report_version_id) values($1,$2,$3,$4)`,
      [business.id,affectedStore.id,rowFinishRun.id,exactVersion.id]);
    const rowFinishLine=await tone(`insert into mc.result_lines(business_id,store_id,run_id,product_id,variant_id,accounting_date,category_code,
      amount_signed,quality,result_scope,financial_period_result_id) values($1,$2,$3,$4,$5,'2026-09-21','wb_row_rounding_adjustment',
      0.0041,'partial','selected_product',$6) returning id`,
      [business.id,affectedStore.id,rowFinishRun.id,returnProduct.id,returnVariant.id,rowFinishPeriod.id]);
    await tq(`insert into mc.result_evidence(business_id,store_id,result_line_id,report_row_id,source_operation_version_id,contribution_amount)
      values($1,$2,$3,$4,$5,0.0041)`,[business.id,affectedStore.id,rowFinishLine.id,exactRow.id,exactOperation.id]);
    await tq(`create temporary table exact_row_finish_guard_probe(
      id uuid primary key,status text not null,quality text,missing_reasons jsonb,finished_at timestamptz,
      request_id uuid,method_version_id uuid not null)`);
    await tq(`create trigger exact_row_finish_guard_probe_trigger before update on exact_row_finish_guard_probe
      for each row execute function mc.guard_run_finish()`);
    await tq(`insert into exact_row_finish_guard_probe(id,status,quality,missing_reasons,request_id,method_version_id)
      values($1,'running',null,'[]',$2,$3)`,[rowFinishRun.id,rowFinishRequest.id,resultV29.id]);
    await assert.rejects(()=>tq(`update exact_row_finish_guard_probe set status='succeeded',quality='partial',
      missing_reasons='["operation_unclassified"]',finished_at=clock_timestamp() where id=$1`,[rowFinishRun.id]),
      /evidence source missing from calculation inputs/);

    const alternateParserV13=await tone(`insert into mc.method_versions(code,version_no,description,parameters,implementation_version)
      values('wb_finance_import_test_alternate',1,'Test-only alternate normalization','{}','wb-finance-v13') returning id`);
    const alternateNormalization=await tone(`insert into mc.report_normalizations(
      business_id,store_id,report_version_id,method_version_id,normalization_key,status)
      values($1,$2,$3,$4,'exact-row-alternate-normalization','succeeded') returning id`,
      [business.id,affectedStore.id,exactVersion.id,alternateParserV13.id]);
    const alternateOperationIdentity=await tone(`insert into mc.operations(business_id,store_id,source_code,source_operation_key)
      values($1,$2,'wb_finance','exact-row-alternate-sale') returning id`,[business.id,affectedStore.id]);
    const alternateOperation=await tone(`insert into mc.operation_versions(business_id,store_id,operation_id,report_row_id,version_no,
      operation_type,product_id,variant_id,accounting_date,quantity,report_normalization_id)
      values($1,$2,$3,$4,1,'sale',$5,$6,'2026-09-21',1,$7) returning id`,
      [business.id,affectedStore.id,alternateOperationIdentity.id,exactRow2.id,returnProduct.id,returnVariant.id,alternateNormalization.id]);
    for(const [key,category,amount,field,scope] of [
      ['retailAmount','revenue','500','retailAmount','selected_product'],
      ['vw','wb_reward_without_vat','-56.5360655737704918','vw','selected_product'],
      ['vwNds','wb_reward_vat','-12.108','vwNds','selected_product'],
      ['forPay','payout','431.36','forPay','reconciliation']
    ])await tq(`insert into mc.financial_components(business_id,store_id,operation_version_id,component_key,category_code,
      amount_signed,method_version_id,source_field,result_scope_classification) values($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [business.id,affectedStore.id,alternateOperation.id,key,category,amount,alternateParserV13.id,field,scope]);
    const alternateRequest=await tone(`insert into mc.calculation_requests(business_id,store_id,generation_no,selection_id,method_version_id,
      period_start,period_end,input_fingerprint,is_latest) values($1,$2,59,$3,$4,'2026-09-21','2026-09-27','alternate-row-finish-v29-fixture',false) returning id`,
      [business.id,affectedStore.id,returnSelection.id,resultV29.id]);
    await tq(`insert into mc.calculation_request_products(business_id,store_id,request_id,product_id) values($1,$2,$3,$4)`,
      [business.id,affectedStore.id,alternateRequest.id,returnProduct.id]);
    await tq(`insert into mc.calculation_request_inputs(business_id,store_id,request_id,report_normalization_id) values($1,$2,$3,$4)`,
      [business.id,affectedStore.id,alternateRequest.id,exactNormalization.id]);
    await tq(`insert into mc.calculation_request_inputs(business_id,store_id,request_id,report_version_id) values($1,$2,$3,$4)`,
      [business.id,affectedStore.id,alternateRequest.id,exactVersion.id]);
    const alternateRun=await tone(`insert into mc.calculation_runs(business_id,store_id,selection_id,method_version_id,period_start,period_end,
      input_fingerprint,request_id,attempt_no) values($1,$2,$3,$4,'2026-09-21','2026-09-27','alternate-row-finish-v29-fixture',$5,1) returning id`,
      [business.id,affectedStore.id,returnSelection.id,resultV29.id,alternateRequest.id]);
    const alternatePeriod=await tone(`insert into mc.financial_period_results(business_id,store_id,run_id,period_start,period_end,quality,missing_reasons,totals)
      values($1,$2,$3,'2026-09-21','2026-09-27','partial','["operation_unclassified"]',
      '{"selectedProductsResultBeforeTax":"0.0041","storeLevelResultBeforeTax":"0.0000","availableResultBeforeTax":"0.0041","estimatedUsnTax":"0.0000","availableResultAfterTax":null,"netProfit":null}') returning id`,
      [business.id,affectedStore.id,alternateRun.id]);
    await tq(`insert into mc.calculation_inputs(business_id,store_id,run_id,report_normalization_id) values($1,$2,$3,$4)`,
      [business.id,affectedStore.id,alternateRun.id,exactNormalization.id]);
    await tq(`insert into mc.calculation_inputs(business_id,store_id,run_id,report_version_id) values($1,$2,$3,$4)`,
      [business.id,affectedStore.id,alternateRun.id,exactVersion.id]);
    const alternateLine=await tone(`insert into mc.result_lines(business_id,store_id,run_id,product_id,variant_id,accounting_date,category_code,
      amount_signed,quality,result_scope,financial_period_result_id) values($1,$2,$3,$4,$5,'2026-09-21','wb_row_rounding_adjustment',
      0.0041,'partial','selected_product',$6) returning id`,
      [business.id,affectedStore.id,alternateRun.id,returnProduct.id,returnVariant.id,alternatePeriod.id]);
    await assert.rejects(()=>tq(`insert into mc.result_evidence(business_id,store_id,result_line_id,report_row_id,source_operation_version_id,contribution_amount)
      values($1,$2,$3,$4,$5,0.0041)`,[business.id,affectedStore.id,alternateLine.id,exactRow2.id,alternateOperation.id]),
      /outside frozen request inputs/);

    const missingLinkRequest=await tone(`insert into mc.calculation_requests(business_id,store_id,generation_no,selection_id,method_version_id,
      period_start,period_end,input_fingerprint,is_latest) values($1,$2,60,$3,$4,'2026-09-21','2026-09-27','exact-link-finish-v29-fixture',false) returning id`,
      [business.id,affectedStore.id,returnSelection.id,resultV29.id]);
    await tq(`insert into mc.calculation_request_products(business_id,store_id,request_id,product_id) values($1,$2,$3,$4)`,
      [business.id,affectedStore.id,missingLinkRequest.id,returnProduct.id]);
    for(const [column,value] of [['report_normalization_id',exactNormalization.id],['report_version_id',exactVersion.id]])
      await tq(`insert into mc.calculation_request_inputs(business_id,store_id,request_id,${column}) values($1,$2,$3,$4)`,
        [business.id,affectedStore.id,missingLinkRequest.id,value]);
    const missingLinkRun=await tone(`insert into mc.calculation_runs(business_id,store_id,selection_id,method_version_id,period_start,period_end,
      input_fingerprint,request_id,attempt_no) values($1,$2,$3,$4,'2026-09-21','2026-09-27','exact-link-finish-v29-fixture',$5,1) returning id`,
      [business.id,affectedStore.id,returnSelection.id,resultV29.id,missingLinkRequest.id]);
    const missingLinkPeriod=await tone(`insert into mc.financial_period_results(business_id,store_id,run_id,period_start,period_end,quality,missing_reasons,totals)
      values($1,$2,$3,'2026-09-21','2026-09-27','partial','["operation_unclassified"]',
      '{"selectedProductsResultBeforeTax":"311.3335","storeLevelResultBeforeTax":"0.0000","availableResultBeforeTax":"311.3335","estimatedUsnTax":"0.0000","availableResultAfterTax":null,"netProfit":null}') returning id`,
      [business.id,affectedStore.id,missingLinkRun.id]);
    await tq(`insert into mc.calculation_inputs(business_id,store_id,run_id,report_normalization_id) values($1,$2,$3,$4)`,
      [business.id,affectedStore.id,missingLinkRun.id,exactNormalization.id]);
    await tq(`insert into mc.calculation_inputs(business_id,store_id,run_id,report_version_id) values($1,$2,$3,$4)`,
      [business.id,affectedStore.id,missingLinkRun.id,exactVersion.id]);
    const missingLinkLine=await tone(`insert into mc.result_lines(business_id,store_id,run_id,product_id,variant_id,accounting_date,category_code,
      amount_signed,quality,result_scope,financial_period_result_id) values($1,$2,$3,$4,$5,'2026-09-22','return_wb_expense_reversal',
      311.3335,'partial','selected_product',$6) returning id`,
      [business.id,affectedStore.id,missingLinkRun.id,returnProduct.id,returnVariant.id,missingLinkPeriod.id]);
    assert.deepEqual(await tone(`select
      exists(select 1 from mc.calculation_request_inputs where request_id=$1 and report_normalization_id=$2) frozen_normalization,
      exists(select 1 from mc.calculation_request_inputs where request_id=$1 and operation_link_id=$3) frozen_link,
      (select product_id=$4 and report_normalization_id=$2 and report_row_id=$5 from mc.operation_versions where id=$6) source_matches`,
      [missingLinkRequest.id,exactNormalization.id,exactReturnLink.id,returnProduct.id,returnRow.id,exactReturnV13.id]),
      {frozen_normalization:true,frozen_link:false,source_matches:true});
    await assert.rejects(()=>tq(`insert into mc.result_evidence(business_id,store_id,result_line_id,report_row_id,source_operation_version_id,operation_link_id,
      contribution_amount) values($1,$2,$3,$4,$5,$6,311.3335)`,
      [business.id,affectedStore.id,missingLinkLine.id,returnRow.id,exactReturnV13.id,exactReturnLink.id]),
      /outside frozen request inputs/);

    await tq(`select set_config('app.user_id','',false),set_config('app.business_id','',false)`);
    await transportUpgradeDb.exec(await readFile(path.join(root,'db/migrations/058_exact_wb_row_evidence_input.sql'),'utf8'));
    await tq(`select set_config('app.user_id',$1,false),set_config('app.business_id',$2,false)`,[owner.id,business.id]);
    await tq(`update exact_row_finish_guard_probe set status='succeeded',quality='partial',
      missing_reasons='["operation_unclassified"]',finished_at=clock_timestamp() where id=$1`,[rowFinishRun.id]);
    const exactRowFinishGuard=(await tone(`select pg_get_functiondef('mc.guard_run_finish()'::regprocedure) definition`)).definition;
    assert.match(exactRowFinishGuard,/return_wb_expense_reversal/);
    assert.match(exactRowFinishGuard,/wb_row_rounding_adjustment/);
    assert.equal((await tone(`select max(version)::int version from mc.schema_migrations`)).version,58);
    pass('migration 58 accepts only frozen exact WB row evidence during run finalization');
  }finally{await transportUpgradeDb.close();}

  // Produce a machine-derived field/constraint inventory for review.
  const cols = await q("select table_name,column_name,data_type,udt_name,is_nullable,column_default,numeric_precision,numeric_scale from information_schema.columns where table_schema='mc' order by table_name,ordinal_position");
  const constraints = await q("select c.relname as table_name,con.conname,con.contype,pg_get_constraintdef(con.oid) as definition from pg_constraint con join pg_class c on c.oid=con.conrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='mc' order by c.relname,con.conname");
  const inventory = ['# Marketplace Control — словарь БД, итерация 1','','Сформирован из применённой миграции. Названия полей, типы, значения по умолчанию и ограничения соответствуют проверенной схеме.','','Денежные значения — точные десятичные числа. NULL означает отсутствие значения. Все даты периодов включительны; стоимость действует от effective_from до следующей даты стоимости варианта.',''];
  for(const t of tables) {
    inventory.push(`## ${t.table_name}`,'','| Поле | Тип | NULL | По умолчанию |','|---|---|---|---|');
    for(const c of cols.filter(x=>x.table_name===t.table_name)) {
      const type=c.data_type==='numeric'&&c.numeric_precision!==null?`numeric(${c.numeric_precision},${c.numeric_scale})`:c.data_type;
      inventory.push(`| ${c.column_name} | ${type} | ${c.is_nullable==='YES'?'да':'нет'} | ${(c.column_default??'—').replaceAll('|','\\|')} |`);
    }
    inventory.push('','Ограничения и связи:','');
    for(const c of constraints.filter(x=>x.table_name===t.table_name)) inventory.push(`- \`${c.definition}\``);
    inventory.push('');
  }
  if(process.env.DB_TEST_CHECK_ONLY!=='1') {
    await mkdir(path.join(root,'outputs'),{recursive:true});
    await writeFile(path.join(root,'outputs/database-v1-dictionary.md'),inventory.join('\n').trimEnd()+'\n');
    await mkdir(path.join(root,'work'),{recursive:true});
    await writeFile(path.join(root,'work/db-test-result.json'),JSON.stringify({engine:version,passed:count,tables:tables.length},null,2));
  }
  console.log(`PASS: ${count} checks, ${tables.length} tables.${process.env.DB_TEST_CHECK_ONLY==='1'?'':' Dictionary generated.'}`);
} catch(error) {
  console.error(error.message, error.detail??'', error.where??'');
  process.exitCode=1;
} finally {
  await db.close();
}
