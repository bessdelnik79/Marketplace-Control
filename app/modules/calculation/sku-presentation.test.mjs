import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSkuPresentation} from './sku-presentation.mjs';
const item=(productId,result,revenue='100.0000',quality='complete')=>({productId,quality,metrics:{availableResultAfterTax:{amount:result,availability:result===null?'unavailable':quality},revenue:{amount:revenue,availability:quality}}});
const model=items=>({items,context:{quality:'complete'},reconciliation:{status:'matched'}});
test('all scoped products including zero and missing metrics are retained, independent of paging',()=>{
  const result=buildSkuPresentation(model([item('loss','-1.0000'),item('near','5.0000'),item('profit','5.0001'),item('zero','0.0000'),item('unknown',null)]));
  assert.deepEqual(result.items.map(i=>i.status),['loss','near','profit','zero','incomplete']);
  assert.equal(result.summary.skuResult,null);assert.equal(result.summary.totalCount,5);
  assert.equal(result.items[2].marginPercent,'5.0'); // classification uses exact amount, not rounded display
});
test('full scope totals use exact saved values, not a paginated or filtered subset',()=>{
  const result=buildSkuPresentation(model(Array.from({length:125},(_,i)=>item(String(i),'0.0001','1.0000'))));
  assert.equal(result.items.length,125);assert.equal(result.summary.skuResult,'0.0125');assert.equal(result.summary.revenue,'125.0000');
});
test('large decimal margins remain exact; zero revenue and partial metrics are not complete profit claims',()=>{
  const result=buildSkuPresentation(model([item('large','9007199254740993.1250','18014398509481986.2500'),item('no-revenue','-1.0000','0.0000'),item('partial','3.0000','100.0000','partial')]));
  assert.equal(result.items[0].marginPercent,'50.0');assert.equal(result.items[1].marginPercent,null);assert.equal(result.items[2].status,'incomplete');
  assert.equal(result.summary.skuResult,null);assert.equal(result.summary.revenue,null);
});
test('mismatched reconciliation suppresses summary and reliable classifications',()=>{
  const source=model([item('a','10.0000')]);source.reconciliation.status='mismatch';
  const result=buildSkuPresentation(source);assert.equal(result.items[0].status,'incomplete');assert.equal(result.items[0].marginPercent,null);assert.equal(result.summary.skuResult,null);assert.equal(result.summary.revenue,null);
});
test('buyout presentation uses the demo confirmed-order method per SKU and exposes missing history',()=>{
  const source=model([item('a','10.0000'),item('b','10.0000')]);source.context.period={start:'2026-08-01',end:'2026-08-31'};
  assert.equal(buildSkuPresentation(source).items[0].buyout.reason,'history_missing');
  source.orderOutcomeHistory={coverage:{start:'2025-08-31',end:'2026-08-31',complete:true},records:[{sku:'a',srid:'order-a',orderedAt:'2026-08-01',outcomeAt:'2026-08-10',outcome:'retained'}]};
  const result=buildSkuPresentation(source);assert.equal(result.items[0].buyout.percent,100);assert.equal(result.items[0].buyout.sampleSize,1);assert.equal(result.items[1].buyout.reason,'no_confirmed_orders');
});
