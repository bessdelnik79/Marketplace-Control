import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
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
  await db.exec(await readFile(path.join(root,'db/migrations/001_initial.sql'),'utf8'));
  await db.exec(await readFile(path.join(root,'db/migrations/002_password_auth.sql'),'utf8'));
  pass('all migrations apply atomically to empty PostgreSQL');
  const version = (await one('select version()')).version;
  console.log(version);
  const tables = await q("select table_name from information_schema.tables where table_schema='mc' and table_type='BASE TABLE' order by table_name");
  const user = await insert('users',{display_name:'Owner'});
  await insert('auth_identities',{user_id:user.id,provider:'password',subject:'owner@example.test'});
  await insert('auth_password_credentials',{user_id:user.id,password_hash:'scrypt$16384$8$1$salt$hash'});
  await insert('auth_sessions',{user_id:user.id,token_hash:'a'.repeat(64),expires_at:new Date(Date.now()+86400000)});
  assert.equal((await one('select max(version)::int as version from mc.schema_migrations')).version,2);
  pass('password identity and expiring session are stored by migration 2');
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
  const store = await insert('stores',{business_id:b.id,external_account_id:'cabinet-a',name:'A'});
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
  await rejects('insert into mc.product_selection_items(business_id,store_id,selection_id,product_id) values($1,$2,$3,$4)',[b.id,store.id,selection.id,products[3].id],/confirmed/,'sealed selection cannot be extended silently');
  await rejects('delete from mc.product_selections where id=$1',[selection.id],/immutable/,'selection cannot be reset by deleting header');
  await q('update mc.stores set status=$1 where id=$2',['archived',store.id]);
  await q('update mc.stores set status=$1 where id=$2',['active',store.id]);
  await rejects(selectSql,[store.id,doc.id,[products[3].id]],/already selected/,'reconnecting same store retains selection');

  const b2 = await insert('businesses',{name:'Business B'});
  await insert('memberships',{business_id:b2.id,user_id:user.id});
  const store2 = await insert('stores',{business_id:b2.id,external_account_id:'cabinet-b',name:'B'});
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
  const op = await insert('operations',{...base,source_code:'wb',source_operation_key:'report-1/row-1'});
  const ov = await insert('operation_versions',{...base,operation_id:op.id,report_row_id:rr.id,version_no:1,srid:'shared-srid',operation_type:'sale',product_id:products[0].id,variant_id:small.id,accounting_date:'2026-09-01',quantity:2});
  const component = await insert('financial_components',{...base,operation_version_id:ov.id,component_key:'revenue',category_code:'revenue',amount_signed:2000,method_version_id:method.id});
  const op2 = await insert('operations',{...base,source_code:'wb',source_operation_key:'another-row'});
  await insert('operation_versions',{...base,operation_id:op2.id,report_row_id:rr.id,version_no:1,srid:'shared-srid',operation_type:'service_charge',accounting_date:'2026-09-01'});
  pass('multiple operations may share srid');
  const run = await insert('calculation_runs',{...base,selection_id:selection.id,method_version_id:method.id,period_start:'2026-08-31',period_end:'2026-09-06',input_fingerprint:'inputs-1'});
  await insert('calculation_inputs',{...base,run_id:run.id,report_version_id:rv.id});
  await insert('calculation_inputs',{...base,run_id:run.id,cost_version_id:costV1.id});
  const line = await insert('result_lines',{...base,run_id:run.id,product_id:products[0].id,variant_id:small.id,accounting_date:'2026-09-01',category_code:'revenue',amount_signed:2000,quality:'complete'});
  await rejects("update mc.calculation_runs set status='succeeded',finished_at=now() where id=$1",[run.id],/reconcile/,'cannot finish a result without evidence');
  await insert('result_evidence',{...base,result_line_id:line.id,financial_component_id:component.id,contribution_amount:2000});
  const costLine = await insert('result_lines',{...base,run_id:run.id,product_id:products[0].id,variant_id:small.id,accounting_date:'2026-09-01',category_code:'cost_of_goods',amount_signed:-900,quality:'complete'});
  await rejects('insert into mc.result_evidence(business_id,store_id,result_line_id,cost_version_id,quantity,contribution_amount) values($1,$2,$3,$4,2,-940)',[b.id,store.id,costLine.id,costMV.id],/match variant/,'cannot use another size cost in financial evidence');
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
  await q("update mc.jobs set status='succeeded' where id=$1",[job.id]);
  await insert('jobs',{...base,job_type:'sync',deduplication_key:'sync-1'});
  pass('completed job does not block next scheduled sync');

  // Deliberately use a non-owner role: superusers bypass row-level security.
  await db.exec('create role mc_test_reader; grant usage on schema mc to mc_test_reader; grant select on all tables in schema mc to mc_test_reader; grant execute on function mc.context_business_id(),mc.context_user_id() to mc_test_reader; set role mc_test_reader;');
  await context(b.id,user.id);
  assert.equal((await one('select count(*)::int as n from mc.stores')).n,1);
  assert.equal((await one('select count(*)::int as n from mc.products where store_id=$1',[store2.id])).n,0);
  assert.equal((await one('select count(*)::int as n from mc.selected_products')).n,3);
  pass('non-owner role sees only current business, including views');
  await context('',user.id);
  assert.equal((await one('select count(*)::int as n from mc.products')).n,0);
  pass('missing tenant context fails closed');
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
  const extra = await insert('stores',{business_id:b.id,external_account_id:'a-second',name:'A second'});
  const ep1 = await product(extra,9991), ep2 = await product(extra,9992);
  const extraDoc = await insert('source_documents',{business_id:b.id,store_id:extra.id,origin:'wb_api',document_type:'catalog',checksum:'cat-extra',completeness:'partial'});
  await rejects(selectSql,[extra.id,extraDoc.id,[ep1.id]],/complete WB catalog/,'selection waits for complete initial catalog');
  await q("update mc.source_documents set completeness='complete' where id=$1",[extraDoc.id]);
  await rejects(selectSql,[extra.id,extraDoc.id,[ep1.id,ep2.id]],/product limit/,'product quota is shared across stores');
  await one(selectSql,[extra.id,extraDoc.id,[ep1.id]]);
  pass('new plan permits another store with remaining product allowance');
  await rejects('update mc.subscriptions set plan_version_id=$1 where business_id=$2',[byCode.free.id,b.id],/downgrade/,'unresolved downgrade cannot silently remove selected products');
  await rejects('update mc.billing_plan_versions set product_limit=999 where id=$1',[byCode.free.id],/immutable/,'published plan conditions require a new version');

  const isolated = await insert('businesses',{name:'Deferred selection test'});
  await insert('memberships',{business_id:isolated.id,user_id:user.id});
  const isolatedStore = await insert('stores',{business_id:isolated.id,external_account_id:'isolated',name:'isolated'});
  const isolatedDoc = await insert('source_documents',{business_id:isolated.id,store_id:isolatedStore.id,origin:'wb_api',document_type:'catalog',checksum:'isolated',completeness:'complete'});
  await rejects('insert into mc.product_selections(business_id,store_id,plan_version_id,catalog_document_id,confirmed_by,product_limit_snapshot) values($1,$2,$3,$4,$5,3)',[isolated.id,isolatedStore.id,byCode.free.id,isolatedDoc.id,user.id],/nonempty and confirmed/,'cannot commit an unfinished selection header');

  // Produce a machine-derived field/constraint inventory for review.
  const cols = await q("select table_name,column_name,data_type,udt_name,is_nullable,column_default,numeric_precision,numeric_scale from information_schema.columns where table_schema='mc' order by table_name,ordinal_position");
  const constraints = await q("select c.relname as table_name,con.conname,con.contype,pg_get_constraintdef(con.oid) as definition from pg_constraint con join pg_class c on c.oid=con.conrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='mc' order by c.relname,con.conname");
  const inventory = ['# Marketplace Control — словарь БД, итерация 1','','Сформирован из применённой миграции. Названия полей, типы, значения по умолчанию и ограничения соответствуют проверенной схеме.','','Денежные значения — точные десятичные числа. NULL означает отсутствие значения. Все даты периодов включительны; стоимость действует от effective_from до следующей даты стоимости варианта.',''];
  for(const t of tables) {
    inventory.push(`## ${t.table_name}`,'','| Поле | Тип | NULL | По умолчанию |','|---|---|---|---|');
    for(const c of cols.filter(x=>x.table_name===t.table_name)) {
      const type=c.data_type==='numeric'?`numeric(${c.numeric_precision},${c.numeric_scale})`:c.data_type;
      inventory.push(`| ${c.column_name} | ${type} | ${c.is_nullable==='YES'?'да':'нет'} | ${(c.column_default??'—').replaceAll('|','\\|')} |`);
    }
    inventory.push('','Ограничения и связи:','');
    for(const c of constraints.filter(x=>x.table_name===t.table_name)) inventory.push(`- \`${c.definition}\``);
    inventory.push('');
  }
  await mkdir(path.join(root,'outputs'),{recursive:true});
  await writeFile(path.join(root,'outputs/database-v1-dictionary.md'),inventory.join('\n')+'\n');
  await mkdir(path.join(root,'work'),{recursive:true});
  await writeFile(path.join(root,'work/db-test-result.json'),JSON.stringify({engine:version,passed:count,tables:tables.length},null,2));
  console.log(`PASS: ${count} checks, ${tables.length} tables. Dictionary generated.`);
} catch(error) {
  console.error(error.message, error.detail??'', error.where??'');
  process.exitCode=1;
} finally {
  await db.close();
}
