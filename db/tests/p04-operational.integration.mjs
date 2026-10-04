import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const integrationUrl=process.env.P04_INTEGRATION_DATABASE_URL;
if(!integrationUrl)throw new Error('Set P04_INTEGRATION_DATABASE_URL to a disposable PostgreSQL database whose name contains "test".');
if(!new URL(integrationUrl).pathname.slice(1).toLowerCase().includes('test'))throw new Error('Refusing to run P0.4 integration tests outside a database whose name contains "test".');
process.env.DATABASE_URL=integrationUrl;

const {migrate,pool,beginOperationalSync,completeOperationalSync,failOperationalSync,getOperationalOverviewData,getOperationalSyncState,reserveOperationalRequestSlot}=await import('../../app/db.mjs');
const {storeOperationalSnapshot}=await import('../../app/infrastructure/storage/operational-source-storage.mjs');
const ids={user:randomUUID(),foreignUser:randomUUID(),business:randomUUID(),foreignBusiness:randomUUID(),store:randomUUID(),product:randomUUID()};
const rawRoot=await mkdtemp(path.join(os.tmpdir(),'mc-p04-integration-'));
const masterKey=Buffer.alloc(32,11);
const storage={root:rawRoot,masterKey};

await migrate();
async function context(userId,businessId,action){
  const client=await pool.connect();
  try{
    await client.query('begin');
    await client.query("select set_config('app.user_id',$1,true),set_config('app.business_id',$2,true)",[userId,businessId]);
    const result=await action(client);
    await client.query('commit');
    return result;
  }catch(error){await client.query('rollback');throw error;}finally{client.release();}
}

await context(ids.user,ids.business,async client=>{
  await client.query(`insert into mc.users(id,display_name) values($1,'P04 owner'),($2,'Foreign owner')`,[ids.user,ids.foreignUser]);
  await client.query(`insert into mc.businesses(id,name) values($1,'P04 test'),($2,'Foreign test')`,[ids.business,ids.foreignBusiness]);
  await client.query(`insert into mc.memberships(business_id,user_id,role) values($1,$2,'owner'),($3,$4,'owner')`,[ids.business,ids.user,ids.foreignBusiness,ids.foreignUser]);
  await client.query(`insert into mc.stores(id,business_id,external_account_id,name,status) values($1,$2,'p04-seller','P04 store','active')`,[ids.store,ids.business]);
  const connection=(await client.query(`insert into mc.connections(business_id,store_id,secret_ref,scopes,status) values($1,$2,'database:p04','["analytics"]'::jsonb,'active') returning id`,[ids.business,ids.store])).rows[0];
  await client.query(`insert into mc.connection_secrets(business_id,connection_id,ciphertext,nonce,auth_tag) values($1,$2,decode('abcd','hex'),decode(repeat('01',12),'hex'),decode(repeat('02',16),'hex'))`,[ids.business,connection.id]);
  const catalog=(await client.query(`insert into mc.source_documents(business_id,store_id,origin,document_type,checksum,completeness) values($1,$2,'wb_api','catalog','p04-catalog','complete') returning id`,[ids.business,ids.store])).rows[0];
  await client.query(`insert into mc.products(id,business_id,store_id,wb_article,seller_article) values($1,$2,$3,7400001,'P04')`,[ids.product,ids.business,ids.store]);
  await client.query(`select mc.confirm_product_selection($1,$2,$3::uuid[])`,[ids.store,catalog.id,[ids.product]]);
  await client.query(`insert into mc.sync_streams(business_id,store_id,source_type,next_run_at,status) values($1,$2,'operational_sales_funnel',now(),'active')`,[ids.business,ids.store]);
});

const week={dateFrom:'2026-09-14',dateTo:'2026-09-20'};
function metrics(skipDate){
  const rows=[];
  for(let day=14;day<=20;day++)if(day!==skipDate)rows.push({nmId:7400001,date:`2026-09-${day}`,currency:'RUB',orderCount:day,orderSum:`${day}00.25`,buyoutCount:day-1,buyoutSum:`${day-1}00.10`});
  return rows;
}
async function storedObject(raw,snapshotId){
  return storeOperationalSnapshot({businessId:ids.business,storeId:ids.store,snapshotId,raw,root:rawRoot,masterKey});
}

test('global dispatcher sees only eligible targets without tenant context',async()=>{
  const due=()=>pool.query(`select business_id,store_id from mc.list_operational_sync_candidates(10) where store_id=$1`,[ids.store]).then(result=>result.rows);
  assert.deepEqual(await due(),[{business_id:ids.business,store_id:ids.store}]);
  await context(ids.user,ids.business,client=>client.query(`update mc.connections set status='invalid' where store_id=$1`,[ids.store]));
  await context(ids.user,ids.business,client=>client.query(`update mc.sync_streams set next_run_at=clock_timestamp() where store_id=$1 and source_type='operational_sales_funnel'`,[ids.store]));
  assert.deepEqual(await due(),[]);
  await context(ids.user,ids.business,client=>client.query(`update mc.connections set status='active' where store_id=$1`,[ids.store]));
  assert.deepEqual(await due(),[{business_id:ids.business,store_id:ids.store}]);
});

