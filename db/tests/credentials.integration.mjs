import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';

const integrationUrl=process.env.CREDENTIALS_INTEGRATION_DATABASE_URL;
if(!integrationUrl)throw new Error('Set CREDENTIALS_INTEGRATION_DATABASE_URL to a disposable PostgreSQL database whose name contains "test".');
const databaseName=new URL(integrationUrl).pathname.slice(1);
if(!databaseName.toLowerCase().includes('test'))throw new Error('Refusing to run credential integration tests outside a database whose name contains "test".');
process.env.DATABASE_URL=integrationUrl;

const [{migrate,pool,saveWbConnection,enqueueJob,claimJobs,completeJob,failJob,getFinancialSyncState,requestFinancialInventoryRefresh},{encryptSecret,fingerprintSecret},{createFinancialInventoryRepository}]=await Promise.all([
  import('../../app/db.mjs'),
  import('../../app/infrastructure/security/secrets.mjs'),
  import('../../app/modules/reports/financial-inventory.repository.mjs')
]);
const inventoryRepository=createFinancialInventoryRepository({pool});

const ids={user:randomUUID(),business:randomUUID(),store:randomUUID()};
const encryptionKey=randomBytes(32),fingerprintKey=randomBytes(32);
const at=new Date('2026-09-28T21:30:00.000Z');

await migrate();

async function inContext(action){
  const client=await pool.connect();
  try{
    await client.query('begin');
    await client.query("select set_config('app.user_id',$1,true),set_config('app.business_id',$2,true)",[ids.user,ids.business]);
    const result=await action(client);
    await client.query('commit');
    return result;
  }catch(error){await client.query('rollback');throw error;}finally{client.release();}
}

await inContext(async client=>{
  await client.query(`insert into mc.users(id,display_name) values($1,'Credential owner')`,[ids.user]);
  await client.query(`insert into mc.businesses(id,name) values($1,'Credential integration')`,[ids.business]);
  await client.query(`insert into mc.memberships(business_id,user_id,role) values($1,$2,'owner')`,[ids.business,ids.user]);
  await client.query(`insert into mc.stores(id,business_id,external_account_id,name,status) values($1,$2,'credential-new','New token store','paused')`,[ids.store,ids.business]);
});

async function acceptInventory(reportId){
  await inContext(async client=>{
    const inventoryRow=(await client.query(`select id,inventory_checksum,period_start,period_end,external_report_id
      from mc.financial_week_inventory where store_id=$1 and external_report_id=$2`,[ids.store,reportId])).rows[0];
    const document=(await client.query(`insert into mc.source_documents(
      business_id,store_id,origin,document_type,external_document_id,checksum,completeness
    ) values($1,$2,'wb_api','weekly_realization',$3,$4,'complete') returning id`,
    [ids.business,ids.store,inventoryRow.external_report_id,inventoryRow.inventory_checksum])).rows[0];
    const report=(await client.query(`insert into mc.reports(
      business_id,store_id,external_report_id,period_start,period_end
    ) values($1,$2,$3,$4,$5) returning id`,
    [ids.business,ids.store,inventoryRow.external_report_id,inventoryRow.period_start,inventoryRow.period_end])).rows[0];
    const version=(await client.query(`insert into mc.report_versions(
      business_id,store_id,report_id,document_id,version_no,checksum,parser_version
    ) values($1,$2,$3,$4,1,$5,'wb-finance-v11') returning id`,
    [ids.business,ids.store,report.id,document.id,inventoryRow.inventory_checksum])).rows[0];
    await client.query(`update mc.report_versions set status='validated' where id=$1`,[version.id]);
    await client.query(`update mc.report_versions set status='accepted',accepted_at=now() where id=$1`,[version.id]);
    await client.query(`update mc.reports set current_version_id=$1 where id=$2`,[version.id,report.id]);
    const method=(await client.query(`select id from mc.method_versions where code='wb_finance_import' and version_no=11`)).rows[0];
    const normalization=(await client.query(`insert into mc.report_normalizations(
      business_id,store_id,report_version_id,method_version_id,normalization_key,status
    ) values($1,$2,$3,$4,$5,'succeeded') returning id`,
    [ids.business,ids.store,version.id,method.id,`credential-integration:${version.id}`])).rows[0];
    await client.query(`update mc.financial_week_inventory set fetch_status='accepted',report_version_id=$2,
      accepted_normalization_id=$3,accepted_inventory_checksum=inventory_checksum,accepted_at=now() where id=$1`,
    [inventoryRow.id,version.id,normalization.id]);
  });
}

const save=(storeId,sellerId,token,scopes=['finance'])=>saveWbConnection(ids.user,{
  storeId,sellerId,scopes,encrypted:encryptSecret(token,encryptionKey),fingerprint:fingerprintSecret(token,fingerprintKey),now:at
});

