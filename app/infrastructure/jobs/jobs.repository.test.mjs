import assert from 'node:assert/strict';
import test from 'node:test';
import { createJobsRepository } from './jobs.repository.mjs';

const storeId = '11111111-1111-4111-8111-111111111111';
const jobId = '22222222-2222-4222-8222-222222222222';
const leaseToken = '33333333-3333-4333-8333-333333333333';

function setup({ rows = [] } = {}) {
  const calls = [];
  const query = async(sql, params) => {
    calls.push({ sql, params });
    return { rows };
  };
  const repository = createJobsRepository({
    pool: { query },
    withOwnedBusinessContext: async(userId, action) => {
      calls.push({ contextUserId: userId });
      return action({ query }, 'unused-business-id');
    }
  });
  return { repository, calls };
}

test('enqueue uses tenant context and passes a JSON payload to the durable function', async() => {
  const job = { id: jobId, status: 'pending' };
  const { repository, calls } = setup({ rows: [job] });
  const result = await repository.enqueueJob('user-1', {
    storeId,
    jobType: 'financial_report_fetch',
    deduplicationKey: 'store:week:2026-09-21',
    payload: { periodStart: '2026-09-21' },
    priority: 10
  });

  assert.equal(result, job);
  assert.equal(calls[0].contextUserId, 'user-1');
  assert.match(calls[1].sql, /mc\.enqueue_job/);
  assert.deepEqual(JSON.parse(calls[1].params[3]), { periodStart: '2026-09-21' });
  assert.deepEqual(calls[1].params.slice(0, 3), [storeId, 'financial_report_fetch', 'store:week:2026-09-21']);
});

test('claim is restricted to explicit job types and bounded lease parameters', async() => {
  const jobs = [{ id: jobId, lease_token: leaseToken }];
  const { repository, calls } = setup({ rows: jobs });
  assert.equal(await repository.claimJobs({
    workerId: 'worker-a',
    jobTypes: ['financial_report_fetch', 'financial_report_fetch'],
    leaseSeconds: 90,
    limit: 5
  }), jobs);
  assert.match(calls[0].sql, /mc\.claim_jobs/);
  assert.deepEqual(calls[0].params, ['worker-a', ['financial_report_fetch'], 90, 5]);
  await assert.rejects(() => repository.claimJobs({ workerId: 'worker-a', jobTypes: [] }), /jobTypes/);
  await assert.rejects(() => repository.claimJobs({ workerId: 'worker-a', jobTypes: ['x'], limit: 101 }), /limit/);
});

test('lease mutations require UUID token and expose accepted state', async() => {
  const { repository, calls } = setup({ rows: [{ accepted: true }] });
  assert.equal(await repository.heartbeatJob({ jobId, leaseToken, workerId: 'worker-a', leaseSeconds: 30 }), true);
  assert.equal(await repository.completeJob({ jobId, leaseToken, workerId: 'worker-a', outcome: 'superseded' }), true);
  assert.match(calls[0].sql, /heartbeat_job/);
  assert.match(calls[1].sql, /complete_job/);
  await assert.rejects(() => repository.completeJob({ jobId, leaseToken, workerId: 'worker-a', outcome: 'ignored' }), /outcome/);
  await assert.rejects(() => repository.heartbeatJob({ jobId, leaseToken: 'not-a-token', workerId: 'worker-a' }), /leaseToken/);
});

test('failure passes only a safe error code and explicit retry decision', async() => {
  const state = { status: 'pending', available_at: '2026-09-28T00:01:00.000Z' };
  const { repository, calls } = setup({ rows: [state] });
  assert.equal(await repository.failJob({
    jobId,
    leaseToken,
    workerId: 'worker-a',
    errorCode: 'wb.rate_limited',
    retryable: true,
    retryDelaySeconds: 120
  }), state);
  assert.deepEqual(calls[0].params, [jobId, leaseToken, 'worker-a', 'wb.rate_limited', true, 120]);
  await assert.rejects(() => repository.failJob({
    jobId,
    leaseToken,
    workerId: 'worker-a',
    errorCode: 'raw exception with customer data'
  }), /errorCode/);
});

test('repository rejects invalid enqueue values before querying PostgreSQL', async() => {
  const { repository, calls } = setup();
  await assert.rejects(() => repository.enqueueJob('user-1', {
    storeId: 'not-a-uuid', jobType: 'sync', deduplicationKey: 'key'
  }), /storeId/);
  await assert.rejects(() => repository.enqueueJob('user-1', {
    storeId, jobType: '', deduplicationKey: 'key'
  }), /jobType/);
  await assert.rejects(() => repository.enqueueJob('user-1', {
    storeId, jobType: 'sync', deduplicationKey: 'key', maxAttempts: 0
  }), /maxAttempts/);
  assert.equal(calls.length, 0);
});
