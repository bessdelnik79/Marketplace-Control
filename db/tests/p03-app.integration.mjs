import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

const integrationUrl=process.env.P03_INTEGRATION_DATABASE_URL;
if(!integrationUrl)throw new Error('Set P03_INTEGRATION_DATABASE_URL to a disposable PostgreSQL database whose name contains "test".');
const databaseName=new URL(integrationUrl).pathname.slice(1);
if(!databaseName.toLowerCase().includes('test'))throw new Error('Refusing to run P0.3 integration tests outside a database whose name contains "test".');
process.env.DATABASE_URL=integrationUrl;

const {migrate,pool,runFinancialCalculation,beginFinancialSync,completeFinancialSync,failFinancialSync,getFinancialBankReconciliationState,getPublishedFinancialPeriod,getPublishedFinancialPeriodPair,getFinancialSellerOffsetReference,getFinancialSyncState,getFinancialCalculationInvalidation,getFinancialCompatibilityBootstrapState,acknowledgeFinancialCalculationInvalidation,retryFinancialDailyPublication,wakeFinancialDailyAfterCompatibility,jobsRepository,financialDailyGenerationRepository}=await import('../../app/db.mjs');
const ids={user:randomUUID(),business:randomUUID(),store:randomUUID()};
let compatibilityV30;

await migrate();
async function context(action){
  const client=await pool.connect();
  try{
    await client.query('begin');
    await client.query("select set_config('app.user_id',$1,true),set_config('app.business_id',$2,true)",[ids.user,ids.business]);
    const value=await action(client);
    await client.query('commit');
    return value;
  }catch(error){await client.query('rollback');throw error;}finally{client.release();}
}

await context(async client=>{
  await client.query(`insert into mc.users(id,display_name) values($1,'P03 owner')`,[ids.user]);
  await client.query(`insert into mc.businesses(id,name) values($1,'P03 test')`,[ids.business]);
  await client.query(`insert into mc.memberships(business_id,user_id,role) values($1,$2,'owner')`,[ids.business,ids.user]);
  await client.query(`insert into mc.stores(id,business_id,external_account_id,name,status) values($1,$2,'p03-test','P03 store','active')`,[ids.store,ids.business]);
  const catalog=(await client.query(`insert into mc.source_documents(business_id,store_id,origin,document_type,checksum,completeness) values($1,$2,'wb_api','catalog','p03-catalog','complete') returning id`,[ids.business,ids.store])).rows[0];
  const product=(await client.query(`insert into mc.products(business_id,store_id,wb_article,seller_article) values($1,$2,700001,'P03') returning id`,[ids.business,ids.store])).rows[0];
  const variant=(await client.query(`insert into mc.variants(business_id,store_id,product_id,external_variant_id) values($1,$2,$3,'default') returning id`,[ids.business,ids.store,product.id])).rows[0];
  await client.query(`insert into mc.variant_identifiers(business_id,store_id,variant_id,identifier_type,identifier_value) values($1,$2,$3,'barcode','4600000000001')`,[ids.business,ids.store,variant.id]);
  const selection=(await client.query(`select mc.confirm_product_selection($1,$2,$3::uuid[]) as id`,[ids.store,catalog.id,[product.id]])).rows[0];
  const cost=(await client.query(`insert into mc.variant_costs(business_id,store_id,product_id,variant_id,effective_from) values($1,$2,$3,$4,'2026-07-01') returning id`,[ids.business,ids.store,product.id,variant.id])).rows[0];
  const costVersion=(await client.query(`insert into mc.cost_versions(business_id,store_id,cost_id,version_no,unit_cost,origin,changed_by) values($1,$2,$3,1,40,'manual',$4) returning id`,[ids.business,ids.store,cost.id,ids.user])).rows[0];
  await client.query(`update mc.variant_costs set current_version_id=$1 where id=$2`,[costVersion.id,cost.id]);
  const document=(await client.query(`insert into mc.source_documents(business_id,store_id,origin,document_type,external_document_id,checksum,completeness) values($1,$2,'wb_api','weekly_realization','p03-report','p03-report','complete') returning id`,[ids.business,ids.store])).rows[0];
  const report=(await client.query(`insert into mc.reports(business_id,store_id,external_report_id,period_start,period_end) values($1,$2,'785995400','2026-07-13','2026-07-19') returning id`,[ids.business,ids.store])).rows[0];
  const reportVersion=(await client.query(`insert into mc.report_versions(business_id,store_id,report_id,document_id,version_no,checksum,parser_version) values($1,$2,$3,$4,1,'p03-v1','wb-finance-v13') returning id`,[ids.business,ids.store,report.id,document.id])).rows[0];
  const reportRow=(await client.query(`insert into mc.report_rows(business_id,store_id,report_version_id,external_row_key,row_number,raw_data,row_checksum) values($1,$2,$3,'1',1,$4::jsonb,'p03-row') returning id`,[ids.business,ids.store,reportVersion.id,JSON.stringify({docTypeName:'Продажа',sellerOperName:'Продажа',rrDate:'2026-07-15',nmId:700001,sku:'4600000000001',quantity:1,retailAmount:'100',rebillLogisticCost:'100.24',forPay:'100'})])).rows[0];
  const storeRow=(await client.query(`insert into mc.report_rows(business_id,store_id,report_version_id,external_row_key,row_number,raw_data,row_checksum) values($1,$2,$3,'2',2,$4::jsonb,'p03-store-row') returning id`,[ids.business,ids.store,reportVersion.id,JSON.stringify({docTypeName:'',sellerOperName:'Удержание',rrDate:'2026-07-15',nmId:0,additionalPayment:'1458.34'})])).rows[0];
  await client.query(`update mc.report_versions set status='validated' where id=$1`,[reportVersion.id]);
  await client.query(`update mc.report_versions set status='accepted',accepted_at=now() where id=$1`,[reportVersion.id]);
  await client.query(`update mc.reports set current_version_id=$1 where id=$2`,[reportVersion.id,report.id]);
  const importMethod=(await client.query(`select id from mc.method_versions where code='wb_finance_import' and version_no=13`)).rows[0];
  const normalization=(await client.query(`insert into mc.report_normalizations(business_id,store_id,report_version_id,method_version_id,normalization_key,status) values($1,$2,$3,$4,$5,'succeeded') returning id`,[ids.business,ids.store,reportVersion.id,importMethod.id,`wb-finance-v13:${reportVersion.id}`])).rows[0];
  const operation=(await client.query(`insert into mc.operations(business_id,store_id,source_code,source_operation_key) values($1,$2,'wb_finance','785995400/1') returning id`,[ids.business,ids.store])).rows[0];
  const operationVersion=(await client.query(`insert into mc.operation_versions(business_id,store_id,operation_id,report_row_id,report_normalization_id,version_no,operation_type,product_id,variant_id,accounting_date,quantity) values($1,$2,$3,$4,$5,1,'sale',$6,$7,'2026-07-15',1) returning id`,[ids.business,ids.store,operation.id,reportRow.id,normalization.id,product.id,variant.id])).rows[0];
  await client.query(`insert into mc.financial_components(business_id,store_id,operation_version_id,component_key,category_code,amount_signed,method_version_id,source_field,result_scope_classification) values($1,$2,$3,'retailAmount','revenue',100,$4,'retailAmount','selected_product')`,[ids.business,ids.store,operationVersion.id,importMethod.id]);
  await client.query(`insert into mc.financial_components(business_id,store_id,operation_version_id,component_key,category_code,amount_signed,method_version_id,source_field,result_scope_classification) values($1,$2,$3,'forPay','payout',100,$4,'forPay','reconciliation')`,[ids.business,ids.store,operationVersion.id,importMethod.id]);
  await client.query(`insert into mc.financial_components(business_id,store_id,operation_version_id,component_key,category_code,amount_signed,method_version_id,source_field,result_scope_classification) values($1,$2,$3,'rebillLogisticCost','rebill_logistic_compensation',-100.24,$4,'rebillLogisticCost','reconciliation')`,[ids.business,ids.store,operationVersion.id,importMethod.id]);
  const storeOperation=(await client.query(`insert into mc.operations(business_id,store_id,source_code,source_operation_key) values($1,$2,'wb_finance','785995400/2') returning id`,[ids.business,ids.store])).rows[0];
  const storeOperationVersion=(await client.query(`insert into mc.operation_versions(business_id,store_id,operation_id,report_row_id,report_normalization_id,version_no,operation_type,accounting_date) values($1,$2,$3,$4,$5,1,'adjustment','2026-07-15') returning id`,[ids.business,ids.store,storeOperation.id,storeRow.id,normalization.id])).rows[0];
  await client.query(`insert into mc.financial_components(business_id,store_id,operation_version_id,component_key,category_code,amount_signed,method_version_id,source_field,result_scope_classification) values($1,$2,$3,'additionalPayment','commission_adjustment',-1458.34,$4,'additionalPayment','store')`,[ids.business,ids.store,storeOperationVersion.id,importMethod.id]);
  const taxSetting=(await client.query(`insert into mc.tax_settings(business_id,effective_from) values($1,'2026-01-01') returning id`,[ids.business])).rows[0];
  const taxVersion=(await client.query(`insert into mc.tax_setting_versions(business_id,tax_setting_id,version_no,regime_code,usn_rate_fraction,vat_mode,changed_by)
    values($1,$2,1,'usn_income',0.06,'exempt',$3) returning id`,[ids.business,taxSetting.id,ids.user])).rows[0];
  await client.query(`update mc.tax_settings set current_version_id=$1 where id=$2`,[taxVersion.id,taxSetting.id]);
  assert.ok(selection.id);
});

