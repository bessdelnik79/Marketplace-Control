import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const integrationUrl=process.env.OPERATIONAL_INTEGRATION_DATABASE_URL;
if(!integrationUrl)throw new Error('Set OPERATIONAL_INTEGRATION_DATABASE_URL to a disposable PostgreSQL database whose name contains "test".');
if(!new URL(integrationUrl).pathname.slice(1).toLowerCase().includes('test'))throw new Error('Refusing to run P0.4 integration tests outside a database whose name contains "test".');
process.env.DATABASE_URL=integrationUrl;

const {acquireOperationalSyncLease,closeOperationalSyncLeases,beginOperationalSync,completeOperationalSync,failOperationalSync,getOperationalOverviewData,getOperationalSyncState,reserveOperationalRequestSlot,requestOperationalRangeRefresh,operationalDisplayRange}=await import('../../app/modules/operational/operational.repository.mjs');
const {migrate,pool}=await import('../../app/infrastructure/database/client.mjs');
const {buildOperationalOverview}=await import('../../app/modules/overview/operational-overview.mjs');
const {storeOperationalSnapshot}=await import('../../app/infrastructure/storage/operational-source-storage.mjs');
const {saveWbConnection}=await import('../../app/modules/stores/stores.repository.mjs');
const {claimJobs,completeJob}=await import('../../app/db.mjs');
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

await context(ids.foreignUser,ids.foreignBusiness,async client=>{
  await client.query(`insert into mc.users(id,display_name) values($1,'Foreign owner')`,[ids.foreignUser]);
  await client.query(`insert into mc.businesses(id,name) values($1,'Foreign test')`,[ids.foreignBusiness]);
  await client.query(`insert into mc.memberships(business_id,user_id,role) values($1,$2,'owner')`,[ids.foreignBusiness,ids.foreignUser]);
});
await context(ids.user,ids.business,async client=>{
  await client.query(`insert into mc.users(id,display_name) values($1,'P04 owner')`,[ids.user]);
  await client.query(`insert into mc.businesses(id,name) values($1,'P04 test')`,[ids.business]);
  await client.query(`insert into mc.memberships(business_id,user_id,role) values($1,$2,'owner')`,[ids.business,ids.user]);
  await client.query(`insert into mc.stores(id,business_id,external_account_id,name,status) values($1,$2,'p04-seller','P04 store','active')`,[ids.store,ids.business]);
  await client.query(`select mc.apply_tariff_period($1,'plus',$2,clock_timestamp())`,[ids.business,`operational-returns:${randomUUID()}`]);
  const connection=(await client.query(`insert into mc.connections(business_id,store_id,secret_ref,scopes,status) values($1,$2,'database:p04','["analytics","statistics"]'::jsonb,'active') returning id`,[ids.business,ids.store])).rows[0];
  await client.query(`insert into mc.connection_secrets(business_id,connection_id,ciphertext,nonce,auth_tag) values($1,$2,decode('abcd','hex'),decode(repeat('01',12),'hex'),decode(repeat('02',16),'hex'))`,[ids.business,connection.id]);
  const catalog=(await client.query(`insert into mc.source_documents(business_id,store_id,origin,document_type,checksum,completeness) values($1,$2,'wb_api','catalog','p04-catalog','complete') returning id`,[ids.business,ids.store])).rows[0];
  await client.query(`insert into mc.products(id,business_id,store_id,wb_article,seller_article) values($1,$2,$3,7400001,'P04')`,[ids.product,ids.business,ids.store]);
  await client.query(`select mc.confirm_product_selection($1,$2,$3::uuid[])`,[ids.store,catalog.id,[ids.product]]);
});