test('new, repeated and changed WB credentials advance generation and enqueue exactly once',async()=>{
  const first=await save(ids.store,'credential-new','wb-token-one');
  assert.deepEqual({changed:first.credentialChanged,generation:first.generation},{changed:true,generation:1});
  assert.match(first.jobId,/^[0-9a-f-]{36}$/i);
  assert.equal(Object.hasOwn(first,'fingerprint'),false);
  const initialFactory=await inContext(async client=>({
    marker:(await client.query(`select period_start::text,period_end::text from mc.operational_history_factories where store_id=$1`,[ids.store])).rows[0],
    days:(await client.query(`select metric_date::text,status,initial_status from mc.operational_range_requests where store_id=$1 order by metric_date`,[ids.store])).rows
  }));
  assert.deepEqual(initialFactory.marker,{period_start:'2026-08-31',period_end:'2026-09-29'});
  assert.equal(initialFactory.days.length,30);
  assert.ok(initialFactory.days.every(day=>day.status==='pending'&&day.initial_status==='pending'));
  const firstCiphertext=await inContext(async client=>(await client.query(
    `select ciphertext from mc.connection_secrets where connection_id=$1`,[first.id]
  )).rows[0].ciphertext);

  const repeated=await save(ids.store,'credential-new','wb-token-one',['finance','analytics']);
  assert.deepEqual({changed:repeated.credentialChanged,generation:repeated.generation,jobId:repeated.jobId},{changed:false,generation:1,jobId:null});
  const repeatedState=await inContext(async client=>(await client.query(
    `select c.scopes,s.ciphertext from mc.connections c join mc.connection_secrets s on s.connection_id=c.id where c.store_id=$1`,[ids.store]
  )).rows[0]);
  assert.deepEqual(repeatedState.scopes,['finance','analytics']);
  assert.equal(repeatedState.ciphertext.equals(firstCiphertext),false);
  assert.equal(await inContext(async client=>Number((await client.query(`select count(*) from mc.operational_range_requests where store_id=$1`,[ids.store])).rows[0].count)),30);

  const changed=await save(ids.store,'credential-new','wb-token-two',['finance','analytics']);
  assert.deepEqual({changed:changed.credentialChanged,generation:changed.generation},{changed:true,generation:2});
  assert.notEqual(changed.jobId,first.jobId);
  const concurrent=await Promise.all([
    save(ids.store,'credential-new','wb-token-three',['finance','analytics']),
    save(ids.store,'credential-new','wb-token-three',['finance','analytics'])
  ]);
  assert.equal(concurrent.filter(result=>result.credentialChanged).length,1);
  assert.deepEqual(concurrent.map(result=>result.generation),[3,3]);

  const state=await inContext(async client=>({
    connection:(await client.query(`select credential_generation,scopes from mc.connections where store_id=$1`,[ids.store])).rows[0],
    secret:(await client.query(`select ciphertext,credential_fingerprint from mc.connection_secrets where connection_id=$1`,[first.id])).rows[0],
    jobs:(await client.query(`select id,deduplication_key,payload,priority,max_attempts from mc.jobs where store_id=$1 order by created_at,id`,[ids.store])).rows,
    eventState:(await client.query(`select next_generation from mc.financial_store_event_state where store_id=$1`,[ids.store])).rows[0],
    coverage:(await client.query(`select credential_generation,week_start::text as week_start,week_end::text as week_end,check_reasons from mc.financial_week_coverage where store_id=$1 order by credential_generation,week_start`,[ids.store])).rows,
    audits:(await client.query(`select action,safe_details from mc.audit_events where store_id=$1 order by created_at,id`,[ids.store])).rows
  }));
  assert.equal(Number(state.connection.credential_generation),3);
  assert.equal(Number(state.eventState.next_generation),4);
  assert.deepEqual(state.connection.scopes,['finance','analytics']);
  assert.equal(state.jobs.length,3);
  assert.deepEqual(state.jobs.map(job=>job.deduplication_key),[
    `financial-inventory:${ids.store}:g1:credential`,
    `financial-inventory:${ids.store}:g2:credential`,
    `financial-inventory:${ids.store}:g3:credential`
  ]);
  assert.deepEqual(state.jobs[0].payload,{
    schemaVersion:1,credentialGeneration:1,reason:'credential_generation',
    window:{dateFrom:'2025-09-29',dateTo:'2026-09-27'},timezone:'Europe/Moscow'
  });
  assert.ok(state.jobs.every(job=>job.priority===100&&job.max_attempts===20));
  assert.equal(state.coverage.length,156);
  assert.deepEqual(state.coverage[0].check_reasons,['credential_generation']);
  assert.equal(state.coverage[0].week_start,'2025-09-29');
  assert.ok(state.audits.filter(row=>row.action==='wb_credential_saved').every(row=>{
    const encoded=JSON.stringify(row.safe_details);
    return !encoded.includes('wb-token')&&!encoded.includes(state.secret.credential_fingerprint);
  }));
});

