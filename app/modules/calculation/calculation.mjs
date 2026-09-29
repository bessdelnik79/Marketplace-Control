import { createHash } from 'node:crypto';

const MONEY_SCALE = 4;
const RESULT_CATEGORIES = new Set([
  'revenue', 'revenue_return', 'acquiring', 'logistics',
  'storage', 'acceptance', 'penalty', 'deduction', 'commission_adjustment',
  'other_adjustment', 'promotion', 'pickup_reward', 'wb_reward_without_vat', 'wb_reward_vat',
  'return_wb_expense_reversal',
]);
const NON_RESULT_CATEGORIES = new Set(['payout','commission','loyalty_compensation','loyalty_discount_reference','rebill_logistic_compensation']);
const VERIFIED_RECONCILIATION_COMPONENTS = new Map([
  ['payout','forPay'],
  ['commission','ppvzSalesCommission'],
  ['loyalty_discount_reference','cashbackDiscount'],
  ['rebill_logistic_compensation','rebillLogisticCost']
]);
const VERIFIED_WB_COMPONENTS = new Map([
  ['acquiringFee', { category: 'acquiring', operation: 'sale', document: 'продажа', names: new Set(['продажа']) }],
  ['deliveryService', { category: 'logistics', operation: 'service_charge', document: '', names: new Set(['логистика', 'доставка', 'коррекция стоимости доставки']) }],
  ['paidStorage', { category: 'storage', operation: 'service_charge', document: '', names: new Set(['хранение', 'коррекция хранения']) }],
  ['paidAcceptance', { category: 'acceptance', operation: 'service_charge', document: '', names: new Set(['обработка товара']) }],
  ['penalty', { category: 'penalty', operation: 'adjustment', document: '', names: new Set(['штраф']) }],
  ['deduction', { category: 'deduction', operation: 'adjustment', document: '', names: new Set(['удержание']) }]
]);
const VERIFIED_STORE_COMPONENTS = new Map([
  ['retailAmount', new Set(['revenue','revenue_return'])],
  ['acquiringFee', new Set(['acquiring'])],
  ['deliveryService', new Set(['logistics'])],
  ['paidStorage', new Set(['storage'])],
  ['paidAcceptance', new Set(['acceptance'])],
  ['penalty', new Set(['penalty'])],
  ['deduction', new Set(['deduction','promotion'])],
  ['additionalPayment', new Set(['commission_adjustment'])],
  ['vw', new Set(['wb_reward_without_vat'])],
  ['vwNds', new Set(['wb_reward_vat'])],
  ['ppvzReward', new Set(['pickup_reward'])]
]);
const EXPENSE_CATEGORIES = new Set([
  'packaging', 'software_services', 'external_promotion', 'agency_services', 'other_external'
]);
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

function invalid(code = 'calculation_invalid_input') {
  throw new Error(code);
}

function parseDecimal(value, maximumScale, code = 'calculation_invalid_decimal') {
  const text = String(value ?? '').trim();
  const match = text.match(/^([+-]?)(\d+)(?:\.(\d+))?$/);
  if (!match || (match[3]?.length ?? 0) > maximumScale) invalid(code);
  const whole = match[2].replace(/^0+(?=\d)/, '');
  const fraction = (match[3] ?? '').padEnd(maximumScale, '0');
  let scaled = BigInt(`${whole}${fraction}` || '0');
  if (match[1] === '-') scaled = -scaled;
  return scaled;
}

function formatDecimal(scaled, scale = MONEY_SCALE) {
  const negative = scaled < 0n;
  const digits = (negative ? -scaled : scaled).toString().padStart(scale + 1, '0');
  const value = scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  return negative && scaled !== 0n ? `-${value}` : value;
}

function money(value) {
  const text = String(value ?? '').trim();
  const whole = text.match(/^[+-]?(\d+)/)?.[1]?.replace(/^0+(?=\d)/, '');
  if (whole && whole.length > 16) invalid('calculation_money_overflow');
  return parseDecimal(value, MONEY_SCALE, 'calculation_invalid_money');
}

export function normalizeMoney(value) {
  return formatDecimal(money(value));
}

