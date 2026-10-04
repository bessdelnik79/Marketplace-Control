import test from 'node:test';
import assert from 'node:assert/strict';
import { createOverviewRoutes } from './overview.routes.mjs';

const current = { user_id: 'user-1' };
const stores = [
  { id: 'store-1', name: 'Первый', connected: true },
  { id: 'store-2', name: 'Второй', connected: true }
];

function setup(overrides = {}) {
  const calls = [];
  const response = {};
  const handler = createOverviewRoutes({
    listStores: async id => { calls.push(['stores', id]); return stores; },
    getOverviewState: async (id, options) => { calls.push(['overview', id, options]); return { store: { id: options.storeId } }; },
    overviewPage: (user, list, state, options) => ({ user, list, state, options }),
    send: (res, status, body, headers={}) => Object.assign(res, { status, body, headers }),
    redirect: (res, location) => Object.assign(res, { status: 303, location }),
    sameOrigin:()=>true,
    form:async()=>({storeId:'store-1',periodStart:'2026-09-10',periodEnd:'2026-09-19'}),
    ...overrides
  });
  return { calls, response, run: (route = '/overview', user = current, method = 'GET') => handler({ method }, response, new URL(route, 'http://localhost'), user) };
}

test('overview routes leave unrelated requests untouched and require authentication', async () => {
  const unrelated = setup();
  assert.equal(await unrelated.run('/settings'), false);
  assert.deepEqual(unrelated.calls, []);
  const anonymous = setup();
  assert.equal(await anonymous.run('/', null), true);
  assert.equal(anonymous.response.location, '/login');
});

test('operational range reads only the owned store and never queues work in GET',async()=>{
  let queued=false;
  const state=setup({getOperationalOverview:async(user,store,options)=>({user,store,options}),operationalOverviewPanel:value=>value,
    requestOperationalRangeRefresh:async()=>{queued=true}});
  await state.run('/overview/operational?storeId=store-2&operationalStart=2026-09-01&operationalEnd=2026-09-30');
  assert.equal(state.response.status,200);assert.equal(queued,false);
  assert.deepEqual(state.response.body,{user:'user-1',store:'store-2',options:{periodStart:'2026-09-01',periodEnd:'2026-09-30'}});
  assert.equal(state.response.headers['cache-control'],'no-store');
  const foreign=setup();await foreign.run('/overview/operational?storeId=foreign');assert.equal(foreign.response.status,404);
  const anonymous=setup();await anonymous.run('/overview/operational',null);assert.equal(anonymous.response.status,401);
});

test('operational ranges reset on main-page reload and reject incomplete or oversized ranges',async()=>{
  const main=setup();await main.run('/overview?operationalStart=2026-01-01&operationalEnd=2026-01-31');
  assert.equal(main.calls.at(-1)[2].operationalStart,undefined);
  for(const query of ['operationalStart=2026-09-01','operationalStart=2026-09-10&operationalEnd=2026-09-01','operationalStart=2024-01-01&operationalEnd=2026-01-01']){
    const state=setup();await state.run('/overview/operational?'+query);assert.equal(state.response.status,400);
  }
});

test('operational refresh is same-origin POST and validates store ownership before queueing',async()=>{
  let writes=0;
  const options={form:async()=>({storeId:'store-1',operationalStart:'2026-09-01',operationalEnd:'2026-09-07'}),requestOperationalRangeRefresh:async()=>{writes++;return{queued:7}}};
  const state=setup(options);await state.run('/overview/operational-refresh',current,'POST');assert.equal(state.response.status,202);assert.equal(writes,1);
  const csrf=setup({...options,sameOrigin:()=>false});await csrf.run('/overview/operational-refresh',current,'POST');assert.equal(csrf.response.status,403);assert.equal(writes,1);
  const foreign=setup({...options,form:async()=>({storeId:'foreign'})});await foreign.run('/overview/operational-refresh',current,'POST');assert.equal(foreign.response.status,404);assert.equal(writes,1);
});

test('overview reads the owned requested store and selected week', async () => {
  const state = setup();
  assert.equal(await state.run('/overview?storeId=store-2&week=2026-09-14'), true);
  assert.deepEqual(state.calls, [
    ['stores', 'user-1'],
    ['overview', 'user-1', { storeId: 'store-2', financialPeriodStart: '2026-09-14', financialPeriodEnd: '2026-09-20' }]
  ]);
  assert.equal(state.response.status, 200);
  assert.equal(state.response.body.options.selectedStoreId, 'store-2');
  assert.equal(state.response.body.options.selectedWeek, '2026-09-14');
});

