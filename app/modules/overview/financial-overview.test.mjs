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
  selectedBeforeTax = beforeTax,
  storeBeforeTax = '0.0000',
  tax = '6.0000',
  afterTax = '94.0000',
  scope = 'selected_products',
  coverage = undefined
} = {}) {
  const lines = [
    { result_scope: 'selected_product', accounting_date: periodStart, category_code: 'revenue', amount_signed: revenue, quality },
    { result_scope: 'selected_product', accounting_date: periodStart, category_code: 'commission', amount_signed: expenseLine, quality },
    ...(storeBeforeTax === '0.0000' ? [] : [{ result_scope: 'store', accounting_date: periodStart, category_code: 'store_expenses', amount_signed: storeBeforeTax, quality }]),
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
      selectedProductsResultBeforeTax: selectedBeforeTax,
      storeLevelResultBeforeTax: storeBeforeTax,
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

test('period overview separates WB expenses and cost of goods from persisted evidence', () => {
  const overview = buildFinancialPeriodOverview(envelope());
  assert.deepEqual(overview.totals, {
    revenue: '130.0000',
    wbExpenses: '30.0000',
    costOfGoods: '0.0000',
    tax: '6.0000',
    availableResultBeforeTax: '100.0000',
    availableResultAfterTax: '94.0000'
  });
  assert.deepEqual(overview.displayResult, { amount: '94.0000', basis: 'after_tax' });
});

test('v8 overview includes confirmed store expenses once in the 07-13 September result',()=>{
  const overview=buildFinancialPeriodOverview(envelope({
    methodVersion:'financial-result-v8',periodStart:'2026-09-07',periodEnd:'2026-09-13',
    revenue:'8442.7900',expenseLine:'-2849.0000',selectedBeforeTax:'5593.7900',storeBeforeTax:'-4669.6100',
    beforeTax:'924.1800',tax:'506.5674',afterTax:'417.6126'
  }));
  assert.deepEqual(overview.totals,{
    revenue:'8442.7900',wbExpenses:'7518.6100',costOfGoods:'0.0000',tax:'506.5674',
    availableResultBeforeTax:'924.1800',availableResultAfterTax:'417.6126'
  });
  assert.deepEqual(overview.displayResult,{amount:'417.6126',basis:'after_tax'});
});

test('current and compatible overviews include result-affecting rows without a product',()=>{
  for(const methodVersion of ['financial-result-v9','financial-result-v11','financial-result-v12','financial-result-v13','financial-result-v14']){
    const overview=buildFinancialPeriodOverview(envelope({
      methodVersion,periodStart:'2026-08-24',periodEnd:'2026-08-30',
      revenue:'3835.0000',expenseLine:'-1221.0000',selectedBeforeTax:'2614.0000',storeBeforeTax:'-4953.6200',
      beforeTax:'-2339.6200',tax:'306.8000',afterTax:'-2646.4200'
    }));
    assert.deepEqual(overview.totals,{
      revenue:'3835.0000',wbExpenses:'6174.6200',costOfGoods:'0.0000',tax:'306.8000',
      availableResultBeforeTax:'-2339.6200',availableResultAfterTax:'-2646.4200'
    });
  }
});

test('legacy v12 publication remains reproducible with loyalty compensation in its persisted result',()=>{
  const raw=envelope({methodVersion:'financial-result-v12',revenue:'100.0000',expenseLine:'-10.0000',selectedBeforeTax:'92.0000',storeBeforeTax:'-0.5000',beforeTax:'91.5000',tax:null,afterTax:null});
  raw.lines=raw.lines.filter(line=>line.category_code!=='store_expenses');
  raw.lines.push(
    {result_scope:'selected_product',accounting_date:'2026-09-15',category_code:'loyalty_compensation',amount_signed:'2.0000',quality:'complete'},
    {result_scope:'store',accounting_date:'2026-09-15',category_code:'loyalty_compensation',amount_signed:'-0.5000',quality:'complete'}
  );
  const overview=buildFinancialPeriodOverview(raw);
  assert.equal(overview.totals.revenue,'100.0000');
  assert.equal(overview.totals.wbExpenses,'8.5000');
  assert.equal(overview.totals.costOfGoods,'0.0000');
  assert.equal(overview.totals.availableResultBeforeTax,'91.5000');
});

test('v9 overview reports store-scoped revenue and returns as revenue instead of negative expenses',()=>{
  const raw=envelope({methodVersion:'financial-result-v9',revenue:'0.0000',expenseLine:'0.0000',selectedBeforeTax:'0.0000',storeBeforeTax:'0.0000',beforeTax:'0.0000',tax:'0.0000',afterTax:'0.0000'});
  raw.lines.splice(1,0,
    {result_scope:'store',accounting_date:'2026-09-15',category_code:'revenue',amount_signed:'100.0000',quality:'complete'},
    {result_scope:'store',accounting_date:'2026-09-15',category_code:'revenue_return',amount_signed:'-20.0000',quality:'complete'}
  );
  raw.totals.storeLevelResultBeforeTax='80.0000';
  raw.totals.availableResultBeforeTax='80.0000';
  raw.totals.availableResultAfterTax='80.0000';
  const overview=buildFinancialPeriodOverview(raw);
  assert.equal(overview.totals.revenue,'80.0000');
  assert.equal(overview.totals.wbExpenses,'0.0000');
  assert.equal(overview.totals.costOfGoods,'0.0000');
});

test('revenue includes revenue_return and ignores store-scope lines in selected product result', () => {
  const raw = envelope({ revenue: '150.0000', expenseLine: '-30.0000' });
  raw.lines.splice(1, 0,
    { result_scope: 'selected_product', accounting_date: '2026-09-15', category_code: 'revenue_return', amount_signed: '-20.0000', quality: 'complete' },
    { result_scope: 'store', accounting_date: '2026-09-15', category_code: 'storage', amount_signed: '-7.0000', quality: 'complete' }
  );
  const overview = buildFinancialPeriodOverview(raw);
  assert.equal(overview.totals.revenue, '130.0000');
  assert.equal(overview.totals.wbExpenses, '30.0000');
  assert.equal(overview.totals.costOfGoods, '0.0000');
});

test('dashboard breakdown preserves the 17-23 August result while moving loyalty compensation out of revenue',()=>{
  const raw=envelope({
    methodVersion:'financial-result-v12',periodStart:'2026-08-17',periodEnd:'2026-08-23',
    revenue:'11069.3200',expenseLine:'-5804.2600',selectedBeforeTax:'2009.0600',storeBeforeTax:'-50.4300',
    beforeTax:'1960.6300',tax:'885.5456',afterTax:'1075.0844'
  });
  raw.lines.splice(2,0,
    {result_scope:'selected_product',accounting_date:'2026-08-19',category_code:'cost_of_goods',amount_signed:'-3256.0000',quality:'complete'},
    {result_scope:'store',accounting_date:'2026-08-19',category_code:'loyalty_compensation',amount_signed:'2.0000',quality:'complete'}
  );
  raw.totals.storeLevelResultBeforeTax='-48.4300';
  const overview=buildFinancialPeriodOverview(raw);
  assert.deepEqual(overview.totals,{
    revenue:'11069.3200',wbExpenses:'5852.6900',costOfGoods:'3256.0000',tax:'885.5456',
    availableResultBeforeTax:'1960.6300',availableResultAfterTax:'1075.0844'
  });
  assert.deepEqual(overview.displayResult,{amount:'1075.0844',basis:'after_tax'});
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
