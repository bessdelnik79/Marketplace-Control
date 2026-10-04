import { createHash } from 'node:crypto';
import { decimal, parseFinancialJson, stableJson } from './finance.mjs';
import { scaledMoneyMatches } from '../../infrastructure/finance/money-comparison.mjs';

export const financialReportListEndpoint = 'https://finance-api.wildberries.ru/api/finance/v1/sales-reports/list';
const scale = 1000000000000n;
const numeric20x4Limit = 10000000000000000000000000000n;
const checkedFields = ['forPay', 'deliveryService', 'paidStorage', 'paidAcceptance', 'deduction', 'penalty', 'additionalPayment'];
const expenseFields = checkedFields.slice(1);
const unsupportedCashbackFields = ['cashbackAmount', 'cashbackCommissionChange'];

function units(value, missingZero = false) {
  if (value === null || value === undefined || value === '') return missingZero ? 0n : null;
  const normalized = decimal(value);
  const negative = normalized.startsWith('-');
  const [whole, fraction = ''] = normalized.replace('-', '').split('.');
  if (fraction.length > 12) return null;
  const result = BigInt(whole) * scale + BigInt(fraction.padEnd(12, '0') || '0');
  return negative ? -result : result;
}

function cents(value) {
  const sign = value < 0n ? -1n : 1n;
  const magnitude = value < 0n ? -value : value;
  return sign * ((magnitude + 5000000000n) / 10000000000n);
}

function money(value) {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  return `${negative ? '-' : ''}${magnitude / 100n}.${String(magnitude % 100n).padStart(2, '0')}`;
}

function notCheckable(reason) {
  return { status: 'not_checkable', expectedAmount: null, actualAmount: null, reason };
}

// This is deliberately narrower than a general payout formula. Cashback point
// movements and reversed service amounts have not been verified against a
// printed report. cashbackDiscount is informational and already included in
// the report revenue, so it neither changes nor blocks this control.
export function reconcileBankPayment(report, summary) {
  if (!summary) return notCheckable('summary_missing');
  if (String(summary.reportType) !== '1' || summary.currency !== 'RUB' || String(summary.reportId) !== report.externalReportId ||
      String(summary.dateFrom).slice(0, 10) !== report.periodStart || String(summary.dateTo).slice(0, 10) !== report.periodEnd) {
    return notCheckable('summary_scope_unverified');
  }
  try {
    for (const field of unsupportedCashbackFields) {
      if (units(summary[`${field}Sum`]) !== 0n) return notCheckable('cashback_unverified');
    }
    const summaryAmounts = Object.fromEntries(checkedFields.map(field => [field, units(summary[`${field}Sum`]) ]));
    const bank = units(summary.bankPaymentSum);
    if (bank === null || bank < 0n || bank >= numeric20x4Limit || Object.values(summaryAmounts).some(value => value === null) ||
        expenseFields.some(field => summaryAmounts[field] < 0n)) return notCheckable('summary_amount_unverified');

    const totals = Object.fromEntries(checkedFields.map(field => [field, 0n]));
    for (const { rawData: row } of report.rows) {
      if (unsupportedCashbackFields.some(field => units(row[field], true) !== 0n)) return notCheckable('cashback_unverified');
      const amounts = Object.fromEntries(checkedFields.map(field => [field, units(row[field], true)]));
      if (Object.values(amounts).some(value => value === null) || expenseFields.some(field => amounts[field] < 0n)) {
        return notCheckable('row_amount_or_sign_unverified');
      }
      const type = String(row.docTypeName ?? '').trim().toLocaleLowerCase('ru-RU');
      const operation = String(row.sellerOperName ?? '').trim().toLocaleLowerCase('ru-RU');
      if (amounts.forPay !== 0n) {
        if ((type !== 'продажа' || operation !== 'продажа') && (type !== 'возврат' || operation !== 'возврат')) {
          return notCheckable('settlement_row_unverified');
        }
        if (amounts.forPay < 0n) return notCheckable('settlement_sign_unverified');
        totals.forPay += type === 'возврат' ? -amounts.forPay : amounts.forPay;
      }
      for (const field of expenseFields) totals[field] += amounts[field];
    }
    if(checkedFields.some(field => cents(totals[field]) !== cents(summaryAmounts[field]) && !scaledMoneyMatches(totals[field],summaryAmounts[field],12)))return notCheckable('summary_detail_mismatch');
    const expected = totals.forPay - expenseFields.reduce((sum, field) => sum + totals[field], 0n);
    if (expected < 0n || expected >= numeric20x4Limit) return notCheckable('payment_amount_unverified');
    const expectedCents = cents(expected), actualCents = cents(bank);
    const matched = expectedCents === actualCents || scaledMoneyMatches(expected,bank,12);
    if(expectedCents >= 1000000000000000000n || actualCents >= 1000000000000000000n)return notCheckable('payment_amount_unverified');
    return {
      status: matched ? 'passed' : 'failed',
      expectedAmount: money(expectedCents), actualAmount: money(actualCents),
      reason: matched ? null : 'bank_payment_mismatch'
    };
  } catch {
    return notCheckable('invalid_amount');
  }
}

export function normalizeFinancialSummaries(rows) {
  const summaries = new Map();
  for (const row of rows) {
    if (!row || typeof row !== 'object' || !/^\d+$/.test(String(row.reportId ?? ''))) throw new Error('financial_invalid_summary');
    const id = String(row.reportId).replace(/^0+(?=\d)/, '');
    const checksum = createHash('sha256').update(stableJson(row)).digest('hex');
    const previous = summaries.get(id);
    if (previous && previous.checksum !== checksum) throw new Error('financial_duplicate_summary_conflict');
    summaries.set(id, { rawData: row, checksum });
  }
  return summaries;
}

export async function loadWbFinancialSummaries(token, { dateFrom, dateTo, fetchImpl = fetch, beforeRequest = async () => {}, limit = 1000, maxPages = 100 } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateFrom)) || !/^\d{4}-\d{2}-\d{2}$/.test(String(dateTo)) || dateTo < dateFrom ||
      !Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('financial_invalid_request');
  const rows = [];
  for (let page = 0; page < maxPages; page++) {
    await beforeRequest({ page, offset: rows.length });
    let response;
    try {
      response = await fetchImpl(financialReportListEndpoint, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ dateFrom, dateTo, limit, offset: rows.length, period: 'weekly' }), signal: AbortSignal.timeout(30000)
      });
    } catch { throw new Error('financial_summary_unavailable'); }
    if (response.status === 204) return normalizeFinancialSummaries(rows);
    if (response.status === 400 || response.status === 403) {
      const body = await response.text().catch(() => '');
      if (/unavailable for (?:your|the) registration country|недоступ\w* для (?:вашей )?стран\w* регистрации/i.test(body)) {
        throw new Error('financial_summary_unsupported_country');
      }
      if(response.status === 403)throw new Error('financial_summary_unauthorized');
      throw new Error('financial_summary_unavailable');
    }
    if (response.status === 401) throw new Error('financial_summary_unauthorized');
    if (response.status === 429) throw new Error('financial_summary_rate_limited');
    if (!response.ok) throw new Error('financial_summary_unavailable');
    const batch = parseFinancialJson(await response.text());
    if (!Array.isArray(batch)) throw new Error('financial_invalid_summary');
    rows.push(...batch);
    if (batch.length < limit) return normalizeFinancialSummaries(rows);
  }
  throw new Error('financial_summary_too_large');
}
