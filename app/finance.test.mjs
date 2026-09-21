import test from 'node:test';
import assert from 'node:assert/strict';
import { decimal, financialDateRange, financialReportPeriodMatches, financialRequestDelaySeconds, loadWbFinancialReports, normalizeFinancialOperation, normalizeFinancialReports, parseFinancialJson } from './finance.mjs';

const row = (overrides = {}) => ({
  reportId: '90071992547409931', dateFrom: '2026-09-01', dateTo: '2026-09-07', createDate: '2026-09-08', currency: 'RUB',
  rrdId: '90071992547409941', nmId: '1234567', docTypeName: 'Продажа', sellerOperName: 'Продажа', rrDate: '2026-09-07',
  quantity: 1, retailAmount: '367.00', ...overrides
});

test('financial JSON keeps 64-bit WB identifiers as strings', () => {
  const parsed = parseFinancialJson('[{"reportId":90071992547409931,"rrdId":90071992547409941,"nmId":123}]');
  assert.deepEqual(parsed, [{ reportId: '90071992547409931', rrdId: '90071992547409941', nmId: '123' }]);
});

test('stored PostgreSQL dates match the same financial report calendar period', () => {
  const stored={period_start:new Date(2026,7,10),period_end:new Date(2026,7,16)};
  assert.equal(financialReportPeriodMatches(stored,{periodStart:'2026-08-10',periodEnd:'2026-08-16'}),true);
  assert.equal(financialReportPeriodMatches(stored,{periodStart:'2026-08-10',periodEnd:'2026-08-17'}),false);
  assert.equal(financialReportPeriodMatches({period_start:'2026-08-10',period_end:'2026-08-16'},{periodStart:'2026-08-10',periodEnd:'2026-08-16'}),true);
});

test('financial reports reserve every request and paginate by exact rrdId until 204', async () => {
  const bodies = [], reservations = [];
  const first = row(), second = row({ rrdId: '90071992547409999', reportId: '90071992547409932', dateFrom: '2026-09-08', dateTo: '2026-09-14' });
  const responses = [new Response(JSON.stringify([first])), new Response(JSON.stringify([second])), new Response(null, { status: 204 })];
  const result = await loadWbFinancialReports('token', {
    dateFrom: '2026-09-01', dateTo: '2026-09-15', limit: 1,
    fetchImpl: async (_url, options) => { bodies.push(options.body); return responses.shift(); },
    beforeRequest: async request => reservations.push(request)
  });
  assert.equal(result.pageCount, 2);
  assert.equal(result.reports.length, 2);
  assert.match(bodies[1], /"rrdId":90071992547409941/);
  assert.equal(reservations.length, 3);
  assert.deepEqual(reservations.map(request=>request.rrdId),['0','90071992547409941','90071992547409999']);
});

test('financial loader stops after the first rate limit response', async () => {
  let calls = 0;
  await assert.rejects(()=>loadWbFinancialReports('token', {
    dateFrom: '2026-09-01', dateTo: '2026-09-07',
    fetchImpl: async () => {
      calls++;
      return new Response('{}', { status: 429, headers: { 'retry-after': '2' } });
    }
  }),/financial_rate_limited/);
  assert.equal(calls,1);
});

test('financial request jitter is an integer from 65 through 75 seconds',()=>{
  assert.equal(financialRequestDelaySeconds(()=>0),65);
  assert.equal(financialRequestDelaySeconds(()=>0.999999),75);
  assert.throws(()=>financialRequestDelaySeconds(()=>1),/financial_invalid_random/);
});

test('normalization rejects changed duplicate rows and foreign currency', () => {
  assert.throws(() => normalizeFinancialReports([row(), row({ retailAmount: '368' })]), /financial_duplicate_row_conflict/);
  assert.throws(() => normalizeFinancialReports([row({ currency: 'USD' })]), /financial_invalid_row/);
});