test('inventory context and writes require the current lease and latest credential generation',async()=>{
  const claimed=await claimJobs({workerId:'credential-integration-worker',jobTypes:['financial_inventory_refresh'],leaseSeconds:300,limit:3});
  assert.equal(claimed.length,3);
  const current=claimed.find(item=>Number(item.payload.credentialGeneration)===3);
  const stale=claimed.find(item=>Number(item.payload.credentialGeneration)===1);
  await assert.rejects(()=>pool.query(`select * from mc.get_financial_inventory_context($1,$2,$3,$4)`,[
    current.id,3,randomUUID(),'credential-integration-worker'
  ]),/running financial inventory job is required/);
  const context=(await pool.query(`select * from mc.get_financial_inventory_context($1,$2,$3,$4)`,[
    current.id,3,current.lease_token,'credential-integration-worker'
  ])).rows[0];
  assert.equal(context.store_id,ids.store);
  assert.equal((await pool.query(`select * from mc.get_financial_inventory_context($1,$2,$3,$4)`,[
    stale.id,1,stale.lease_token,'credential-integration-worker'
  ])).rows.length,0);
  const inventory=[{reportId:'90071992547409931',checksum:'b'.repeat(64),dateFrom:'2026-09-21',dateTo:'2026-09-27',reportType:'1',country:'Россия'}];
  const applied=(await pool.query(`select * from mc.apply_financial_inventory($1,$2,$3,$4,$5::jsonb)`,[
    current.id,3,current.lease_token,'credential-integration-worker',JSON.stringify(inventory)
  ])).rows[0];
  assert.equal(applied.superseded,false);
  assert.equal(Number(applied.uncovered_weeks),0);
  const coverageDistribution=await inContext(async client=>(await client.query(
    `select count(*)::int total,count(*) filter(where coverage_status='absent')::int absent,
      count(*) filter(where coverage_status='fetching')::int fetching
      from mc.financial_week_coverage where store_id=$1 and credential_generation=3`,[ids.store]
  )).rows[0]);
  assert.deepEqual(coverageDistribution,{total:52,absent:51,fetching:1});
  assert.equal(await inContext(async client=>Number((await client.query(
    `select count(*) from mc.jobs where store_id=$1 and job_type='financial_report_fetch'`,[ids.store]
  )).rows[0].count)),1);
  await completeJob({jobId:current.id,leaseToken:current.lease_token,workerId:'credential-integration-worker',outcome:'completed'});
  assert.equal(await inContext(async client=>(await client.query('select mc.operational_financial_bootstrap_ready($1) ready',[ids.store])).rows[0].ready),false);
  for(const old of claimed.filter(item=>item.id!==current.id))await completeJob({jobId:old.id,leaseToken:old.lease_token,workerId:'credential-integration-worker',outcome:'superseded'});
  const [fetchJob]=await claimJobs({workerId:'credential-fetch-worker',jobTypes:['financial_report_fetch'],leaseSeconds:300,limit:1});
  await acceptInventory('90071992547409931');
  await completeJob({jobId:fetchJob.id,leaseToken:fetchJob.lease_token,workerId:'credential-fetch-worker',outcome:'completed'});
  assert.equal(await inContext(async client=>(await client.query('select mc.operational_financial_bootstrap_ready($1) ready',[ids.store])).rows[0].ready),true);
  await enqueueJob(ids.user,{storeId:ids.store,jobType:'financial_inventory_refresh',deduplicationKey:`integration-refresh:${ids.store}`,
    payload:{schemaVersion:1,credentialGeneration:3,window:{dateFrom:'2026-09-21',dateTo:'2026-09-27'}},priority:500,maxAttempts:3});
  const [refresh]=await claimJobs({workerId:'credential-refresh-worker',jobTypes:['financial_inventory_refresh'],leaseSeconds:300,limit:1});
  const outsideCoverage=await inContext(async client=>(await client.query(`update mc.financial_week_coverage set
      coverage_status='pending',last_checked_at=null,next_retry_at=null,last_error_code=null,updated_at='2026-01-01T00:00:00Z'
    where id=(select id from mc.financial_week_coverage where store_id=$1 and credential_generation=3
      and week_end<'2026-09-21' order by week_start limit 1)
    returning id,coverage_status,last_checked_at,next_retry_at,last_error_code,updated_at`,[ids.store])).rows[0]);
  const outsideInventory={reportId:'90071992547409932',checksum:'c'.repeat(64),dateFrom:'2026-09-14',dateTo:'2026-09-20',reportType:'1',country:'Россия',summaryRaw:{marker:'after'}};
  await inContext(client=>client.query(`insert into mc.financial_week_inventory(
      business_id,store_id,coverage_id,external_report_id,inventory_checksum,report_type,country,period_start,period_end,summary_raw_data
    ) select business_id,store_id,id,$2,$3,'1','Россия','2026-09-14','2026-09-20',$4::jsonb
      from mc.financial_week_coverage where store_id=$1 and credential_generation=3 and week_start='2026-09-14'`,
    [ids.store,outsideInventory.reportId,outsideInventory.checksum,JSON.stringify({marker:'before'})]));
  const reapplied=await inventoryRepository.apply(
    refresh.id,3,refresh.lease_token,'credential-refresh-worker',[...inventory,outsideInventory]
  );
  assert.equal(Number(reapplied.uncovered_weeks),0);
  assert.equal(Number(reapplied.enqueued_fetches),1);
  assert.deepEqual(await inContext(async client=>(await client.query(`select id,coverage_status,last_checked_at,next_retry_at,last_error_code,updated_at
      from mc.financial_week_coverage where id=$1`,[outsideCoverage.id])).rows[0]),outsideCoverage);
  assert.deepEqual(await inContext(async client=>(await client.query(`select summary_raw_data from mc.financial_week_inventory
      where store_id=$1 and external_report_id=$2`,[ids.store,outsideInventory.reportId])).rows[0].summary_raw_data),{marker:'before'});
  assert.equal(await inContext(async client=>Number((await client.query(
    `select count(*) from mc.jobs where store_id=$1 and job_type='financial_report_fetch'`,[ids.store]
  )).rows[0].count)),2);
  await completeJob({jobId:refresh.id,leaseToken:refresh.lease_token,workerId:'credential-refresh-worker',outcome:'completed'});
});

