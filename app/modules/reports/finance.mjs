import { createHash } from 'node:crypto';

export const financialReportsEndpoint = 'https://finance-api.wildberries.ru/api/finance/v1/sales-reports/detailed';
export const financialParserVersion = 'wb-finance-v7';
const unverifiedMoneyFields = [
  'sellerPromo','installmentCoFinancingAmount','cashbackAmount','cashbackDiscount',
  'cashbackCommissionChange','sellerPromoDiscount','loyaltyDiscount','agencyVat'
];

const calendarDate=value=>{
  if(value instanceof Date){
    if(Number.isNaN(value.getTime()))return null;
    const pad=part=>String(part).padStart(2,'0');
    return`${value.getFullYear()}-${pad(value.getMonth()+1)}-${pad(value.getDate())}`;
  }
  const text=String(value??'').slice(0,10);
  return/^\d{4}-\d{2}-\d{2}$/.test(text)?text:null;
};

export function financialReportPeriodMatches(existing,incoming){
  return calendarDate(existing?.period_start)===incoming?.periodStart&&calendarDate(existing?.period_end)===incoming?.periodEnd;
}

const identifierFields = ['reportId','rrdId','giId','nmId','shkId','ppvzOfficeId','orderId','trbxId','loyaltyId'];
const identifierPattern = new RegExp(`("(?:${identifierFields.join('|')})"\\s*:\\s*)(-?\\d+)(?=\\s*[,}])`, 'g');
const decimalPattern = /^-?\d+(?:\.\d+)?$/;
// srid and shkId identify a WB transaction/package, not a catalog item. WB also
// sends them on store-level service rows where nmId and SKU are empty.
const itemIdentifierFields = ['nmId', 'sku', 'saName', 'barcode'];
const storeServiceFields = new Map([
  ['deliveryService', { category: 'logistics', operation: 'service_charge', names: new Set(['логистика', 'доставка', 'коррекция стоимости доставки']) }],
  ['paidStorage', { category: 'storage', operation: 'service_charge', names: new Set(['хранение', 'коррекция хранения']) }],
  ['paidAcceptance', { category: 'acceptance', operation: 'service_charge', names: new Set(['обработка товара']) }],
  ['penalty', { category: 'penalty', operation: 'adjustment', names: new Set(['штраф']) }],
  ['deduction', { category: 'deduction', operation: 'adjustment', names: new Set(['удержание']) }]
]);

function hasRealItemIdentifier(row) {
  return itemIdentifierFields.some(field => {
    const value = row?.[field];
    if (value === null || value === undefined) return false;
    const text = String(value).trim();
    return text !== '' && !/^0+(?:\.0+)?$/.test(text);
  });
}

function realIdentifier(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text !== '' && !/^0+(?:\.0+)?$/.test(text) ? text : null;
}

function isVerifiedPromotionRow(row) {
  const deduction = decimal(row?.deduction);
  return !hasRealItemIdentifier(row) && deduction !== null && deduction !== '0' && !deduction.startsWith('-') &&
    String(row?.docTypeName ?? '').trim() === '' && String(row?.sellerOperName ?? '').trim() === 'Удержание' &&
    /^Оказание услуг «WB Продвижение», документ №\d+$/.test(String(row?.bonusTypeName ?? '').trim());
}

function isVerifiedPvzStoreRow(row) {
  return !hasRealItemIdentifier(row) && String(row?.docTypeName ?? '').trim() === 'Продажа' &&
    String(row?.sellerOperName ?? '').trim() === 'Возмещение за выдачу и возврат товаров на ПВЗ';
}

function isVerifiedPvzComponent(row, component) {
  if (!isVerifiedPvzStoreRow(row)) return false;
  const raw = decimal(row?.[component.sourceField]);
  if (raw === null || raw === '0') return false;
  if (component.sourceField === 'ppvzReward') return component.categoryCode === 'pickup_reward';
  if (component.sourceField === 'vw') return component.categoryCode === 'wb_reward_without_vat';
  if (component.sourceField === 'vwNds') return component.categoryCode === 'wb_reward_vat';
  return false;
}

function apiError(message, response, retryAfterMs) {
  const error = new Error(message);
  error.status = response?.status;
  error.endpoint = financialReportsEndpoint;
  if (retryAfterMs) error.retryAfterMs = retryAfterMs;
  return error;
}

export function parseFinancialJson(raw) {
  try {
    return JSON.parse(String(raw).replace(identifierPattern, '$1"$2"'));
  } catch {
    throw new Error('financial_invalid_response');
  }
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}

