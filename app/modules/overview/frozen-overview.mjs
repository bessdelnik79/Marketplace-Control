// A frozen overview displays the same persisted totals checked by the drill-down
// reader. Comparisons and situations from a different publication are excluded.
export function frozenFinancialOverview({context, reconciliation}) {
  const checked = code => reconciliation.checks.find(check => check.code === code)?.expected ?? null;
  const afterTax = context.resultBasis === 'after_tax';
  const amount = context.quality === 'unavailable' ? null :
    context.totals?.[afterTax ? 'availableResultAfterTax' : 'availableResultBeforeTax'] ?? null;
  return {
    status: amount === null ? 'unavailable' : 'available', quality: context.quality,
    publicationId: context.publication.id, publicationSource: context.publication.source,
    publishedAt: context.publication.publishedAt, methodVersion: context.method.version,
    period: context.period, requestedPeriod: context.period, coveredPeriod: context.coverage.covered,
    missingReasons: context.missingReasons, scope: context.scope, frozen: true,
    frozenUpdate: context.update,
    updateStatus: {status:'current'},
    totals: {revenue:checked('overview_revenue'), wbExpenses:checked('overview_wbExpenses'),
      costOfGoods:checked('overview_costOfGoods'), toTransfer:checked('overview_toTransfer'),
      tax:afterTax && context.quality !== 'unavailable' ? context.totals?.estimatedUsnTax ?? null : null},
    displayResult: {amount, basis:amount === null ? 'unavailable' : afterTax ? 'after_tax' : 'before_tax'},
    comparison: {comparable:false, reason:'frozen_publication_comparison_unavailable'}
  };
}
