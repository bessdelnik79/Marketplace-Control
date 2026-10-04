import test from 'node:test';
import assert from 'node:assert/strict';
import {
  operationalRollingMoscowRange,
  operationalSyncErrorCode,
  runOperationalSync,
  scheduleOperationalSync
} from './operational-sync.mjs';

const silentLogger = { info() {}, warn() {} };
const fixedClock = () => new Date('2026-09-21T20:59:00Z');
const sellerId = 'seller-1';
const analyticsReadOnlyMask = (1n << 2n) | (1n << 30n);
const wbToken = (overrides = {}) => {
  const payload = { sid: sellerId, exp: 2_000_000_000, s: Number(analyticsReadOnlyMask), acc: 1, t: false, ...overrides };
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
};

function products(count) {
  return Array.from({ length: count }, (_, index) => ({ productId: `product-${index + 1}`, nmId: 7_400_000 + index + 1 }));
}

function jobFor(range, count = 1) {
  return {
    started: true,
    business_id: '11111111-1111-4111-8111-111111111111',
    store_id: '22222222-2222-4222-8222-222222222222',
    stream_id: 'stream-1',
    run_id: 'run-1',
    seller_id: sellerId,
    date_from: range.dateFrom,
    date_to: range.dateTo,
    ciphertext: Buffer.from('ciphertext'),
    nonce: Buffer.alloc(12),
    auth_tag: Buffer.alloc(16),
    products: products(count)
  };
}

function ids() {
  const values = [
    '33333333-3333-4333-8333-333333333333',
    '44444444-4444-4444-8444-444444444444'
  ];
  return () => values.shift();
}

test('rolling range follows the Moscow calendar across the UTC day boundary', () => {
  assert.deepEqual(operationalRollingMoscowRange(new Date('2026-09-21T20:59:59Z')), {
    dateFrom: '2026-09-15', dateTo: '2026-09-21'
  });
  assert.deepEqual(operationalRollingMoscowRange(new Date('2026-09-21T21:00:00Z')), {
    dateFrom: '2026-09-16', dateTo: '2026-09-22'
  });
  assert.throws(() => operationalRollingMoscowRange(new Date('invalid')), { message: 'operational_invalid_clock' });
});

test('rolling range preserves calendar arithmetic across year and leap-month boundaries', () => {
  const yearBoundary = new Date('2026-12-31T22:00:00Z');
  assert.deepEqual(operationalRollingMoscowRange(yearBoundary), { dateFrom: '2026-12-26', dateTo: '2027-01-01' });
  assert.equal(yearBoundary.toISOString(), '2026-12-31T22:00:00.000Z');
  assert.deepEqual(operationalRollingMoscowRange(new Date('2028-03-01T12:00:00Z')), { dateFrom: '2028-02-24', dateTo: '2028-03-01' });
});