export function stableJson(value) {
  return JSON.stringify(stable(value));
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function dateValue(value) {
  const result = String(value ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || Number.isNaN(Date.parse(`${result}T00:00:00Z`))) throw new Error('financial_invalid_row');
  return result;
}

function decimalId(value) {
  const result = String(value ?? '');
  if (!/^\d+$/.test(result)) throw new Error('financial_invalid_row');
  return result.replace(/^0+(?=\d)/, '');
}

function compareDecimalIds(a, b) {
  return a.length - b.length || a.localeCompare(b);
}

export function decimal(value, { absolute = false, negative = false } = {}) {
  if (value === null || value === undefined || value === '') return null;
  let result = String(value).trim().replace(',', '.');
  if (!decimalPattern.test(result)) throw new Error('financial_invalid_amount');
  const parts = result.replace(/^-/, '').split('.');
  let whole = parts[0].replace(/^0+(?=\d)/, '') || '0';
  let fraction = (parts[1] ?? '').replace(/0+$/, '');
  result = fraction ? `${whole}.${fraction}` : whole;
  if (result === '0') return '0';
  const sourceNegative = String(value).trim().startsWith('-');
  if (negative || (!absolute && sourceNegative)) return `-${result}`;
  return result;
}

function roundedKopecks(value) {
  const raw = decimal(value);
  if (raw === null) return null;
  const negative = raw.startsWith('-');
  const [whole, fraction = ''] = raw.replace(/^-/, '').split('.');
  let kopecks = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2));
  if ((fraction[2] ?? '0') >= '5') kopecks += 1n;
  if (kopecks === 0n) return '0';
  const integer = kopecks / 100n;
  const remainder = String(kopecks % 100n).padStart(2, '0');
  return decimal(`${negative ? '-' : ''}${integer}.${remainder}`);
}

function hasMoney(row, fields) {
  return fields.some(field => {
    const value = decimal(row[field]);
    return value !== null && value !== '0';
  });
}

export function normalizeFinancialOperation(row) {
  const docType = String(row?.docTypeName ?? '').trim().toLocaleLowerCase('ru-RU');
  const operationName = String(row?.sellerOperName ?? '').trim().toLocaleLowerCase('ru-RU');
  let operationType = 'unclassified';
  if (isVerifiedPvzStoreRow(row)) operationType = 'other';
  else if (docType === 'возврат' && operationName === 'возврат') operationType = 'return';
  else if (docType === 'продажа' && operationName === 'продажа') operationType = 'sale';
  else if (hasMoney(row, ['deliveryService','rebillLogisticCost','paidStorage','paidAcceptance','ppvzSalesCommission','acquiringFee'])) operationType = 'service_charge';
  else if (hasMoney(row, ['penalty','deduction','additionalPayment'])) operationType = 'adjustment';
  else if (hasMoney(row, ['forPay'])) operationType = 'settlement';

  const components = [];
  const add = (field, categoryCode, direction) => {
    const raw = direction === 'rounded_expense' || direction === 'absolute_expense'
      ? roundedKopecks(row?.[field])
      : decimal(row?.[field]);
    if (raw === null || raw === '0') return;
    let amountSigned=raw;
    if(direction==='income')amountSigned=decimal(raw,{absolute:true});
    else if(direction==='expense')amountSigned=raw.startsWith('-')?decimal(raw,{absolute:true}):decimal(raw,{negative:true});
    else if(direction==='rounded_expense')amountSigned=raw.startsWith('-')?decimal(raw,{absolute:true}):decimal(raw,{negative:true});
    else if(direction==='absolute_expense')amountSigned=decimal(raw,{absolute:true,negative:true});
    else if(direction==='document')amountSigned=operationType==='return'?decimal(raw,{absolute:true}):operationType==='sale'?decimal(raw,{negative:true}):raw.startsWith('-')?decimal(raw,{absolute:true}):decimal(raw,{negative:true});
    else if(direction==='settlement')amountSigned=operationType==='return'?decimal(raw,{negative:true}):operationType==='sale'?decimal(raw,{absolute:true}):raw;
    components.push({ componentKey: field, categoryCode, amountSigned, sourceField: field });
  };
  if (operationType === 'sale') add('retailAmount', 'revenue', 'income');
  if (operationType === 'return') add('retailAmount', 'revenue_return', 'expense');
  add('ppvzSalesCommission', 'commission', 'document');
  add('vw', 'wb_reward_without_vat', 'rounded_expense');
  add('vwNds', 'wb_reward_vat', 'rounded_expense');
  add('ppvzReward', 'pickup_reward', 'absolute_expense');
  add('acquiringFee', 'acquiring', 'document');
  add('deliveryService', 'logistics', 'document');
  add('rebillLogisticCost', 'rebill_logistic_compensation', 'rounded_expense');
  add('paidStorage', 'storage', 'expense');
  add('paidAcceptance', 'acceptance', 'expense');
  add('penalty', 'penalty', 'expense');
  add('deduction', isVerifiedPromotionRow(row) ? 'promotion' : 'deduction', 'expense');
  add('additionalPayment', 'commission_adjustment', 'expense');
  add('forPay', 'payout', 'settlement');
  for(const field of unverifiedMoneyFields)add(field,'unclassified_financial_field','source');

  let quantity = decimal(row?.quantity);
  if (quantity !== null && operationType === 'return') quantity = decimal(quantity, { negative: true });
  else if (quantity !== null && operationType === 'sale') quantity = decimal(quantity, { absolute: true });
  return {
    operationType,
    accountingDate: dateValue(row?.rrDate),
    sourceOccurredAt: row?.saleDt || row?.orderDt || null,
    quantity,
    wbArticle: realIdentifier(row?.nmId),
    variantBarcode: realIdentifier(row?.sku),
    srid: realIdentifier(row?.srid),
    components
  };
}