export function isVerifiedWbResultComponent({ categoryCode, sourceField, operationType, docTypeName, sellerOperName, bonusTypeName, rawValue, scopeCode }) {
  const value=String(rawValue??'').trim().replace(',', '.');
  if(!/^-?\d+(?:\.\d+)?$/.test(value)||!/[1-9]/.test(value))return false;
  if(sourceField==='cashbackDiscount')return false;
  if(scopeCode==='store')return VERIFIED_STORE_COMPONENTS.get(sourceField)?.has(categoryCode)===true;
  if(sourceField==='ppvzReward'&&categoryCode==='pickup_reward')return true;
  if(sourceField==='rebillLogisticCost'&&categoryCode==='rebill_logistic_compensation')return false;
  if((sourceField==='vw'&&categoryCode==='wb_reward_without_vat')||(sourceField==='vwNds'&&categoryCode==='wb_reward_vat')){
    const document=String(docTypeName??'').trim();
    const name=String(sellerOperName??'').trim();
    return(operationType==='sale'&&document==='Продажа'&&name==='Продажа')||
      (operationType==='return'&&document==='Возврат'&&name==='Возврат')||
      (operationType==='other'&&document==='Продажа'&&name==='Возмещение за выдачу и возврат товаров на ПВЗ');
  }
  if(sourceField==='deliveryService'&&categoryCode==='logistics'
    &&operationType==='service_charge'&&value.startsWith('-'))return true;
  if(value.startsWith('-'))return false;
  if (sourceField === 'retailAmount') {
    return (categoryCode === 'revenue' && operationType === 'sale') ||
      (categoryCode === 'revenue_return' && operationType === 'return');
  }
  if (sourceField === 'deduction' && categoryCode === 'promotion' && operationType === 'adjustment') {
    return String(docTypeName ?? '').trim() === '' && String(sellerOperName ?? '').trim() === 'Удержание' &&
      /^Оказание услуг «WB Продвижение», документ №\d+$/.test(String(bonusTypeName ?? '').trim());
  }
  const rule = VERIFIED_WB_COMPONENTS.get(sourceField);
  if (!rule || rule.category !== categoryCode || rule.operation !== operationType) return false;
  const document = String(docTypeName ?? '').trim().toLocaleLowerCase('ru-RU');
  const name = String(sellerOperName ?? '').trim().toLocaleLowerCase('ru-RU');
  return document === rule.document && rule.names.has(name);
}

function validDate(value) {
  const text = String(value ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) invalid('calculation_invalid_date');
  const [year, month, day] = text.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) invalid('calculation_invalid_date');
  return text;
}

function dateNumber(value) {
  const [year, month, day] = validDate(value).split('-').map(Number);
  return Math.trunc(Date.UTC(year, month - 1, day) / 86400000);
}

function dateFromNumber(value) {
  return new Date(value * 86400000).toISOString().slice(0, 10);
}

function period(start, end) {
  start = validDate(start);
  end = validDate(end);
  if (end < start) invalid('calculation_invalid_period');
  return { start, end, startDay: dateNumber(start), endDay: dateNumber(end) };
}

function requiredId(value) {
  const id = String(value ?? '').trim();
  if (!id) invalid('calculation_source_id_missing');
  return id;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(stable(value));
}

function sortedUnique(values) {
  return [...new Set((values ?? []).map(value => requiredId(value)))].sort();
}

export function createInputFingerprint({
  resultMethodVersion,
  selectedProductIds = [],
  reportVersionIds = [],
  reportNormalizationIds = [],
  emptyWeekCoverageIds = [],
  costVersionIds = [],
  operationLinkIds = [],
  expenseVersionIds = [],
  taxSettingVersionIds = [],
  periodStart,
  periodEnd
}) {
  const range = period(periodStart, periodEnd);
  const payload = {
    result_method_version: requiredId(resultMethodVersion),
    selection_snapshot_product_ids_sorted: sortedUnique(selectedProductIds),
    report_version_ids_sorted: sortedUnique(reportVersionIds),
    report_normalization_ids_sorted: sortedUnique(reportNormalizationIds),
    empty_week_coverage_ids_sorted: sortedUnique(emptyWeekCoverageIds),
    cost_version_ids_sorted: sortedUnique(costVersionIds),
    operation_link_ids_sorted: sortedUnique(operationLinkIds),
    expense_version_ids_sorted: sortedUnique(expenseVersionIds),
    tax_setting_version_ids_sorted: sortedUnique(taxSettingVersionIds),
    period_start: range.start,
    period_end: range.end
  };
  return createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex');
}