test('credential update and annual enqueue roll back together',async()=>{
  const before=await inContext(async client=>(await client.query(
    `select c.credential_generation,s.credential_fingerprint from mc.connections c join mc.connection_secrets s on s.connection_id=c.id where c.store_id=$1`,
    [ids.store]
  )).rows[0]);
  await assert.rejects(()=>saveWbConnection(ids.user,{
    storeId:ids.store,sellerId:'credential-new',scopes:['finance'],
    encrypted:encryptSecret('rollback-token',encryptionKey),
    fingerprint:fingerprintSecret('rollback-token',fingerprintKey),now:new Date('invalid')
  }),/invalid|date|time/i);
  const after=await inContext(async client=>(await client.query(
    `select c.credential_generation,s.credential_fingerprint from mc.connections c join mc.connection_secrets s on s.connection_id=c.id where c.store_id=$1`,
    [ids.store]
  )).rows[0]);
  assert.deepEqual(after,before);
});

test('manual refresh is durable and mixed pipeline state remains running',async()=>{
  await inContext(client=>client.query(`update mc.financial_week_coverage set coverage_status='partial',last_error_code='financial_terminal_fixture'
    where store_id=$1 and credential_generation=3 and week_start='2025-09-29'`,[ids.store]));
  const gaps=await inContext(async client=>(await client.query(`select min(week_start)::text date_from,
    max(week_end)::text date_to,count(*)::int count from mc.financial_week_coverage
    where store_id=$1 and credential_generation=3 and coverage_status in ('partial','retry','unavailable')`,[ids.store])).rows[0]);
  const first=await requestFinancialInventoryRefresh(ids.user,ids.store,{now:new Date('2025-10-06T09:00:00Z')});
  const duplicate=await requestFinancialInventoryRefresh(ids.user,ids.store,{now:new Date('2025-10-06T09:01:00Z')});
  assert.equal(duplicate.id,first.id);
  assert.equal(first.payload.reason,'manual_recovery');
  assert.deepEqual(first.payload.window,{dateFrom:gaps.date_from,dateTo:gaps.date_to});
  const status=await getFinancialSyncState(ids.user,ids.store);
  assert.equal(status.run_status,'running');
  assert.equal(status.stream_status,'active');
  assert.equal(await inContext(async client=>Number((await client.query(
    `select count(*) from mc.financial_week_coverage where store_id=$1 and credential_generation=3
      and 'manual_recovery'=any(check_reasons)`,[ids.store]
  )).rows[0].count)),gaps.count);
  for(const jobType of ['financial_report_fetch','financial_inventory_refresh']){
    for(const job of await claimJobs({workerId:`credential-status-${jobType}`,jobTypes:[jobType],leaseSeconds:300,limit:100})){
      await completeJob({jobId:job.id,leaseToken:job.lease_token,workerId:`credential-status-${jobType}`,outcome:'completed'});
    }
  }
  await inContext(client=>client.query(`update mc.financial_week_coverage
    set coverage_status='partial',last_error_code='financial_terminal_fixture',next_retry_at=null
    where id=(select id from mc.financial_week_coverage where store_id=$1 and credential_generation=3 order by week_start limit 1)`,[ids.store]));
  const terminal=await getFinancialSyncState(ids.user,ids.store);
  assert.equal(terminal.run_status,'failed');
  assert.equal(terminal.error_code,'financial_terminal_fixture');
});

