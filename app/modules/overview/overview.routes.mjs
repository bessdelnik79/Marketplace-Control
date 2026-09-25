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

export function createOverviewRoutes({
  listStores,
  getOverviewState,
  overviewPage,
  send,
  redirect,
  scheduleOperationalSync,
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
    const week = requestedWeek(url);
    if (week === undefined) {
      send(res, 400, 'Неделя должна быть указана в формате ГГГГ-ММ-ДД.');
      return true;
    }
    if (store.demo === true) {
      send(res, 200, overviewPage(current, stores, null, { selectedStoreId: store.id, selectedWeek: week }));
      return true;
    }
    if (!store.connected) {
      send(res, 200, overviewPage(current, stores, null, { selectedStoreId: store.id, selectedWeek: week }));
      return true;
    }
    scheduleOperationalSync(current.user_id, store.id);
    const state = await getOverviewState(current.user_id, { storeId: store.id, financialPeriodStart: week });
    if (!state) {
      send(res, 404, 'Магазин не найден.');
      return true;
    }
    send(res, 200, overviewPage(current, stores, state, { selectedStoreId: store.id, selectedWeek: week }));
    return true;
  };
}