// Seller-directed USN estimate for the frozen SKU selection. Cashback
// compensation already included in Sale must not be added a second time.
export function calculateStoreTaxReference({ periodStart, periodEnd, selectedProductIds = [], sourceRows = [], taxSettings = [], reportCoverageComplete = true }) {
  const range = period(periodStart, periodEnd);
  const reasons = new Set();
  const selected = new Set(sortedUnique(selectedProductIds));
  if (!reportCoverageComplete) reasons.add('report_coverage_incomplete');
  const settings = taxSettings.map(setting => ({
    ...setting,
    id: requiredId(setting.id),
    effectiveFrom: validDate(setting.effectiveFrom),
    state: setting.state ?? 'active'
  })).sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom) || a.id.localeCompare(b.id));
  for (let i = 1; i < settings.length; i++) {
    if (settings[i].effectiveFrom === settings[i - 1].effectiveFrom) invalid('calculation_ambiguous_tax_setting');
  }
  const effectiveSegments=[];
  for(let index=0;index<settings.length;index++){
    const setting=settings[index];
    const next=settings[index+1];
    const segmentStart=setting.effectiveFrom>range.start?setting.effectiveFrom:range.start;
    const segmentEnd=next&&next.effectiveFrom<=range.end?dateFromNumber(dateNumber(next.effectiveFrom)-1):range.end;
    if(segmentStart<=segmentEnd)effectiveSegments.push({setting,segmentStart,segmentEnd});
  }
  if(!effectiveSegments.length||effectiveSegments[0].segmentStart!==range.start)reasons.add('tax_setting_missing');
  for(const {setting} of effectiveSegments){
    if(setting.state==='voided')reasons.add('tax_setting_missing');
    else if(setting.regimeCode!=='usn_income')reasons.add('tax_method_unsupported');
    else if(setting.vatMode!=null&&setting.vatMode!=='exempt')reasons.add('vat_method_unsupported');
  }
  const segments = new Map();
  const seen = new Set();
  for (const row of sourceRows) {
    const id = uniqueSource(seen, row?.id, 'financial_component');
    if (row?.state === 'withdrawn') continue;
    const accountingDate = validDate(row?.accountingDate);
    if (accountingDate < range.start || accountingDate > range.end) continue;
    const raw = row?.retailAmount;
    const productId = row?.productId == null ? null : String(row.productId);
    const document = String(row?.docTypeName ?? '').trim().toLocaleLowerCase('ru-RU');
    const operation = String(row?.sellerOperName ?? '').trim().toLocaleLowerCase('ru-RU');
    const isSaleOrReturn = (document === 'продажа' && operation === 'продажа') || (document === 'возврат' && operation === 'возврат');
    if (!productId && /^\d+$/.test(String(row?.wbArticle??'').trim()) && !/^0+$/.test(String(row?.wbArticle??'').trim())) continue;
    if (!productId) {
      if (isSaleOrReturn) reasons.add('tax_source_unlinked');
      if (isSaleOrReturn && (raw === null || raw === undefined || raw === '')) reasons.add('tax_source_unverified');
      if (raw !== null && raw !== undefined && raw !== '') {
        const text = String(raw).trim();
        if (!/^[+-]?\d+(?:[.,]\d{1,4})?$/.test(text) || money(text.replace(',', '.')) !== 0n) reasons.add('tax_source_unlinked');
      }
      continue;
    }
    if (!selected.has(productId)) continue;
    if (raw === null || raw === undefined || raw === '') {
      if (isSaleOrReturn) reasons.add('tax_source_unverified');
      continue;
    }
    if (!/^[+-]?\d+(?:[.,]\d{1,4})?$/.test(String(raw).trim())) { reasons.add('tax_source_unverified'); continue; }
    const value = money(String(raw).replace(',', '.'));
    let sign;
    if (document === 'продажа' && operation === 'продажа') sign = 1n;
    else if (document === 'возврат' && operation === 'возврат') sign = -1n;
    else { reasons.add('tax_source_unverified'); continue; }
    if (value < 0n) { reasons.add('tax_source_unverified'); continue; }
    const effective=effectiveSegments.find(item=>accountingDate>=item.segmentStart&&accountingDate<=item.segmentEnd);
    const setting = effective?.setting;
    if (!setting) { reasons.add('tax_setting_missing'); continue; }
    if(setting.state==='voided'){reasons.add('tax_setting_missing');continue;}
    if (setting.regimeCode !== 'usn_income') { reasons.add('tax_method_unsupported'); continue; }
    const rateText = String(setting.usnRateFraction ?? '').trim();
    const canonicalRate = rateText.includes('.') ? rateText.replace(/0+$/, '').replace(/\.$/, '') : rateText;
    const rate = parseDecimal(canonicalRate, 8, 'calculation_invalid_tax_rate');
    if (rate < 0n || rate > 100000000n) invalid('calculation_invalid_tax_rate');
    const key = `${productId}:${setting.id}:${effective.segmentStart}:${effective.segmentEnd}`;
    const segment = segments.get(key) ?? { productId, taxSettingVersionId: setting.id, segmentStart:effective.segmentStart,segmentEnd:effective.segmentEnd, rateFraction: formatDecimal(rate, 8), base: 0n, evidence: [] };
    const amount = sign * value;
    segment.base += amount;
    segment.evidence.push({ sourceId: id, accountingDate, contributionAmount: formatDecimal(amount) });
    segments.set(key, segment);
  }
  for(const productId of selected)for(const effective of effectiveSegments){
    const setting=effective.setting;
    if(setting.state!=='active'||setting.regimeCode!=='usn_income')continue;
    const rateText=String(setting.usnRateFraction??'').trim();
    const canonicalRate=rateText.includes('.')?rateText.replace(/0+$/,'').replace(/\.$/,''):rateText;
    const rate=parseDecimal(canonicalRate,8,'calculation_invalid_tax_rate');
    const key=`${productId}:${setting.id}:${effective.segmentStart}:${effective.segmentEnd}`;
    if(!segments.has(key))segments.set(key,{productId,taxSettingVersionId:setting.id,segmentStart:effective.segmentStart,segmentEnd:effective.segmentEnd,rateFraction:formatDecimal(rate,8),base:0n,evidence:[]});
  }
  let base = 0n;
  const products = new Map();
  const rows = [...segments.values()].sort((a, b) => a.productId.localeCompare(b.productId) || a.segmentStart.localeCompare(b.segmentStart) || a.taxSettingVersionId.localeCompare(b.taxSettingVersionId));
  for (const segment of rows) {
    base += segment.base;
    const product = products.get(segment.productId) ?? { productId: segment.productId, base: 0n, numerator: 0n };
    product.base += segment.base;
    product.numerator += segment.base * parseDecimal(segment.rateFraction, 8);
    products.set(segment.productId, product);
    segment.taxableBase = formatDecimal(segment.base);
    segment.evidence.sort((a, b) => a.accountingDate.localeCompare(b.accountingDate) || a.sourceId.localeCompare(b.sourceId));
    delete segment.base;
  }
  // Round once per selected SKU, after all its effective-dated rates.
  let tax = 0n;
  const productTotals = [...products.values()].sort((a, b) => a.productId.localeCompare(b.productId)).map(product => {
    const amount = product.numerator >= 0n ? (product.numerator + 50000000n) / 100000000n : -((-product.numerator + 50000000n) / 100000000n);
    tax += amount;
    return { productId: product.productId, taxableBase: formatDecimal(product.base), estimatedTax: formatDecimal(amount) };
  });
  if (base < 0n || tax < 0n) reasons.add('tax_base_negative_unverified');
  if (selected.size === 0) reasons.add('tax_base_missing');
  const usable = rows.length > 0 && !['report_coverage_incomplete', 'tax_setting_missing', 'tax_method_unsupported', 'tax_source_unverified', 'tax_source_unlinked', 'tax_base_missing', 'tax_base_negative_unverified'].some(reason => reasons.has(reason));
  return {
    scope: 'selected_products', method: 'seller_defined_usn_income_selected_line1_estimate', quality: reasons.size ? 'partial' : 'complete',
    missingReasons: [...reasons].sort(), taxableBase: usable ? formatDecimal(base) : null,
    estimatedTax: usable ? formatDecimal(tax) : null, usable, products: productTotals, computations: productTotals, segments: rows
  };
}

