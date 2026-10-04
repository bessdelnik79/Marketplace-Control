import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const integrationUrl=process.env.FIELD_EXPENSES_INTEGRATION_DATABASE_URL;
if(!integrationUrl)throw new Error('Set FIELD_EXPENSES_INTEGRATION_DATABASE_URL to an empty disposable PostgreSQL database whose name contains "test".');
if(!new URL(integrationUrl).pathname.slice(1).toLowerCase().includes('test'))throw new Error('Refusing field expense integration outside a database whose name contains "test".');
process.env.DATABASE_URL=integrationUrl;
const {migrate,pool,completeFinancialSync,runFinancialCalculation,getPublishedFinancialPeriod,jobsRepository,financialDailyGenerationRepository}=await import('../../app/db.mjs');
const {persistFinancialNormalization}=await import('../../app/modules/reports/normalization.repository.mjs');
const {financialParserVersion}=await import('../../app/modules/reports/finance.mjs');
const {refreshFinancialBankChecks,getFinancialBankReconciliationState}=await import('../../app/modules/reports/reports.repository.mjs');
test.after(async()=>{await pool.end();});

async function context(scope,action){
  const client=await pool.connect();
  try{
    await client.query('begin');
    await client.query("select set_config('app.user_id',$1,true),set_config('app.business_id',$2,true)",[scope.user,scope.business]);
    const result=await action(client);
    await client.query('commit');
    return result;
  }catch(error){await client.query('rollback');throw error;}finally{client.release();}
}

const periodStart='2026-09-21',periodEnd='2026-09-27';
async function fixture(rawRows){
  const scope={user:randomUUID(),business:randomUUID(),store:randomUUID()};
  const setup=await context(scope,async client=>{
    await client.query(`insert into mc.users(id,display_name) values($1,'Field expense owner')`,[scope.user]);
    await client.query(`insert into mc.businesses(id,name) values($1,'Field expense test')`,[scope.business]);
    await client.query(`insert into mc.memberships(business_id,user_id,role) values($1,$2,'owner')`,[scope.business,scope.user]);
    await client.query(`insert into mc.stores(id,business_id,external_account_id,name,status) values($1,$2,$3,'Field expense store','active')`,[scope.store,scope.business,scope.store]);
    const catalog=(await client.query(`insert into mc.source_documents(business_id,store_id,origin,document_type,checksum,completeness)
      values($1,$2,'wb_api','catalog',$3,'complete') returning id`,[scope.business,scope.store,`catalog:${scope.store}`])).rows[0];
    const product=(await client.query(`insert into mc.products(business_id,store_id,wb_article,seller_article)
      values($1,$2,730001,'FIELD-EXPENSE') returning id`,[scope.business,scope.store])).rows[0];
    const variant=(await client.query(`insert into mc.variants(business_id,store_id,product_id,external_variant_id)
      values($1,$2,$3,'default') returning id`,[scope.business,scope.store,product.id])).rows[0];
    await client.query(`insert into mc.variant_identifiers(business_id,store_id,variant_id,identifier_type,identifier_value)
      values($1,$2,$3,'barcode','4730000000001')`,[scope.business,scope.store,variant.id]);
    await client.query(`select mc.confirm_product_selection($1,$2,$3::uuid[])`,[scope.store,catalog.id,[product.id]]);
    const cost=(await client.query(`insert into mc.variant_costs(business_id,store_id,product_id,variant_id,effective_from)
      values($1,$2,$3,$4,'2026-01-01') returning id`,[scope.business,scope.store,product.id,variant.id])).rows[0];
    const costVersion=(await client.query(`insert into mc.cost_versions(business_id,store_id,cost_id,version_no,unit_cost,origin,changed_by)
      values($1,$2,$3,1,0,'manual',$4) returning id`,[scope.business,scope.store,cost.id,scope.user])).rows[0];
    await client.query(`update mc.variant_costs set current_version_id=$1 where id=$2`,[costVersion.id,cost.id]);
    const setting=(await client.query(`insert into mc.tax_settings(business_id,effective_from) values($1,'2026-01-01') returning id`,[scope.business])).rows[0];
    const tax=(await client.query(`insert into mc.tax_setting_versions(business_id,tax_setting_id,version_no,regime_code,usn_rate_fraction,vat_mode,changed_by)
      values($1,$2,1,'usn_income',0.06,'exempt',$3) returning id`,[scope.business,setting.id,scope.user])).rows[0];
    await client.query(`update mc.tax_settings set current_version_id=$1 where id=$2`,[tax.id,setting.id]);
    const stream=(await client.query(`insert into mc.sync_streams(business_id,store_id,source_type,status)
      values($1,$2,'financial_reports','active') returning id`,[scope.business,scope.store])).rows[0];
    const run=(await client.query(`insert into mc.sync_runs(business_id,store_id,stream_id,requested_from,requested_to,status,started_at)
      values($1,$2,$3,$4,$5,'running',now()) returning id`,[scope.business,scope.store,stream.id,periodStart,periodEnd])).rows[0];
    return {stream:stream.id,run:run.id,product:product.id};
  });
  await completeFinancialSync(scope.user,{business_id:scope.business,store_id:scope.store,stream_id:setup.stream,run_id:setup.run,date_from:periodStart,date_to:periodEnd},{
    documentId:randomUUID(),reports:[{externalReportId:'930001',periodStart,periodEnd,checksum:`report:${scope.store}`,
      rows:rawRows.map((rawData,index)=>({externalRowKey:String(index+1),rowChecksum:`row:${scope.store}:${index}`,
        rawData:{reportId:930001,rrDate:'2026-09-22',nmId:730001,sku:'4730000000001',...rawData}}))}]
  });
  const cached=await context(scope,async client=>{
    const saved=(await client.query(`select rv.id,n.catalog_revision,n.id normalization_id from mc.reports r
      join mc.report_versions rv on rv.id=r.current_version_id join mc.report_normalizations n on n.report_version_id=rv.id
      join mc.method_versions method on method.id=n.method_version_id
      where r.store_id=$1 and method.implementation_version=$2 order by n.normalized_at desc limit 1`,[scope.store,financialParserVersion])).rows[0];
    const result=await persistFinancialNormalization(client,{businessId:scope.business,storeId:scope.store,reportVersionId:saved.id,catalogRevision:saved.catalog_revision});
    assert.equal(result.id,saved.normalization_id);
    return result;
  });
  assert.equal(cached.cached,true);
  return {...scope,product:setup.product};
}

