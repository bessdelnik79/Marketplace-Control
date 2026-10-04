import { formatScale4Money, parseScale4Money, validateCalendarDate } from './financial-overview.mjs';

const dayMs=86400000;

function invalid(code){throw new Error(code);}
function dayNumber(value){
  const [year,month,day]=validateCalendarDate(value).split('-').map(Number);
  return Math.trunc(Date.UTC(year,month-1,day)/dayMs);
}
function dateFromDay(value){return new Date(value*dayMs).toISOString().slice(0,10);}
function requiredText(value){const text=String(value??'').trim();if(!text)invalid('overview_invalid_operational_data');return text;}
function count(value){
  const text=String(value??'');
  if(!/^\d+$/.test(text))invalid('overview_invalid_operational_count');
  return BigInt(text);
}
function timestamp(value){
  const date=value instanceof Date?value:new Date(value);
  if(Number.isNaN(date.getTime()))invalid('overview_invalid_freshness');
  return date.toISOString();
}
function reasons(value){
  if(!Array.isArray(value))invalid('overview_invalid_missing_reasons');
  return [...new Set(value.map(requiredText))].sort();
}
function average(value,divisor){
  const quotient=value/divisor,remainder=value%divisor;
  return quotient+(remainder*2n>=divisor?1n:0n);
}
function measure(rows,prefix,{averaged=false}={}){
  const divisor=averaged?4n:1n;
  const totalCount=rows.reduce((sum,row)=>sum+count(row[`${prefix}_count`]),0n);
  const totalAmount=rows.reduce((sum,row)=>sum+parseScale4Money(String(row[`${prefix}_amount`])),0n);
  return {
    count:averaged?`${totalCount/4n}.${String((totalCount%4n)*2500n).padStart(4,'0')}`:totalCount.toString(),
    amount:formatScale4Money(average(totalAmount,divisor))
  };
}
function rowsForDate(rows,date,productIds){
  const byProduct=new Map(rows.filter(row=>row.metric_date===date).map(row=>[String(row.product_id),row]));
  const selected=productIds.map(id=>byProduct.get(id));
  return selected.every(row=>row?.available===true&&row.currency==='RUB')?selected:null;
}
function availableRowsForDate(rows,date,productIds){
  const byProduct=new Map(rows.filter(row=>row.metric_date===date).map(row=>[String(row.product_id),row]));
  return productIds.map(id=>byProduct.get(id)).filter(row=>row?.available===true&&row.currency==='RUB');
}

