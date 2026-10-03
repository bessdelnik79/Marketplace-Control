import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {recoverHistoricalCatalog} from '../../app/modules/catalog/historical-catalog.repository.mjs';

const url=process.env.HISTORICAL_CATALOG_INTEGRATION_DATABASE_URL;
if(!url||!new URL(url).pathname.toLowerCase().includes('test'))throw new Error('Set HISTORICAL_CATALOG_INTEGRATION_DATABASE_URL to a disposable database containing test in its name.');
process.env.DATABASE_URL=url;
const {migrate,pool}=await import('../../app/db.mjs');
test.after(async()=>pool.end());
async function context(scope,action){
  const client=await pool.connect();
  try{
    await client.query('begin');
    await client.query("select set_config('app.user_id',$1,true),set_config('app.business_id',$2,true)",[scope.user,scope.businessId]);
    const result=await action(client);await client.query('commit');return result;
  }catch(error){await client.query('rollback');throw error;}finally{client.release();}
}
async function fixture({fullCatalog=true,articles=[{nmId:800001,saName:'DELETED',barcode:'80000101'}],selectedCount=1}={}){
  const scope={user:randomUUID(),businessId:randomUUID(),storeId:randomUUID()};
  await context(scope,async client=>{
    await client.query(`insert into mc.users(id,display_name) values($1,'Historical owner')`,[scope.user]);
    await client.query(`insert into mc.businesses(id,name) values($1,'Historical test')`,[scope.businessId]);
    await client.query(`insert into mc.memberships(business_id,user_id,role) values($1,$2,'owner')`,[scope.businessId,scope.user]);
    await client.query(`insert into mc.stores(id,business_id,external_account_id,name,status) values($1::uuid,$2,$1::text,'Historical store','active')`,[scope.storeId,scope.businessId]);
    const stream=(await client.query(`insert into mc.sync_streams(business_id,store_id,source_type) values($1,$2,'catalog') returning id`,[scope.businessId,scope.storeId])).rows[0];
    const run=(await client.query(`insert into mc.sync_runs(business_id,store_id,stream_id,status) values($1,$2,$3,$4) returning id`,[scope.businessId,scope.storeId,stream.id,fullCatalog?'succeeded':'failed'])).rows[0];
    const document=(await client.query(`insert into mc.source_documents(business_id,store_id,sync_run_id,origin,document_type,checksum,completeness) values($1,$2,$3,'wb_api','catalog',$4,'complete') returning id`,[scope.businessId,scope.storeId,run.id,randomUUID()])).rows[0];
    const ids=[];
    for(let n=0;n<selectedCount;n++)ids.push((await client.query(`insert into mc.products(business_id,store_id,wb_article,seller_article) values($1,$2,$3,'LIVE') returning id`,[scope.businessId,scope.storeId,700001+n])).rows[0].id);
    await client.query(`select mc.confirm_product_selection($1,$2,$3::uuid[])`,[scope.storeId,document.id,ids]);
    const reportDocument=(await client.query(`insert into mc.source_documents(business_id,store_id,origin,document_type,checksum,completeness) values($1,$2,'wb_api','weekly_realization',$3,'complete') returning id`,[scope.businessId,scope.storeId,randomUUID()])).rows[0];
    const report=(await client.query(`insert into mc.reports(business_id,store_id,external_report_id,period_start,period_end) values($1,$2,$3,'2026-04-06','2026-04-12') returning id`,[scope.businessId,scope.storeId,randomUUID()])).rows[0];
    const version=(await client.query(`insert into mc.report_versions(business_id,store_id,report_id,document_id,version_no,checksum,parser_version) values($1,$2,$3,$4,1,$5,'test') returning id`,[scope.businessId,scope.storeId,report.id,reportDocument.id,randomUUID()])).rows[0];
    scope.reportVersionId=version.id;
    for(let n=0;n<articles.length;n++)await client.query(`insert into mc.report_rows(business_id,store_id,report_version_id,external_row_key,row_number,raw_data,row_checksum) values($1,$2,$3,$4,$5,$6,$7)`,[scope.businessId,scope.storeId,version.id,String(n),n+1,JSON.stringify(articles[n]),randomUUID()]);
    await client.query(`update mc.report_versions set status='validated' where id=$1`,[version.id]);
    await client.query(`update mc.report_versions set status='accepted',accepted_at=now() where id=$1`,[version.id]);
    await client.query(`update mc.reports set current_version_id=$2 where id=$1`,[report.id,version.id]);
  });
  return scope;
}
const recover=scope=>context(scope,client=>recoverHistoricalCatalog(client,scope));

