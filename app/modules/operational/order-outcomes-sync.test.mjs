import test from 'node:test';
import assert from 'node:assert/strict';
import {createOrderOutcomeDispatcher,orderOutcomeRange,orderOutcomeErrorCode} from './order-outcomes-sync.mjs';
import {pool as defaultPool} from '../../infrastructure/database/client.mjs';
const clock=()=>new Date('2026-10-10T12:00:00Z');
const target={user_id:'u',business_id:'b',store_id:'s'};
const token=overrides=>`header.${Buffer.from(JSON.stringify({sid:'seller',exp:2000000000,s:Number((1n<<5n)|(1n<<30n)),acc:1,t:false,...overrides})).toString('base64url')}.sig`;
const job={...target,seller_id:'seller',credential_generation:'1',products:[{nmId:42,productId:'p'}],reset:true,cursors:{}};
const source={orders:[],events:[],pages:[{endpoint:'https://statistics-api.wildberries.ru/api/v1/supplier/orders',raw:'[]',checksum:'a'.repeat(64)}],cursors:{orders:'2026-10-10',sales:'2026-10-10'},complete:true,observedThrough:clock().toISOString()};
function harness(extra={}){
  const calls=[],lease={assertActive(){},async release(){calls.push('release');}};
  const dependencies={candidates:async()=>[target],acquire:async()=>lease,begin:async()=>job,decrypt:()=>token(),reserve:async()=>({waitMs:0}),wait:async()=>{},load:async(_token,config)=>{await config.beforeRequest({endpoint:source.pages[0].endpoint});return source;},store:async()=>{calls.push('store');return {partNumber:0,storageKey:'safe',checksum:'a'.repeat(64),byteSize:42};},complete:async(_lease,_job,result)=>{calls.push(['complete',result]);},hasBatch:async()=>false,fail:async(_lease,_target,code)=>{calls.push(['fail',code]);},remove:async()=>{calls.push('remove');},randomUUID:()=> 'batch',...extra};
  const dispatcher=createOrderOutcomeDispatcher({clock,dependencies,logger:{warn(){}}});
  return {dispatcher,calls};
}
const turn=()=>new Promise(resolve=>setImmediate(resolve));
test('initial 90 calendar days and one-hour overlap with reset/floor',()=>{
  assert.deepEqual(orderOutcomeRange(job,clock()),{dateFrom:{orders:'2026-07-13',sales:'2026-07-13'},sourceFrom:'2026-07-13',coverageEnd:'2026-10-10'});
  const range=orderOutcomeRange({...job,reset:false,cursors:{orders:'2026-10-09T10:00:00',sales:'2026-10-09T10:00:00Z'}},clock());
  assert.equal(range.dateFrom.orders,'2026-10-09T06:00:00.000Z');assert.equal(range.dateFrom.sales,'2026-10-09T09:00:00.000Z');
  assert.equal(orderOutcomeRange({...job,reset:false,cursors:{orders:'2025-01-01'}},clock()).sourceFrom,'2026-07-13');
  assert.equal(orderOutcomeRange({...job,reset:false,cursors:{orders:'2026-10-08T10:00:00',sales:'2026-10-09T10:00:00'}},clock()).sourceFrom,'2026-10-09');
});
test('dispatcher without options uses the application pool',async()=>{
  const original=defaultPool.query;let queried=false;
  defaultPool.query=async sql=>{queried=true;assert.match(sql,/list_sku_order_sync_candidates/);return {rows:[]};};
  const dispatcher=createOrderOutcomeDispatcher();
  try{await dispatcher.dispatch();assert.equal(queried,true);}finally{await dispatcher.stop();defaultPool.query=original;}
});
test('success stores encrypted source refs and does not remove committed batch',async()=>{
  const {dispatcher,calls}=harness();await dispatcher.dispatch();await turn();await dispatcher.stop();
  assert.deepEqual(calls.map(c=>Array.isArray(c)?c[0]:c),['store','complete','release']);
  assert.equal(calls[1][1].objects[0].endpoint,'orders');
  assert.equal(calls[1][1].coverageEnd,'2026-10-10');
});
test('persist rejection cleans only its owned batch and records safe failure',async()=>{
  const {dispatcher,calls}=harness({complete:async()=>{throw new Error('operational_sync_superseded');}});
  await dispatcher.dispatch();await turn();await dispatcher.stop();
  assert.deepEqual(calls,['store',['fail','operational_sync_superseded'],'remove','release']);
  assert.equal(orderOutcomeErrorCode(new Error('private credential')),'operational_internal_error');
});
test('lost commit acknowledgement preserves source unless a fresh read confirms batch absent',async()=>{
  for(const present of [true,null,false]){
    const {dispatcher,calls}=harness({complete:async()=>{throw new Error('connection lost after COMMIT');},hasBatch:async()=>present});
    await dispatcher.dispatch();await turn();await dispatcher.stop();
    assert.equal(calls.includes('remove'),present===false);
    assert.equal(calls.at(-1),'release');
  }
  const {dispatcher,calls}=harness({complete:async()=>{throw new Error('connection lost');},hasBatch:async()=>{throw new Error('unavailable');}});
  await dispatcher.dispatch();await turn();await dispatcher.stop();assert.equal(calls.includes('remove'),false);
});
test('seller mismatch, expired, test and write tokens never call WB or storage',async()=>{
  for(const overrides of [{sid:'other'},{exp:1},{t:true},{s:Number(1n<<5n)},{s:Number(1n<<30n)},{acc:2}]){
    let loaded=false;
    const {dispatcher,calls}=harness({decrypt:()=>token(overrides),load:async()=>{loaded=true;}});
    await dispatcher.dispatch();await turn();await dispatcher.stop();
    assert.equal(loaded,false);assert.deepEqual(calls,[['fail','operational_unauthorized'],'release']);
  }
});
test('only two jobs run; duplicate targets, concurrent dispatch and stop abort safely',async()=>{
  let count=0,aborted=0;
  const {dispatcher}=harness({candidates:async()=>[target,{...target,store_id:'s2'},{...target,store_id:'s3'}],load:async(_token,{signal})=>{count++;return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>{aborted++;reject(new Error('stop'));},{once:true}));}});
  await dispatcher.dispatch();await turn();await dispatcher.dispatch();assert.equal(count,2);
  await dispatcher.stop();assert.equal(aborted,2);await dispatcher.dispatch();assert.equal(count,2);
});
test('stop interrupts a real reserved slot wait before network starts',async()=>{
  let loaded=false;
  // Omit the injected wait to exercise the dispatcher implementation.
  const actual=createOrderOutcomeDispatcher({clock,dependencies:{candidates:async()=>[target],acquire:async()=>({assertActive(){},release:async()=>{}}),begin:async()=>job,decrypt:()=>token(),reserve:async()=>({waitMs:65000}),load:async(_token,config)=>{await config.beforeRequest({endpoint:source.pages[0].endpoint});loaded=true;return source;},fail:async()=>{}},logger:{warn(){}}});
  await actual.dispatch();await turn();await actual.stop();assert.equal(loaded,false);
});
