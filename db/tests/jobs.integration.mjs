import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import pg from 'pg';

const integrationUrl = process.env.JOBS_INTEGRATION_DATABASE_URL;
if (!integrationUrl) {
  throw new Error('Set JOBS_INTEGRATION_DATABASE_URL to a disposable PostgreSQL database whose name contains "test".');
}
const parsedIntegrationUrl = new URL(integrationUrl);
const integrationDatabase = parsedIntegrationUrl.pathname.slice(1);
if (!/(^|_)test($|_)/.test(integrationDatabase.toLowerCase())) {
  throw new Error('Refusing to run queue integration tests outside a database whose name contains "test".');
}

const quoteIdentifier = (value) => `"${value.replaceAll('"', '""')}"`;
const roleSuffix = randomUUID().replaceAll('-', '').slice(0, 12);
const roles = {
  app: `mc_jobs_app_${roleSuffix}`,
  definer: `mc_jobs_def_${roleSuffix}`,
  worker: `mc_jobs_worker_${roleSuffix}`
};
const roleIdentifiers = Object.fromEntries(
  Object.entries(roles).map(([key, value]) => [key, quoteIdentifier(value)])
);
const bootstrapPool = new pg.Pool({ connectionString: integrationUrl, max: 1 });
const bootstrapState = (await bootstrapPool.query(`select current_database() database_name,session_user,
    r.rolsuper
  from pg_roles r where r.rolname=session_user`)).rows[0];
if (bootstrapState.database_name !== integrationDatabase) {
  await bootstrapPool.end();
  throw new Error('Bootstrap connection must target the same disposable test database.');
}
if (!bootstrapState.rolsuper) {
  await bootstrapPool.end();
  throw new Error('Queue integration bootstrap role must be a superuser of the disposable test cluster.');
}
if ((await bootstrapPool.query(`select exists(
  select 1 from pg_namespace where nspname='mc'
) occupied`)).rows[0].occupied) {
  await bootstrapPool.end();
  throw new Error('Queue integration database must be empty and disposable.');
}
const sessionIdentifier = quoteIdentifier(bootstrapState.session_user);
await bootstrapPool.query('begin');
try {
  await bootstrapPool.query(`create role ${roleIdentifiers.app} nologin nosuperuser nobypassrls nocreatedb nocreaterole noinherit`);
  await bootstrapPool.query(`create role ${roleIdentifiers.definer} nologin nosuperuser nobypassrls nocreatedb nocreaterole noinherit`);
  await bootstrapPool.query(`create role ${roleIdentifiers.worker} nologin nosuperuser nobypassrls nocreatedb nocreaterole noinherit`);
  await bootstrapPool.query(`grant create on database ${quoteIdentifier(integrationDatabase)} to ${roleIdentifiers.app}`);
  await bootstrapPool.query(`grant ${roleIdentifiers.definer},${roleIdentifiers.worker} to ${roleIdentifiers.app}`);
  await bootstrapPool.query(`grant ${roleIdentifiers.app} to ${sessionIdentifier}`);
  await bootstrapPool.query('commit');
} catch (error) {
  await bootstrapPool.query('rollback');
  throw error;
} finally {
  await bootstrapPool.end();
}

const runtimeUrl = new URL(integrationUrl);
const existingOptions = runtimeUrl.searchParams.get('options');
runtimeUrl.searchParams.set('options', [existingOptions, `-c role=${roles.app}`].filter(Boolean).join(' '));
process.env.DATABASE_URL = runtimeUrl.toString();

let cleaned = false;
async function cleanupIntegrationRoles() {
  if (cleaned) return;
  const cleanupPool = new pg.Pool({ connectionString: integrationUrl, max: 1 });
  try {
    await cleanupPool.query('begin');
    await cleanupPool.query(`drop owned by ${roleIdentifiers.worker},${roleIdentifiers.definer},${roleIdentifiers.app} cascade`);
    await cleanupPool.query(`revoke ${roleIdentifiers.definer},${roleIdentifiers.worker} from ${roleIdentifiers.app}`);
    await cleanupPool.query(`revoke ${roleIdentifiers.app} from ${sessionIdentifier}`);
    await cleanupPool.query(`drop role ${roleIdentifiers.worker},${roleIdentifiers.definer},${roleIdentifiers.app}`);
    await cleanupPool.query('commit');
    cleaned = true;
  } catch (error) {
    await cleanupPool.query('rollback');
    throw error;
  } finally {
    await cleanupPool.end();
  }
}

