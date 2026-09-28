import assert from 'node:assert/strict';
import test from 'node:test';
import {createFinancialCalculationWorker} from './calculation-sync.mjs';

test('compatibility calculation worker drains durable invalidation and acknowledges its exact generation',async()=>{
  const pending={requested_by:'user-1',store_id:'store-1',generation_token:'generation-1'};
  const calls=[];
  const worker=createFinancialCalculationWorker({
    list:async()=>(calls.push(['list']),[pending]),
    bootstrap:async(...args)=>(calls.push(['bootstrap',...args]),{selectionReady:true,targets:[{periodStart:'2026-09-21',periodEnd:'2026-09-27'}]}),
    run:async(...args)=>(calls.push(['run',...args]),{requestId:'request-1',runId:'run-1',quality:'complete',changed:true}),
    wakeDaily:async(...args)=>(calls.push(['wake',...args]),true),
    acknowledge:async(...args)=>(calls.push(['ack',...args]),true)
  });
  assert.equal(await worker.runOnce(),true);
  assert.deepEqual(calls,[
    ['list'],['bootstrap','user-1','store-1'],
    ['run','user-1','store-1',{targetPeriod:{periodStart:'2026-09-21',periodEnd:'2026-09-27'}}],
    ['wake','user-1','store-1'],
    ['ack','user-1','store-1','generation-1']
  ]);
});

test('compatibility calculation worker leaves failed invalidation durable and idles on an empty queue',async()=>{
  const pending={requested_by:'user-1',store_id:'store-1',generation_token:'generation-1'};
  let acknowledged=false;
  const worker=createFinancialCalculationWorker({
    list:async()=>[pending],bootstrap:async()=>({selectionReady:true,targets:[{periodStart:'2026-09-21',periodEnd:'2026-09-27'}]}),
    run:async()=>{throw new Error('calculation_financial_inputs_missing');},
    wakeDaily:async()=>assert.fail('failed compatibility calculation must not wake daily publication'),
    acknowledge:async()=>{acknowledged=true;}
  });
  assert.equal(await worker.runOnce(),true);
  assert.equal(acknowledged,false);
  assert.equal(await createFinancialCalculationWorker({list:async()=>[],bootstrap:async()=>({selectionReady:true,targets:[]}),run:async()=>{},acknowledge:async()=>{}}).runOnce(),false);
});

test('compatibility calculation worker only acknowledges local changes after daily cutover',async()=>{
  const pending={requested_by:'user-1',store_id:'store-1',generation_token:'generation-2'};
  let acknowledged=false;
  const worker=createFinancialCalculationWorker({
    list:async()=>[pending],bootstrap:async()=>({dailyPublished:true,selectionReady:true,targets:[]}),
    run:async()=>assert.fail('published daily stores do not need another legacy calculation'),
    wakeDaily:async()=>assert.fail('published daily stores do not need a wake-up'),
    acknowledge:async()=>{acknowledged=true;}
  });
  assert.equal(await worker.runOnce(),true);
  assert.equal(acknowledged,true);
});

test('compatibility calculation worker keeps invalidation while durable WB pipeline is active',async()=>{
  const pending={requested_by:'user-1',store_id:'store-1',generation_token:'generation-3'};
  let acknowledged=false;
  const worker=createFinancialCalculationWorker({
    list:async()=>[pending],bootstrap:async()=>({selectionReady:true,waitingForPipeline:true,targets:[]}),
    run:async()=>assert.fail('compatibility calculation waits for accepted durable inputs'),
    wakeDaily:async()=>assert.fail('waiting compatibility calculation must not wake daily publication'),
    acknowledge:async()=>{acknowledged=true;}
  });
  assert.equal(await worker.runOnce(),true);
  assert.equal(acknowledged,false);
});

test('compatibility calculation uses accepted periods while later WB reports are still loading',async()=>{
  const pending={requested_by:'user-1',store_id:'store-1',generation_token:'generation-4'};
  const calls=[];
  const worker=createFinancialCalculationWorker({
    list:async()=>[pending],
    bootstrap:async()=>({selectionReady:true,waitingForPipeline:true,targets:[{periodStart:'2026-01-05',periodEnd:'2026-01-11'}]}),
    run:async(...args)=>(calls.push(['run',...args]),{requestId:'request-1',runId:'run-1',quality:'partial',changed:true}),
    wakeDaily:async(...args)=>(calls.push(['wake',...args]),true),
    acknowledge:async(...args)=>(calls.push(['ack',...args]),true)
  });
  assert.equal(await worker.runOnce(),true);
  assert.deepEqual(calls,[
    ['run','user-1','store-1',{targetPeriod:{periodStart:'2026-01-05',periodEnd:'2026-01-11'}}],
    ['wake','user-1','store-1'],
    ['ack','user-1','store-1','generation-4']
  ]);
});