const display={periodStart:'2026-09-14',periodEnd:'2026-09-20',now:new Date('2026-09-21T12:00:00Z')};
async function publish(range,{cancelCount=2,cancelAmount='9007199254740993.1250',returnCount=cancelCount,returnAmount=cancelAmount,fetchedAt=new Date('2026-09-21T12:00:00Z'),skipFirst=false}={}){
  const job=await beginOperationalSync(ids.user,ids.store,{force:true,...range});
  const snapshotId=randomUUID();
  const object=await storeOperationalSnapshot({businessId:ids.business,storeId:ids.store,snapshotId,raw:JSON.stringify({range,cancelCount,cancelAmount,returnCount,returnAmount,skipFirst}),root:rawRoot,masterKey});
  const rows=[];
  for(let time=Date.parse(`${job.date_from}T00:00:00Z`);time<=Date.parse(`${job.date_to}T00:00:00Z`);time+=86400000)rows.push({nmId:7400001,date:new Date(time).toISOString().slice(0,10),currency:'RUB',orderCount:3,orderSum:'20.0000',buyoutCount:1,buyoutSum:'10.0000',cancelCount,cancelSum:cancelAmount,returnCount,returnSum:returnAmount});
  if(skipFirst)rows.shift();
  const result=await completeOperationalSync(ids.user,job,{documentId:randomUUID(),snapshotId,objects:[object],metrics:rows,fetchedAt,storage});
  return {job,result};
}

test('calendar defaults independently of persisted snapshots to Moscow latest seven days',()=>{
  assert.deepEqual(operationalDisplayRange({now:new Date('2026-09-21T21:00:00Z')}),{start:'2026-09-16',end:'2026-09-22',days:7,today:'2026-09-22'});
  assert.throws(()=>operationalDisplayRange({...display,periodStart:'2025-01-01'}),/operational_invalid_period/);
  assert.throws(()=>operationalDisplayRange({...display,periodEnd:'2026-09-22'}),/operational_invalid_period/);
});

