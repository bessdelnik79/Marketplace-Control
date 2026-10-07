import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
const url=process.env.FINANCIAL_HISTORY_UPGRADE_DATABASE_URL;
if(!url||!new URL(url).pathname.includes('test'))throw new Error('A disposable history upgrade test database is required');
process.env.DATABASE_URL=url;
const {pool,saveWbConnection,claimJobs,failJob}=await import('../../app/db.mjs');
for(const name of (await readdir(new URL('../migrations/',import.meta.url))).filter(name=>/^\d+_.+\.sql$/.test(name)&&Number(name.slice(0,3))<79).sort())await pool.query(await readFile(new URL('../migrations/'+name,import.meta.url),'utf8'));
const user=randomUUID(),business=randomUUID();
async function context(action){const c=await pool.connect();try{await c.query('begin');await c.query("select set_config('app.user_id',$1,true),set_config('app.business_id',$2,true)",[user,business]);const result=await action(c);await c.query('commit');return result;}catch(error){await c.query('rollback');throw error;}finally{c.release();}}
await context(async c=>{await c.query("insert into mc.users(id,display_name) values($1,'History owner')",[user]);await c.query("insert into mc.businesses(id,name) values($1,'History upgrade')",[business]);await c.query("insert into mc.memberships(business_id,user_id,role) values($1,$2,'owner')",[business,user]);await c.query("select mc.apply_tariff_period($1,'plus',$2,clock_timestamp())",[business,randomUUID()]);});
async function fixture(){const id=randomUUID();await context(c=>c.query("insert into mc.stores(id,business_id,name,status) values($1,$2,'History store','paused')",[id,business]));await saveWbConnection(user,{storeId:id,sellerId:id,scopes:['finance','analytics','statistics'],fingerprint:'a'.repeat(64),now:new Date('2026-10-07T08:00:00Z'),encrypted:{ciphertext:Buffer.from('abcd','hex'),nonce:Buffer.alloc(12,1),authTag:Buffer.alloc(16,2),keyVersion:1}});return id;}
const successful=await fixture(),incomplete=await fixture();
const worker='history-upgrade';const jobs=await claimJobs({workerId:worker,jobTypes:['financial_inventory_refresh'],leaseSeconds:300,limit:100});
const applied=jobs.find(j=>j.store_id===successful),failed=jobs.find(j=>j.store_id===incomplete);
assert.ok(applied);assert.ok(failed);
const prior=(await pool.query('select * from mc.apply_financial_inventory($1,1,$2,$3,$4::jsonb)',[applied.id,applied.lease_token,worker,'[]'])).rows[0];assert.equal(prior.uncovered_weeks,52);
await failJob({jobId:applied.id,leaseToken:applied.lease_token,workerId:worker,errorCode:'financial_inventory_not_confirmed',retryable:true,retryDelaySeconds:3600});
await failJob({jobId:failed.id,leaseToken:failed.lease_token,workerId:worker,errorCode:'financial_summary_unavailable',retryable:true,retryDelaySeconds:900});
await pool.query(await readFile(new URL('../migrations/079_financial_history_inventory.sql',import.meta.url),'utf8'));
test('upgrade recovers a completed historical list while preserving independent fresh wait',async()=>{
 const result=await context(async c=>({job:(await c.query('select status,last_error_code from mc.jobs where id=$1',[applied.id])).rows[0],coverage:(await c.query("select coverage_status,count(*)::int count from mc.financial_week_coverage where store_id=$1 group by coverage_status order by coverage_status",[successful])).rows,dispatch:(await c.query('select count(*)::int count from mc.job_dispatch where job_id=$1',[applied.id])).rows[0].count,ready:(await c.query('select mc.operational_financial_bootstrap_ready($1) ready',[successful])).rows[0].ready}));
 assert.deepEqual(result.job,{status:'succeeded',last_error_code:null});assert.deepEqual(result.coverage,[{coverage_status:'absent',count:51},{coverage_status:'retry',count:1}]);assert.equal(result.dispatch,0);assert.equal(result.ready,true);
});
test('upgrade never trusts incomplete or failed API listing',async()=>{
 const result=await context(async c=>({job:(await c.query('select status,last_error_code from mc.jobs where id=$1',[failed.id])).rows[0],ready:(await c.query('select mc.operational_financial_bootstrap_ready($1) ready',[incomplete])).rows[0].ready}));assert.deepEqual(result.job,{status:'pending',last_error_code:'financial_summary_unavailable'});assert.equal(result.ready,false);
});
test('upgrade retains FORCE RLS and hides internal reconciliation from ordinary roles',async()=>{
 const role=(await pool.query('select rolsuper,rolbypassrls from pg_roles where rolname=current_user')).rows[0];assert.deepEqual(role,{rolsuper:false,rolbypassrls:false});
 const rls=(await pool.query("select relforcerowsecurity from pg_class where oid='mc.stores'::regclass")).rows[0];assert.equal(rls.relforcerowsecurity,true);
 assert.equal((await pool.query("select has_function_privilege('public','mc.reconcile_financial_history_inventory(uuid,bigint)','execute') allowed")).rows[0].allowed,false);
});
test.after(async()=>pool.end());