test('P0.3 persists selected-SKU USN, deducts it once and idempotently keeps one publication',async()=>{
  const first=await runFinancialCalculation(ids.user,ids.store);
  assert.equal(first.quality,'complete');
  assert.deepEqual(first.missingReasons,[]);
  assert.equal(first.totals.availableResultBeforeTax,'-1398.3400');
  assert.equal(first.totals.estimatedUsnTax,'6.0000');
  assert.equal(first.totals.availableResultAfterTax,'-1404.3400');
  const second=await runFinancialCalculation(ids.user,ids.store);
  assert.equal(second.changed,false);
  const saved=await context(async client=>(await client.query(
    `select r.quality,r.missing_reasons,count(distinct p.id)::int publications,sum(l.amount_signed)::text total,
            count(distinct tc.id)::int computations,count(distinct ts.id)::int segments,count(distinct tb.id)::int basis,
            count(distinct case when l.category_code='estimated_usn_tax' then e.id end)::int tax_evidence
       from mc.publications p join mc.calculation_runs r on r.id=p.run_id
       left join mc.result_lines l on l.run_id=r.id
       left join mc.result_evidence e on e.result_line_id=l.id
       left join mc.tax_computations tc on tc.run_id=r.id
       left join mc.tax_computation_segments ts on ts.tax_computation_id=tc.id
       left join mc.tax_basis_evidence tb on tb.tax_segment_id=ts.id
      where p.store_id=$1 and p.is_current group by r.quality,r.missing_reasons`,[ids.store]
  )).rows[0]);
  assert.equal(saved.quality,'complete');
  assert.deepEqual(saved.missing_reasons,[]);
  assert.equal(saved.publications,1);
  assert.equal(saved.total,'-1404.3400');
  assert.deepEqual([saved.computations,saved.segments,saved.basis,saved.tax_evidence],[1,1,1,1]);
  const rebill=await context(async client=>(await client.query(
    `select count(*) filter(where f.result_scope_classification='reconciliation' and f.source_field='rebillLogisticCost')::int as components,
            (select count(*)::int from mc.result_lines l where l.store_id=$1 and l.category_code='rebill_logistic_compensation') as result_lines,
            (select count(*)::int from mc.data_issues i where i.store_id=$1 and i.report_normalization_id=n.id) as issues
       from mc.report_normalizations n join mc.operation_versions o on o.report_normalization_id=n.id
       join mc.financial_components f on f.operation_version_id=o.id
      where n.store_id=$1 and n.normalization_key like 'wb-finance-v13:%' group by n.id`,[ids.store]
  )).rows[0]);
  assert.deepEqual(rebill,{components:1,result_lines:0,issues:0});
});

test('compatibility bootstrap replays every current week until the first daily pointer exists',async t=>{
  const activeFetchJob=await context(async client=>(await client.query(
    `select job.id from mc.enqueue_job($1,'financial_report_fetch',$2,$3::jsonb,clock_timestamp(),100,5) job`,
    [ids.store,`bootstrap-active-pipeline:${randomUUID()}`,JSON.stringify({schemaVersion:1})]
  )).rows[0]);
  t.after(()=>context(client=>client.query(`delete from mc.jobs where id=$1`,[activeFetchJob.id])));
  const before=await getFinancialCompatibilityBootstrapState(ids.user,ids.store);
  assert.deepEqual(before.targets,[{periodStart:'2026-07-13',periodEnd:'2026-07-19'}]);
  assert.equal(before.waitingForPipeline,false);
  compatibilityV30=await runFinancialCalculation(ids.user,ids.store,{targetPeriod:before.targets[0]});
  assert.equal(compatibilityV30.changed,true);
  const repeated=await getFinancialCompatibilityBootstrapState(ids.user,ids.store);
  assert.deepEqual(repeated.targets,[{periodStart:'2026-07-13',periodEnd:'2026-07-19'}]);
});

test('completed compatibility calculation wakes the delayed daily shadow retry',async()=>{
  const delayed=await context(async client=>{
    const job=(await client.query(`update mc.jobs set available_at=clock_timestamp()+interval '15 minutes',
      last_error_code='financial_daily_publication_shadow_incompatible',updated_at=clock_timestamp()
      where id=(select id from mc.jobs where store_id=$1 and job_type='financial_dates_recalculate' and status='pending'
        order by created_at limit 1) returning id,available_at`,[ids.store])).rows[0];
    assert.ok(job?.id);
    await client.query(`update mc.job_dispatch set available_at=$2 where job_id=$1`,[job.id,job.available_at]);
    return job;
  });
  const awakened=await wakeFinancialDailyAfterCompatibility(ids.user,ids.store);
  assert.equal(awakened.id,delayed.id);
  const state=await context(async client=>(await client.query(`select job.available_at,dispatch.available_at dispatch_available_at
    from mc.jobs job join mc.job_dispatch dispatch on dispatch.job_id=job.id where job.id=$1`,[delayed.id])).rows[0]);
  assert.ok(new Date(state.available_at)<new Date(delayed.available_at));
  assert.equal(new Date(state.dispatch_available_at).getTime(),new Date(state.available_at).getTime());
});

test('daily shadow generation rebuilds saved inputs and matches the exact published week without WB fetches',async()=>{
  const workerId=`daily-integration:${randomUUID()}`;
  const drainDaily=async()=>{
    let processed=0;
    for(;processed<10;processed+=1){
      const[job]=await jobsRepository.claimJobs({workerId,jobTypes:['financial_dates_recalculate'],leaseSeconds:300,limit:1});
      if(!job)break;
      const result=await financialDailyGenerationRepository.build(job.id,job.lease_token,workerId);
      await jobsRepository.completeJob({jobId:job.id,leaseToken:job.lease_token,workerId,outcome:result.superseded?'superseded':'completed'});
    }
    assert.ok(processed<10,'daily queue must drain');
  };
  const compatibilityRun=compatibilityV30;
  assert.ok(compatibilityRun?.runId);
  await drainDaily();
  const initialPointer=await context(async client=>(await client.query(
    `select p.id,p.publication_no,count(d.accounting_date)::int mapped_days
       from mc.financial_daily_current_publications current
       join mc.financial_daily_publications p on p.id=current.publication_id
       join mc.financial_daily_publication_days d on d.publication_id=p.id
      where current.store_id=$1 group by p.id,p.publication_no`,[ids.store]
  )).rows[0]);
  assert.equal(Number(initialPointer.publication_no),1);
  assert.equal(initialPointer.mapped_days,7);
  const initialPublished=await getPublishedFinancialPeriod(ids.user,ids.store,'2026-07-13','2026-07-19');
  assert.equal(initialPublished.publication_source,'daily');
  assert.equal(initialPublished.publication_id,initialPointer.id);
  assert.equal(initialPublished.quality,'complete');
  assert.deepEqual(initialPublished.covered_period,{start:'2026-07-13',end:'2026-07-19'});
  assert.equal(initialPublished.totals.availableResultAfterTax,'-1404.3400');
  const firstEvent=await context(async client=>(await client.query(
    `select e.* from mc.publications p
       join mc.calculation_runs r on r.id=p.run_id
       cross join lateral mc.emit_financial_input_event(
         p.store_id,$2,'shadow_backfill',r.period_start,'2026-07-15',
         p_source_result_method_version_id=>r.method_version_id
       ) e
      where p.store_id=$1 and p.is_current`,[ids.store,`daily-shadow:${randomUUID()}`]
  )).rows[0]);
  const emitted=await context(async client=>(await client.query(
    `select e.* from mc.publications p
       join mc.calculation_runs r on r.id=p.run_id
       cross join lateral mc.emit_financial_input_event(
         p.store_id,$2,'shadow_backfill','2026-07-16',r.period_end,
         p_source_result_method_version_id=>r.method_version_id
       ) e
      where p.store_id=$1 and p.is_current`,[ids.store,`daily-shadow:${randomUUID()}`]
  )).rows[0]);
  assert.equal(firstEvent.dispatch_job_id,emitted.dispatch_job_id);
  assert.ok(emitted.id);
  await drainDaily();

  const saved=await context(async client=>(await client.query(
    `select g.status,g.quality,count(distinct d.accounting_date)::int days,
            count(distinct t.id)::int tax_facts,count(distinct te.id)::int tax_evidence,
            c.status comparison_status,
            (select count(*)::int from mc.jobs where store_id=$1 and job_type='financial_report_fetch') fetch_jobs
       from mc.financial_daily_generations g
       join mc.financial_input_events e on e.dispatch_job_id=g.job_id and e.event_generation=g.source_event_generation
       join mc.financial_daily_days d on d.generation_id=g.id
       left join mc.financial_daily_tax_facts t on t.generation_id=g.id
       left join mc.financial_daily_tax_evidence te on te.tax_fact_id=t.id
       left join mc.financial_daily_shadow_comparisons c on c.generation_id=g.id
      where e.id=$2
      group by g.status,g.quality,c.status`,[ids.store,emitted.id]
  )).rows[0]);
  assert.deepEqual(saved,{status:'succeeded',quality:'complete',days:7,tax_facts:1,tax_evidence:1,comparison_status:'matched',fetch_jobs:0});

  const firstPointer=await context(async client=>(await client.query(
    `select p.id,p.publication_no,count(d.accounting_date)::int mapped_days
       from mc.financial_daily_current_publications current
       join mc.financial_daily_publications p on p.id=current.publication_id
       join mc.financial_daily_publication_days d on d.publication_id=p.id
      where current.store_id=$1 group by p.id,p.publication_no`,[ids.store]
  )).rows[0]);
  assert.equal(Number(firstPointer.publication_no),2);
  assert.equal(firstPointer.mapped_days,7);
  const published=await getPublishedFinancialPeriod(ids.user,ids.store,'2026-07-13','2026-07-19');
  assert.equal(published.publication_source,'daily');
  assert.equal(published.publication_id,firstPointer.id);
  assert.equal(published.quality,'complete');
  assert.deepEqual(published.covered_period,{start:'2026-07-13',end:'2026-07-19'});
  assert.equal(published.totals.availableResultAfterTax,'-1404.3400');

  const partialEvent=await context(async client=>(await client.query(
    `select event.* from mc.method_versions method
       cross join lateral mc.emit_financial_input_event(
         $1,$2,'shadow_backfill','2026-07-15','2026-07-15',p_source_result_method_version_id=>method.id
       ) event where method.code='financial_result' and method.version_no=30`,
    [ids.store,`daily-partial:${randomUUID()}`]
  )).rows[0]);
  assert.ok(partialEvent.dispatch_job_id);
  await drainDaily();
  const secondPointer=await context(async client=>(await client.query(
    `select p.id,p.publication_no,
            count(*) filter(where d.generation_id=p.generation_id)::int replaced_days,
            count(*) filter(where d.generation_id<>p.generation_id)::int carried_days
       from mc.financial_daily_current_publications current
       join mc.financial_daily_publications p on p.id=current.publication_id
       join mc.financial_daily_publication_days d on d.publication_id=p.id
      where current.store_id=$1 group by p.id,p.publication_no,p.generation_id`,[ids.store]
  )).rows[0]);
  assert.equal(Number(secondPointer.publication_no),3);
  assert.deepEqual([secondPointer.replaced_days,secondPointer.carried_days],[1,6]);
  const republished=await getPublishedFinancialPeriod(ids.user,ids.store,'2026-07-13','2026-07-19');
  assert.equal(republished.publication_source,'daily');
  assert.equal(republished.publication_id,secondPointer.id);
  assert.equal(republished.totals.availableResultAfterTax,'-1404.3400');

  const retryEvent=await context(async client=>(await client.query(
    `select event.* from mc.method_versions method
       cross join lateral mc.emit_financial_input_event(
         $1,$2,'shadow_backfill','2026-07-16','2026-07-16',p_source_result_method_version_id=>method.id
       ) event where method.code='financial_result' and method.version_no=30`,
    [ids.store,`daily-retry:${randomUUID()}`]
  )).rows[0]);
  await context(async client=>{
    await client.query(`delete from mc.job_dispatch where job_id=$1`,[retryEvent.dispatch_job_id]);
    await client.query(`update mc.jobs set status='failed',attempt_count=max_attempts,finished_at=now(),last_error_code='forced_test_failure'
      where id=$1`,[retryEvent.dispatch_job_id]);
  });
  const retried=await retryFinancialDailyPublication(ids.user,ids.store,'2026-07-16','2026-07-16');
  assert.equal(retried.id,retryEvent.dispatch_job_id);
  assert.equal(Number(retried.attempt_count),0);
  const[retryJob]=await jobsRepository.claimJobs({workerId,jobTypes:['financial_dates_recalculate'],leaseSeconds:300,limit:1});
  assert.equal(retryJob.id,retryEvent.dispatch_job_id);
  const retryResult=await financialDailyGenerationRepository.build(retryJob.id,retryJob.lease_token,workerId);
  assert.equal(retryResult.superseded,false);
  await jobsRepository.completeJob({jobId:retryJob.id,leaseToken:retryJob.lease_token,workerId,outcome:'completed'});
});

