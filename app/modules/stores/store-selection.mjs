// Selection only accepts stores returned for the authenticated business.
export function selectStoreOrder(stores, storeId) {
  if (storeId === null || storeId === undefined) return [...stores];
  const selected = stores.find(store => store.id === storeId);
  if (!selected) throw new Error('store_not_found');
  return [selected, ...stores.filter(store => store.id !== selected.id)];
}

export function storeSelectionUrl(target, storeId) {
  if (!storeId) return target;
  const url = new URL(target, 'http://localhost');
  url.searchParams.set('storeId', storeId);
  return `${url.pathname}${url.search}${url.hash}`;
}