let migrate;
let pool;
let enqueueJob;
let withOwnedBusinessContext;
async function closePoolAndCleanup() {
  try {
    if (pool) await pool.end();
  } finally {
    await cleanupIntegrationRoles();
  }
}
try {
  ({ migrate, pool, enqueueJob } = await import('../../app/db.mjs'));
  ({ withOwnedBusinessContext } = await import('../../app/infrastructure/database/client.mjs'));
} catch (error) {
  await closePoolAndCleanup();
  throw error;
}

try {
  await migrate();
  const runtimeRole = (await pool.query(`select current_user,
    r.rolsuper,r.rolbypassrls,r.rolcreaterole,r.rolcreatedb
    from pg_roles r where r.rolname=current_user`)).rows[0];
  assert.deepEqual(runtimeRole, {
    current_user: roles.app,
    rolsuper: false,
    rolbypassrls: false,
    rolcreaterole: false,
    rolcreatedb: false
  });

  await pool.query(`grant usage,create on schema mc to ${roleIdentifiers.definer}`);
  await pool.query(`grant execute on function mc.context_business_id() to ${roleIdentifiers.definer}`);
  await pool.query(`grant select,update on mc.jobs to ${roleIdentifiers.definer}`);
  await pool.query(`grant select,update,delete on mc.job_dispatch to ${roleIdentifiers.definer}`);
  await pool.query(`grant insert on mc.audit_events to ${roleIdentifiers.definer}`);
  await pool.query(`revoke all on function
    mc.claim_jobs(text,text[],integer,integer),
    mc.heartbeat_job(uuid,uuid,text,integer),
    mc.complete_job(uuid,uuid,text,text),
    mc.fail_job(uuid,uuid,text,text,boolean,integer)
  from public`);
  await pool.query(`grant usage on schema mc to ${roleIdentifiers.worker}`);
  await pool.query(`grant execute on function
    mc.claim_jobs(text,text[],integer,integer),
    mc.heartbeat_job(uuid,uuid,text,integer),
    mc.complete_job(uuid,uuid,text,text),
    mc.fail_job(uuid,uuid,text,text,boolean,integer)
  to ${roleIdentifiers.worker}`);
  for (const signature of [
    'mc.claim_jobs(text,text[],integer,integer)',
    'mc.heartbeat_job(uuid,uuid,text,integer)',
    'mc.complete_job(uuid,uuid,text,text)',
    'mc.fail_job(uuid,uuid,text,text,boolean,integer)'
  ]) await pool.query(`alter function ${signature} owner to ${roleIdentifiers.definer}`);
  await pool.query(`revoke create on schema mc from ${roleIdentifiers.definer}`);
} catch (error) {
  await closePoolAndCleanup();
  throw error;
}

after(async() => {
  await closePoolAndCleanup();
});

