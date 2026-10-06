import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const integrationUrl=process.env.TARIFF_PROFILES_INTEGRATION_DATABASE_URL;
if(!integrationUrl)throw new Error('Set TARIFF_PROFILES_INTEGRATION_DATABASE_URL to an empty disposable PostgreSQL database whose name contains "test".');
if(!new URL(integrationUrl).pathname.slice(1).toLowerCase().includes('test'))throw new Error('Refusing tariff profiles integration outside a database whose name contains "test".');
process.env.DATABASE_URL=integrationUrl;
const {pool}=await import('../../app/infrastructure/database/client.mjs');
test.after(async()=>{await pool.end();});

// This scenario verifies the deliberately inert stage-073 contract. Later
// runtime cutover and reconciliation have their own lifecycle integration.
async function migrateFoundation(){
  const applied=new Set((await pool.query('select version from mc.schema_migrations')).rows.map(row=>row.version));
  const directory=path.resolve('db/migrations');
  for(const file of (await readdir(directory)).filter(name=>/^\d+_.+\.sql$/.test(name)&&Number(name.slice(0,3))<=73).sort()){
    if(!applied.has(Number(file.slice(0,3))))await pool.query(await readFile(path.join(directory,file),'utf8'));
  }
}

async function context(scope,action,role){
  const client=await pool.connect();
  try{
    await client.query('begin');
    if(role)await client.query(`set local role ${role}`);
    await client.query("select set_config('app.user_id',$1,true),set_config('app.business_id',$2,true)",[scope.user,scope.business]);
    const result=await action(client);
    await client.query('commit');
    return result;
  }catch(error){await client.query('rollback');throw error;}finally{client.release();}
}

async function fixture(paid=false,select=true){
  const scope={user:randomUUID(),business:randomUUID(),store:randomUUID(),products:[]};
  await context(scope,async client=>{
    await client.query(`insert into mc.users(id,display_name) values($1,'Tariff owner')`,[scope.user]);
    await client.query(`insert into mc.businesses(id,name) values($1,'Tariff test')`,[scope.business]);
    await client.query(`insert into mc.memberships(business_id,user_id,role) values($1,$2,'owner')`,[scope.business,scope.user]);
    if(paid)await client.query(`update mc.subscriptions set plan_version_id=(select v.id from mc.billing_plan_versions v join mc.billing_plans p on p.id=v.plan_id where p.code='plus' order by v.version_no desc limit 1) where business_id=$1`,[scope.business]);
    if(!select)return;
    await client.query(`insert into mc.stores(id,business_id,external_account_id,name,status) values($1,$2,$3,'Tariff store','active')`,[scope.store,scope.business,scope.store]);
    const document=(await client.query(`insert into mc.source_documents(business_id,store_id,origin,document_type,checksum,completeness) values($1,$2,'wb_api','catalog',$3,'complete') returning id`,[scope.business,scope.store,randomUUID()])).rows[0];
    for(let index=0;index<(paid?5:2);index++){
      const product=(await client.query(`insert into mc.products(business_id,store_id,wb_article,seller_article) values($1,$2,$3,$4) returning id`,[scope.business,scope.store,900001+index,`TARIFF-${index}`])).rows[0];
      scope.products.push(product.id);
    }
    await client.query(`select mc.confirm_product_selection($1,$2,$3::uuid[])`,[scope.store,document.id,scope.products]);
    if(paid){
      scope.archivedStore=randomUUID();
      await client.query(`insert into mc.stores(id,business_id,external_account_id,name,status) values($1,$2,$3,'Historical store','active')`,[scope.archivedStore,scope.business,scope.archivedStore]);
      const archivedDocument=(await client.query(`insert into mc.source_documents(business_id,store_id,origin,document_type,checksum,completeness) values($1,$2,'wb_api','catalog',$3,'complete') returning id`,[scope.business,scope.archivedStore,randomUUID()])).rows[0];
      const archivedProduct=(await client.query(`insert into mc.products(business_id,store_id,wb_article,seller_article) values($1,$2,900099,'Archived tariff product') returning id`,[scope.business,scope.archivedStore])).rows[0];
      await client.query(`select mc.confirm_product_selection($1,$2,$3::uuid[])`,[scope.archivedStore,archivedDocument.id,[archivedProduct.id]]);
      await client.query(`update mc.stores set status='archived' where id=$1`,[scope.archivedStore]);
      scope.extraStore=randomUUID();
      await client.query(`insert into mc.stores(id,business_id,external_account_id,name,status) values($1,$2,$3,'Store without selection','active')`,[scope.extraStore,scope.business,scope.extraStore]);
    }
  });
  return scope;
}