test('verified 07-13 store sources do not create product-link issues and no-sale SKU persists zero tax',async()=>{
  const scope={user:randomUUID(),business:randomUUID(),store:randomUUID()};
  const scoped=async action=>{
    const client=await pool.connect();
    try{
      await client.query('begin');
      await client.query("select set_config('app.user_id',$1,true),set_config('app.business_id',$2,true)",[scope.user,scope.business]);
      const value=await action(client);await client.query('commit');return value;
    }catch(error){await client.query('rollback');throw error;}finally{client.release();}
  };
  const fixture=await scoped(async client=>{
    await client.query(`insert into mc.users(id,display_name) values($1,'Verified store owner')`,[scope.user]);
    await client.query(`insert into mc.businesses(id,name) values($1,'Verified store business')`,[scope.business]);
    await client.query(`insert into mc.memberships(business_id,user_id,role) values($1,$2,'owner')`,[scope.business,scope.user]);
    await client.query(`insert into mc.stores(id,business_id,external_account_id,name,status) values($1,$2,'verified-store','Verified store','active')`,[scope.store,scope.business]);
    const catalog=(await client.query(`insert into mc.source_documents(business_id,store_id,origin,document_type,checksum,completeness) values($1,$2,'wb_api','catalog','verified-store-catalog','complete') returning id`,[scope.business,scope.store])).rows[0];
    const products=[];
    for(const [article,seller] of [[720001,'SALE'],[720002,'NO-SALE']])products.push((await client.query(
      `insert into mc.products(business_id,store_id,wb_article,seller_article) values($1,$2,$3,$4) returning id`,[scope.business,scope.store,article,seller]
    )).rows[0]);
    const variant=(await client.query(`insert into mc.variants(business_id,store_id,product_id,external_variant_id) values($1,$2,$3,'default') returning id`,[scope.business,scope.store,products[0].id])).rows[0];
    await client.query(`insert into mc.variant_identifiers(business_id,store_id,variant_id,identifier_type,identifier_value) values($1,$2,$3,'barcode','4720000000001')`,[scope.business,scope.store,variant.id]);
    await client.query(`select mc.confirm_product_selection($1,$2,$3::uuid[])`,[scope.store,catalog.id,products.map(product=>product.id)]);
    const cost=(await client.query(`insert into mc.variant_costs(business_id,store_id,product_id,variant_id,effective_from) values($1,$2,$3,$4,'2026-09-01') returning id`,[scope.business,scope.store,products[0].id,variant.id])).rows[0];
    const costVersion=(await client.query(`insert into mc.cost_versions(business_id,store_id,cost_id,version_no,unit_cost,origin,changed_by) values($1,$2,$3,1,40,'manual',$4) returning id`,[scope.business,scope.store,cost.id,scope.user])).rows[0];
    await client.query(`update mc.variant_costs set current_version_id=$1 where id=$2`,[costVersion.id,cost.id]);
    const setting=(await client.query(`insert into mc.tax_settings(business_id,effective_from) values($1,'2026-01-01') returning id`,[scope.business])).rows[0];
    const tax=(await client.query(`insert into mc.tax_setting_versions(business_id,tax_setting_id,version_no,regime_code,usn_rate_fraction,vat_mode,changed_by) values($1,$2,1,'usn_income',0.06,'exempt',$3) returning id`,[scope.business,setting.id,scope.user])).rows[0];
    await client.query(`update mc.tax_settings set current_version_id=$1 where id=$2`,[tax.id,setting.id]);
    const stream=(await client.query(`insert into mc.sync_streams(business_id,store_id,source_type,status) values($1,$2,'financial_reports','active') returning id`,[scope.business,scope.store])).rows[0];
    const run=(await client.query(`insert into mc.sync_runs(business_id,store_id,stream_id,requested_from,requested_to,status,started_at) values($1,$2,$3,'2026-09-07','2026-09-13','running',now()) returning id`,[scope.business,scope.store,stream.id])).rows[0];
    return{productIds:products.map(product=>product.id),streamId:stream.id,runId:run.id};
  });
  const rows=[
    {externalRowKey:'sale',rowChecksum:'verified-sale',rawData:{reportId:9200,rrDate:'2026-09-08',docTypeName:'Продажа',sellerOperName:'Продажа',nmId:720001,sku:'4720000000001',quantity:1,retailAmount:'100',forPay:'100'}},
    {externalRowKey:'storage',rowChecksum:'verified-storage',rawData:{reportId:9200,rrDate:'2026-09-09',docTypeName:'',sellerOperName:'Хранение',nmId:0,paidStorage:'5.51'}},
    {externalRowKey:'promotion',rowChecksum:'verified-promotion',rawData:{reportId:9200,rrDate:'2026-09-10',docTypeName:'',sellerOperName:'Удержание',bonusTypeName:'Оказание услуг «WB Продвижение», документ №315213683',nmId:0,deduction:'304'}},
    {externalRowKey:'loyalty',rowChecksum:'verified-loyalty',rawData:{reportId:9200,rrDate:'2026-09-10',docTypeName:'Продажа',sellerOperName:'Компенсация скидки по программе лояльности',nmId:720001,cashbackDiscount:'2'}},
    {externalRowKey:'pvz',rowChecksum:'verified-pvz',rawData:{reportId:9200,rrDate:'2026-09-11',docTypeName:'Продажа',sellerOperName:'Возмещение за выдачу и возврат товаров на ПВЗ',nmId:0,ppvzReward:'16.2900',vw:'-13.3522',vwNds:'-2.9400'}},
    {externalRowKey:'transport-reimbursement',rowChecksum:'verified-transport-reimbursement',rawData:{reportId:9200,rrDate:'2026-09-12',docTypeName:'',sellerOperName:'Возмещение издержек по перевозке/по складским операциям с товаром',nmId:720001,sku:'4720000000001',rebillLogisticCost:'18.97501',vw:'-15.5470',vwNds:'-3.42901'}}
  ];
  await completeFinancialSync(scope.user,{business_id:scope.business,store_id:scope.store,stream_id:fixture.streamId,run_id:fixture.runId,date_from:'2026-09-07',date_to:'2026-09-13'},
    {documentId:randomUUID(),reports:[{externalReportId:'9200',periodStart:'2026-09-07',periodEnd:'2026-09-13',checksum:'verified-store-report',rows}]});
  const calculated=await runFinancialCalculation(scope.user,scope.store);
  assert.equal(calculated.quality,'complete');
  assert.deepEqual(calculated.missingReasons,[]);
  // Storage -5.51, promotion -304, PVZ -16.29+13.3522+2.94=+0.0022.
  // Transport -18.97501+15.547+3.42901=+0.001 rounds to zero kopecks
  // and is reconciliation only; PVZ has no payout row to justify rounding.
  assert.equal(calculated.totals.storeLevelResultBeforeTax,'-309.5078');
  assert.equal(calculated.totals.availableResultBeforeTax,'-249.5078');
  assert.equal(calculated.totals.availableResultAfterTax,'-255.5078');
  const persisted=await scoped(async client=>({
    issues:(await client.query(`select code from mc.data_issues where store_id=$1 and status='open' and code in('financial_operation_unclassified','financial_components_unverified','financial_product_not_in_catalog')`,[scope.store])).rows,
    tax:(await client.query(`select product_id,taxable_base::text,tax_amount::text from mc.tax_computations where run_id=$1 order by product_id`,[calculated.runId])).rows,
    loyaltyComponents:(await client.query(`select f.amount_signed::text,f.result_scope_classification from mc.financial_components f join mc.operation_versions o on o.id=f.operation_version_id where o.report_normalization_id in(select report_normalization_id from mc.calculation_inputs where run_id=$1) and f.category_code='loyalty_discount_reference'`,[calculated.runId])).rows,
    loyaltyResultLines:(await client.query(`select amount_signed::text,result_scope from mc.result_lines where run_id=$1 and category_code in('loyalty_compensation','loyalty_discount_reference')`,[calculated.runId])).rows,
    transport:(await client.query(`select sum(f.amount_signed)::text exact_sum,round(sum(f.amount_signed),2)::text kopeck_sum,
      count(*)::int components,count(e.id)::int result_evidence
      from mc.financial_components f join mc.operation_versions o on o.id=f.operation_version_id
      join mc.report_rows row on row.id=o.report_row_id
      left join mc.result_evidence e on e.financial_component_id=f.id
      left join mc.result_lines line on line.id=e.result_line_id and line.run_id=$1
      where o.report_normalization_id in(select report_normalization_id from mc.calculation_inputs where run_id=$1)
        and row.external_row_key='transport-reimbursement'`,[calculated.runId])).rows[0]
  }));
  assert.deepEqual(persisted.issues,[]);
  assert.deepEqual(persisted.loyaltyComponents,[{amount_signed:'2',result_scope_classification:'reconciliation'}]);
  assert.deepEqual(persisted.loyaltyResultLines,[]);
  assert.deepEqual(persisted.transport,{exact_sum:'0.00100',kopeck_sum:'0.00',components:3,result_evidence:0});
  assert.equal(persisted.tax.length,2);
  assert.deepEqual(persisted.tax.find(row=>row.product_id===fixture.productIds[1]),{product_id:fixture.productIds[1],taxable_base:'0.0000',tax_amount:'0.0000'});
});

