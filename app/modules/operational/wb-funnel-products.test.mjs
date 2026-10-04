import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {loadWbFunnelProductsDay,loadWbFunnelProductsHistory,normalizeFunnelProducts,parseFunnelProductsJson} from './wb-funnel-products.mjs';
import {wbSalesFunnelHistoryEndpoint} from './wb-sales-funnel.mjs';

function payload(date,{currency='RUB',cancelCount=2,cancelSum='12.3456',nmId='7400001'}={}){
  return {data:{currency,products:[{product:{nmId},statistic:{selected:{period:{start:date,end:date},orderCount:5,orderSum:'9007199254740993.1250',buyoutCount:3,buyoutSum:'12.34',cancelCount,cancelSum}}}]}};
}

test('daily products support more than twenty selected cards without weakening duplicate checks',()=>{
  const nmIds=Array.from({length:25},(_,index)=>7400001+index),date='2026-10-01';
  const data={data:{currency:'RUB',products:nmIds.map(nmId=>payload(date,{nmId:String(nmId)}).data.products[0])}};
  const result=normalizeFunnelProducts(data,{nmIds,date});assert.equal(result.rows.length,25);assert.equal(result.missing.length,0);
  data.data.products.push(data.data.products[0]);assert.throws(()=>normalizeFunnelProducts(data,{nmIds,date}),/operational_duplicate_row/);
});
test('daily products use root currency and exact cancellations including after-purchase returns',()=>{
  const result=normalizeFunnelProducts(payload('2026-10-01'),{nmIds:[7400001],date:'2026-10-01'});
  assert.equal(result.rows[0].cancelCount,2);
  assert.equal(result.rows[0].cancelSum,'12.3456');
  assert.equal(result.rows[0].orderSum,'9007199254740993.125');
  assert.equal(result.rows[0].currency,'RUB');
});
test('zero is confirmed only on explicit returned selected product and date',()=>{
  const result=normalizeFunnelProducts(payload('2026-10-01',{cancelCount:0,cancelSum:'0'}),{nmIds:[7400001,7400002],date:'2026-10-01'});
  assert.equal(result.rows[0].cancelCount,0);
  assert.equal(result.missing.length,1);
  assert.throws(()=>normalizeFunnelProducts(payload('2026-10-02'),{nmIds:[7400001],date:'2026-10-01'}),/operational_unexpected_date/);
});
test('missing currency and cancellation fields fail closed without assuming rubles or zero',()=>{
  const withoutCurrency=payload('2026-10-01');delete withoutCurrency.data.currency;
  assert.throws(()=>normalizeFunnelProducts(withoutCurrency,{nmIds:[7400001],date:'2026-10-01'}),/operational_invalid_currency/);
  const withoutCancel=payload('2026-10-01');delete withoutCancel.data.products[0].statistic.selected.cancelCount;
  assert.throws(()=>normalizeFunnelProducts(withoutCancel,{nmIds:[7400001],date:'2026-10-01'}),/operational_invalid_response/);
  assert.throws(()=>normalizeFunnelProducts(payload('2026-10-01',{currency:'USD'}),{nmIds:[7400001],date:'2026-10-01'}),/operational_currency_mismatch/);
});
test('loader makes one request per exact day and preserves every raw response',async()=>{
  const calls=[],reserves=[];
  const response=await loadWbFunnelProductsHistory('token',{nmIds:[7400001],dateFrom:'2026-10-01',dateTo:'2026-10-02',now:new Date('2026-10-04T00:00:00Z'),beforeRequest:async()=>reserves.push(true),fetchImpl:async(url,options)=>{
    const body=JSON.parse(options.body);calls.push({url,body});
    const data=payload(body.selectedPeriod.start);
    return {status:200,ok:true,text:async()=>JSON.stringify(data)};
  }});
  assert.equal(calls.length,2);assert.equal(reserves.length,2);assert.equal(response.rows.length,2);
  assert.deepEqual(calls[0].body,{selectedPeriod:{start:'2026-10-01',end:'2026-10-01'},pastPeriod:{start:'2025-10-04',end:'2026-09-30'},nmIds:[7400001],skipDeletedNm:false,limit:1000,offset:0});
  assert.deepEqual(calls[1].body.pastPeriod,{start:'2025-10-04',end:'2026-10-01'});
  const stored=JSON.parse(response.raw);
  assert.equal(stored.pages.length,2);
  assert.equal(parseFunnelProductsJson(stored.pages[0].raw).data.currency,'RUB');
});
test('numeric cancellation sums survive JSON parse without IEEE754 rounding',()=>{
  const raw='{"data":{"currency":"RUB","products":[{"product":{"nmId":7400001},"statistic":{"selected":{"period":{"start":"2026-10-01","end":"2026-10-01"},"orderCount":1,"orderSum":9007199254740993.125,"buyoutCount":1,"buyoutSum":1,"cancelCount":1,"cancelSum":9007199254740993.125}}}]}}';
  const result=normalizeFunnelProducts(parseFunnelProductsJson(raw),{nmIds:[7400001],date:'2026-10-01'});
  assert.equal(result.rows[0].cancelSum,'9007199254740993.125');
});