export function periodizeExpense(expense, calculationPeriod = null) {
  const id = requiredId(expense?.id);
  const expensePeriod = period(expense?.periodStart, expense?.periodEnd);
  const amount = money(expense?.amount);
  if (amount <= 0n) invalid('calculation_invalid_expense_amount');
  const method = expense?.recognitionMethod;
  if (!['on_date', 'evenly_over_period'].includes(method)) invalid('calculation_invalid_recognition_method');
  if (method === 'on_date' && expensePeriod.start !== expensePeriod.end) invalid('calculation_on_date_period_mismatch');

  const numberOfDays = BigInt(expensePeriod.endDay - expensePeriod.startDay + 1);
  const base = amount / numberOfDays;
  const last = amount - base * (numberOfDays - 1n);
  const window = calculationPeriod ? period(calculationPeriod.periodStart, calculationPeriod.periodEnd) : expensePeriod;
  const firstDay = Math.max(expensePeriod.startDay, window.startDay);
  const finalDay = Math.min(expensePeriod.endDay, window.endDay);
  if (finalDay < firstDay) return [];

  const result = [];
  for (let day = firstDay; day <= finalDay; day += 1) {
    const contribution = method === 'on_date' || day === expensePeriod.endDay ? last : base;
    result.push({
      expenseVersionId: id,
      accountingDate: dateFromNumber(day),
      amountSigned: formatDecimal(-contribution)
    });
  }
  return result;
}

function roundedProductToMoney(leftValue, rightMoney) {
  const leftText = String(leftValue ?? '').trim();
  const match = leftText.match(/^([+-]?)(\d+)(?:\.(\d+))?$/);
  if (!match || (match[3]?.length ?? 0) > 6) invalid('calculation_invalid_quantity');
  const scale = match[3]?.length ?? 0;
  const left = parseDecimal(leftText, scale, 'calculation_invalid_quantity');
  const product = left * rightMoney;
  const divisor = 10n ** BigInt(scale);
  const absolute = product < 0n ? -product : product;
  let quotient = absolute / divisor;
  const remainder = absolute % divisor;
  if (remainder * 2n >= divisor) quotient += 1n;
  return product < 0n ? -quotient : quotient;
}

function compareEvidence(a, b) {
  return a.sourceType.localeCompare(b.sourceType) || a.sourceId.localeCompare(b.sourceId);
}