test('first credential factory waits for selection, drains thirty Moscow days and fences old credentials',async()=>{
  const storeId=randomUUID(),productId=randomUUID(),at=new Date('2026-01-31T21:30:00Z');
  await context(ids.user,ids.business,async client=>{
    await client.query(`select mc.apply_tariff_period($1,'plus',$2,clock_timestamp())`,[ids.business,`operational-factory:${randomUUID()}`]);
    await client.query(`insert into mc.stores(id,business_id,name,status) values($1,$2,'Factory store','paused')`,[storeId,ids.business]);
  });
  const credential={storeId,sellerId:'factory-seller',scopes:['finance','analytics','statistics'],fingerprint:'a'.repeat(64),now:at,
    encrypted:{ciphertext:Buffer.from('abcd','hex'),nonce:Buffer.alloc(12,1),authTag:Buffer.alloc(16,2),keyVersion:1}};
  await saveWbConnection(ids.user,credential);
  const options={periodStart:'2026-01-26',periodEnd:'2026-02-01',now:at};
  let data=await getOperationalOverviewData(ids.user,storeId,options);
  assert.deepEqual([data.updateStatus.factory.start,data.updateStatus.factory.end,data.updateStatus.factory.totalDays],['2026-01-03','2026-02-01',30]);
  assert.equal(data.updateStatus.factory.status,'waiting_financial');
  assert.equal(data.updateStatus.factory.pendingDays,30);
  assert.equal((await beginOperationalSync(ids.user,storeId,{force:true,dateFrom:'2026-01-26',dateTo:'2026-02-01'})).reason,'waiting_financial');
  const worker='operational-factory-finance';
  const bootstrap=(await claimJobs({workerId:worker,jobTypes:['financial_inventory_refresh'],leaseSeconds:300,limit:100})).find(item=>item.store_id===storeId);
  assert.ok(bootstrap);
  await pool.query('select * from mc.apply_financial_inventory($1,$2,$3,$4,$5::jsonb)',[bootstrap.id,Number(bootstrap.payload.credentialGeneration),bootstrap.lease_token,worker,'[]']);
  await completeJob({jobId:bootstrap.id,leaseToken:bootstrap.lease_token,workerId:worker,outcome:'completed'});
  assert.equal((await beginOperationalSync(ids.user,storeId,{force:true,dateFrom:'2026-01-26',dateTo:'2026-02-01'})).reason,'selection_required');
  await saveWbConnection(ids.user,{...credential,now:new Date('2026-02-02T12:00:00Z')});
  assert.equal((await getOperationalOverviewData(ids.user,storeId,options)).updateStatus.factory.start,'2026-01-03');
  assert.equal(await getOperationalOverviewData(ids.foreignUser,storeId,options),null);
  assert.deepEqual(await context(ids.foreignUser,ids.foreignBusiness,async client=>(await client.query(`select * from mc.operational_history_factories where store_id=$1`,[storeId])).rows),[]);
  await context(ids.user,ids.business,async client=>{
    const document=(await client.query(`insert into mc.source_documents(business_id,store_id,origin,document_type,checksum,completeness) values($1,$2,'wb_api','catalog','factory-catalog','complete') returning id`,[ids.business,storeId])).rows[0];
    await client.query(`insert into mc.products(id,business_id,store_id,wb_article,seller_article) values($1,$2,$3,7400003,'Factory')`,[productId,ids.business,storeId]);
    await client.query(`select mc.confirm_product_selection($1,$2,$3::uuid[])`,[storeId,document.id,[productId]]);
  });
  let job=await beginOperationalSync(ids.user,storeId,{force:true,dateFrom:'2026-01-26',dateTo:'2026-02-01'});
  assert.deepEqual([job.date_from,job.date_to],['2026-01-26','2026-02-01']);
  data=await getOperationalOverviewData(ids.user,storeId,options);
  assert.equal(data.updateStatus.factory.status,'running');assert.equal(data.updateStatus.status,'running');
  const outside=await getOperationalOverviewData(ids.user,storeId,{...options,periodStart:'2025-11-01',periodEnd:'2025-11-01'});
  assert.equal(outside.updateStatus.status,'unavailable');assert.equal(outside.updateStatus.factory.status,'running');
  const rotationRace=await Promise.allSettled([
    failOperationalSync(ids.user,job,'operational_unauthorized'),
    saveWbConnection(ids.user,{...credential,fingerprint:'b'.repeat(64)})
  ]);
  assert.ok(rotationRace.every(result=>result.status==='fulfilled'),rotationRace.map(result=>result.reason?.message).filter(Boolean).join('; '));
  const raceState=await context(ids.user,ids.business,async client=>(await client.query(`select ss.status,c.credential_generation
    from mc.sync_streams ss join mc.connections c on c.business_id=ss.business_id and c.store_id=ss.store_id
    where ss.business_id=$1 and ss.store_id=$2 and ss.source_type='operational_sales_funnel'`,[ids.business,storeId])).rows[0]);
  assert.equal(raceState.status,'active');assert.equal(Number(raceState.credential_generation),2);
  await assert.rejects(()=>completeOperationalSync(ids.user,job,{documentId:randomUUID(),snapshotId:randomUUID(),objects:[{}],metrics:[]}),/operational_sync_superseded/);
  const completedDates=new Set();
  for(let batch=0;batch<5;batch++){
    job=await beginOperationalSync(ids.user,storeId,{force:true,dateFrom:'2026-01-26',dateTo:'2026-02-01'});
    if(batch===4){
      const remainingDays=(Date.parse(job.date_to)-Date.parse(job.date_from))/86400000+1;
      await failOperationalSync(ids.user,job,'operational_rate_limited');
      const retry=(await getOperationalOverviewData(ids.user,storeId,{...options,periodStart:job.date_from,periodEnd:job.date_to})).updateStatus;
      assert.equal(retry.status,'failed');assert.equal(retry.retryScheduled,true);
      assert.equal(retry.factory.status,'failed');assert.equal(retry.factory.completeDays,completedDates.size);
      assert.equal(retry.factory.failedDays,remainingDays);assert.equal(completedDates.size+remainingDays,30);
      assert.equal(retry.factory.pendingDays,0);assert.equal(retry.factory.retryScheduled,true);
      job=await beginOperationalSync(ids.user,storeId,{force:true,dateFrom:'2026-01-26',dateTo:'2026-02-01'});
    }
    assert.ok((Date.parse(job.date_to)-Date.parse(job.date_from))/86400000<=6);
    const snapshotId=randomUUID();
    const object=await storeOperationalSnapshot({businessId:ids.business,storeId,snapshotId,raw:JSON.stringify({batch}),root:rawRoot,masterKey});
    const metrics=[];
    for(let day=Date.parse(job.date_from);day<=Date.parse(job.date_to);day+=86400000)metrics.push({nmId:7400003,date:new Date(day).toISOString().slice(0,10),currency:'RUB',orderCount:0,orderSum:'0',buyoutCount:0,buyoutSum:'0',cancelCount:0,cancelSum:'0',returnCount:0,returnSum:'0'});
    await completeOperationalSync(ids.user,job,{documentId:randomUUID(),snapshotId,objects:[object],metrics,storage});
    for(const metric of metrics){assert.equal(completedDates.has(metric.date),false);completedDates.add(metric.date);}
    const factory=(await getOperationalOverviewData(ids.user,storeId,options)).updateStatus.factory;
    assert.equal(factory.completeDays,completedDates.size);
  }
  assert.equal(completedDates.size,30);
  assert.equal([...completedDates].sort()[0],'2026-01-03');assert.equal([...completedDates].sort().at(-1),'2026-02-01');
  data=await getOperationalOverviewData(ids.user,storeId,options);
  assert.equal(data.updateStatus.factory.status,'current');assert.equal(data.updateStatus.factory.completeDays,30);
  assert.equal(data.updateStatus.factory.retryScheduled,false);
  await saveWbConnection(ids.user,{...credential,fingerprint:'b'.repeat(64),now:new Date('2026-03-03T12:00:00Z')});
  assert.equal((await getOperationalOverviewData(ids.user,storeId,options)).updateStatus.factory.completeDays,30);
  const extra=randomUUID();
  await context(ids.user,ids.business,async client=>{
    await client.query(`insert into mc.products(id,business_id,store_id,wb_article,seller_article) values($1,$2,$3,7400004,'Factory extra')`,[extra,ids.business,storeId]);
    await client.query(`select mc.add_products_to_selection($1,$2::uuid[])`,[storeId,[extra]]);
  });
  const changedScope=(await getOperationalOverviewData(ids.user,storeId,options)).updateStatus.factory;
  assert.equal(changedScope.status,'unavailable');assert.equal(changedScope.completeDays,0);assert.equal(changedScope.missingDays,30);
  const expired=await requestOperationalRangeRefresh(ids.user,storeId,'2024-01-01','2024-01-07',{now:at});
  assert.equal(expired.status,'unavailable');assert.equal(expired.queued,0);
  assert.equal(expired.errorCode,'operational_history_out_of_range');
  const expiredRead=await getOperationalOverviewData(ids.user,storeId,{periodStart:'2024-01-01',periodEnd:'2024-01-07',now:at});
  assert.equal(expiredRead.updateStatus.status,'unavailable');assert.equal(expiredRead.updateStatus.totalDays,35);
  assert.equal(expiredRead.updateStatus.errorCode,'operational_history_out_of_range');
});
test('immutable versions support exact return money, idempotency and corrected snapshots',async()=>{
  const range={dateFrom:'2026-09-14',dateTo:'2026-09-20'};
  const first=await publish(range);
  const data=await getOperationalOverviewData(ids.user,ids.store,display);
  const model=buildOperationalOverview(data);
  assert.deepEqual(model.returnData.returns,{count:'14',amount:'63050394783186951.8750'});
  assert.equal(model.returnData.quality,'complete');
  const repeated=await publish(range,{fetchedAt:new Date('2026-09-21T13:00:00Z')});
  assert.equal(repeated.result.reused,true);
  assert.equal(repeated.result.snapshotId,first.result.snapshotId);
  await publish(range,{cancelCount:3,cancelAmount:'1.2345',fetchedAt:new Date('2026-09-21T14:00:00Z')});
  assert.deepEqual(buildOperationalOverview(await getOperationalOverviewData(ids.user,ids.store,display)).returnData.returns,{count:'21',amount:'8.6415'});
  await assert.rejects(()=>context(ids.user,ids.business,client=>client.query(`update mc.operational_daily_metrics set cancel_count=100 where snapshot_id=$1`,[first.result.snapshotId])),/immutable|mutation/i);
  assert.equal(await getOperationalOverviewData(ids.foreignUser,ids.store,display),null);
});
test('durable refresh queues exact four preceding equal ranges and drains only published window',async()=>{
  const requested=await requestOperationalRangeRefresh(ids.user,ids.store,'2026-09-19','2026-09-20',{now:display.now});
  assert.equal(requested.status,'pending');
  const pending=()=>context(ids.user,ids.business,async client=>(await client.query(`select metric_date::text from mc.operational_range_requests where store_id=$1 and status='pending' order by metric_date`,[ids.store])).rows);
  const before=await pending();
  assert.equal(before[0].metric_date,'2026-09-11');
  assert.equal(before.at(-1).metric_date,'2026-09-13');
  const duplicate=await requestOperationalRangeRefresh(ids.user,ids.store,'2026-09-19','2026-09-20',{now:display.now});
  assert.equal(duplicate.queued,0);
  const loaded=await publish({dateFrom:'2026-09-15',dateTo:'2026-09-21'},{cancelCount:0,cancelAmount:'0.0000',fetchedAt:new Date('2026-09-21T15:00:00Z')});
  assert.equal(loaded.job.date_from,'2026-09-11');
  assert.equal(loaded.job.date_to,'2026-09-13');
  assert.equal((await pending()).length,0);
  assert.equal(buildOperationalOverview(await getOperationalOverviewData(ids.user,ids.store,{...display,periodStart:'2026-09-19'})).returnData.comparison.available,true);
});
test('pending range isolation denies foreign tenant read and enqueue',async()=>{
  await assert.rejects(()=>requestOperationalRangeRefresh(ids.foreignUser,ids.store,'2026-09-19','2026-09-20',{now:display.now}),/operational_connection_unavailable/);
  const foreignRows=await context(ids.foreignUser,ids.foreignBusiness,async client=>(await client.query(`select * from mc.operational_range_requests where store_id=$1`,[ids.store])).rows);
  assert.deepEqual(foreignRows,[]);
});

