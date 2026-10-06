import test from 'node:test';
import assert from 'node:assert/strict';
import { createExpensesRoutes } from './expenses.routes.mjs';

test('expense routes reject cross-origin writes before loading store data', async () => {
  const calls = [];
  const handle = createExpensesRoutes({
    sameOrigin: () => false,
    send: (_res, status) => calls.push(['send', status]),
    listStores: () => { throw new Error('store lookup must not run'); },
  });
  assert.equal(await handle({ method: 'POST' }, {}, new URL('http://local/expenses'), { user_id: 'user' }), true);
  assert.deepEqual(calls, [['send', 403]]);
  assert.equal(await handle({ method: 'POST' }, {}, new URL('http://local/taxes'), { user_id: 'user' }), false);
});

test('saving an expense relies on the transactional database event for recalculation', async () => {
  const calls = [];
  const handle = createExpensesRoutes({
    sameOrigin: () => true,
    listStores: async () => [{ id: 'store' }],
    takeLimit: async () => ({ allowed: true }),
    form: async () => ({ storeId: 'store', amount: '100' }),
    saveExpense: async (userId, expense) => calls.push(['save', userId, expense.storeId]),
    redirect: (_res, location) => calls.push(['redirect', location]),
  });
  assert.equal(await handle({ method: 'POST' }, {}, new URL('http://local/expenses'), { user_id: 'user' }), true);
  assert.deepEqual(calls, [
    ['save', 'user', 'store'],
    ['redirect', '/expenses?saved=1&storeId=store'],
  ]);
});

test('expense failure keeps the verified second store selected', async () => {
  const stores = [{ id: 'first' }, { id: 'second' }];
  let displayed;
  const handle = createExpensesRoutes({
    sameOrigin: () => true, listStores: async () => stores,
    takeLimit: async () => ({ allowed: true }),
    form: async () => ({ storeId: 'second' }),
    saveExpense: async () => { throw new Error('expense_amount_invalid'); },
    sendExpenses: (_res, status, _current, selected) => { displayed = [status, selected[0].id]; },
  });
  await handle({ method: 'POST' }, {}, new URL('http://local/expenses'), { user_id: 'user' });
  assert.deepEqual(displayed, [422, 'second']);
  assert.equal(stores[0].id, 'first');
});

test('voiding an expense redirects to its verified store', async () => {
  let location;
  const handle = createExpensesRoutes({
    sameOrigin: () => true, listStores: async () => [{ id: 'first' }, { id: 'second' }],
    form: async () => ({ storeId: 'second', expenseId: 'expense' }),
    voidExpense: async (_user, value) => assert.equal(value.storeId, 'second'),
    redirect: (_res, value) => { location = value; },
  });
  await handle({ method: 'POST' }, {}, new URL('http://local/expenses/void'), { user_id: 'user' });
  assert.equal(location, '/expenses?voided=1&storeId=second');
});

test('foreign expense store is rejected before mutation', async () => {
  let status;
  const handle = createExpensesRoutes({
    sameOrigin: () => true, listStores: async () => [{ id: 'owned' }],
    takeLimit: async () => ({ allowed: true }), form: async () => ({ storeId: 'foreign' }),
    saveExpense: async () => assert.fail('foreign store must not be written'),
    sendExpenses: (_res, value) => { status = value; },
  });
  await handle({ method: 'POST' }, {}, new URL('http://local/expenses'), { user_id: 'user' });
  assert.equal(status, 404);
});

for (const pathname of ['/expenses', '/expenses/import']) {
  test(`${pathname} rate limit retains the verified second store before reading the body`, async () => {
    let displayed;
    const handle = createExpensesRoutes({
      sameOrigin: () => true, listStores: async () => [{ id: 'first' }, { id: 'second' }],
      takeLimit: async () => ({ allowed: false }),
      form: async () => assert.fail('rate limited body must not be read'),
      multipart: async () => assert.fail('rate limited upload must not be read'),
      sendExpenses: (_res, status, _current, stores) => { displayed = [status, stores[0].id]; },
    });
    await handle({ method: 'POST' }, {}, new URL(`http://local${pathname}?storeId=second`), { user_id: 'user' });
    assert.deepEqual(displayed, [429, 'second']);
  });
}

test('foreign query store is rejected before expense limits or body parsing', async () => {
  let status;
  const handle = createExpensesRoutes({
    sameOrigin: () => true, listStores: async () => [{ id: 'owned' }],
    takeLimit: async () => assert.fail('foreign query must be rejected first'),
    multipart: async () => assert.fail('foreign query must not read uploads'),
    send: (_res, value) => { status = value; },
  });
  await handle({ method: 'POST' }, {}, new URL('http://local/expenses/import?storeId=foreign'), { user_id: 'user' });
  assert.equal(status, 404);
});

test('inactive tariff store cannot download expense templates or exports',async()=>{
 for(const path of ['/expenses/template.csv','/expenses/export.csv']){
  let status;const handler=createExpensesRoutes({listStores:async()=>[{id:'retained',selectable:false}],getExpenseState:async()=>assert.fail('inactive expense reader'),send:(_res,value)=>{status=value}});
  await handler({method:'GET'},{},new URL(`${path}?storeId=retained`,'http://localhost'),{user_id:'owner'});assert.equal(status,404);
 }
});
