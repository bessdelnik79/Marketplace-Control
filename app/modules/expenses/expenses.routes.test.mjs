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

test('saving an expense schedules recalculation for its store', async () => {
  const calls = [];
  const handle = createExpensesRoutes({
    sameOrigin: () => true,
    listStores: async () => [{ id: 'store' }],
    takeLimit: async () => ({ allowed: true }),
    form: async () => ({ storeId: 'store', amount: '100' }),
    saveExpense: async (userId, expense) => calls.push(['save', userId, expense.storeId]),
    scheduleFinancialCalculation: (userId, storeId) => calls.push(['calculate', userId, storeId]),
    redirect: (_res, location) => calls.push(['redirect', location]),
  });
  assert.equal(await handle({ method: 'POST' }, {}, new URL('http://local/expenses'), { user_id: 'user' }), true);
  assert.deepEqual(calls, [
    ['save', 'user', 'store'],
    ['calculate', 'user', 'store'],
    ['redirect', '/expenses?saved=1'],
  ]);
});