function lineKey(line) {
  return canonicalJson({
    scopeCode: line.scopeCode,
    productId: line.productId,
    variantId: line.variantId,
    accountingDate: line.accountingDate,
    categoryCode: line.categoryCode
  });
}

function addLine(lines, line, amount, evidence) {
  if (amount === 0n) return;
  const key = lineKey(line);
  const current = lines.get(key) ?? { ...line, amount: 0n, evidence: [] };
  current.amount += amount;
  current.evidence.push(evidence);
  lines.set(key, current);
}

function sourceInPeriod(source, range) {
  const date = validDate(source?.accountingDate);
  return date >= range.start && date <= range.end;
}

function validateScopeStructure(source) {
  if (source?.scopeCode === 'store' && (source.productId != null || source.variantId != null)) {
    invalid('calculation_store_scope_contradiction');
  }
}

function resolveScope(source, selected, reasons) {
  validateScopeStructure(source);
  if (source?.scopeCode === 'store') {
    return { scopeCode: 'store', productId: null, variantId: null };
  }
  if (source?.scopeCode === 'product_expected') {
    reasons.add('product_link_missing');
    return null;
  }
  if (source?.scopeCode !== 'selected_product') invalid('calculation_invalid_scope');
  if (!source.productId) {
    reasons.add('product_link_missing');
    return null;
  }
  const productId = String(source.productId);
  if (!selected.has(productId)) return null;
  return { scopeCode: 'selected_product', productId, variantId: source.variantId == null ? null : String(source.variantId) };
}

function selectCost(costVersions, variantId, accountingDate) {
  const candidates = costVersions.filter(cost =>
    cost?.state !== 'voided' &&
    String(cost?.variantId ?? '') === variantId &&
    validDate(cost?.effectiveFrom) <= accountingDate
  );
  candidates.sort((a, b) =>
    validDate(b.effectiveFrom).localeCompare(validDate(a.effectiveFrom)) ||
    requiredId(b.id).localeCompare(requiredId(a.id))
  );
  if (candidates.length > 1 && validDate(candidates[0].effectiveFrom) === validDate(candidates[1].effectiveFrom)) {
    invalid('calculation_ambiguous_cost_version');
  }
  return candidates[0] ?? null;
}

function uniqueSource(seen, value, sourceType) {
  const id = requiredId(value);
  const key = `${sourceType}:${id}`;
  if (seen.has(key)) invalid('calculation_duplicate_source');
  seen.add(key);
  return id;
}

function orderedReasons(reasons) {
  return [...reasons].sort((a, b) =>
    (MISSING_REASON_RANK.get(a) ?? Number.MAX_SAFE_INTEGER) - (MISSING_REASON_RANK.get(b) ?? Number.MAX_SAFE_INTEGER) || a.localeCompare(b)
  );
}

function isVerifiedNonResultComponent(component){
  if(component?.categoryCode==='loyalty_compensation'){
    return component?.sourceField==='cashbackDiscount'
      &&['selected_product','store'].includes(component?.scopeCode);
  }
  return component?.scopeCode==='reconciliation'
    &&VERIFIED_RECONCILIATION_COMPONENTS.get(component?.categoryCode)===component?.sourceField;
}

function isTransportReimbursementComponent(component){
  const fieldMatches=(component?.sourceField==='vw'&&component?.categoryCode==='wb_reward_without_vat')
    ||(component?.sourceField==='vwNds'&&component?.categoryCode==='wb_reward_vat')
    ||(component?.sourceField==='rebillLogisticCost'&&component?.categoryCode==='rebill_logistic_compensation');
  const rawValue=String(component?.rawValue??'').trim().replace(',', '.');
  return fieldMatches
    &&/^-?\d+(?:\.\d+)?$/.test(rawValue)
    &&/[1-9]/.test(rawValue);
}

function verifiedTransportReimbursementReferenceIds(components){
  const groups=new Map();
  for(const component of components){
    if(!isTransportReimbursementComponent(component))continue;
    const operationId=String(component?.operationVersionId??'').trim();
    if(!operationId)continue;
    const group=groups.get(operationId)??[];
    group.push(component);
    groups.set(operationId,group);
  }
  const verified=new Set();
  for(const group of groups.values()){
    const fields=new Set(group.map(component=>component.sourceField));
    if(group.length!==3||fields.size!==3
      ||!fields.has('rebillLogisticCost')||!fields.has('vw')||!fields.has('vwNds'))continue;
    const net=group.reduce((sum,component)=>sum+money(component.amountSigned),0n);
    if(net!==0n)continue;
    for(const component of group){
      if(component.sourceField==='vw'||component.sourceField==='vwNds')verified.add(String(component.id));
    }
  }
  return verified;
}

