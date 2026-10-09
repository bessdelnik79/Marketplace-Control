import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateBuyout, buyoutBounds } from './sku-buyout.mjs';

const record = (srid, outcome = 'retained', changes = {}) => ({ srid, sku: 'sku-a', orderedAt: '2026-08-01', outcome, outcomeAt: '2026-08-10', ...changes });
const calculate = (records, coverage = { start: '2025-08-31', end: '2026-08-31', complete: true }) => calculateBuyout({ sku: 'sku-a', periodEnd: '2026-08-31', history: { records, coverage } });

test('confirmed outcomes only, duplicates and returned buyout count as one order', () => {
  const result = calculate([record('a'), record('a'), record('b'), record('b', 'returned', { outcomeAt: '2026-08-15' }), record('c', 'refused'), record('p', 'pending'), record('other', 'retained', { sku: 'sku-b' })]);
  assert.ok(Math.abs(result.percent - 100 / 3) < 1e-10);
  assert.equal(result.sampleSize, 3);
  assert.deepEqual(result.counts, { retained: 1, returned: 1, refused: 1 });
  assert.equal(result.smallSample, true);
});

test('latest 100 are sorted by order date, not outcome date', () => {
  const older = record('older', 'refused', { orderedAt: '2026-01-01', outcomeAt: '2026-08-30' });
  const recent = Array.from({ length: 100 }, (_, i) => record(`recent-${i}`));
  const result = calculate([older, ...recent]);
  assert.equal(result.percent, 100);
  assert.equal(result.sampleSize, 100);
  assert.equal(result.sampleStart, '2026-08-01');
});

test('continuous shorter coverage accepts 1, 29, 30, 99 and 100 confirmed orders with limits', () => {
  const coverage = { start: '2026-07-01', end: '2026-08-31', complete: true, observedAt: '2026-09-01T12:00:00Z' };
  const rows = Array.from({ length: 100 }, (_, i) => record(String(i)));
  for (const size of [1, 29, 30, 99, 100]) {
    const result = calculate(rows.slice(0, size), coverage);
    assert.equal(result.status, 'available');
    assert.equal(result.sampleSize, size);
    assert.equal(result.percent, 100);
    assert.equal(result.smallSample, size < 30);
    assert.equal(result.quality, 'partial');
    assert.equal(result.historyLimited, true);
    assert.equal(result.historyStart, coverage.start);
    assert.equal(result.historyEnd, coverage.end);
    assert.equal(result.observedAt, coverage.observedAt);
  }
  assert.equal(calculate(rows, { ...coverage, complete: false }).reason, 'history_incomplete');
});

test('outcomes stop at available coverage end; history before cutoff remains unavailable', () => {
  const coverage = { start: '2026-07-01', end: '2026-08-20', complete: true };
  const result = calculate([record('a'), record('a', 'returned', { outcomeAt: '2026-08-21' }), record('late', 'retained', { outcomeAt: '2026-08-21' })], coverage);
  assert.equal(result.sampleSize, 1);
  assert.equal(result.percent, 100);
  assert.equal(result.historyEnd, '2026-08-20');
  assert.equal(result.quality, 'partial');
  assert.equal(calculate([record('a')], { ...coverage, end: '2026-08-16' }).reason, 'history_incomplete');
});

test('source-limited complete coverage discloses partial quality without suppressing confirmed zero', () => {
  const result = calculate([record('a', 'refused')], { start: '2025-08-01', end: '2026-09-01', complete: true, sourceLimited: true });
  assert.equal(result.percent, 0);
  assert.equal(result.historyStart, '2025-08-31');
  assert.equal(result.historyEnd, '2026-08-31');
  assert.equal(result.quality, 'partial');
  assert.match(result.sourceLimitations[0], /без подтверждённой оплаты/);
  assert.equal(calculate([record('a')]).quality, 'complete');
});

test('calendar year and cutoff include their boundary days, exclude recent orders', () => {
  const result = calculate([
    record('year-boundary', 'retained', { orderedAt: '2025-08-31', outcomeAt: '2025-09-01' }),
    record('too-old', 'refused', { orderedAt: '2025-08-30', outcomeAt: '2025-09-01' }),
    record('cutoff', 'refused', { orderedAt: '2026-08-17T23:59:59+03:00', outcomeAt: '2026-08-31T23:59:59+03:00' }),
    record('too-new', 'refused', { orderedAt: '2026-08-18', outcomeAt: '2026-08-20' })
  ]);
  assert.equal(result.sampleSize, 2);
  assert.equal(result.percent, 50);
  assert.deepEqual(buyoutBounds('2024-02-29'), { start: '2023-02-28', cutoff: '2024-02-15', end: '2024-02-29' });
});