test('operational repository atomically publishes immutable complete and partial versions',async()=>{
  const first=await beginOperationalSync(ids.user,ids.store,{force:true,...week});
  assert.equal(first.started,true);
  assert.deepEqual(first.products.map(item=>item.nmId),[7400001]);
  await assert.rejects(()=>completeOperationalSync(ids.user,first,{documentId:randomUUID(),snapshotId:randomUUID(),objects:[{storageKey:'plain.json',partNumber:0,byteSize:2,checksum:'a'.repeat(64),contentType:'text/plain'}],metrics:metrics()}),{message:'operational_invalid_object'});
  const absentSnapshotId=randomUUID();
  await assert.rejects(()=>completeOperationalSync(ids.user,first,{documentId:randomUUID(),snapshotId:absentSnapshotId,objects:[{storageKey:`${ids.business}/${ids.store}/operational-snapshots/${absentSnapshotId}/part-0000.json.gz.enc`,partNumber:0,byteSize:64,checksum:'a'.repeat(64),contentType:'application/json+gzip+aes-256-gcm'}],metrics:metrics(),storage}),{message:'operational_storage_unavailable'});
  const completeSnapshotId=randomUUID();
  const complete=await completeOperationalSync(ids.user,first,{documentId:randomUUID(),snapshotId:completeSnapshotId,objects:[await storedObject('{"batch":"complete"}',completeSnapshotId)],metrics:metrics(),fetchedAt:new Date('2026-09-21T01:00:00Z'),storage});
  assert.equal(complete.quality,'complete');
  assert.equal(complete.rowCount,7);
  const state=await getOperationalSyncState(ids.user,ids.store);
  assert.equal(state.run_status,'succeeded');
  assert.equal(state.quality,'complete');
  assert.equal(state.metric_count,7);

  const correctionJob=await beginOperationalSync(ids.user,ids.store,{force:true,...week});
  const partialSnapshotId=randomUUID();
  const partial=await completeOperationalSync(ids.user,correctionJob,{documentId:randomUUID(),snapshotId:partialSnapshotId,objects:[await storedObject('{"batch":"partial"}',partialSnapshotId)],metrics:metrics(18),fetchedAt:new Date('2026-09-22T01:00:00Z'),storage});
  assert.equal(partial.quality,'partial');
  assert.deepEqual(partial.missingReasons,['metric_date_missing']);
  const history=await context(ids.user,ids.business,async client=>(await client.query(
    `select s.version_no,s.quality,count(m.id)::int as rows,(p.current_snapshot_id=s.id) as current
       from mc.operational_snapshots s join mc.operational_periods p on p.id=s.operational_period_id
       left join mc.operational_daily_metrics m on m.snapshot_id=s.id
      where p.store_id=$1 group by s.id,p.current_snapshot_id order by s.version_no`,[ids.store]
  )).rows);
  assert.deepEqual(history.map(row=>[row.version_no,row.quality,row.rows,row.current]),[[1,'complete',7,false],[2,'partial',6,true]]);

  const rollingRange={dateFrom:'2026-09-15',dateTo:'2026-09-21'};
  const rollingMetrics=Array.from({length:7},(_,index)=>{
    const day=15+index;
    return {nmId:7400001,date:`2026-09-${day}`,currency:'RUB',orderCount:day,orderSum:`${day}00.25`,buyoutCount:day-1,buyoutSum:`${day-1}00.10`};
  });
  const rollingJob=await beginOperationalSync(ids.user,ids.store,{force:true,...rollingRange});
  const rollingSnapshotId=randomUUID();
  await completeOperationalSync(ids.user,rollingJob,{documentId:randomUUID(),snapshotId:rollingSnapshotId,objects:[await storedObject('{"batch":"rolling"}',rollingSnapshotId)],metrics:rollingMetrics,fetchedAt:new Date('2026-09-23T01:00:00Z'),storage});
  const current=await context(ids.user,ids.business,async client=>(await client.query(
    `select metric_date::text,available,order_count::int from mc.current_operational_daily_metrics where store_id=$1 order by metric_date`,[ids.store]
  )).rows);
  assert.equal(current.length,8);
  assert.equal(new Set(current.map(row=>row.metric_date)).size,8);
  assert.deepEqual(current.find(row=>row.metric_date==='2026-09-18'),{metric_date:'2026-09-18',available:true,order_count:18});
});

