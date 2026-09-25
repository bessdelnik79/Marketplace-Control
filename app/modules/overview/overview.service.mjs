import { getPublishedFinancialPeriodPair } from '../calculation/calculation.repository.mjs';
import { buildFinancialOverview, calendarWeekForDate, previousCalendarWeek } from './financial-overview.mjs';

function requiredId(value) {
  const result = String(value ?? '').trim();
  if (!result) throw new Error('overview_invalid_request');
  return result;
}

function timestamp(value) {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('overview_invalid_freshness');
  return date.toISOString();
}

function normalizeScope(value) {
  if (!value || value.type !== 'selected_products' || !Array.isArray(value.productIds)) {
    throw new Error('overview_invalid_scope');
  }
  const productIds = [...new Set(value.productIds.map(requiredId))].sort();
  return { type: 'selected_products', productIds };
}

function comparisonKey(scope) {
  return `${scope.type}:${scope.productIds.join(',')}`;
}

function decoratePeriod(period, pair, scope) {
  if (!period) return null;
  return {
    ...period,
    publication_id: pair.publication_id,
    method_version: pair.method_version,
    scope: scope.type,
    coverage: {
      productIds: scope.productIds,
      comparisonKey: comparisonKey(scope),
      comparable: period.quality === 'complete',
      requestedPeriod: { start: period.period_start, end: period.period_end },
      coveredPeriod: period.covered_period ?? null
    }
  };
}

export async function getFinancialOverview(userId, storeId, selectedDate, {
  loadPeriodPair = getPublishedFinancialPeriodPair
} = {}) {
  const normalizedUserId = requiredId(userId);
  const normalizedStoreId = requiredId(storeId);
  const timezone = 'Europe/Moscow';
  const period = calendarWeekForDate(selectedDate, { timezone });
  const previousPeriod = previousCalendarWeek(period);
  const pair = await loadPeriodPair(normalizedUserId, normalizedStoreId, {
    periodStart: period.start,
    periodEnd: period.end,
    previousPeriodStart: previousPeriod.start,
    previousPeriodEnd: previousPeriod.end
  });
  if (!pair) return null;

  const scope = normalizeScope(pair.scope);
  const provenance = {
    publicationId: requiredId(pair.publication_id),
    publishedAt: timestamp(pair.published_at),
    sourceFreshness: timestamp(pair.current?.source_freshness),
    methodVersion: requiredId(pair.method_version),
    timezone,
    scope
  };
  if (!pair.current) {
    return {
      status: 'unavailable',
      ...provenance,
      period,
      requestedPeriod: period,
      coveredPeriod: null,
      quality: 'unavailable',
      missingReasons: ['published_period_missing'],
      comparison: {
        period: previousPeriod,
        quality: 'unavailable',
        amount: null,
        changeAmount: null,
        changePercent: null,
        comparable: false,
        reason: 'current_period_unavailable'
      }
    };
  }

  const overview = buildFinancialOverview({
    current: decoratePeriod(pair.current, pair, scope),
    previous: decoratePeriod(pair.previous, pair, scope),
    timezone
  });
  return {
    status: 'available',
    ...overview,
    ...provenance,
    requestedPeriod: overview.period,
    coveredPeriod: pair.current.covered_period ?? null
  };
}