async function drainDaily(){
  const workerId=`field-expenses:${randomUUID()}`;
  let processed=0;
  for(;processed<20;processed++){
    const [job]=await jobsRepository.claimJobs({workerId,jobTypes:['financial_dates_recalculate'],leaseSeconds:300,limit:1});
    if(!job)break;
    assert.equal(job.payload.allowsWbApi,false);
    const result=await financialDailyGenerationRepository.build(job.id,job.lease_token,workerId);
    await jobsRepository.completeJob({jobId:job.id,leaseToken:job.lease_token,workerId,outcome:result.superseded?'superseded':'completed'});
  }
  assert.ok(processed<20,'daily queue must drain');
  assert.ok(processed>0,'at least one daily generation must be built');
}

const corrections=[
  {sellerOperName:'Логистика',deliveryService:'57.98'},
  {sellerOperName:'Коррекция логистики WB: новое название',deliveryService:'-14.64'},
  {sellerOperName:'',docTypeName:'',deliveryService:'-14.64'},
  {sellerOperName:'Другое название',docTypeName:'Изменённый документ',deliveryService:'-14.64'}
];

test('financial method upgrades queue every tenant existing week through v36 without WB fetch',async()=>{
  assert.equal((await pool.query("select to_regclass('mc.schema_migrations') table_name")).rows[0].table_name,null,'use an empty disposable database');
  const directory=path.resolve('db/migrations');
  for(const file of (await readdir(directory)).filter(name=>/^\d+_.+\.sql$/.test(name)&&Number(name.slice(0,3))<63).sort()){
    await pool.query(await readFile(path.join(directory,file),'utf8'));
  }
  const tenants=[await fixture(corrections),await fixture(corrections)];
  await migrate();
  for(const scope of tenants){
    const saved=await context(scope,async client=>({
      events:(await client.query(`select e.affected_from::text,e.affected_to::text,m.implementation_version
        from mc.financial_input_events e join mc.method_versions m on m.id=e.source_result_method_version_id
        where e.store_id=$1 and e.event_key=$2`,[scope.store,`financial-result-upgrade:v32:store:${scope.store}`])).rows,
      invalidation:(await client.query(`select reason from mc.calculation_invalidations where store_id=$1`,[scope.store])).rows[0],
      paymentEvents:(await client.query(`select e.affected_from::text,e.affected_to::text,m.implementation_version
        from mc.financial_input_events e join mc.method_versions m on m.id=e.source_result_method_version_id
        where e.store_id=$1 and e.event_key=$2`,[scope.store,`financial-payment-commission:v1:store:${scope.store}`])).rows,
      fetches:(await client.query(`select count(*)::int n from mc.jobs where store_id=$1 and job_type='financial_report_fetch'`,[scope.store])).rows[0].n,
      jobs:(await client.query(`select payload->>'allowsWbApi' allows_wb_api from mc.jobs where store_id=$1 and job_type='financial_dates_recalculate' and status='pending'`,[scope.store])).rows
    }));
    assert.deepEqual(saved.events,[{affected_from:periodStart,affected_to:periodEnd,implementation_version:'financial-result-v32'}]);
    assert.equal(saved.invalidation.reason,'financial_payment_commission_control');
    assert.deepEqual(saved.paymentEvents,[{affected_from:periodStart,affected_to:periodEnd,implementation_version:'financial-result-v36'}]);
    assert.equal(saved.fetches,0);
    assert.ok(saved.jobs.length>0);
    assert.ok(saved.jobs.every(job=>job.allows_wb_api==='false'));
  }
  for(const scope of tenants){
    const result=await runFinancialCalculation(scope.user,scope.store);
    assert.equal(result.quality,'complete');
    assert.equal(result.totals.availableResultBeforeTax,'-14.0600');
  }
  await drainDaily();
  for(const scope of tenants){
    const published=await getPublishedFinancialPeriod(scope.user,scope.store,periodStart,periodEnd);
    assert.equal(published.publication_source,'daily');
    assert.equal(published.quality,'complete');
    assert.equal(published.totals.availableResultBeforeTax,'-14.0600');
    assert.equal(published.totals.availableResultAfterTax,'-14.0600');
    assert.equal(await getPublishedFinancialPeriod(tenants.find(tenant=>tenant.user!==scope.user).user,scope.store,periodStart,periodEnd),null);
    const normalized=await context(scope,async client=>(await client.query(`select f.amount_signed::text
      from mc.financial_components f join mc.operation_versions o on o.id=f.operation_version_id
      join mc.report_rows row on row.id=o.report_row_id where o.store_id=$1 and f.source_field='deliveryService'
      order by row.row_number`,[scope.store])).rows.map(row=>row.amount_signed));
    assert.deepEqual(normalized,['-57.98','14.64','14.64','14.64']);
  }
});