test('viewer may read operational periods but cannot queue a WB refresh',async()=>{
  const viewer=randomUUID();
  await context(viewer,ids.business,client=>client.query(`insert into mc.users(id,display_name) values($1,'Read-only viewer')`,[viewer]));
  await context(ids.user,ids.business,async client=>{
    await client.query(`insert into mc.memberships(business_id,user_id,role) values($1,$2,'viewer')`,[ids.business,viewer]);
  });
  assert.ok(await getOperationalOverviewData(viewer,ids.store,display));
  await assert.rejects(()=>requestOperationalRangeRefresh(viewer,ids.store,'2026-09-19','2026-09-20',{now:display.now}),/operational_refresh_forbidden/);
});
test('failed historical run retains previous published result and pending queue',async()=>{
  await requestOperationalRangeRefresh(ids.user,ids.store,'2026-08-31','2026-09-01',{now:display.now});
  const before=buildOperationalOverview(await getOperationalOverviewData(ids.user,ids.store,display));
  const job=await beginOperationalSync(ids.user,ids.store,{force:true,dateFrom:'2026-09-15',dateTo:'2026-09-21'});
  await failOperationalSync(ids.user,job,'operational_rate_limited');
  const after=buildOperationalOverview(await getOperationalOverviewData(ids.user,ids.store,display));
  assert.deepEqual(after.returnData.returns,before.returnData.returns);
  assert.equal(after.updateStatus.status,'pending');
  assert.ok(after.updateStatus.failedDays>0);
  assert.equal(after.updateStatus.retryScheduled,true);
  assert.ok(after.updateStatus.pendingDays>0);
});