const RETURN_WB_EXPENSE_FIELDS=new Set(['acquiringFee','vw','vwNds','ppvzReward']);
const RETURN_REPLACED_EXPENSE_FIELDS=new Set(['vw','vwNds','ppvzReward']);
const RETURN_RAW_SCALE=18;

function rawReturnAmount(value){
  if(value===null||value===undefined||String(value).trim()==='')return 0n;
  return parseDecimal(String(value).trim().replace(',','.'),RETURN_RAW_SCALE,'calculation_invalid_return_expense');
}

function roundReturnAmountToMoney(value){
  const divisor=10n**BigInt(RETURN_RAW_SCALE-2),absolute=value<0n?-value:value;
  const kopecks=(absolute+divisor/2n)/divisor;
  return(value<0n?-kopecks:kopecks)*100n;
}

export function calculateReturnWbExpenseReversal(components){
  const fields=new Map();
  for(const component of components??[]){
    const field=String(component?.sourceField??'');
    if(!RETURN_WB_EXPENSE_FIELDS.has(field)&&!['retailAmount','forPay'].includes(field))continue;
    if(fields.has(field))invalid('calculation_ambiguous_return_expense');
    fields.set(field,rawReturnAmount(component.rawValue));
  }
  if(!fields.has('retailAmount')||!fields.has('forPay'))return null;
  const expense=[...RETURN_WB_EXPENSE_FIELDS].reduce((sum,field)=>sum+(fields.get(field)??0n),0n);
  const control=fields.get('retailAmount')-fields.get('forPay');
  const rounded=roundReturnAmountToMoney(expense);
  return rounded===roundReturnAmountToMoney(control)?rounded:null;
}

function totalsFor(lines,taxUsable=false) {
  let selected = 0n, store = 0n, tax=0n;
  for (const line of lines) {
    const amount = money(line.amountSigned);
    if(line.categoryCode==='estimated_usn_tax'){tax+=-amount;continue;}
    if (line.scopeCode === 'selected_product') selected += amount;
    else if (line.scopeCode === 'store') store += amount;
  }
  return {
    selectedProductsResultBeforeTax: formatDecimal(selected),
    storeLevelResultBeforeTax: formatDecimal(store),
    availableResultBeforeTax: formatDecimal(selected+store),
    estimatedUsnTax:formatDecimal(tax),
    availableResultAfterTax: taxUsable?formatDecimal(selected+store-tax):null,
    netProfit: null
  };
}