test('manual refresh recovers every terminal week in the current credential generation',async()=>{
  const terminalWeeks=await inContext(async client=>(await client.query(`select week_start::text,week_end::text
    from mc.financial_week_coverage where store_id=$1 and credential_generation=3
    order by week_start limit 2`,[ids.store])).rows);
  assert.equal(terminalWeeks.length,2);
  const staleWeek=await inContext(async client=>{
    await client.query(`update mc.financial_week_coverage
      set coverage_status='unavailable',last_error_code='stale_generation_fixture',next_retry_at=null
      where id=(select id from mc.financial_week_coverage where store_id=$1 and credential_generation=1 order by week_start limit 1)`,[ids.store]);
    await client.query(`update mc.financial_week_coverage
      set coverage_status='unavailable',last_error_code='financial_inventory_not_confirmed',next_retry_at=null
      where store_id=$1 and credential_generation=3 and week_start=any($2::date[])`,[ids.store,terminalWeeks.map(week=>week.week_start)]);
    return (await client.query(`select id from mc.financial_week_coverage
      where store_id=$1 and credential_generation=1 order by week_start limit 1`,[ids.store])).rows[0];
  });
  const recovery=await requestFinancialInventoryRefresh(ids.user,ids.store,{now:new Date('2025-10-13T09:00:00Z')});
  const duplicate=await requestFinancialInventoryRefresh(ids.user,ids.store,{now:new Date('2025-10-13T09:01:00Z')});
  assert.equal(duplicate.id,recovery.id);
  assert.equal(recovery.payload.reason,'manual_recovery');
  assert.equal(recovery.payload.recoveryWeeks,2);
  assert.deepEqual(recovery.payload.window,{dateFrom:terminalWeeks[0].week_start,dateTo:terminalWeeks[1].week_end});
  const recovered=await inContext(async client=>(await client.query(`select coverage_status,last_error_code,next_retry_at
    from mc.financial_week_coverage where store_id=$1 and credential_generation=3 and week_start=any($2::date[])
    order by week_start`,[ids.store,terminalWeeks.map(week=>week.week_start)])).rows);
  assert.deepEqual(recovered.map(row=>row.coverage_status),['pending','pending']);
  assert.ok(recovered.every(row=>row.last_error_code===null&&row.next_retry_at===null));
  assert.deepEqual(await inContext(async client=>(await client.query(`select coverage_status,last_error_code
    from mc.financial_week_coverage where id=$1`,[staleWeek.id])).rows[0]),
    {coverage_status:'unavailable',last_error_code:'stale_generation_fixture'});
  const claimed=(await claimJobs({workerId:'manual-recovery-cleanup',jobTypes:['financial_inventory_refresh'],leaseSeconds:300,limit:100})).find(job=>job.id===recovery.id);
  assert.ok(claimed);
  await completeJob({jobId:claimed.id,leaseToken:claimed.lease_token,workerId:'manual-recovery-cleanup',outcome:'completed'});
  await inContext(client=>client.query(`update mc.financial_week_coverage set coverage_status='complete'
    where store_id=$1 and credential_generation=3 and week_start=any($2::date[])`,[ids.store,terminalWeeks.map(week=>week.week_start)]));
});

test('real inventory failures still make exhausted coverage terminal and visibly incomplete',async()=>{
  await inContext(client=>client.query(`insert into mc.financial_week_coverage(
      business_id,store_id,credential_generation,week_start,week_end,check_reasons,coverage_status,
      freshness_due_at,next_retry_at,last_error_code
    ) values($1,$2,3,'2024-01-01','2024-01-07',array['terminal_test'],'retry',now(),now(),'financial_inventory_not_confirmed')
    on conflict(business_id,store_id,credential_generation,week_start) do update
      set coverage_status='retry',next_retry_at=now(),last_error_code='financial_inventory_not_confirmed'`,[ids.business,ids.store]));
  const queued=await enqueueJob(ids.user,{
    storeId:ids.store,jobType:'financial_inventory_refresh',deduplicationKey:`terminal-inventory:${ids.store}`,
    payload:{schemaVersion:1,credentialGeneration:3,window:{dateFrom:'2024-01-01',dateTo:'2024-01-07'}},maxAttempts:1
  });
  const claimed=(await claimJobs({workerId:'terminal-inventory-worker',jobTypes:['financial_inventory_refresh'],leaseSeconds:300,limit:100})).find(job=>job.id===queued.id);
  assert.ok(claimed);
  const failed=await failJob({jobId:claimed.id,leaseToken:claimed.lease_token,workerId:'terminal-inventory-worker',errorCode:'wb_request_failed',retryable:true,retryDelaySeconds:900});
  assert.equal(failed.status,'failed');
  const coverage=await inContext(async client=>(await client.query(`select coverage_status,next_retry_at,last_error_code
    from mc.financial_week_coverage where store_id=$1 and credential_generation=3 and week_start='2024-01-01'`,[ids.store])).rows[0]);
  assert.equal(coverage.coverage_status,'unavailable');
  assert.equal(coverage.next_retry_at,null);
  assert.equal(coverage.last_error_code,'wb_request_failed');
  const state=await getFinancialSyncState(ids.user,ids.store);
  assert.equal(state.run_status,'failed');
  assert.equal(state.error_code,'wb_request_failed');
  assert.ok(Number(state.failed_weeks)>=1);
});