test('mixed sale expenses retain exact sources and rounded evidence through v31 and v32 publication',async()=>{
  const scope=await fixture([{docTypeName:'Продажа',sellerOperName:'Продажа',quantity:1,retailAmount:'100',forPay:'81.37',
    acquiringFee:'1',vw:'2',vwNds:'0.4',deliveryService:'1.23456',paidStorage:'2',paidAcceptance:'3',penalty:'4',deduction:'5'}]);
  const calculated=await runFinancialCalculation(scope.user,scope.store);
  assert.equal(calculated.quality,'complete');
  assert.deepEqual(calculated.missingReasons,[]);
  assert.equal(calculated.totals.availableResultBeforeTax,'81.3700');
  assert.equal(calculated.totals.availableResultAfterTax,'75.3700');
  const persisted=await context(scope,async client=>({
    method:(await client.query(`select m.implementation_version from mc.calculation_runs r join mc.method_versions m on m.id=r.method_version_id where r.id=$1`,[calculated.runId])).rows[0].implementation_version,
    logistics:(await client.query(`select f.amount_signed::text source_amount,line.amount_signed::text result_amount,e.contribution_amount::text evidence_amount
      from mc.result_lines line join mc.result_evidence e on e.result_line_id=line.id
      join mc.financial_components f on f.id=e.financial_component_id
      where line.run_id=$1 and line.category_code='logistics'`,[calculated.runId])).rows,
    categories:(await client.query(`select category_code from mc.result_lines where run_id=$1 order by category_code`,[calculated.runId])).rows.map(row=>row.category_code)
  }));
  assert.equal(persisted.method,'financial-result-v35');
  assert.deepEqual(persisted.logistics,[{source_amount:'-1.23456',result_amount:'-1.2346',evidence_amount:'-1.2346'}]);
  for(const category of ['logistics','storage','acceptance','penalty','deduction','acquiring','wb_reward_without_vat','wb_reward_vat','wb_row_rounding_adjustment']){
    assert.ok(persisted.categories.includes(category),category);
  }
  await context(scope,client=>client.query(`select e.id from mc.method_versions method
    cross join lateral mc.emit_financial_input_event($1,$2,'result_method_updated',$3,$4,
      p_source_result_method_version_id=>method.id) e
    where method.code='financial_result' and method.version_no=36`,
    [scope.store,`field-expenses-mixed:${scope.store}`,periodStart,periodEnd]));
  await drainDaily();
  const published=await getPublishedFinancialPeriod(scope.user,scope.store,periodStart,periodEnd);
  assert.equal(published.publication_source,'daily');
  assert.equal(published.quality,'complete');
  assert.equal(published.totals.availableResultBeforeTax,'81.3700');
  assert.equal(published.totals.availableResultAfterTax,'75.3700');
  const daily=await context(scope,async client=>(await client.query(`select method.implementation_version,line.amount_signed::text,e.contribution_amount::text
    from mc.financial_daily_current_publications current join mc.financial_daily_publication_days day on day.publication_id=current.publication_id
    join mc.financial_daily_generations generation on generation.id=day.generation_id
    join mc.method_versions method on method.id=generation.result_method_version_id
    join mc.financial_daily_results line on line.generation_id=generation.id and line.accounting_date=day.accounting_date
    join mc.financial_daily_evidence e on e.daily_result_id=line.id
    where current.store_id=$1 and line.category_code='logistics'`,[scope.store])).rows);
  assert.deepEqual(daily,[{implementation_version:'financial-result-v36',amount_signed:'-1.2346',contribution_amount:'-1.2346'}]);
});