test('partial coverage marks missing requested day failed rather than falsely complete or endlessly pending',async()=>{
  await context(ids.user,ids.business,async client=>{
    await client.query(`delete from mc.operational_range_requests where business_id=$1 and store_id=$2`,[ids.business,ids.store]);
    await client.query(`insert into mc.operational_range_requests(business_id,store_id,metric_date)
      select $1,$2,day::date from generate_series('2026-09-15'::date,'2026-09-21'::date,interval '1 day') day`,[ids.business,ids.store]);
  });
  const loaded=await publish({dateFrom:'2026-09-15',dateTo:'2026-09-21'},{skipFirst:true,cancelCount:0,cancelAmount:'0.0000'});
  assert.equal(loaded.result.quality,'partial');
  const row=await context(ids.user,ids.business,async client=>(await client.query(`select status from mc.operational_range_requests where store_id=$1 and metric_date=$2`,[ids.store,loaded.job.date_from])).rows[0]);
  assert.equal(row.status,'failed');
  const state=await getOperationalOverviewData(ids.user,ids.store,{...display,periodStart:loaded.job.date_from,periodEnd:loaded.job.date_to});
  assert.equal(state.updateStatus.status,'failed');
  assert.equal(state.updateStatus.errorCode,'operational_metric_unavailable');
  assert.equal(state.updateStatus.retryScheduled,false);
});