test('expired final inventory lease also makes uncovered weeks terminal',async()=>{
  await inContext(client=>client.query(`insert into mc.financial_week_coverage(
      business_id,store_id,credential_generation,week_start,week_end,check_reasons,coverage_status,
      freshness_due_at,next_retry_at,last_error_code
    ) values($1,$2,3,'2024-01-08','2024-01-14',array['expired_lease_test'],'retry',now(),now(),'financial_inventory_not_confirmed')
    on conflict(business_id,store_id,credential_generation,week_start) do update
      set coverage_status='retry',next_retry_at=now(),last_error_code='financial_inventory_not_confirmed'`,[ids.business,ids.store]));
  const queued=await enqueueJob(ids.user,{
    storeId:ids.store,jobType:'financial_inventory_refresh',deduplicationKey:`expired-terminal-inventory:${ids.store}`,
    payload:{schemaVersion:1,credentialGeneration:3,window:{dateFrom:'2024-01-08',dateTo:'2024-01-14'}},maxAttempts:1
  });
  const claimed=(await claimJobs({workerId:'expired-terminal-worker',jobTypes:['financial_inventory_refresh'],leaseSeconds:300,limit:100})).find(job=>job.id===queued.id);
  assert.ok(claimed);
  await inContext(async client=>{
    await client.query(`update mc.jobs set lease_until=clock_timestamp()-interval '1 second' where id=$1`,[queued.id]);
    await client.query(`update mc.job_dispatch set lease_until=clock_timestamp()-interval '1 second' where job_id=$1`,[queued.id]);
  });
  const reclaimed=await claimJobs({workerId:'expired-terminal-recovery',jobTypes:['financial_inventory_refresh'],leaseSeconds:300,limit:100});
  assert.equal(reclaimed.some(job=>job.id===queued.id),false);
  const result=await inContext(async client=>({
    job:(await client.query(`select status,last_error_code from mc.jobs where id=$1`,[queued.id])).rows[0],
    coverage:(await client.query(`select coverage_status,next_retry_at,last_error_code from mc.financial_week_coverage
      where store_id=$1 and credential_generation=3 and week_start='2024-01-08'`,[ids.store])).rows[0]
  }));
  assert.deepEqual(result.job,{status:'failed',last_error_code:'max_attempts_exhausted'});
  assert.equal(result.coverage.coverage_status,'unavailable');
  assert.equal(result.coverage.next_retry_at,null);
  assert.equal(result.coverage.last_error_code,'max_attempts_exhausted');
});

