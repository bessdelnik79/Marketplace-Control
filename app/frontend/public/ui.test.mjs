import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { startFinancialResultPolling, startFinancialSyncPolling } from './financial-poll.js';

function response(body,{ok=true,status=ok?200:500}={}){return{ok,status,async json(){return body}}}

function harness({fetchImpl=async()=>response({status:'running',publicationId:'publication-1'}),hidden=false,now=()=>0,startedAt=0}={}){
  let timerId=0,reloads=0,removals=0,noteShown=false,visibilityListener;
  const timers=new Map();
  const controller=startFinancialResultPolling({
    element:{querySelector(){return{removeAttribute(name){if(name==='hidden')noteShown=true}}}},
    storage:{remove(){removals++}},statusUrl:'/overview/financial-status',publicationId:'publication-1',fetchImpl,
    reload(){reloads++},now,startedAt,
    setTimer(fn,delay){const id=++timerId;timers.set(id,{fn,delay});return id},clearTimer(id){timers.delete(id)},
    isHidden:()=>hidden,addVisibilityListener(listener){visibilityListener=listener}
  });
  return{controller,timers,get reloads(){return reloads},get removals(){return removals},get noteShown(){return noteShown},setHidden(value){hidden=value},show(){visibilityListener()}};
}

const delays=h=>[...h.timers.values()].map(timer=>timer.delay);

