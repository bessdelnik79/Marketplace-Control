import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadWbSalesFunnelHistory,
  normalizeSalesFunnelHistory,
  parseSalesFunnelHistoryJson,
  wbSalesFunnelHistoryEndpoint
} from './wb-sales-funnel.mjs';

const period = { dateFrom: '2026-09-14', dateTo: '2026-09-20' };
const point = (date, overrides = {}) => ({
  date,
  orderCount: 2,
  orderSum: '9007199254740991.1234',
  buyoutCount: 1,
  buyoutSum: '100.50',
  ...overrides
});
const product = (nmId, history, currency = 'RUB') => ({ product: { nmId: String(nmId) }, history, currency });

test('loader sends the documented v3 daily request, reserves it and preserves exact raw sums', async () => {
  const raw = '[{"product":{"nmId":101},"history":[{"date":"2026-09-14","orderCount":2,"orderSum":9007199254740991.1234,"buyoutCount":1,"buyoutSum":100.50}],"currency":"RUB"}]';
  const calls = [], reservations = [];
  const result = await loadWbSalesFunnelHistory('secret-token', {
    nmIds: [101], ...period,
    beforeRequest: request => reservations.push(request),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(raw, { status: 200 });
    }
  });
  assert.equal(calls[0].url, wbSalesFunnelHistoryEndpoint);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer secret-token');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    selectedPeriod: { start: period.dateFrom, end: period.dateTo },
    nmIds: [101], skipDeletedNm: false, aggregationLevel: 'day'
  });
  assert.deepEqual(reservations, [{ endpoint: wbSalesFunnelHistoryEndpoint, nmIds: [101], ...period }]);
  assert.equal(result.rows[0].orderSum, '9007199254740991.1234');
  assert.equal(result.rows[0].buyoutSum, '100.5');
  assert.equal(result.raw, raw);
  assert.match(result.rawChecksum, /^[0-9a-f]{64}$/);
});

test('coverage gaps remain explicit missing keys and are never filled with zero rows', () => {
  const result = normalizeSalesFunnelHistory([
    product(101, [point('2026-09-14')]),
    product(102, [point('2026-09-14', { orderCount: 0, orderSum: '0', buyoutCount: 0, buyoutSum: '0' })])
  ], { nmIds: [101, 102], ...period });
  assert.equal(result.rows.length, 2);
  assert.equal(result.missing.length, 12);
  assert.deepEqual(result.missing.slice(0, 2), [{ nmId: 101, date: '2026-09-15' }, { nmId: 102, date: '2026-09-15' }]);
  assert.equal(result.rows.some(row => row.date === '2026-09-15'), false);
});

test('request validation requires unique safe nmIds and at most seven inclusive days', async () => {
  const never = async () => { throw new Error('must not fetch'); };
  for (const options of [
    { nmIds: [], ...period },
    { nmIds: [1, 1], ...period },
    { nmIds: [Number.MAX_SAFE_INTEGER + 1], ...period },
    { nmIds: Array.from({ length: 21 }, (_, index) => index + 1), ...period },
    { nmIds: [1], dateFrom: '2026-09-14', dateTo: '2026-09-21' }
  ]) await assert.rejects(() => loadWbSalesFunnelHistory('token', { ...options, fetchImpl: never }), /^Error: operational_/);
  const rolling = normalizeSalesFunnelHistory([], { nmIds: [1], dateFrom: '2026-09-15', dateTo: '2026-09-20' });
  assert.equal(rolling.missing.length, 6);
});

test('HTTP and network failures use stable operational errors', async () => {
  for (const [status, code] of [
    [401, 'operational_unauthorized'],
    [403, 'operational_unauthorized'],
    [402, 'operational_payment_required'],
    [429, 'operational_rate_limited'],
    [400, 'operational_invalid_request'],
    [500, 'operational_unavailable'],
    [503, 'operational_unavailable']
  ]) {
    await assert.rejects(() => loadWbSalesFunnelHistory('token', {
      nmIds: [101], ...period, fetchImpl: async () => new Response('{}', { status })
    }), error => error.message === code && error.status === status && error.endpoint === wbSalesFunnelHistoryEndpoint);
  }
  await assert.rejects(() => loadWbSalesFunnelHistory('token', {
    nmIds: [101], ...period, fetchImpl: async () => { throw new Error('socket detail'); }
  }), { message: 'operational_unavailable' });
  await assert.rejects(() => loadWbSalesFunnelHistory('token', {
    nmIds: [101], ...period, fetchImpl: async () => null
  }), { message: 'operational_unavailable' });
});

test('strict response validation rejects plural metrics, duplicates, foreign products and dates', () => {
  const args = { nmIds: [101], ...period };
  assert.throws(() => normalizeSalesFunnelHistory([product(101, [{
    date: '2026-09-14', ordersCount: 1, ordersSumRub: '10', buyoutsCount: 1, buyoutsSumRub: '10'
  }])], args), { message: 'operational_invalid_response' });
  assert.throws(() => normalizeSalesFunnelHistory([product(101, [point('2026-09-14'), point('2026-09-14')])], args), { message: 'operational_duplicate_row' });
  assert.throws(() => normalizeSalesFunnelHistory([product(102, [point('2026-09-14')])], args), { message: 'operational_unexpected_nm_id' });
  assert.throws(() => normalizeSalesFunnelHistory([product(101, [point('2026-09-21')])], args), { message: 'operational_unexpected_date' });
  assert.throws(() => normalizeSalesFunnelHistory([product(101, [point('2026-09-14')], '')], args), { message: 'operational_invalid_currency' });
  assert.throws(() => normalizeSalesFunnelHistory([product(101, [point('2026-09-14', { orderCount: -1 })])], args), { message: 'operational_invalid_response' });
});

test('JSON parser rejects malformed payloads and keeps identifier and sums as strings', () => {
  assert.deepEqual(parseSalesFunnelHistoryJson('[{"product":{"nmId":101},"history":[{"orderSum":10.00,"buyoutSum":9}]}]'), [
    { product: { nmId: '101' }, history: [{ orderSum: '10.00', buyoutSum: '9' }] }
  ]);
  assert.throws(() => parseSalesFunnelHistoryJson('{'), { message: 'operational_invalid_response' });
});
