const MONEY_SCALE = 4;
const DAY_MS = 86400000;
const QUALITY_VALUES = new Set(['complete', 'partial', 'unavailable']);
const QUALITY_RANK = new Map([['complete', 0], ['partial', 1], ['unavailable', 2]]);
const REVENUE_CATEGORIES = new Set(['revenue', 'revenue_return']);
const COST_OF_GOODS_CATEGORY = 'cost_of_goods';
const WB_TRANSFER_CATEGORIES = new Set([
  'acquiring', 'logistics', 'storage', 'acceptance', 'penalty', 'deduction',
  'commission_adjustment', 'other_adjustment', 'promotion', 'pickup_reward',
  'wb_reward_without_vat', 'wb_reward_vat'
]);
const STORE_RESULT_METHODS = new Set(['financial-result-v7', 'financial-result-v8', 'financial-result-v9', 'financial-result-v10', 'financial-result-v11', 'financial-result-v12', 'financial-result-v13', 'financial-result-v14', 'financial-result-v15', 'financial-result-v16', 'financial-result-v17', 'financial-result-v18', 'financial-result-v19', 'financial-result-v20', 'financial-result-v21', 'financial-result-v22']);
const MISSING_REASON_ORDER = [
  'cost_missing',
  'return_original_sale_unmatched',
  'operation_unclassified',
  'product_link_missing',
  'store_component_unallocated',
  'store_expense_unallocated',
  'tax_setting_missing',
  'tax_selected_reference_only',
  'tax_method_unsupported',
  'tax_source_unverified',
  'tax_source_unlinked',
  'tax_base_missing',
  'tax_base_negative_unverified',
  'vat_method_unsupported',
  'report_coverage_incomplete',
  'source_unreconciled'
];
const MISSING_REASON_RANK = new Map(MISSING_REASON_ORDER.map((reason, index) => [reason, index]));

function invalid(code) {
  throw new Error(code);
}

export function parseScale4Money(value) {
  if (typeof value !== 'string') invalid('overview_invalid_money');
  const text = value.trim();
  const match = text.match(/^([+-]?)(\d+)(?:\.(\d{1,4}))?$/);
  if (!match) invalid('overview_invalid_money');
  const fraction = (match[3] ?? '').padEnd(MONEY_SCALE, '0');
  let scaled = BigInt(`${match[2]}${fraction}`);
  if (match[1] === '-') scaled = -scaled;
  return scaled;
}

export function formatScale4Money(value) {
  if (typeof value !== 'bigint') invalid('overview_invalid_money');
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(MONEY_SCALE + 1, '0');
  const result = `${digits.slice(0, -MONEY_SCALE)}.${digits.slice(-MONEY_SCALE)}`;
  return negative && value !== 0n ? `-${result}` : result;
}

export function validateCalendarDate(value) {
  const text = String(value ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) invalid('overview_invalid_date');
  const [year, month, day] = text.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    invalid('overview_invalid_date');
  }
  return text;
}

function dayNumber(value) {
  const [year, month, day] = validateCalendarDate(value).split('-').map(Number);
  return Math.trunc(Date.UTC(year, month - 1, day) / DAY_MS);
}