async function snapshot(scope){
  return context(scope,async client=>{
    const result={};
    for(const table of ['subscriptions','subscription_events','stores','products','source_documents','product_selections','product_selection_items','financial_input_events','jobs']){
      result[table]=(await client.query(`select * from mc.${table} where business_id=$1 order by id`,[scope.business])).rows;
    }
    return result;
  });
}

test('tariff foundation preserves runtime and history, creates isolated snapshots and free registration state',async t=>{
  assert.equal((await pool.query("select to_regclass('mc.schema_migrations') table_name")).rows[0].table_name,null,'use an empty disposable database');
  const directory=path.resolve('db/migrations');
  for(const file of (await readdir(directory)).filter(name=>/^\d+_.+\.sql$/.test(name)&&Number(name.slice(0,3))<73).sort())await pool.query(await readFile(path.join(directory,file),'utf8'));
  const paid=await fixture(true),free=await fixture(),empty=await fixture(false,false);
  const scopes=[paid,free,empty];
  const before=await Promise.all(scopes.map(snapshot));
  await migrateFoundation();
  assert.equal((await pool.query('select max(version)::int version from mc.schema_migrations')).rows[0].version,73,'foundation scenario must not enable the later runtime cutover');
  const states=[];
  for(const [index,scope] of scopes.entries()){
    assert.deepEqual(await snapshot(scope),before[index],'migration must not change historical data, subscriptions or financial jobs');
    states.push(await context(scope,async client=>{
      const state=(await client.query(`select * from mc.tariff_profile_state where business_id=$1`,[scope.business])).rows[0];
      assert.equal(state.revision,'1');
      const freeProfile=(await client.query(`select p.*,b.code from mc.tariff_profiles p join mc.billing_plans b on b.id=p.plan_id where p.id=$1`,[state.free_profile_id])).rows[0];
      assert.equal(freeProfile.code,'free');
      assert.equal(freeProfile.revision,'1');
      assert.equal(freeProfile.selection_confirmed,false);
      assert.equal((await client.query(`select * from mc.tariff_profile_stores where profile_id=$1`,[state.free_profile_id])).rowCount,0);
      assert.equal((await client.query(`select * from mc.tariff_profile_products where profile_id=$1`,[state.free_profile_id])).rowCount,0,'unknown original free subset must never be guessed');
      const products=(await client.query(`select product_id from mc.tariff_profile_products where profile_id=$1 order by product_id`,[state.active_profile_id])).rows.map(row=>row.product_id);
      assert.deepEqual(products,index===0?[...scope.products].sort():[]);
      const stores=(await client.query(`select store_id from mc.tariff_profile_stores where profile_id=$1 order by store_id`,[state.active_profile_id])).rows.map(row=>row.store_id);
      assert.deepEqual(stores,index===0?[scope.store,scope.extraStore].sort():[],'retain connected paid stores without a confirmed selection');
      assert.equal((await client.query(`select selection_confirmed from mc.tariff_profiles where id=$1`,[state.active_profile_id])).rows[0].selection_confirmed,index===0);
      assert.equal((await client.query(`select period_end from mc.subscriptions where business_id=$1`,[scope.business])).rows[0].period_end,null,'do not invent a legacy expiry');
      return state;
    }));
  }
  const registered=await fixture(false,false);
  await context(registered,async client=>{
    const state=(await client.query(`select * from mc.tariff_profile_state where business_id=$1`,[registered.business])).rows[0];
    assert.ok(state);
    assert.equal(state.active_profile_id,state.free_profile_id);
    assert.equal((await client.query(`select count(*)::int count from mc.tariff_profiles where business_id=$1`,[registered.business])).rows[0].count,1);
    assert.equal((await client.query(`select count(*)::int count from mc.tariff_profile_products where business_id=$1`,[registered.business])).rows[0].count,0);
  });

  const role=`tariff_test_${randomUUID().replaceAll('-','')}`;
  await pool.query(`create role ${role} nologin nosuperuser nobypassrls`);
  t.after(async()=>{await pool.query(`drop owned by ${role}`);await pool.query(`drop role ${role}`);});
  await pool.query(`grant usage on schema mc to ${role}`);
  await pool.query(`grant select on mc.tariff_profiles,mc.tariff_profile_stores,mc.tariff_profile_products,mc.tariff_profile_state to ${role}`);
  await pool.query(`grant execute on function mc.context_business_id() to ${role}`);
  await context(paid,async client=>{
    for(const table of ['tariff_profiles','tariff_profile_stores','tariff_profile_products','tariff_profile_state']){
      assert.ok((await client.query(`select * from mc.${table}`)).rows.every(row=>row.business_id===paid.business));
      assert.equal((await client.query(`select * from mc.${table} where business_id=$1`,[free.business])).rowCount,0);
      const flags=(await client.query(`select relrowsecurity,relforcerowsecurity from pg_class where oid=$1::regclass`,[`mc.${table}`])).rows[0];
      assert.deepEqual(flags,{relrowsecurity:true,relforcerowsecurity:true});
    }
    assert.equal((await client.query(`select has_function_privilege(current_user,'mc.initialize_tariff_profile()','EXECUTE') allowed`)).rows[0].allowed,false);
  },role);
  await assert.rejects(()=>context(paid,client=>client.query(`update mc.tariff_profile_state set revision=2 where business_id=$1`,[paid.business]),role),{code:'42501'});
  // Even explicitly granted DML cannot cross tenants. Production grants remain
  // absent: this adversarial grant applies only to the disposable test role.
  await pool.query(`grant insert on mc.tariff_profile_stores,mc.tariff_profile_products to ${role}`);
  await pool.query(`grant update on mc.tariff_profile_state,mc.tariff_profiles to ${role}`);
  await pool.query(`grant select on mc.billing_plans to ${role}`);
  await assert.rejects(()=>context(paid,client=>client.query(`insert into mc.tariff_profile_stores(business_id,profile_id,store_id) values($1,$2,$3)`,[free.business,states[1].free_profile_id,free.store]),role),{code:'42501'});
  await assert.rejects(()=>context(paid,client=>client.query(`insert into mc.tariff_profile_stores(business_id,profile_id,store_id) values($1,$2,$3)`,[paid.business,states[1].free_profile_id,paid.store]),role),{code:'23503'});
  await assert.rejects(()=>context(paid,client=>client.query(`insert into mc.tariff_profile_stores(business_id,profile_id,store_id) values($1,$2,$3)`,[paid.business,states[0].free_profile_id,free.store]),role),{code:'23503'});
  await assert.rejects(()=>context(paid,client=>client.query(`update mc.tariff_profile_state set active_profile_id=$1 where business_id=$2`,[states[1].active_profile_id,paid.business]),role),{code:'23503'});
  await assert.rejects(()=>context(paid,client=>client.query(`update mc.tariff_profile_state set free_profile_id=$1 where business_id=$2`,[states[0].active_profile_id,paid.business]),role),{code:'23514'},'paid profile cannot become the free baseline');
  await assert.rejects(()=>context(paid,client=>client.query(`update mc.tariff_profiles set plan_id=(select id from mc.billing_plans where code='free') where id=$1`,[states[0].active_profile_id]),role),{code:'23514'},'profile plan identity is immutable');
  await assert.rejects(()=>context(paid,client=>client.query(`update mc.tariff_profiles set revision=0 where id=$1`,[states[0].active_profile_id]),role),{code:'23514'});
  await assert.rejects(()=>context(paid,client=>client.query(`insert into mc.tariff_profile_products(business_id,profile_id,store_id,product_id) values($1,$2,$3,$4)`,[paid.business,states[0].free_profile_id,paid.store,paid.products[0]]),role),{code:'23503'},'profile store membership is required');
  await assert.rejects(()=>context(paid,client=>client.query(`insert into mc.tariff_profile_products(business_id,profile_id,store_id,product_id) values($1,$2,$3,$4)`,[paid.business,states[0].active_profile_id,paid.store,free.products[0]]),role),{code:'23503'},'historical item must belong to the same business/store');

  // Migration runner skips completed versions. Direct SQL reapplication is not
  // supported, following the existing migration contract.
  await migrateFoundation();
  for(const [index,scope] of scopes.entries()){
    assert.deepEqual(await snapshot(scope),before[index]);
    const state=await context(scope,async client=>(await client.query(`select * from mc.tariff_profile_state where business_id=$1`,[scope.business])).rows[0]);
    assert.deepEqual(state,states[index]);
  }
});
