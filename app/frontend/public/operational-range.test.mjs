import test from 'node:test';
import assert from 'node:assert/strict';
import { loadOperationalRange, refreshOperationalRange } from './operational-range.js';

test('operational range fetch keeps selection out of financial URL and browser persistence',async()=>{
  let request;
  const result=await loadOperationalRange({storeId:'store & 1',start:'2026-09-01',end:'2026-09-30',fetchImpl:async(url,options)=>{
    request={url,options};return{ok:true,redirected:false,text:async()=>'<section data-operational-panel></section>'};
  }});
  const url=new URL(request.url,'http://localhost');
  assert.equal(url.pathname,'/overview/operational');assert.equal(url.searchParams.get('storeId'),'store & 1');
  assert.equal(url.searchParams.get('operationalStart'),'2026-09-01');assert.equal(url.searchParams.has('periodStart'),false);
  assert.equal(request.options.cache,'no-store');assert.equal(request.options.credentials,'same-origin');
  assert.ok(request.options.signal instanceof AbortSignal);assert.match(result,/data-operational-panel/);
});

test('operational range rejects errors and login redirects instead of replacing the panel',async()=>{
  for(const response of [{ok:false,redirected:false},{ok:true,redirected:true}]){
    await assert.rejects(loadOperationalRange({storeId:'s',start:'2026-09-01',end:'2026-09-01',fetchImpl:async()=>response}),/operational_range_unavailable/);
  }
});

test('viewer can retain read access when operational refresh is forbidden',async()=>{
  assert.deepEqual(await refreshOperationalRange({storeId:'s',start:'2026-09-01',end:'2026-09-01',fetchImpl:async()=>({status:403})}),{queued:0,status:'read_only'});
});