async function asWorker(sql, params = []) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`set local role ${roleIdentifiers.worker}`);
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
const heartbeatAsWorker = ({ jobId, leaseToken, workerId, leaseSeconds = 60 }) => asWorker(
  `select * from mc.heartbeat_job($1,$2,$3,$4)`,
  [jobId, leaseToken, workerId, leaseSeconds]
);
const completeAsWorker = ({ jobId, leaseToken, workerId, outcome = 'completed' }) => asWorker(
  `select * from mc.complete_job($1,$2,$3,$4)`,
  [jobId, leaseToken, workerId, outcome]
);
const failAsWorker = ({ jobId, leaseToken, workerId, errorCode, retryable, retryDelaySeconds }) => asWorker(
  `select * from mc.fail_job($1,$2,$3,$4,$5,$6)`,
  [jobId, leaseToken, workerId, errorCode, retryable, retryDelaySeconds]
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

try {
  const seedPool = new pg.Pool({ connectionString: integrationUrl, max: 1 });
  try {
    await seedPool.query(`insert into mc.users(id,display_name) values($1,'Queue owner'),($2,'Foreign queue owner')`, [ids.user, ids.foreignUser]);
    await seedPool.query(`insert into mc.businesses(id,name) values($1,'Queue integration'),($2,'Foreign queue integration')`, [ids.business, ids.foreignBusiness]);
    await seedPool.query(`insert into mc.memberships(business_id,user_id,role) values($1,$2,'owner'),($3,$4,'owner')`, [ids.business, ids.user, ids.foreignBusiness, ids.foreignUser]);
  } finally {
    await seedPool.end();
  }
  await withOwnedBusinessContext(ids.user, (client, businessId) => client.query(
    `insert into mc.stores(id,business_id,external_account_id,name,status) values($1,$2,$3,'Queue store','active')`,
    [ids.store, businessId, `queue-${ids.store}`]
  ));
  await withOwnedBusinessContext(ids.foreignUser, (client, businessId) => client.query(
    `insert into mc.stores(id,business_id,external_account_id,name,status) values($1,$2,$3,'Foreign queue store','active')`,
    [ids.foreignStore, businessId, `queue-${ids.foreignStore}`]
  ));
} catch (error) {
  await closePoolAndCleanup();
  throw error;
}

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
  let claimedB;
  try {
    await lockClient.query('begin');
    await lockClient.query(`select job_id from mc.job_dispatch where job_id=$1 for update`, [first.id]);
    claimedB = await claimAsWorker({ workerId: `${type}:b`, jobTypes: [type], leaseSeconds: 60, limit: 1 });
    await lockClient.query('commit');
  } catch (error) {
    await lockClient.query('rollback');
    throw error;
  } finally {
    lockClient.release();
  }
  const claimedA = await claimAsWorker({ workerId: `${type}:a`, jobTypes: [type], leaseSeconds: 60, limit: 1 });
  assert.equal(claimedA.length, 1);
  assert.equal(claimedB.length, 1);
  assert.notEqual(claimedA[0].id, claimedB[0].id);
  assert.deepEqual(new Set([claimedA[0].id, claimedB[0].id]), new Set([first.id, second.id]));

  const byId = new Map([[claimedA[0].id, { ...claimedA[0], workerId: `${type}:a` }], [claimedB[0].id, { ...claimedB[0], workerId: `${type}:b` }]]);
  const firstLease = byId.get(first.id);
  const secondLease = byId.get(second.id);
  assert.equal((await heartbeatAsWorker({ jobId: first.id, leaseToken: firstLease.lease_token, workerId: firstLease.workerId, leaseSeconds: 120 }))[0].id, first.id);
  await assert.rejects(() => heartbeatAsWorker({ jobId: first.id, leaseToken: firstLease.lease_token, workerId: secondLease.workerId }), /not owned|expired/);
  assert.equal((await completeAsWorker({ jobId: first.id, leaseToken: firstLease.lease_token, workerId: firstLease.workerId, outcome: 'superseded' }))[0].outcome, 'superseded');

  const [retry] = await failAsWorker({
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
  const [first] = await claimAsWorker({ workerId: `${type}:old`, jobTypes: [`${type}_recovery`], leaseSeconds: 60, limit: 1 });
  await withOwnedBusinessContext(ids.user, (client, businessId) => client.query(
    `update mc.jobs set lease_until=clock_timestamp()-interval '1 second' where business_id=$1 and id=$2`,
    [businessId, job.id]
  ));
  await pool.query(`update mc.job_dispatch set lease_until=clock_timestamp()-interval '1 second' where job_id=$1`, [job.id]);
  const [recovered] = await claimAsWorker({ workerId: `${type}:new`, jobTypes: [`${type}_recovery`], leaseSeconds: 60, limit: 1 });
  assert.equal(recovered.id, job.id);
  assert.equal(recovered.attempt_count, 2);
  assert.notEqual(recovered.lease_token, first.lease_token);
  await assert.rejects(() => completeAsWorker({
    jobId: job.id, leaseToken: first.lease_token, workerId: `${type}:old`
  }), /not owned|expired/);

  await withOwnedBusinessContext(ids.user, (client, businessId) => client.query(
    `update mc.jobs set lease_until=clock_timestamp()-interval '1 second' where business_id=$1 and id=$2`,
    [businessId, job.id]
  ));
  await pool.query(`update mc.job_dispatch set lease_until=clock_timestamp()-interval '1 second' where job_id=$1`, [job.id]);
  assert.deepEqual(await claimAsWorker({ workerId: `${type}:third`, jobTypes: [`${type}_recovery`], leaseSeconds: 60, limit: 1 }), []);
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
      has_function_privilege($1,p.oid,'execute') executable
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='mc' and p.proname=any($2::text[]) order by p.proname`, [
    roles.worker, ['enqueue_job', 'claim_jobs', 'heartbeat_job', 'complete_job', 'fail_job']
  ])).rows;
  assert.equal(workerPrivileges.find(row => row.proname === 'enqueue_job').executable, false);
  assert.ok(workerPrivileges.filter(row => row.proname !== 'enqueue_job').every(row => row.executable === true));
  assert.equal((await pool.query(`select has_function_privilege(
    $1,'mc.context_business_id()','execute') allowed`, [roles.worker]
  )).rows[0].allowed, false);
});