export function calculateFinancialResult({
  periodStart,
  periodEnd,
  resultMethodVersion = 'financial-result-v28',
  selectedProductIds = [],
  financialComponents = [],
  operations = [],
  operationLinks = [],
  costVersions = [],
  expenses = [],
  taxSetting = null,
  taxReference = null,
  reportCoverageComplete = true,
  allowEmptyResult = false
}) {
  const range = period(periodStart, periodEnd);
  const selected = new Set(selectedProductIds.map(value => requiredId(value)));
  const reasons = new Set();
  const lines = new Map();
  const seenSources = new Set();
  const transportReimbursementReferences=verifiedTransportReimbursementReferenceIds(financialComponents);

  const operationsById = new Map();
  for (const operation of operations) {
    const id = String(operation?.id ?? '').trim();
    if (!id) continue;
    const matches = operationsById.get(id) ?? [];
    matches.push(operation);
    operationsById.set(id, matches);
  }
  const signedReturnExpenseMethod=['financial-result-v25','financial-result-v26','financial-result-v27','financial-result-v28'].includes(resultMethodVersion);
  const retainReturnAcquiringMethod=['financial-result-v25','financial-result-v26'].includes(resultMethodVersion);
  const replacedReturnExpenseFields=retainReturnAcquiringMethod?RETURN_REPLACED_EXPENSE_FIELDS:RETURN_WB_EXPENSE_FIELDS;
  const componentsByOperation=new Map();
  for(const component of financialComponents){
    const operationId=String(component?.operationVersionId??'').trim();
    if(!operationId)continue;
    const group=componentsByOperation.get(operationId)??[];
    group.push(component);componentsByOperation.set(operationId,group);
  }
  const excludedProduct = source => {
    const wbArticle=String(source?.wbArticle??'').trim();
    if(!/^\d+$/.test(wbArticle)||/^0+$/.test(wbArticle))return false;
    if(source?.productId&&selected.has(String(source.productId)))return false;
    return true;
  };
  const confirmedReturnSale = operation => {
    const operationId=String(operation?.id??'');
    const possibleLinks=operationLinks.filter(link=>String(link?.fromOperationVersionId??'')===operationId
      &&link?.linkType==='return_to_original_sale'&&link?.status!=='rejected');
    if(possibleLinks.length!==1||possibleLinks[0]?.status!=='confirmed')return null;
    const link=possibleLinks[0];
    const linkedSales=operationsById.get(String(link?.toOperationVersionId??''))??[];
    const sale=linkedSales.length===1?linkedSales[0]:null;
    if(!sale||sale?.state==='withdrawn'||sale?.operationType!=='sale'
      ||String(sale?.productId??'')!==String(operation?.productId??'')
      ||String(sale?.variantId??'')!==String(operation?.variantId??'')
      ||validDate(sale?.accountingDate)>validDate(operation?.accountingDate))return null;
    return{link,sale};
  };
  const returnExpenseComponentIds=new Set();
  for(const component of financialComponents){
    if(component?.operationType!=='return'||!replacedReturnExpenseFields.has(component?.sourceField))continue;
    const operationId=String(component?.operationVersionId??'').trim();
    const operationCandidates=operationsById.get(operationId)??[];
    if(!signedReturnExpenseMethod||(operationCandidates.length===1&&confirmedReturnSale(operationCandidates[0])))returnExpenseComponentIds.add(String(component.id));
  }

  for (const component of financialComponents) {
    if (component?.state === 'withdrawn' || !sourceInPeriod(component, range)) continue;
    const componentId = uniqueSource(seenSources, component?.id, 'financial_component');
    validateScopeStructure(component);
    if(excludedProduct(component))continue;
    if (component?.productId && !selected.has(String(component.productId))) continue;
    if(returnExpenseComponentIds.has(String(componentId)))continue;
    if (NON_RESULT_CATEGORIES.has(component?.categoryCode)) {
      if(!isVerifiedNonResultComponent(component))reasons.add('operation_unclassified');
      continue;
    }
    if(transportReimbursementReferences.has(String(componentId)))continue;
    if (component?.scopeCode === 'reconciliation') {
      reasons.add('operation_unclassified');
      continue;
    }
    const rawComponentValue=String(component?.rawValue??'').trim().replace(',', '.');
    const retainedReturnAcquiring=retainReturnAcquiringMethod&&component?.operationType==='return'
      &&component?.sourceField==='acquiringFee'&&component?.categoryCode==='acquiring'
      &&String(component?.docTypeName??'').trim()==='Возврат'&&String(component?.sellerOperName??'').trim()==='Возврат'
      &&/^-?\d+(?:\.\d+)?$/.test(rawComponentValue)&&/[1-9]/.test(rawComponentValue);
    if (component?.classificationStatus !== 'confirmed'&&!retainedReturnAcquiring) {
      reasons.add('operation_unclassified');
      continue;
    }
    if (component?.reconciliationStatus === 'failed') {
      reasons.add('source_unreconciled');
      continue;
    }
    if (!RESULT_CATEGORIES.has(component?.categoryCode)) {
      reasons.add('operation_unclassified');
      continue;
    }
    const scope = resolveScope(component, selected, reasons);
    if (!scope) continue;
    const amount = money(component.amountSigned);
    addLine(lines, {
      ...scope,
      accountingDate: validDate(component.accountingDate),
      categoryCode: component.categoryCode
    }, amount, {
      sourceType: 'financial_component',
      sourceId: componentId,
      contributionAmount: formatDecimal(amount)
    });
  }

  for (const operation of operations) {
    if (operation?.state === 'withdrawn' || !sourceInPeriod(operation, range)) continue;
    const operationId = uniqueSource(seenSources, operation?.id, 'operation');
    if (!['sale', 'return'].includes(operation?.operationType)) continue;
    if(excludedProduct(operation))continue;
    const scope = resolveScope({ ...operation, scopeCode: operation.scopeCode ?? 'selected_product' }, selected, reasons);
    if (!scope) continue;
    if (operation.operationType === 'return') {
      const confirmed=confirmedReturnSale(operation);
      if (!confirmed) {
        reasons.add('return_original_sale_unmatched');
        continue;
      }
      const {link,sale}=confirmed;
      const returnDate = validDate(operation.accountingDate);
      const reversal=calculateReturnWbExpenseReversal(componentsByOperation.get(operationId)??[]);
      if(reversal===null||(!signedReturnExpenseMethod&&reversal<=0n))reasons.add('operation_unclassified');
      else addLine(lines,{
        ...scope,accountingDate:returnDate,categoryCode:'return_wb_expense_reversal'
      },reversal,{
        sourceType:'return_expense_reversal',sourceId:operationId,reportRowId:requiredId(operation.reportRowId),
        operationLinkId:requiredId(link.id),contributionAmount:formatDecimal(reversal)
      });
      const saleDate = validDate(sale.accountingDate);
      const cost = selectCost(costVersions, String(sale.variantId), saleDate);
      if (!cost) {
        reasons.add('cost_missing');
        continue;
      }
      const unitCost = money(cost.unitCost);
      if (unitCost < 0n) invalid('calculation_invalid_cost');
      let cogs = roundedProductToMoney(operation.quantity, unitCost);
      if (cogs < 0n) cogs = -cogs;
      addLine(lines, {
        ...scope,
        accountingDate: returnDate,
        categoryCode: 'cost_of_goods'
      }, cogs, {
        sourceType: 'return_cost',
        sourceId: operationId,
        originalSaleOperationId: requiredId(sale.id),
        operationLinkId: requiredId(link.id),
        costVersionId: requiredId(cost.id),
        quantity: String(operation.quantity),
        unitCost: formatDecimal(unitCost),
        contributionAmount: formatDecimal(cogs)
      });
      continue;
    }
    if (!scope.variantId) {
      reasons.add('product_link_missing');
      continue;
    }
    const accountingDate = validDate(operation.accountingDate);
    const cost = selectCost(costVersions, scope.variantId, accountingDate);
    if (!cost) {
      reasons.add('cost_missing');
      continue;
    }
    const unitCost = money(cost.unitCost);
    if (unitCost < 0n) invalid('calculation_invalid_cost');
    let cogs = roundedProductToMoney(operation.quantity, unitCost);
    if (cogs < 0n) cogs = -cogs;
    cogs = -cogs;
    addLine(lines, {
      ...scope,
      accountingDate,
      categoryCode: 'cost_of_goods'
    }, cogs, {
      sourceType: 'sale_cost',
      sourceId: operationId,
      costVersionId: requiredId(cost.id),
      quantity: String(operation.quantity),
      unitCost: formatDecimal(unitCost),
      contributionAmount: formatDecimal(cogs)
    });
  }

  for (const expense of expenses) {
    if (expense?.state === 'voided') continue;
    const expenseCategory = String(expense?.category ?? '');
    if (!EXPENSE_CATEGORIES.has(expenseCategory)) invalid('calculation_invalid_expense_category');
    const dailyRows = periodizeExpense(expense, { periodStart: range.start, periodEnd: range.end });
    if (dailyRows.length === 0) continue;
    uniqueSource(seenSources, expense?.id, 'expense_version');
    validateScopeStructure(expense);
    const scope = resolveScope(expense, selected, reasons);
    if (!scope) continue;
    for (const daily of dailyRows) {
      const amount = money(daily.amountSigned);
      addLine(lines, {
        ...scope,
        accountingDate: daily.accountingDate,
        categoryCode: expenseCategory
      }, amount, {
        sourceType: 'expense_version',
        sourceId: requiredId(expense.id),
        contributionAmount: formatDecimal(amount)
      });
    }
  }

  if (!reportCoverageComplete) reasons.add('report_coverage_incomplete');
  if(taxReference){
    for(const reason of taxReference.missingReasons)reasons.add(reason);
    if(taxReference.usable)for(const product of taxReference.products){
      const amount=money(product.estimatedTax);
      addLine(lines,{scopeCode:'selected_product',productId:product.productId,variantId:null,accountingDate:range.end,categoryCode:'estimated_usn_tax'},-amount,{sourceType:'tax_computation',productId:product.productId,contributionAmount:formatDecimal(-amount)});
    }
    if(taxSetting&&taxSetting.vatMode!=='exempt')reasons.add('vat_method_unsupported');
  }else if (!taxSetting) reasons.add('tax_setting_missing');
  else {
    reasons.add(taxSetting.regimeCode === 'usn_income' ? 'tax_selected_reference_only' : 'tax_method_unsupported');
    if (taxSetting.vatMode !== 'exempt') reasons.add('vat_method_unsupported');
  }

  const resultLines = [...lines.values()]
    .filter(line => line.amount !== 0n)
    .map(line => ({
      scopeCode: line.scopeCode,
      productId: line.productId,
      variantId: line.variantId,
      accountingDate: line.accountingDate,
      categoryCode: line.categoryCode,
      amountSigned: formatDecimal(line.amount),
      evidence: line.evidence.sort(compareEvidence)
    }))
    .sort((a, b) =>
      a.accountingDate.localeCompare(b.accountingDate) ||
      a.scopeCode.localeCompare(b.scopeCode) ||
      String(a.productId ?? '').localeCompare(String(b.productId ?? '')) ||
      String(a.variantId ?? '').localeCompare(String(b.variantId ?? '')) ||
      a.categoryCode.localeCompare(b.categoryCode)
    );

  const missingReasons = orderedReasons(reasons);
  if (resultLines.length === 0 && reportCoverageComplete && allowEmptyResult) {
    return {
      quality: missingReasons.length ? 'partial' : 'complete',
      missingReasons,
      lines: [],
      totals: totalsFor([], taxReference?.usable === true)
    };
  }
  if (resultLines.length === 0) {
    return { quality: 'unavailable', missingReasons, lines: [], totals: null };
  }
  return {
    quality: missingReasons.length ? 'partial' : 'complete',
    missingReasons,
    lines: resultLines,
    totals: totalsFor(resultLines,Boolean(taxReference?.usable))
  };
}
