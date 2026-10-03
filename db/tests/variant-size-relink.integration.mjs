import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const integrationUrl=process.env.VARIANT_SIZE_RELINK_INTEGRATION_DATABASE_URL;
if(!integrationUrl)throw new Error('Set VARIANT_SIZE_RELINK_INTEGRATION_DATABASE_URL to an empty disposable PostgreSQL database whose name contains "test".');
if(!new URL(integrationUrl).pathname.slice(1).toLowerCase().includes('test'))throw new Error('Refusing variant size integration outside a database whose name contains "test".');
process.env.DATABASE_URL=integrationUrl;
const {migrate,pool,completeFinancialSync,runFinancialCalculation,getPublishedFinancialPeriod,jobsRepository,financialDailyGenerationRepository}=await import('../../app/db.mjs');
const {persistFinancialNormalization,reconcileHistoricalCatalogs}=await import('../../app/modules/reports/normalization.repository.mjs');
const {completeCatalogSync}=await import('../../app/modules/catalog/catalog.repository.mjs');
test.after(async()=>{await pool.end();});

const periodStart='2026-09-21',periodEnd='2026-09-27';
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

async function fixture(){
  const scope={user:randomUUID(),business:randomUUID(),store:randomUUID()};
  const saved=await context(scope,async client=>{
    await client.query(`insert into mc.users(id,display_name) values($1,'Variant size owner')`,[scope.user]);
    await client.query(`insert into mc.businesses(id,name) values($1,'Variant size test')`,[scope.business]);
    await client.query(`insert into mc.memberships(business_id,user_id,role) values($1,$2,'owner')`,[scope.business,scope.user]);
    await client.query(`insert into mc.stores(id,business_id,external_account_id,name,status) values($1,$2,$3,'Variant size store','active')`,[scope.store,scope.business,scope.store]);
    const controlStore=(await client.query(`insert into mc.stores(business_id,external_account_id,name,status) values($1,$2,'Unaffected store','archived') returning id,catalog_revision`,[scope.business,randomUUID()])).rows[0];
    const catalog=(await client.query(`insert into mc.source_documents(business_id,store_id,origin,document_type,checksum,completeness) values($1,$2,'wb_api','catalog',$3,'complete') returning id`,[scope.business,scope.store,randomUUID()])).rows[0];
    const products=[];
    const variants=[];
    for(const [index,article] of [700001,700002].entries()){
      const product=(await client.query(`insert into mc.products(business_id,store_id,wb_article,seller_article) values($1,$2,$3,$4) returning id`,[scope.business,scope.store,article,`SIZE-${article}`])).rows[0];
      products.push(product.id);
      const variant=(await client.query(`insert into mc.variants(business_id,store_id,product_id,external_variant_id,size_label) values($1,$2,$3,$4,$5) returning id`,[scope.business,scope.store,product.id,`variant-${article}`,index===0?null:'0'])).rows[0];
      variants.push(variant.id);
      await client.query(`insert into mc.variant_identifiers(business_id,store_id,variant_id,identifier_type,identifier_value) values($1,$2,$3,'barcode',$4)`,[scope.business,scope.store,variant.id,index===0?'own-barcode':'shared-other']);
    }
    await client.query(`select mc.confirm_product_selection($1,$2,$3::uuid[])`,[scope.store,catalog.id,products]);
    const cost=(await client.query(`insert into mc.variant_costs(business_id,store_id,product_id,variant_id,effective_from) values($1,$2,$3,$4,'2026-01-01') returning id`,[scope.business,scope.store,products[0],variants[0]])).rows[0];
    const costVersion=(await client.query(`insert into mc.cost_versions(business_id,store_id,cost_id,version_no,unit_cost,origin,changed_by) values($1,$2,$3,1,395,'manual',$4) returning id`,[scope.business,scope.store,cost.id,scope.user])).rows[0];
    await client.query(`update mc.variant_costs set current_version_id=$1 where id=$2`,[costVersion.id,cost.id]);
    const setting=(await client.query(`insert into mc.tax_settings(business_id,effective_from) values($1,'2026-01-01') returning id`,[scope.business])).rows[0];
    const tax=(await client.query(`insert into mc.tax_setting_versions(business_id,tax_setting_id,version_no,regime_code,usn_rate_fraction,vat_mode,changed_by) values($1,$2,1,'usn_income',0.08,'exempt',$3) returning id`,[scope.business,setting.id,scope.user])).rows[0];
    await client.query(`update mc.tax_settings set current_version_id=$1 where id=$2`,[tax.id,setting.id]);
    await client.query(`insert into mc.operational_sync_targets(business_id,store_id,requested_by,status) values($1,$2,$3,'blocked')`,[scope.business,scope.store,scope.user]);
    const stream=(await client.query(`insert into mc.sync_streams(business_id,store_id,source_type,status) values($1,$2,'financial_reports','active') returning id`,[scope.business,scope.store])).rows[0];
    const run=(await client.query(`insert into mc.sync_runs(business_id,store_id,stream_id,requested_from,requested_to,status,started_at) values($1,$2,$3,$4,$5,'running',now()) returning id`,[scope.business,scope.store,stream.id,periodStart,periodEnd])).rows[0];
    return {products,variants,cost:cost.id,costVersion:costVersion.id,stream:stream.id,run:run.id,controlStore};
  });
  await completeFinancialSync(scope.user,{business_id:scope.business,store_id:scope.store,stream_id:saved.stream,run_id:saved.run,date_from:periodStart,date_to:periodEnd},{documentId:randomUUID(),reports:[{
    externalReportId:'940001',periodStart,periodEnd,checksum:randomUUID(),rows:[{externalRowKey:'1',rowChecksum:randomUUID(),rawData:{reportId:940001,rrDate:'2026-09-22',nmId:700001,sku:'shared-other',techSize:'0',docTypeName:'Продажа',sellerOperName:'Продажа',quantity:1,retailAmount:'1310',forPay:'1310'}}]
  }]});
  const old=await context(scope,async client=>{
    const normalization=(await client.query(`select n.id,n.report_version_id,n.catalog_revision from mc.report_normalizations n where n.store_id=$1 order by n.normalized_at desc limit 1`,[scope.store])).rows[0];
    const operation=(await client.query(`select product_id,variant_id from mc.operation_versions where report_normalization_id=$1`,[normalization.id])).rows[0];
    assert.equal(operation.product_id,saved.products[0]);
    assert.equal(operation.variant_id,null);
    await client.query(`update mc.variants set size_label='0' where id=$1`,[saved.variants[0]]);
    const cached=await persistFinancialNormalization(client,{businessId:scope.business,storeId:scope.store,reportVersionId:normalization.report_version_id,catalogRevision:normalization.catalog_revision});
    assert.equal(cached.id,normalization.id);
    assert.equal(cached.cached,true);
    assert.equal((await client.query(`select catalog_revision from mc.stores where id=$1`,[scope.store])).rows[0].catalog_revision,normalization.catalog_revision);
    return normalization;
  });
  return {...scope,...saved,old};
}

