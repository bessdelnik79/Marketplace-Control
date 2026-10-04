import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOperationalOverview } from './operational-overview.mjs';

test('legacy cancellation totals cannot become purchased returns',()=>{
 const rows=productIds.map(id=>({...row(date(0),id),cancel_count:'99',cancel_amount:'999.0000'}));
 const result=buildOperationalOverview(envelope(rows,{period_end:date(0)}));
 assert.equal(result.returnData.returns,null);assert.equal(result.returnData.quality,'unavailable');
});
test('purchased return counts remain available while WB is filling in their amount',()=>{
 const rows=productIds.map(id=>({...row(date(0),id),return_count:'1',return_amount:null,cancel_count:'99',cancel_amount:'999.0000'}));
 const result=buildOperationalOverview(envelope(rows,{period_end:date(0)}));
 assert.deepEqual(result.returnData.returns,{count:'2',amount:null});assert.equal(result.returnData.quality,'partial');
 assert.equal(result.returnData.comparison.available,false);assert.ok(result.returnData.missingReasons.includes('operational_returns_amount_pending'));
});

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

test('two-day selection compares four preceding two-day periods and includes purchased returns',()=>{
  const rows=[];
  for(let day=-8;day<2;day++)for(const productId of productIds)rows.push({...row(date(day),productId),return_count:'2',return_amount:'3.1250'});
  const result=buildOperationalOverview(envelope(rows,{period_end:'2026-09-15'}));
  assert.equal(result.dailySeries.length,2);
  assert.equal(result.comparison.available,true);
  assert.deepEqual(result.comparison.orders,{count:'4.0000',amount:'40.5000'});
  assert.deepEqual(result.returnData.returns,{count:'8',amount:'12.5000'});
  assert.deepEqual(result.returnData.comparison.returns,{count:'8.0000',amount:'12.5000'});
  assert.equal(result.returnData.comparison.dailySeries.length,2);
});
test('legacy snapshots preserve orders while purchased returns remain unavailable',()=>{
  const rows=Array.from({length:7},(_,day)=>productIds.map(productId=>row(date(day),productId))).flat();
  const result=buildOperationalOverview(envelope(rows));
  assert.equal(result.quality,'complete');
  assert.equal(result.returnData.quality,'unavailable');
  assert.equal(result.returnData.returns,null);
  assert.equal(result.returnData.comparison.available,false);
});
test('current range with no facts preserves requested dates and shows unavailable rather than zero',()=>{
  const result=buildOperationalOverview(envelope([],{period_start:'2026-01-01',period_end:'2026-01-31'}));
  assert.equal(result.dailySeries.length,31);
  assert.equal(result.orders,null);
  assert.equal(result.returnData.returns,null);
  assert.equal(result.quality,'unavailable');
});

test('partial refresh preserves one whole saved day with exact scope and original freshness',()=>{
 const current=[{...row(date(0),productIds[0]),order_count:'99',return_count:'2',return_amount:'1.0000'}];
 const saved=productIds.map(id=>({...row(date(0),id,{week:1}),return_count:null,return_amount:null}));
 const model=buildOperationalOverview({...envelope(current,{period_end:date(0)}),savedRows:saved});
 assert.equal(model.quality,'complete');assert.equal(model.savedDataUsed,true);
 assert.deepEqual(model.orders,{count:'2',amount:'20.2500'});assert.deepEqual(model.missingReasons,[]);
 assert.equal(model.updatedAt,saved[0].fetched_at.toISOString());
 assert.equal(model.comparison.reason,'operational_saved_snapshot');
 assert.equal(model.returnData.quality,'partial');assert.deepEqual(model.returnData.returns,{count:'2',amount:'1.0000'});
});
test('saved incomplete scope never fabricates missing products or returns',()=>{
 const model=buildOperationalOverview({...envelope([row(date(0),productIds[0])],{period_end:date(0)}),savedRows:[row(date(0),productIds[0],{week:1})]});
 assert.equal(model.quality,'partial');assert.equal(model.savedDataUsed,false);assert.equal(model.returnData.quality,'unavailable');
});

test('saved return counts with unknown money never become zero or complete',()=>{
 const current=productIds.map(id=>({...row(date(0),id),return_count:null,return_amount:null}));
 const saved=productIds.map(id=>({...row(date(0),id,{week:1}),return_count:'1',return_amount:null}));
 const model=buildOperationalOverview({...envelope(current,{period_end:date(0)}),savedRows:saved});
 assert.equal(model.returnData.savedDataUsed,true);
 assert.deepEqual(model.returnData.returns,{count:'2',amount:null});
 assert.equal(model.returnData.quality,'partial');
 assert.ok(model.returnData.missingReasons.includes('operational_returns_amount_pending'));
 assert.equal(model.returnData.comparison.available,false);
});
test('returns beyond Statistics retention explain unknown history while orders remain readable',()=>{
 const rows=productIds.map(id=>({...row('2026-06-01',id),return_count:null,return_amount:null}));
 const model=buildOperationalOverview({...envelope(rows,{period_start:'2026-06-01',period_end:'2026-06-01'}),today:'2026-10-04'});
 assert.equal(model.quality,'complete');assert.equal(model.returnData.quality,'unavailable');
 assert.ok(model.returnData.missingReasons.includes('operational_returns_history_unavailable'));
 assert.equal(model.returnData.returns,null);
});
