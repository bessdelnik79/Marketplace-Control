import { calendarWeekForDate, validateCalendarPeriod } from './financial-overview.mjs';

function requestedWeek(url) {
  const value = url.searchParams.get('week');
  if (value === null || value === '') return null;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return undefined;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]) return undefined;
  return value;
}

function requestedPeriod(url) {
  const start = url.searchParams.get('periodStart');
  const end = url.searchParams.get('periodEnd');
  if (start !== null || end !== null) {
    if (!start || !end) return undefined;
    try {
      return validateCalendarPeriod({ start, end, timezone: 'Europe/Moscow' });
    } catch {
      return undefined;
    }
  }
  const week = requestedWeek(url);
  if (week === undefined) return undefined;
  return week === null ? null : calendarWeekForDate(week, { timezone: 'Europe/Moscow' });
}

export function createOverviewRoutes({
  listStores,
  getOverviewState,
  overviewPage,
  send,
  redirect,
  scheduleOperationalSync,
  getFinancialPeriodRecoveryState = async () => ({ status: 'uncovered' }),
  scheduleFinancialCalculation = () => false,
}) {
  return async function handleOverview(req, res, url, current) {
    if (req.method !== 'GET' || !['/', '/overview'].includes(url.pathname)) return false;
    if (!current) {
      redirect(res, '/login');
      return true;
    }
    const stores = await listStores(current.user_id);
    if (!stores.length) {
      if (url.pathname === '/') redirect(res, '/onboarding/store');
      else send(res, 200, overviewPage(current, stores));
      return true;
    }
    const requestedStoreId = url.searchParams.get('storeId');
    const store = requestedStoreId ? stores.find(item => item.id === requestedStoreId) : stores[0];
    if (!store) {
      send(res, 404, 'Магазин не найден.');
      return true;
    }
    const period = requestedPeriod(url);
    if (period === undefined) {
      send(res, 400, 'Период должен содержать корректные даты, не более 366 дней.');
      return true;
    }
    const week = url.searchParams.get('week') || null;
    const pageOptions = {
      selectedStoreId: store.id,
      selectedWeek: week,
      selectedPeriodStart: period?.start ?? null,
      selectedPeriodEnd: period?.end ?? null
    };
    if (store.demo === true) {
      send(res, 200, overviewPage(current, stores, null, pageOptions));
      return true;
    }
    if (!store.connected) {
      send(res, 200, overviewPage(current, stores, null, pageOptions));
      return true;
    }
    scheduleOperationalSync(current.user_id, store.id);
    const state = await getOverviewState(current.user_id, {
      storeId: store.id,
      financialPeriodStart: period?.start ?? null,
      financialPeriodEnd: period?.end ?? null
    });
    if (!state) {
      send(res, 404, 'Магазин не найден.');
      return true;
    }
    const missingPublishedPeriod=period&&state.financial?.status==='unavailable'&&state.financial.publishedExact!==true
      &&(state.financial.missingReasons??[]).some(reason=>['published_period_missing','published_financial_result_missing','report_coverage_incomplete'].includes(reason));
    if(missingPublishedPeriod){
      const recovery=await getFinancialPeriodRecoveryState(current.user_id,store.id,period.start,period.end);
      const retryFailed=recovery.status==='failed'&&url.searchParams.get('retryCalculation')==='1';
      if(recovery.status==='ready'||retryFailed)scheduleFinancialCalculation(current.user_id,store.id,{targetPeriod:{periodStart:period.start,periodEnd:period.end}});
      if(['ready','queued','running','busy'].includes(recovery.status)||retryFailed)state.financial={
        ...state.financial,status:'calculating',calculationStage:recovery.status==='running'?'running':'queued',refresh:true
      };
      else if(recovery.status==='failed')state.financial={...state.financial,status:'failed',calculationFailure:recovery.reason};
      else if(recovery.status==='uncovered')state.financial={...state.financial,missingReasons:[recovery.reason??'calculation_period_coverage_incomplete']};
    }
    send(res, 200, overviewPage(current, stores, state, pageOptions));
    return true;
  };
}