test('sync batches selected products by 1000, waits for every reserved slot and stores exact raw parts', async () => {
  const calls = { begin: [], reserve: [], waits: [], loads: [], stores: [], progress: [], complete: [], remove: [], fail: [] };
  const result = await runOperationalSync('user-1', 'store-1', {
    force: true,
    clock: fixedClock,
    sourceRoot: 'synthetic-root',
    masterKey: Buffer.alloc(32, 4),
    waitImpl: async ms => calls.waits.push(ms),
    logger: silentLogger,
    dependencies: {
      begin: async (_userId, _storeId, options) => { calls.begin.push(options); return jobFor(options, 1005); },
      reserve: async (...args) => { calls.reserve.push(args); return { waitMs: calls.reserve.length === 1 ? 35 : 20 }; },
      decrypt: () => wbToken(),
      load: async (token, options) => {
        calls.loads.push({ token, options });
        await options.beforeRequest();
        const raw = JSON.stringify({ batch: calls.loads.length });
        return {
          raw,
          rawChecksum: String(calls.loads.length).repeat(64),
          rows: options.nmIds.map(nmId => ({ nmId, date: options.dateFrom, currency: 'RUB', orderCount: 1, orderSum: '10.25', buyoutCount: 1, buyoutSum: '9.5' })),
          missing: options.nmIds.map(nmId => ({ nmId, date: options.dateTo }))
        };
      },
      store: async options => {
        calls.stores.push(options);
        return { storageKey: `part-${options.partNumber}`, partNumber: options.partNumber, byteSize: 64, checksum: options.checksum, contentType: 'application/json+gzip+aes-256-gcm' };
      },
      progress: async (...args) => calls.progress.push(args.at(-1)),
      complete: async (...args) => { calls.complete.push(args.at(-1)); return { quality: 'partial', rowCount: 25, missingReasons: ['metric_date_missing'] }; },
      remove: async options => calls.remove.push(options),
      fail: async (...args) => calls.fail.push(args),
      randomUUID: ids()
    }
  });

  assert.deepEqual(calls.begin, [{ force: true, dateFrom: '2026-09-15', dateTo: '2026-09-21' }]);
  assert.deepEqual(calls.loads.map(call => call.options.nmIds.length), [1000, 5]);
  assert.deepEqual(calls.loads.map(call => call.token), [wbToken(), wbToken()]);
  assert.equal(calls.reserve.length, 2);
  assert.deepEqual(calls.waits, [35, 20]);
  assert.deepEqual(calls.stores.map(call => [call.partNumber, call.raw]), [[0, '{"batch":1}'], [1, '{"batch":2}']]);
  assert.deepEqual(calls.progress.map(progress => progress.stage), ['loading', 'loading', 'saving']);
  assert.equal(calls.progress[1].missing, 1005);
  assert.equal(calls.complete[0].objects.length, 2);
  assert.equal(calls.complete[0].metrics.length, 1005);
  assert.equal(calls.remove.length, 0);
  assert.equal(calls.fail.length, 0);
  assert.equal(result.status, 'completed');
});

test('coverage gaps are passed as absence of rows, never synthesized as zero metrics', async () => {
  let completed;
  const result = await runOperationalSync('user-gap', 'store-gap', {
    clock: fixedClock,
    logger: silentLogger,
    dependencies: {
      begin: async (_userId, _storeId, range) => jobFor(range, 2),
      reserve: async () => ({ waitMs: 0 }),
      decrypt: () => wbToken(),
      load: async (_token, options) => {
        await options.beforeRequest();
        return {
          raw: '[]', rawChecksum: 'a'.repeat(64),
          rows: [{ nmId: options.nmIds[0], date: options.dateFrom, currency: 'RUB', orderCount: 0, orderSum: '0', buyoutCount: 0, buyoutSum: '0' }],
          missing: [{ nmId: options.nmIds[1], date: options.dateFrom }]
        };
      },
      store: async options => ({ storageKey: 'part-0', partNumber: 0, byteSize: 64, checksum: options.checksum, contentType: 'application/json+gzip+aes-256-gcm' }),
      progress: async () => {},
      complete: async (_userId, _job, payload) => { completed = payload; return { quality: 'partial', rowCount: 1, missingReasons: ['metric_date_missing'] }; },
      remove: async () => {}, fail: async () => {}, randomUUID: ids()
    }
  });
  assert.equal(result.status, 'completed');
  assert.equal(completed.metrics.length, 1);
  assert.equal(completed.metrics[0].orderCount, 0);
  assert.equal(completed.metrics.some(metric => metric.nmId === 7_400_002), false);
});

test('any pre-publication failure removes all stored parts before marking the run failed', async () => {
  const order = [];
  let storeCalls = 0, completed = false;
  const result = await runOperationalSync('user-cleanup', 'store-cleanup', {
    clock: fixedClock,
    sourceRoot: 'test-root',
    logger: silentLogger,
    dependencies: {
      begin: async (_userId, _storeId, range) => jobFor(range, 1001),
      reserve: async () => ({ waitMs: 0 }), decrypt: () => wbToken(),
      load: async (_token, options) => {
        await options.beforeRequest();
        return { raw: '[]', rawChecksum: 'b'.repeat(64), rows: [], missing: options.nmIds.map(nmId => ({ nmId, date: options.dateFrom })) };
      },
      store: async options => {
        order.push(`store:${options.partNumber}`);
        if (++storeCalls === 2) throw new Error('operational_storage_unavailable');
        return { partNumber: 0 };
      },
      progress: async () => {},
      complete: async () => { completed = true; },
      remove: async () => { order.push('remove'); },
      fail: async (_userId, _job, code) => { order.push(`fail:${code}`); },
      randomUUID: ids()
    }
  });
  assert.deepEqual(order, ['store:0', 'store:1', 'remove', 'fail:operational_storage_unavailable']);
  assert.equal(completed, false);
  assert.deepEqual(result, {
    status: 'failed', range: { dateFrom: '2026-09-15', dateTo: '2026-09-21' }, errorCode: 'operational_storage_unavailable'
  });
});

