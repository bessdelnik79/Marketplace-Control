import { getPublishedFinancialPeriodPair } from '../calculation/calculation.repository.mjs';
import { getOperationalOverviewData } from '../operational/operational.repository.mjs';
import { buildFinancialOverview, calendarWeekForDate, previousCalendarPeriod, validateCalendarPeriod } from './financial-overview.mjs';
import { buildOperationalOverview } from './operational-overview.mjs';
import { buildSituations } from './situations.mjs';

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

function envelopeMatchesPeriod(envelope, period) {
  return envelope?.period_start === period.start && envelope?.period_end === period.end;
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

export async function getFinancialOverview(userId, storeId, selectedDate, selectedEndOrDependencies = null, dependencies = {}) {
  const selectedEnd = typeof selectedEndOrDependencies === 'string' ? selectedEndOrDependencies : null;
  const { loadPeriodPair = getPublishedFinancialPeriodPair } =
    selectedEndOrDependencies && typeof selectedEndOrDependencies === 'object' ? selectedEndOrDependencies : dependencies;
  const normalizedUserId = requiredId(userId);
  const normalizedStoreId = requiredId(storeId);
  const timezone = 'Europe/Moscow';
  let period,previousPeriod,pair;
  if ((selectedDate === null || selectedDate === undefined || selectedDate === '') && selectedEnd) {
    throw new Error('overview_invalid_period');
  }
  if(selectedDate===null||selectedDate===undefined||selectedDate===''){
    pair=await loadPeriodPair(normalizedUserId,normalizedStoreId,{});
    if(pair?.current){
      period=validateCalendarPeriod({start:pair.current.period_start,end:pair.current.period_end,timezone});
      previousPeriod=previousCalendarPeriod(period);
      if (!envelopeMatchesPeriod(pair.previous, previousPeriod)) {
        pair=await loadPeriodPair(normalizedUserId,normalizedStoreId,{
          periodStart:period.start,periodEnd:period.end,
          previousPeriodStart:previousPeriod.start,previousPeriodEnd:previousPeriod.end
        });
      }
    }
  }else{
    period=selectedEnd
      ?validateCalendarPeriod({start:selectedDate,end:selectedEnd,timezone})
      :calendarWeekForDate(selectedDate,{timezone});
    previousPeriod=previousCalendarPeriod(period);
    pair=await loadPeriodPair(normalizedUserId,normalizedStoreId,{
      periodStart:period.start,periodEnd:period.end,
      previousPeriodStart:previousPeriod.start,previousPeriodEnd:previousPeriod.end
    });
  }
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
      crossBorderBuyout: { present: null, reportCount: null },
      period:period??null,
      requestedPeriod: period??null,
      coveredPeriod: null,
      quality: 'unavailable',
      missingReasons: ['published_period_missing'],
      totals: null,
      displayResult: null,
      comparison: {
        period: previousPeriod??null,
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
    crossBorderBuyout: {
      present: pair.current.cross_border_buyout?.present === true,
      reportCount: Number(pair.current.cross_border_buyout?.reportCount ?? 0)
    },
    requestedPeriod: overview.period,
    coveredPeriod: pair.current.covered_period ?? null
  };
}

export async function getOverviewState(userId,{storeId,financialPeriodStart,financialPeriodEnd=null},{
  loadPeriodPair=getPublishedFinancialPeriodPair,
  loadOperationalData=getOperationalOverviewData
}={}){
  const normalizedUserId=requiredId(userId),normalizedStoreId=requiredId(storeId);
  const operationalData=await loadOperationalData(normalizedUserId,normalizedStoreId);
  if(!operationalData)return null;
  const financial=await getFinancialOverview(normalizedUserId,normalizedStoreId,financialPeriodStart,financialPeriodEnd,{loadPeriodPair});
  const requestedFinancialPeriod=financialPeriodStart
    ?financialPeriodEnd
      ?validateCalendarPeriod({start:financialPeriodStart,end:financialPeriodEnd,timezone:'Europe/Moscow'})
      :calendarWeekForDate(financialPeriodStart,{timezone:'Europe/Moscow'})
    :null;
  const financialState=financial??{
    status:'unavailable',publicationId:null,methodVersion:null,publishedAt:null,sourceFreshness:null,scope:null,
    quality:'unavailable',missingReasons:['published_financial_result_missing'],totals:null,displayResult:null,situationEvidence:null,
    crossBorderBuyout:{present:null,reportCount:null},requestedPeriod:requestedFinancialPeriod,coveredPeriod:null,
    comparison:{period:requestedFinancialPeriod?previousCalendarPeriod(requestedFinancialPeriod):null,quality:'unavailable',amount:null,changeAmount:null,changePercent:null,comparable:false,reason:'current_period_unavailable'}
  };
  return {
    store:{
      id:requiredId(operationalData.store?.id),name:requiredId(operationalData.store?.name),
      status:requiredId(operationalData.store?.status),marketplaceCode:requiredId(operationalData.store?.marketplace_code),
      connected:operationalData.store?.connected===true
    },
    financial:financialState,
    operational:buildOperationalOverview(operationalData),
    situations:buildSituations(financialState)
  };
}
