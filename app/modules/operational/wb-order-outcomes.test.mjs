import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {loadWbOrderOutcomes} from './wb-order-outcomes.mjs';

const now=new Date('2026-10-10T12:00:00Z');
const order={srid:'00123',nmId:42,date:'2026-10-01T10:00:00',lastChangeDate:'2026-10-09T10:00:00',isCancel:false};
const sale={srid:'00123',nmId:42,saleID:'S001',date:'2026-10-05T10:00:00',lastChangeDate:'2026-10-09T10:00:00'};
function options(batches,extra={}){
  return {dateFrom:'2026-10-01',clock:()=>now,fetchImpl:async()=>({ok:true,status:200,text:async()=>JSON.stringify(batches.shift())}),...extra};
}
test('preserves string identity, Moscow dates, independent sale dates and raw evidence',async()=>{
  const requested=[],gated=[];
  const batches=[[order,{...order,srid:'cancelled',isCancel:true,cancelDate:'2026-10-07T09:00:00'}],[sale,{...sale,saleID:'R001',date:'2026-10-08T09:00:00'}]];
  const config=options(batches,{beforeRequest:async value=>gated.push(value)}),fetchImpl=config.fetchImpl;
  config.fetchImpl=async url=>{requested.push(new URL(url));return fetchImpl();};
  const result=await loadWbOrderOutcomes('secret',config);
  assert.equal(result.orders[0].srid,'00123');
  assert.equal(result.orders[0].orderedAt,'2026-10-01T07:00:00.000Z');
  assert.deepEqual(result.events.map(e=>[e.outcome,e.outcomeAt,e.sourceKey]),[
    ['refused','2026-10-07T06:00:00.000Z','order:cancelled'],
    ['retained','2026-10-05T07:00:00.000Z','sale:S001'],
    ['returned','2026-10-08T06:00:00.000Z','sale:R001']
  ]);
  assert.equal(result.cursors.orders,order.lastChangeDate);
  assert.equal(result.complete,true);
  assert.equal(result.observedThrough,now.toISOString());
  assert.equal(gated.length,2);
  assert.ok(requested.every(url=>url.searchParams.get('flag')==='0'));
  assert.ok(result.pages.every(page=>page.checksum===createHash('sha256').update(page.raw).digest('hex')));
});
test('empty streams valid and endpoint-specific cursors respected',async()=>{
  const result=await loadWbOrderOutcomes('secret',options([[],[]],{dateFrom:{orders:'2026-10-01',sales:'2026-10-02'}}));
  assert.deepEqual(result.events,[]);assert.deepEqual(result.cursors,{orders:'2026-10-01',sales:'2026-10-02'});
});
test('clock advances during rate wait and outer cancellation prevents network',async()=>{
  let current=now;
  const later={...order,lastChangeDate:'2026-10-10T15:01:00'};
  const result=await loadWbOrderOutcomes('secret',options([[later],[]],{clock:()=>current,beforeRequest:async()=>{current=new Date(now.getTime()+65000);}}));
  assert.equal(result.orders.length,1);
  const controller=new AbortController();controller.abort();let called=false;
  await assert.rejects(loadWbOrderOutcomes('secret',options([],{signal:controller.signal,fetchImpl:async()=>{called=true;}})));
  assert.equal(called,false);
});
test('inclusive full-page cursor preserves precision and deduplicates',async()=>{
  const row={...order,lastChangeDate:'2026-10-09T10:00:00.12345'};
  const calls=[],config=options([Array(80000).fill(row),[row],[]]),fetchImpl=config.fetchImpl;
  config.fetchImpl=async url=>{calls.push(new URL(url).searchParams.get('dateFrom'));return fetchImpl();};
  const result=await loadWbOrderOutcomes('secret',config);
  assert.equal(result.orders.length,1);assert.equal(calls[1],row.lastChangeDate);
});
test('full page with no cursor progress fails closed',async()=>{
  await assert.rejects(loadWbOrderOutcomes('secret',options([Array(80000).fill(order)],{dateFrom:order.lastChangeDate})),/cursor_stalled/);
});
test('identical duplicates accepted; conflicting immutable events rejected across updates',async()=>{
  assert.equal((await loadWbOrderOutcomes('secret',options([[order,order],[sale,sale]]))).events.length,1);
  await assert.rejects(loadWbOrderOutcomes('secret',options([[order],[sale,{...sale,date:'2026-10-06T10:00:00',lastChangeDate:'2026-10-09T11:00:00'}]])),/duplicate_conflict/);
  await assert.rejects(loadWbOrderOutcomes('secret',options([[order,{...order,nmId:43}],[]])),/duplicate_conflict/);
  await assert.rejects(loadWbOrderOutcomes('secret',options([[order,{...order,isCancel:true,cancelDate:'2026-10-07T10:00:00'}],[]])),/duplicate_conflict/);
});
test('rejects malformed dates, future dates, unsafe identifiers and unsupported events',async()=>{
  for(const patch of [{date:'2026-02-30T10:00:00'},{date:'2026-10-01T25:00:00'},{lastChangeDate:'2026-10-11T10:00:00'},{nmId:9007199254740992},{nmId:'42'},{srid:123},{isCancel:true,cancelDate:'2026-09-30T10:00:00'}]){
    await assert.rejects(loadWbOrderOutcomes('secret',options([[{...order,...patch}],[]])),/invalid_response/);
  }
  await assert.rejects(loadWbOrderOutcomes('secret',options([[],[{...sale,saleID:'X001'}]])),/invalid_response/);
});
test('safe errors for HTTP, malformed bodies, size limits and network errors',async()=>{
  for(const [status,code] of [[401,'unauthorized'],[403,'unauthorized'],[402,'payment_required'],[429,'rate_limited'],[500,'outcomes_unavailable'],[400,'invalid_request']]){
    await assert.rejects(loadWbOrderOutcomes('secret',options([],{fetchImpl:async()=>({ok:false,status})})),new RegExp(code));
  }
  for(const [raw,code] of [['{}','invalid_response'],['{','invalid_response'],[' '.repeat(32*1024*1024+1),'too_large']]){
    await assert.rejects(loadWbOrderOutcomes('secret',options([],{fetchImpl:async()=>({ok:true,status:200,text:async()=>raw})})),new RegExp(code));
  }
  await assert.rejects(loadWbOrderOutcomes('secret',options([],{fetchImpl:async()=>{throw new Error('secret');}})),error=>error.message==='operational_outcomes_unavailable');
});
