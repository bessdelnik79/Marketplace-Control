import { validateCalendarPeriod } from '../overview/financial-overview.mjs';

const revenueCategories = new Set(['revenue', 'revenue_return']);
function validPeriod(start, end) {
  try { validateCalendarPeriod({start, end}); return true; } catch { return false; }
}

function quantity(value) {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  const amount = BigInt(whole + fraction);
  if (amount <= 0n) return null;
  return {amount, scale: fraction.length};
}
function canonical(value) {
  const digits = value.amount.toString().padStart(value.scale + 1, '0');
  return value.scale ? `${digits.slice(0, -value.scale)}.${digits.slice(-value.scale)}`.replace(/\.?0+$/, '') : digits;
}
function financialQuantities(pages, input, productId) {
  const unavailable = quantityReason => ({soldQuantity:null, returnedQuantity:null, quantityReason});
  if (!validPeriod(input.periodStart, input.periodEnd)) return unavailable('situation_sale_quantity_unverified');
  if (!pages.length) return unavailable('situation_revenue_groups_missing');
  if (pages.some(({page}) => page.nextCursor || page.items.length !== page.totalItems)) return unavailable('situation_revenue_page_incomplete');
  if (pages.some(({page}) => page.reconciliation?.status !== 'matched' || page.moneyReconciliation?.status !== 'matched')) return unavailable('drilldown_reconciliation_mismatch');
  if (pages.some(({page}) => page.evidenceStatus !== 'matched' || page.items.some(row => row.evidenceStatus !== 'matched' || !row.source))) return unavailable('drilldown_frozen_source_missing');
  const operations = new Map();
  const totals = {sale:{amount:0n, scale:0}, return:{amount:0n, scale:0}};
  for (const {group, page} of pages) for (const row of page.items) {
    const source = row.source;
    const expectedType = group.categoryCode === 'revenue' ? 'sale' : 'return';
    if (!source.operationVersionId || source.operationType !== expectedType || source.productId !== productId
      || !validPeriod(source.accountingDate, source.accountingDate)
      || source.accountingDate < input.periodStart || source.accountingDate > input.periodEnd) return unavailable('situation_sale_quantity_unverified');
    const operationQuantity = expectedType === 'return'
      ? typeof source.quantity === 'string' && source.quantity.startsWith('-') ? quantity(source.quantity.slice(1)) : null
      : quantity(source.quantity);
    if (!operationQuantity) return unavailable('situation_sale_quantity_unverified');
    const signature = JSON.stringify([source.operationType, canonical(operationQuantity),
      source.accountingDate, source.productId, source.variantId, source.reportRowId, source.reportVersionId, source.reportNormalizationId]);
    if (operations.has(source.operationVersionId)) {
      if (operations.get(source.operationVersionId) !== signature) return unavailable('situation_sale_operation_inconsistent');
      continue;
    }
    operations.set(source.operationVersionId, signature);
    const total = totals[expectedType], nextScale = Math.max(total.scale, operationQuantity.scale);
    total.amount = total.amount * 10n ** BigInt(nextScale - total.scale) + operationQuantity.amount * 10n ** BigInt(nextScale - operationQuantity.scale);
    total.scale = nextScale;
  }
  const hasSales = pages.some(({group}) => group.categoryCode === 'revenue');
  return {soldQuantity:hasSales ? canonical(totals.sale) : null, returnedQuantity:canonical(totals.return),
    quantityReason:hasSales ? null : 'situation_revenue_groups_missing'};
}

export async function readSituationRevenuePreview(userId, input, item, readPublishedContributions) {
  const groups = item.groups.filter(group => revenueCategories.has(group.categoryCode));
  const pages = await Promise.all(groups.map(async group => ({group, page:await readPublishedContributions(userId,
    {...input, productId:item.productId, groupKey:group.groupKey, cursor:null, limit:100})})));
  const rows = pages.flatMap(({group, page}) => page.items.map(row => ({...row,
    source:row.evidenceStatus === 'matched' && page.reconciliation?.status === 'matched' ? row.source : null,
    groupKey:group.groupKey, categoryCode:group.categoryCode})))
    .sort((a, b) => (a.source?.accountingDate ?? '\uffff').localeCompare(b.source?.accountingDate ?? '\uffff') || a.id.localeCompare(b.id));
  return {storeId:input.storeId, productId:item.productId, period:{start:input.periodStart, end:input.periodEnd},
    rows:rows.slice(0, 10), groups:pages.map(({group, page}) => ({groupKey:group.groupKey,
    categoryCode:group.categoryCode, totalItems:page.totalItems, nextCursor:page.nextCursor,
    evidenceStatus:page.evidenceStatus, reconciliation:page.reconciliation})), ...financialQuantities(pages, input, item.productId),
    hasMore:rows.length > 10 || pages.some(({page}) => Boolean(page.nextCursor) || page.totalItems > page.items.length)};
}