test('identical operational checksum reuses accepted version while retaining the new protected source',async()=>{
  const job=await beginOperationalSync(ids.user,ids.store,{force:true,...week});
  const repeatedSnapshotId=randomUUID();
  const result=await completeOperationalSync(ids.user,job,{documentId:randomUUID(),snapshotId:repeatedSnapshotId,objects:[await storedObject('{"batch":"partial"}',repeatedSnapshotId)],metrics:metrics(18),fetchedAt:new Date('2026-09-24T01:00:00Z'),storage});
  assert.equal(result.reused,true);
  const counts=await context(ids.user,ids.business,async client=>(await client.query(
    `select (select count(*)::int from mc.operational_snapshots where store_id=$1) snapshots,
            (select count(*)::int from mc.source_documents where store_id=$1 and document_type='operational_sales_funnel') documents`,[ids.store]
  )).rows[0]);
  assert.deepEqual(counts,{snapshots:3,documents:4});
});

test('A to B to A creates a fresh immutable activation and current read returns A',async()=>{
  const job=await beginOperationalSync(ids.user,ids.store,{force:true,...week});
  const snapshotId=randomUUID();
  const result=await completeOperationalSync(ids.user,job,{documentId:randomUUID(),snapshotId,objects:[await storedObject('{"batch":"complete"}',snapshotId)],metrics:metrics(),fetchedAt:new Date('2026-09-25T01:00:00Z'),storage});
  assert.equal(result.reused,true);
  const current=await context(ids.user,ids.business,async client=>(await client.query(
    `select metric_date::text,available,order_count::int from mc.current_operational_daily_metrics where store_id=$1 and metric_date='2026-09-18'`,[ids.store]
  )).rows[0]);
  assert.deepEqual(current,{metric_date:'2026-09-18',available:true,order_count:18});
  const overview=await getOperationalOverviewData(ids.user,ids.store,{periodStart:week.dateFrom,periodEnd:week.dateTo});
  assert.equal(overview.store.id,ids.store);
  assert.deepEqual(overview.current.product_ids,[ids.product]);
  assert.equal(overview.rows.find(row=>row.metric_date==='2026-09-18').order_count,'18');
  assert.equal(await getOperationalOverviewData(ids.foreignUser,ids.store),null);
  const versions=await context(ids.user,ids.business,async client=>(await client.query(`select count(*)::int as n from mc.operational_snapshots where store_id=$1`,[ids.store])).rows[0].n);
  assert.equal(versions,3);
});

test('failed run and foreign tenant cannot replace or read the current snapshot',async()=>{
  const before=(await getOperationalSyncState(ids.user,ids.store)).snapshot_id;
  const job=await beginOperationalSync(ids.user,ids.store,{force:true,...week});
  await failOperationalSync(ids.user,job,'operational_rate_limited',{retryDelaySeconds:20});
  assert.equal((await getOperationalSyncState(ids.user,ids.store)).snapshot_id,before);
  assert.equal(await getOperationalSyncState(ids.foreignUser,ids.store),null);
});

test('analytics request slots are seller-scoped and serialized',async()=>{
  const firstJob=await beginOperationalSync(ids.user,ids.store,{force:true,...week});
  const first=await reserveOperationalRequestSlot(ids.user,firstJob,20);
  const second=await reserveOperationalRequestSlot(ids.user,firstJob,20);
  assert.equal(new Date(second.scheduledAt).getTime(),new Date(first.nextAllowedAt).getTime());
  await failOperationalSync(ids.user,firstJob,'operational_test_finished');
});

test('operational failure cannot finish a run from another stream',async()=>{
  const operationalJob=await beginOperationalSync(ids.user,ids.store,{force:true,...week});
  const foreignRun=await context(ids.user,ids.business,async client=>{
    const stream=(await client.query(`insert into mc.sync_streams(business_id,store_id,source_type,status) values($1,$2,'catalog','active') on conflict(store_id,source_type) do update set status='active' returning id`,[ids.business,ids.store])).rows[0];
    return (await client.query(`insert into mc.sync_runs(business_id,store_id,stream_id,status,started_at) values($1,$2,$3,'running',now()) returning id,stream_id`,[ids.business,ids.store,stream.id])).rows[0];
  });
  await failOperationalSync(ids.user,{...operationalJob,run_id:foreignRun.id},'operational_wrong_run');
  const status=await context(ids.user,ids.business,async client=>(await client.query(`select status from mc.sync_runs where id=$1`,[foreignRun.id])).rows[0].status);
  assert.equal(status,'running');
  await context(ids.user,ids.business,client=>client.query(`update mc.sync_runs set status='failed',finished_at=now(),error_code='test_cleanup' where id=$1`,[foreignRun.id]));
  await failOperationalSync(ids.user,operationalJob,'operational_test_finished');
});

