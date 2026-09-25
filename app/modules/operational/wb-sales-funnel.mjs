import { createHash } from 'node:crypto';

export const wbSalesFunnelHistoryEndpoint = 'https://seller-analytics-api.wildberries.ru/api/analytics/v3/sales-funnel/products/history';

const DAY_MS = 86400000;
const exactFieldPattern = /("(?:nmId|orderSum|buyoutSum)"\s*:\s*)(-?\d+(?:\.\d+)?)(?=\s*[,}])/g;

function failure(code, response) {
  const error = new Error(code);
  if (response) {
    error.status = response.status;
    error.endpoint = wbSalesFunnelHistoryEndpoint;
  }
  return error;
}

function calendarDate(value) {
  const text = String(value ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw failure('operational_invalid_date');
  const [year, month, day] = text.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw failure('operational_invalid_date');
  }
  return text;
}

function dayNumber(value) {
  const [year, month, day] = calendarDate(value).split('-').map(Number);
  return Math.trunc(Date.UTC(year, month - 1, day) / DAY_MS);
}

function dateFromDay(value) {
  const date = new Date(value * DAY_MS);
  return `${String(date.getUTCFullYear()).padStart(4, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function requestPeriod(dateFrom, dateTo) {
  dateFrom = calendarDate(dateFrom);
  dateTo = calendarDate(dateTo);
  const start = dayNumber(dateFrom), end = dayNumber(dateTo);
  if (end < start || end - start > 6) throw failure('operational_invalid_period');
  return { dateFrom, dateTo, start, end };
}

function selectedNmIds(values) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 20) throw failure('operational_invalid_nm_ids');
  if (values.some(value => !Number.isSafeInteger(value) || value <= 0)) throw failure('operational_invalid_nm_ids');
  if (new Set(values).size !== values.length) throw failure('operational_duplicate_nm_id');
  return [...values];
}

function exactDecimal(value) {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value)) throw failure('operational_invalid_response');
  const [whole, fraction = ''] = value.split('.');
  const normalizedWhole = whole.replace(/^0+(?=\d)/, '');
  const normalizedFraction = fraction.replace(/0+$/, '');
  return normalizedFraction ? `${normalizedWhole}.${normalizedFraction}` : normalizedWhole;
}

function safeCount(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw failure('operational_invalid_response');
  return value;
}

function responseNmId(value) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw failure('operational_invalid_response');
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw failure('operational_invalid_response');
  return number;
}

export function parseSalesFunnelHistoryJson(raw) {
  if (typeof raw !== 'string') throw failure('operational_invalid_response');
  try {
    return JSON.parse(raw.replace(exactFieldPattern, '$1"$2"'));
  } catch {
    throw failure('operational_invalid_response');
  }
}

export function normalizeSalesFunnelHistory(payload, { nmIds, dateFrom, dateTo }) {
  const selected = selectedNmIds(nmIds);
  const selectedSet = new Set(selected);
  const period = requestPeriod(dateFrom, dateTo);
  if (!Array.isArray(payload)) throw failure('operational_invalid_response');

  const rows = [], keys = new Set(), currencies = new Set();
  for (const item of payload) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || !item.product || typeof item.product !== 'object' || !Array.isArray(item.history)) {
      throw failure('operational_invalid_response');
    }
    const nmId = responseNmId(item.product.nmId);
    if (!selectedSet.has(nmId)) throw failure('operational_unexpected_nm_id');
    const currency = String(item.currency ?? '').trim();
    if (!currency) throw failure('operational_invalid_currency');
    currencies.add(currency);
    for (const point of item.history) {
      if (!point || typeof point !== 'object' || Array.isArray(point)) throw failure('operational_invalid_response');
      const date = calendarDate(point.date);
      const day = dayNumber(date);
      if (day < period.start || day > period.end) throw failure('operational_unexpected_date');
      const key = `${nmId}:${date}`;
      if (keys.has(key)) throw failure('operational_duplicate_row');
      keys.add(key);
      rows.push({
        nmId,
        date,
        currency,
        orderCount: safeCount(point.orderCount),
        orderSum: exactDecimal(point.orderSum),
        buyoutCount: safeCount(point.buyoutCount),
        buyoutSum: exactDecimal(point.buyoutSum)
      });
    }
  }
  if (currencies.size > 1) throw failure('operational_currency_mismatch');
  rows.sort((left, right) => left.date.localeCompare(right.date) || left.nmId - right.nmId);

  const missing = [];
  for (let day = period.start; day <= period.end; day++) {
    const date = dateFromDay(day);
    for (const nmId of selected) if (!keys.has(`${nmId}:${date}`)) missing.push({ nmId, date });
  }
  return { period: { start: period.dateFrom, end: period.dateTo }, currency: currencies.size ? [...currencies][0] : null, rows, missing };
}

export async function loadWbSalesFunnelHistory(token, {
  nmIds,
  dateFrom,
  dateTo,
  fetchImpl = fetch,
  beforeRequest = async () => {}
} = {}) {
  const selected = selectedNmIds(nmIds);
  const period = requestPeriod(dateFrom, dateTo);
  if (typeof token !== 'string' || !token.trim() || typeof fetchImpl !== 'function' || typeof beforeRequest !== 'function') {
    throw failure('operational_invalid_request');
  }
  const request = {
    endpoint: wbSalesFunnelHistoryEndpoint,
    nmIds: [...selected],
    dateFrom: period.dateFrom,
    dateTo: period.dateTo
  };
  await beforeRequest(request);
  let response;
  try {
    response = await fetchImpl(wbSalesFunnelHistoryEndpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ selectedPeriod: { start: period.dateFrom, end: period.dateTo }, nmIds: selected, skipDeletedNm: false, aggregationLevel: 'day' }),
      signal: AbortSignal.timeout(30000)
    });
  } catch {
    throw failure('operational_unavailable');
  }
  if (!response || !Number.isInteger(response.status) || typeof response.text !== 'function') throw failure('operational_unavailable');
  if (response.status === 401 || response.status === 403) throw failure('operational_unauthorized', response);
  if (response.status === 402) throw failure('operational_payment_required', response);
  if (response.status === 429) throw failure('operational_rate_limited', response);
  if (response.status >= 500) throw failure('operational_unavailable', response);
  if (!response.ok) throw failure('operational_invalid_request', response);

  let raw;
  try {
    raw = await response.text();
  } catch {
    throw failure('operational_unavailable', response);
  }
  const normalized = normalizeSalesFunnelHistory(parseSalesFunnelHistoryJson(raw), {
    nmIds: selected,
    dateFrom: period.dateFrom,
    dateTo: period.dateTo
  });
  return {
    ...normalized,
    raw,
    rawChecksum: createHash('sha256').update(raw).digest('hex')
  };
}
