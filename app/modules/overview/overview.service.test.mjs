import test from 'node:test';
import assert from 'node:assert/strict';
import { getFinancialOverview } from './overview.service.mjs';

function period(start, end, { quality = 'complete', missingReasons = [] } = {}) {
  return {
    period_start: start,
    period_end: end,
    quality,
    missing_reasons: missingReasons,
    source_freshness: new Date(`${end}T23:00:00Z`),
    covered_period: { start, end },
    lines: [
      { result_scope: 'selected_product', accounting_date: start, category_code: 'revenue', amount_signed: '100.0000', quality },
      { result_scope: 'selected_product', accounting_date: end, category_code: 'commission', amount_signed: '-20.0000', quality },
      { result_scope: 'selected_product', accounting_date: end, category_code: 'estimated_usn_tax', amount_signed: '-6.0000', quality }
    ],
    totals: {
      selectedProductsResultBeforeTax: '80.0000',
      availableResultBeforeTax: '80.0000',
      estimatedUsnTax: '6.0000',
      availableResultAfterTax: '74.0000'
    },
    taxReference: { scope: 'selected_products', usable: true, includedInResult: true, estimatedTax: '6.0000' }
  };
}

function pair(overrides = {}) {
  return {
    publication_id: 'publication-1',
    published_at: new Date('2026-09-21T10:00:00Z'),
    method_version: 'financial-result-v5',
    scope: { type: 'selected_products', productIds: ['product-b', 'product-a'] },
    current: period('2026-09-14', '2026-09-20'),
    previous: period('2026-09-07', '2026-09-13'),
    ...overrides
  };
}

test('service reads adjacent weeks atomically and exposes publication provenance and exact scope', async () => {
  let request;
  const overview = await getFinancialOverview('user-1', 'store-1', '2026-09-17', {
    loadPeriodPair: async (...args) => { request = args; return pair(); }
  });
  assert.deepEqual(request, ['user-1', 'store-1', {
    periodStart: '2026-09-14', periodEnd: '2026-09-20',
    previousPeriodStart: '2026-09-07', previousPeriodEnd: '2026-09-13'
  }]);
  assert.equal(overview.status, 'available');
  assert.equal(overview.publicationId, 'publication-1');
  assert.equal(overview.publishedAt, '2026-09-21T10:00:00.000Z');
  assert.equal(overview.sourceFreshness, '2026-09-20T23:00:00.000Z');
  assert.deepEqual(overview.requestedPeriod, { start: '2026-09-14', end: '2026-09-20', timezone: 'Europe/Moscow' });
  assert.deepEqual(overview.coveredPeriod, { start: '2026-09-14', end: '2026-09-20' });
  assert.deepEqual(overview.scope, { type: 'selected_products', productIds: ['product-a', 'product-b'] });
  assert.equal(overview.comparison.comparable, true);
});

test('partial periods never show a percentage without proven comparable coverage', async () => {
  const partial = period('2026-09-14', '2026-09-20', { quality: 'partial', missingReasons: ['cost_missing'] });
  const previous = period('2026-09-07', '2026-09-13', { quality: 'partial', missingReasons: ['cost_missing'] });
  const overview = await getFinancialOverview('user-1', 'store-1', '2026-09-14', {
    loadPeriodPair: async () => pair({ current: partial, previous })
  });
  assert.equal(overview.comparison.comparable, false);
  assert.equal(overview.comparison.changePercent, null);
  assert.equal(overview.comparison.reason, 'incomparable_coverage');
});

test('missing persisted week returns an explicit unavailable model without recalculation', async () => {
  const overview = await getFinancialOverview('user-1', 'store-1', '2026-09-15', {
    loadPeriodPair: async () => pair({ current: null, previous: null })
  });
  assert.equal(overview.status, 'unavailable');
  assert.equal(overview.quality, 'unavailable');
  assert.deepEqual(overview.requestedPeriod, { start: '2026-09-14', end: '2026-09-20', timezone: 'Europe/Moscow' });
  assert.equal(overview.coveredPeriod, null);
  assert.deepEqual(overview.missingReasons, ['published_period_missing']);
  assert.equal(overview.comparison.changePercent, null);
});

test('service rejects invalid date and foreign or missing publication stays absent', async () => {
  await assert.rejects(() => getFinancialOverview('user-1', 'store-1', '2026-02-29', { loadPeriodPair: async () => pair() }), { message: 'overview_invalid_date' });
  assert.equal(await getFinancialOverview('user-1', 'foreign-store', '2026-09-14', { loadPeriodPair: async () => null }), null);
});
