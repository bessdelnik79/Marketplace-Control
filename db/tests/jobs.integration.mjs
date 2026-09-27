import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';

const integrationUrl = process.env.JOBS_INTEGRATION_DATABASE_URL;
if (!integrationUrl) {
  throw new Error('Set JOBS_INTEGRATION_DATABASE_URL to a disposable PostgreSQL database whose name contains "test".');
}
if (!new URL(integrationUrl).pathname.slice(1).toLowerCase().includes('test')) {
  throw new Error('Refusing to run queue integration tests outside a database whose name contains "test".');
}
process.env.DATABASE_URL = integrationUrl;

const {
  migrate,
  pool,
  enqueueJob,
  claimJobs,
  heartbeatJob,
  completeJob,
  failJob
} = await import('../../app/db.mjs');
const { withOwnedBusinessContext } = await import('../../app/infrastructure/database/client.mjs');

await migrate();
after(async() => pool.end());

await pool.query(`do $$ begin
  if not exists(select 1 from pg_roles where rolname='mc_jobs_integration_definer') then
    create role mc_jobs_integration_definer nologin nosuperuser nocreatedb nocreaterole noinherit;
  end if;
  if not exists(select 1 from pg_roles where rolname='mc_jobs_integration_worker') then
    create role mc_jobs_integration_worker nologin nosuperuser nocreatedb nocreaterole noinherit;
  end if;
end $$`);
await pool.query(`grant usage,create on schema mc to mc_jobs_integration_definer`);
await pool.query(`grant execute on function mc.context_business_id() to mc_jobs_integration_definer`);
await pool.query(`grant select,update on mc.jobs to mc_jobs_integration_definer`);
await pool.query(`grant select,update,delete on mc.job_dispatch to mc_jobs_integration_definer`);
await pool.query(`grant insert on mc.audit_events to mc_jobs_integration_definer`);
for (const signature of [
  'mc.claim_jobs(text,text[],integer,integer)',
  'mc.heartbeat_job(uuid,uuid,text,integer)',
  'mc.complete_job(uuid,uuid,text,text)',
  'mc.fail_job(uuid,uuid,text,text,boolean,integer)'
]) await pool.query(`alter function ${signature} owner to mc_jobs_integration_definer`);
await pool.query(`revoke create on schema mc from mc_jobs_integration_definer`);
await pool.query(`revoke all on function
  mc.claim_jobs(text,text[],integer,integer),
  mc.heartbeat_job(uuid,uuid,text,integer),
  mc.complete_job(uuid,uuid,text,text),
  mc.fail_job(uuid,uuid,text,text,boolean,integer)
from public`);
await pool.query(`grant usage on schema mc to mc_jobs_integration_worker`);
await pool.query(`grant execute on function
  mc.claim_jobs(text,text[],integer,integer),
  mc.heartbeat_job(uuid,uuid,text,integer),
  mc.complete_job(uuid,uuid,text,text),
  mc.fail_job(uuid,uuid,text,text,boolean,integer)
to mc_jobs_integration_worker`);

async function asWorker(sql, params = []) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local role mc_jobs_integration_worker');
    const result = await client.query(sql, params);
    await client.query('commit');
    return result.rows;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

const claimAsWorker = ({ workerId, jobTypes, leaseSeconds = 60, limit = 1 }) => asWorker(
  `select * from mc.claim_jobs($1,$2::text[],$3,$4)`,
  [workerId, jobTypes, leaseSeconds, limit]
);

const ids = {
  user: randomUUID(),
  business: randomUUID(),
  store: randomUUID(),
  foreignUser: randomUUID(),
  foreignBusiness: randomUUID(),
  foreignStore: randomUUID()
};
const type = `queue_integration_${randomUUID()}`;

await pool.query(`insert into mc.users(id,display_name) values($1,'Queue owner'),($2,'Foreign queue owner')`, [ids.user, ids.foreignUser]);
await pool.query(`insert into mc.businesses(id,name) values($1,'Queue integration'),($2,'Foreign queue integration')`, [ids.business, ids.foreignBusiness]);
await pool.query(`insert into mc.memberships(business_id,user_id,role) values($1,$2,'owner'),($3,$4,'owner')`, [ids.business, ids.user, ids.foreignBusiness, ids.foreignUser]);
await withOwnedBusinessContext(ids.user, (client, businessId) => client.query(
  `insert into mc.stores(id,business_id,external_account_id,name,status) values($1,$2,$3,'Queue store','active')`,
  [ids.store, businessId, `queue-${ids.store}`]
));
await withOwnedBusinessContext(ids.foreignUser, (client, businessId) => client.query(
  `insert into mc.stores(id,business_id,external_account_id,name,status) values($1,$2,$3,'Foreign queue store','active')`,
  [ids.foreignStore, businessId, `queue-${ids.foreignStore}`]
));

