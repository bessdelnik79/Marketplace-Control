import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFinancialOverview,
  buildFinancialPeriodOverview,
  calendarWeekForDate,
  compareFinancialPeriods,
  formatScale4Money,
  parseScale4Money,
  previousCalendarWeek,
  previousCalendarPeriod,
  validateCalendarDate,
  validateCalendarPeriod
} from './financial-overview.mjs';

function envelope({
  publicationId = 'publication-1',
  methodVersion = 'financial-v5',
  periodStart = '2026-09-14',
  periodEnd = '2026-09-20',
  quality = 'complete',
  missingReasons = [],
  revenue = '130.0000',
  expenseLine = '-30.0000',
  beforeTax = '100.0000',
  tax = '6.0000',
  afterTax = '94.0000',
  scope = 'selected_products',
  coverage = undefined
} = {}) {
  const lines = [
    { result_scope: 'selected_product', accounting_date: periodStart, category_code: 'revenue', amount_signed: revenue, quality },
    { result_scope: 'selected_product', accounting_date: periodStart, category_code: 'commission', amount_signed: expenseLine, quality },
    ...(tax === null ? [] : [{ result_scope: 'selected_product', accounting_date: periodEnd, category_code: 'estimated_usn_tax', amount_signed: `-${tax}`, quality }])
  ];
  return {
    publication_id: publicationId,
    method_version: methodVersion,
    period_start: periodStart,
    period_end: periodEnd,
    quality,
    missing_reasons: missingReasons,
    scope,
    ...(coverage === undefined ? {} : { coverage }),
    lines,
    totals: {
      selectedProductsResultBeforeTax: beforeTax,
      availableResultBeforeTax: beforeTax,
      estimatedUsnTax: tax,
      availableResultAfterTax: afterTax
    },
    taxReference: {
      scope: 'selected_products',
      usable: tax !== null,
      includedInResult: tax !== null,
      estimatedTax: tax
    }
  };
}

test('calendar dates and Monday-Sunday weeks use UTC calendar arithmetic with timezone as metadata', () => {
  assert.equal(validateCalendarDate('2026-12-31'), '2026-12-31');
  assert.deepEqual(calendarWeekForDate('2027-01-01'), {
    start: '2026-12-28',
    end: '2027-01-03',
    timezone: 'Europe/Moscow'
  });
  assert.deepEqual(calendarWeekForDate('2027-01-01', { timezone: 'Asia/Tokyo' }), {
    start: '2026-12-28',
    end: '2027-01-03',
    timezone: 'Asia/Tokyo'
  });
  assert.deepEqual(previousCalendarWeek({ start: '2026-12-28', end: '2027-01-03', timezone: 'Europe/Moscow' }), {
    start: '2026-12-21',
    end: '2026-12-27',
    timezone: 'Europe/Moscow'
  });
  assert.throws(() => validateCalendarDate('2026-02-29'), { message: 'overview_invalid_date' });
  assert.throws(() => validateCalendarDate('2026-2-09'), { message: 'overview_invalid_date' });
});

test('calendar periods accept 1..366 days and previous period has the same length', () => {
  const period = validateCalendarPeriod({ start: '2026-08-19', end: '2026-09-25', timezone: 'Europe/Moscow' });
  assert.deepEqual(period, { start: '2026-08-19', end: '2026-09-25', timezone: 'Europe/Moscow' });
  assert.deepEqual(previousCalendarPeriod(period), {
    start: '2026-07-12', end: '2026-08-18', timezone: 'Europe/Moscow'
  });
  assert.deepEqual(validateCalendarPeriod({ start: '2026-09-25', end: '2026-09-25' }), {
    start: '2026-09-25', end: '2026-09-25', timezone: 'Europe/Moscow'
  });
  assert.doesNotThrow(() => validateCalendarPeriod({ start: '2024-01-01', end: '2024-12-31' }));
  assert.throws(() => validateCalendarPeriod({ start: '2026-09-26', end: '2026-09-25' }), { message: 'overview_invalid_period' });
  assert.throws(() => validateCalendarPeriod({ start: '2024-01-01', end: '2025-01-01' }), { message: 'overview_invalid_period' });
});

