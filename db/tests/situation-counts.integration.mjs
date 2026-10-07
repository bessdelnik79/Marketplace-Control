import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const integrationUrl=process.env.P04_INTEGRATION_DATABASE_URL;
if(!integrationUrl)throw new Error('Set P04_INTEGRATION_DATABASE_URL to a disposable PostgreSQL database whose name contains "test".');
if(!new URL(integrationUrl).pathname.slice(1).toLowerCase().includes('test'))throw new Error('Refusing to run situation count integration tests outside a database whose name contains "test".');
process.env.DATABASE_URL=integrationUrl;

const {migrate,pool}=await import('../../app/infrastructure/database/client.mjs');
const {beginOperationalSync,completeOperationalSync,closeOperationalSyncLeases}=await import('../../app/modules/operational/operational.repository.mjs');
const {readSituationOperationalCounts}=await import('../../app/modules/operational/situation-counts.mjs');
const {storeOperationalSnapshot}=await import('../../app/infrastructure/storage/operational-source-storage.mjs');
const ids={user:randomUUID(),foreignUser:randomUUID(),business:randomUUID(),foreignBusiness:randomUUID(),
  store:randomUUID(),product:randomUUID(),otherProduct:randomUUID(),unselectedProduct:randomUUID()};
const rawRoot=await mkdtemp(path.join(os.tmpdir(),'mc-situation-counts-'));
const masterKey=Buffer.alloc(32,19),storage={root:rawRoot,masterKey};
const period={periodStart:'2026-09-14',periodEnd:'2026-09-15'};
const input={storeId:ids.store,productId:ids.product,...period};

await migrate();
async function context(userId,businessId,action){
  const client=await pool.connect();
  try{
    await client.query('begin');
    await client.query("select set_config('app.user_id',$1,true),set_config('app.business_id',$2,true)",[userId,businessId]);
    const result=await action(client);await client.query('commit');return result;
  }catch(error){await client.query('rollback');throw error;}finally{client.release();}
}
await context(ids.user,ids.business,async client=>{
  await client.query(`insert into mc.users(id,display_name) values($1,'Situation count owner'),($2,'Foreign count owner')`,[ids.user,ids.foreignUser]);
  await client.query(`insert into mc.businesses(id,name) values($1,'Situation counts test'),($2,'Foreign counts test')`,[ids.business,ids.foreignBusiness]);
  await client.query(`insert into mc.memberships(business_id,user_id,role) values($1,$2,'owner'),($3,$4,'owner')`,[ids.business,ids.user,ids.foreignBusiness,ids.foreignUser]);
  await client.query(`insert into mc.stores(id,business_id,external_account_id,name,status) values($1,$2,$3,'Situation counts','active')`,[ids.store,ids.business,`count-${ids.store}`]);
  await client.query(`select mc.apply_tariff_period($1,'plus',$2,clock_timestamp())`,[ids.business,`situation-counts:${randomUUID()}`]);
  const connection=(await client.query(`insert into mc.connections(business_id,store_id,secret_ref,scopes,status) values($1,$2,'database:counts','["analytics","statistics"]'::jsonb,'active') returning id`,[ids.business,ids.store])).rows[0];
  await client.query(`insert into mc.connection_secrets(business_id,connection_id,ciphertext,nonce,auth_tag) values($1,$2,decode('abcd','hex'),decode(repeat('01',12),'hex'),decode(repeat('02',16),'hex'))`,[ids.business,connection.id]);
  const catalog=(await client.query(`insert into mc.source_documents(business_id,store_id,origin,document_type,checksum,completeness) values($1,$2,'wb_api','catalog',$3,'complete') returning id`,[ids.business,ids.store,`counts-catalog-${ids.store}`])).rows[0];
  for(const [product,article] of [[ids.product,7500001],[ids.otherProduct,7500002],[ids.unselectedProduct,7500003]]){
    await client.query(`insert into mc.products(id,business_id,store_id,wb_article,seller_article) values($1,$2,$3,$4,$5)`,[product,ids.business,ids.store,article,`COUNT-${article}`]);
  }
  await client.query(`select mc.confirm_product_selection($1,$2,$3::uuid[])`,[ids.store,catalog.id,[ids.product,ids.otherProduct]]);
  await client.query(`insert into mc.sync_streams(business_id,store_id,source_type,next_run_at,status) values($1,$2,'operational_sales_funnel',now(),'active')`,[ids.business,ids.store]);
});