test('publication failure also removes the complete snapshot directory before fail state', async () => {
  const order = [];
  const result = await runOperationalSync('user-publication', 'store-publication', {
    clock: fixedClock,
    logger: silentLogger,
    dependencies: {
      begin: async (_userId, _storeId, range) => jobFor(range),
      reserve: async () => ({ waitMs: 0 }), decrypt: () => wbToken(),
      load: async (_token, options) => {
        await options.beforeRequest();
        return { raw: '[]', rawChecksum: 'c'.repeat(64), rows: [], missing: [] };
      },
      store: async options => ({ storageKey: 'part-0', partNumber: 0, byteSize: 64, checksum: options.checksum, contentType: 'application/json+gzip+aes-256-gcm' }),
      progress: async () => {},
      complete: async () => { order.push('complete'); throw new Error('operational_sync_superseded'); },
      remove: async () => { order.push('remove'); },
      fail: async (_userId, _job, code) => { order.push(`fail:${code}`); },
      randomUUID: ids()
    }
  });
  assert.deepEqual(order, ['complete', 'remove', 'fail:operational_sync_superseded']);
  assert.equal(result.errorCode, 'operational_sync_superseded');
});

test('rate-limit and unknown errors map to stable fail codes', async () => {
  for (const [sourceMessage, expected, retry] of [
    ['operational_rate_limited', 'operational_rate_limited', 20],
    ['socket included secret detail', 'operational_internal_error', 60]
  ]) {
    let failed;
    const result = await runOperationalSync(`user-${retry}`, `store-${retry}`, {
      clock: fixedClock,
      logger: silentLogger,
      dependencies: {
        begin: async (_userId, _storeId, range) => jobFor(range),
        reserve: async () => ({ waitMs: 0 }), decrypt: () => wbToken(),
        load: async (_token, options) => { await options.beforeRequest(); throw new Error(sourceMessage); },
        store: async () => { throw new Error('must not store'); }, progress: async () => {}, complete: async () => {}, remove: async () => {},
        fail: async (_userId, _job, code, options) => { failed = { code, options }; }, randomUUID: ids()
      }
    });
    assert.equal(result.errorCode, expected);
    assert.deepEqual(failed, { code: expected, options: { retryDelaySeconds: retry } });
  }
  assert.equal(operationalSyncErrorCode(new Error('unexpected raw error')), 'operational_internal_error');
});

test('local token validation maps invalid, expired, unsafe and mismatched tokens to the blocking unauthorized code', async () => {
  const tokenValues = [
    'not-a-jwt',
    wbToken({ exp: 1 }),
    wbToken({ s: Number(1n << 30n) }),
    wbToken({ s: Number(1n << 2n) }),
    wbToken({ sid: 'another-seller' }),
    wbToken({ acc: 2 }),
    wbToken({ t: true })
  ];
  for (const [index, tokenValue] of tokenValues.entries()) {
    let failed, loaded = false;
    const result = await runOperationalSync('token-user', `token-store-${index}`, {
      clock: fixedClock,
      logger: silentLogger,
      dependencies: {
        begin: async (_userId, _storeId, range) => jobFor(range),
        decrypt: () => tokenValue,
        load: async () => { loaded = true; },
        fail: async (_userId, _job, code) => { failed = code; }
      }
    });
    assert.equal(result.errorCode, 'operational_unauthorized');
    assert.equal(failed, 'operational_unauthorized');
    assert.equal(loaded, false);
  }
});

test('scheduler deduplicates an active user and store in process', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const options = {
    clock: fixedClock,
    logger: silentLogger,
    dependencies: { begin: async () => gate }
  };
  assert.equal(scheduleOperationalSync('dedupe-user', 'dedupe-store', options), true);
  assert.equal(scheduleOperationalSync('dedupe-user', 'dedupe-store', options), false);
  release({ started: false, reason: 'not_due' });
  await new Promise(resolve => setImmediate(resolve));
});