test('half-kopeck controls persist exact WB amounts through weekly and daily evidence',async()=>{
  for(const [expense,payout,expectedQuality] of [['1.775','98.23','complete'],['1.77500000000000000001','98.23','partial']]){
    const scope=await fixture([
      {docTypeName:'Продажа',sellerOperName:'Продажа',quantity:1,retailAmount:'100',forPay:payout,deliveryService:expense},
      {docTypeName:'',sellerOperName:'Возмещение издержек по перевозке/по складским операциям с товаром',rebillLogisticCost:'2.13',vw:'-1.775',vwNds:'-0.36'}
    ]);
    const calculated=await runFinancialCalculation(scope.user,scope.store);
    assert.equal(calculated.quality,expectedQuality);
    if(expectedQuality==='complete'){
      assert.equal(calculated.totals.availableResultBeforeTax,'98.2300');
      await context(scope,client=>client.query(`select e.id from mc.method_versions method
        cross join lateral mc.emit_financial_input_event($1,$2,'result_method_updated',$3,$4,
          p_source_result_method_version_id=>method.id) e
        where method.code='financial_result' and method.version_no=36`,
        [scope.store,`half-kopeck:${scope.store}`,periodStart,periodEnd]));
      await drainDaily();
      const published=await getPublishedFinancialPeriod(scope.user,scope.store,periodStart,periodEnd);
      assert.equal(published.quality,'complete');
      assert.equal(published.totals.availableResultBeforeTax,'98.2300');
      const amounts=await context(scope,async client=>(await client.query(`select component.amount_signed::text amount
        from mc.financial_components component join mc.operation_versions operation on operation.id=component.operation_version_id
        where operation.store_id=$1 and component.source_field='deliveryService'`,[scope.store])).rows);
      assert.deepEqual(amounts,[{amount:'-1.775'}]);
    }
  }
});

