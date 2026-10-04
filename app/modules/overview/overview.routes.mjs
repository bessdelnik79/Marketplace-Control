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
  getOperationalOverview = async () => null,
  operationalOverviewPanel = () => '',
  requestOperationalRangeRefresh = async () => null,
  scheduleOperationalSync = () => false,
  overviewPage,
  send,
  redirect,
  getFinancialDailyPublicationStatus = async () => ({ status: 'current', publicationId: null }),
  retryFinancialDailyPublication = async () => null,
  sameOrigin = () => true,
  form = async () => ({}),
}) {
  return async function handleOverview(req, res, url, current) {
    const isPage=req.method==='GET'&&['/','/overview'].includes(url.pathname);
    const isStatus=req.method==='GET'&&url.pathname==='/overview/financial-status';
    const isRetry=req.method==='POST'&&url.pathname==='/overview/financial-retry';
    const isOperational=req.method==='GET'&&url.pathname==='/overview/operational';
    const isOperationalRefresh=req.method==='POST'&&url.pathname==='/overview/operational-refresh';
    if(!isPage&&!isStatus&&!isRetry&&!isOperational&&!isOperationalRefresh)return false;
    if (!current) {
      if(isStatus||isOperational||isOperationalRefresh)send(res,401,JSON.stringify({error:'authentication_required'}),{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
      else redirect(res, '/login');
      return true;
    }
    if((isRetry||isOperationalRefresh)&&!sameOrigin(req)){
      send(res,403,'Запрос отклонён.',{'cache-control':'no-store'});
      return true;
    }
    const stores = await listStores(current.user_id);
    if (!stores.length) {
      if(isStatus||isOperational||isOperationalRefresh)send(res,404,JSON.stringify({error:'store_not_found'}),{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
      else if (url.pathname === '/') redirect(res, '/onboarding/store');
      else send(res, 200, overviewPage(current, stores));
      return true;
    }
    const body=isRetry||isOperationalRefresh?await form(req):null;
    const requestedStoreId = body?body.storeId:url.searchParams.get('storeId');
    const store = requestedStoreId ? stores.find(item => item.id === requestedStoreId) : stores[0];
    if (!store) {
      send(res,404,isStatus?JSON.stringify({error:'store_not_found'}):'Магазин не найден.',isStatus?{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}:{});
      return true;
    }
    if(isOperational||isOperationalRefresh){
      const start=body?body.operationalStart:url.searchParams.get('operationalStart');
      const end=body?body.operationalEnd:url.searchParams.get('operationalEnd');
      let period=null;
      try{if(start||end)period=validateCalendarPeriod({start,end,timezone:'Europe/Moscow'});}
      catch{send(res,400,'Некорректный период статистики.',{'cache-control':'no-store'});return true;}
      if(isOperationalRefresh){
        if(!period){send(res,400,'Период обязателен.',{'cache-control':'no-store'});return true;}
        try{
          const result=await requestOperationalRangeRefresh(current.user_id,store.id,period.start,period.end);
          if(result?.pendingDays>0||result?.queued>0)scheduleOperationalSync(current.user_id,store.id);
          send(res,202,JSON.stringify(result),{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
        }catch(error){
          if(['owned business context is required','operational_refresh_forbidden'].includes(error.message)){send(res,403,'Недостаточно прав.',{'cache-control':'no-store'});return true;}
          if(error.message==='operational_invalid_period'){send(res,400,'Некорректный период статистики.',{'cache-control':'no-store'});return true;}
          throw error;
        }
      }else{
        let state;
        try{state=await getOperationalOverview(current.user_id,store.id,{periodStart:period?.start??null,periodEnd:period?.end??null});}
        catch(error){if(error.message==='operational_invalid_period'){send(res,400,'Некорректный период статистики.',{'cache-control':'no-store'});return true;}throw error;}
        send(res,state?200:404,state?operationalOverviewPanel(state,{selectedStoreId:store.id}):'Магазин не найден.',{'cache-control':'no-store'});
      }
      return true;
    }
    const periodUrl=isRetry?new URL(`/overview?periodStart=${encodeURIComponent(body.periodStart??'')}&periodEnd=${encodeURIComponent(body.periodEnd??'')}`,'http://localhost'):url;
    const period = requestedPeriod(periodUrl);
    if (period === undefined) {
      send(res,400,isStatus?JSON.stringify({error:'invalid_period'}):'Период должен содержать корректные даты, не более 366 дней.',isStatus?{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}:{'cache-control':'no-store'});
      return true;
    }
    if(isStatus){
      const status=await getFinancialDailyPublicationStatus(current.user_id,store.id,period?.start??null,period?.end??null);
      send(res,status?200:404,JSON.stringify(status??{error:'store_not_found'}),{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
      return true;
    }
    if(isRetry){
      if(!period){send(res,400,'Период обязателен.',{'cache-control':'no-store'});return true;}
      try{await retryFinancialDailyPublication(current.user_id,store.id,period.start,period.end);}
      catch(error){
        if(error.message==='financial_daily_retry_unavailable'){send(res,409,'Повтор недоступен.',{'cache-control':'no-store'});return true;}
        if(error.message==='owned business context is required'){send(res,403,'Недостаточно прав для повтора.',{'cache-control':'no-store'});return true;}
        throw error;
      }
      redirect(res,`/overview?storeId=${encodeURIComponent(store.id)}&periodStart=${period.start}&periodEnd=${period.end}`);
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
    const state = await getOverviewState(current.user_id, {
      storeId: store.id,
      financialPeriodStart: period?.start ?? null,
      financialPeriodEnd: period?.end ?? null
    });
    if (!state) {
      send(res, 404, 'Магазин не найден.');
      return true;
    }
    send(res, 200, overviewPage(current, stores, state, pageOptions),{'cache-control':'no-store'});
    return true;
  };
}
