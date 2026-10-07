import { buildOperationalOverview } from '../overview/operational-overview.mjs';
import { getOperationalOverviewData, operationalDisplayRange } from './operational.repository.mjs';

function unavailable(period, reason) {
  return {period, orders:{count:null, availability:'unavailable'}, buyouts:{count:null, availability:'unavailable'},
    updatedAt:null, missingReasons:[reason], snapshotIds:[],
    source:{type:'operational_sales_funnel', dateBasis:'order_date', scope:'current_active_product', savedDataUsed:false}};
}

export function createSituationOperationalCountsReader({readOperationalData=getOperationalOverviewData}={}) {
  return async function readSituationOperationalCounts(userId, {storeId, productId, periodStart, periodEnd}) {
    const period={start:periodStart, end:periodEnd};
    const unavailableResult=reason => ({...unavailable(period, reason), storeId, productId});
    if (!storeId || !productId) return unavailableResult('operational_scope_unavailable');
    if (!periodStart || !periodEnd) return unavailableResult('operational_period_unavailable');
    try { operationalDisplayRange({periodStart, periodEnd}); }
    catch (error) {
      if (!['operational_invalid_period','overview_invalid_date'].includes(error.message)) throw error;
      return unavailableResult('operational_period_unavailable');
    }
    const data=await readOperationalData(userId, storeId, {periodStart, periodEnd});
    if (!data || String(data.store?.id) !== String(storeId)) return unavailableResult('operational_scope_unavailable');
    if (!data.current) return unavailableResult('operational_snapshot_missing');
    if (data.current.period_start !== periodStart || data.current.period_end !== periodEnd) {
      return unavailableResult('operational_period_mismatch');
    }
    if (!data.current.product_ids?.some(id => String(id) === String(productId))) {
      return unavailableResult('operational_scope_unavailable');
    }
    const selectedRows=rows => (rows ?? []).filter(row => String(row.product_id) === String(productId));
    const overview=buildOperationalOverview({...data,
      current:{...data.current, product_ids:[String(productId)]},
      rows:selectedRows(data.rows), savedRows:selectedRows(data.savedRows)});
    const complete=overview.quality === 'complete' && overview.dailySeries.every(day => day.quality === 'complete');
    const measure=key => ({count:complete ? overview[key]?.count ?? null : null,
      availability:complete && overview[key]?.count != null ? 'complete' : 'unavailable'});
    return {period, storeId, productId, orders:measure('orders'), buyouts:measure('buyouts'), updatedAt:overview.updatedAt,
      missingReasons:overview.missingReasons.length || complete ? overview.missingReasons : ['operational_current_incomplete'], snapshotIds:overview.snapshotIds,
      source:{type:'operational_sales_funnel', dateBasis:'order_date', scope:'current_active_product', savedDataUsed:overview.savedDataUsed ?? false}};
  };
}

export const readSituationOperationalCounts=createSituationOperationalCountsReader();