test('wide prior lookup includes explicitly zero selected products without importing past metrics',async()=>{
  const calls=[];
  const result=await loadWbFunnelProductsHistory('token',{nmIds:[7400001,7400002],dateFrom:'2026-10-03',dateTo:'2026-10-03',now:new Date('2026-10-04T00:00:00Z'),fetchImpl:async(url,options)=>{
    const body=JSON.parse(options.body);calls.push({url,body});
    const data=payload('2026-10-03');
    const zero=payload('2026-10-03',{nmId:'7400002',cancelCount:0,cancelSum:'0'}).data.products[0];
    Object.assign(zero.statistic.selected,{orderCount:0,orderSum:'0',buyoutCount:0,buyoutSum:'0'});
    data.data.products.push(zero);
    for(const product of data.data.products)product.statistic.past={period:body.pastPeriod,orderCount:999,orderSum:'999999',buyoutCount:999,buyoutSum:'999999',cancelCount:999,cancelSum:'999999'};
    return {status:200,ok:true,text:async()=>JSON.stringify(data)};
  }});
  assert.equal(calls.length,1);
  assert.deepEqual(calls[0].body.pastPeriod,{start:'2025-10-04',end:'2026-10-02'});
  assert.deepEqual(result.rows[1],{nmId:7400002,date:'2026-10-03',currency:'RUB',orderCount:0,orderSum:'0',buyoutCount:0,buyoutSum:'0',cancelCount:0,cancelSum:'0'});
  assert.equal(result.rows[0].orderCount,5);assert.equal(result.rows[0].cancelCount,2);assert.deepEqual(result.missing,[]);
});

function history(nmId,dates){
  return {product:{nmId:String(nmId)},currency:'RUB',history:dates.map(date=>({date,orderCount:9,orderSum:'123.4567',buyoutCount:4,buyoutSum:'45.67'}))};
}

test('recent missing product days recover orders without replacing primary rows or claiming cancellations',async()=>{
  const calls=[],rawResponses=[];
  const result=await loadWbFunnelProductsHistory('token',{nmIds:[7400002,7400001],dateFrom:'2026-10-01',dateTo:'2026-10-02',now:new Date('2026-10-04T00:00:00Z'),fetchImpl:async(url,options)=>{
    const body=JSON.parse(options.body);calls.push({url,body});
    const data=url===wbSalesFunnelHistoryEndpoint?[history(7400002,['2026-10-01','2026-10-02'])]:{data:{currency:'RUB',products:[...payload(body.selectedPeriod.start).data.products,...(body.selectedPeriod.start==='2026-10-02'?payload('2026-10-02',{nmId:'7400002',cancelCount:7}).data.products:[])]}};
    const raw=JSON.stringify(data);rawResponses.push(raw);
    return {status:200,ok:true,text:async()=>raw};
  }});
  assert.equal(calls.length,3);assert.deepEqual(calls[2].body.nmIds,[7400002]);
  assert.deepEqual(calls[2].body.selectedPeriod,{start:'2026-10-01',end:'2026-10-02'});
  assert.deepEqual(result.rows.map(row=>[row.date,row.nmId]),[['2026-10-01',7400001],['2026-10-01',7400002],['2026-10-02',7400001],['2026-10-02',7400002]]);
  assert.deepEqual(result.missing,[]);
  const recovered=result.rows[1];assert.equal(recovered.orderCount,9);assert.equal(recovered.orderSum,'123.4567');
  assert.equal(Object.hasOwn(recovered,'cancelCount'),false);assert.equal(Object.hasOwn(recovered,'cancelSum'),false);
  assert.equal(result.rows[3].orderCount,5);assert.equal(result.rows[3].cancelCount,7);assert.equal(result.rows[3].cancelSum,'12.3456');
  const stored=JSON.parse(result.raw);
  assert.deepEqual(stored.pages.map(page=>page.raw),rawResponses.slice(0,2));
  assert.equal(stored.fallbackPages[0].endpoint,wbSalesFunnelHistoryEndpoint);
  assert.equal(stored.fallbackPages[0].raw,rawResponses[2]);
  assert.equal(stored.fallbackPages[0].checksum,createHash('sha256').update(rawResponses[2]).digest('hex'));
  assert.equal(result.rawChecksum,createHash('sha256').update(result.raw).digest('hex'));
});

