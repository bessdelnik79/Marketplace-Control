import { validateCalendarPeriod } from '../overview/financial-overview.mjs';

const paths = new Set(['/sku', '/sku/card', '/sku/sources']);
const contextKeys = ['storeId', 'publicationSource', 'publicationId', 'periodStart', 'periodEnd'];
const messages = {
  drilldown_invalid_request: 'Некорректные параметры расшифровки.',
  drilldown_cursor_context_mismatch: 'Страница относится к другому результату или фильтру. Откройте список заново.',
  drilldown_not_found: 'Расшифровка не найдена.'
};
function invalid() { throw new Error('drilldown_invalid_request'); }
function limit(value) {
  if (value === null) return 25;
  if (!/^[1-9]\d?$|^100$/.test(value)) invalid();
  return Number(value);
}
function period(params) {
  const start = params.get('periodStart'), end = params.get('periodEnd');
  if (start === null && end === null) return null;
  try { return validateCalendarPeriod({start, end}); } catch { invalid(); }
}

export function createDrilldownRoutes({listStores, getFinancialOverview, readPublishedSkuList, readPublishedSkuCard,
  readPublishedContributions, skuListPage, skuCardPage, skuSourcesPage, send, redirect}) {
  return async function handleDrilldown(req, res, url, current) {
    if (req.method !== 'GET' || !paths.has(url.pathname)) return false;
    res.setHeader?.('cache-control', 'no-store');
    if (!current) { redirect(res, '/login'); return true; }
    try {
      const params = url.searchParams;
      for (const key of new Set(params.keys())) if (params.getAll(key).length !== 1) invalid();
      const stores = await listStores(current.user_id);
      const storeId = params.get('storeId');
      const store = storeId ? stores.find(item => item.id === storeId) : stores[0];
      if (storeId && !store) throw new Error('drilldown_not_found');
      const selectedStores = store ? [store, ...stores.filter(item => item !== store)] : stores;
      const requested = period(params);
      const pageLimit = limit(params.get('limit'));
      const explicit = params.has('publicationId') || params.has('publicationSource');
      const listState = {search:params.get('search') ?? '', sort:params.get('sort') ?? 'result_asc',
        limit:pageLimit, cursor:params.get(url.pathname === '/sku' ? 'cursor' : 'listCursor')};
      if (listState.search.length > 256 || !['result_asc','result_desc','revenue_asc','revenue_desc'].includes(listState.sort)) invalid();
      const options = {listState, selectedStoreId:store?.id ?? null, period:requested};
      if (!explicit) {
        if (url.pathname !== '/sku') invalid();
        if (params.has('cursor')) invalid();
        const financial = store && !store.demo ? await getFinancialOverview(current.user_id, store.id, requested?.start ?? null, requested?.end ?? null) : null;
        if (!financial?.publicationId || !financial?.period?.start || !financial?.period?.end) {
          send(res, 200, skuListPage(current, selectedStores, null, options), {'cache-control':'no-store'});
          return true;
        }
        const canonical = new URLSearchParams({storeId:store.id, publicationSource:financial.publicationSource,
          publicationId:financial.publicationId, periodStart:financial.period.start, periodEnd:financial.period.end,
          search:listState.search, sort:listState.sort, limit:String(pageLimit)});
        redirect(res, `/sku?${canonical}`);
        return true;
      }
      if (!store || contextKeys.some(key => !params.get(key))) invalid();
      const input = Object.fromEntries(contextKeys.map(key => [key, params.get(key)]));
      let data, renderer;
      if (url.pathname === '/sku') {
        data = await readPublishedSkuList(current.user_id, {...input, ...listState});
        renderer = skuListPage;
      } else if (url.pathname === '/sku/card') {
        data = await readPublishedSkuCard(current.user_id, {...input, productId:params.get('productId')});
        renderer = skuCardPage;
      } else {
        if (params.has('taxBasis') && params.get('taxBasis') !== '1') invalid();
        const scope = params.get('scope');
        if (scope !== null && scope !== 'store') invalid();
        if (scope === 'store' && params.has('productId')) invalid();
        const contributionInput = {...input, groupKey:params.get('groupKey'), cursor:params.get('cursor'),
          limit:pageLimit, taxBasis:params.get('taxBasis') === '1',
          ...(scope === 'store' ? {scope} : {productId:params.get('productId')})};
        data = await readPublishedContributions(current.user_id, contributionInput);
        if (scope !== 'store') data.product = (await readPublishedSkuCard(current.user_id, {...input, productId:params.get('productId')})).item;
        options.taxBasis = contributionInput.taxBasis;
        renderer = skuSourcesPage;
      }
      send(res, 200, renderer(current, selectedStores, data, options), {'cache-control':'no-store'});
    } catch (error) {
      if (!Object.hasOwn(messages, error.message)) throw error;
      send(res, error.message === 'drilldown_not_found' ? 404 : 400, messages[error.message], {'cache-control':'no-store'});
    }
    return true;
  };
}