test('read model restores saved complete scope locally after a partial refresh',async()=>{
  await context(ids.user,ids.business,client=>client.query(`update mc.operational_range_requests set status='failed' where status='pending'`));
  await publish({dateFrom:'2026-09-14',dateTo:'2026-09-20'},{fetchedAt:new Date('2026-10-02T12:00:00Z')});
  await publish({dateFrom:'2026-09-14',dateTo:'2026-09-20'},{skipFirst:true,fetchedAt:new Date('2026-10-03T12:00:00Z')});
  const data=await getOperationalOverviewData(ids.user,ids.store,display);
  assert.equal(data.savedRows.length,7);
  const model=buildOperationalOverview(data);
  assert.equal(model.quality,'complete');assert.equal(model.savedDataUsed,true);
  assert.equal(model.returnData.quality,'complete');assert.equal(model.returnData.savedDataUsed,true);
  assert.equal(model.orders.count,'21');
});

test('historical purchased-return amount pending remains retryable until WB fills its amount',async()=>{
  await context(ids.user,ids.business,async client=>{
    await client.query(`delete from mc.operational_range_requests where business_id=$1 and store_id=$2`,[ids.business,ids.store]);
    await client.query(`insert into mc.operational_range_requests(business_id,store_id,metric_date)
      select $1,$2,day::date from generate_series('2026-08-24'::date,'2026-08-30'::date,interval '1 day') day`,[ids.business,ids.store]);
  });
  const range={dateFrom:'2026-08-24',dateTo:'2026-08-30'},options={...display,periodStart:range.dateFrom,periodEnd:range.dateTo};
  await publish(range,{returnCount:1,returnAmount:null,fetchedAt:display.now});
  let data=await getOperationalOverviewData(ids.user,ids.store,options);
  assert.equal(data.updateStatus.status,'failed');assert.equal(data.updateStatus.failedDays,7);assert.equal(data.updateStatus.retryScheduled,true);
  const scheduled=await context(ids.user,ids.business,async client=>(await client.query(`select next_run_at>=now()+interval '14 minutes' delayed
    from mc.sync_streams where business_id=$1 and store_id=$2 and source_type='operational_sales_funnel'`,[ids.business,ids.store])).rows[0]);
  assert.equal(scheduled.delayed,true);
  assert.ok(data.rows.filter(row=>row.metric_date>=range.dateFrom).every(row=>row.return_count==='1'&&row.return_amount===null));
  await publish(range,{returnCount:1,returnAmount:'2.50',fetchedAt:new Date('2026-09-21T13:00:00Z')});
  data=await getOperationalOverviewData(ids.user,ids.store,options);
  assert.equal(data.updateStatus.failedDays,0);assert.equal(data.updateStatus.retryScheduled,false);
});

