import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { startFinancialResultPolling, startFinancialSyncReload } from './financial-poll.js';

function response(body,{ok=true}={}){return{ok,async json(){return body}}}

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

test('financial sync reload waits while account settings have unsaved changes',()=>{
  let dirty=true,reloads=0,nextId=0;
  const timers=new Map();
  startFinancialSyncReload({reload(){reloads++},isDirty:()=>dirty,setTimer(fn,delay){const id=++nextId;timers.set(id,{fn,delay});return id},clearTimer(id){timers.delete(id)}});
  assert.deepEqual([...timers.values()].map(timer=>timer.delay),[5000]);
  let current=[...timers.entries()][0];timers.delete(current[0]);current[1].fn();
  assert.equal(reloads,0);
  dirty=false;
  current=[...timers.entries()][0];timers.delete(current[0]);current[1].fn();
  assert.equal(reloads,1);
});
