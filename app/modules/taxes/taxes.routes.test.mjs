import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaxesRoutes } from './taxes.routes.mjs';

test('tax routes reject cross-origin writes before loading store data', async () => {
  const calls = [];
  const handle = createTaxesRoutes({
    sameOrigin: () => false,
    send: (_res, status) => calls.push(status),
    listStores: () => { throw new Error('store lookup must not run'); },
  });
  assert.equal(await handle({ method: 'POST' }, {}, new URL('http://local/taxes'), { user_id: 'user' }), true);
  assert.deepEqual(calls, [403]);
  assert.equal(await handle({ method: 'POST' }, {}, new URL('http://local/expenses'), { user_id: 'user' }), false);
});

test('voiding a tax setting recalculates every user store', async () => {
  const calls = [];
  const handle = createTaxesRoutes({
    sameOrigin: () => true,
    listStores: async () => [{ id: 'first' }, { id: 'second' }],
    form: async () => ({ settingId: 'setting' }),
    voidTaxSetting: async (userId, setting) => calls.push(['void', userId, setting.settingId]),
    scheduleFinancialCalculation: (userId, storeId) => calls.push(['calculate', userId, storeId]),
    redirect: (_res, location) => calls.push(['redirect', location]),
  });
  assert.equal(await handle({ method: 'POST' }, {}, new URL('http://local/taxes/void'), { user_id: 'user' }), true);
  assert.deepEqual(calls, [
    ['void', 'user', 'setting'],
    ['calculate', 'user', 'first'],
    ['calculate', 'user', 'second'],
    ['redirect', '/taxes?voided=1'],
  ]);
});