function buildMetricsOverview(data){
  if(!data?.current)return {
    status:'unavailable',period:data?.period??null,updatedAt:null,quality:'unavailable',missingReasons:['operational_snapshot_missing'],
    snapshotIds:[],scope:null,orders:null,buyouts:null,dailySeries:[],comparison:{available:false,periods:0,reason:'operational_history_insufficient',orders:null,buyouts:null,dailySeries:[]}
  };
  const current=data.current;
  const start=validateCalendarDate(current.period_start),end=validateCalendarDate(current.period_end);
  const startDay=dayNumber(start),endDay=dayNumber(end);
  if(endDay<startDay||endDay-startDay>365)invalid('overview_invalid_operational_period');
  const periodDays=endDay-startDay+1;
  const productIds=[...new Set((current.product_ids??[]).map(requiredText))];
  if(!productIds.length)invalid('overview_invalid_scope');
  const rows=Array.isArray(data.rows)?data.rows:invalid('overview_invalid_operational_data');
  const savedDates=new Set();
  const currentGroups=[];
  const dailySeries=[];
  for(let day=startDay;day<=endDay;day++){
    const date=dateFromDay(day);
    let availableRows=availableRowsForDate(rows,date,productIds);
    if(availableRows.length<productIds.length){
      const saved=rowsForDate(data.savedRows??[],date,productIds);
      if(saved){availableRows=saved;savedDates.add(date);}
    }
    currentGroups.push(...availableRows);
    const dayQuality=availableRows.length===productIds.length?'complete':availableRows.length?'partial':'unavailable';
    dailySeries.push({date,quality:dayQuality,available:availableRows.length>0,orders:availableRows.length?measure(availableRows,'order'):null,buyouts:availableRows.length?measure(availableRows,'buyout'):null});
  }
  const expected=(endDay-startDay+1)*productIds.length;
  const currentRows=rows.filter(row=>{
    const day=dayNumber(row.metric_date);
    return day>=startDay&&day<=endDay&&productIds.includes(String(row.product_id));
  });
  const baseReasons=reasons([
    ...(savedDates.size===periodDays?[]:current.missing_reasons??[]),
    ...currentRows.filter(row=>row.available!==true&&!savedDates.has(row.metric_date)).flatMap(row=>row.missing_reasons??[])
  ]);
  const availableCount=currentGroups.length;
  const quality=availableCount===expected&&(current.quality==='complete'||savedDates.size>0)?'complete':availableCount?'partial':'unavailable';
  const missingReasons=[...new Set([...(quality==='complete'?[]:baseReasons),...(availableCount===expected?[]:['operational_metric_unavailable'])])].sort();
  const snapshotIds=[...new Set(currentGroups.map(row=>requiredText(row.snapshot_id)))].sort();
  const updatedAt=currentGroups.length
    ? currentGroups.map(row=>timestamp(row.fetched_at)).sort().at(savedDates.size?0:-1)
    : null;
  const baselineGroups=[];
  const baselineDaily=[];
  let baselineComplete=true;
  for(let day=startDay;day<=endDay;day++){
    const date=dateFromDay(day),dayRows=[];
    for(let offset=1;offset<=4;offset++){
      const comparisonRows=rowsForDate(rows,dateFromDay(day-offset*periodDays),productIds);
      if(!comparisonRows){baselineComplete=false;break;}
      dayRows.push(...comparisonRows);
    }
    if(!baselineComplete)break;
    baselineGroups.push(...dayRows);
    baselineDaily.push({date,orders:measure(dayRows,'order',{averaged:true}),buyouts:measure(dayRows,'buyout',{averaged:true})});
  }
  const comparison=quality==='complete'&&baselineComplete&&!savedDates.size?{
    available:true,periods:4,reason:null,orders:measure(baselineGroups,'order',{averaged:true}),buyouts:measure(baselineGroups,'buyout',{averaged:true}),dailySeries:baselineDaily
  }:{available:false,periods:0,reason:savedDates.size?'operational_saved_snapshot':quality==='complete'?'operational_history_insufficient':'operational_current_incomplete',orders:null,buyouts:null,dailySeries:[]};
  return {
    status:quality==='unavailable'?'unavailable':'available',snapshotIds,savedDataUsed:savedDates.size>0,
    period:{start,end,timezone:'Europe/Moscow'},updatedAt,quality,missingReasons,
    scope:{type:'selected_products',productIds},orders:availableCount?measure(currentGroups,'order'):null,
    buyouts:availableCount?measure(currentGroups,'buyout'):null,dailySeries,comparison
  };
}

export function buildOperationalOverview(data){
  const result=buildMetricsOverview(data);
  const returnMetrics=rows=>rows.map(row=>({...row,
    available:row.available===true&&row.cancel_count!=null&&row.cancel_amount!=null,
    order_count:row.cancel_count,order_amount:row.cancel_amount,buyout_count:row.cancel_count,buyout_amount:row.cancel_amount
  }));
  const returns=buildMetricsOverview({...data,savedRows:returnMetrics(data?.savedRows??[]),rows:returnMetrics(data?.rows??[]),current:data?.current?{...data.current,quality:'complete',missing_reasons:[]}:null});
  result.returnData={status:returns.status,quality:returns.quality,savedDataUsed:returns.savedDataUsed,missingReasons:returns.missingReasons,
    updatedAt:returns.orders?returns.updatedAt:null,snapshotIds:returns.snapshotIds,returns:returns.orders,
    dailySeries:returns.dailySeries.map(day=>({date:day.date,quality:day.quality,available:day.available,returns:day.orders})),
    comparison:{available:returns.comparison.available,periods:returns.comparison.periods,reason:returns.comparison.reason,
      returns:returns.comparison.orders,dailySeries:returns.comparison.dailySeries.map(day=>({date:day.date,returns:day.orders}))}};
  if(data?.updateStatus)result.updateStatus=data.updateStatus;
  return result;
}