test('scale-4 money stays exact beyond Number safe precision', () => {
  const value = parseScale4Money('9007199254740991.1234') + parseScale4Money('0.0001');
  assert.equal(formatScale4Money(value), '9007199254740991.1235');
  assert.throws(() => parseScale4Money('1.00001'), { message: 'overview_invalid_money' });
});

test('period overview derives revenue, expenses and after-tax display result from persisted evidence', () => {
  const overview = buildFinancialPeriodOverview(envelope());
  assert.deepEqual(overview.totals, {
    revenue: '130.0000',
    expenses: '30.0000',
    tax: '6.0000',
    availableResultBeforeTax: '100.0000',
    availableResultAfterTax: '94.0000'
  });
  assert.deepEqual(overview.displayResult, { amount: '94.0000', basis: 'after_tax' });
});

test('revenue includes revenue_return and ignores store-scope lines in selected product result', () => {
  const raw = envelope({ revenue: '150.0000', expenseLine: '-30.0000' });
  raw.lines.splice(1, 0,
    { result_scope: 'selected_product', accounting_date: '2026-09-15', category_code: 'revenue_return', amount_signed: '-20.0000', quality: 'complete' },
    { result_scope: 'store', accounting_date: '2026-09-15', category_code: 'storage', amount_signed: '-7.0000', quality: 'complete' }
  );
  const overview = buildFinancialPeriodOverview(raw);
  assert.equal(overview.totals.revenue, '130.0000');
  assert.equal(overview.totals.expenses, '30.0000');
});

test('unusable tax is not silently treated as zero and result explicitly stays before tax', () => {
  const raw = envelope({ tax: null, afterTax: null, quality: 'partial', missingReasons: ['tax_setting_missing', 'cost_missing', 'tax_setting_missing'] });
  raw.totals.estimatedUsnTax = '0.0000';
  const overview = buildFinancialPeriodOverview(raw);
  assert.equal(overview.totals.tax, null);
  assert.equal(overview.totals.availableResultAfterTax, null);
  assert.deepEqual(overview.displayResult, { amount: '100.0000', basis: 'before_tax' });
  assert.deepEqual(overview.missingReasons, ['cost_missing', 'tax_setting_missing']);
});

test('a partial aggregate may retain complete evidence lines from covered child periods',()=>{
  const raw=envelope({quality:'partial',missingReasons:['cost_missing']});
  raw.lines.forEach(line=>{line.quality='complete';});
  const overview=buildFinancialPeriodOverview(raw);
  assert.equal(overview.quality,'partial');
  assert.equal(overview.displayResult.amount,'94.0000');
});

test('overview compares adjacent weeks from one publication and uses absolute previous amount for percent', () => {
  const current = envelope();
  const previous = envelope({
    periodStart: '2026-09-07', periodEnd: '2026-09-13',
    revenue: '90.0000', expenseLine: '-10.0000', beforeTax: '80.0000', tax: '4.0000', afterTax: '76.0000'
  });
  const overview = buildFinancialOverview({ current, previous });
  assert.deepEqual(overview.comparison, {
    period: { start: '2026-09-07', end: '2026-09-13', timezone: 'Europe/Moscow' },
    quality: 'complete',
    amount: '76.0000',
    changeAmount: '18.0000',
    changePercent: '23.6842',
    comparable: true,
    reason: null
  });

  const lossCurrent = buildFinancialPeriodOverview(envelope({ revenue: '-100.0000', expenseLine: '-10.0000', beforeTax: '-110.0000', tax: '0.0000', afterTax: '-110.0000' }));
  const lossPrevious = buildFinancialPeriodOverview(envelope({ revenue: '-80.0000', expenseLine: '-20.0000', beforeTax: '-100.0000', tax: '0.0000', afterTax: '-100.0000' }));
  assert.equal(compareFinancialPeriods(lossCurrent, lossPrevious).changePercent, '-10.0000');
});

