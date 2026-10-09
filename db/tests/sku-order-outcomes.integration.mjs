import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import {createHash} from 'node:crypto';
import {loadSkuOrderHistories} from '../../app/modules/calculation/sku-order-history.repository.mjs';
import {calculateBuyout} from '../../app/modules/calculation/sku-buyout.mjs';

const url=process.env.SKU_OUTCOMES_INTEGRATION_DATABASE_URL;
if(!url||!/(?:^|_)test(?:_|$)/i.test(new URL(url).pathname.slice(1)))throw new Error('Disposable test database required');
const admin=new pg.Pool({connectionString:url,max:1});
const role=`mc_outcomes_${randomUUID().replaceAll('-','')}`;
const runtimeUrl=new URL(url);runtimeUrl.searchParams.set('options',`-c role=${role}`);
process.env.DATABASE_URL=runtimeUrl.href;
const {createOrderOutcomeRepository}=await import('../../app/modules/operational/order-outcomes.repository.mjs');
const {storeOperationalSnapshot}=await import('../../app/infrastructure/storage/operational-source-storage.mjs');
const {pool:storagePool}=await import('../../app/infrastructure/database/client.mjs');
const runtime=new pg.Pool({connectionString:runtimeUrl.href,max:2});
const storage={root:await mkdtemp(path.join(os.tmpdir(),'mc-outcomes-test-')),masterKey:Buffer.alloc(32,15)};
const ids=Object.fromEntries(['user','viewer','foreign','business','otherBusiness','store','product','batch'].map(key=>[key,randomUUID()]));
async function context(user,business,action){
  const client=await runtime.connect();
  try{await client.query('begin');await client.query("select set_config('app.user_id',$1,true),set_config('app.business_id',$2,true)",[user,business]);
    const value=await action(client);await client.query('commit');return value;
  }catch(error){await client.query('rollback');throw error;}finally{client.release();}
}
try{
  assert.equal((await admin.query('select rolsuper from pg_roles where rolname=current_user')).rows[0].rolsuper,true);
  assert.equal((await admin.query("select count(*)::int n from pg_namespace where nspname='mc'")).rows[0].n,0,'test DB must be empty');
  await admin.query(`create role ${role} nologin nosuperuser nobypassrls`);
  const database=(await admin.query('select current_database() name')).rows[0].name;
  await admin.query(`grant create on database "${database.replaceAll('"','""')}" to ${role}`);
  for(const name of (await readdir('db/migrations')).filter(name=>/^\d+_.*\.sql$/.test(name)).sort())await runtime.query(await readFile(`db/migrations/${name}`,'utf8'));
  await admin.query("insert into mc.users(id,display_name) values($1,'owner'),($2,'viewer'),($3,'foreign')",[ids.user,ids.viewer,ids.foreign]);
  await context(ids.user,ids.business,async client=>{
    await client.query("insert into mc.businesses(id,name) values($1,'outcomes test')",[ids.business]);
    await client.query("insert into mc.memberships(business_id,user_id,role) values($1,$2,'owner'),($1,$3,'viewer')",[ids.business,ids.user,ids.viewer]);
    await client.query("insert into mc.stores(id,business_id,external_account_id,name,status) values($1,$2,'outcomes-test','test','active')",[ids.store,ids.business]);
    const connection=(await client.query(`insert into mc.connections(business_id,store_id,secret_ref,scopes,status) values($1,$2,'database:test','["statistics"]'::jsonb,'active') returning id`,[ids.business,ids.store])).rows[0].id;
    await client.query("insert into mc.connection_secrets(business_id,connection_id,ciphertext,nonce,auth_tag) values($1,$2,decode('abcd','hex'),decode(repeat('01',12),'hex'),decode(repeat('02',16),'hex'))",[ids.business,connection]);
    await client.query("insert into mc.products(id,business_id,store_id,wb_article,seller_article) values($1,$2,$3,12345,'SKU')",[ids.product,ids.business,ids.store]);
    const document=(await client.query("insert into mc.source_documents(business_id,store_id,origin,document_type,checksum,completeness) values($1,$2,'wb_api','catalog','outcomes-catalog','complete') returning id",[ids.business,ids.store])).rows[0].id;
    await client.query("insert into mc.sync_streams(business_id,store_id,source_type,next_run_at,status) values($1,$2,'operational_sales_funnel',now(),'active')",[ids.business,ids.store]);
    await client.query('select mc.confirm_product_selection($1,$2,$3::uuid[])',[ids.store,document,[ids.product]]);
    await client.query("insert into mc.operational_sync_targets(store_id,business_id,requested_by,next_run_at,status) values($1,$2,$3,now()+interval '1 year','blocked') on conflict(store_id) do update set next_run_at=excluded.next_run_at,status='blocked'",[ids.store,ids.business,ids.user]);
    await client.query("insert into mc.sku_order_batches(id,business_id,store_id,observed_at,credential_generation,source_from) values($1,$2,$3,'2026-09-01',1,'2026-08-01')",[ids.batch,ids.business,ids.store]);
    await client.query("insert into mc.sku_order_coverage(business_id,store_id,product_id,coverage_start,coverage_end,batch_id) values($1,$2,$3,'2026-08-01','2026-08-31',$4)",[ids.business,ids.store,ids.product,ids.batch]);
    await client.query(`insert into mc.sku_order_identities(business_id,store_id,product_id,srid,ordered_at,batch_id)
      select $1,$2,$3,'order-'||n,'2026-08-01T00:00:00Z'::timestamptz+n*interval '1 minute',$4 from generate_series(1,101) n`,[ids.business,ids.store,ids.product,ids.batch]);
    await client.query(`insert into mc.sku_order_events(business_id,store_id,product_id,srid,source_key,changed_at,outcome,outcome_at,batch_id)
      select $1,$2,$3,'order-'||n,'sale-'||n,'2026-08-03','retained','2026-08-02',$4 from generate_series(1,101) n`,[ids.business,ids.store,ids.product,ids.batch]);
    await client.query(`insert into mc.sku_order_events(business_id,store_id,product_id,srid,source_key,changed_at,outcome,outcome_at,batch_id)
      values($1,$2,$3,'order-101','return-101','2026-08-05','returned','2026-08-04',$4),
      ($1,$2,$3,'order-100','future-return','2026-09-05','returned','2026-09-04',$4)`,[ids.business,ids.store,ids.product,ids.batch]);
  });
  assert.equal((await runtime.query('select * from mc.list_sku_order_sync_candidates(2)')).rows.length,1,'journal independent of financial/funnel gate');
  const read=()=>context(ids.viewer,ids.business,client=>loadSkuOrderHistories(client,{businessId:ids.business,storeId:ids.store,periodEnd:'2026-08-31',productIds:[ids.product]}));
  const history=(await read())[ids.product];
  const result=calculateBuyout({sku:ids.product,periodEnd:'2026-08-31',history});
  assert.equal(result.percent,99);assert.equal(result.sampleSize,100);assert.equal(history.records.length,101,'100 identities plus return');
  assert.equal(result.quality,'partial');assert.equal(result.counts.returned,1,'future return cannot rewrite August');
  assert.equal(history.records.some(row=>row.srid==='order-1'),false,'latest orders win');
  const repository=createOrderOutcomeRepository({pool:runtime});
  await context(ids.user,ids.business,client=>client.query("update mc.sku_order_coverage set coverage_start='2025-09-01' where store_id=$1",[ids.store]));
  const target={user_id:ids.user,business_id:ids.business,store_id:ids.store};
  const lease=await repository.acquire(target);
  try{
    assert.equal(await repository.acquire(target),null,'cross-worker lease prevents parallel API calls');
    const job=await repository.begin(lease,target,new Date());assert.equal(job.products[0].nmId,12345);
    const slot=await repository.reserve(lease,job,'https://statistics-api.wildberries.ru/api/v1/supplier/sales');assert.equal(slot.waitMs,0);
    const repeatSlot=await repository.reserve(lease,job,'https://statistics-api.wildberries.ru/api/v1/supplier/sales');assert.ok(repeatSlot.waitMs>60000);
    async function batch(orderedAt){
      const batchId=randomUUID(),raw='[]',checksum=createHash('sha256').update(raw).digest('hex');
      const object=await storeOperationalSnapshot({businessId:ids.business,storeId:ids.store,snapshotId:batchId,partNumber:0,raw,checksum,...storage});
      return {batchId,storage,sourceFrom:'2026-08-01',coverageEnd:'2026-08-31',objects:[{...object,endpoint:'orders'}],result:{complete:true,observedThrough:'2026-09-01T00:00:00Z',cursors:{orders:'2026-09-01',sales:'2026-09-01'},
        pages:[{endpoint:'https://statistics-api.wildberries.ru/api/v1/supplier/orders',raw,checksum}],
        orders:[{srid:'repo-order',nmId:12345,orderedAt}],events:[{sourceKey:'repo-sale',changedAt:'2026-08-03T00:00:00Z',srid:'repo-order',nmId:12345,outcome:'retained',outcomeAt:'2026-08-02T00:00:00Z'}]}};
    }
    const first=await batch('2026-08-01T00:00:00Z');await repository.complete(lease,job,first);
    assert.equal(await repository.hasBatch(target,first.batchId),true,'fresh connection confirms committed batch');
    assert.equal(await repository.hasBatch(target,randomUUID()),false,'fresh connection confirms absent batch');
    const coverage=await context(ids.user,ids.business,async client=>(await client.query('select coverage_start::text from mc.sku_order_coverage where store_id=$1',[ids.store])).rows[0]);
    assert.equal(coverage.coverage_start,'2025-09-01','scope/token reset preserves accumulated continuous history');
    assert.equal(await repository.begin(lease,target,new Date()),null,'hourly durable state prevents replay');
    await repository.complete(lease,job,await batch('2026-08-01T00:00:00Z'));
    const count=()=>context(ids.user,ids.business,async client=>(await client.query('select count(*)::int n from mc.sku_order_identities where srid=$1',['repo-order'])).rows[0].n);
    assert.equal(await count(),1,'overlap does not duplicate order');
    await assert.rejects(async()=>repository.complete(lease,job,await batch('2026-07-31T00:00:00Z')),/duplicate_conflict/);
    await context(ids.user,ids.business,client=>client.query('update mc.connections set credential_generation=credential_generation+1 where store_id=$1',[ids.store]));
    await assert.rejects(async()=>repository.complete(lease,job,await batch('2026-08-01T00:00:00Z')),/superseded/);
  }finally{await lease.release();}
  const foreign=await context(ids.foreign,ids.otherBusiness,client=>loadSkuOrderHistories(client,{businessId:ids.business,storeId:ids.store,periodEnd:'2026-08-31',productIds:[ids.product]}));
  assert.deepEqual(foreign,{});
  await assert.rejects(()=>context(ids.viewer,ids.business,client=>client.query("insert into mc.sku_order_sync_state(business_id,store_id) values($1,$2)",[ids.business,ids.store])),/row-level security/);
  await assert.rejects(()=>context(ids.user,ids.business,client=>client.query("update mc.sku_order_identities set ordered_at=now() where store_id=$1",[ids.store])),/immutable|cannot|append/i);
  await context(ids.user,ids.business,async client=>{
    await client.query('delete from mc.memberships where business_id=$1 and user_id=$2',[ids.business,ids.viewer]);
    await client.query("insert into mc.auth_sessions(user_id,token_hash,expires_at) values($1,$2,now()+interval '1 hour')",[ids.user,'a'.repeat(64)]);
    await client.query('select mc.erase_account($1,$2,null)',[ids.user,'a'.repeat(64)]);
  });
  assert.equal((await admin.query('select count(*)::int n from mc.sku_order_events')).rows[0].n,0);
  console.log('SKU outcomes PostgreSQL: bounded sample, historical outcomes, independent dispatch, viewer read, tenant isolation, immutable history and account erasure passed');
}finally{
  await storagePool.end();await runtime.end();await admin.query(`drop owned by ${role} cascade`).catch(()=>{});await admin.query(`drop role if exists ${role}`).catch(()=>{});await admin.end();await rm(storage.root,{recursive:true,force:true});
}
