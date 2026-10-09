import {createHash} from 'node:crypto';

export const wbOrderOutcomesEndpoints=Object.freeze({
  orders:'https://statistics-api.wildberries.ru/api/v1/supplier/orders',
  sales:'https://statistics-api.wildberries.ru/api/v1/supplier/sales'
});
const invalid=()=>new Error('operational_outcomes_invalid_response');
const maxBytes=32*1024*1024;
function timestamp(value,now,{dateOnly=false}={}){
  if(dateOnly&&typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value))value+= 'T00:00:00';
  if(typeof value!=='string')throw invalid();
  const match=/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,7})?(Z|[+-]\d{2}:\d{2})?$/.exec(value);
  if(!match||Number(match[2])>23||Number(match[3])>59||Number(match[4])>59)throw invalid();
  const calendar=new Date(`${match[1]}T00:00:00Z`);
  if(!Number.isFinite(calendar.getTime())||calendar.toISOString().slice(0,10)!==match[1])throw invalid();
  const ms=Date.parse(match[5]?value:`${value}+03:00`);
  if(!Number.isFinite(ms)||ms>now||ms<now-21*366*86400000)throw invalid();
  return new Date(ms).toISOString();
}
function identity(row){
  if(!row||typeof row!=='object'||Array.isArray(row)||typeof row.srid!=='string'||!/^\S+$/.test(row.srid)||!Number.isSafeInteger(row.nmId)||row.nmId<=0)throw invalid();
  return {srid:row.srid,nmId:row.nmId};
}
function insertImmutable(map,key,value){
  const previous=map.get(key);
  if(previous){
    const {changedAt:oldChanged,...oldFields}=previous,{changedAt:newChanged,...newFields}=value;
    if(JSON.stringify(oldFields)!==JSON.stringify(newFields))throw new Error('operational_outcomes_duplicate_conflict');
    if(newChanged&&newChanged>oldChanged)map.set(key,value);
  }else map.set(key,value);
}

// These preliminary statistics omit some unpaid orders. Complete describes only
// retrieval of this stream, never completeness of all marketplace orders.
export async function loadWbOrderOutcomes(token,{dateFrom,fetchImpl=fetch,beforeRequest=async()=>{},clock=()=>new Date(),signal}={}){
  if(typeof token!=='string'||!token.trim()||typeof clock!=='function')throw new Error('operational_invalid_request');
  const started=clock();
  if(!(started instanceof Date)||!Number.isFinite(started.getTime()))throw new Error('operational_invalid_clock');
  const now=started.getTime(),orders=new Map(),events=new Map(),pages=[],cursors={};
  let bytes=0;
  for(const [kind,endpoint] of Object.entries(wbOrderOutcomesEndpoints)){
    let cursor=typeof dateFrom==='string'?dateFrom:dateFrom?.[kind];
    let cursorTime=timestamp(cursor,now,{dateOnly:true});
    const versions=new Map();
    for(let page=0;page<20;page++){
      await beforeRequest({endpoint,dateFrom:cursor});
      signal?.throwIfAborted();
      const url=new URL(endpoint);url.searchParams.set('dateFrom',cursor);url.searchParams.set('flag','0');
      let response,raw;
      try{
        response=await fetchImpl(url.href,{headers:{Authorization:token},signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000)});
      }catch{throw new Error('operational_outcomes_unavailable');}
      if(response.status===401||response.status===403)throw new Error('operational_unauthorized');
      if(response.status===402)throw new Error('operational_payment_required');
      if(response.status===429)throw new Error('operational_rate_limited');
      if(!response.ok)throw new Error(response.status>=500?'operational_outcomes_unavailable':'operational_invalid_request');
      try{raw=await response.text();}catch{throw new Error('operational_outcomes_unavailable');}
      bytes+=Buffer.byteLength(raw);
      if(bytes>maxBytes)throw new Error('operational_outcomes_too_large');
      let rows;
      try{rows=JSON.parse(raw);}catch{throw invalid();}
      if(!Array.isArray(rows))throw invalid();
      const observed=clock();
      if(!(observed instanceof Date)||!Number.isFinite(observed.getTime()))throw new Error('operational_invalid_clock');
      const pageNow=observed.getTime();
      pages.push({endpoint,dateFrom:cursor,raw,checksum:createHash('sha256').update(raw).digest('hex')});
      let last=cursorTime;
      for(const row of rows){
        const id=identity(row),changedAt=timestamp(row.lastChangeDate,pageNow);
        if(changedAt<cursorTime||changedAt<last)throw invalid();
        last=changedAt;
        let sourceKey;
        if(kind==='orders'){
          sourceKey=`order:${id.srid}`;
          const orderedAt=timestamp(row.date,pageNow);
          if(typeof row.isCancel!=='boolean')throw invalid();
          insertImmutable(orders,id.srid,{...id,orderedAt});
          if(row.isCancel){
            const outcomeAt=timestamp(row.cancelDate,pageNow);
            if(outcomeAt<orderedAt)throw invalid();
            insertImmutable(events,sourceKey,{...id,outcome:'refused',outcomeAt,changedAt,sourceKey});
          }
        }else{
          if(typeof row.saleID!=='string'||!/^\S+$/.test(row.saleID)||!['S','R'].includes(row.saleID[0]))throw invalid();
          sourceKey=`sale:${row.saleID}`;
          const outcomeAt=timestamp(row.date,pageNow);
          insertImmutable(events,sourceKey,{...id,outcome:row.saleID[0]==='S'?'retained':'returned',outcomeAt,changedAt,sourceKey});
        }
        // Compare only journal fields: unrelated preliminary money fields may change.
        const encoded=JSON.stringify(kind==='orders'?{...id,date:row.date,isCancel:row.isCancel,cancelDate:row.isCancel?row.cancelDate:null}:events.get(sourceKey));
        const versionKey=`${sourceKey}:${row.lastChangeDate}`;
        if(versions.has(versionKey)&&versions.get(versionKey)!==encoded)throw new Error('operational_outcomes_duplicate_conflict');
        versions.set(versionKey,encoded);
      }
      if(rows.length)cursor=rows.at(-1).lastChangeDate;
      cursors[kind]=cursor;
      if(rows.length<80000)break;
      if(last<=cursorTime)throw new Error('operational_outcomes_cursor_stalled');
      cursorTime=last;
      if(page===19)throw new Error('operational_outcomes_page_limit');
    }
  }
  const observed=clock();
  if(!(observed instanceof Date)||!Number.isFinite(observed.getTime()))throw new Error('operational_invalid_clock');
  return {orders:[...orders.values()],events:[...events.values()],pages,cursors,complete:true,observedThrough:observed.toISOString()};
}
