import test from 'node:test';
import assert from 'node:assert/strict';
import {loadWbPurchasedReturns,parsePurchasedReturnsJson} from './wb-purchased-returns.mjs';
const now=new Date('2026-10-04T12:00:00Z');
const options={nmIds:[7400001],dateFrom:'2026-10-01',dateTo:'2026-10-01',now};
const event=(saleID,overrides={})=>({saleID,srid:`order-${saleID}`,nmId:7400001,date:'2026-10-01T12:00:00',lastChangeDate:'2026-10-02T12:00:00',priceWithDisc:'-123.4567',...overrides});
const fetchRows=rows=>async()=>new Response(JSON.stringify(rows));
test('only actual return events count; sales, refusals and repeated rows do not inflate returns',async()=>{
  const returned=event('R1');
  const result=await loadWbPurchasedReturns('token',{...options,fetchImpl:fetchRows([event('S1',{isCancel:true}),returned,returned,event('R2',{nmId:7400002})])});
  assert.deepEqual(result.rows,[{nmId:7400001,date:'2026-10-01',returnCount:1,returnSum:'123.4567'}]);
  const raw=JSON.parse(result.raw);assert.equal(raw.pages.length,1);assert.equal(JSON.parse(raw.pages[0].raw).length,4);
});
test('flag one requests the full store day and confirms zero only on successful complete day responses',async()=>{
  const requests=[],slots=[];
  const result=await loadWbPurchasedReturns('token',{...options,nmIds:[7400001,7400002],dateTo:'2026-10-02',beforeRequest:async request=>slots.push(request),fetchImpl:async(url)=>{requests.push(new URL(url));return new Response('[]');}});
  assert.equal(requests.length,2);assert.equal(slots.length,2);
  assert.deepEqual(requests.map(url=>[url.searchParams.get('flag'),url.searchParams.get('dateFrom')]),[['1','2026-10-01'],['1','2026-10-02']]);
  assert.equal(result.rows.length,4);assert.ok(result.rows.every(row=>row.returnCount===0&&row.returnSum==='0.0000'));
});
test('updates deduplicate by sale identity, not order identity, and conflicting equal versions fail closed',async()=>{
  const first=event('R1'),updated=event('R1',{lastChangeDate:'2026-10-03T12:00:00',priceWithDisc:'-200.00'});
  const result=await loadWbPurchasedReturns('token',{...options,fetchImpl:fetchRows([first,updated,event('R2',{srid:first.srid})])});
  assert.equal(result.rows[0].returnCount,2);assert.equal(result.rows[0].returnSum,'323.4567');
  await assert.rejects(()=>loadWbPurchasedReturns('token',{...options,fetchImpl:fetchRows([first,{...first,priceWithDisc:'-1'}])}),/duplicate_conflict/);
});
test('unfilled return money keeps a proven count without fabricating a zero amount',async()=>{
  const result=await loadWbPurchasedReturns('token',{...options,fetchImpl:fetchRows([event('R1',{priceWithDisc:'0'})])});
  assert.equal(result.rows[0].returnCount,1);assert.equal(result.rows[0].returnSum,null);
  assert.equal(result.missing[0].reason,'operational_returns_amount_pending');
});
test('money precision survives JSON numbers beyond the safe integer range',()=>{
  assert.equal(parsePurchasedReturnsJson('[{"nmId":7400001,"priceWithDisc":-9007199254740993.1250}]')[0].priceWithDisc,'-9007199254740993.1250');
});
test('history outside guaranteed retention remains unknown and makes no request',async()=>{
  const result=await loadWbPurchasedReturns('token',{...options,dateFrom:'2026-07-01',dateTo:'2026-07-02',fetchImpl:()=>assert.fail('outside retention')});
  assert.equal(result.rows.length,0);assert.equal(result.missing.length,2);assert.ok(result.missing.every(row=>row.reason==='operational_returns_history_unavailable'));
});
test('limits and malformed or wrong-day responses cannot confirm zeros',async()=>{
  await assert.rejects(()=>loadWbPurchasedReturns('token',{...options,fetchImpl:async()=>new Response('{}',{status:429})}),/operational_rate_limited/);
  await assert.rejects(()=>loadWbPurchasedReturns('token',{...options,fetchImpl:fetchRows([event('R1',{date:'2026-09-30T12:00:00'})])}),/operational_unexpected_date/);
  await assert.rejects(()=>loadWbPurchasedReturns('token',{...options,fetchImpl:fetchRows([event('R1',{saleID:''})])}),/invalid_response/);
  await assert.rejects(()=>loadWbPurchasedReturns('token',{...options,now:new Date('invalid'),fetchImpl:()=>assert.fail('invalid clock')}),/invalid_clock/);
});
test('retention is checked again after waiting across Moscow midnight',async()=>{
  let current=new Date('2026-10-03T20:59:59Z');
  const result=await loadWbPurchasedReturns('token',{nmIds:[7400001],dateFrom:'2026-07-06',dateTo:'2026-07-06',now:current,clock:()=>current,beforeRequest:async()=>{current=new Date('2026-10-03T21:00:00Z');},fetchImpl:()=>assert.fail('expired day')});
  assert.equal(result.rows.length,0);assert.equal(result.missing.length,1);
});