test('financial decimals are canonical and never use floating point', () => {
  assert.equal(decimal('001.2300'), '1.23');
  assert.equal(decimal('-14.8900'), '-14.89');
  assert.equal(decimal('14.89', { negative: true }), '-14.89');
  assert.throws(() => decimal('NaN'), /financial_invalid_amount/);
});

test('financial date range uses a deterministic Moscow calendar date', () => {
  assert.deepEqual(financialDateRange(new Date('2026-09-15T22:30:00Z'), 7), { dateFrom: '2026-09-09', dateTo: '2026-09-16' });
});

test('financial operation creates signed components without counting payout as revenue', () => {
  const operation = normalizeFinancialOperation(row({
    retailAmount: '1000', ppvzSalesCommission: '200', acquiringFee: '12.50', deliveryService: '70',
    paidStorage: '5', paidAcceptance: '3', penalty: '10', deduction: '4', additionalPayment: '20', forPay: '715.50'
  }));
  assert.equal(operation.operationType, 'sale');
  assert.deepEqual(Object.fromEntries(operation.components.map(component => [component.componentKey, component.amountSigned])), {
    retailAmount: '1000', ppvzSalesCommission: '-200', acquiringFee: '-12.5', deliveryService: '-70', paidStorage: '-5',
    paidAcceptance: '-3', penalty: '-10', deduction: '-4', additionalPayment: '-20', forPay: '715.5'
  });
  assert.equal(operation.components.find(component => component.componentKey === 'forPay').categoryCode, 'payout');
  assert.equal(operation.components.find(component => component.componentKey === 'additionalPayment').categoryCode, 'commission_adjustment');
});

test('return quantity and revenue are negative', () => {
  const operation = normalizeFinancialOperation(row({ docTypeName: 'Возврат', sellerOperName: 'Возврат', quantity: '2', retailAmount: '500' }));
  assert.equal(operation.operationType, 'return');
  assert.equal(operation.quantity, '-2');
  assert.equal(operation.components.find(component => component.categoryCode === 'revenue_return').amountSigned, '-500');
});

test('financial corrections preserve reversal direction and names containing return are not product returns', () => {
  const correction=normalizeFinancialOperation(row({docTypeName:'Продажа',sellerOperName:'Корректировка вознаграждения',deduction:'-4',additionalPayment:'-20'}));
  assert.equal(correction.operationType,'adjustment');
  assert.deepEqual(Object.fromEntries(correction.components.map(component=>[component.componentKey,component.amountSigned])),{deduction:'4',additionalPayment:'20'});
  const compensation=normalizeFinancialOperation(row({docTypeName:'Продажа',sellerOperName:'Добровольная компенсация при возврате',additionalPayment:'10'}));
  assert.equal(compensation.operationType,'adjustment');
  assert.equal(compensation.quantity,'1');
});

test('unverified WB remuneration fields remain separate informational components',()=>{
  const operation=normalizeFinancialOperation(row({vw:'12.5',vwNds:'2.5',ppvzReward:'3',rebillLogisticCost:'4',cashbackAmount:'5'}));
  assert.deepEqual(operation.components.filter(component=>['vw','vwNds','ppvzReward','rebillLogisticCost'].includes(component.componentKey)).map(({componentKey,categoryCode,amountSigned})=>({componentKey,categoryCode,amountSigned})),[
    {componentKey:'vw',categoryCode:'wb_reward_without_vat',amountSigned:'12.5'},
    {componentKey:'vwNds',categoryCode:'wb_reward_vat',amountSigned:'2.5'},
    {componentKey:'ppvzReward',categoryCode:'pickup_reward',amountSigned:'3'},
    {componentKey:'rebillLogisticCost',categoryCode:'rebill_logistic_compensation',amountSigned:'4'}
  ]);
  assert.deepEqual(operation.components.find(component=>component.componentKey==='cashbackAmount'),{
    componentKey:'cashbackAmount',categoryCode:'unclassified_financial_field',amountSigned:'5',sourceField:'cashbackAmount'
  });
});
