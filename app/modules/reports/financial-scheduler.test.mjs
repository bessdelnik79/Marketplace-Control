import assert from 'node:assert/strict';
import test from 'node:test';
import { createFinancialScheduler, startFinancialScheduler } from './financial-scheduler.mjs';

test('scheduler delegates a frozen instant and bounded batch to PostgreSQL', async () => {
  const calls = [];
  const rows = [{ store_id: 'store-1' }];
  const at = new Date('2026-09-27T21:00:00Z');
  const scheduler = createFinancialScheduler({ pool: { query: async (...args) => (calls.push(args), { rows }) } });
  assert.equal(await scheduler.scheduleDue({ at, limit: 25 }), rows);
  assert.deepEqual(calls, [['select * from mc.schedule_financial_inventory($1,$2)', [at, 25]]]);
  await assert.rejects(() => scheduler.scheduleDue({ limit: 0 }), /between 1 and 500/);
});

test('runtime tick never overlaps and reports failures', async () => {
  let running = 0, maximum = 0, calls = 0;
  const failures = [];
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const stop = startFinancialScheduler({
    intervalMs: 1000,
    scheduleDue: async () => { calls++; running++; maximum = Math.max(maximum, running); await pending; running--; throw new Error('test_failure'); },
    onError: error => failures.push(error.message)
  });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(calls, 1);
  release();
  await new Promise(resolve => setTimeout(resolve, 10));
  stop();
  assert.equal(maximum, 1);
  assert.deepEqual(failures, ['test_failure']);
});