test('financial sync reselects a previously accepted checksum without duplicating its version',async()=>{
  const fixture=await context(async client=>{
    await client.query(`insert into mc.sync_streams(business_id,store_id,source_type) values($1,$2,'financial_reports') on conflict(store_id,source_type) do nothing`,[ids.business,ids.store]);
    const stream=(await client.query(`select id from mc.sync_streams where store_id=$1 and source_type='financial_reports'`,[ids.store])).rows[0];
    const document=(await client.query(
      `insert into mc.source_documents(business_id,store_id,origin,document_type,checksum,completeness)
       values($1,$2,'wb_api','weekly_realization','p03-reselect-source','complete') returning id`,
      [ids.business,ids.store]
    )).rows[0];
    const report=(await client.query(
      `insert into mc.reports(business_id,store_id,external_report_id,report_type,period_start,period_end)
       values($1,$2,'p03-reselect','weekly_realization','2026-08-10','2026-08-16') returning id`,
      [ids.business,ids.store]
    )).rows[0];
    const versions=[];
    for(const [number,checksum] of [[1,'p03-old-checksum'],[2,'p03-new-checksum']]){
      const version=(await client.query(
        `insert into mc.report_versions(business_id,store_id,report_id,document_id,version_no,checksum,parser_version)
         values($1,$2,$3,$4,$5,$6,'wb-finance-v13') returning id`,
        [ids.business,ids.store,report.id,document.id,number,checksum]
      )).rows[0];
      await client.query(`update mc.report_versions set status='validated' where id=$1`,[version.id]);
      await client.query(`update mc.report_versions set status='accepted',accepted_at=now() where id=$1`,[version.id]);
      versions.push(version.id);
    }
    const method=(await client.query(
      `select id from mc.method_versions where code='wb_finance_import' and implementation_version='wb-finance-v13'`
    )).rows[0];
    await client.query(
      `insert into mc.report_normalizations(business_id,store_id,report_version_id,method_version_id,normalization_key,status)
       values($1,$2,$3,$4,$5,'succeeded')`,
      [ids.business,ids.store,versions[0],method.id,`wb-finance-v13:${versions[0]}`]
    );
    await client.query(`update mc.reports set current_version_id=$1 where id=$2`,[versions[1],report.id]);
    return {streamId:stream.id,reportId:report.id,oldVersionId:versions[0]};
  });
  const source={externalReportId:'p03-reselect',periodStart:'2026-08-10',periodEnd:'2026-08-16',checksum:'p03-old-checksum',rows:[]};
  const run=async()=>{
    const runId=await context(async client=>(await client.query(
      `insert into mc.sync_runs(business_id,store_id,stream_id,requested_from,requested_to,status,started_at)
       values($1,$2,$3,'2026-08-10','2026-08-16','running',now()) returning id`,
      [ids.business,ids.store,fixture.streamId]
    )).rows[0].id);
    return completeFinancialSync(ids.user,{
      business_id:ids.business,store_id:ids.store,stream_id:fixture.streamId,run_id:runId,
      date_from:'2026-08-10',date_to:'2026-08-16'
    },{documentId:randomUUID(),reports:[source]});
  };
  const first=await run();
  assert.equal(first.reselectedReports,1);
  assert.equal(first.insertedReports,0);
  const second=await run();
  assert.equal(second.reselectedReports,0);
  assert.equal(second.unchangedReports,1);
  const saved=await context(async client=>(await client.query(
    `select r.current_version_id,count(v.id)::int as versions
       from mc.reports r join mc.report_versions v on v.report_id=r.id
      where r.id=$1 group by r.current_version_id`,[fixture.reportId]
  )).rows[0]);
  assert.equal(saved.current_version_id,fixture.oldVersionId);
  assert.equal(saved.versions,2);
});

test('historical check advances only after a complete weekly sync and preserves recent cursor',async()=>{
  const legacy=await context(async client=>{
    const connection=(await client.query(
      `insert into mc.connections(business_id,store_id,secret_ref,status) values($1,$2,'p03-history','active') returning id`,
      [ids.business,ids.store]
    )).rows[0];
    await client.query(
      `insert into mc.connection_secrets(business_id,connection_id,ciphertext,nonce,auth_tag)
       values($1,$2,decode('00','hex'),decode(repeat('00',12),'hex'),decode(repeat('00',16),'hex'))`,
      [ids.business,connection.id]
    );
    const document=(await client.query(
      `insert into mc.source_documents(business_id,store_id,origin,document_type,checksum,completeness)
       values($1,$2,'wb_api','weekly_realization','p03-history-legacy','complete') returning id`,[ids.business,ids.store]
    )).rows[0];
    const report=(await client.query(
      `insert into mc.reports(business_id,store_id,external_report_id,report_type,period_start,period_end)
       values($1,$2,'p03-history-legacy','weekly_realization','2026-08-17','2026-08-23') returning id`,[ids.business,ids.store]
    )).rows[0];
    const version=(await client.query(
      `insert into mc.report_versions(business_id,store_id,report_id,document_id,version_no,checksum,parser_version)
       values($1,$2,$3,$4,1,'p03-history-legacy','wb-finance-v2') returning id`,[ids.business,ids.store,report.id,document.id]
    )).rows[0];
    await client.query(`update mc.report_versions set status='validated' where id=$1`,[version.id]);
    await client.query(`update mc.report_versions set status='accepted',accepted_at=now() where id=$1`,[version.id]);
    await client.query(`update mc.reports set current_version_id=$1 where id=$2`,[version.id,report.id]);
    const oldMethod=(await client.query(
      `select id from mc.method_versions where code='wb_finance_import' and implementation_version='wb-finance-v2'`
    )).rows[0];
    await client.query(
      `insert into mc.report_normalizations(business_id,store_id,report_version_id,method_version_id,normalization_key,status)
       values($1,$2,$3,$4,$5,'succeeded')`,[ids.business,ids.store,version.id,oldMethod.id,`wb-finance-v2:${version.id}`]
    );
    return{versionId:version.id};
  });
  const ranges={initialRange:{dateFrom:'2026-06-01',dateTo:'2026-09-21'},recentRange:{dateFrom:'2026-09-21',dateTo:'2026-09-24'}};
  const first=await beginFinancialSync(ids.user,ids.store,{force:true,historical:true,...ranges});
  assert.equal(first.started,true);
  assert.deepEqual([first.date_from,first.date_to],['2026-08-17','2026-08-23']);
  await failFinancialSync(ids.user,first,'financial_invalid_request');
  await context(async client=>{
    const currentMethod=(await client.query(
      `select id from mc.method_versions where code='wb_finance_import' and implementation_version='wb-finance-v13'`
    )).rows[0];
    await client.query(
      `insert into mc.report_normalizations(business_id,store_id,report_version_id,method_version_id,normalization_key,status)
       values($1,$2,$3,$4,$5,'succeeded')`,[ids.business,ids.store,legacy.versionId,currentMethod.id,`wb-finance-v13:${legacy.versionId}`]
    );
  });
  const second=await beginFinancialSync(ids.user,ids.store,{force:true,historical:true,...ranges});
  assert.deepEqual([second.date_from,second.date_to],['2026-08-10','2026-08-16']);
  await failFinancialSync(ids.user,second,'financial_invalid_request');
  const third=await beginFinancialSync(ids.user,ids.store,{force:true,historical:true,...ranges});
  assert.deepEqual([third.date_from,third.date_to],['2026-08-10','2026-08-16']);
  await completeFinancialSync(ids.user,third,{documentId:randomUUID(),reports:[]});
  const cursor=await context(async client=>(await client.query(
    `select cursor from mc.sync_streams where business_id=$1 and store_id=$2 and source_type='financial_reports'`,
    [ids.business,ids.store]
  )).rows[0].cursor);
  assert.equal(cursor.historicalWeekStart,'2026-08-10');
  assert.equal(cursor.dateTo,'2026-08-16');
});

test('superseded financial run cannot change versions, coverage, or historical cursor',async()=>{
  const ranges={initialRange:{dateFrom:'2026-06-01',dateTo:'2026-09-21'},recentRange:{dateFrom:'2026-09-21',dateTo:'2026-09-24'}};
  const old=await beginFinancialSync(ids.user,ids.store,{force:true,historical:true,...ranges});
  assert.equal(old.started,true);
  await context(client=>client.query(`update mc.sync_runs set started_at=now()-interval '4 hours' where id=$1`,[old.run_id]));
  const replacement=await beginFinancialSync(ids.user,ids.store,{force:true,historical:true,...ranges});
  assert.equal(replacement.started,true);
  assert.deepEqual([replacement.date_from,replacement.date_to],[old.date_from,old.date_to]);
  const state=()=>context(async client=>(await client.query(
    `select (select current_version_id from mc.reports where store_id=$1 and external_report_id='p03-reselect') as version_id,
            (select count(*)::int from mc.report_versions where report_id=(select id from mc.reports where store_id=$1 and external_report_id='p03-reselect')) as version_count,
            (select count(*)::int from mc.source_documents where store_id=$1 and sync_run_id=$4) as source_count,
            (select count(*)::int from mc.coverage_intervals where store_id=$1 and stream_id=$2) as coverage_count,
            (select cursor from mc.sync_streams where id=$2) as cursor,
            (select status from mc.sync_streams where id=$2) as stream_status,
            (select status from mc.sync_runs where id=$3) as replacement_status`,
    [ids.store,old.stream_id,replacement.run_id,old.run_id]
  )).rows[0]);
  const before=await state();
  await assert.rejects(
    ()=>completeFinancialSync(ids.user,old,{documentId:randomUUID(),reports:[{
      externalReportId:'p03-reselect',periodStart:'2026-08-10',periodEnd:'2026-08-16',checksum:'p03-new-checksum',rows:[]
    }]}),
    /financial_sync_superseded/
  );
  await failFinancialSync(ids.user,old,'financial_unauthorized');
  assert.deepEqual(await state(),before);
  await failFinancialSync(ids.user,replacement,'financial_unavailable');
});

