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
  assert.equal((await one('select max(version)::int as version from mc.schema_migrations')).version,23);
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
  const resultMethodV3=await one("select implementation_version from mc.method_versions where code='financial_result' and version_no=3");
  assert.equal(resultMethodV3.implementation_version,'financial-result-v3');
  const resultMethodV4=await one("select implementation_version,parameters from mc.method_versions where code='financial_result' and version_no=4");
  assert.equal(resultMethodV4.implementation_version,'financial-result-v4');
  assert.equal(resultMethodV4.parameters.rounding,'once-per-selected-product');
  const resultMethodV6=await one("select implementation_version,parameters from mc.method_versions where code='financial_result' and version_no=6");
  assert.equal(resultMethodV6.implementation_version,'financial-result-v6');
  assert.equal(resultMethodV6.parameters.zeroSaleTaxBase,'complete-coverage-v1');
  assert.deepEqual(await q("select code,class from mc.financial_categories where code in ('pickup_reward','wb_reward_without_vat','wb_reward_vat') order by code"),[
    {code:'pickup_reward',class:'income'},{code:'wb_reward_vat',class:'expense'},{code:'wb_reward_without_vat',class:'expense'}
  ]);
  const guards=(await q("select proname,pg_get_functiondef(p.oid) as definition from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='mc' and proname in ('guard_period_result','guard_selected_tax_artifact','guard_selected_tax_finish','guard_run_finish') order by proname"));
  assert.equal(guards.length,4);
  for(const guard of guards)assert.match(guard.definition,/financial-result-v6/,guard.proname);
  const taxComputationColumns=(await q("select column_name from information_schema.columns where table_schema='mc' and table_name='tax_computations' order by column_name")).map(row=>row.column_name);
  assert.ok(taxComputationColumns.includes('product_id'));
  assert.ok(!taxComputationColumns.includes('tax_year')&&!taxComputationColumns.includes('tax_setting_version_id')&&!taxComputationColumns.includes('rate_fraction'));
  assert.equal((await one("select count(*)::int as n from information_schema.columns where table_schema='mc' and table_name='tax_computation_segments' and column_name='tax_amount'")).n,0);
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
  await q("update mc.jobs set status='succeeded' where id=$1",[job.id]);
  await insert('jobs',{...base,job_type:'sync',deduplication_key:'sync-1'});
  pass('completed job does not block next scheduled sync');

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
