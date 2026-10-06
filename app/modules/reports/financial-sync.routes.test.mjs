import test from 'node:test';
import assert from 'node:assert/strict';
import {createFinancialSyncRoutes} from './financial-sync.routes.mjs';

const current={user_id:'user-1'},stores=[{id:'store-1',connected:true},{id:'store-2',connected:true}];
function setup(overrides={}){
  const calls=[],response={};
  const handler=createFinancialSyncRoutes({
    listStores:async userId=>{calls.push(['stores',userId]);return stores;},
    getFinancialSyncState:async(userId,storeId)=>{calls.push(['state',userId,storeId]);return{run_status:'running'};},
    financialSyncView:(state,store)=>({title:'Статус',note:'Текст',running:true,storeId:store.id,state}),
    send:(res,status,body,headers={})=>Object.assign(res,{status,body,headers}),
    ...overrides
  });
  return{calls,response,run:(route='/financial-reports/status?storeId=store-1',user=current,method='GET')=>handler({method},response,new URL(route,'http://localhost'),user)};
}

test('financial sync status route ignores unrelated requests and requires a session',async()=>{
  const unrelated=setup();assert.equal(await unrelated.run('/settings'),false);assert.deepEqual(unrelated.calls,[]);
  const anonymous=setup();assert.equal(await anonymous.run(undefined,null),true);assert.equal(anonymous.response.status,401);
  assert.equal(JSON.parse(anonymous.response.body).error,'auth_required');
});

test('financial sync status reads only an owned store and returns no-store presentation JSON',async()=>{
  const state=setup();assert.equal(await state.run('/financial-reports/status?storeId=store-2'),true);
  assert.deepEqual(state.calls,[['stores','user-1'],['state','user-1','store-2']]);
  assert.equal(state.response.status,200);assert.equal(state.response.headers['cache-control'],'no-store');
  assert.match(state.response.headers['content-type'],/application\/json/);assert.equal(JSON.parse(state.response.body).storeId,'store-2');
});

test('financial sync status rejects a foreign store before reading its state',async()=>{
  const state=setup();await state.run('/financial-reports/status?storeId=foreign');
  assert.equal(state.response.status,404);assert.equal(state.calls.some(([name])=>name==='state'),false);
});

test('inactive tariff store status cannot expose saved sync state',async()=>{
 const h=setup({listStores:async()=>[{id:'store-1',selectable:false}]});await h.run();assert.equal(h.response.status,404);assert.deepEqual(h.calls,[]);
});