test('payment commission controls retain acquiring once in weekly and daily results',async()=>{
  for(const [paymentProcessing,forPay,quality] of [
    ['Комиссия за организацию платежа с НДС','100','complete'],
    ['Перевыставление эквайринга','99','complete'],
    ['Компенсация платёжных услуг','99','complete'],
    ['Комиссия за организацию платежа с НДС','98','partial']
  ]){
    const scope=await fixture([{docTypeName:'Продажа',sellerOperName:'Продажа',quantity:1,
      retailAmount:'100',acquiringFee:'1',forPay,paymentProcessing}]);
    const result=await runFinancialCalculation(scope.user,scope.store);
    assert.equal(result.quality,quality);
    assert.equal(result.totals.availableResultBeforeTax,'99.0000');
    assert.equal(result.missingReasons.includes('source_unreconciled'),quality==='partial');
    assert.equal(result.missingReasons.includes('operation_unclassified'),false);
    const evidence=await context(scope,async client=>(await client.query(`select line.category_code,line.amount_signed::text,
      count(e.id)::int evidence_count from mc.result_lines line join mc.result_evidence e on e.result_line_id=line.id
      where line.run_id=$1 and line.category_code in('revenue','acquiring') group by line.id order by line.category_code`,[result.runId])).rows);
    assert.deepEqual(evidence,[{category_code:'acquiring',amount_signed:'-1.0000',evidence_count:1},
      {category_code:'revenue',amount_signed:'100.0000',evidence_count:1}]);
    await context(scope,client=>client.query(`select mc.emit_financial_input_event($1,$2,'result_method_updated',$3,$4,
      p_source_result_method_version_id=>(select id from mc.method_versions where code='financial_result' and version_no=36))`,
      [scope.store,`payment-control:${scope.store}`,periodStart,periodEnd]));
    await drainDaily();
    const published=await getPublishedFinancialPeriod(scope.user,scope.store,periodStart,periodEnd);
    assert.equal(published.quality,quality);
    assert.equal(published.totals.availableResultBeforeTax,'99.0000');
    assert.equal(published.missing_reasons.includes('source_unreconciled'),quality==='partial');
  }
});

test('December payment commissions publish exact evidenced rounding without changing WB fields',async()=>{
  for(const [raw,expected] of [
    [{retailAmount:'1460',forPay:'1046.26',acquiringFee:'26.31',ppvzReward:'4.85',vw:'340.7416666666666667',vwNds:'68.15'},'1019.9500'],
    [{retailAmount:'1364',forPay:'1046.26',acquiringFee:'26.31',ppvzReward:'30.683',vw:'239.2141666666666667',vwNds:'47.84'},'1019.9500'],
    [{retailAmount:'100',forPay:'98.77',acquiringFee:'0',deliveryService:'1.23456'},'98.7700']
  ]){
    const scope=await fixture([{docTypeName:'Продажа',sellerOperName:'Продажа',quantity:1,
      paymentProcessing:'Комиссия за организацию платежа с НДС',...raw}]);
    const calculated=await runFinancialCalculation(scope.user,scope.store);
    assert.equal(calculated.quality,'complete');
    assert.equal(calculated.totals.availableResultBeforeTax,expected);
    const adjustment=await context(scope,async client=>(await client.query(`select e.contribution_amount::text,
      mc.expected_wb_row_rounding_adjustment(e.source_operation_version_id,run.method_version_id,null)::text expected
      from mc.result_evidence e join mc.result_lines line on line.id=e.result_line_id
      join mc.calculation_runs run on run.id=line.run_id where run.id=$1 and line.category_code='wb_row_rounding_adjustment'`,[calculated.runId])).rows);
    assert.equal(adjustment.length,1);
    assert.equal(Number(adjustment[0].contribution_amount),Number(adjustment[0].expected));
    await context(scope,client=>client.query(`select mc.emit_financial_input_event($1,$2,'result_method_updated',$3,$4,
      p_source_result_method_version_id=>(select id from mc.method_versions where code='financial_result' and version_no=36))`,
      [scope.store,`payment-rounding:${scope.store}`,periodStart,periodEnd]));
    await drainDaily();
    const published=await getPublishedFinancialPeriod(scope.user,scope.store,periodStart,periodEnd);
    assert.equal(published.quality,'complete');
    assert.equal(published.totals.availableResultBeforeTax,expected);
    const saved=await context(scope,async client=>(await client.query(`select row.raw_data->>'forPay' payout,row.raw_data->>'acquiringFee' acquiring
      from mc.report_rows row join mc.operation_versions operation on operation.report_row_id=row.id where operation.store_id=$1`,[scope.store])).rows);
    assert.ok(saved.every(row=>row.payout===raw.forPay&&row.acquiring===raw.acquiringFee));
  }
});

