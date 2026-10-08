import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';

const url=process.env.HEADER_PRODUCT_PROMPT_INTEGRATION_DATABASE_URL;
if(!url||!new URL(url).pathname.slice(1).toLowerCase().includes('test'))throw new Error('Set HEADER_PRODUCT_PROMPT_INTEGRATION_DATABASE_URL to an empty disposable PostgreSQL database whose name contains "test".');
process.env.DATABASE_URL=url;
const {pool,migrate}=await import('../../app/infrastructure/database/client.mjs');
const {listStores}=await import('../../app/modules/stores/stores.repository.mjs');
test.after(async()=>{await pool.end();});

async function context(scope,action){
  const client=await pool.connect();
  try{
    await client.query('begin');
    await client.query(`select set_config('app.business_id',$1,true),set_config('app.user_id',$2,true)`,[scope.business,scope.user]);
    const result=await action(client);
    await client.query('commit');
    return result;
  }catch(error){await client.query('rollback');throw error;}finally{client.release();}
}
async function addStore(scope,{connected=true,count=5}={}){
  const store={id:randomUUID(),products:[]};
  await context(scope,async client=>{
    await client.query(`insert into mc.stores(id,business_id,external_account_id,name,status)
      values($1::uuid,$2::uuid,$3::text,'Header prompt store','active')`,[store.id,scope.business,store.id]);
    await client.query(`insert into mc.connections(business_id,store_id,secret_ref,scopes,status,credential_generation)
      values($1,$2,'test','["finance","analytics"]',$3,1)`,[scope.business,store.id,connected?'active':'invalid']);
    store.catalog=(await client.query(`insert into mc.source_documents(business_id,store_id,origin,document_type,checksum,completeness)
      values($1,$2,'wb_api','catalog',$3,'complete') returning id`,[scope.business,store.id,randomUUID()])).rows[0].id;
    for(let i=0;i<count;i++)store.products.push((await client.query(`insert into mc.products(business_id,store_id,wb_article,seller_article)
      values($1,$2,$3,$4) returning id`,[scope.business,store.id,970001+i,`HEADER-${i}`])).rows[0].id);
  });
  return store;
}
async function fixture(options){
  const scope={user:randomUUID(),business:randomUUID()};
  await context(scope,async client=>{
    await client.query(`insert into mc.users(id,display_name) values($1,'Header owner')`,[scope.user]);
    await client.query(`insert into mc.businesses(id,name) values($1,'Header business')`,[scope.business]);
    await client.query(`insert into mc.memberships(business_id,user_id,role) values($1,$2,'owner')`,[scope.business,scope.user]);
  });
  scope.store=await addStore(scope,options);
  return scope;
}
const choose=(scope,store,products)=>context(scope,client=>client.query(`select mc.choose_tariff_profile_products($1,$2,$3::uuid[])`,[store.id,store.catalog,products]));
const upgrade=scope=>context(scope,client=>client.query(`select mc.apply_tariff_period($1,'plus',$2,$3)`,[scope.business,randomUUID(),new Date(Date.now()-1000)]));
const currentStore=async scope=>(await listStores(scope.user)).find(store=>store.id===scope.store.id);

test('header product prompt uses ordinary tenant-isolated profile counts across tariff transitions',async()=>{
  assert.equal((await pool.query(`select to_regclass('mc.schema_migrations') name`)).rows[0].name,null,'use an empty disposable database');
  const role=(await pool.query(`select rolsuper,rolbypassrls from pg_roles where rolname=current_user`)).rows[0];
  assert.equal(role.rolsuper,false,'run this integration as the ordinary migration owner');
  assert.equal(role.rolbypassrls,false);
  await migrate();
  const scope=await fixture();
  const initial=await currentStore(scope);
  assert.equal(initial.entitled,true);
  assert.equal(initial.connected,true);
  assert.equal(initial.unselected_product_count,5);
  assert.equal(initial.remaining_product_slots,3);
  assert.equal(initial.can_expand_selection,true,'unconfirmed free profile can make its first choice');
  await context(scope,client=>client.query(`update mc.products set status='archived' where business_id=$1 and id=$2`,[scope.business,scope.store.products[4]]));
  assert.equal((await currentStore(scope)).unselected_product_count,4,'unavailable catalog products are not offered for selection');
  await context(scope,client=>client.query(`update mc.products set status='active' where business_id=$1 and id=$2`,[scope.business,scope.store.products[4]]));
  await choose(scope,scope.store,scope.store.products.slice(0,3));
  const free=await currentStore(scope);
  assert.equal(free.unselected_product_count,2);
  assert.equal(free.remaining_product_slots,0);
  assert.equal(free.can_expand_selection,false,'confirmed free subset remains frozen');
  const foreign=await fixture();
  await choose(foreign,foreign.store,foreign.store.products.slice(0,3));
  await upgrade(scope);
  const paid=await currentStore(scope);
  assert.equal(paid.unselected_product_count,2);
  assert.equal(paid.remaining_product_slots,97,'first paid activation retains the three selected products');
  assert.equal(paid.can_expand_selection,true);
  assert.deepEqual((await listStores(scope.user)).map(store=>store.id),[scope.store.id],'foreign stores and counts are not exposed');
  await choose(scope,scope.store,scope.store.products);
  const allSelected=await currentStore(scope);
  assert.equal(allSelected.unselected_product_count,0,'header can suppress the prompt when every eligible product is selected');
  assert.equal(allSelected.remaining_product_slots,95);
  const second=await addStore(scope,{count:3});
  await choose(scope,second,second.products);
  const withSecond=await currentStore(scope);
  assert.equal(withSecond.remaining_product_slots,92,'remaining slots subtract selected products in every entitled store');
  const secondState=(await listStores(scope.user)).find(store=>store.id===second.id);
  assert.equal(secondState.remaining_product_slots,92);
  assert.equal(secondState.unselected_product_count,0);
  await context(scope,client=>client.query(`update mc.connections set status='invalid' where business_id=$1 and store_id=$2`,[scope.business,scope.store.id]));
  assert.equal((await currentStore(scope)).connected,false,'a disconnected store remains identifiable for header suppression');
  await context(scope,client=>client.query(`update mc.stores set status='paused' where business_id=$1 and id=$2`,[scope.business,scope.store.id]));
  assert.equal((await currentStore(scope)).can_expand_selection,false,'paused stores cannot accept a product choice');
  await context(scope,client=>client.query(`update mc.subscriptions set period_start='2020-01-01',period_end='2020-02-01' where business_id=$1`,[scope.business]));
  const expiredStores=await listStores(scope.user);
  const excluded=expiredStores.find(store=>store.id===second.id);
  assert.equal(excluded.connected,true);
  assert.equal(excluded.entitled,false,'retained paid store is unavailable under the free profile');
  assert.equal(excluded.can_expand_selection,false);
  assert.equal(excluded.unselected_product_count,3);
  assert.equal(excluded.remaining_product_slots,0,'expired access uses the original free three-product subset');
});