test('bank control stores a versioned summary without changing product profit',async()=>{
  const before=await getPublishedFinancialPeriod(ids.user,ids.store,'2026-07-13','2026-07-19');
  const sync=await context(async client=>{
    const stream=(await client.query(`select id from mc.sync_streams where store_id=$1 and source_type='financial_reports'`,[ids.store])).rows[0];
    const run=(await client.query(`insert into mc.sync_runs(business_id,store_id,stream_id,requested_from,requested_to,status,started_at) values($1,$2,$3,'2026-07-13','2026-07-19','running',now()) returning id`,[ids.business,ids.store,stream.id])).rows[0];
    return {business_id:ids.business,store_id:ids.store,stream_id:stream.id,run_id:run.id,date_from:'2026-07-13',date_to:'2026-07-19'};
  });
  const summary={reportId:785995400,reportType:1,currency:'RUB',dateFrom:'2026-07-13',dateTo:'2026-07-19',forPaySum:'100',deliveryServiceSum:'0',paidStorageSum:'0',paidAcceptanceSum:'0',deductionSum:'0',penaltySum:'0',additionalPaymentSum:'0',cashbackAmountSum:'0',cashbackDiscountSum:'0',cashbackCommissionChangeSum:'0',bankPaymentSum:'100'};
  const source={externalReportId:'785995400',periodStart:'2026-07-13',periodEnd:'2026-07-19',checksum:'p03-v1',rows:[{externalRowKey:'1',rowChecksum:'p03-row',rawData:{docTypeName:'Продажа',sellerOperName:'Продажа',rrDate:'2026-07-15',nmId:700001,sku:'4600000000001',quantity:1,retailAmount:'100',forPay:'100'}}]};
  const saved=await completeFinancialSync(ids.user,sync,{documentId:randomUUID(),reports:[source],summaries:new Map([['785995400',{rawData:summary,checksum:'p03-summary-v1'}]])});
  assert.equal(saved.bankChecks.passed,1);
  const state=await getFinancialBankReconciliationState(ids.user,ids.store);
  assert.equal(state.passed,1);
  await runFinancialCalculation(ids.user,ids.store);
  const current=await getPublishedFinancialPeriod(ids.user,ids.store,'2026-07-13','2026-07-19');
  assert.equal(current.taxReference.scope,'selected_products');
  assert.equal(current.taxReference.includedInResult,true);
  assert.equal(current.taxReference.estimatedTax,'6.0000');
  assert.ok(!current.taxReference.missingReasons.includes('tax_source_unlinked'));
  assert.deepEqual(current.totals,before.totals);
  const snapshot=await context(async client=>(await client.query(`select s.id,s.raw_data->>'bankPaymentSum' as bank_payment from mc.financial_report_summary_versions s where s.store_id=$1`,[ids.store])).rows[0]);
  assert.equal(snapshot.bank_payment,'100');
  await assert.rejects(()=>context(client=>client.query(`update mc.financial_report_summary_versions set raw_data='{}' where id=$1`,[snapshot.id])),/immutable/);
});

