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

test('migration 063 queues every tenant existing week for v32 without WB fetch',async()=>{
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
      fetches:(await client.query(`select count(*)::int n from mc.jobs where store_id=$1 and job_type='financial_report_fetch'`,[scope.store])).rows[0].n,
      jobs:(await client.query(`select payload->>'allowsWbApi' allows_wb_api from mc.jobs where store_id=$1 and job_type='financial_dates_recalculate' and status='pending'`,[scope.store])).rows
    }));
    assert.deepEqual(saved.events,[{affected_from:periodStart,affected_to:periodEnd,implementation_version:'financial-result-v32'}]);
    assert.equal(saved.invalidation.reason,'field_based_wb_expenses_v32');
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
  assert.equal(persisted.method,'financial-result-v31');
  assert.deepEqual(persisted.logistics,[{source_amount:'-1.23456',result_amount:'-1.2346',evidence_amount:'-1.2346'}]);
  for(const category of ['logistics','storage','acceptance','penalty','deduction','acquiring','wb_reward_without_vat','wb_reward_vat','wb_row_rounding_adjustment']){
    assert.ok(persisted.categories.includes(category),category);
  }
  await context(scope,client=>client.query(`select e.id from mc.method_versions method
    cross join lateral mc.emit_financial_input_event($1,$2,'result_method_updated',$3,$4,
      p_source_result_method_version_id=>method.id) e
    where method.code='financial_result' and method.version_no=32`,
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
  assert.deepEqual(daily,[{implementation_version:'financial-result-v32',amount_signed:'-1.2346',contribution_amount:'-1.2346'}]);
});