test('absent reports wait hourly beyond twenty polls without spending real failure attempts',async()=>{
  const queued=await enqueueJob(ids.user,{
    storeId:ids.store,jobType:'financial_inventory_refresh',deduplicationKey:`hourly-wait:${ids.store}`,
    payload:{schemaVersion:1,credentialGeneration:3,window:{dateFrom:'2024-02-05',dateTo:'2024-02-11'}},maxAttempts:20
  });
  await inContext(client=>client.query(`insert into mc.financial_week_coverage(
    business_id,store_id,credential_generation,week_start,week_end,check_reasons,freshness_due_at
  ) values($1,$2,3,'2024-02-05','2024-02-11',array['hourly_wait_test','awaiting_fresh_report'],now())`,[ids.business,ids.store]));
  const workerId='hourly-wait-worker';
  const first=(await claimJobs({workerId,jobTypes:['financial_inventory_refresh'],leaseSeconds:300,limit:100})).find(job=>job.id===queued.id);
  const realFailure=await failJob({jobId:first.id,leaseToken:first.lease_token,workerId,errorCode:'wb_request_failed',retryable:true,retryDelaySeconds:0});
  assert.equal(realFailure.attempt_count,1);
  for(let i=0;i<25;i++){
    const claimed=(await claimJobs({workerId,jobTypes:['financial_inventory_refresh'],leaseSeconds:300,limit:100})).find(job=>job.id===queued.id);
    assert.ok(claimed);
    assert.equal(claimed.attempt_count,2);
    const applied=await inventoryRepository.apply(claimed.id,3,claimed.lease_token,workerId,[]);
    assert.equal(Number(applied.uncovered_weeks),1);
    const before=Date.now();
    await assert.rejects(()=>failJob({jobId:claimed.id,leaseToken:randomUUID(),workerId,errorCode:'financial_inventory_not_confirmed',retryable:true,retryDelaySeconds:0}),/lease/);
    const waited=await failJob({jobId:claimed.id,leaseToken:claimed.lease_token,workerId,errorCode:'financial_inventory_not_confirmed',retryable:true,retryDelaySeconds:0});
    assert.equal(waited.status,'pending');
    assert.equal(waited.attempt_count,1);
    assert.ok(new Date(waited.available_at).getTime()>=before+3599000);
    const state=await inContext(async client=>({
      coverage:(await client.query(`select coverage_status,inventory_confirmed_at,empty_confirmed_by_job_id,next_retry_at
        from mc.financial_week_coverage where store_id=$1 and credential_generation=3 and week_start='2024-02-05'`,[ids.store])).rows[0],
      dispatch:(await client.query(`select status,attempt_count,available_at from mc.job_dispatch where job_id=$1`,[queued.id])).rows[0]
    }));
    assert.equal(state.coverage.coverage_status,'retry');
    assert.equal(state.coverage.inventory_confirmed_at,null);
    assert.equal(state.coverage.empty_confirmed_by_job_id,null);
    assert.ok(new Date(state.coverage.next_retry_at).getTime()>=before+3598000);
    assert.equal(state.dispatch.status,'pending');
    assert.equal(state.dispatch.attempt_count,1);
    assert.equal(new Date(state.dispatch.available_at).getTime(),new Date(waited.available_at).getTime());
    assert.equal((await claimJobs({workerId,jobTypes:['financial_inventory_refresh'],leaseSeconds:300,limit:100})).some(job=>job.id===queued.id),false);
    await inContext(async client=>{
      await client.query(`update mc.jobs set available_at=clock_timestamp()-interval '1 second' where id=$1`,[queued.id]);
      await client.query(`update mc.job_dispatch set available_at=clock_timestamp()-interval '1 second' where job_id=$1`,[queued.id]);
    });
  }
  const claimed=(await claimJobs({workerId,jobTypes:['financial_inventory_refresh'],leaseSeconds:300,limit:100})).find(job=>job.id===queued.id);
  const late=await inventoryRepository.apply(claimed.id,3,claimed.lease_token,workerId,[{
    reportId:'90071992547409933',checksum:'d'.repeat(64),dateFrom:'2024-02-05',dateTo:'2024-02-11',summaryRaw:{sales:0,returns:0}
  }]);
  assert.equal(Number(late.uncovered_weeks),0);
  assert.equal(Number(late.found_reports),1);
  assert.equal(Number(late.enqueued_fetches),1);
  assert.equal(await inContext(async client=>(await client.query(`select coverage_status from mc.financial_week_coverage
    where store_id=$1 and credential_generation=3 and week_start='2024-02-05'`,[ids.store])).rows[0].coverage_status),'fetching');
  await completeJob({jobId:claimed.id,leaseToken:claimed.lease_token,workerId,outcome:'completed'});
  const fetch=(await claimJobs({workerId:'late-zero-fetch-worker',jobTypes:['financial_report_fetch'],leaseSeconds:300,limit:100})).find(job=>job.payload.reportId==='90071992547409933');
  assert.ok(fetch);
  await acceptInventory('90071992547409933');
  await completeJob({jobId:fetch.id,leaseToken:fetch.lease_token,workerId:'late-zero-fetch-worker',outcome:'completed'});
  const persisted=await inContext(async client=>(await client.query(`select fetch_status,summary_raw_data,
    report_version_id is not null and accepted_normalization_id is not null as accepted_evidence
    from mc.financial_week_inventory where store_id=$1 and external_report_id='90071992547409933'`,[ids.store])).rows[0]);
  assert.equal(persisted.fetch_status,'accepted');
  assert.equal(persisted.accepted_evidence,true);
  assert.deepEqual(persisted.summary_raw_data,{sales:0,returns:0});
  const refresh=await enqueueJob(ids.user,{storeId:ids.store,jobType:'financial_inventory_refresh',deduplicationKey:`late-accepted:${ids.store}`,payload:queued.payload,maxAttempts:20});
  const acceptedJob=(await claimJobs({workerId,jobTypes:['financial_inventory_refresh'],leaseSeconds:300,limit:100})).find(job=>job.id===refresh.id);
  const accepted=await inventoryRepository.apply(acceptedJob.id,3,acceptedJob.lease_token,workerId,[{
    reportId:'90071992547409933',checksum:'d'.repeat(64),dateFrom:'2024-02-05',dateTo:'2024-02-11',summaryRaw:{sales:0,returns:0}
  }]);
  assert.equal(Number(accepted.uncovered_weeks),0);
  // An explicit later list refresh rechecks detail freshness even at the same checksum.
  assert.equal(Number(accepted.enqueued_fetches),1);
  assert.equal(await inContext(async client=>(await client.query(`select coverage_status from mc.financial_week_coverage
    where store_id=$1 and credential_generation=3 and week_start='2024-02-05'`,[ids.store])).rows[0].coverage_status),'fetching');
  await completeJob({jobId:acceptedJob.id,leaseToken:acceptedJob.lease_token,workerId,outcome:'completed'});
});