test('saved bank boundary failures receive a fresh check without rewriting history',async()=>{
  for(const source of ['summary_versions','inventory']){
  const scope=await fixture([{docTypeName:'Продажа',sellerOperName:'Продажа',quantity:1,retailAmount:'100',forPay:'60',acquiringFee:'40'}]);
  await context(scope,async client=>{
    const report=(await client.query(`select current_version_id,external_report_id,period_start::text,period_end::text from mc.reports where store_id=$1`,[scope.store])).rows[0];
    const run=(await client.query(`select id from mc.sync_runs where store_id=$1 limit 1`,[scope.store])).rows[0];
    const summary={reportId:report.external_report_id,reportType:1,dateFrom:report.period_start,dateTo:report.period_end,currency:'RUB',
      forPaySum:'60',deliveryServiceSum:'0',paidStorageSum:'0',paidAcceptanceSum:'0',deductionSum:'0',penaltySum:'0',additionalPaymentSum:'0',
      cashbackAmountSum:'0',cashbackCommissionChangeSum:'0',bankPaymentSum:'60.005'};
    if(source==='summary_versions')await client.query(`insert into mc.financial_report_summary_versions(business_id,store_id,report_version_id,sync_run_id,checksum,raw_data)
      values($1,$2,$3,$4,'half-kopeck-summary',$5::jsonb)`,[scope.business,scope.store,report.current_version_id,run.id,JSON.stringify(summary)]);
    if(source==='inventory'){
      const coverage=(await client.query(`insert into mc.financial_week_coverage(business_id,store_id,credential_generation,week_start,week_end,check_reasons)
        values($1,$2,1,$3,$4,ARRAY['test']) returning id`,[scope.business,scope.store,periodStart,periodEnd])).rows[0];
      const normalization=(await client.query(`select id from mc.report_normalizations where report_version_id=$1 and status='succeeded' order by normalized_at desc limit 1`,[report.current_version_id])).rows[0];
      await client.query(`insert into mc.financial_week_inventory(business_id,store_id,coverage_id,external_report_id,inventory_checksum,period_start,period_end,
        summary_raw_data,report_version_id,accepted_normalization_id,accepted_inventory_checksum,accepted_at,fetch_status)
        values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$5,clock_timestamp(),'accepted')`,
        [scope.business,scope.store,coverage.id,report.external_report_id,'a'.repeat(64),periodStart,periodEnd,JSON.stringify(summary),report.current_version_id,normalization.id]);
    }
    await client.query(`insert into mc.reconciliation_checks(business_id,store_id,report_version_id,check_code,expected_amount,actual_amount,status,details,created_at)
      values($1,$2,$3,'wb_bank_payment_sum_v1',60,60.01,'failed','{"reason":"bank_payment_mismatch"}',clock_timestamp())`,[scope.business,scope.store,report.current_version_id]);
  });
  assert.equal((await getFinancialBankReconciliationState(scope.user,scope.store)).failed,1);
  await refreshFinancialBankChecks(scope.user,scope.store);
  assert.equal((await getFinancialBankReconciliationState(scope.user,scope.store)).passed,1);
  await refreshFinancialBankChecks(scope.user,scope.store);
  const checks=await context(scope,async client=>(await client.query(`select status,count(*)::int n from mc.reconciliation_checks
    where store_id=$1 and (details->>'reason'='bank_payment_mismatch' or status='passed') group by status order by status`,[scope.store])).rows);
  assert.deepEqual(checks,[{status:'failed',n:1},{status:'passed',n:1}]);
  }
});