test('missing days in both sources remain missing without zero rows',async()=>{
  const calls=[];
  const result=await loadWbFunnelProductsHistory('token',{nmIds:[7400001],dateFrom:'2026-10-01',dateTo:'2026-10-01',now:new Date('2026-10-04T00:00:00Z'),fetchImpl:async(url)=>{
    calls.push(url);return {status:200,ok:true,text:async()=>JSON.stringify(url===wbSalesFunnelHistoryEndpoint?[]:{data:{currency:'RUB',products:[]}})};
  }});
  assert.equal(calls.length,2);assert.deepEqual(result.rows,[]);assert.deepEqual(result.missing,[{nmId:7400001,date:'2026-10-01'}]);
  assert.equal(JSON.parse(result.raw).fallbackPages.length,1);
});

test('fallback never requests historical dates outside the latest seven Moscow calendar days',async()=>{
  for(const [dateFrom,dateTo] of [['2026-09-20','2026-09-21']]){
    const calls=[];
    const result=await loadWbFunnelProductsHistory('token',{nmIds:[7400001],dateFrom,dateTo,now:new Date('2026-10-04T00:00:00Z'),fetchImpl:async(url)=>{
      calls.push(url);return {status:200,ok:true,text:async()=>JSON.stringify({data:{currency:'RUB',products:[]}})};
    }});
    assert.equal(calls.length,2);assert.equal(result.missing.length,2);assert.deepEqual(JSON.parse(result.raw).fallbackPages,[]);
  }
});

test('daily comparison clips history to WB horizon and ends before the selected day',async()=>{
  const now=new Date('2026-10-03T21:00:00Z'),calls=[];
  const fetchImpl=async(url,options)=>{
    const body=JSON.parse(options.body);calls.push(body);
    return {status:200,ok:true,text:async()=>JSON.stringify(payload(body.selectedPeriod.start))};
  };
  for(const date of ['2026-09-28','2025-10-05','2026-10-04'])await loadWbFunnelProductsDay('token',{nmIds:[7400001],date,now,fetchImpl});
  assert.deepEqual(calls[0].pastPeriod,{start:'2025-10-04',end:'2026-09-27'});
  assert.deepEqual(calls[1].pastPeriod,{start:'2025-10-04',end:'2025-10-04'});
  assert.deepEqual(calls[2].pastPeriod,{start:'2025-10-05',end:'2026-10-03'});
});

test('day and history reject invalid clocks, old and future selected dates before requests',async()=>{
  const events=[],options={nmIds:[7400001],now:new Date('2026-10-04T00:00:00Z'),
    beforeRequest:async()=>events.push('reserve'),fetchImpl:async()=>{events.push('fetch');throw new Error('unexpected_fetch');}};
  for(const date of ['2025-10-04','2026-10-05'])await assert.rejects(loadWbFunnelProductsDay('token',{...options,date}),/operational_invalid_period/);
  for(const now of [new Date('invalid'),'2026-10-04'])await assert.rejects(loadWbFunnelProductsDay('token',{...options,date:'2026-10-04',now}),/operational_invalid_clock/);
  for(const [dateFrom,dateTo] of [['2025-10-04','2025-10-05'],['2026-10-03','2026-10-05']])await assert.rejects(loadWbFunnelProductsHistory('token',{...options,dateFrom,dateTo}),/operational_invalid_period/);
  await assert.rejects(loadWbFunnelProductsHistory('token',{...options,dateFrom:'2026-10-03',dateTo:'2026-10-04',now:new Date('invalid')}),/operational_invalid_clock/);
  assert.deepEqual(events,[]);
});

