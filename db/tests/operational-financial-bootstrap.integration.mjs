import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
const url=process.env.OPERATIONAL_BOOTSTRAP_INTEGRATION_DATABASE_URL;
if(!url||!new URL(url).pathname.toLowerCase().includes('test'))throw new Error('A disposable bootstrap test database is required');
process.env.DATABASE_URL=url;
const {migrate,pool,saveWbConnection,claimJobs,completeJob,failJob,enqueueJob}=await import('../../app/db.mjs');
const {beginOperationalSync,getOperationalOverviewData}=await import('../../app/modules/operational/operational.repository.mjs');
await migrate();
const user=randomUUID(),business=randomUUID();
async function context(action){const c=await pool.connect();try{await c.query('begin');await c.query("select set_config('app.user_id',$1,true),set_config('app.business_id',$2,true)",[user,business]);const result=await action(c);await c.query('commit');return result;}catch(error){await c.query('rollback');throw error;}finally{c.release();}}
await context(async c=>{
 await c.query("insert into mc.users(id,display_name) values($1,'Bootstrap owner')",[user]);
 await c.query("insert into mc.businesses(id,name) values($1,'Bootstrap integration')",[business]);
 await c.query("insert into mc.memberships(business_id,user_id,role) values($1,$2,'owner')",[business,user]);
 await c.query("select mc.apply_tariff_period($1,'plus',$2,clock_timestamp())",[business,`bootstrap:${randomUUID()}`]);
});
const at=new Date('2026-09-29T12:00:00Z');
async function store(){const id=randomUUID();await context(async c=>{await c.query("update mc.stores set status='archived' where business_id=$1 and status<>'archived'",[business]);await c.query("insert into mc.stores(id,business_id,name,status) values($1,$2,'New store','paused')",[id,business]);});return id;}
const credential=(id,fingerprint='a'.repeat(64))=>({storeId:id,sellerId:id,scopes:['finance','analytics','statistics'],fingerprint,now:at,encrypted:{ciphertext:Buffer.from('abcd','hex'),nonce:Buffer.alloc(12,1),authTag:Buffer.alloc(16,2),keyVersion:1}});
const ready=id=>context(async c=>(await c.query('select mc.operational_financial_bootstrap_ready($1) ready',[id])).rows[0].ready);
async function confirmEmpty(job,worker){await pool.query('select * from mc.apply_financial_inventory($1,$2,$3,$4,$5::jsonb)',[job.id,Number(job.payload.credentialGeneration),job.lease_token,worker,'[]']);await completeJob({jobId:job.id,leaseToken:job.lease_token,workerId:worker,outcome:'completed'});}
test('new store waits for a successful list; absent historical weeks do not block or create zero evidence',async()=>{
 const id=await store();await saveWbConnection(user,credential(id));
 assert.equal(await ready(id),false);
 assert.equal((await beginOperationalSync(user,id,{force:true,dateFrom:'2026-09-21',dateTo:'2026-09-27'})).reason,'waiting_financial');
 const data=await getOperationalOverviewData(user,id,{now:at});assert.equal(data.updateStatus.factory.status,'waiting_financial');
 const worker='bootstrap-empty';const job=(await claimJobs({workerId:worker,jobTypes:['financial_inventory_refresh'],leaseSeconds:300,limit:100})).find(j=>j.store_id===id);assert.ok(job);
 await confirmEmpty(job,worker);
 assert.equal(await ready(id),true);
 const state=await context(async c=>({
  absent:(await c.query("select count(*)::int count from mc.financial_week_coverage where store_id=$1 and coverage_status='absent' and inventory_confirmed_at is null and empty_confirmed_by_job_id is null and next_retry_at is null",[id])).rows[0].count,
  fabricated:(await c.query("select count(*)::int count from mc.financial_input_events where store_id=$1 and event_type='empty_week_confirmed'",[id])).rows[0].count
 }));assert.ok(state.absent>=51);assert.equal(state.fabricated,0);
 assert.equal((await beginOperationalSync(user,id,{force:true,dateFrom:'2026-09-21',dateTo:'2026-09-27'})).reason,'selection_required');
 // A Monday refresh and a later token rotation do not repeat initial bootstrap.
 await context(c=>c.query("update mc.financial_week_coverage set coverage_status='pending' where store_id=$1",[id]));
 assert.equal(await ready(id),true);await saveWbConnection(user,credential(id,'b'.repeat(64)));assert.equal(await ready(id),true);
});
test('rotation before initial completion waits for the current generation',async()=>{
 const id=await store();await saveWbConnection(user,credential(id));await saveWbConnection(user,credential(id,'b'.repeat(64)));
 const worker='bootstrap-rotation',jobs=await claimJobs({workerId:worker,jobTypes:['financial_inventory_refresh'],leaseSeconds:300,limit:100});
 const old=jobs.find(j=>j.store_id===id&&Number(j.payload.credentialGeneration)===1),current=jobs.find(j=>j.store_id===id&&Number(j.payload.credentialGeneration)===2);assert.ok(old);assert.ok(current);
 const applied=(await pool.query('select * from mc.apply_financial_inventory($1,$2,$3,$4,$5::jsonb)',[old.id,1,old.lease_token,worker,'[]'])).rows[0];assert.equal(applied.superseded,true);
 await completeJob({jobId:old.id,leaseToken:old.lease_token,workerId:worker,outcome:'superseded'});assert.equal(await ready(id),false);
 await confirmEmpty(current,worker);assert.equal(await ready(id),true);
});
test('fresh report waits separately after empty historical list and remains expected as it ages',async()=>{
 const id=await store();await saveWbConnection(user,credential(id));const worker='fresh-independent';
 const initial=(await claimJobs({workerId:worker,jobTypes:['financial_inventory_refresh'],leaseSeconds:300,limit:100})).find(j=>j.store_id===id);assert.ok(initial);
 await confirmEmpty(initial,worker);assert.equal(await ready(id),true);
 const wait=await context(async c=>(await c.query("select id,payload from mc.jobs where store_id=$1 and payload->>'reason'='fresh_report_wait'",[id])).rows[0]);assert.ok(wait);
 assert.deepEqual(wait.payload.window,{dateFrom:'2026-09-21',dateTo:'2026-09-27'});
 await context(async c=>{await c.query("update mc.jobs set available_at=now()-interval '1 second' where id=$1",[wait.id]);await c.query("update mc.job_dispatch set available_at=now()-interval '1 second' where job_id=$1",[wait.id]);});
 const claimed=(await claimJobs({workerId:worker,jobTypes:['financial_inventory_refresh'],leaseSeconds:300,limit:100})).find(j=>j.id===wait.id);assert.ok(claimed);
 const applied=(await pool.query('select * from mc.apply_financial_inventory($1,1,$2,$3,$4::jsonb)',[claimed.id,claimed.lease_token,worker,'[]'])).rows[0];assert.equal(applied.uncovered_weeks,1);
 const pending=await failJob({jobId:claimed.id,leaseToken:claimed.lease_token,workerId:worker,errorCode:'financial_inventory_not_confirmed',retryable:true,retryDelaySeconds:0});assert.equal(pending.status,'pending');assert.equal(pending.attempt_count,0);assert.ok(new Date(pending.available_at)>new Date(Date.now()+3590000));assert.equal(await ready(id),true);
 const historical=(await context(async c=>(await c.query("select week_start::text,week_end::text from mc.financial_week_coverage where store_id=$1 and coverage_status='absent' order by week_start limit 1",[id])).rows[0]));
 const later=await enqueueJob(user,{storeId:id,jobType:'financial_inventory_refresh',deduplicationKey:`later-historical:${id}`,payload:{schemaVersion:1,credentialGeneration:1,reason:'manual_refresh',window:{dateFrom:historical.week_start,dateTo:historical.week_end}}});
 const laterClaim=(await claimJobs({workerId:worker,jobTypes:['financial_inventory_refresh'],leaseSeconds:300,limit:100})).find(j=>j.id===later.id);assert.ok(laterClaim);
 const found=(await pool.query('select * from mc.apply_financial_inventory($1,1,$2,$3,$4::jsonb)',[later.id,laterClaim.lease_token,worker,JSON.stringify([{reportId:'12345',checksum:'c'.repeat(64),dateFrom:historical.week_start,dateTo:historical.week_end}])])).rows[0];assert.equal(found.uncovered_weeks,0);assert.equal(found.enqueued_fetches,1);
 const result=await context(async c=>(await c.query("select coverage_status from mc.financial_week_coverage where store_id=$1 and week_start=$2",[id,historical.week_start])).rows[0]);assert.equal(result.coverage_status,'fetching');
});
test('unsupported list fallback still waits for period fetches and normalization',async()=>{
 const id=await store();await saveWbConnection(user,credential(id));const worker='country-fallback';
 const job=(await claimJobs({workerId:worker,jobTypes:['financial_inventory_refresh'],leaseSeconds:300,limit:100})).find(j=>j.store_id===id&&j.payload.reason==='credential_generation');assert.ok(job);
 const fallback=(await pool.query('select * from mc.apply_financial_period_fallback($1,1,$2,$3)',[job.id,job.lease_token,worker])).rows[0];assert.equal(fallback.superseded,false);
 await completeJob({jobId:job.id,leaseToken:job.lease_token,workerId:worker,outcome:'completed'});assert.equal(await ready(id),false);
 const jobs=await context(async c=>(await c.query("select count(*)::int count from mc.jobs where store_id=$1 and job_type='financial_report_fetch' and status='pending'",[id])).rows[0].count);assert.ok(jobs>=52);
});
test.after(async()=>pool.end());
