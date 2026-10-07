import assert from 'node:assert/strict';
import test from 'node:test';
import { createAccountErasureWorker } from './account-erasure.worker.mjs';
import { processAccountErasureCleanup } from './account-erasure.repository.mjs';

test('worker coalesces concurrent runs and can retry after failure', async () => {
  let finish, calls = 0;
  const repository = { processAccountErasureCleanup: async cleanup => {
    calls++;
    await new Promise(resolve => { finish = resolve; });
    return cleanup();
  } };
  let shouldFail = true;
  const worker = createAccountErasureWorker({ repository, cleanup: async () => {
    if (shouldFail) throw new Error('filesystem unavailable');
    return true;
  } });
  const first = worker.runOnce();
  assert.equal(first, worker.runOnce());
  await Promise.resolve();
  finish();
  await assert.rejects(first, /filesystem unavailable/);
  shouldFail = false;
  const retry = worker.runOnce();
  await Promise.resolve(); finish();
  assert.equal(await retry, true);
  assert.equal(calls, 2);
  await worker.stop();
});

test('failed filesystem cleanup retains the durable queue entry and a later run completes it', async () => {
  let queued = true, retries = 0, released = 0;
  const database = { connect: async () => ({
    query: async sql => {
      if (sql.startsWith('select erased_business_id')) return { rows: queued ? [{ erased_business_id: 'business' }] : [] };
      if (sql.startsWith('update mc.account_erasure_cleanup')) retries++;
      if (sql.startsWith('delete from mc.account_erasure_cleanup')) queued = false;
      return { rows: [] };
    },
    release: () => { released++; }
  }) };
  await processAccountErasureCleanup(async () => { throw new Error('disk unavailable'); }, { database });
  assert.equal(queued, true);
  assert.equal(retries, 1);
  await processAccountErasureCleanup(async () => {}, { database });
  assert.equal(queued, false);
  assert.equal(await processAccountErasureCleanup(async () => assert.fail('empty queue'), { database }), false);
  assert.equal(released, 3);
});
