import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

const integrationUrl=process.env.P03_INTEGRATION_DATABASE_URL;
if(!integrationUrl)throw new Error('Set P03_INTEGRATION_DATABASE_URL to a disposable PostgreSQL database whose name contains "test".');
const databaseName=new URL(integrationUrl).pathname.slice(1);
if(!databaseName.toLowerCase().includes('test'))throw new Error('Refusing to run P0.3 integration tests outside a database whose name contains "test".');
process.env.DATABASE_URL=integrationUrl;

const {migrate,pool,runFinancialCalculation,completeFinancialSync}=await import('../../app/db.mjs');
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
  const reportRow=(await client.query(`insert into mc.report_rows(business_id,store_id,report_version_id,external_row_key,row_number,raw_data,row_checksum) values($1,$2,$3,'1',1,'{}','p03-row') returning id`,[ids.business,ids.store,reportVersion.id])).rows[0];
  await client.query(`update mc.report_versions set status='validated' where id=$1`,[reportVersion.id]);
  await client.query(`update mc.report_versions set status='accepted',accepted_at=now() where id=$1`,[reportVersion.id]);
  await client.query(`update mc.reports set current_version_id=$1 where id=$2`,[reportVersion.id,report.id]);
  const importMethod=(await client.query(`select id from mc.method_versions where code='wb_finance_import' and version_no=2`)).rows[0];
  const normalization=(await client.query(`insert into mc.report_normalizations(business_id,store_id,report_version_id,method_version_id,normalization_key,status) values($1,$2,$3,$4,$5,'succeeded') returning id`,[ids.business,ids.store,reportVersion.id,importMethod.id,`wb-finance-v2:${reportVersion.id}`])).rows[0];
  const operation=(await client.query(`insert into mc.operations(business_id,store_id,source_code,source_operation_key) values($1,$2,'wb_finance','785995400/1') returning id`,[ids.business,ids.store])).rows[0];
  const operationVersion=(await client.query(`insert into mc.operation_versions(business_id,store_id,operation_id,report_row_id,report_normalization_id,version_no,operation_type,product_id,variant_id,accounting_date,quantity) values($1,$2,$3,$4,$5,1,'sale',$6,$7,'2026-07-15',1) returning id`,[ids.business,ids.store,operation.id,reportRow.id,normalization.id,product.id,variant.id])).rows[0];
  await client.query(`insert into mc.financial_components(business_id,store_id,operation_version_id,component_key,category_code,amount_signed,method_version_id,source_field,result_scope_classification) values($1,$2,$3,'retailAmount','revenue',100,$4,'retailAmount','selected_product')`,[ids.business,ids.store,operationVersion.id,importMethod.id]);
  assert.ok(selection.id);
});

test('P0.3 creates a reproducible partial result and idempotently keeps one publication',async()=>{
  const first=await runFinancialCalculation(ids.user,ids.store);
  assert.equal(first.quality,'partial');
  assert.deepEqual(first.missingReasons,['tax_setting_missing']);
  assert.equal(first.totals.availableResultBeforeTax,'60.0000');
  const second=await runFinancialCalculation(ids.user,ids.store);
  assert.equal(second.changed,false);
  const saved=await context(async client=>(await client.query(
    `select r.quality,r.missing_reasons,count(distinct p.id)::int publications,sum(l.amount_signed)::text total
       from mc.publications p join mc.calculation_runs r on r.id=p.run_id
       left join mc.result_lines l on l.run_id=r.id
      where p.store_id=$1 and p.is_current group by r.quality,r.missing_reasons`,[ids.store]
  )).rows[0]);
  assert.equal(saved.quality,'partial');
  assert.deepEqual(saved.missing_reasons,['tax_setting_missing']);
  assert.equal(saved.publications,1);
  assert.equal(saved.total,'60.0000');
});

test('financial sync reselects a previously accepted checksum without duplicating its version',async()=>{
  const fixture=await context(async client=>{
    const stream=(await client.query(
      `insert into mc.sync_streams(business_id,store_id,source_type) values($1,$2,'financial_reports') returning id`,
      [ids.business,ids.store]
    )).rows[0];
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
  const source={externalReportId:'p03-reselect',periodStart:'2026-08-10',periodEnd:'2026-08-16',checksum:'p03-old-checksum'};
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

test.after(async()=>{await pool.end();});
