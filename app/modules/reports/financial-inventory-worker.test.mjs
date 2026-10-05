import assert from 'node:assert/strict';
import test from 'node:test';
import { encryptSecret } from '../../infrastructure/security/secrets.mjs';
import { inventoryRows, createFinancialInventoryWorker } from './financial-inventory-worker.mjs';

const token = payload => `x.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.x`;
const encoded = token({ sid: 'seller-1', exp: 2000000000, s: Number((1n << 13n) | (1n << 30n)), acc: 3 });
const job = { id: '11111111-1111-4111-8111-111111111111', lease_token: '22222222-2222-4222-8222-222222222222', payload: { credentialGeneration: 2, window: { dateFrom: '2025-09-22', dateTo: '2026-09-27' } } };

test('inventory rows keep report ids as strings and safe list metadata', () => {
  const rows = inventoryRows(new Map([['9223372036854775808', { checksum: 'a'.repeat(64), rawData: { reportId: 9223372036854775808, dateFrom: '2026-09-21T00:00:00Z', dateTo: '2026-09-27T00:00:00Z', reportType: 1, country: 'Россия' } }]]));
  assert.deepEqual(rows[0], { reportId: '9223372036854775808', checksum: 'a'.repeat(64), dateFrom: '2026-09-21', dateTo: '2026-09-27', reportType: '1', country: 'Россия', summaryRaw: { reportId: 9223372036854775808, dateFrom: '2026-09-21T00:00:00Z', dateTo: '2026-09-27T00:00:00Z', reportType: 1, country: 'Россия' } });
});

test('worker lists inventory then persists it and completes the durable job', async () => {
  const previousKey = process.env.WB_TOKEN_ENCRYPTION_KEY;
  const key = Buffer.alloc(32, 7);
  process.env.WB_TOKEN_ENCRYPTION_KEY = key.toString('base64');
  const calls = [];
  const jobs = {
    claimJobs: async () => [job], heartbeatJob: async () => true,
    completeJob: async value => calls.push(['complete', value]), failJob: async value => calls.push(['fail', value])
  };
  const encrypted = encryptSecret(encoded, key);
  const inventory = {
    getContext: async () => ({ seller_id: 'seller-1', ciphertext: encrypted.ciphertext, nonce: encrypted.nonce, auth_tag: encrypted.authTag }),
    reserveRequestSlot: async () => ({ waitMs: 0 }),
    apply: async (...args) => (calls.push(['apply', ...args]), { uncovered_weeks: 0, superseded: false }),
    applyPeriodFallback: async () => assert.fail('fallback is not expected')
  };
  const worker = createFinancialInventoryWorker({
    jobs, inventory, random: () => 0, wait: async () => {},
    fetchImpl: async () => new Response(JSON.stringify([{ reportId: '9007199254740993', dateFrom: '2026-09-21', dateTo: '2026-09-27', reportType: 1, country: 'Россия' }]))
  });
  try {
    assert.equal(await worker.runOnce(), true);
    assert.equal(calls[0][0], 'apply');
    assert.equal(calls[0][5][0].reportId, '9007199254740993');
    assert.equal(calls[1][0], 'complete');
    assert.equal(calls.some(([type]) => type === 'fail'), false);
  } finally {
    if(previousKey === undefined)delete process.env.WB_TOKEN_ENCRYPTION_KEY;
    else process.env.WB_TOKEN_ENCRYPTION_KEY = previousKey;
  }
});

test('worker completes a generation changed during list loading as superseded', async () => {
  const previousKey = process.env.WB_TOKEN_ENCRYPTION_KEY;
  const key = Buffer.alloc(32, 8);
  process.env.WB_TOKEN_ENCRYPTION_KEY = key.toString('base64');
  const encrypted = encryptSecret(encoded, key), completed = [];
  const jobs = {
    claimJobs: async () => [job], heartbeatJob: async () => true,
    completeJob: async value => completed.push(value), failJob: async () => assert.fail('stale generation must not fail')
  };
  const inventory = {
    getContext: async () => ({ seller_id: 'seller-1', ciphertext: encrypted.ciphertext, nonce: encrypted.nonce, auth_tag: encrypted.authTag }),
    reserveRequestSlot: async () => ({ waitMs: 0 }), apply: async () => ({ superseded: true, uncovered_weeks: 0 }),
    applyPeriodFallback: async () => assert.fail('fallback is not expected')
  };
  try {
    const worker = createFinancialInventoryWorker({ jobs, inventory, wait: async () => {}, random: () => 0, fetchImpl: async () => new Response('[]') });
    await worker.runOnce();
    assert.equal(completed[0].outcome, 'superseded');
  } finally {
    if(previousKey === undefined)delete process.env.WB_TOKEN_ENCRYPTION_KEY;
    else process.env.WB_TOKEN_ENCRYPTION_KEY = previousKey;
  }
});

test('persisted unsupported-country capability skips list API and queues period fallback', async () => {
  const completed = [], calls = [];
  const jobs = {
    claimJobs: async () => [job], heartbeatJob: async () => true, failJob: async () => assert.fail('fallback must not fail'),
    completeJob: async value => completed.push(value)
  };
  const inventory = {
    getContext: async () => ({ list_api: 'unsupported_country' }),
    reserveRequestSlot: async () => assert.fail('list API must not be retried'),
    apply: async () => assert.fail('list inventory must not be applied'),
    applyPeriodFallback: async (...args) => (calls.push(args), { superseded: false, enqueued_fetches: 53 })
  };
  const worker = createFinancialInventoryWorker({ jobs, inventory, fetchImpl: async () => assert.fail('WB list must not be called') });
  await worker.runOnce();
  assert.deepEqual(calls[0].slice(0,3),[job.id,2,job.lease_token]);
  assert.equal(completed[0].outcome,'completed');
});

test('successful list without the expected report schedules an hourly durable retry',async()=>{
  const previousKey=process.env.WB_TOKEN_ENCRYPTION_KEY,key=Buffer.alloc(32,9);
  process.env.WB_TOKEN_ENCRYPTION_KEY=key.toString('base64');
  const encrypted=encryptSecret(encoded,key),failures=[];
  const jobs={claimJobs:async()=>[job],heartbeatJob:async()=>true,
    completeJob:async()=>assert.fail('missing report must remain queued'),failJob:async value=>failures.push(value)};
  const inventory={getContext:async()=>({seller_id:'seller-1',ciphertext:encrypted.ciphertext,nonce:encrypted.nonce,auth_tag:encrypted.authTag}),
    reserveRequestSlot:async()=>({waitMs:0}),apply:async()=>({uncovered_weeks:1,superseded:false}),
    applyPeriodFallback:async()=>assert.fail('fallback is not expected')};
  try{
    const worker=createFinancialInventoryWorker({jobs,inventory,fetchImpl:async()=>new Response('[]')});
    await worker.runOnce();
    assert.equal(failures.length,1);
    assert.equal(failures[0].errorCode,'financial_inventory_not_confirmed');
    assert.equal(failures[0].retryDelaySeconds,3600);
    assert.equal(failures[0].retryable,true);
  }finally{
    if(previousKey===undefined)delete process.env.WB_TOKEN_ENCRYPTION_KEY;
    else process.env.WB_TOKEN_ENCRYPTION_KEY=previousKey;
  }
});