test('older-than-ninety-day funnel coverage completes its queue without inventing or re-fetching returns',async()=>{
  const options={...display,periodStart:'2026-05-01',periodEnd:'2026-05-07'};
  const requested=await requestOperationalRangeRefresh(ids.user,ids.store,options.periodStart,options.periodEnd,{now:display.now});
  assert.equal(requested.pendingDays,35);
  for(let batch=0;batch<5;batch++)await publish({dateFrom:options.periodStart,dateTo:options.periodEnd},{cancelCount:99,cancelAmount:'99',returnCount:null,returnAmount:null,fetchedAt:display.now});
  const data=await getOperationalOverviewData(ids.user,ids.store,options);
  assert.equal(data.today,'2026-09-21');assert.equal(data.updateStatus.status,'current');assert.equal(data.updateStatus.completeDays,35);
  assert.equal(data.updateStatus.failedDays,0);assert.equal(data.updateStatus.pendingDays,0);
  assert.ok(data.rows.every(row=>row.return_count===null&&row.return_amount===null));
  assert.equal(buildOperationalOverview(data).returnData.returns,null);
  const repeated=await requestOperationalRangeRefresh(ids.user,ids.store,options.periodStart,options.periodEnd,{now:display.now});
  assert.equal(repeated.queued,0);assert.equal(repeated.pendingDays,0);assert.equal(repeated.status,'current');
});

test('funnel cancellations remain audit data and missing purchased-return evidence never becomes zero',async()=>{
  await publish({dateFrom:'2026-08-03',dateTo:'2026-08-09'},{cancelCount:99,cancelAmount:'99',returnCount:null,returnAmount:null});
  const legacy=await getOperationalOverviewData(ids.user,ids.store,{...display,periodStart:'2026-08-03',periodEnd:'2026-08-09'});
  assert.equal(legacy.rows[0].cancel_count,'99');assert.equal(legacy.rows[0].return_count,null);
  assert.equal(buildOperationalOverview(legacy).returnData.quality,'unavailable');assert.equal(buildOperationalOverview(legacy).returnData.returns,null);
  assert.equal(legacy.updateStatus.completeDays,0);
  await publish({dateFrom:'2026-08-17',dateTo:'2026-08-23'},{cancelCount:99,cancelAmount:'99',returnCount:2,returnAmount:'3.1250'});
  const purchased=buildOperationalOverview(await getOperationalOverviewData(ids.user,ids.store,{...display,periodStart:'2026-08-17',periodEnd:'2026-08-23'}));
  assert.deepEqual(purchased.returnData.returns,{count:'14',amount:'21.8750'});
});

test('saved fallback rejects alternate scope and foreign tenant',async()=>{
  const second=randomUUID();
  await context(ids.user,ids.business,async client=>{
    await client.query(`insert into mc.products(id,business_id,store_id,wb_article,seller_article) values($1,$2,$3,7400002,'P04 extra')`,[second,ids.business,ids.store]);
    await client.query(`select mc.add_products_to_selection($1,$2::uuid[])`,[ids.store,[second]]);
  });
  const data=await getOperationalOverviewData(ids.user,ids.store,display);
  assert.deepEqual(data.savedRows,[]);assert.equal(buildOperationalOverview(data).savedDataUsed,false);
  assert.equal(await getOperationalOverviewData(ids.foreignUser,ids.store,display),null);
});