test('overview compares adjacent arbitrary periods without slicing persisted lines', () => {
  const current = envelope({ periodStart: '2026-08-19', periodEnd: '2026-09-25' });
  const previous = envelope({ periodStart: '2026-07-12', periodEnd: '2026-08-18' });
  const overview = buildFinancialOverview({ current, previous });
  assert.deepEqual(overview.period, { start: '2026-08-19', end: '2026-09-25', timezone: 'Europe/Moscow' });
  assert.deepEqual(overview.comparison.period, { start: '2026-07-12', end: '2026-08-18', timezone: 'Europe/Moscow' });
  assert.equal(overview.comparison.comparable, true);
});

test('comparison has no changes for zero base or incompatible publication, method, scope and coverage', () => {
  const current = buildFinancialPeriodOverview(envelope());
  const zero = buildFinancialPeriodOverview(envelope({ revenue: '0.0000', expenseLine: '0.0000', beforeTax: '0.0000', tax: '0.0000', afterTax: '0.0000' }));
  assert.deepEqual(compareFinancialPeriods(current, zero), {
    period: zero.period, quality: 'complete', amount: '0.0000', changeAmount: '94.0000', changePercent: null, comparable: true, reason: 'previous_zero'
  });

  for (const [change, reason] of [
    [{ publicationId: 'publication-2' }, 'different_publication'],
    [{ methodVersion: 'financial-v6' }, 'different_method_version'],
    [{ scope: 'store' }, 'different_scope']
  ]) {
    const previous = buildFinancialPeriodOverview(envelope(change));
    assert.equal(compareFinancialPeriods(current, previous).reason, reason);
    assert.equal(compareFinancialPeriods(current, previous).changeAmount, null);
  }

  const partialCurrent = buildFinancialPeriodOverview(envelope({ quality: 'partial', missingReasons: ['cost_missing'], coverage: { comparisonKey: 'products:a' } }));
  const partialPrevious = buildFinancialPeriodOverview(envelope({ quality: 'partial', missingReasons: ['cost_missing'], coverage: { comparisonKey: 'products:b' } }));
  assert.equal(compareFinancialPeriods(partialCurrent, partialPrevious).reason, 'incomparable_coverage');
});

test('overview rejects inconsistent persisted totals, tax, line quality, dates and previous period', () => {
  const totalMismatch = envelope();
  totalMismatch.totals.availableResultBeforeTax = '99.0000';
  assert.throws(() => buildFinancialPeriodOverview(totalMismatch), { message: 'overview_total_mismatch' });

  const taxMismatch = envelope();
  taxMismatch.taxReference.estimatedTax = '5.0000';
  assert.throws(() => buildFinancialPeriodOverview(taxMismatch), { message: 'overview_tax_mismatch' });

  const hiddenAfterTax = envelope({ tax: null, afterTax: null, quality: 'partial', missingReasons: ['tax_setting_missing'] });
  hiddenAfterTax.totals.availableResultAfterTax = '100.0000';
  assert.throws(() => buildFinancialPeriodOverview(hiddenAfterTax), { message: 'overview_tax_mismatch' });

  const qualityMismatch = envelope();
  qualityMismatch.lines[0].quality = 'partial';
  assert.throws(() => buildFinancialPeriodOverview(qualityMismatch), { message: 'overview_line_quality_mismatch' });

  const dateMismatch = envelope();
  dateMismatch.lines[0].accounting_date = '2026-09-21';
  assert.throws(() => buildFinancialPeriodOverview(dateMismatch), { message: 'overview_line_period_mismatch' });

  const wrongPrevious = envelope({ periodStart: '2026-08-31', periodEnd: '2026-09-06' });
  assert.throws(() => buildFinancialOverview({ current: envelope(), previous: wrongPrevious }), { message: 'overview_previous_period_mismatch' });
});
