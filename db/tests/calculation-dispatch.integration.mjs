import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {readFile,readdir} from 'node:fs/promises';
const integrationUrl=process.env.CALCULATION_DISPATCH_INTEGRATION_DATABASE_URL;
if(!integrationUrl)throw new Error('Set CALCULATION_DISPATCH_INTEGRATION_DATABASE_URL to a disposable PostgreSQL database whose name contains "test".');
const databaseName=new URL(integrationUrl).pathname.slice(1);
if(!databaseName.toLowerCase().includes('test'))throw new Error('Refusing to run calculation dispatcher integration tests outside a database whose name contains "test".');
process.env.DATABASE_URL=integrationUrl;

const {pool,jobsRepository,financialDailyGenerationRepository}=await import('../../app/db.mjs');
const ids={user:randomUUID(),business:randomUUID(),store:randomUUID()};

for(const name of (await readdir(new URL('../migrations/',import.meta.url))).filter(name=>/^\d+_.+\.sql$/.test(name)&&Number(name.slice(0,3))<78).sort())await pool.query(await readFile(new URL('../migrations/'+name,import.meta.url),'utf8'));
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
  await client.query(`select mc.emit_financial_input_event($1,$2,'report_accepted','2026-07-13','2026-07-19',
    p_source_report_version_id=>$3,p_source_normalization_id=>$4)`,[ids.store,`accepted:${normalization.id}`,reportVersion.id,normalization.id]);
  assert.ok(selection.id);
});

await pool.query(await readFile(new URL('../migrations/078_calculation_dispatch.sql',import.meta.url),'utf8'));
const {createFinancialCalculationWorker}=await import('../../app/modules/calculation/calculation-sync.mjs');
const {createFinancialDailyGenerationWorker}=await import('../../app/modules/calculation/daily-generation-worker.mjs');

test('ordinary background worker discovers a fresh account and publishes while financial history is pending',async()=>{
  const role=(await pool.query('select rolsuper,rolbypassrls from pg_roles where rolname=current_user')).rows[0];
  assert.deepEqual(role,{rolsuper:false,rolbypassrls:false},'run with a non-superuser migration owner');
  assert.equal((await pool.query('select count(*)::int n from mc.calculation_invalidations')).rows[0].n,0);
  assert.equal((await pool.query('select * from mc.list_calculation_invalidations()')).rows[0].store_id,ids.store,'backfill must be visible without tenant context');
  const active=await context(async client=>(await client.query(
    `select id from mc.enqueue_job($1,'financial_report_fetch',$2,'{"schemaVersion":1}'::jsonb,clock_timestamp(),100,5)`,
    [ids.store,`ongoing-history:${randomUUID()}`])).rows[0]);
  const worker=createFinancialCalculationWorker();
  assert.equal(await worker.runOnce(),true);
  assert.equal((await pool.query('select * from mc.list_calculation_invalidations()')).rows.length,0,'ack must clear both queues without ambient tenant context');
  assert.ok(await context(async client=>(await client.query('select id from mc.publications where store_id=$1',[ids.store])).rows[0]));
  const daily=createFinancialDailyGenerationWorker({jobs:jobsRepository,repository:financialDailyGenerationRepository});
  for(let attempt=0;attempt<5;attempt++)if(!await daily.runOnce())break;
  const published=await context(async client=>(await client.query('select publication_id from mc.financial_daily_current_publications where store_id=$1',[ids.store])).rows[0]);
  assert.ok(published,'fresh account must get its first daily publication');
  const quality=await context(async client=>(await client.query(`select g.quality,
    exists(select 1 from mc.financial_daily_reasons r where r.generation_id=g.id and r.reason_code='tax_setting_missing') tax_missing
    from mc.financial_daily_current_publications p join mc.financial_daily_publications publication on publication.id=p.publication_id
    join mc.financial_daily_generations g on g.id=publication.generation_id where p.store_id=$1`,[ids.store])).rows[0]);
  assert.equal(quality.quality,'partial');assert.equal(quality.tax_missing,true);
  assert.equal(await context(async client=>(await client.query('select status from mc.jobs where id=$1',[active.id])).rows[0].status),'pending','financial backfill must still be ongoing');
});