function requestBody({ dateFrom, dateTo, limit, rrdId }) {
  if (!/^\d+$/.test(String(rrdId))) throw new Error('financial_invalid_cursor');
  const prefix = JSON.stringify({ dateFrom, dateTo, limit, period: 'weekly' });
  return `${prefix.slice(0, -1)},"rrdId":${rrdId}}`;
}

async function fetchPage(token, params, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(financialReportsEndpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: requestBody(params),
      signal: AbortSignal.timeout(30000)
    });
  } catch {
    throw apiError('financial_unavailable');
  }
  if (response.status === 204) return { done: true, response };
  if (response.status === 401 || response.status === 403) throw apiError('financial_unauthorized', response);
  if (response.status === 402) throw apiError('financial_payment_required', response);
  if (response.status === 429) throw apiError('financial_rate_limited', response);
  if (response.status >= 500) throw apiError('financial_unavailable', response);
  if (!response.ok) throw apiError('financial_invalid_request', response);
  const raw = await response.text();
  const rows = parseFinancialJson(raw);
  if (!Array.isArray(rows) || rows.length === 0) throw apiError('financial_invalid_response', response);
  return { done: false, response, raw, rows };
}

export function financialRequestDelaySeconds(random = Math.random) {
  const value = Number(random());
  if (!Number.isFinite(value) || value < 0 || value >= 1) throw new Error('financial_invalid_random');
  return 65 + Math.floor(value * 11);
}

export function normalizeFinancialReports(rows) {
  const reports = new Map();
  for (const rawData of rows) {
    if (!rawData || typeof rawData !== 'object') throw new Error('financial_invalid_row');
    const externalReportId = decimalId(rawData.reportId);
    const externalRowKey = decimalId(rawData.rrdId);
    const periodStart = dateValue(rawData.dateFrom);
    const periodEnd = dateValue(rawData.dateTo);
    if (periodEnd < periodStart || String(rawData.currency ?? '') !== 'RUB') throw new Error('financial_invalid_row');
    const rowJson = stableJson(rawData);
    const rowChecksum = hash(rowJson);
    let report = reports.get(externalReportId);
    if (!report) {
      report = { externalReportId, periodStart, periodEnd, currency: 'RUB', createdAt: rawData.createDate ?? null, rows: [], keys: new Map() };
      reports.set(externalReportId, report);
    }
    if (report.periodStart !== periodStart || report.periodEnd !== periodEnd) throw new Error('financial_report_period_mismatch');
    const prior = report.keys.get(externalRowKey);
    if (prior && prior !== rowChecksum) throw new Error('financial_duplicate_row_conflict');
    if (prior) continue;
    report.keys.set(externalRowKey, rowChecksum);
    report.rows.push({ externalRowKey, rawData, rowChecksum });
  }
  return [...reports.values()].map(report => {
    report.rows.sort((a, b) => compareDecimalIds(a.externalRowKey, b.externalRowKey));
    const checksum = hash(report.rows.map(row => `${row.externalRowKey}:${row.rowChecksum}`).join('\n'));
    delete report.keys;
    return { ...report, checksum };
  }).sort((a, b) => a.periodStart.localeCompare(b.periodStart) || compareDecimalIds(a.externalReportId, b.externalReportId));
}