test('historical report catalog recovers only auditable affordable deleted products',async t=>{
  await migrate();
  await t.test('adds selected product and cost-capable barcode variant once without fake WB metadata',async()=>{
    const scope=await fixture();const result=await recover(scope);
    assert.equal(result.changed,true);assert.equal(result.catalogRevision,1);assert.equal(result.addedProductIds.length,1);
    await context(scope,async client=>{
      const row=(await client.query(`select p.seller_article,p.historical_deleted,p.image_url,p.historical_source_row_id,v.external_variant_id,v.historical_report_only from mc.products p join mc.variants v on v.product_id=p.id join mc.product_selection_items i on i.product_id=p.id where p.id=$1`,[result.addedProductIds[0]])).rows[0];
      assert.equal(row.seller_article,'DELETED');assert.equal(row.historical_deleted,true);assert.equal(row.image_url,null);assert.ok(row.historical_source_row_id);
      assert.equal(row.external_variant_id,'historical:80000101');assert.equal(row.historical_report_only,true);
    });
    const again=await recover(scope);assert.equal(again.changed,false);assert.equal(again.catalogRevision,1);assert.deepEqual(again.addedProductIds,[]);
  });
  await t.test('two concurrent recovery transactions cannot consume the last slot twice',async()=>{
    const scope=await fixture({selectedCount:2,articles:[{nmId:800002,barcode:'B'},{nmId:800001,barcode:'A'}]});
    const results=await Promise.all([recover(scope),recover(scope)]);
    assert.equal(results.reduce((n,row)=>n+row.addedProductIds.length,0),1);
    const count=await context(scope,async client=>(await client.query(`select count(*)::int as n from mc.product_selection_items where business_id=$1`,[scope.businessId])).rows[0].n);
    assert.equal(count,3);assert.equal(results[0].catalogRevision,1);assert.equal(results[1].catalogRevision,1);
  });
  await t.test('failed catalog and expired subscription do not add products',async()=>{
    const failed=await fixture({fullCatalog:false});assert.equal((await recover(failed)).reason,'catalog_not_ready');
    const inactive=await fixture();await context(inactive,client=>client.query(`update mc.subscriptions set period_start=now()-interval '2 days',period_end=now()-interval '1 day' where business_id=$1`,[inactive.businessId]));
    assert.equal((await recover(inactive)).reason,'subscription_inactive');
  });
  await t.test('ambiguous barcodes never link two historical articles',async()=>{
    const scope=await fixture({articles:[{nmId:800001,barcode:'SHARED'},{nmId:800002,barcode:'SHARED'}]});
    const result=await recover(scope);assert.equal(result.addedProductIds.length,2);
    const count=await context(scope,async client=>(await client.query(`select count(*)::int as n from mc.variant_identifiers where store_id=$1`,[scope.storeId])).rows[0].n);
    assert.equal(count,0);
  });
  await t.test('WB zero-article service rows do not block a real historical barcode',async()=>{
    const scope=await fixture({articles:[{nmId:800001,sku:'REAL'},{nmId:0,sku:'REAL'},{nmId:'',sku:'REAL'}]});
    const result=await recover(scope);assert.equal(result.addedProductIds.length,1);
    const identifiers=await context(scope,async client=>(await client.query(`select p.wb_article::text,i.identifier_value from mc.variant_identifiers i join mc.variants v on v.id=i.variant_id join mc.products p on p.id=v.product_id where i.store_id=$1`,[scope.storeId])).rows);
    assert.deepEqual(identifiers,[{wb_article:'800001',identifier_value:'REAL'}]);
  });
  await t.test('a barcode already owned by a live card is never reassigned',async()=>{
    const scope=await fixture({articles:[{nmId:800001,sku:'70000101'}]});
    const original=await context(scope,async client=>{
      const product=(await client.query(`select id from mc.products where store_id=$1 and wb_article=700001`,[scope.storeId])).rows[0];
      const variant=(await client.query(`insert into mc.variants(business_id,store_id,product_id,external_variant_id) values($1,$2,$3,'WB-size') returning id`,[scope.businessId,scope.storeId,product.id])).rows[0];
      await client.query(`insert into mc.variant_identifiers(business_id,store_id,variant_id,identifier_type,identifier_value) values($1,$2,$3,'barcode','70000101')`,[scope.businessId,scope.storeId,variant.id]);
      return variant.id;
    });
    await recover(scope);
    const identifiers=await context(scope,async client=>(await client.query(`select variant_id from mc.variant_identifiers where store_id=$1`,[scope.storeId])).rows);
    assert.deepEqual(identifiers,[{variant_id:original}]);
  });
  await t.test('an archived selected card recovers without consuming another slot or replacing variants',async()=>{
    const scope=await fixture({selectedCount:3,articles:[{nmId:700001,sku:'70000101'}]});
    const original=await context(scope,async client=>{
      const product=(await client.query(`select id from mc.products where store_id=$1 and wb_article=700001`,[scope.storeId])).rows[0];
      const variant=(await client.query(`insert into mc.variants(business_id,store_id,product_id,external_variant_id,status) values($1,$2,$3,'WB-size','archived') returning id`,[scope.businessId,scope.storeId,product.id])).rows[0];
      await client.query(`insert into mc.variant_identifiers(business_id,store_id,variant_id,identifier_type,identifier_value) values($1,$2,$3,'barcode','70000101')`,[scope.businessId,scope.storeId,variant.id]);
      await client.query(`update mc.products set status='archived' where id=$1`,[product.id]);
      return variant.id;
    });
    const result=await recover(scope);assert.equal(result.changed,true);assert.deepEqual(result.addedProductIds,[]);assert.equal(result.catalogRevision,1);
    const variants=await context(scope,async client=>(await client.query(`select id,status,external_variant_id,historical_report_only from mc.variants where store_id=$1`,[scope.storeId])).rows);
    assert.deepEqual(variants,[{id:original,status:'active',external_variant_id:'WB-size',historical_report_only:false}]);
    assert.equal((await recover(scope)).changed,false);
  });
  await t.test('normalizations append another catalog revision without rewriting old interpretation',async()=>{
    const scope=await fixture();
    await context(scope,async client=>{
      const method=(await client.query(`select id from mc.method_versions where code='wb_finance_import' order by version_no desc limit 1`)).rows[0];
      for(const revision of [0,1])await client.query(`insert into mc.report_normalizations(business_id,store_id,report_version_id,method_version_id,normalization_key,status,catalog_revision) values($1,$2,$3,$4,$5,'succeeded',$6)`,[scope.businessId,scope.storeId,scope.reportVersionId,method.id,`test:${scope.reportVersionId}:${revision}`,revision]);
      const rows=(await client.query(`select catalog_revision::int as revision from mc.report_normalizations where store_id=$1 order by catalog_revision`,[scope.storeId])).rows;
      assert.deepEqual(rows,[{revision:0},{revision:1}]);
      await assert.rejects(client.query(`update mc.report_normalizations set catalog_revision=2 where store_id=$1`,[scope.storeId]),/immutable/);
    });
  });
  await t.test('viewer and foreign tenant context are rejected',async()=>{
    const scope=await fixture();const viewer=randomUUID();await context(scope,async client=>{
      await client.query(`insert into mc.users(id,display_name) values($1,'Viewer')`,[viewer]);
      await client.query(`insert into mc.memberships(business_id,user_id,role) values($1,$2,'viewer')`,[scope.businessId,viewer]);
    });
    await assert.rejects(recover({...scope,user:viewer}),/authenticated business editor/);
    await assert.rejects(context(scope,client=>recoverHistoricalCatalog(client,{businessId:randomUUID(),storeId:scope.storeId})),/catalog_context_mismatch/);
  });
});