test('two concurrent claimants receive disjoint durable jobs', async() => {
  const first = await enqueueJob(ids.user, {
    storeId: ids.store, jobType: type, deduplicationKey: `${type}:first`, priority: 10
  });
  const duplicate = await enqueueJob(ids.user, {
    storeId: ids.store, jobType: type, deduplicationKey: `${type}:first`, payload: { ignored: true }, priority: 100
  });
  const second = await enqueueJob(ids.user, {
    storeId: ids.store, jobType: type, deduplicationKey: `${type}:second`, priority: 5
  });
  assert.equal(duplicate.id, first.id);
  assert.deepEqual(duplicate.payload, {});

  const lockClient = await pool.connect();
  await lockClient.query('begin');
  await lockClient.query(`select job_id from mc.job_dispatch where job_id=$1 for update`, [first.id]);
  const claimedB = await claimAsWorker({ workerId: `${type}:b`, jobTypes: [type], leaseSeconds: 60, limit: 1 });
  await lockClient.query('commit');
  lockClient.release();
  const claimedA = await claimAsWorker({ workerId: `${type}:a`, jobTypes: [type], leaseSeconds: 60, limit: 1 });
  assert.equal(claimedA.length, 1);
  assert.equal(claimedB.length, 1);
  assert.notEqual(claimedA[0].id, claimedB[0].id);
  assert.deepEqual(new Set([claimedA[0].id, claimedB[0].id]), new Set([first.id, second.id]));

  const byId = new Map([[claimedA[0].id, { ...claimedA[0], workerId: `${type}:a` }], [claimedB[0].id, { ...claimedB[0], workerId: `${type}:b` }]]);
  const firstLease = byId.get(first.id);
  const secondLease = byId.get(second.id);
  assert.equal(await heartbeatJob({ jobId: first.id, leaseToken: firstLease.lease_token, workerId: firstLease.workerId, leaseSeconds: 120 }), true);
  await assert.rejects(() => heartbeatJob({ jobId: first.id, leaseToken: firstLease.lease_token, workerId: secondLease.workerId }), /not owned|expired/);
  assert.equal(await completeJob({ jobId: first.id, leaseToken: firstLease.lease_token, workerId: firstLease.workerId, outcome: 'superseded' }), true);

  const retry = await failJob({
    jobId: second.id,
    leaseToken: secondLease.lease_token,
    workerId: secondLease.workerId,
    errorCode: 'temporary.test',
    retryable: true,
    retryDelaySeconds: 60
  });
  assert.equal(retry.status, 'pending');
  assert.ok(new Date(retry.available_at) > new Date());
});

test('expired leases are reclaimed with a new token and exhaustion is terminal', async() => {
  const job = await enqueueJob(ids.user, {
    storeId: ids.store,
    jobType: `${type}_recovery`,
    deduplicationKey: `${type}:recovery`,
    maxAttempts: 2
  });
  const [first] = await claimJobs({ workerId: `${type}:old`, jobTypes: [`${type}_recovery`], leaseSeconds: 60, limit: 1 });
  await withOwnedBusinessContext(ids.user, (client, businessId) => client.query(
    `update mc.jobs set lease_until=clock_timestamp()-interval '1 second' where business_id=$1 and id=$2`,
    [businessId, job.id]
  ));
  await pool.query(`update mc.job_dispatch set lease_until=clock_timestamp()-interval '1 second' where job_id=$1`, [job.id]);
  const [recovered] = await claimJobs({ workerId: `${type}:new`, jobTypes: [`${type}_recovery`], leaseSeconds: 60, limit: 1 });
  assert.equal(recovered.id, job.id);
  assert.equal(recovered.attempt_count, 2);
  assert.notEqual(recovered.lease_token, first.lease_token);
  await assert.rejects(() => completeJob({
    jobId: job.id, leaseToken: first.lease_token, workerId: `${type}:old`
  }), /not owned|expired/);

  await withOwnedBusinessContext(ids.user, (client, businessId) => client.query(
    `update mc.jobs set lease_until=clock_timestamp()-interval '1 second' where business_id=$1 and id=$2`,
    [businessId, job.id]
  ));
  await pool.query(`update mc.job_dispatch set lease_until=clock_timestamp()-interval '1 second' where job_id=$1`, [job.id]);
  assert.deepEqual(await claimJobs({ workerId: `${type}:third`, jobTypes: [`${type}_recovery`], leaseSeconds: 60, limit: 1 }), []);
  const terminal = await withOwnedBusinessContext(ids.user, async(client, businessId) => (await client.query(
    `select status,last_error_code,finished_at from mc.jobs where business_id=$1 and id=$2`, [businessId, job.id]
  )).rows[0]);
  assert.equal(terminal.status, 'failed');
  assert.equal(terminal.last_error_code, 'max_attempts_exhausted');
  assert.ok(terminal.finished_at);
});

test('tenant reads remain isolated and internal functions are not public', async() => {
  await enqueueJob(ids.foreignUser, {
    storeId: ids.foreignStore,
    jobType: `${type}_foreign`,
    deduplicationKey: `${type}:foreign`
  });
  const ownRows = await withOwnedBusinessContext(ids.user, async(client, businessId) => (await client.query(
    `select business_id from mc.jobs where business_id in ($1,$2)`, [businessId, ids.foreignBusiness]
  )).rows);
  assert.ok(ownRows.length >= 1);
  assert.ok(ownRows.every(row => row.business_id === ids.business));

  const privileges = (await pool.query(`select p.oid::regprocedure::text signature,
      has_function_privilege('public',p.oid,'execute') executable
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='mc' and p.proname=any($1::text[])`, [
    ['enqueue_job', 'claim_jobs', 'heartbeat_job', 'complete_job', 'fail_job']
  ])).rows;
  assert.equal(privileges.length, 5);
  assert.ok(privileges.every(row => row.executable === false));
  const workerPrivileges = (await pool.query(`select p.proname,
      has_function_privilege('mc_jobs_integration_worker',p.oid,'execute') executable
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='mc' and p.proname=any($1::text[]) order by p.proname`, [
    ['enqueue_job', 'claim_jobs', 'heartbeat_job', 'complete_job', 'fail_job']
  ])).rows;
  assert.equal(workerPrivileges.find(row => row.proname === 'enqueue_job').executable, false);
  assert.ok(workerPrivileges.filter(row => row.proname !== 'enqueue_job').every(row => row.executable === true));
  assert.equal((await pool.query(`select has_function_privilege(
    'mc_jobs_integration_worker','mc.context_business_id()','execute') allowed`
  )).rows[0].allowed, false);
});