test('P0.3 persists exact weekly results, links return cost fail-closed and isolates full-report reference',async()=>{
  const isolated={user:randomUUID(),business:randomUUID(),store:randomUUID()};
  const isolatedContext=async action=>{
    const client=await pool.connect();
    try{
      await client.query('begin');
      await client.query("select set_config('app.user_id',$1,true),set_config('app.business_id',$2,true)",[isolated.user,isolated.business]);
      const value=await action(client);await client.query('commit');return value;
    }catch(error){await client.query('rollback');throw error;}finally{client.release();}
  };
  const fixture=await isolatedContext(async client=>{
    await client.query(`insert into mc.users(id,display_name) values($1,'P03 weekly owner')`,[isolated.user]);
    await client.query(`insert into mc.businesses(id,name) values($1,'P03 weekly business')`,[isolated.business]);
    await client.query(`insert into mc.memberships(business_id,user_id,role) values($1,$2,'owner')`,[isolated.business,isolated.user]);
    await client.query(`insert into mc.stores(id,business_id,external_account_id,name,status) values($1,$2,'p03-weekly','P03 weekly store','active')`,[isolated.store,isolated.business]);
    const catalog=(await client.query(`insert into mc.source_documents(business_id,store_id,origin,document_type,checksum,completeness) values($1,$2,'wb_api','catalog','p03-weekly-catalog','complete') returning id`,[isolated.business,isolated.store])).rows[0];
    const product=(await client.query(`insert into mc.products(business_id,store_id,wb_article,seller_article) values($1,$2,710001,'P03-W') returning id`,[isolated.business,isolated.store])).rows[0];
    const variant=(await client.query(`insert into mc.variants(business_id,store_id,product_id,external_variant_id) values($1,$2,$3,'default') returning id`,[isolated.business,isolated.store,product.id])).rows[0];
    await client.query(`insert into mc.variant_identifiers(business_id,store_id,variant_id,identifier_type,identifier_value) values($1,$2,$3,'barcode','4710000000001')`,[isolated.business,isolated.store,variant.id]);
    await client.query(`select mc.confirm_product_selection($1,$2,$3::uuid[])`,[isolated.store,catalog.id,[product.id]]);
    const cost=(await client.query(`insert into mc.variant_costs(business_id,store_id,product_id,variant_id,effective_from) values($1,$2,$3,$4,'2026-07-01') returning id`,[isolated.business,isolated.store,product.id,variant.id])).rows[0];
    const costVersion=(await client.query(`insert into mc.cost_versions(business_id,store_id,cost_id,version_no,unit_cost,origin,changed_by) values($1,$2,$3,1,40,'manual',$4) returning id`,[isolated.business,isolated.store,cost.id,isolated.user])).rows[0];
    await client.query(`update mc.variant_costs set current_version_id=$1 where id=$2`,[costVersion.id,cost.id]);
    const setting=(await client.query(`insert into mc.tax_settings(business_id,effective_from) values($1,'2026-01-01') returning id`,[isolated.business])).rows[0];
    const tax=(await client.query(`insert into mc.tax_setting_versions(business_id,tax_setting_id,version_no,regime_code,usn_rate_fraction,vat_mode,changed_by) values($1,$2,1,'usn_income',0.06,'exempt',$3) returning id`,[isolated.business,setting.id,isolated.user])).rows[0];
    await client.query(`update mc.tax_settings set current_version_id=$1 where id=$2`,[tax.id,setting.id]);
    const stream=(await client.query(`insert into mc.sync_streams(business_id,store_id,source_type,status) values($1,$2,'financial_reports','active') returning id`,[isolated.business,isolated.store])).rows[0];
    const run=(await client.query(`insert into mc.sync_runs(business_id,store_id,stream_id,requested_from,requested_to,status,started_at) values($1,$2,$3,'2026-08-03','2026-08-16','running',now()) returning id`,[isolated.business,isolated.store,stream.id])).rows[0];
    return{productId:product.id,variantId:variant.id,streamId:stream.id,runId:run.id};
  });
  // Sale payout 200-10=190; return payout 100-10=90. Keep the second return
  // above the remaining sold quantity so return COGS still fails closed.
  const sale={reportId:9001,docTypeName:'Продажа',sellerOperName:'Продажа',rrDate:'2026-08-03',saleDt:'2026-08-03T10:00:00Z',orderDt:'2026-08-02T10:00:00Z',srid:'shared-order',shkId:'shared-shk',nmId:710001,sku:'4710000000001',quantity:2,retailAmount:'200',forPay:'190',vw:'10'};
  const unmatched={reportId:9001,docTypeName:'Продажа',sellerOperName:'Продажа',rrDate:'2026-08-04',saleDt:'2026-08-04T10:00:00Z',orderDt:'2026-08-04T09:00:00Z',srid:'missing-product',shkId:'missing-product',quantity:1,retailAmount:'5',forPay:'5'};
  const returned={reportId:9002,docTypeName:'Возврат',sellerOperName:'Возврат',rrDate:'2026-08-05',saleDt:'2026-08-05T10:00:00Z',orderDt:'2026-08-02T10:00:00Z',srid:'shared-order',shkId:'shared-shk',nmId:710001,sku:'4710000000001',quantity:1,retailAmount:'100',forPay:'90',vw:'10'};
  const excessiveReturn={...returned,rrDate:'2026-08-06',saleDt:'2026-08-06T10:00:00Z',quantity:2,retailAmount:'200',forPay:'180',vw:'20'};
  const secondWeek={reportId:9003,docTypeName:'Продажа',sellerOperName:'Продажа',rrDate:'2026-08-10',saleDt:'2026-08-10T10:00:00Z',orderDt:'2026-08-09T10:00:00Z',srid:'week-two',shkId:'week-two',nmId:710001,sku:'4710000000001',quantity:1,retailAmount:'100',forPay:'100'};
  await completeFinancialSync(isolated.user,{business_id:isolated.business,store_id:isolated.store,stream_id:fixture.streamId,run_id:fixture.runId,date_from:'2026-08-03',date_to:'2026-08-16'},
    {documentId:randomUUID(),reports:[
      {externalReportId:'9001',periodStart:'2026-08-03',periodEnd:'2026-08-09',checksum:'week-one-sale',rows:[{externalRowKey:'sale',rowChecksum:'sale',rawData:sale},{externalRowKey:'unmatched',rowChecksum:'unmatched',rawData:unmatched}]},
      {externalReportId:'9002',periodStart:'2026-08-03',periodEnd:'2026-08-09',checksum:'week-one-return',rows:[{externalRowKey:'return',rowChecksum:'return',rawData:returned},{externalRowKey:'excessive-return',rowChecksum:'excessive-return',rawData:excessiveReturn}]},
      {externalReportId:'9003',periodStart:'2026-08-10',periodEnd:'2026-08-16',checksum:'week-two',rows:[{externalRowKey:'sale',rowChecksum:'week-two-sale',rawData:secondWeek}]}
    ],summaries:new Map([['9003',{checksum:'p03-cross-border',rawData:{reportId:'9003',reportType:2,country:'Армения'}}]])});
  await assert.rejects(()=>isolatedContext(async client=>{
    const rows=(await client.query(`select o.id,o.operation_type from mc.operation_versions o join mc.report_rows rr on rr.id=o.report_row_id where rr.raw_data->>'srid'='shared-order' order by o.accounting_date,o.id`)).rows;
    const method=(await client.query(`select id from mc.method_versions where code='financial_result' and version_no=5`)).rows[0];
    return client.query(`insert into mc.operation_links(business_id,store_id,from_operation_version_id,to_operation_version_id,link_type,status,method_version_id)
      values($1,$2,$3,$4,'return_to_original_sale','confirmed',$5)`,[isolated.business,isolated.store,rows.find(row=>row.operation_type==='sale').id,rows.find(row=>row.operation_type==='return').id,method.id]);
  }),/confirmed return link/);
  const calculated=await runFinancialCalculation(isolated.user,isolated.store);
  assert.equal(calculated.changed,true);
  const first=await getPublishedFinancialPeriod(isolated.user,isolated.store,'2026-08-03','2026-08-09');
  const second=await getPublishedFinancialPeriod(isolated.user,isolated.store,'2026-08-10','2026-08-16');
  assert.equal(first.quality,'partial');
  assert.ok(first.missing_reasons.includes('product_link_missing')||first.missing_reasons.includes('tax_source_unlinked'));
  assert.equal(second.quality,'complete');
  assert.deepEqual(second.missing_reasons,[]);
  assert.equal(second.totals.availableResultAfterTax,'54.0000');
  const combined=await getPublishedFinancialPeriod(isolated.user,isolated.store,'2026-08-03','2026-08-16');
  assert.equal(combined.quality,'partial');
  assert.ok(combined.totals?.availableResultBeforeTax);
  const expectedCombinedLines=[...first.lines,...second.lines].filter(line=>line.category_code!=='estimated_usn_tax');
  assert.equal(combined.lines.length,expectedCombinedLines.length);
  assert.deepEqual(combined.covered_period,{start:'2026-08-03',end:'2026-08-16'});
  assert.deepEqual(combined.cross_border_buyout,{present:true,reportCount:1});
  const boundaryGap=await getPublishedFinancialPeriod(isolated.user,isolated.store,'2026-08-01','2026-08-20');
  assert.equal(boundaryGap.quality,'unavailable');
  assert.equal(boundaryGap.totals,null);
  assert.ok(boundaryGap.missing_reasons.includes('report_coverage_incomplete'));
  assert.deepEqual(boundaryGap.covered_period,{start:'2026-08-03',end:'2026-08-16'});
  const uncovered=await getPublishedFinancialPeriod(isolated.user,isolated.store,'2026-08-04','2026-08-10');
  assert.equal(uncovered.quality,'unavailable');
  assert.equal(uncovered.totals,null);
  assert.deepEqual(uncovered.missing_reasons,['report_coverage_incomplete']);
  assert.deepEqual(uncovered.covered_period,null);
  const pair=await getPublishedFinancialPeriodPair(isolated.user,isolated.store,{periodStart:'2026-08-10',periodEnd:'2026-08-16',previousPeriodStart:'2026-08-03',previousPeriodEnd:'2026-08-09'});
  assert.equal(pair.current.period_result_id,second.period_result_id);
  assert.equal(pair.previous.period_result_id,first.period_result_id);
  assert.equal(pair.publication_id,second.publication_id);
  assert.equal(pair.method_version,'financial-result-v35');
  assert.equal(pair.timezone,'Europe/Moscow');
  assert.deepEqual(pair.scope,{type:'selected_products',productIds:[fixture.productId]});
  assert.ok(pair.current.source_freshness);
  assert.deepEqual(pair.current.covered_period,{start:'2026-08-10',end:'2026-08-16'});
  assert.deepEqual(pair.current.cross_border_buyout,{present:true,reportCount:1});
  assert.ok(pair.previous.source_freshness);
  assert.deepEqual(pair.previous.covered_period,{start:'2026-08-03',end:'2026-08-09'});
  assert.deepEqual(pair.previous.cross_border_buyout,{present:false,reportCount:0});
  assert.equal(await getPublishedFinancialPeriodPair(ids.user,isolated.store,{periodStart:'2026-08-10',periodEnd:'2026-08-16'}),null);
  const latest=await getPublishedFinancialPeriodPair(isolated.user,isolated.store);
  assert.equal(latest.current.period_start,'2026-08-10');
  assert.equal(latest.previous.period_result_id,first.period_result_id);
  const returnEvidence=await isolatedContext(async client=>(await client.query(
    `select e.contribution_amount::text,e.quantity::text,l.status,
            (select count(*)::int from mc.calculation_request_inputs i where i.request_id=r.request_id and i.operation_link_id=e.operation_link_id) as frozen
       from mc.result_evidence e join mc.result_lines rl on rl.id=e.result_line_id
       join mc.calculation_runs r on r.id=rl.run_id join mc.operation_links l on l.id=e.operation_link_id
      where r.id=$1 and e.operation_link_id is not null`,[calculated.runId]
  )).rows[0]);
  assert.deepEqual(returnEvidence,{contribution_amount:'40.0000',quantity:'-1.000000',status:'confirmed',frozen:1});
  const linkCount=await isolatedContext(async client=>(await client.query(`select count(*)::int as n from mc.operation_links where store_id=$1 and status='confirmed'`,[isolated.store])).rows[0].n);
  assert.equal(linkCount,1);
  const secondRun=await runFinancialCalculation(isolated.user,isolated.store);
  assert.equal(secondRun.changed,false);
  const invalidation=await getFinancialCalculationInvalidation(isolated.user,isolated.store);
  assert.equal(await acknowledgeFinancialCalculationInvalidation(isolated.user,isolated.store,invalidation?.generation_token),true);
  const targetA=await runFinancialCalculation(isolated.user,isolated.store,{targetPeriod:{periodStart:'2026-08-04',periodEnd:'2026-08-10'}});
  assert.equal(targetA.changed,true);
  const publishedTargetA=await getPublishedFinancialPeriod(isolated.user,isolated.store,'2026-08-04','2026-08-10');
  assert.equal(publishedTargetA.method_version,'financial-result-v36');
  assert.deepEqual([publishedTargetA.period_start,publishedTargetA.period_end],['2026-08-04','2026-08-10']);
  assert.ok(publishedTargetA.period_result_id);
  assert.ok(publishedTargetA.lines.every(line=>line.accounting_date>='2026-08-04'&&line.accounting_date<='2026-08-10'));
  const targetB=await runFinancialCalculation(isolated.user,isolated.store,{targetPeriod:{periodStart:'2026-08-05',periodEnd:'2026-08-11'}});
  assert.equal(targetB.changed,true);
  const cachedTargetA=await getPublishedFinancialPeriod(isolated.user,isolated.store,'2026-08-04','2026-08-10');
  assert.equal(cachedTargetA.publication_id,publishedTargetA.publication_id);
  const simpleTarget=await runFinancialCalculation(isolated.user,isolated.store,{targetPeriod:{periodStart:'2026-08-10',periodEnd:'2026-08-11'}});
  assert.equal(simpleTarget.changed,true);
  const publishedSimple=await getPublishedFinancialPeriod(isolated.user,isolated.store,'2026-08-10','2026-08-11');
  assert.equal(publishedSimple.quality,'complete');
  assert.deepEqual(publishedSimple.missing_reasons,[]);
  assert.deepEqual(publishedSimple.totals,{
    selectedProductsResultBeforeTax:'60.0000',storeLevelResultBeforeTax:'0.0000',availableResultBeforeTax:'60.0000',
    estimatedUsnTax:'6.0000',availableResultAfterTax:'54.0000',netProfit:null
  });
  assert.deepEqual(publishedSimple.cross_border_buyout,{present:true,reportCount:1});
  assert.equal((await getPublishedFinancialPeriod(isolated.user,isolated.store,'2026-08-04','2026-08-10')).publication_id,publishedTargetA.publication_id);
  await isolatedContext(client=>client.query(`insert into mc.calculation_invalidations(business_id,store_id,requested_by,reason)
    values($1,$2,$3,'target_cache_test') on conflict(store_id) do update set requested_by=excluded.requested_by,reason=excluded.reason,generation_token=gen_random_uuid(),invalidated_at=clock_timestamp()`,[isolated.business,isolated.store,isolated.user]));
  const invalidatedTargetA=await getPublishedFinancialPeriod(isolated.user,isolated.store,'2026-08-04','2026-08-10');
  assert.equal(invalidatedTargetA.quality,'unavailable');
  await isolatedContext(client=>client.query(`delete from mc.calculation_invalidations where store_id=$1`,[isolated.store]));
  const restoredWeekly=await runFinancialCalculation(isolated.user,isolated.store);
  assert.equal(restoredWeekly.changed,true);
  const staleTargetA=await getPublishedFinancialPeriod(isolated.user,isolated.store,'2026-08-04','2026-08-10');
  assert.equal(staleTargetA.quality,'unavailable');
  const reference=await getFinancialSellerOffsetReference(isolated.user,isolated.store,'9001');
  assert.equal(reference.total,null);
  assert.equal(reference.lines.find(line=>line.code==='wb_reward_without_vat').candidateAmount,'10');
  const invalidPeriodRun=await isolatedContext(async client=>(await client.query(`insert into mc.sync_runs(business_id,store_id,stream_id,requested_from,requested_to,status,started_at) values($1,$2,$3,'2026-08-17','2026-08-23','running',now()) returning id`,[isolated.business,isolated.store,fixture.streamId])).rows[0]);
  await assert.rejects(()=>completeFinancialSync(isolated.user,{business_id:isolated.business,store_id:isolated.store,stream_id:fixture.streamId,run_id:invalidPeriodRun.id,date_from:'2026-08-17',date_to:'2026-08-23'},
    {documentId:randomUUID(),reports:[{externalReportId:'9004',periodStart:'2026-08-17',periodEnd:'2026-08-23',checksum:'invalid-row-period',rows:[{externalRowKey:'1',rowChecksum:'invalid-row-period',rawData:{...secondWeek,reportId:9004,rrDate:'2026-08-24'}}]}]}),/financial_row_period_mismatch/);
  await failFinancialSync(isolated.user,{business_id:isolated.business,store_id:isolated.store,stream_id:fixture.streamId,run_id:invalidPeriodRun.id},'financial_invalid_request');
  const inconsistentRun=await isolatedContext(async client=>(await client.query(`insert into mc.sync_runs(business_id,store_id,stream_id,requested_from,requested_to,status,started_at)
    values($1,$2,$3,'2026-08-03','2026-08-09','running',now()) returning id`,[isolated.business,isolated.store,fixture.streamId])).rows[0]);
  // Preserve the original contradictory return as an explicit negative case:
  // retail 100 - payout 100 = 0, while reported return WB expense is 999.
  await completeFinancialSync(isolated.user,{business_id:isolated.business,store_id:isolated.store,stream_id:fixture.streamId,run_id:inconsistentRun.id,date_from:'2026-08-03',date_to:'2026-08-09'},
    {documentId:randomUUID(),reports:[{externalReportId:'9002',periodStart:'2026-08-03',periodEnd:'2026-08-09',checksum:'inconsistent-return',rows:[
      {externalRowKey:'return',rowChecksum:'inconsistent-return',rawData:{...returned,forPay:'100',vw:'999'}},
      {externalRowKey:'excessive-return',rowChecksum:'excessive-return',rawData:excessiveReturn}
    ]}]});
  const inconsistent=await runFinancialCalculation(isolated.user,isolated.store);
  assert.equal(inconsistent.quality,'partial');
  assert.ok(inconsistent.missingReasons.includes('source_unreconciled'));
  const inconsistentReturnEvidence=await isolatedContext(async client=>(await client.query(`select count(*)::int count
    from mc.result_evidence e join mc.result_lines line on line.id=e.result_line_id
    join mc.report_rows row on row.id=e.report_row_id
    where line.run_id=$1 and row.row_checksum='inconsistent-return'
      and line.category_code in('cost_of_goods','return_wb_expense_reversal')`,[inconsistent.runId])).rows[0].count);
  assert.equal(inconsistentReturnEvidence,0);
  const retainedReturn=await isolatedContext(async client=>(await client.query(`select line.category_code,e.contribution_amount::text
    from mc.result_evidence e join mc.result_lines line on line.id=e.result_line_id
    left join mc.financial_components component on component.id=e.financial_component_id
    join mc.operation_versions operation on operation.id=coalesce(e.source_operation_version_id,component.operation_version_id)
    join mc.report_rows row on row.id=operation.report_row_id
    where line.run_id=$1 and row.row_checksum='inconsistent-return'
      and line.category_code in('revenue_return','cost_of_goods') order by line.category_code`,[inconsistent.runId])).rows);
  assert.deepEqual(retainedReturn,[{category_code:'cost_of_goods',contribution_amount:'40.0000'},
    {category_code:'revenue_return',contribution_amount:'-100.0000'}]);
});

