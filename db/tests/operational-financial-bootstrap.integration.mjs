import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
const url=process.env.OPERATIONAL_BOOTSTRAP_INTEGRATION_DATABASE_URL;
if(!url||!new URL(url).pathname.toLowerCase().includes('test'))throw new Error('A disposable bootstrap test database is required');
process.env.DATABASE_URL=url;
const {migrate,pool,saveWbConnection,claimJobs,completeJob}=await import('../../app/db.mjs');
const {beginOperationalSync,getOperationalOverviewData}=await import('../../app/modules/operational/operational.repository.mjs');
await migrate();
const user=randomUUID(),business=randomUUID();
async function context(action){const c=await pool.connect();try{await c.query('begin');await c.query("select set_config('app.user_id',$1,true),set_config('app.business_id',$2,true)",[user,business]);const result=await action(c);await c.query('commit');return result;}catch(error){await c.query('rollback');throw error;}finally{c.release();}}
await context(async c=>{
 await c.query("insert into mc.users(id,display_name) values($1,'Bootstrap owner')",[user]);
 await c.query("insert into mc.businesses(id,name) values($1,'Bootstrap integration')",[business]);
 await c.query("insert into mc.memberships(business_id,user_id,role) values($1,$2,'owner')",[business,user]);
 await c.query("update mc.subscriptions set plan_version_id=(select v.id from mc.billing_plan_versions v join mc.billing_plans p on p.id=v.plan_id where p.code='plus' order by v.version_no desc limit 1),period_end=now()+interval '1 month' where business_id=$1",[business]);
});
const at=new Date('2026-09-29T12:00:00Z');
async function store(){const id=randomUUID();await context(c=>c.query("insert into mc.stores(id,business_id,name,status) values($1,$2,'New store','paused')",[id,business]));return id;}
const credential=(id,fingerprint='a'.repeat(64))=>({storeId:id,sellerId:id,scopes:['finance','analytics','statistics'],fingerprint,now:at,encrypted:{ciphertext:Buffer.from('abcd','hex'),nonce:Buffer.alloc(12,1),authTag:Buffer.alloc(16,2),keyVersion:1}});
const ready=id=>context(async c=>(await c.query('select mc.operational_financial_bootstrap_ready($1) ready',[id])).rows[0].ready);
async function confirmEmpty(job,worker){await pool.query('select * from mc.apply_financial_inventory($1,$2,$3,$4,$5::jsonb)',[job.id,Number(job.payload.credentialGeneration),job.lease_token,worker,'[]']);await completeJob({jobId:job.id,leaseToken:job.lease_token,workerId:worker,outcome:'completed'});}
test('new store waits for complete financial history; inventory success alone and force do not bypass',async()=>{
 const id=await store();await saveWbConnection(user,credential(id));
 assert.equal(await ready(id),false);
 assert.equal((await beginOperationalSync(user,id,{force:true,dateFrom:'2026-09-21',dateTo:'2026-09-27'})).reason,'waiting_financial');
 const data=await getOperationalOverviewData(user,id,{now:at});assert.equal(data.updateStatus.factory.status,'waiting_financial');
 const worker='bootstrap-empty';const job=(await claimJobs({workerId:worker,jobTypes:['financial_inventory_refresh'],leaseSeconds:300,limit:100})).find(j=>j.store_id===id);assert.ok(job);
 await confirmEmpty(job,worker);
 await context(c=>c.query("update mc.financial_week_coverage set coverage_status='pending' where store_id=$1 and week_start=(select min(week_start) from mc.financial_week_coverage where store_id=$1)",[id]));
 assert.equal(await ready(id),false);
 await context(c=>c.query("update mc.financial_week_coverage set coverage_status='empty' where store_id=$1",[id]));
 assert.equal(await ready(id),true);
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
test.after(async()=>pool.end());
