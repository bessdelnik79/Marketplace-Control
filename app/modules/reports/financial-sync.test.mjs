import test from 'node:test';
import assert from 'node:assert/strict';
import { financialSyncErrorCode, financialSyncFailureDiagnostic } from './financial-sync.mjs';

test('financial sync preserves safe repository validation codes', () => {
  for (const code of [
    'financial_row_period_mismatch',
    'financial_report_version_not_accepted',
    'financial_method_missing',
    'financial_context_mismatch',
    'financial_invalid_rate_delay'
  ]) assert.equal(financialSyncErrorCode(new Error(code)), code);
  assert.equal(financialSyncErrorCode(new Error('secret database detail')), 'financial_internal_error');
});

test('financial sync diagnostics expose only bounded structured fields', () => {
  const error = Object.assign(new Error('secret-token-value'), {
    name: 'DatabaseError',
    code: '23514',
    constraint: 'operation_accounting_date_check',
    status: 500,
    endpoint: 'https://finance-api.wildberries.ru/api/v5/supplier/reportDetailByPeriod?rrdid=123&token=secret',
    rawData: { nmId: 'private-row' },
    token: 'secret-token-value'
  });
  const diagnostic = financialSyncFailureDiagnostic(error);
  assert.deepEqual(diagnostic, {
    errorCode: 'financial_internal_error',
    errorName: 'DatabaseError',
    databaseCode: '23514',
    constraint: 'operation_accounting_date_check',
    wbStatus: 500,
    endpoint: 'https://finance-api.wildberries.ru/api/v5/supplier/reportDetailByPeriod'
  });
  assert.doesNotMatch(JSON.stringify(diagnostic), /secret|rrdid|private-row/);
  assert.deepEqual(financialSyncFailureDiagnostic(Object.assign(new Error('unknown'), {
    name: 'bad name with spaces', constraint: 'unsafe/constraint', code: 'x'.repeat(121)
  })), { errorCode: 'financial_internal_error' });
});