test('hourly waits retain confirmed report evidence while another week is missing',async()=>{
  const workerId='mixed-hourly-worker';
  const queued=await enqueueJob(ids.user,{storeId:ids.store,jobType:'financial_inventory_refresh',
    deduplicationKey:`mixed-hourly:${ids.store}`,maxAttempts:20,
    payload:{schemaVersion:1,credentialGeneration:3,window:{dateFrom:'2024-03-04',dateTo:'2024-03-17'}}});
  await inContext(client=>client.query(`insert into mc.financial_week_coverage(
    business_id,store_id,credential_generation,week_start,week_end,check_reasons,freshness_due_at
  ) select $1,$2,3,day::date,day::date+6,case when day::date='2024-03-11'::date then array['mixed_hourly_test','awaiting_fresh_report'] else array['mixed_hourly_test'] end,now()
    from generate_series('2024-03-04'::date,'2024-03-11'::date,interval '7 days') day`,[ids.business,ids.store]));
  const known={reportId:'90071992547409934',checksum:'e'.repeat(64),dateFrom:'2024-03-04',dateTo:'2024-03-10',summaryRaw:{marker:'confirmed'}};
  const changedKnown={...known,checksum:'a'.repeat(64),summaryRaw:{marker:'changed'}};
  const late={reportId:'90071992547409935',checksum:'f'.repeat(64),dateFrom:'2024-03-11',dateTo:'2024-03-17'};
  const lateForeign={...late,reportId:'90071992547409936',checksum:'b'.repeat(64),reportType:'2'};
  const claim=async()=>(await claimJobs({workerId,jobTypes:['financial_inventory_refresh'],leaseSeconds:300,limit:100})).find(job=>job.id===queued.id);
  const retryNow=async()=>inContext(async client=>{
    await client.query(`update mc.jobs set available_at=clock_timestamp()-interval '1 second' where id=$1`,[queued.id]);
    await client.query(`update mc.job_dispatch set available_at=clock_timestamp()-interval '1 second' where job_id=$1`,[queued.id]);
  });
  const evidence=async()=>inContext(async client=>(await client.query(`select last_seen_at,fetch_status,
    report_version_id,accepted_normalization_id,accepted_inventory_checksum,accepted_at,inventory_checksum,summary_raw_data
    from mc.financial_week_inventory where store_id=$1 and external_report_id=$2`,[ids.store,known.reportId])).rows[0]);
  let claimed=await claim();
  const initial=await inventoryRepository.apply(claimed.id,3,claimed.lease_token,workerId,[known]);
  assert.equal(Number(initial.uncovered_weeks),1);
  assert.equal(Number(initial.enqueued_fetches),1);
  const fetch=(await claimJobs({workerId:'mixed-hourly-fetch',jobTypes:['financial_report_fetch'],leaseSeconds:300,limit:100})).find(job=>job.payload.reportId===known.reportId);
  assert.ok(fetch);
  await acceptInventory(known.reportId);
  await completeJob({jobId:fetch.id,leaseToken:fetch.lease_token,workerId:'mixed-hourly-fetch',outcome:'completed'});
  const confirmed=await evidence();
  assert.equal(confirmed.fetch_status,'accepted');
  for(let i=0;i<2;i++){
    const waiting=await failJob({jobId:claimed.id,leaseToken:claimed.lease_token,workerId,
      errorCode:'financial_inventory_not_confirmed',retryable:true,retryDelaySeconds:3600});
    assert.equal(waiting.payload.awaitingReportsOnly,true);
    await retryNow();
    claimed=await claim();
    const result=await inventoryRepository.apply(claimed.id,3,claimed.lease_token,workerId,i===0?[changedKnown]:[changedKnown,late,lateForeign]);
    assert.equal(Number(result.uncovered_weeks),i===0?1:0);
    assert.equal(Number(result.found_reports),i===0?0:2);
    assert.equal(Number(result.enqueued_fetches),i===0?0:2);
    assert.deepEqual(await evidence(),confirmed);
  }
  const lateRows=await inContext(async client=>(await client.query(`select external_report_id,fetch_status
    from mc.financial_week_inventory where store_id=$1 and external_report_id=any($2::text[])
    order by external_report_id`,[ids.store,[late.reportId,lateForeign.reportId]])).rows);
  assert.deepEqual(lateRows,[{external_report_id:late.reportId,fetch_status:'pending'},{external_report_id:lateForeign.reportId,fetch_status:'pending'}]);
  await completeJob({jobId:claimed.id,leaseToken:claimed.lease_token,workerId,outcome:'completed'});
  const manual=await enqueueJob(ids.user,{storeId:ids.store,jobType:'financial_inventory_refresh',
    deduplicationKey:`mixed-manual:${ids.store}`,maxAttempts:20,
    payload:{schemaVersion:1,credentialGeneration:3,window:{dateFrom:known.dateFrom,dateTo:known.dateTo}}});
  const manualJob=(await claimJobs({workerId,jobTypes:['financial_inventory_refresh'],leaseSeconds:300,limit:100})).find(job=>job.id===manual.id);
  const refreshed=await inventoryRepository.apply(manualJob.id,3,manualJob.lease_token,workerId,[changedKnown]);
  assert.equal(Number(refreshed.found_reports),1);
  assert.equal(Number(refreshed.enqueued_fetches),1);
  const newEvidence=await evidence();
  assert.equal(newEvidence.inventory_checksum,changedKnown.checksum);
  assert.deepEqual(newEvidence.summary_raw_data,changedKnown.summaryRaw);
  assert.equal(newEvidence.fetch_status,'pending');
  await completeJob({jobId:manualJob.id,leaseToken:manualJob.lease_token,workerId,outcome:'completed'});
});

test.after(async()=>{await pool.end();});
