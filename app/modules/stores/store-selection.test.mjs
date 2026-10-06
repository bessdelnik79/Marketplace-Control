import test from 'node:test';
import assert from 'node:assert/strict';
import { selectStoreOrder, storeSelectionUrl } from './store-selection.mjs';

test('selected owned store becomes first without changing the original list', () => {
  const stores = [{ id: 'first' }, { id: 'second' }, { id: 'third' }];
  assert.deepEqual(selectStoreOrder(stores, 'second').map(store => store.id), ['second', 'first', 'third']);
  assert.deepEqual(stores.map(store => store.id), ['first', 'second', 'third']);
});
test('missing selection keeps default order and permits an empty business', () => {
  assert.deepEqual(selectStoreOrder([{ id: 'first' }], null), [{ id: 'first' }]);
  assert.deepEqual(selectStoreOrder([], undefined), []);
});
test('foreign, unknown and explicitly empty selections never fall back to another store', () => {
  for (const id of ['foreign', '', 'missing']) {
    assert.throws(() => selectStoreOrder([{ id: 'owned' }], id), /store_not_found/);
  }
});
test('store redirect preserves notice and anchor and encodes the selected ID', () => {
  assert.equal(storeSelectionUrl('/settings?connection=connected#store', 'second'), '/settings?connection=connected&storeId=second#store');
  assert.equal(storeSelectionUrl('/products?storeId=first&updated=1', 'second'), '/products?storeId=second&updated=1');
  assert.equal(storeSelectionUrl('/settings#store', null), '/settings#store');
});

test('tariff-unavailable store cannot be selected or become the default',()=>{
 const stores=[{id:'retained',selectable:false},{id:'active',selectable:true}];
 assert.throws(()=>selectStoreOrder(stores,'retained'),/store_not_found/);
 assert.deepEqual(selectStoreOrder(stores,null).map(store=>store.id),['active','retained']);
 assert.deepEqual(selectStoreOrder([{id:'retained',selectable:false}],null),[]);
});