test('poll module load failure exposes the existing manual refresh fallback',async()=>{
  const source=await readFile(new URL('./ui.js',import.meta.url),'utf8');
  assert.match(source,/import\('\/financial-poll\.js'\)[^;]+\.catch\(\(\)=>\{\$\('\[data-financial-poll-note\]'/);
});

test('calculating response schedules another background check without reloading',async()=>{
  const h=harness();
  await h.controller.checkNow();
  assert.equal(h.reloads,0);
  assert.deepEqual(delays(h),[4000]);
});

test('new publication clears polling state and reloads exactly once',async()=>{
  const h=harness({fetchImpl:async()=>response({status:'current',publicationId:'publication-2'})});
  await h.controller.checkNow();
  await h.controller.checkNow();
  assert.equal(h.removals,1);
  assert.equal(h.reloads,1);
  assert.equal(h.timers.size,0);
});

test('current unchanged publication stops quietly and terminal failure reloads its badge',async()=>{
  const current=harness({fetchImpl:async()=>response({status:'current',publicationId:'publication-1'})});
  await current.controller.checkNow();
  assert.equal(current.reloads,0);assert.equal(current.removals,1);assert.equal(current.timers.size,0);
  const failed=harness({fetchImpl:async()=>response({status:'failed',publicationId:'publication-1'})});
  await failed.controller.checkNow();
  assert.equal(failed.reloads,1);assert.equal(failed.removals,1);
});

test('network and non-ok responses keep background polling alive',async()=>{
  for(const fetchImpl of [async()=>{throw new Error('offline')},async()=>response('',{ok:false})]){
    const h=harness({fetchImpl});
    await h.controller.checkNow();
    assert.equal(h.reloads,0);
    assert.deepEqual(delays(h),[4000]);
  }
});

test('deadline shows the manual refresh note without making a request',async()=>{
  let requests=0;
  const h=harness({fetchImpl:async()=>{requests++;return response({status:'running',publicationId:'publication-1'})},now:()=>600000});
  await h.controller.checkNow();
  assert.equal(requests,0);
  assert.equal(h.noteShown,true);
  assert.equal(h.timers.size,0);
});

test('hidden page waits until it becomes visible',()=>{
  const h=harness({hidden:true});
  assert.equal(h.timers.size,0);
  h.setHidden(false);
  h.show();
  assert.deepEqual(delays(h),[4000]);
});

test('a hanging request is aborted and polling resumes',async()=>{
  const h=harness({fetchImpl:(_url,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted'))))});
  const checking=h.controller.checkNow();
  const timeout=[...h.timers.entries()].find(([,timer])=>timer.delay===12000);
  assert.ok(timeout);
  h.timers.delete(timeout[0]);
  timeout[1].fn();
  await checking;
  assert.deepEqual(delays(h),[4000]);
});

function syncHarness({fetchImpl=async()=>response({running:true,title:'Загрузка',note:'44 из 53',buttonLabel:'Загрузка выполняется',buttonDisabled:true,busy:true}),hidden=false}={}){
  let nextId=0,visibilityListener;const timers=new Map(),updates=[];
  const controller=startFinancialSyncPolling({statusUrl:'/financial-reports/status?storeId=store-1',fetchImpl,update:value=>updates.push(value),isHidden:()=>hidden,
    addVisibilityListener:listener=>{visibilityListener=listener},setTimer(fn,delay){const id=++nextId;timers.set(id,{fn,delay});return id},clearTimer(id){timers.delete(id)}});
  return{controller,timers,updates,setHidden:value=>{hidden=value},show:()=>visibilityListener()};
}

test('financial sync polling updates only panel state and keeps polling while active',async()=>{
  const h=syncHarness();
  await h.controller.checkNow();
  assert.equal(h.updates.length,1);assert.equal(h.updates[0].title,'Загрузка');
  assert.deepEqual([...h.timers.values()].map(timer=>timer.delay),[5000]);
});

test('financial sync polling stops after terminal state without reloading the page',async()=>{
  const h=syncHarness({fetchImpl:async()=>response({running:false,title:'Загружено не полностью',note:'44 из 53',buttonLabel:'Обновить отчёты',buttonDisabled:false,busy:false})});
  await h.controller.checkNow();
  assert.equal(h.updates.length,1);assert.equal(h.updates[0].running,false);assert.equal(h.timers.size,0);
  const source=await readFile(new URL('./ui.js',import.meta.url),'utf8');
  assert.doesNotMatch(source,/startFinancialSyncPolling\([^;]+location\.reload/);
  assert.match(source,/title\.textContent=state\.title/);
  assert.match(source,/note\.textContent=state\.note/);
});

test('financial sync network errors retry and hidden pages wait until visible',async()=>{
  const failed=syncHarness({fetchImpl:async()=>{throw new Error('offline')}});await failed.controller.checkNow();
  assert.equal(failed.updates.length,0);assert.deepEqual([...failed.timers.values()].map(timer=>timer.delay),[5000]);
  const hidden=syncHarness({hidden:true});assert.equal(hidden.timers.size,0);hidden.setHidden(false);hidden.show();
  assert.deepEqual([...hidden.timers.values()].map(timer=>timer.delay),[5000]);
});

test('financial sync reports persistent network failure and slows retries',async()=>{
  const errors=[];let nextId=0;const timers=new Map();
  const controller=startFinancialSyncPolling({statusUrl:'/status',fetchImpl:async()=>{throw new Error('offline')},update(){},onError:value=>errors.push(value),maxConsecutiveErrors:2,
    setTimer(fn,delay){const id=++nextId;timers.set(id,{fn,delay});return id},clearTimer(id){timers.delete(id)}});
  await controller.checkNow();assert.equal(errors.length,0);
  await controller.checkNow();assert.deepEqual(errors,[{reason:'unavailable',terminal:false}]);
  assert.ok([...timers.values()].some(timer=>timer.delay===30000));
});

test('financial sync stops on an expired session and exposes an auth error',async()=>{
  const errors=[];let nextId=0;const timers=new Map();
  const controller=startFinancialSyncPolling({statusUrl:'/status',fetchImpl:async()=>response(null,{ok:false,status:401}),update(){},onError:value=>errors.push(value),
    setTimer(fn,delay){const id=++nextId;timers.set(id,{fn,delay});return id},clearTimer(id){timers.delete(id)}});
  await controller.checkNow();assert.deepEqual(errors,[{reason:'auth',terminal:true}]);assert.equal(timers.size,0);
});

test('financial sync hanging status request is aborted and polling resumes',async()=>{
  const h=syncHarness({fetchImpl:(_url,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted'))))});
  const checking=h.controller.checkNow(),timeout=[...h.timers.entries()].find(([,timer])=>timer.delay===12000);
  assert.ok(timeout);h.timers.delete(timeout[0]);timeout[1].fn();await checking;
  assert.deepEqual([...h.timers.values()].map(timer=>timer.delay),[5000]);
});
