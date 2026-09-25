import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOperationalOverview } from './operational-overview.mjs';

const productIds=['product-a','product-b'];
function row(date,productId,{available=true,week=0}={}){
  return {
    product_id:productId,metric_date:date,snapshot_id:`snapshot-${week}`,currency:available?'RUB':null,available,
    order_count:available?'1':null,order_amount:available?'10.1250':null,
    buyout_count:available?'1':null,buyout_amount:available?'8.0000':null,
    fetched_at:new Date(`2026-09-${String(25-week).padStart(2,'0')}T01:00:00Z`)
  };
}
function date(day){return new Date(Date.UTC(2026,8,14)+day*86400000).toISOString().slice(0,10);}
function envelope(rows,current={}){
  return {current:{period_start:'2026-09-14',period_end:'2026-09-20',snapshot_id:'snapshot-0',quality:'complete',missing_reasons:[],product_ids:productIds,fetched_at:new Date('2026-09-25T01:00:00Z'),...current},rows};
}

test('aggregates exact current facts and withholds comparison without four exact periods',()=>{
  const rows=Array.from({length:7},(_,day)=>productIds.map(productId=>row(date(day),productId))).flat();
  const result=buildOperationalOverview(envelope(rows));
  assert.equal(result.quality,'complete');
  assert.deepEqual(result.orders,{count:'14',amount:'141.7500'});
  assert.deepEqual(result.buyouts,{count:'14',amount:'112.0000'});
  assert.equal(result.dailySeries.length,7);
  assert.deepEqual(result.snapshotIds,['snapshot-0']);
  assert.deepEqual(result.comparison,{available:false,periods:0,reason:'operational_history_insufficient',orders:null,buyouts:null,dailySeries:[]});
});

test('builds exact four-period weekday baseline',()=>{
  const rows=[];
  for(let offset=0;offset<=4;offset++)for(let day=0;day<7;day++)for(const productId of productIds){
    rows.push(row(date(day-offset*7),productId,{week:offset}));
  }
  const result=buildOperationalOverview(envelope(rows));
  assert.equal(result.comparison.available,true);
  assert.equal(result.comparison.periods,4);
  assert.deepEqual(result.comparison.orders,{count:'14.0000',amount:'141.7500'});
  assert.equal(result.comparison.dailySeries.length,7);
});

test('missing selected product is partial and is never converted to zero',()=>{
  const rows=Array.from({length:7},(_,day)=>row(date(day),'product-a'));
  const result=buildOperationalOverview(envelope(rows));
  assert.equal(result.quality,'partial');
  assert.deepEqual(result.missingReasons,['operational_metric_unavailable']);
  assert.deepEqual(result.orders,{count:'7',amount:'70.8750'});
  assert.equal(result.dailySeries.every(item=>item.quality==='partial'),true);
});

test('absent snapshot has an explicit unavailable model',()=>{
  const result=buildOperationalOverview({current:null,rows:[]});
  assert.equal(result.status,'unavailable');
  assert.equal(result.orders,null);
  assert.deepEqual(result.missingReasons,['operational_snapshot_missing']);
});
