import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';

const integrationUrl=process.env.COSTS_INTEGRATION_DATABASE_URL;
if(!integrationUrl)throw new Error('Set COSTS_INTEGRATION_DATABASE_URL to a disposable PostgreSQL database whose name contains "test".');
const databaseName=new URL(integrationUrl).pathname.slice(1);
if(!databaseName.toLowerCase().includes('test'))throw new Error('Refusing to run costs integration tests outside a database whose name contains "test".');
process.env.DATABASE_URL=integrationUrl;

const {migrate,pool,getCostState,importVariantCosts}=await import('../../app/db.mjs');
const ids={user:randomUUID(),viewer:randomUUID(),business:randomUUID(),store:randomUUID()};
const foreign={user:randomUUID(),business:randomUUID(),store:randomUUID()};
test.after(async()=>{await pool.end();});

async function context(scope,action){
  const client=await pool.connect();
  try{
    await client.query('begin');
    await client.query("select set_config('app.user_id',$1,true),set_config('app.business_id',$2,true)",[scope.user,scope.business]);
    const value=await action(client);
    await client.query('commit');
    return value;
  }catch(error){await client.query('rollback');throw error;}finally{client.release();}
}

async function fixture(scope){
  await context(scope,async client=>{
    await client.query(`insert into mc.users(id,display_name) values($1,'Costs test owner')`,[scope.user]);
    await client.query(`insert into mc.businesses(id,name) values($1,'Costs test')`,[scope.business]);
    await client.query(`insert into mc.memberships(business_id,user_id,role) values($1,$2,'owner')`,[scope.business,scope.user]);
    await client.query(`insert into mc.stores(id,business_id,external_account_id,name,status) values($1,$2,$3,'Costs test store','active')`,[scope.store,scope.business,scope.store]);
    const catalog=(await client.query(`insert into mc.source_documents(business_id,store_id,origin,document_type,checksum,completeness) values($1,$2,'wb_api','catalog',$3,'complete') returning id`,[scope.business,scope.store,randomUUID()])).rows[0];
    const product=(await client.query(`insert into mc.products(business_id,store_id,wb_article,seller_article) values($1,$2,700001,'COSTS') returning id`,[scope.business,scope.store])).rows[0];
    await client.query(`insert into mc.variants(business_id,store_id,product_id,external_variant_id) values($1,$2,$3,'default')`,[scope.business,scope.store,product.id]);
    await client.query(`select mc.confirm_product_selection($1,$2,$3::uuid[])`,[scope.store,catalog.id,[product.id]]);
  });
}

const row=(unitCost,overrides={})=>({rowNumber:1,wbArticle:'700001',externalVariantId:'default',unitCost,effectiveFrom:'2020-01-01',...overrides});
const upload=(rows,storeId=ids.store)=>({storeId,fileName:'synthetic-costs.csv',checksum:createHash('sha256').update(JSON.stringify(rows)).digest('hex'),rows});
async function versions(scope=ids){
  return context(scope,async client=>(await client.query(`select version_no,unit_cost::text from mc.cost_versions where business_id=$1 and store_id=$2 order by version_no`,[scope.business,scope.store])).rows);
}

test('costs persistence preserves decimals, versions, atomicity and tenant permissions',async t=>{
  await migrate();
  await fixture(ids);
  await fixture(foreign);
  await context(ids,async client=>{
    await client.query(`insert into mc.users(id,display_name) values($1,'Costs test viewer')`,[ids.viewer]);
    await client.query(`insert into mc.memberships(business_id,user_id,role) values($1,$2,'viewer')`,[ids.business,ids.viewer]);
  });

  await t.test('stores an exact decimal and exposes the selected variant',async()=>{
    const result=await importVariantCosts(ids.user,upload([row('123456789012.3456')]));
    assert.equal(result.ok,true);
    assert.equal(result.applied,1);
    const state=await getCostState(ids.user,ids.store);
    assert.deepEqual(state.summary,{totalVariants:1,configuredVariants:1});
    assert.equal(state.rows[0].unit_cost,'123456789012.3456');
    assert.equal(state.products[0].variants[0].cost_version_id,state.rows[0].cost_version_id);
    assert.equal(state.lastImport.status,'completed');
    assert.equal(state.lastImport.applied_rows,1);
  });

  await t.test('identical import keeps the current version',async()=>{
    const before=await versions();
    const versionId=(await getCostState(ids.user,ids.store)).rows[0].cost_version_id;
    const result=await importVariantCosts(ids.user,upload([row('123456789012.3456')]));
    assert.equal(result.ok,true);
    assert.equal(result.applied,0);
    assert.equal(result.skipped,1);
    assert.deepEqual(await versions(),before);
    assert.equal((await getCostState(ids.user,ids.store)).rows[0].cost_version_id,versionId);
  });

  await t.test('changed amount creates the next version',async()=>{
    const result=await importVariantCosts(ids.user,upload([row('42.0101')]));
    assert.equal(result.ok,true);
    assert.equal(result.applied,1);
    assert.deepEqual(await versions(),[{version_no:1,unit_cost:'123456789012.3456'},{version_no:2,unit_cost:'42.0101'}]);
    assert.equal((await getCostState(ids.user,ids.store)).rows[0].unit_cost,'42.0101');
  });

  await t.test('an invalid row prevents applying a valid change',async()=>{
    const before=await versions();
    const result=await importVariantCosts(ids.user,upload([row('99.9999'),row('-1',{rowNumber:2,externalVariantId:'missing'})]));
    assert.equal(result.ok,false);
    assert.equal(result.applied,0);
    assert.ok(result.errors.some(error=>error.rowNumber===2&&error.code==='cost_invalid_amount'));
    assert.deepEqual(await versions(),before);
    const state=await getCostState(ids.user,ids.store);
    assert.equal(state.rows[0].unit_cost,'42.0101');
    assert.equal(state.lastImport.status,'failed');
    assert.equal(state.lastImport.applied_rows,0);
    assert.equal(state.lastImport.invalid_rows,1);
  });

  await t.test('viewer cannot write costs',async()=>{
    const before=await versions();
    await assert.rejects(importVariantCosts(ids.viewer,upload([row('10')])),{message:'cost_write_forbidden'});
    assert.deepEqual(await versions(),before);
  });

  await t.test('another business cannot read or write store costs',async()=>{
    await importVariantCosts(foreign.user,upload([row('77.7777')],foreign.store));
    const before=await versions(foreign);
    const state=await getCostState(ids.user,foreign.store);
    assert.deepEqual(state.products,[]);
    assert.deepEqual(state.rows,[]);
    assert.deepEqual(state.summary,{totalVariants:0,configuredVariants:0});
    assert.equal(state.lastImport,null);
    await assert.rejects(importVariantCosts(ids.user,upload([row('10')],foreign.store)),{message:'store_not_found'});
    assert.deepEqual(await versions(foreign),before);
  });
});