test('latest normalization resolves legacy unlinked data issues and sync count ignores them',async()=>{
  const fixture=await context(async client=>{
    const document=(await client.query(`insert into mc.source_documents(business_id,store_id,origin,document_type,external_document_id,checksum,completeness)
      values($1,$2,'wb_api','weekly_realization','issue-lifecycle','issue-lifecycle-source','complete') returning id`,[ids.business,ids.store])).rows[0];
    const report=(await client.query(`insert into mc.reports(business_id,store_id,external_report_id,period_start,period_end)
      values($1,$2,'889900','2026-09-07','2026-09-13') returning id`,[ids.business,ids.store])).rows[0];
    const version=(await client.query(`insert into mc.report_versions(business_id,store_id,report_id,document_id,version_no,checksum,parser_version)
      values($1,$2,$3,$4,1,'issue-lifecycle-v1','wb-finance-v13') returning id`,[ids.business,ids.store,report.id,document.id])).rows[0];
    const row=(await client.query(`insert into mc.report_rows(business_id,store_id,report_version_id,external_row_key,row_number,raw_data,row_checksum)
      values($1,$2,$3,'1',1,$4::jsonb,'issue-lifecycle-row') returning id`,[ids.business,ids.store,version.id,JSON.stringify({reportId:889900,docTypeName:'Продажа',sellerOperName:'Продажа',rrDate:'2026-09-08',nmId:700001,sku:'4600000000001',quantity:1,retailAmount:'100',forPay:'100'})])).rows[0];
    await client.query(`update mc.report_versions set status='validated' where id=$1`,[version.id]);
    await client.query(`update mc.report_versions set status='accepted',accepted_at=now() where id=$1`,[version.id]);
    await client.query(`update mc.reports set current_version_id=$1 where id=$2`,[version.id,report.id]);
    const method=(await client.query(`select id from mc.method_versions where code='wb_finance_import' and implementation_version='wb-finance-v2'`)).rows[0];
    const normalization=(await client.query(`insert into mc.report_normalizations(business_id,store_id,report_version_id,method_version_id,normalization_key,status)
      values($1,$2,$3,$4,$5,'succeeded') returning id`,[ids.business,ids.store,version.id,method.id,`wb-finance-v2:${version.id}`])).rows[0];
    const issues=(await client.query(`insert into mc.data_issues(business_id,store_id,document_id,report_row_id,code,severity)
      values($1,$2,$3,$4,'financial_operation_unclassified','blocking'),
            ($1,$2,$3,$4,'financial_operation_unclassified','blocking') returning id`,[ids.business,ids.store,document.id,row.id])).rows;
    const stream=(await client.query(`select id from mc.sync_streams where store_id=$1 and source_type='financial_reports'`,[ids.store])).rows[0];
    const run=(await client.query(`insert into mc.sync_runs(business_id,store_id,stream_id,requested_from,requested_to,status,started_at) values($1,$2,$3,'2026-09-07','2026-09-13','running',now()) returning id`,[ids.business,ids.store,stream.id])).rows[0];
    return{normalizationId:normalization.id,issueIds:issues.map(issue=>issue.id),streamId:stream.id,runId:run.id};
  });
  const source={externalReportId:'889900',periodStart:'2026-09-07',periodEnd:'2026-09-13',checksum:'issue-lifecycle-v2',rows:[{externalRowKey:'1',rowChecksum:'issue-lifecycle-row-v2',rawData:{reportId:889900,docTypeName:'Продажа',sellerOperName:'Продажа',rrDate:'2026-09-08',nmId:700001,sku:'4600000000001',quantity:1,retailAmount:'100',forPay:'100'}}]};
  await completeFinancialSync(ids.user,{business_id:ids.business,store_id:ids.store,stream_id:fixture.streamId,run_id:fixture.runId,date_from:'2026-09-07',date_to:'2026-09-13'},
    {documentId:randomUUID(),reports:[source]});
  const lifecycle=await context(async client=>(await client.query(`select status,resolved_at is not null as resolved,report_normalization_id,resolved_by_normalization_id from mc.data_issues where id=any($1::uuid[]) order by id`,[fixture.issueIds])).rows);
  assert.equal(lifecycle.length,2);
  assert.ok(lifecycle.every(issue=>issue.status==='resolved'&&issue.resolved));
  assert.ok(lifecycle.every(issue=>issue.report_normalization_id===fixture.normalizationId));
  assert.ok(lifecycle.every(issue=>issue.resolved_by_normalization_id));
  assert.equal(lifecycle.filter(issue=>issue.resolved_by_normalization_id===fixture.normalizationId).length,1);
  assert.equal(lifecycle.filter(issue=>issue.resolved_by_normalization_id!==fixture.normalizationId).length,1);
  const state=await getFinancialSyncState(ids.user,ids.store);
  assert.equal(state.issue_count,0);

  const current=await context(async client=>{
    const version=(await client.query(`select current_version_id from mc.reports where store_id=$1 and external_report_id='889900'`,[ids.store])).rows[0];
    const row=(await client.query(`select id from mc.report_rows where report_version_id=$1 and external_row_key='1'`,[version.current_version_id])).rows[0];
    const document=(await client.query(`select document_id from mc.report_versions where id=$1`,[version.current_version_id])).rows[0];
    const oldMethod=(await client.query(`select id from mc.method_versions where code='wb_finance_import' and implementation_version='wb-finance-v2'`)).rows[0];
    await client.query(`insert into mc.report_normalizations(business_id,store_id,report_version_id,method_version_id,normalization_key,status)
      values($1,$2,$3,$4,$5,'succeeded')`,[ids.business,ids.store,version.current_version_id,oldMethod.id,`wb-finance-v2:${version.current_version_id}`]);
    const issue=(await client.query(`insert into mc.data_issues(business_id,store_id,document_id,report_row_id,code,severity)
      values($1,$2,$3,$4,'financial_operation_unclassified','blocking') returning id`,[ids.business,ids.store,document.document_id,row.id])).rows[0];
    const normalization=(await client.query(`select rn.id from mc.report_normalizations rn join mc.method_versions m on m.id=rn.method_version_id
      where rn.report_version_id=$1 order by m.version_no desc,rn.normalized_at desc,rn.id desc limit 1`,[version.current_version_id])).rows[0];
    const run=(await client.query(`insert into mc.sync_runs(business_id,store_id,stream_id,requested_from,requested_to,status,started_at) values($1,$2,$3,'2026-09-07','2026-09-13','running',now()) returning id`,[ids.business,ids.store,fixture.streamId])).rows[0];
    return{issueId:issue.id,normalizationId:normalization.id,runId:run.id};
  });
  await completeFinancialSync(ids.user,{business_id:ids.business,store_id:ids.store,stream_id:fixture.streamId,run_id:current.runId,date_from:'2026-09-07',date_to:'2026-09-13'},
    {documentId:randomUUID(),reports:[source]});
  const currentIssue=await context(async client=>(await client.query(`select status,report_normalization_id,resolved_by_normalization_id from mc.data_issues where id=$1`,[current.issueId])).rows[0]);
  assert.deepEqual(currentIssue,{status:'open',report_normalization_id:current.normalizationId,resolved_by_normalization_id:null});
});