export async function loadWbFinancialReports(token, {
  dateFrom,
  dateTo,
  fetchImpl = fetch,
  limit = 100000,
  maxPages = 100,
  beforeRequest = async () => {},
  onPage = async () => {}
} = {}) {
  dateFrom = dateValue(dateFrom);
  dateTo = dateValue(dateTo);
  if (dateTo < dateFrom || !Number.isInteger(limit) || limit < 1 || limit > 100000) throw new Error('financial_invalid_request');
  const rows = [], pages = [];
  let rrdId = '0';
  for (let page = 0; page < maxPages; page++) {
    await beforeRequest({ page, rrdId, rowCount: rows.length });
    const result = await fetchPage(token, { dateFrom, dateTo, limit, rrdId }, fetchImpl);
    if (result.done) return { dateFrom, dateTo, rows, reports: normalizeFinancialReports(rows), pages, pageCount: pages.length, finalRrdId: rrdId };
    const last = decimalId(result.rows.at(-1)?.rrdId);
    if (compareDecimalIds(last, rrdId) <= 0) throw new Error('financial_invalid_cursor');
    rows.push(...result.rows);
    pages.push({ partNumber: page, raw: result.raw, checksum: hash(result.raw), rowCount: result.rows.length, firstRrdId: decimalId(result.rows[0].rrdId), lastRrdId: last });
    rrdId = last;
    await onPage({ pageCount: pages.length, rowCount: rows.length, rrdId });
  }
  throw new Error('financial_too_large');
}

export function financialDateRange(now = new Date(), days = 91) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  const end = new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00Z`);
  const start = new Date(end.getTime() - days * 86400000);
  return { dateFrom: start.toISOString().slice(0, 10), dateTo: end.toISOString().slice(0, 10) };
}

export function financialComponentScope(row, operation, component, productMatched = false) {
  if (productMatched) return 'selected_product';
  if (operation.operationType === 'other' && isVerifiedPvzComponent(row,component)) return 'store';
  const rule = storeServiceFields.get(component.sourceField);
  const raw = decimal(row?.[component.sourceField]);
  const hasItemIdentifier = hasRealItemIdentifier(row);
  const document = String(row?.docTypeName ?? '').trim().toLocaleLowerCase('ru-RU');
  const name = String(row?.sellerOperName ?? '').trim().toLocaleLowerCase('ru-RU');
  if (rule && !hasItemIdentifier && document === '' && rule.names.has(name) &&
      operation.operationType === rule.operation && component.categoryCode === rule.category &&
      raw !== null && raw !== '0' && !raw.startsWith('-')) return 'store';
  if (component.sourceField === 'deduction' && component.categoryCode === 'promotion' &&
      operation.operationType === 'adjustment' && isVerifiedPromotionRow(row)) return 'store';
  return 'product_expected';
}

const unverifiedResultCategories = new Set([
  'unclassified_financial_field','commission_adjustment'
]);

const verifiedResultExpenseCategories = new Set([
  'wb_reward_without_vat','wb_reward_vat','pickup_reward','rebill_logistic_compensation'
]);

export function unverifiedFinancialComponents(row,operation,productMatched=false){
  return operation.components.filter(component=>{
    if(verifiedResultExpenseCategories.has(component.categoryCode)){
      if(productMatched)return false;
      return !(operation.operationType==='other'&&isVerifiedPvzComponent(row,component));
    }
    if(unverifiedResultCategories.has(component.categoryCode))return true;
    const raw=decimal(row?.[component.sourceField]);
    if(raw?.startsWith('-'))return true;
    return financialComponentScope(row,operation,component,productMatched)==='product_expected'&&!productMatched;
  }).map(component=>component.sourceField).sort();
}

export function financialHistoricalWeekRange(earliestDate, recentFrom, lastCheckedWeek) {
  const monday = value => {
    const date = dateValue(value);
    const day = new Date(`${date}T00:00:00Z`);
    if (day.toISOString().slice(0, 10) !== date) throw new Error('financial_invalid_request');
    day.setUTCDate(day.getUTCDate() - (day.getUTCDay() + 6) % 7);
    return day;
  };
  if (!earliestDate) return null;
  const first = monday(earliestDate);
  const recent = monday(recentFrom);
  const latest = new Date(recent.getTime() - 7 * 86400000);
  if (first > latest) return null;
  let next = first;
  if (lastCheckedWeek) {
    const previous = monday(lastCheckedWeek);
    if (previous >= first && previous < latest) next = new Date(previous.getTime() + 7 * 86400000);
  }
  return { dateFrom: next.toISOString().slice(0, 10), dateTo: new Date(next.getTime() + 6 * 86400000).toISOString().slice(0, 10) };
}
