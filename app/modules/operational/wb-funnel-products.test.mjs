import test from 'node:test';
import assert from 'node:assert/strict';
import {loadWbFunnelProductsHistory,normalizeFunnelProducts,parseFunnelProductsJson} from './wb-funnel-products.mjs';

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
  const response=await loadWbFunnelProductsHistory('token',{nmIds:[7400001],dateFrom:'2026-10-01',dateTo:'2026-10-02',beforeRequest:async()=>reserves.push(true),fetchImpl:async(url,options)=>{
    const body=JSON.parse(options.body);calls.push({url,body});
    const data=payload(body.selectedPeriod.start);
    return {status:200,ok:true,text:async()=>JSON.stringify(data)};
  }});
  assert.equal(calls.length,2);assert.equal(reserves.length,2);assert.equal(response.rows.length,2);
  assert.deepEqual(calls[0].body,{selectedPeriod:{start:'2026-10-01',end:'2026-10-01'},nmIds:[7400001],skipDeletedNm:false,limit:1000,offset:0});
  const stored=JSON.parse(response.raw);
  assert.equal(stored.pages.length,2);
  assert.equal(parseFunnelProductsJson(stored.pages[0].raw).data.currency,'RUB');
});
test('numeric cancellation sums survive JSON parse without IEEE754 rounding',()=>{
  const raw='{"data":{"currency":"RUB","products":[{"product":{"nmId":7400001},"statistic":{"selected":{"period":{"start":"2026-10-01","end":"2026-10-01"},"orderCount":1,"orderSum":9007199254740993.125,"buyoutCount":1,"buyoutSum":1,"cancelCount":1,"cancelSum":9007199254740993.125}}}]}}';
  const result=normalizeFunnelProducts(parseFunnelProductsJson(raw),{nmIds:[7400001],date:'2026-10-01'});
  assert.equal(result.rows[0].cancelSum,'9007199254740993.125');
});