test('overview passes an exact arbitrary period to the service and page', async () => {
  const state = setup();
  await state.run('/overview?storeId=store-1&periodStart=2026-08-19&periodEnd=2026-09-25');
  assert.deepEqual(state.calls.at(-1), ['overview', 'user-1', {
    storeId: 'store-1', financialPeriodStart: '2026-08-19', financialPeriodEnd: '2026-09-25'
  }]);
  assert.equal(state.response.body.options.selectedPeriodStart, '2026-08-19');
  assert.equal(state.response.body.options.selectedPeriodEnd, '2026-09-25');
});

test('overview GET is read-only and leaves durable update state to the service',async()=>{
  let mutation=false;
  const state=setup({
    getOverviewState:async()=>({store:{id:'store-1'},financial:{status:'available',updateStatus:{status:'pending'}}}),
    scheduleOperationalSync:()=>{mutation=true;},scheduleFinancialCalculation:()=>{mutation=true;},scheduleFinancialSync:()=>{mutation=true;}
  });
  await state.run('/overview?storeId=store-1&periodStart=2026-09-10&periodEnd=2026-09-19');
  assert.equal(mutation,false);
  assert.equal(state.response.body.state.financial.updateStatus.status,'pending');
  assert.equal(state.response.headers['cache-control'],'no-store');
});

test('tenant-scoped status endpoint returns no-store JSON',async()=>{
  const state=setup({getFinancialDailyPublicationStatus:async(...args)=>({status:'running',publicationId:'daily-1',args})});
  await state.run('/overview/financial-status?storeId=store-2&periodStart=2026-09-10&periodEnd=2026-09-19');
  assert.equal(state.response.status,200);
  assert.equal(state.response.headers['cache-control'],'no-store');
  assert.match(state.response.headers['content-type'],/application\/json/);
  assert.equal(JSON.parse(state.response.body).publicationId,'daily-1');
});

test('manual retry is same-origin POST and enqueues only the durable daily retry dependency',async()=>{
  const retried=[];
  const state=setup({retryFinancialDailyPublication:async(...args)=>retried.push(args)});
  await state.run('/overview/financial-retry',current,'POST');
  assert.deepEqual(retried,[['user-1','store-1','2026-09-10','2026-09-19']]);
  assert.equal(state.response.status,303);
  const rejected=setup({sameOrigin:()=>false,retryFinancialDailyPublication:async()=>assert.fail('must not retry')});
  await rejected.run('/overview/financial-retry',current,'POST');
  assert.equal(rejected.response.status,403);
});

test('manual retry maps a viewer authorization failure to 403',async()=>{
  const state=setup({retryFinancialDailyPublication:async()=>{throw new Error('owned business context is required');}});
  await state.run('/overview/financial-retry',current,'POST');
  assert.equal(state.response.status,403);
});

test('overview asks the service for the latest published week when none is selected', async () => {
  const state = setup();
  await state.run('/');
  assert.deepEqual(state.calls.at(-1), ['overview', 'user-1', { storeId: 'store-1', financialPeriodStart: null, financialPeriodEnd: null }]);
});

test('overview rejects foreign stores and malformed weeks before reading state', async () => {
  const foreign = setup();
  await foreign.run('/overview?storeId=foreign');
  assert.equal(foreign.response.status, 404);
  assert.equal(foreign.calls.some(([name]) => name === 'overview'), false);
  const invalid = setup();
  await invalid.run('/overview?week=2026-02-29');
  assert.equal(invalid.response.status, 400);
  assert.equal(invalid.calls.some(([name]) => name === 'overview'), false);
});

test('overview rejects incomplete, reversed, invalid and overlong periods', async () => {
  for (const route of [
    '/overview?periodStart=2026-09-01',
    '/overview?periodStart=2026-09-20&periodEnd=2026-09-19',
    '/overview?periodStart=2026-02-29&periodEnd=2026-03-01',
    '/overview?periodStart=2025-09-01&periodEnd=2026-09-02'
  ]) {
    const state = setup();
    await state.run(route);
    assert.equal(state.response.status, 400, route);
    assert.equal(state.calls.some(([name]) => name === 'overview'), false, route);
  }
});

test('only an explicitly demo store may bypass the real overview read', async () => {
  const demoStores = [{ id: 'demo', name: 'Демо', connected: true, demo: true }];
  const state = setup({ listStores: async () => demoStores });
  await state.run('/overview');
  assert.equal(state.response.status, 200);
  assert.equal(state.calls.some(([name]) => name === 'overview'), false);
  assert.equal(state.response.body.list[0].demo, true);
});