async function drainDaily(){
  const workerId=`variant-size:${randomUUID()}`;
  for(let count=0;count<30;count++){
    const [job]=await jobsRepository.claimJobs({workerId,jobTypes:['financial_dates_recalculate'],leaseSeconds:300,limit:1});
    if(!job)return;
    assert.equal(job.payload.allowsWbApi,false);
    const result=await financialDailyGenerationRepository.build(job.id,job.lease_token,workerId);
    await jobsRepository.completeJob({jobId:job.id,leaseToken:job.lease_token,workerId,outcome:result.superseded?'superseded':'completed'});
  }
  assert.fail('daily queue must drain');
}

test('migration 064 relinks unique sizes across tenants without altering barcode owners or cost evidence',async()=>{
  assert.equal((await pool.query("select to_regclass('mc.schema_migrations') table_name")).rows[0].table_name,null,'use an empty disposable database');
  const directory=path.resolve('db/migrations');
  for(const file of (await readdir(directory)).filter(name=>/^\d+_.+\.sql$/.test(name)&&Number(name.slice(0,3))<64).sort())await pool.query(await readFile(path.join(directory,file),'utf8'));
  const tenants=[await fixture(),await fixture()];
  await migrate();
  await reconcileHistoricalCatalogs();
  for(const scope of tenants){
    await context(scope,async client=>{
      assert.equal(Number((await client.query(`select catalog_revision from mc.stores where id=$1`,[scope.store])).rows[0].catalog_revision),Number(scope.old.catalog_revision)+1);
      assert.equal((await client.query(`select catalog_revision from mc.stores where id=$1`,[scope.controlStore.id])).rows[0].catalog_revision,scope.controlStore.catalog_revision);
      assert.equal((await client.query(`select status from mc.operational_sync_targets where store_id=$1`,[scope.store])).rows[0].status,'blocked');
      const operations=(await client.query(`select report_normalization_id,product_id,variant_id from mc.operation_versions where store_id=$1 order by version_no`,[scope.store])).rows;
      assert.equal(operations.length,2);
      assert.equal(operations[0].report_normalization_id,scope.old.id);
      assert.equal(operations[0].variant_id,null);
      assert.notEqual(operations[1].report_normalization_id,scope.old.id);
      assert.equal(operations[1].product_id,scope.products[0]);
      assert.equal(operations[1].variant_id,scope.variants[0]);
      const issues=(await client.query(`select code,severity,status,details,resolved_by_normalization_id from mc.data_issues where store_id=$1 order by code`,[scope.store])).rows;
      assert.equal(issues.length,2);
      assert.equal(issues[0].code,'financial_variant_matched_by_size');
      assert.equal(issues[0].severity,'warning');
      assert.deepEqual(issues[0].details,{wbArticle:'700001',sourceBarcode:'shared-other',sizeLabel:'0',variantId:scope.variants[0]});
      assert.equal(issues[1].code,'financial_variant_not_matched');
      assert.equal(issues[1].status,'resolved');
      assert.equal(issues[1].resolved_by_normalization_id,operations[1].report_normalization_id);
      assert.deepEqual((await client.query(`select identifier_value,variant_id from mc.variant_identifiers where store_id=$1 and valid_to is null order by identifier_value`,[scope.store])).rows,[{identifier_value:'own-barcode',variant_id:scope.variants[0]},{identifier_value:'shared-other',variant_id:scope.variants[1]}]);
      assert.deepEqual((await client.query(`select id,current_version_id from mc.variant_costs where store_id=$1`,[scope.store])).rows,[{id:scope.cost,current_version_id:scope.costVersion}]);
      assert.equal((await client.query(`select count(*)::int n from mc.cost_versions where store_id=$1`,[scope.store])).rows[0].n,1);
      assert.equal((await client.query(`select count(*)::int n from mc.jobs where store_id=$1 and job_type='financial_report_fetch'`,[scope.store])).rows[0].n,0);
    });
    const calculated=await runFinancialCalculation(scope.user,scope.store);
    assert.equal(calculated.quality,'complete');
    assert.deepEqual(calculated.missingReasons,[]);
    assert.equal(calculated.totals.availableResultBeforeTax,'915.0000');
    assert.equal(calculated.totals.availableResultAfterTax,'810.2000');
    await context(scope,async client=>{
      assert.deepEqual((await client.query(`select distinct e.cost_version_id from mc.result_evidence e join mc.result_lines line on line.id=e.result_line_id where line.run_id=$1 and e.cost_version_id is not null`,[calculated.runId])).rows,[{cost_version_id:scope.costVersion}]);
      await client.query(`select e.id from mc.method_versions method cross join lateral mc.emit_financial_input_event($1,$2,'result_method_updated',$3,$4,p_source_result_method_version_id=>method.id) e where method.code='financial_result' and method.version_no=32`,[scope.store,`variant-size-daily:${scope.store}`,periodStart,periodEnd]);
    });
  }
  await drainDaily();
  for(const scope of tenants){
    const published=await getPublishedFinancialPeriod(scope.user,scope.store,periodStart,periodEnd);
    assert.equal(published.publication_source,'daily');
    assert.equal(published.quality,'complete');
    assert.deepEqual(published.missing_reasons,[]);
    assert.equal(published.totals.availableResultBeforeTax,'915.0000');
    assert.equal(published.totals.availableResultAfterTax,'810.2000');
    assert.equal(await getPublishedFinancialPeriod(tenants.find(tenant=>tenant.user!==scope.user).user,scope.store,periodStart,periodEnd),null);
  }
  // A later catalog-only change must invalidate a size-derived link even when
  // external IDs and barcode ownership do not change.
  const scope=tenants[0];
  let revision=Number(scope.old.catalog_revision)+1;
  const sourceVariant=sizeLabel=>({externalId:'variant-700001',sizeLabel,colorLabel:null,attributes:{},barcodes:['own-barcode']});
  const otherVariant={externalId:'variant-700002',sizeLabel:'0',colorLabel:null,attributes:{},barcodes:['shared-other']};
  async function sync(variants){
    const job=await context(scope,async client=>{
      const stream=(await client.query(`insert into mc.sync_streams(business_id,store_id,source_type,status) values($1,$2,'catalog','active') on conflict(store_id,source_type) do update set status='active' returning id`,[scope.business,scope.store])).rows[0];
      const run=(await client.query(`insert into mc.sync_runs(business_id,store_id,stream_id,status,started_at) values($1,$2,$3,'running',now()) returning id`,[scope.business,scope.store,stream.id])).rows[0];
      return {business_id:scope.business,store_id:scope.store,stream_id:stream.id,run_id:run.id};
    });
    await completeCatalogSync(scope.user,job,{cards:[
      {nmId:700001,vendorCode:'SIZE-700001',title:null,imageUrl:null,variants},
      {nmId:700002,vendorCode:'SIZE-700002',title:null,imageUrl:null,variants:[otherVariant]}
    ]});
    await context(scope,async client=>{
      const current=Number((await client.query(`select catalog_revision from mc.stores where id=$1`,[scope.store])).rows[0].catalog_revision);
      assert.equal(current,revision+1);
      revision=current;
      const operation=(await client.query(`select o.variant_id from mc.operation_versions o join mc.report_normalizations n on n.id=o.report_normalization_id where o.store_id=$1 and n.catalog_revision=$2`,[scope.store,revision])).rows[0];
      assert.ok(operation,'catalog change must create a fresh normalization');
      return operation;
    });
  }
  async function assertCurrentVariant(expected){
    await context(scope,async client=>{
      assert.equal((await client.query(`select o.variant_id from mc.operation_versions o join mc.report_normalizations n on n.id=o.report_normalization_id where o.store_id=$1 and n.catalog_revision=$2`,[scope.store,revision])).rows[0].variant_id,expected);
      assert.equal((await client.query(`select variant_id from mc.variant_identifiers where store_id=$1 and identifier_value='shared-other' and valid_to is null`,[scope.store])).rows[0].variant_id,scope.variants[1]);
      assert.equal((await client.query(`select current_version_id from mc.variant_costs where id=$1`,[scope.cost])).rows[0].current_version_id,scope.costVersion);
    });
  }
  await sync([sourceVariant('M')]);
  await assertCurrentVariant(null);
  const unmatched=await runFinancialCalculation(scope.user,scope.store);
  assert.ok(unmatched.missingReasons.includes('product_link_missing'));
  await context(scope,async client=>assert.equal((await client.query(`select count(*)::int n from mc.result_evidence e join mc.result_lines line on line.id=e.result_line_id where line.run_id=$1 and e.cost_version_id is not null`,[unmatched.runId])).rows[0].n,0));
  await sync([sourceVariant('0')]);
  await assertCurrentVariant(scope.variants[0]);
  const duplicate={externalId:'duplicate-size',sizeLabel:'0',colorLabel:null,attributes:{},barcodes:[]};
  await sync([sourceVariant('0'),duplicate]);
  await assertCurrentVariant(null);
  await sync([sourceVariant('0')]);
  await assertCurrentVariant(scope.variants[0]);
  await sync([]);
  await assertCurrentVariant(null);
  await context(scope,async client=>assert.equal((await client.query(`select status from mc.variants where id=$1`,[scope.variants[0]])).rows[0].status,'archived'));
  await sync([sourceVariant('0')]);
  await assertCurrentVariant(scope.variants[0]);
  await context(scope,async client=>assert.equal((await client.query(`select status from mc.variants where id=$1`,[scope.variants[0]])).rows[0].status,'active'));
});
