import test from 'node:test';
import assert from 'node:assert/strict';
import { decimal, financialDateRange, loadWbFinancialReports, normalizeFinancialOperation, normalizeFinancialReports, parseFinancialJson } from './finance.mjs';

const row = (overrides = {}) => ({
  reportId: '90071992547409931', dateFrom: '2026-09-01', dateTo: '2026-09-07', createDate: '2026-09-08', currency: 'RUB',
  rrdId: '90071992547409941', nmId: '1234567', docTypeName: 'Продажа', sellerOperName: 'Продажа', rrDate: '2026-09-07',
  quantity: 1, retailAmount: '367.00', ...overrides
});

test('financial JSON keeps 64-bit WB identifiers as strings', () => {
  const parsed = parseFinancialJson('[{"reportId":90071992547409931,"rrdId":90071992547409941,"nmId":123}]');
  assert.deepEqual(parsed, [{ reportId: '90071992547409931', rrdId: '90071992547409941', nmId: '123' }]);
});

test('financial reports paginate by exact rrdId until 204', async () => {
  const bodies = [], waits = [];
  const first = row(), second = row({ rrdId: '90071992547409999', reportId: '90071992547409932', dateFrom: '2026-09-08', dateTo: '2026-09-14' });
  const responses = [new Response(JSON.stringify([first])), new Response(JSON.stringify([second])), new Response(null, { status: 204 })];
  const result = await loadWbFinancialReports('token', {
    dateFrom: '2026-09-01', dateTo: '2026-09-15', limit: 1, minIntervalMs: 60000,
    fetchImpl: async (_url, options) => { bodies.push(options.body); return responses.shift(); },
    waitImpl: async ms => waits.push(ms)
  });
  assert.equal(result.pageCount, 2);
  assert.equal(result.reports.length, 2);
  assert.match(bodies[1], /"rrdId":90071992547409941/);
  assert.deepEqual(waits, [60000, 60000]);
});

test('financial loader retries rate limits without losing cursor', async () => {
  let calls = 0;
  const waits = [];
  const result = await loadWbFinancialReports('token', {
    dateFrom: '2026-09-01', dateTo: '2026-09-07', minIntervalMs: 5,
    fetchImpl: async () => {
      calls++;
      if (calls === 1) return new Response('{}', { status: 429, headers: { 'retry-after': '2' } });
      if (calls === 2) return new Response(JSON.stringify([row()]));
      return new Response(null, { status: 204 });
    },
    waitImpl: async ms => waits.push(ms)
  });
  assert.equal(result.rows.length, 1);
  assert.deepEqual(waits, [2000, 5]);
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
    paidAcceptance: '-3', penalty: '-10', deduction: '-4', additionalPayment: '20', forPay: '715.5'
  });
  assert.equal(operation.components.find(component => component.componentKey === 'forPay').categoryCode, 'payout');
});

test('return quantity and revenue are negative', () => {
  const operation = normalizeFinancialOperation(row({ docTypeName: 'Возврат', sellerOperName: 'Возврат', quantity: '2', retailAmount: '500' }));
  assert.equal(operation.operationType, 'return');
  assert.equal(operation.quantity, '-2');
  assert.equal(operation.components.find(component => component.categoryCode === 'revenue_return').amountSigned, '-500');
});
