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
    send: (res, status, body) => Object.assign(res, { status, body }),
    redirect: (res, location) => Object.assign(res, { status: 303, location }),
    scheduleOperationalSync: (...args) => calls.push(['sync', ...args]),
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

test('overview reads the owned requested store and selected week', async () => {
  const state = setup();
  assert.equal(await state.run('/overview?storeId=store-2&week=2026-09-14'), true);
  assert.deepEqual(state.calls, [
    ['stores', 'user-1'],
    ['sync', 'user-1', 'store-2'],
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

test('overview starts one background calculation for a covered unpublished period',async()=>{
  const calls=[];
  const state=setup({
    getOverviewState:async()=>({store:{id:'store-1'},financial:{status:'unavailable',missingReasons:['report_coverage_incomplete']}}),
    getFinancialPeriodRecoveryState:async(...args)=>{calls.push(['recovery',...args]);return{status:'ready'};},
    scheduleFinancialCalculation:(...args)=>calls.push(['calculation',...args])
  });
  await state.run('/overview?storeId=store-1&periodStart=2026-09-10&periodEnd=2026-09-19');
  assert.deepEqual(calls,[
    ['recovery','user-1','store-1','2026-09-10','2026-09-19'],
    ['calculation','user-1','store-1',{targetPeriod:{periodStart:'2026-09-10',periodEnd:'2026-09-19'}}]
  ]);
  assert.equal(state.response.body.state.financial.status,'calculating');
  assert.equal(state.response.body.state.financial.calculationStage,'queued');
  assert.equal(state.response.body.state.financial.refresh,true);
});

test('overview automatically updates legacy report normalizations before calculating',async()=>{
  const calls=[];
  const ranges=[{periodStart:'2026-08-10',periodEnd:'2026-08-16'}];
  const state=setup({
    getOverviewState:async()=>({store:{id:'store-1'},financial:{status:'unavailable',missingReasons:['report_coverage_incomplete']}}),
    getFinancialPeriodRecoveryState:async()=>({status:'normalization_required',ranges}),
    scheduleFinancialSync:(...args)=>calls.push(args)
  });
  await state.run('/overview?storeId=store-1&periodStart=2026-08-10&periodEnd=2026-08-16');
  assert.deepEqual(calls,[['user-1','store-1',{
    targetPeriod:{periodStart:'2026-08-10',periodEnd:'2026-08-16'},targetRanges:ranges
  }]]);
  assert.equal(state.response.body.state.financial.status,'calculating');
  assert.equal(state.response.body.state.financial.calculationStage,'sources');
});

test('overview polls an existing target calculation without scheduling a duplicate',async()=>{
  let scheduled=false;
  const state=setup({
    getOverviewState:async()=>({store:{id:'store-1'},financial:{status:'unavailable',missingReasons:['published_period_missing']}}),
    getFinancialPeriodRecoveryState:async()=>({status:'running'}),
    scheduleFinancialCalculation:()=>{scheduled=true;}
  });
  await state.run('/overview?periodStart=2026-09-10&periodEnd=2026-09-19');
  assert.equal(scheduled,false);
  assert.equal(state.response.body.state.financial.status,'calculating');
  assert.equal(state.response.body.state.financial.calculationStage,'running');
});

test('overview resumes a durable queued target calculation after a process restart',async()=>{
  const scheduled=[];
  const state=setup({
    getOverviewState:async()=>({store:{id:'store-1'},financial:{status:'unavailable',missingReasons:['published_period_missing']}}),
    getFinancialPeriodRecoveryState:async()=>({status:'queued'}),
    scheduleFinancialCalculation:(...args)=>scheduled.push(args)
  });
  await state.run('/overview?periodStart=2026-09-10&periodEnd=2026-09-19');
  assert.equal(scheduled.length,1);
  assert.equal(state.response.body.state.financial.status,'calculating');
});

test('failed target normalization stops automatic retries and retries only on request',async()=>{
  const scheduled=[];
  const ranges=[{periodStart:'2026-08-10',periodEnd:'2026-08-16'}];
  const state=setup({
    getOverviewState:async()=>({store:{id:'store-1'},financial:{status:'unavailable',missingReasons:['report_coverage_incomplete']}}),
    getFinancialPeriodRecoveryState:async()=>({status:'normalization_failed',reason:'financial_unauthorized',ranges}),
    scheduleFinancialSync:(...args)=>scheduled.push(args)
  });
  await state.run('/overview?periodStart=2026-08-10&periodEnd=2026-08-16');
  assert.equal(state.response.body.state.financial.status,'failed');
  assert.deepEqual(scheduled,[]);
  await state.run('/overview?periodStart=2026-08-10&periodEnd=2026-08-16&retryCalculation=1');
  assert.equal(state.response.status,303);
  assert.equal(state.response.location,'/overview?periodStart=2026-08-10&periodEnd=2026-08-16');
  assert.equal(scheduled.length,1);
  await state.run('/overview?periodStart=2026-08-10&periodEnd=2026-08-16');
  assert.equal(state.response.status,200);
  assert.equal(state.response.body.state.financial.status,'failed');
  assert.equal(scheduled.length,1);
});

test('stale retry parameter is always removed without duplicating an active job',async()=>{
  let scheduled=0;
  const state=setup({
    getOverviewState:async()=>({store:{id:'store-1'},financial:{status:'unavailable',missingReasons:['report_coverage_incomplete']}}),
    getFinancialPeriodRecoveryState:async()=>({status:'normalization_running'}),
    scheduleFinancialSync:()=>{scheduled++;},
    scheduleFinancialCalculation:()=>{scheduled++;}
  });
  await state.run('/overview?periodStart=2026-08-10&periodEnd=2026-08-16&retryCalculation=1');
  assert.equal(state.response.status,303);
  assert.equal(state.response.location,'/overview?periodStart=2026-08-10&periodEnd=2026-08-16');
  assert.equal(scheduled,0);
});

test('failed target calculation stops automatic retries and only retries after an explicit action',async()=>{
  const scheduled=[];
  const state=setup({
    getOverviewState:async()=>({store:{id:'store-1'},financial:{status:'unavailable',missingReasons:['report_coverage_incomplete']}}),
    getFinancialPeriodRecoveryState:async()=>({status:'failed',reason:'calculation_failed'}),
    scheduleFinancialCalculation:(...args)=>scheduled.push(args)
  });
  await state.run('/overview?periodStart=2026-09-10&periodEnd=2026-09-19');
  assert.equal(state.response.body.state.financial.status,'failed');
  assert.deepEqual(scheduled,[]);
  await state.run('/overview?periodStart=2026-09-10&periodEnd=2026-09-19&retryCalculation=1');
  assert.equal(state.response.status,303);
  assert.equal(state.response.location,'/overview?periodStart=2026-09-10&periodEnd=2026-09-19');
  assert.equal(scheduled.length,1);
  await state.run('/overview?periodStart=2026-09-10&periodEnd=2026-09-19');
  assert.equal(state.response.status,200);
  assert.equal(state.response.body.state.financial.status,'failed');
  assert.equal(scheduled.length,1);
});

test('overview replaces a generic missing-publication reason with the actual source coverage gap',async()=>{
  const state=setup({
    getOverviewState:async()=>({store:{id:'store-1'},financial:{status:'unavailable',missingReasons:['published_period_missing']}}),
    getFinancialPeriodRecoveryState:async()=>({status:'uncovered',reason:'calculation_period_coverage_incomplete'})
  });
  await state.run('/overview?periodStart=2026-09-10&periodEnd=2026-09-19');
  assert.deepEqual(state.response.body.state.financial.missingReasons,['calculation_period_coverage_incomplete']);
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