test('manual corrected range resumes only parameter blocks and retains access blocks',async()=>{
  const requested={start:'2026-09-19',end:'2026-09-20'};
  await requestOperationalRangeRefresh(ids.user,ids.store,requested.start,requested.end,{now:display.now});
  let job=await beginOperationalSync(ids.user,ids.store,{force:true,dateFrom:requested.start,dateTo:requested.end});
  await failOperationalSync(ids.user,job,'operational_invalid_request');
  const streamStatus=()=>context(ids.user,ids.business,async client=>(await client.query(`select status from mc.sync_streams where business_id=$1 and store_id=$2 and source_type='operational_sales_funnel'`,[ids.business,ids.store])).rows[0].status);
  assert.equal(await streamStatus(),'blocked');
  await assert.rejects(()=>requestOperationalRangeRefresh(ids.user,ids.store,'2026-09-21','2026-09-20',{now:display.now}),/operational_invalid_period/);
  assert.equal(await streamStatus(),'blocked');
  const resumed=await requestOperationalRangeRefresh(ids.user,ids.store,requested.start,requested.end,{now:display.now});
  assert.equal(resumed.status,'pending');assert.equal(await streamStatus(),'active');
  job=await beginOperationalSync(ids.user,ids.store,{force:true,dateFrom:requested.start,dateTo:requested.end});
  await failOperationalSync(ids.user,job,'operational_unauthorized');
  const denied=await requestOperationalRangeRefresh(ids.user,ids.store,requested.start,requested.end,{now:display.now});
  assert.equal(denied.status,'blocked');assert.equal(denied.queued,0);assert.equal(denied.errorCode,'operational_unauthorized');
  assert.equal(await streamStatus(),'blocked');
});

test('session store lease is exclusive and only a verified active lease can recover a recent orphan',async()=>{
  // Previous access-block regression deliberately leaves this test store blocked.
  await context(ids.user,ids.business,client=>client.query(`update mc.sync_streams set status='active',next_run_at=clock_timestamp()
    where business_id=$1 and store_id=$2 and source_type='operational_sales_funnel'`,[ids.business,ids.store]));
  const first=await acquireOperationalSyncLease(ids.user,ids.store);
  first.assertActive();
  assert.ok(first);assert.equal(await acquireOperationalSyncLease(ids.user,ids.store),null);
  try{
    const range={dateFrom:'2026-09-14',dateTo:'2026-09-20'};
    const orphan=await beginOperationalSync(ids.user,ids.store,{force:true,...range});
    assert.equal(orphan.started,true);
    assert.equal((await beginOperationalSync(ids.user,ids.store,{force:true,...range})).reason,'running');
    await assert.rejects(()=>beginOperationalSync(ids.user,ids.store,{force:true,...range,runtimeLease:{release:async()=>{}}}),/operational_invalid_runtime_lease/);
    const recovered=await beginOperationalSync(ids.user,ids.store,{force:true,...range,runtimeLease:first});
    assert.equal(recovered.started,true);assert.notEqual(recovered.run_id,orphan.run_id);
    const old=await context(ids.user,ids.business,async client=>(await client.query(`select status,error_code from mc.sync_runs where id=$1`,[orphan.run_id])).rows[0]);
    assert.deepEqual(old,{status:'failed',error_code:'operational_interrupted'});
    await failOperationalSync(ids.user,recovered,'test_cleanup');
  }finally{await first.release();await first.release();}
  assert.throws(()=>first.assertActive(),/operational_invalid_runtime_lease/);
  await assert.rejects(()=>beginOperationalSync(ids.user,ids.store,{force:true,dateFrom:'2026-09-14',dateTo:'2026-09-20',runtimeLease:first}),/operational_invalid_runtime_lease/);
  const next=await acquireOperationalSyncLease(ids.user,ids.store);
  assert.ok(next);await next.release();
  await assert.rejects(()=>acquireOperationalSyncLease(ids.foreignUser,ids.store),/operational_connection_unavailable/);
});

test.after(async()=>{await closeOperationalSyncLeases();await pool.end();await rm(rawRoot,{recursive:true,force:true});});