async function publish(start,end,metrics,fetchedAt){
  const job=await beginOperationalSync(ids.user,ids.store,{force:true,dateFrom:start,dateTo:end});
  assert.equal(job.started,true);
  const snapshotId=randomUUID();
  const object=await storeOperationalSnapshot({businessId:ids.business,storeId:ids.store,snapshotId,
    raw:JSON.stringify({metrics}),root:rawRoot,masterKey});
  await completeOperationalSync(ids.user,job,{documentId:randomUUID(),snapshotId,objects:[object],metrics,
    fetchedAt:new Date(fetchedAt),storage});
  return snapshotId;
}
function metric(date,nmId,orders,buyouts){
  return {date,nmId,currency:'RUB',orderCount:orders,orderSum:String(orders*10),
    buyoutCount:buyouts,buyoutSum:String(buyouts*10),returnCount:0,returnSum:'0'};
}

test('no saved operational metrics leaves both counts unknown',async()=>{
  const result=await readSituationOperationalCounts(ids.user,input);
  assert.equal(result.orders.count,null);assert.equal(result.buyouts.count,null);
  assert.equal(result.orders.availability,'unavailable');
});

test('accepted snapshot counts only the selected product and exact range, including complete zeros',async()=>{
  const snapshotId=await publish(period.periodStart,period.periodEnd,[
    metric(period.periodStart,7500001,11,7),metric(period.periodEnd,7500001,0,0),
    metric(period.periodStart,7500002,999,888),metric(period.periodEnd,7500002,999,888)
  ],'2026-09-16T01:00:00Z');
  const result=await readSituationOperationalCounts(ids.user,input);
  assert.deepEqual(result.orders,{count:'11',availability:'complete'});
  assert.deepEqual(result.buyouts,{count:'7',availability:'complete'});
  assert.deepEqual(result.snapshotIds,[snapshotId]);
  assert.equal(result.productId,ids.product);assert.equal(result.source.dateBasis,'order_date');
  const zero=await readSituationOperationalCounts(ids.user,{...input,periodStart:period.periodEnd});
  assert.deepEqual(zero.orders,{count:'0',availability:'complete'});
  assert.deepEqual(zero.buyouts,{count:'0',availability:'complete'});
  const missing=await readSituationOperationalCounts(ids.user,{...input,periodEnd:'2026-09-16'});
  assert.equal(missing.orders.count,null);assert.equal(missing.buyouts.count,null);
});

test('partial newer refresh retains complete saved days while uncovered days stay unknown',async()=>{
  await publish(period.periodStart,period.periodEnd,[
    metric(period.periodStart,7500001,12,8),metric(period.periodStart,7500002,999,888),
    metric(period.periodEnd,7500002,999,888)
  ],'2026-09-17T01:00:00Z');
  const saved=await readSituationOperationalCounts(ids.user,input);
  assert.deepEqual(saved.orders,{count:'12',availability:'complete'});
  assert.equal(saved.source.savedDataUsed,true);
  await publish('2026-09-16','2026-09-17',[
    metric('2026-09-16',7500001,5,4),metric('2026-09-16',7500002,999,888),
    metric('2026-09-17',7500002,999,888)
  ],'2026-09-18T01:00:00Z');
  const partial=await readSituationOperationalCounts(ids.user,{...input,periodStart:'2026-09-16',periodEnd:'2026-09-17'});
  assert.deepEqual(partial.orders,{count:null,availability:'unavailable'});
  assert.deepEqual(partial.buyouts,{count:null,availability:'unavailable'});
  assert.ok(partial.missingReasons.includes('operational_metric_unavailable'));
});

test('foreign tenant, unselected product and archived store expose no totals or snapshots',async()=>{
  for(const [user,request] of [[ids.foreignUser,input],[ids.user,{...input,productId:ids.unselectedProduct}],
    [ids.user,{...input,productId:randomUUID()}]]){
    const result=await readSituationOperationalCounts(user,request);
    assert.equal(result.orders.count,null);assert.equal(result.buyouts.count,null);
    assert.deepEqual(result.snapshotIds,[]);
  }
  await context(ids.user,ids.business,client=>client.query(`update mc.stores set status='archived' where id=$1`,[ids.store]));
  const archived=await readSituationOperationalCounts(ids.user,input);
  assert.equal(archived.orders.count,null);assert.deepEqual(archived.snapshotIds,[]);
});

test.after(async()=>{await closeOperationalSyncLeases();await pool.end();await rm(rawRoot,{recursive:true,force:true});});
