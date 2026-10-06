const revenueCategories = new Set(['revenue', 'revenue_return']);

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
function soldQuantity(pages) {
  if (!pages.some(({group}) => group.categoryCode === 'revenue')) return {soldQuantity:null, quantityReason:'situation_revenue_groups_missing'};
  if (pages.some(({page}) => page.nextCursor || page.items.length !== page.totalItems)) return {soldQuantity:null, quantityReason:'situation_revenue_page_incomplete'};
  if (pages.some(({page}) => page.reconciliation?.status !== 'matched' || page.moneyReconciliation?.status !== 'matched')) return {soldQuantity:null, quantityReason:'drilldown_reconciliation_mismatch'};
  if (pages.some(({page}) => page.evidenceStatus !== 'matched' || page.items.some(row => row.evidenceStatus !== 'matched' || !row.source))) return {soldQuantity:null, quantityReason:'drilldown_frozen_source_missing'};
  const operations = new Map();
  let total = 0n, scale = 0;
  for (const {group, page} of pages) for (const row of page.items) {
    const source = row.source;
    const expectedType = group.categoryCode === 'revenue' ? 'sale' : 'return';
    if (!source.operationVersionId || source.operationType !== expectedType) return {soldQuantity:null, quantityReason:'situation_sale_quantity_unverified'};
    const saleQuantity = expectedType === 'sale' ? quantity(source.quantity) : null;
    if (expectedType === 'sale' && !saleQuantity) return {soldQuantity:null, quantityReason:'situation_sale_quantity_unverified'};
    const signature = JSON.stringify([source.operationType, saleQuantity ? canonical(saleQuantity) : source.quantity,
      source.accountingDate, source.productId, source.variantId, source.reportRowId, source.reportVersionId, source.reportNormalizationId]);
    if (operations.has(source.operationVersionId)) {
      if (operations.get(source.operationVersionId) !== signature) return {soldQuantity:null, quantityReason:'situation_sale_operation_inconsistent'};
      continue;
    }
    operations.set(source.operationVersionId, signature);
    if (!saleQuantity) continue;
    const nextScale = Math.max(scale, saleQuantity.scale);
    total = total * 10n ** BigInt(nextScale - scale) + saleQuantity.amount * 10n ** BigInt(nextScale - saleQuantity.scale);
    scale = nextScale;
  }
  return {soldQuantity:canonical({amount:total, scale}), quantityReason:null};
}

export async function readSituationRevenuePreview(userId, input, item, readPublishedContributions) {
  const groups = item.groups.filter(group => revenueCategories.has(group.categoryCode));
  const pages = await Promise.all(groups.map(async group => ({group, page:await readPublishedContributions(userId,
    {...input, productId:item.productId, groupKey:group.groupKey, cursor:null, limit:100})})));
  const rows = pages.flatMap(({group, page}) => page.items.map(row => ({...row,
    source:row.evidenceStatus === 'matched' && page.reconciliation?.status === 'matched' ? row.source : null,
    groupKey:group.groupKey, categoryCode:group.categoryCode})))
    .sort((a, b) => (a.source?.accountingDate ?? '\uffff').localeCompare(b.source?.accountingDate ?? '\uffff') || a.id.localeCompare(b.id));
  return {rows:rows.slice(0, 10), groups:pages.map(({group, page}) => ({groupKey:group.groupKey,
    categoryCode:group.categoryCode, totalItems:page.totalItems, nextCursor:page.nextCursor,
    evidenceStatus:page.evidenceStatus, reconciliation:page.reconciliation})), ...soldQuantity(pages),
    hasMore:rows.length > 10 || pages.some(({page}) => Boolean(page.nextCursor) || page.totalItems > page.items.length)};
}
