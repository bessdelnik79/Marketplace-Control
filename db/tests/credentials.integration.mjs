import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';

const integrationUrl=process.env.CREDENTIALS_INTEGRATION_DATABASE_URL;
if(!integrationUrl)throw new Error('Set CREDENTIALS_INTEGRATION_DATABASE_URL to a disposable PostgreSQL database whose name contains "test".');
const databaseName=new URL(integrationUrl).pathname.slice(1);
if(!databaseName.toLowerCase().includes('test'))throw new Error('Refusing to run credential integration tests outside a database whose name contains "test".');
process.env.DATABASE_URL=integrationUrl;

const [{migrate,pool,saveWbConnection,enqueueJob,claimJobs,completeJob},{encryptSecret,fingerprintSecret}]=await Promise.all([
  import('../../app/db.mjs'),
  import('../../app/infrastructure/security/secrets.mjs')
]);

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

const save=(storeId,sellerId,token,scopes=['finance'])=>saveWbConnection(ids.user,{
  storeId,sellerId,scopes,encrypted:encryptSecret(token,encryptionKey),fingerprint:fingerprintSecret(token,fingerprintKey),now:at
});

test('new, repeated and changed WB credentials advance generation and enqueue exactly once',async()=>{
  const first=await save(ids.store,'credential-new','wb-token-one');
  assert.deepEqual({changed:first.credentialChanged,generation:first.generation},{changed:true,generation:1});
  assert.match(first.jobId,/^[0-9a-f-]{36}$/i);
  assert.equal(Object.hasOwn(first,'fingerprint'),false);
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
  assert.ok(Number(applied.uncovered_weeks)>0);
  assert.equal(await inContext(async client=>Number((await client.query(
    `select count(*) from mc.jobs where store_id=$1 and job_type='financial_report_fetch'`,[ids.store]
  )).rows[0].count)),1);
  await completeJob({jobId:current.id,leaseToken:current.lease_token,workerId:'credential-integration-worker',outcome:'completed'});
  for(const old of claimed.filter(item=>item.id!==current.id))await completeJob({jobId:old.id,leaseToken:old.lease_token,workerId:'credential-integration-worker',outcome:'superseded'});
  const [fetchJob]=await claimJobs({workerId:'credential-fetch-worker',jobTypes:['financial_report_fetch'],leaseSeconds:300,limit:1});
  await inContext(async client=>{
    const inventoryRow=(await client.query(`select id,inventory_checksum,period_start,period_end,external_report_id
      from mc.financial_week_inventory where store_id=$1`,[ids.store])).rows[0];
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
  await completeJob({jobId:fetchJob.id,leaseToken:fetchJob.lease_token,workerId:'credential-fetch-worker',outcome:'completed'});
  await enqueueJob(ids.user,{storeId:ids.store,jobType:'financial_inventory_refresh',deduplicationKey:`integration-refresh:${ids.store}`,
    payload:{schemaVersion:1,credentialGeneration:3,window:{dateFrom:'2026-09-21',dateTo:'2026-09-27'}},priority:500,maxAttempts:3});
  const [refresh]=await claimJobs({workerId:'credential-refresh-worker',jobTypes:['financial_inventory_refresh'],leaseSeconds:300,limit:1});
  const reapplied=(await pool.query(`select * from mc.apply_financial_inventory($1,$2,$3,$4,$5::jsonb)`,[
    refresh.id,3,refresh.lease_token,'credential-refresh-worker',JSON.stringify(inventory)
  ])).rows[0];
  assert.equal(Number(reapplied.enqueued_fetches),1);
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

test.after(async()=>{await pool.end();});
