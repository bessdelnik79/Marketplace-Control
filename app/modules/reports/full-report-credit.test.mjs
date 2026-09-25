import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSellerOffsetReference } from './full-report-credit.mjs';

test('seller offset keeps nine candidate lines separate and never invents a total', () => {
  const result = buildSellerOffsetReference({
    reportId: '101',
    rows: [
      { reportId: '101', vw: '10.25', vwNds: '2.05', cashbackCommissionChange: '1', acquiringFee: '3.5', rebillLogisticCost: '4', ppvzReward: '5', penalty: '6', deduction: '7' },
      { reportId: '101', vw: '-0.25', vwNds: '0', cashbackCommissionChange: '0.5', acquiringFee: '0.5', rebillLogisticCost: '0', ppvzReward: '1', penalty: '0', deduction: '2' }
    ]
  });
  assert.equal(result.status, 'not_determined');
  assert.equal(result.total, null);
  assert.equal(result.lines.length, 9);
  assert.equal(result.lines[0].candidateAmount, '10');
  assert.equal(result.lines[2].candidateAmount, '1.5');
  assert.equal(result.lines[3].candidateAmount, null);
  assert.ok(result.lines.every(line => line.status !== 'confirmed'));
});

test('seller offset rejects rows from another report id', () => {
  assert.throws(() => buildSellerOffsetReference({ reportId: '101', rows: [{ reportId: '102' }] }), /seller_offset_report_mismatch/);
});

test('seller offset marks an invalid source without replacing it with zero', () => {
  const result = buildSellerOffsetReference({ reportId: '101', rows: [{ reportId: '101', acquiringFee: 'oops' }] });
  const acquiring = result.lines.find(line => line.code === 'payment_organization_withholding');
  assert.equal(acquiring.status, 'invalid_source');
  assert.equal(acquiring.candidateAmount, null);
  const penalties = result.lines.find(line => line.code === 'penalties');
  assert.equal(penalties.status, 'source_missing');
  assert.equal(penalties.candidateAmount, null);
  assert.equal(result.total, null);
});