test('future returns do not rewrite historical percentage; future-only outcomes are excluded', () => {
  const result = calculate([record('a'), record('a', 'returned', { outcomeAt: '2026-09-01' }), record('future-only', 'retained', { outcomeAt: '2026-09-01' })]);
  assert.equal(result.sampleSize, 1);
  assert.equal(result.percent, 100);
});

test('identity conflicts, incompatible outcomes and sale after return fail closed', () => {
  assert.equal(calculate([record('a'), record('a', 'retained', { sku: 'sku-b' })]).reason, 'identity_conflict');
  assert.equal(calculate([record('a'), record('a', 'retained', { orderedAt: '2026-08-02' })]).reason, 'identity_conflict');
  assert.equal(calculate([record('a'), record('a', 'refused')]).reason, 'outcome_conflict');
  assert.equal(calculate([record('a'), record('a', 'returned', { outcomeAt: '2026-08-09' })]).reason, 'outcome_conflict');
});

test('unknown, malformed, missing and empty histories never manufacture zero or refusal', () => {
  assert.equal(calculate([record('a', 'unknown')]).reason, 'no_confirmed_orders');
  assert.equal(calculate([record('a', 'unknown'), record('b')]).sampleSize, 1);
  assert.equal(calculate([record('a', 'refused', { orderedAt: '2026-02-30' })]).reason, 'invalid_record');
  assert.equal(calculate([record('a', 'refused', { outcomeAt: '2026-08-10T12:00:00' })]).reason, 'invalid_record');
  assert.equal(calculate([]).reason, 'no_confirmed_orders');
  assert.equal(calculateBuyout({ sku: 'sku-a', periodEnd: '2026-08-31' }).percent, null);
});

test('irrelevant SKU and old-order conflicts do not block target, shared target identity does', () => {
  const result = calculate([
    record('a'),
    record('other', 'retained', { sku: 'sku-b' }),
    record('other', 'refused', { sku: 'sku-c' }),
    record('old', 'retained', { orderedAt: '2024-01-01', outcomeAt: '2024-02-01' }),
    record('old', 'refused', { orderedAt: '2024-01-02', outcomeAt: '2024-02-01' }),
    record('unrelated-invalid', 'retained', { sku: 'sku-b', orderedAt: 'not-a-date' })
  ]);
  assert.equal(result.sampleSize, 1);
  assert.equal(result.percent, 100);
  assert.equal(calculate([record('a'), record('a', 'refused', { orderedAt: '2024-01-01', outcomeAt: '2024-02-01' })]).reason, 'identity_conflict');
});

test('complete confirmed refusals yield a real zero, independent SKU does not contribute', () => {
  const result = calculate([record('a', 'refused'), record('b', 'retained', { sku: 'sku-b' })]);
  assert.equal(result.status, 'available');
  assert.equal(result.percent, 0);
  assert.equal(result.sampleSize, 1);
});

test('cutoff and historical outcomes follow Europe/Moscow midnight, not UTC midnight', () => {
  const result = calculate([
    record('cutoff-last-minute', 'retained', { orderedAt: '2026-08-17T23:59:00+03:00', outcomeAt: '2026-08-31T23:59:00+03:00' }),
    record('cutoff-next-day', 'refused', { orderedAt: '2026-08-18T00:01:00+03:00', outcomeAt: '2026-08-25' }),
    record('historical-last-minute', 'refused', { outcomeAt: '2026-08-31T23:59:00+03:00' }),
    record('historical-next-day', 'refused', { outcomeAt: '2026-09-01T00:01:00+03:00' }),
    record('same-order', 'retained', { orderedAt: '2026-08-01T00:00:00+03:00' }),
    record('same-order')
  ]);
  assert.equal(result.sampleSize, 3);
  assert.equal(result.percent, 2 / 3 * 100);
  assert.equal(result.sampleStart, '2026-08-01');
  assert.equal(result.sampleEnd, '2026-08-17');
});