test('dispatch mirrors new requests, preserves newer tokens and restores caller context',async()=>{
  const first=await context(async client=>(await client.query(
    `insert into mc.calculation_invalidations(business_id,store_id,requested_by,reason)
     values($1,$2,$3,'dispatch-regression') returning generation_token`,[ids.business,ids.store,ids.user])).rows[0].generation_token);
  const second=await context(async client=>(await client.query(
    `update mc.calculation_invalidations set generation_token=gen_random_uuid() where store_id=$1 returning generation_token`,[ids.store])).rows[0].generation_token);
  const client=await pool.connect();
  try{
    await client.query('begin');
    const outsider=randomUUID();
    await client.query("select set_config('app.user_id',$1,true),set_config('app.business_id',$2,true)",[outsider,randomUUID()]);
    const original=(await client.query("select current_setting('app.user_id') u,current_setting('app.business_id') b")).rows[0];
    for(const [actor,token,expected] of [[ids.user,first,false],[outsider,second,false],[ids.user,second,true]]){
      assert.equal((await client.query('select mc.ack_calculation_invalidation($1,$2,$3) ok',[actor,ids.store,token])).rows[0].ok,expected);
      assert.deepEqual((await client.query("select current_setting('app.user_id') u,current_setting('app.business_id') b")).rows[0],original);
    }
    assert.equal((await client.query('select count(*)::int n from mc.calculation_dispatch')).rows[0].n,0);
    await client.query('commit');
  }finally{await client.query('rollback');client.release();}
});

test('null actor stays undispatched and direct deletion removes its internal mirror',async()=>{
  await context(client=>client.query(`insert into mc.calculation_invalidations(business_id,store_id,requested_by,reason) values($1,$2,null,'background-source')`,[ids.business,ids.store]));
  assert.equal((await pool.query('select count(*)::int n from mc.calculation_dispatch')).rows[0].n,1);
  assert.equal((await pool.query('select * from mc.list_calculation_invalidations()')).rows.length,0);
  await context(client=>client.query('delete from mc.calculation_invalidations where store_id=$1',[ids.store]));
  assert.equal((await pool.query('select count(*)::int n from mc.calculation_dispatch')).rows[0].n,0);
  assert.equal((await pool.query("select relforcerowsecurity from pg_class where oid='mc.calculation_invalidations'::regclass")).rows[0].relforcerowsecurity,true);
  for(const privilege of ["has_table_privilege('public','mc.calculation_dispatch','select')","has_function_privilege('public','mc.list_calculation_invalidations()','execute')","has_function_privilege('public','mc.ack_calculation_invalidation(uuid,uuid,uuid)','execute')"]){
    assert.equal((await pool.query(`select ${privilege} allowed`)).rows[0].allowed,false);
  }
});