function dateFromDay(value) {
  const date = new Date(value * DAY_MS);
  const year = String(date.getUTCFullYear()).padStart(4, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function timezoneMetadata(value) {
  const timezone = String(value ?? '').trim();
  if (!timezone) invalid('overview_invalid_timezone');
  return timezone;
}

export function calendarWeekForDate(value, { timezone = 'Europe/Moscow' } = {}) {
  const date = validateCalendarDate(value);
  const day = dayNumber(date);
  const weekday = new Date(day * DAY_MS).getUTCDay();
  const monday = day - ((weekday + 6) % 7);
  return {
    start: dateFromDay(monday),
    end: dateFromDay(monday + 6),
    timezone: timezoneMetadata(timezone)
  };
}

export function previousCalendarWeek(period) {
  const normalized = validateCalendarWeek(period);
  const start = dayNumber(normalized.start) - 7;
  return { start: dateFromDay(start), end: dateFromDay(start + 6), timezone: normalized.timezone };
}

export function validateCalendarPeriod(period) {
  if (!period || typeof period !== 'object') invalid('overview_invalid_period');
  const start = validateCalendarDate(period.start);
  const end = validateCalendarDate(period.end);
  const durationDays = dayNumber(end) - dayNumber(start) + 1;
  if (durationDays < 1 || durationDays > 366) invalid('overview_invalid_period');
  return { start, end, timezone: timezoneMetadata(period.timezone ?? 'Europe/Moscow') };
}

export function previousCalendarPeriod(period) {
  const normalized = validateCalendarPeriod(period);
  const durationDays = dayNumber(normalized.end) - dayNumber(normalized.start) + 1;
  const end = dayNumber(normalized.start) - 1;
  return {
    start: dateFromDay(end - durationDays + 1),
    end: dateFromDay(end),
    timezone: normalized.timezone
  };
}

export function validateCalendarWeek(period) {
  const normalized = validateCalendarPeriod(period);
  const expected = calendarWeekForDate(normalized.start, { timezone: normalized.timezone });
  if (normalized.start !== expected.start || normalized.end !== expected.end) invalid('overview_invalid_period');
  return expected;
}

function valueFrom(object, camel, snake = camel) {
  if (object && Object.hasOwn(object, camel)) return object[camel];
  return object?.[snake];
}

function requiredText(value, code = 'overview_invalid_envelope') {
  const text = String(value ?? '').trim();
  if (!text) invalid(code);
  return text;
}

function stableMissingReasons(value) {
  if (!Array.isArray(value) || value.some(reason => typeof reason !== 'string' || !reason.trim())) {
    invalid('overview_invalid_missing_reasons');
  }
  return [...new Set(value.map(reason => reason.trim()))].sort((left, right) => {
    const leftRank = MISSING_REASON_RANK.get(left) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = MISSING_REASON_RANK.get(right) ?? Number.MAX_SAFE_INTEGER;
    return leftRank - rightRank || (left < right ? -1 : left > right ? 1 : 0);
  });
}

function normalizeQuality(value) {
  const quality = String(value ?? '');
  if (!QUALITY_VALUES.has(quality)) invalid('overview_invalid_quality');
  return quality;
}

function normalizeScope(envelope) {
  const scope = valueFrom(envelope, 'scope') ?? envelope?.taxReference?.scope ?? 'selected_products';
  const normalized = requiredText(scope, 'overview_invalid_scope');
  return normalized === 'selected_product' ? 'selected_products' : normalized;
}

function normalizeCoverage(envelope, quality) {
  const raw = envelope?.coverage;
  const comparisonKey = valueFrom(envelope, 'coverageKey', 'coverage_key') ?? raw?.comparisonKey ?? raw?.comparison_key ?? null;
  const comparable = raw?.comparable !== false && (quality === 'complete' || comparisonKey !== null);
  const productIds = raw?.productIds ?? raw?.product_ids ?? [];
  if (!Array.isArray(productIds) || productIds.some(productId => typeof productId !== 'string' || !productId.trim())) {
    invalid('overview_invalid_coverage');
  }
  return {
    comparable,
    comparisonKey: comparisonKey === null ? (quality === 'complete' ? 'complete' : null) : requiredText(comparisonKey, 'overview_invalid_coverage'),
    productIds: [...new Set(productIds.map(productId => productId.trim()))].sort()
  };
}

function normalizeLine(line, period, quality) {
  if (!line || typeof line !== 'object') invalid('overview_invalid_line');
  const scope = requiredText(valueFrom(line, 'resultScope', 'result_scope'), 'overview_invalid_line');
  const category = requiredText(valueFrom(line, 'categoryCode', 'category_code'), 'overview_invalid_line');
  const accountingDate = validateCalendarDate(valueFrom(line, 'accountingDate', 'accounting_date'));
  if (accountingDate < period.start || accountingDate > period.end) invalid('overview_line_period_mismatch');
  if (QUALITY_RANK.get(normalizeQuality(line.quality)) > QUALITY_RANK.get(quality)) invalid('overview_line_quality_mismatch');
  const rawProductId=valueFrom(line,'productId','product_id');
  const productId=rawProductId===null||rawProductId===undefined?null:requiredText(rawProductId,'overview_invalid_line');
  return { scope, productId, category, amount: parseScale4Money(valueFrom(line, 'amountSigned', 'amount_signed')) };
}

function buildSituationEvidence(lines,coverage,quality,missingReasons){
  const products=new Map();
  for(const line of lines){
    if(line.scope!=='selected_product'||line.category==='estimated_usn_tax'||!line.productId)continue;
    products.set(line.productId,(products.get(line.productId)??0n)+line.amount);
  }
  const penalty=lines.filter(line=>line.category==='penalty').reduce((sum,line)=>sum+line.amount,0n);
  return{
    productLossEligible:quality==='complete'&&!missingReasons.includes('product_link_missing'),
    coveredProductIds:coverage.productIds,
    productResultsBeforeTax:[...products].sort(([left],[right])=>left.localeCompare(right)).map(([productId,amount])=>({productId,amount:formatScale4Money(amount)})),
    penaltyAmount:formatScale4Money(penalty)
  };
}

function normalizeTotals(value,methodVersion) {
  if (!value || typeof value !== 'object') invalid('overview_invalid_totals');
  const beforeTax = parseScale4Money(value.availableResultBeforeTax);
  if(value.selectedProductsResultBeforeTax!==undefined){
    const selected=parseScale4Money(value.selectedProductsResultBeforeTax);
    const store=value.storeLevelResultBeforeTax===undefined?0n:parseScale4Money(value.storeLevelResultBeforeTax);
    const expected=['financial-result-v7','financial-result-v8','financial-result-v9','financial-result-v10','financial-result-v11','financial-result-v12','financial-result-v13','financial-result-v14','financial-result-v15','financial-result-v16','financial-result-v17','financial-result-v18','financial-result-v19','financial-result-v20','financial-result-v21','financial-result-v22'].includes(methodVersion)?selected+store:selected;
    if(expected!==beforeTax)invalid('overview_total_mismatch');
  }
  return {
    beforeTax,
    estimatedTax: value.estimatedUsnTax === null || value.estimatedUsnTax === undefined ? null : parseScale4Money(value.estimatedUsnTax),
    afterTax: value.availableResultAfterTax === null || value.availableResultAfterTax === undefined ? null : parseScale4Money(value.availableResultAfterTax)
  };
}

function normalizeTax(taxReference, totals, taxLineTotal, hasTaxLines) {
  if (taxReference && taxReference.usable !== taxReference.includedInResult) invalid('overview_tax_mismatch');
  const included = taxReference?.usable === true && taxReference?.includedInResult === true;
  if (!included) {
    if (totals.afterTax !== null || hasTaxLines) invalid('overview_tax_mismatch');
    return { tax: null, afterTax: null, basis: 'before_tax' };
  }
  if (totals.estimatedTax === null || totals.afterTax === null) invalid('overview_tax_mismatch');
  if (taxReference.estimatedTax !== undefined && taxReference.estimatedTax !== null &&
      parseScale4Money(taxReference.estimatedTax) !== totals.estimatedTax) invalid('overview_tax_mismatch');
  if (!hasTaxLines || taxLineTotal !== -totals.estimatedTax) invalid('overview_tax_mismatch');
  if (totals.beforeTax - totals.estimatedTax !== totals.afterTax) invalid('overview_tax_mismatch');
  return { tax: totals.estimatedTax, afterTax: totals.afterTax, basis: 'after_tax' };
}

export function buildFinancialPeriodOverview(envelope, { timezone = 'Europe/Moscow' } = {}) {
  if (!envelope || typeof envelope !== 'object') invalid('overview_invalid_envelope');
  const period = validateCalendarPeriod({
    start: valueFrom(envelope, 'periodStart', 'period_start'),
    end: valueFrom(envelope, 'periodEnd', 'period_end'),
    timezone
  });
  const quality = normalizeQuality(envelope.quality);
  const missingReasons = stableMissingReasons(valueFrom(envelope, 'missingReasons', 'missing_reasons') ?? []);
  if ((quality === 'complete' && missingReasons.length) || (quality === 'partial' && !missingReasons.length)) {
    invalid('overview_quality_mismatch');
  }
  const publicationId = requiredText(valueFrom(envelope, 'publicationId', 'publication_id'));
  const methodVersion = requiredText(valueFrom(envelope, 'methodVersion', 'method_version'));
  const scope = normalizeScope(envelope);
  const coverage = normalizeCoverage(envelope, quality);

  if (quality === 'unavailable') {
    if (envelope.lines?.length || envelope.totals !== null && envelope.totals !== undefined) invalid('overview_unavailable_has_values');
    return {
      publicationId, methodVersion, scope, period, quality, missingReasons, coverage,
      totals: { revenue: null, wbExpenses: null, toTransfer: null, costOfGoods: null, tax: null, availableResultBeforeTax: null, availableResultAfterTax: null },
      displayResult: { amount: null, basis: 'unavailable' },
      situationEvidence:null
    };
  }

  if (!Array.isArray(envelope.lines)) invalid('overview_invalid_lines');
  const lines = envelope.lines.map(line => normalizeLine(line, period, quality));
  const selected = lines.filter(line => line.scope === 'selected_product');
  const beforeTaxLines = selected.filter(line => line.category !== 'estimated_usn_tax');
  const taxLines = selected.filter(line => line.category === 'estimated_usn_tax');
  const selectedTotal = beforeTaxLines.reduce((sum, line) => sum + line.amount, 0n);
  const includesStoreResult = STORE_RESULT_METHODS.has(methodVersion);
  const resultLines = lines.filter(line => (line.scope === 'selected_product' || (includesStoreResult && line.scope === 'store')) && line.category !== 'estimated_usn_tax');
  const revenue = resultLines.filter(line => REVENUE_CATEGORIES.has(line.category)).reduce((sum, line) => sum + line.amount, 0n);
  const costOfGoods = -resultLines.filter(line => line.category === COST_OF_GOODS_CATEGORY).reduce((sum, line) => sum + line.amount, 0n);
  const wbExpenses = -resultLines.filter(line => !REVENUE_CATEGORIES.has(line.category) && line.category !== COST_OF_GOODS_CATEGORY).reduce((sum, line) => sum + line.amount, 0n);
  const wbTransferAdjustments = resultLines.filter(line => WB_TRANSFER_CATEGORIES.has(line.category)).reduce((sum, line) => sum + line.amount, 0n);
  const toTransfer = revenue + wbTransferAdjustments;
  const storeTotal=lines.filter(line=>line.scope==='store'&&line.category!=='estimated_usn_tax').reduce((sum,line)=>sum+line.amount,0n);
  const persisted = normalizeTotals(envelope.totals,methodVersion);
  const calculatedTotal=includesStoreResult?selectedTotal+storeTotal:selectedTotal;
  if(calculatedTotal!==persisted.beforeTax)invalid('overview_total_mismatch');
  const tax = normalizeTax(envelope.taxReference, persisted, taxLines.reduce((sum, line) => sum + line.amount, 0n), taxLines.length > 0);
  const displayAmount = tax.basis === 'after_tax' ? tax.afterTax : persisted.beforeTax;

  return {
    publicationId,
    methodVersion,
    scope,
    period,
    quality,
    missingReasons,
    coverage,
    totals: {
      revenue: formatScale4Money(revenue),
      wbExpenses: formatScale4Money(wbExpenses),
      toTransfer: formatScale4Money(toTransfer),
      costOfGoods: formatScale4Money(costOfGoods),
      tax: tax.tax === null ? null : formatScale4Money(tax.tax),
      availableResultBeforeTax: formatScale4Money(persisted.beforeTax),
      availableResultAfterTax: tax.afterTax === null ? null : formatScale4Money(tax.afterTax)
    },
    displayResult: { amount: formatScale4Money(displayAmount), basis: tax.basis },
    situationEvidence:buildSituationEvidence(lines,coverage,quality,missingReasons)
  };
}

function roundedDivide(numerator, denominator) {
  const negative = numerator < 0n;
  const absolute = negative ? -numerator : numerator;
  let result = absolute / denominator;
  if ((absolute % denominator) * 2n >= denominator) result += 1n;
  return negative ? -result : result;
}

function comparisonReason(current, previous) {
  if (!previous) return 'previous_period_unavailable';
  if (current.quality === 'unavailable' || previous.quality === 'unavailable') return 'result_unavailable';
  if (current.publicationId !== previous.publicationId) return 'different_publication';
  if (current.methodVersion !== previous.methodVersion) return 'different_method_version';
  if (current.scope !== previous.scope) return 'different_scope';
  if (current.displayResult.basis !== previous.displayResult.basis) return 'different_result_basis';
  if (!current.coverage.comparable || !previous.coverage.comparable || current.coverage.comparisonKey !== previous.coverage.comparisonKey) {
    return 'incomparable_coverage';
  }
  return null;
}

export function compareFinancialPeriods(current, previous) {
  const reason = comparisonReason(current, previous);
  const period = previous?.period ?? previousCalendarPeriod(current.period);
  if (reason) return { period, quality: previous?.quality ?? 'unavailable', amount: previous?.displayResult?.amount ?? null, changeAmount: null, changePercent: null, comparable: false, reason };
  const currentAmount = parseScale4Money(current.displayResult.amount);
  const previousAmount = parseScale4Money(previous.displayResult.amount);
  const change = currentAmount - previousAmount;
  const changePercent = previousAmount === 0n ? null : formatScale4Money(roundedDivide(change * 1000000n, previousAmount < 0n ? -previousAmount : previousAmount));
  return {
    period,
    quality: previous.quality,
    amount: previous.displayResult.amount,
    changeAmount: formatScale4Money(change),
    changePercent,
    comparable: true,
    reason: previousAmount === 0n ? 'previous_zero' : null
  };
}

export function buildFinancialOverview({ current, previous = null, timezone = 'Europe/Moscow' }) {
  const currentOverview = buildFinancialPeriodOverview(current, { timezone });
  const expectedPrevious = previousCalendarPeriod(currentOverview.period);
  const previousOverview = previous === null ? null : buildFinancialPeriodOverview(previous, { timezone });
  if (previousOverview && (previousOverview.period.start !== expectedPrevious.start || previousOverview.period.end !== expectedPrevious.end)) {
    invalid('overview_previous_period_mismatch');
  }
  return { ...currentOverview, comparison: compareFinancialPeriods(currentOverview, previousOverview) };
}
