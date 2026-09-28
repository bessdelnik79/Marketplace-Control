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

test('voiding a tax setting relies on transactional database events', async () => {
  const calls = [];
  const handle = createTaxesRoutes({
    sameOrigin: () => true,
    listStores: async () => [{ id: 'first' }, { id: 'second' }],
    form: async () => ({ settingId: 'setting' }),
    voidTaxSetting: async (userId, setting) => calls.push(['void', userId, setting.settingId]),
    redirect: (_res, location) => calls.push(['redirect', location]),
  });
  assert.equal(await handle({ method: 'POST' }, {}, new URL('http://local/taxes/void'), { user_id: 'user' }), true);
  assert.deepEqual(calls, [
    ['void', 'user', 'setting'],
    ['redirect', '/taxes?voided=1'],
  ]);
});

test('saving a changed tax rate relies on transactional database events',async()=>{
  const calls=[];
  const handle=createTaxesRoutes({
    sameOrigin:()=>true,
    listStores:async()=>[{id:'first'},{id:'second'}],
    takeLimit:async()=>({allowed:true}),
    form:async()=>({effectiveFrom:'2026-01-01',regimeCode:'usn_income',usnRatePercent:'7',vatMode:'exempt',comment:''}),
    saveTaxSetting:async(userId,setting)=>calls.push(['save',userId,setting.usnRatePercent]),
    redirect:(_res,location)=>calls.push(['redirect',location])
  });
  assert.equal(await handle({method:'POST'}, {}, new URL('http://local/taxes'), {user_id:'user'}),true);
  assert.deepEqual(calls,[
    ['save','user','7'],
    ['redirect','/taxes?saved=1']
  ]);
});