test('Moscow midnight during rate wait advances comparison horizon before HTTP',async()=>{
  const now=new Date('2026-10-03T20:59:59Z');let actualNow=now;
  const calls=[];
  await loadWbFunnelProductsHistory('token',{nmIds:[7400001],dateFrom:'2026-09-28',dateTo:'2026-09-28',now,clock:()=>actualNow,
    beforeRequest:async()=>{actualNow=new Date('2026-10-03T21:00:00Z');},fetchImpl:async(url,options)=>{
      const body=JSON.parse(options.body);calls.push(body);
      return {status:200,ok:true,text:async()=>JSON.stringify(payload(body.selectedPeriod.start))};
    }});
  assert.equal(calls.length,1);
  assert.deepEqual(calls[0].pastPeriod,{start:'2025-10-04',end:'2026-09-27'});
});

test('expired selected horizon or invalid clock after rate wait sends no HTTP request',async()=>{
  const events=[],now=new Date('2026-10-03T20:59:59Z');
  const options={nmIds:[7400001],now,beforeRequest:async()=>events.push('reserve'),fetchImpl:async()=>{events.push('fetch');throw new Error('unexpected_fetch');}};
  await assert.rejects(loadWbFunnelProductsDay('token',{...options,date:'2025-10-04',clock:()=>new Date('2026-10-03T21:00:00Z')}),/operational_invalid_period/);
  await assert.rejects(loadWbFunnelProductsDay('token',{...options,date:'2026-09-28',clock:()=>new Date('invalid')}),/operational_invalid_clock/);
  assert.deepEqual(events,['reserve','reserve']);
});

test('fallback clips its period at Moscow midnight and retains older missing days',async()=>{
  const calls=[];
  const result=await loadWbFunnelProductsHistory('token',{nmIds:[7400001],dateFrom:'2026-09-27',dateTo:'2026-09-30',now:new Date('2026-10-03T21:00:00Z'),fetchImpl:async(url,options)=>{
    const body=JSON.parse(options.body);calls.push({url,body});
    return {status:200,ok:true,text:async()=>JSON.stringify(url===wbSalesFunnelHistoryEndpoint?[history(7400001,['2026-09-28','2026-09-29','2026-09-30'])]:{data:{currency:'RUB',products:[]}})};
  }});
  assert.deepEqual(calls[4].body.selectedPeriod,{start:'2026-09-28',end:'2026-09-30'});
  assert.deepEqual(result.missing,[{nmId:7400001,date:'2026-09-27'}]);assert.equal(result.rows.length,3);
});

test('fallback batches only missing cards at twenty and reserves the shared limiter before every request',async()=>{
  const nmIds=Array.from({length:43},(_,index)=>7400001+index),calls=[],events=[];
  const result=await loadWbFunnelProductsHistory('token',{nmIds,dateFrom:'2026-10-01',dateTo:'2026-10-01',now:new Date('2026-10-04T00:00:00Z'),beforeRequest:async()=>events.push('reserve'),fetchImpl:async(url,options)=>{
    events.push('fetch');const body=JSON.parse(options.body);calls.push({url,body});
    return {status:200,ok:true,text:async()=>JSON.stringify(url===wbSalesFunnelHistoryEndpoint?body.nmIds.map(nmId=>history(nmId,['2026-10-01'])):payload('2026-10-01'))};
  }});
  assert.deepEqual(calls.slice(1).map(call=>call.body.nmIds.length),[20,20,2]);
  assert.deepEqual(calls.slice(1).flatMap(call=>call.body.nmIds),nmIds.slice(1));
  assert.deepEqual(events,['reserve','fetch','reserve','fetch','reserve','fetch','reserve','fetch']);
  assert.equal(result.rows.length,43);assert.deepEqual(result.missing,[]);assert.equal(JSON.parse(result.raw).fallbackPages.length,3);
});

test('fallback rate-limit and currency errors fail closed',async()=>{
  for(const [status,expected] of [[429,'operational_rate_limited'],[200,'operational_currency_mismatch']]){
    await assert.rejects(loadWbFunnelProductsHistory('token',{nmIds:[7400001],dateFrom:'2026-10-01',dateTo:'2026-10-01',now:new Date('2026-10-04T00:00:00Z'),fetchImpl:async(url)=>{
      const fallback=url===wbSalesFunnelHistoryEndpoint;
      return {status:fallback?status:200,ok:!fallback||status===200,text:async()=>JSON.stringify(fallback?[{...history(7400001,['2026-10-01']),currency:'USD'}]:{data:{currency:'RUB',products:[]}})};
    }}),new RegExp(expected));
  }
});