test('P0.5 readers pin legacy and mixed-generation daily evidence under ordinary PostgreSQL role',async t=>{
  const {createPublishedDrilldownRepository}=await import('../../app/modules/calculation/drilldown.repository.mjs');
  const role=`mc_drilldown_${randomUUID().replaceAll('-','').slice(0,12)}`;
  const viewer=randomUUID();
  await context(async client=>{
    await client.query(`insert into mc.users(id,display_name) values($1,'P05 viewer')`,[viewer]);
    await client.query(`insert into mc.memberships(business_id,user_id,role) values($1,$2,'viewer')`,[ids.business,viewer]);
    await client.query(`create role ${role} nologin nosuperuser nobypassrls`);
    await client.query(`grant usage on schema mc to ${role}`);
    await client.query(`grant select on all tables in schema mc to ${role}`);
    await client.query(`grant execute on all functions in schema mc to ${role}`);
  });
  t.after(async()=>{
    await pool.query(`drop owned by ${role}`);
    await pool.query(`drop role ${role}`);
  });
  const runtimePool={async connect(){
    const client=await pool.connect();
    await client.query(`set role ${role}`);
    const permissions=(await client.query(`select current_user,rolsuper,rolbypassrls from pg_roles where rolname=current_user`)).rows[0];
    assert.equal(permissions.rolsuper,false);assert.equal(permissions.rolbypassrls,false);
    return{query:client.query.bind(client),release(){client.query('reset role').then(()=>client.release(),error=>client.release(error));}};
  }};
  const reader=createPublishedDrilldownRepository({pool:runtimePool});
  const publications=await context(async client=>({
    legacy:(await client.query(`select p.id from mc.publications p join mc.financial_period_results f on f.run_id=p.run_id
      where p.store_id=$1 and f.period_start='2026-07-13' and f.period_end='2026-07-19' and f.quality='complete'
      order by p.created_at,p.id limit 1`,[ids.store])).rows[0].id,
    daily:(await client.query(`select p.id from mc.financial_daily_publications p where p.store_id=$1
      and exists(select 1 from mc.financial_daily_publication_days d where d.publication_id=p.id)
      order by p.publication_no limit 1`,[ids.store])).rows[0].id,
    mixed:(await client.query(`select p.id from mc.financial_daily_publications p join mc.financial_daily_publication_days d on d.publication_id=p.id
      where p.store_id=$1 group by p.id,p.publication_no having count(distinct d.generation_id)>1 order by p.publication_no limit 1`,[ids.store])).rows[0].id
  }));
  let referenceTotals;
  for(const [publicationSource,publicationId] of [['legacy',publications.legacy],['daily',publications.daily],['daily',publications.mixed]]){
    const input={storeId:ids.store,publicationSource,publicationId,periodStart:'2026-07-13',periodEnd:'2026-07-19'};
    const list=await reader.readPublishedSkuList(viewer,input);
    assert.equal(list.context.publication.id,publicationId);
    assert.equal(list.reconciliation.status,'matched',JSON.stringify(list.reconciliation));
    assert.ok(list.items.length);assert.ok(list.storeLines.length);
    referenceTotals??=list.context.totals;
    assert.deepEqual(list.context.totals,referenceTotals);
    if(publicationId===publications.mixed)assert.equal(new Set(list.context.publication.dayRefs.map(day=>day.generationId)).size,2);
    const item=list.items[0];
    const card=await reader.readPublishedSkuCard(viewer,{...input,productId:item.productId});
    assert.deepEqual(card.item.metrics,item.metrics);
    for(const group of item.groups){
      const page=await reader.readPublishedContributions(viewer,{...input,productId:item.productId,groupKey:group.groupKey,limit:1});
      assert.equal(page.sourceValidationScope,'page');
      assert.ok(page.items.length||group.amountSigned==='0.0000',JSON.stringify(page));
      assert.ok(!JSON.stringify(page).includes('raw_data'));
      assert.ok(!JSON.stringify(page).includes('srid'));
      assert.ok(['matched','unchecked'].includes(page.evidenceStatus),JSON.stringify(page));
      assert.ok(page.items.every(value=>value.evidenceStatus==='matched'),JSON.stringify(page));
      if(publicationSource==='legacy'&&group.categoryCode==='estimated_usn_tax'){
        assert.equal(group.taxBasisAvailable,true);
        const basis=await reader.readPublishedContributions(viewer,{...input,productId:item.productId,groupKey:group.groupKey,taxBasis:true,limit:1});
        assert.ok(basis.items.length);assert.ok(basis.items.every(value=>value.evidenceStatus==='matched'),JSON.stringify(basis));
        assert.ok(basis.items.every(value=>typeof value.basisContributionAmount==='string'));
      }
      if(page.nextCursor){
        const next=await reader.readPublishedContributions(viewer,{...input,productId:item.productId,groupKey:group.groupKey,limit:1,cursor:page.nextCursor});
        assert.notDeepEqual(next.items,page.items);
        await assert.rejects(()=>reader.readPublishedContributions(viewer,{...input,publicationId:randomUUID(),productId:item.productId,groupKey:group.groupKey,cursor:page.nextCursor}),/drilldown_not_found/);
      }
    }
    const storeGroup=list.storeLines[0];
    const storePage=await reader.readPublishedContributions(viewer,{...input,scope:'store',groupKey:storeGroup.groupKey});
    assert.equal(storePage.evidenceStatus,'matched',JSON.stringify(storePage));
    await assert.rejects(()=>reader.readPublishedSkuCard(viewer,{...input,productId:randomUUID()}),/drilldown_not_found/);
    await assert.rejects(()=>reader.readPublishedSkuList(viewer,{...input,storeId:randomUUID()}),/drilldown_not_found/);
    await assert.rejects(()=>reader.readPublishedSkuList(randomUUID(),input),/drilldown_not_found/);
    const missing=await reader.readPublishedSkuList(viewer,{...input,periodEnd:'2026-07-20'});
    assert.equal(missing.context.quality,'unavailable');assert.equal(missing.context.totals,null);
    const filtered=await reader.readPublishedSkuList(viewer,{...input,search:'no-such-product'});
    assert.equal(filtered.items.length,0);assert.deepEqual(filtered.context.totals,list.context.totals);
    assert.deepEqual(filtered.storeLines,list.storeLines);
    const foreign=await context(async client=>(await client.query(`select store.id store_id,membership.user_id,
        product.id product_id,pub.id publication_id,line.id result_line_id,line.run_id,line.financial_period_result_id
        from mc.stores store join mc.memberships membership on membership.business_id=store.business_id
        join mc.products product on product.store_id=store.id
        join lateral(select id,run_id from mc.publications where store_id=store.id order by created_at desc limit 1) pub on true
        join mc.result_lines line on line.run_id=pub.run_id where store.business_id<>$1 limit 1`,[ids.business])).rows[0]);
    assert.ok(foreign,'integration has a real second business');
    await assert.rejects(()=>reader.readPublishedSkuList(viewer,{...input,storeId:foreign.store_id}),/drilldown_not_found/);
    await assert.rejects(()=>reader.readPublishedSkuList(foreign.user_id,input),/drilldown_not_found/);
    await assert.rejects(()=>reader.readPublishedSkuCard(viewer,{...input,productId:foreign.product_id}),/drilldown_not_found/);
    await assert.rejects(()=>reader.readPublishedSkuList(viewer,{...input,publicationSource:'legacy',publicationId:foreign.publication_id}),/drilldown_not_found/);
    await assert.rejects(()=>reader.readPublishedContributions(viewer,{...input,productId:item.productId,groupKey:item.groups[0].groupKey,
      lineRef:{source:'legacy',runId:foreign.run_id,periodResultId:foreign.financial_period_result_id,resultLineId:foreign.result_line_id}}),/drilldown_not_found/);

    // Corrupt only this disposable test snapshot with bootstrap privileges.
    // Runtime remains an ordinary role; frozen reader must fail closed even
    // when the report version is unchanged and a valid alternate normalization exists.
    const table=publicationSource==='legacy'?'calculation_inputs':'financial_daily_generation_inputs';
    const ownerColumn=publicationSource==='legacy'?'run_id':'generation_id';
    const revenueGroup=item.groups.find(group=>group.categoryCode==='revenue');
    const revenuePage=await reader.readPublishedContributions(viewer,{...input,productId:item.productId,groupKey:revenueGroup.groupKey});
    const owner=publicationSource==='legacy'?list.context.publication.runId:revenuePage.items[0].lineRef.generationId;
    const frozen=await context(async client=>{
      const original=(await client.query(`select input.id,input.report_normalization_id,n.report_version_id,n.method_version_id
        from mc.${table} input join mc.report_normalizations n on n.id=input.report_normalization_id
        where input.${ownerColumn}=$1 order by input.id limit 1`,[owner])).rows[0];
      const alternateMethod=(await client.query(`select id from mc.method_versions where code='wb_finance_import' and id<>$1 order by version_no desc limit 1`,[original.method_version_id])).rows[0].id;
      await client.query(`insert into mc.report_normalizations(business_id,store_id,report_version_id,method_version_id,normalization_key,status)
        values($1,$2,$3,$4,$5,'succeeded') on conflict do nothing`,[ids.business,ids.store,original.report_version_id,alternateMethod,`p05-alternate:${randomUUID()}`]);
      const alternate=(await client.query(`select id from mc.report_normalizations where report_version_id=$1 and method_version_id=$2 order by created_at desc limit 1`,[original.report_version_id,alternateMethod])).rows[0].id;
      return{...original,alternate};
    });
    const replaceNormalization=value=>context(async client=>{
      await client.query(`alter table mc.${table} disable trigger user`);
      await client.query(`update mc.${table} set report_normalization_id=$1 where id=$2`,[value,frozen.id]);
      await client.query(`alter table mc.${table} enable trigger user`);
    });
    await replaceNormalization(frozen.alternate);
    try{
      const blocked=await reader.readPublishedContributions(viewer,{...input,productId:item.productId,groupKey:revenueGroup.groupKey});
      assert.equal(blocked.evidenceStatus,'unavailable');
      assert.ok(blocked.items.every(value=>value.source===null),JSON.stringify(blocked));
      assert.ok(blocked.missingReasons.includes('drilldown_frozen_source_missing'));
      assert.deepEqual(blocked.context.totals,list.context.totals);
    }finally{await replaceNormalization(frozen.report_normalization_id);}
  }
  const pinnedInput={storeId:ids.store,publicationSource:'daily',publicationId:publications.daily,periodStart:'2026-07-13',periodEnd:'2026-07-19'};
  const originalPointer=await context(async client=>(await client.query('select publication_id from mc.financial_daily_current_publications where store_id=$1',[ids.store])).rows[0].publication_id);
  const setPointer=value=>context(async client=>{
    await client.query('alter table mc.financial_daily_current_publications disable trigger user');
    await client.query('update mc.financial_daily_current_publications set publication_id=$1 where store_id=$2',[value,ids.store]);
    await client.query('alter table mc.financial_daily_current_publications enable trigger user');
  });
  await setPointer(publications.daily);
  try{
    const before=await reader.readPublishedSkuList(viewer,pinnedInput);
    assert.equal(before.context.update.availablePublicationId,null);
    await setPointer(publications.mixed);
    const after=await reader.readPublishedSkuCard(viewer,{...pinnedInput,productId:before.items[0].productId});
    assert.equal(after.context.publication.id,publications.daily);
    assert.equal(after.context.update.availablePublicationId,publications.mixed);
    assert.deepEqual(after.item.groups,before.items[0].groups);
    assert.deepEqual(after.context.totals,before.context.totals);
  }finally{await setPointer(originalPointer);}
  const mixedInput={storeId:ids.store,publicationSource:'daily',publicationId:publications.mixed,periodStart:'2026-07-13',periodEnd:'2026-07-19'};
  const carried=await context(async client=>(await client.query(`select g.id,g.parser_method_version_id,
      (select id from mc.method_versions where code='wb_finance_import' and id<>g.parser_method_version_id order by version_no limit 1) alternate
      from mc.financial_daily_publications p join mc.financial_daily_publication_days d on d.publication_id=p.id
      join mc.financial_daily_generations g on g.id=d.generation_id where p.id=$1 and g.id<>p.generation_id limit 1`,[publications.mixed])).rows[0]);
  const replaceMethod=value=>context(async client=>{
    await client.query('alter table mc.financial_daily_generations disable trigger user');
    await client.query('update mc.financial_daily_generations set parser_method_version_id=$1 where id=$2',[value,carried.id]);
    await client.query('alter table mc.financial_daily_generations enable trigger user');
  });
  await replaceMethod(carried.alternate);
  try{
    const incompatible=await reader.readPublishedSkuList(viewer,mixedInput);
    assert.equal(incompatible.context.quality,'unavailable');
    assert.ok(incompatible.context.missingReasons.includes('drilldown_publication_incompatible'));
    assert.equal(incompatible.context.totals,null);
  }finally{await replaceMethod(carried.parser_method_version_id);}
});

test.after(async()=>{await pool.end();});
