import test from 'node:test';
import assert from 'node:assert/strict';
import { loadWbFinancialSummaries, normalizeFinancialSummaries, reconcileBankPayment } from './bank-reconciliation.mjs';

const report = {
  externalReportId: '90071992547409931', periodStart: '2026-09-01', periodEnd: '2026-09-07',
  rows: [
    { rawData: { docTypeName: 'Продажа', sellerOperName: 'Продажа', forPay: '100', deliveryService: '5', paidStorage: '2', paidAcceptance: '3', deduction: '4', penalty: '1', additionalPayment: '5' } },
    { rawData: { docTypeName: 'Возврат', sellerOperName: 'Возврат', forPay: '20' } }
  ]
};
const summary = {
  reportId: '90071992547409931', reportType: 1, dateFrom: '2026-09-01', dateTo: '2026-09-07', currency: 'RUB',
  forPaySum: '80', deliveryServiceSum: '5', paidStorageSum: '2', paidAcceptanceSum: '3', deductionSum: '4', penaltySum: '1', additionalPaymentSum: '5',
  cashbackAmountSum: '0', cashbackDiscountSum: '0', cashbackCommissionChangeSum: '0', bankPaymentSum: '60'
};

test('bank control checks covered sale-minus-return and expense rows exactly', () => {
  assert.deepEqual(reconcileBankPayment(report, summary), { status: 'passed', expectedAmount: '60.00', actualAmount: '60.00', reason: null });
  assert.deepEqual(reconcileBankPayment(report, { ...summary, bankPaymentSum: '61' }), { status: 'failed', expectedAmount: '60.00', actualAmount: '61.00', reason: 'bank_payment_mismatch' });
  assert.equal(reconcileBankPayment(report, { ...summary, forPaySum: '81' }).reason, 'summary_detail_mismatch');
});

test('unsupported cashback, reverse signs and non-sale payout rows cannot pass', () => {
  assert.equal(reconcileBankPayment(report, { ...summary, cashbackAmountSum: '1' }).reason, 'cashback_unverified');
  assert.equal(reconcileBankPayment(report, { ...summary, cashbackCommissionChangeSum: '1' }).reason, 'cashback_unverified');
  assert.equal(reconcileBankPayment(report, { ...summary, cashbackDiscountSum: '1' }).reason, 'cashback_unverified');
  assert.equal(reconcileBankPayment(report, { ...summary, additionalPaymentSum: '-5' }).reason, 'summary_amount_unverified');
  assert.equal(reconcileBankPayment(report, { ...summary, bankPaymentSum: '10000000000000000' }).reason, 'summary_amount_unverified');
  assert.equal(reconcileBankPayment(report, { ...summary, bankPaymentSum: '9999999999999999.9999' }).reason, 'payment_amount_unverified');
  assert.equal(reconcileBankPayment({ ...report, rows: [{ rawData: { docTypeName: 'Продажа', sellerOperName: 'ПВЗ', forPay: '100' } }] }, summary).reason, 'settlement_row_unverified');
  assert.equal(reconcileBankPayment(report, null).reason, 'summary_missing');
  assert.equal(reconcileBankPayment(report, { ...summary, reportType: 2 }).reason, 'summary_scope_unverified');
});

test('summary loader preserves large report IDs and paginates through shared reservation hook', async () => {
  const reservations = [], bodies = [];
  const responses = [new Response(JSON.stringify([summary]).replace('"reportId":"90071992547409931"', '"reportId":90071992547409931')), new Response(null, { status: 204 })];
  const loaded = await loadWbFinancialSummaries('token', {
    dateFrom: '2026-09-01', dateTo: '2026-09-07', limit: 1,
    beforeRequest: request => reservations.push(request),
    fetchImpl: async (_url, options) => { bodies.push(JSON.parse(options.body)); return responses.shift(); }
  });
  assert.equal(loaded.get('90071992547409931').rawData.reportId, '90071992547409931');
  assert.deepEqual(bodies.map(body => body.offset), [0, 1]);
  assert.equal(reservations.length, 2);
  assert.throws(() => normalizeFinancialSummaries([summary, { ...summary, bankPaymentSum: '61' }]), /financial_duplicate_summary_conflict/);
});

test('summary rate limit stops after one request and cannot create a verified check', async () => {
  let calls = 0;
  await assert.rejects(() => loadWbFinancialSummaries('token', {
    dateFrom: '2026-09-01', dateTo: '2026-09-07',
    fetchImpl: async () => { calls++; return new Response(null, { status: 429 }); }
  }), /financial_summary_rate_limited/);
  assert.equal(calls, 1);
  assert.equal(reconcileBankPayment(report, undefined).status, 'not_checkable');
});