test('concurrent acknowledgement cannot consume a newer invalidation',async()=>{
  const first=await context(async client=>(await client.query(
    `insert into mc.calculation_invalidations(business_id,store_id,requested_by,reason) values($1,$2,$3,'concurrent-regression') returning generation_token`,[ids.business,ids.store,ids.user])).rows[0].generation_token);
  const updater=await pool.connect(),acknowledger=await pool.connect();
  let pending;
  try{
    await updater.query('begin');
    await updater.query("select set_config('app.user_id',$1,true),set_config('app.business_id',$2,true)",[ids.user,ids.business]);
    const newer=(await updater.query('update mc.calculation_invalidations set generation_token=gen_random_uuid() where store_id=$1 returning generation_token',[ids.store])).rows[0].generation_token;
    const pid=(await acknowledger.query('select pg_backend_pid() pid')).rows[0].pid;
    pending=acknowledger.query('select mc.ack_calculation_invalidation($1,$2,$3) ok',[ids.user,ids.store,first]);
    let waiting=false;
    for(let attempt=0;attempt<100;attempt++){
      waiting=(await pool.query("select wait_event_type='Lock' waiting from pg_stat_activity where pid=$1",[pid])).rows[0]?.waiting===true;
      if(waiting)break;
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    assert.equal(waiting,true,'ack must actually overlap the held invalidation update');
    await updater.query('commit');
    assert.equal((await pending).rows[0].ok,false);
    assert.equal((await pool.query('select generation_token from mc.list_calculation_invalidations() where store_id=$1',[ids.store])).rows[0].generation_token,newer);
    assert.equal((await pool.query('select mc.ack_calculation_invalidation($1,$2,$3) ok',[ids.user,ids.store,newer])).rows[0].ok,true);
  }finally{
    await updater.query('rollback');if(pending)await pending;
    updater.release();acknowledger.release();
  }
});

test('two accounts remain isolated and erasure removes only its own dispatch metadata',async()=>{
  async function fixture(){
    const user=randomUUID(),business=randomUUID(),store=randomUUID();
    const client=await pool.connect();
    try{
      await client.query('begin');
      await client.query("select set_config('app.user_id',$1,true),set_config('app.business_id',$2,true)",[user,business]);
      await client.query("insert into mc.users(id,display_name) values($1,'Dispatch owner')",[user]);
      await client.query("insert into mc.businesses(id,name) values($1,'Dispatch business')",[business]);
      await client.query("insert into mc.memberships(business_id,user_id,role) values($1,$2,'owner')",[business,user]);
      await client.query("insert into mc.auth_password_credentials(user_id,password_hash) values($1,'scrypt$test')",[user]);
      await client.query("insert into mc.auth_sessions(user_id,token_hash,expires_at) values($1,$2,now()+interval '1 hour')",[user,user]);
      await client.query("insert into mc.stores(id,business_id,name,status) values($1,$2,'Dispatch store','paused')",[store,business]);
      const token=(await client.query("insert into mc.calculation_invalidations(business_id,store_id,requested_by,reason) values($1,$2,$3,'isolation-regression') returning generation_token",[business,store,user])).rows[0].generation_token;
      await client.query('commit');return{user,business,store,token};
    }finally{await client.query('rollback');client.release();}
  }
  const a=await fixture(),b=await fixture();
  assert.equal((await pool.query('select * from mc.list_calculation_invalidations()')).rows.length,2);
  assert.equal((await pool.query('select count(*)::int n from mc.calculation_invalidations')).rows[0].n,0);
  assert.equal((await pool.query('select mc.ack_calculation_invalidation($1,$2,$3) ok',[b.user,a.store,a.token])).rows[0].ok,false);
  const viewer=randomUUID(),editor=randomUUID();
  const members=await pool.connect();
  try{
    await members.query('begin');
    await members.query("select set_config('app.business_id',$1,true)",[b.business]);
    for(const [user,role] of [[viewer,'viewer'],[editor,'editor']]){
      await members.query("select set_config('app.user_id',$1,true)",[user]);
      await members.query("insert into mc.users(id,display_name) values($1,'Dispatch member')",[user]);
      await members.query('insert into mc.memberships(business_id,user_id,role) values($1,$2,$3)',[b.business,user,role]);
    }
    await members.query('commit');
  }finally{await members.query('rollback');members.release();}
  assert.equal((await pool.query('select mc.ack_calculation_invalidation($1,$2,$3) ok',[viewer,b.store,b.token])).rows[0].ok,false);
  const client=await pool.connect();
  try{
    await client.query('begin');
    await client.query("select set_config('app.user_id',$1,true),set_config('app.business_id',$2,true)",[a.user,a.business]);
    await client.query("select mc.erase_account($1,$2,'scrypt$test')",[a.user,a.user]);
    await client.query('commit');
  }finally{await client.query('rollback');client.release();}
  const remaining=(await pool.query('select * from mc.list_calculation_invalidations()')).rows;
  assert.deepEqual(remaining.map(row=>row.store_id),[b.store]);
  assert.equal((await pool.query('select mc.ack_calculation_invalidation($1,$2,$3) ok',[editor,b.store,b.token])).rows[0].ok,true);
});

test('rolled-back marker changes never leave scheduler metadata behind',async()=>{
  const client=await pool.connect();
  try{
    await client.query('begin');
    await client.query("select set_config('app.user_id',$1,true),set_config('app.business_id',$2,true)",[ids.user,ids.business]);
    await client.query("insert into mc.calculation_invalidations(business_id,store_id,requested_by,reason) values($1,$2,$3,'rollback-regression')",[ids.business,ids.store,ids.user]);
    assert.equal((await client.query('select count(*)::int n from mc.calculation_dispatch')).rows[0].n,1);
    await client.query('rollback');
    assert.equal((await client.query('select count(*)::int n from mc.calculation_dispatch')).rows[0].n,0);
  }finally{await client.query('rollback');client.release();}
});

test('ordinary reader cannot enumerate internal dispatch or invoke background acknowledgement',async()=>{
  const role=`dispatch_reader_${randomUUID().replaceAll('-','')}`;
  await pool.query(`create role ${role} nologin nosuperuser nobypassrls`);
  await pool.query(`grant ${role} to current_user`);
  await pool.query(`grant usage on schema mc to ${role}`);
  const client=await pool.connect();
  try{
    await client.query(`set role ${role}`);
    for(const sql of ['select * from mc.calculation_dispatch','select * from mc.list_calculation_invalidations()',
      'select mc.ack_calculation_invalidation(null,null,null)'])await assert.rejects(client.query(sql),{code:'42501'});
  }finally{
    await client.query('reset role');client.release();
    await pool.query(`drop owned by ${role}`);await pool.query(`drop role ${role}`);
  }
});

test.after(async()=>{await pool.end();});
