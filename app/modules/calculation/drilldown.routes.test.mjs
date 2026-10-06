import test from 'node:test';
import assert from 'node:assert/strict';
import { createDrilldownRoutes } from './drilldown.routes.mjs';

const base={storeId:'store',publicationSource:'daily',publicationId:'old',periodStart:'2026-07-13',periodEnd:'2026-07-19'};
const current={user_id:'viewer'};
function setup(overrides={}){
  const calls=[],response={};
  const record=name=>async(user,input)=>{calls.push({name,user,input});return {context:{publication:{id:input.publicationId}},item:{name:'Товар'}};};
  const handler=createDrilldownRoutes({listStores:async()=>[{id:'store',connected:true},{id:'other'}],
    getFinancialOverview:async()=>{calls.push({name:'overview'});return{publicationId:'new',publicationSource:'daily',period:{start:base.periodStart,end:base.periodEnd}};},
    readPublishedSkuList:record('list'),readPublishedSkuCard:record('card'),readPublishedContributions:record('sources'),
    readPublishedSituations:record('situations'),readPublishedSituation:record('situation'),
    skuListPage:(_user,stores,data,options)=>({page:'list',stores,data,options}),
    skuCardPage:(_user,stores,data,options)=>({page:'card',stores,data,options}),
    skuSourcesPage:(_user,stores,data,options)=>({page:'sources',stores,data,options}),
    situationsListPage:(_user,stores,data,options)=>({page:'situations',stores,data,options}),
    situationDetailPage:(_user,stores,data,options)=>({page:'situation',stores,data,options}),
    send:(res,status,body,headers)=>Object.assign(res,{status,body,headers}),
    redirect:(res,location)=>Object.assign(res,{status:303,location}),...overrides});
  return {calls,response,run:(path='/sku',user=current,method='GET')=>handler({method},response,new URL(path,'http://localhost'),user)};
}
function route(path='/sku',extra={}){return `${path}?${new URLSearchParams({...base,...extra})}`;}
test('SKU routes require a session and leave unrelated routes untouched',async()=>{
  const s=setup();assert.equal(await s.run('/sku',null),true);assert.equal(s.response.location,'/login');assert.equal(s.calls.length,0);
  assert.equal(await s.run('/products'),false);assert.equal(await s.run('/sku',current,'POST'),false);
});
test('initial entry resolves current once then redirects to immutable publication context',async()=>{
  const s=setup();await s.run('/sku?storeId=store&search=shirt&sort=revenue_desc&limit=10');
  const url=new URL(s.response.location,'http://localhost');assert.equal(s.response.status,303);
  assert.equal(url.searchParams.get('publicationId'),'new');assert.equal(url.searchParams.get('publicationSource'),'daily');
  assert.equal(url.searchParams.get('search'),'shirt');assert.equal(url.searchParams.get('periodStart'),base.periodStart);
  assert.deepEqual(s.calls.map(c=>c.name),['overview']);
});
test('pinned list forwards filters and cursor without reading current publication',async()=>{
  const s=setup();await s.run(route('/sku',{search:'x',sort:'result_desc',cursor:'bound',limit:'7'}));
  assert.deepEqual(s.calls.map(c=>c.name),['list']);assert.equal(s.calls[0].input.publicationId,'old');
  assert.equal(s.calls[0].input.cursor,'bound');assert.equal(s.calls[0].input.limit,7);
  assert.equal(s.response.headers['cache-control'],'no-store');
});
test('card and sources preserve list back state and source cursor separately',async()=>{
  const s=setup();await s.run(route('/sku/sources',{productId:'product',groupKey:'group',cursor:'source-page',listCursor:'list-page',taxBasis:'1'}));
  assert.deepEqual(s.calls.map(c=>c.name),['sources','card']);assert.equal(s.calls[0].input.cursor,'source-page');
  assert.equal(s.calls[0].input.taxBasis,true);assert.equal(s.response.body.options.listState.cursor,'list-page');
  assert.equal(s.response.body.data.product.name,'Товар');assert.equal(s.calls[1].input.publicationId,'old');
});
test('store contribution route does not request a product and preserves store scope',async()=>{
  const s=setup();await s.run(route('/sku/sources',{scope:'store',groupKey:'store-group'}));
  assert.deepEqual(s.calls.map(c=>c.name),['sources']);assert.equal(s.calls[0].input.scope,'store');
  assert.equal(Object.hasOwn(s.calls[0].input,'productId'),false);
});
test('malformed or incomplete contexts never fall back to current',async()=>{
  for(const path of ['/sku?publicationId=old','/sku/card?storeId=store',route('/sku',{periodEnd:'2026-02-30'}),
    route('/sku',{limit:'0'}),route('/sku',{sort:'evil'}),`${route()}&publicationId=other`,
    route('/sku/sources',{scope:'store',productId:'product',groupKey:'g'}),route('/sku/sources',{groupKey:'g',taxBasis:'0'}),
    '/sku?storeId=store&cursor=bound']){
    const s=setup();await s.run(path);assert.equal(s.response.status,400,path);assert.equal(s.calls.length,0,path);
  }
});
test('reader not-found and cursor errors map to uniform private HTTP responses',async()=>{
  for(const code of ['drilldown_not_found','drilldown_invalid_request','drilldown_cursor_context_mismatch']){
    const s=setup({readPublishedSkuList:async()=>{throw new Error(code);}});await s.run(route());
    assert.equal(s.response.status,code==='drilldown_not_found'?404:400);assert.equal(s.response.headers['cache-control'],'no-store');
  }
  const foreign=setup();await foreign.run(route('/sku',{storeId:'foreign'}));assert.equal(foreign.response.status,404);
});
test('no publication renders unavailable instead of a demo or zero result',async()=>{
  const s=setup({getFinancialOverview:async()=>({publicationId:null})});await s.run('/sku?storeId=store');
  assert.equal(s.response.status,200);assert.equal(s.response.body.data,null);
});

test('situations initial entry resolves publication once and explicit list/detail use pinned readers',async()=>{
  const initial=setup();await initial.run('/situations?storeId=store');assert.equal(initial.response.status,303);
  assert.match(initial.response.location,/^\/situations\?/);
  const list=setup();await list.run(route('/situations'));assert.equal(list.response.body.page,'situations');
  assert.deepEqual(list.calls.map(call=>call.name),['situations']);assert.equal(list.calls[0].input.publicationId,'old');
  const detail=setup();await detail.run(route('/situation',{situationId:'penalty'}));
  assert.equal(detail.calls[0].input.situationId,'penalty');assert.equal(detail.response.body.page,'situation');
});

test('sources linked from situation must belong to the actual fired rule groups',async()=>{
  const fired=async()=>({item:{id:'penalty',kind:'penalty',groups:[{scope:'store',groupKey:'penalty-group'}]}});
  const good=setup({readPublishedSituation:fired});await good.run(route('/sku/sources',{scope:'store',groupKey:'penalty-group',situationId:'penalty'}));
  assert.equal(good.response.status,200);assert.equal(good.response.body.data.situation.id,'penalty');
  const foreign=setup({readPublishedSituation:fired});await foreign.run(route('/sku/sources',{scope:'store',groupKey:'revenue-group',situationId:'penalty'}));
  assert.equal(foreign.response.status,404);assert.ok(!foreign.calls.some(call=>call.name==='sources'));
});

test('inactive tariff store is rejected before resolving the current or pinned publication',async()=>{
 const h=setup({listStores:async()=>[{id:'store',selectable:false}]});
 await h.run('/sku?storeId=store');assert.equal(h.response.status,404);assert.deepEqual(h.calls,[]);
});
