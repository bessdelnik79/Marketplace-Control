import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

const integrationUrl=process.env.P03_INTEGRATION_DATABASE_URL;
if(!integrationUrl)throw new Error('Set P03_INTEGRATION_DATABASE_URL to a disposable PostgreSQL database whose name contains "test".');
const databaseName=new URL(integrationUrl).pathname.slice(1);
if(!databaseName.toLowerCase().includes('test'))throw new Error('Refusing to run P0.3 integration tests outside a database whose name contains "test".');
process.env.DATABASE_URL=integrationUrl;

const {migrate,pool,runFinancialCalculation,beginFinancialSync,completeFinancialSync,failFinancialSync,getFinancialBankReconciliationState,getCurrentFinancialResult}=await import('../../app/db.mjs');
const ids={user:randomUUID(),business:randomUUID(),store:randomUUID()};

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
  const reportVersion=(await client.query(`insert into mc.report_versions(business_id,store_id,report_id,document_id,version_no,checksum,parser_version) values($1,$2,$3,$4,1,'p03-v1','wb-finance-v2') returning id`,[ids.business,ids.store,report.id,document.id])).rows[0];
  const reportRow=(await client.query(`insert into mc.report_rows(business_id,store_id,report_version_id,external_row_key,row_number,raw_data,row_checksum) values($1,$2,$3,'1',1,$4::jsonb,'p03-row') returning id`,[ids.business,ids.store,reportVersion.id,JSON.stringify({docTypeName:'Продажа',sellerOperName:'Продажа',rrDate:'2026-07-15',nmId:700001,sku:'4600000000001',quantity:1,retailAmount:'100',forPay:'100'})])).rows[0];
  await client.query(`update mc.report_versions set status='validated' where id=$1`,[reportVersion.id]);
  await client.query(`update mc.report_versions set status='accepted',accepted_at=now() where id=$1`,[reportVersion.id]);
  await client.query(`update mc.reports set current_version_id=$1 where id=$2`,[reportVersion.id,report.id]);
  const importMethod=(await client.query(`select id from mc.method_versions where code='wb_finance_import' and version_no=2`)).rows[0];
  const normalization=(await client.query(`insert into mc.report_normalizations(business_id,store_id,report_version_id,method_version_id,normalization_key,status) values($1,$2,$3,$4,$5,'succeeded') returning id`,[ids.business,ids.store,reportVersion.id,importMethod.id,`wb-finance-v2:${reportVersion.id}`])).rows[0];
  const operation=(await client.query(`insert into mc.operations(business_id,store_id,source_code,source_operation_key) values($1,$2,'wb_finance','785995400/1') returning id`,[ids.business,ids.store])).rows[0];
  const operationVersion=(await client.query(`insert into mc.operation_versions(business_id,store_id,operation_id,report_row_id,report_normalization_id,version_no,operation_type,product_id,variant_id,accounting_date,quantity) values($1,$2,$3,$4,$5,1,'sale',$6,$7,'2026-07-15',1) returning id`,[ids.business,ids.store,operation.id,reportRow.id,normalization.id,product.id,variant.id])).rows[0];
  await client.query(`insert into mc.financial_components(business_id,store_id,operation_version_id,component_key,category_code,amount_signed,method_version_id,source_field,result_scope_classification) values($1,$2,$3,'retailAmount','revenue',100,$4,'retailAmount','selected_product')`,[ids.business,ids.store,operationVersion.id,importMethod.id]);
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
  assert.equal(first.totals.availableResultBeforeTax,'60.0000');
  assert.equal(first.totals.estimatedUsnTax,'6.0000');
  assert.equal(first.totals.availableResultAfterTax,'54.0000');
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
  assert.equal(saved.total,'54.0000');
  assert.deepEqual([saved.computations,saved.segments,saved.basis,saved.tax_evidence],[1,1,1,1]);
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
         values($1,$2,$3,$4,$5,$6,'wb-finance-v2') returning id`,
        [ids.business,ids.store,report.id,document.id,number,checksum]
      )).rows[0];
      await client.query(`update mc.report_versions set status='validated' where id=$1`,[version.id]);
      await client.query(`update mc.report_versions set status='accepted',accepted_at=now() where id=$1`,[version.id]);
      versions.push(version.id);
    }
    const method=(await client.query(
      `select id from mc.method_versions where code='wb_finance_import' and implementation_version='wb-finance-v2'`
    )).rows[0];
    await client.query(
      `insert into mc.report_normalizations(business_id,store_id,report_version_id,method_version_id,normalization_key,status)
       values($1,$2,$3,$4,$5,'succeeded')`,
      [ids.business,ids.store,versions[0],method.id,`wb-finance-v2:${versions[0]}`]
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
  await context(async client=>{
    const connection=(await client.query(
      `insert into mc.connections(business_id,store_id,secret_ref,status) values($1,$2,'p03-history','active') returning id`,
      [ids.business,ids.store]
    )).rows[0];
    await client.query(
      `insert into mc.connection_secrets(business_id,connection_id,ciphertext,nonce,auth_tag)
       values($1,$2,decode('00','hex'),decode(repeat('00',12),'hex'),decode(repeat('00',16),'hex'))`,
      [ids.business,connection.id]
    );
  });
  const ranges={initialRange:{dateFrom:'2026-06-01',dateTo:'2026-09-21'},recentRange:{dateFrom:'2026-09-21',dateTo:'2026-09-24'}};
  const first=await beginFinancialSync(ids.user,ids.store,{force:true,historical:true,...ranges});
  assert.equal(first.started,true);
  assert.deepEqual([first.date_from,first.date_to],['2026-08-10','2026-08-16']);
  await completeFinancialSync(ids.user,first,{documentId:randomUUID(),reports:[]});
  const second=await beginFinancialSync(ids.user,ids.store,{force:true,historical:true,...ranges});
  assert.deepEqual([second.date_from,second.date_to],['2026-08-17','2026-08-23']);
  await failFinancialSync(ids.user,second,'financial_invalid_request');
  const third=await beginFinancialSync(ids.user,ids.store,{force:true,historical:true,...ranges});
  assert.deepEqual([third.date_from,third.date_to],['2026-08-17','2026-08-23']);
  await completeFinancialSync(ids.user,third,{documentId:randomUUID(),reports:[]});
  const cursor=await context(async client=>(await client.query(
    `select cursor from mc.sync_streams where business_id=$1 and store_id=$2 and source_type='financial_reports'`,
    [ids.business,ids.store]
  )).rows[0].cursor);
  assert.equal(cursor.historicalWeekStart,'2026-08-17');
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
  const current=await getCurrentFinancialResult(ids.user,ids.store);
  assert.equal(current.taxReference.scope,'selected_products');
  assert.equal(current.taxReference.includedInResult,true);
  assert.equal(current.taxReference.estimatedTax,'6.0000');
  assert.ok(!current.taxReference.missingReasons.includes('tax_source_unlinked'));
  const profit=await context(async client=>(await client.query(`select sum(l.amount_signed)::text as amount from mc.publications p join mc.result_lines l on l.run_id=p.run_id where p.store_id=$1 and p.is_current`,[ids.store])).rows[0].amount);
  assert.equal(profit,'54.0000');
  const snapshot=await context(async client=>(await client.query(`select s.id,s.raw_data->>'bankPaymentSum' as bank_payment from mc.financial_report_summary_versions s where s.store_id=$1`,[ids.store])).rows[0]);
  assert.equal(snapshot.bank_payment,'100');
  await assert.rejects(()=>context(client=>client.query(`update mc.financial_report_summary_versions set raw_data='{}' where id=$1`,[snapshot.id])),/immutable/);
});

test.after(async()=>{await pool.end();});