test('selection change rejects an obsolete snapshot and makes the stream due immediately',async()=>{
  const job=await beginOperationalSync(ids.user,ids.store,{force:true,...week});
  const secondProduct=randomUUID();
  await context(ids.user,ids.business,async client=>{
    await client.query(`insert into mc.products(id,business_id,store_id,wb_article,seller_article) values($1,$2,$3,7400002,'P04-2')`,[secondProduct,ids.business,ids.store]);
    await client.query(`select mc.add_products_to_selection($1,$2::uuid[])`,[ids.store,[secondProduct]]);
  });
  const snapshotId=randomUUID();
  const object=await storedObject('{"batch":"obsolete"}',snapshotId);
  await assert.rejects(()=>completeOperationalSync(ids.user,job,{documentId:randomUUID(),snapshotId,objects:[object],metrics:metrics(),storage}),{message:'operational_selection_changed'});
  await failOperationalSync(ids.user,job,'operational_selection_changed');
  const state=await getOperationalSyncState(ids.user,ids.store);
  assert.equal(state.run_status,'failed');
  assert.equal(state.error_code,'operational_selection_changed');
  assert.ok(new Date(state.next_run_at)<=new Date(Date.now()+5000));
  assert.equal(state.comparison_ready,false);
  const overview=await getOperationalOverviewData(ids.user,ids.store,{periodStart:week.dateFrom,periodEnd:week.dateTo});
  assert.deepEqual(new Set(overview.current.product_ids),new Set([ids.product,secondProduct]));
  assert.equal(overview.rows.filter(row=>row.product_id===secondProduct).length,0);
});

test('snapshot publication and selection extension share a database mutex',async()=>{
  const job=await beginOperationalSync(ids.user,ids.store,{force:true,...week});
  const snapshotId=randomUUID();
  const allMetrics=job.products.flatMap(product=>Array.from({length:7},(_,index)=>{
    const day=14+index;
    return {nmId:product.nmId,date:`2026-09-${day}`,currency:'RUB',orderCount:day,orderSum:`${day}00.25`,buyoutCount:day-1,buyoutSum:`${day-1}00.10`};
  }));
  const object=await storedObject('{"batch":"mutex"}',snapshotId);
  const blocker=await pool.connect();
  await blocker.query('begin');
  await blocker.query('lock table mc.source_documents in access exclusive mode');
  const completion=completeOperationalSync(ids.user,job,{documentId:randomUUID(),snapshotId,objects:[object],metrics:allMetrics,storage});
  let mutexObserved=false;
  for(let attempt=0;attempt<50&&!mutexObserved;attempt++){
    const probe=await pool.connect();
    try{
      await probe.query('begin');
      await probe.query("select set_config('app.user_id',$1,true),set_config('app.business_id',$2,true)",[ids.user,ids.business]);
      await probe.query('select 1 from mc.businesses where id=$1 for update nowait',[ids.business]);
      await probe.query('rollback');
    }catch(error){
      await probe.query('rollback');
      if(error.code==='55P03')mutexObserved=true;else throw error;
    }finally{probe.release();}
    if(!mutexObserved)await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.equal(mutexObserved,true);
  const thirdProduct=randomUUID();
  let extensionSettled=false;
  const extension=context(ids.user,ids.business,async client=>{
    await client.query(`insert into mc.products(id,business_id,store_id,wb_article,seller_article) values($1,$2,$3,7400003,'P04-3')`,[thirdProduct,ids.business,ids.store]);
    await client.query(`select mc.add_products_to_selection($1,$2::uuid[])`,[ids.store,[thirdProduct]]);
  }).finally(()=>{extensionSettled=true;});
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(extensionSettled,false);
  await blocker.query('commit');
  blocker.release();
  const published=await completion;
  await extension;
  assert.equal(published.quality,'complete');
  const state=await getOperationalSyncState(ids.user,ids.store);
  assert.ok(new Date(state.next_run_at)<=new Date(Date.now()+5000));
});

test('dispatcher business id disambiguates users with multiple memberships',async()=>{
  await context(ids.foreignUser,ids.foreignBusiness,client=>client.query(
    `insert into mc.memberships(business_id,user_id,role,created_at) values($1,$2,'editor','2000-01-01T00:00:00Z')`,
    [ids.foreignBusiness,ids.user]
  ));
  const job=await beginOperationalSync(ids.user,ids.store,{force:true,businessId:ids.business,...week});
  assert.equal(job.started,true);
  assert.equal(job.business_id,ids.business);
  await failOperationalSync(ids.user,job,'operational_test_finished');
});

test.after(async()=>{await pool.end();await rm(rawRoot,{recursive:true,force:true});});
