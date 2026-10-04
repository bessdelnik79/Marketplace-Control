import {createHash} from 'node:crypto';
import {validateCalendarDate,parseScale4Money,formatScale4Money} from '../overview/financial-overview.mjs';

export const wbPurchasedReturnsEndpoint='https://statistics-api.wildberries.ru/api/v1/supplier/sales';
const dayMs=86400000;
const checksum=value=>createHash('sha256').update(value).digest('hex');
function todayNumber(now){
  if(!(now instanceof Date)||Number.isNaN(now.getTime()))throw new Error('operational_invalid_clock');
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));
  return Date.parse(`${parts.year}-${parts.month}-${parts.day}T00:00:00Z`)/dayMs;
}
const dayNumber=date=>Date.parse(`${validateCalendarDate(date)}T00:00:00Z`)/dayMs;
const dateFor=day=>new Date(day*dayMs).toISOString().slice(0,10);
function changedAt(value){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/.test(value))throw new Error('operational_returns_invalid_response');
  const date=Date.parse(/[Zz]|[+-]\d{2}:\d{2}$/.test(value)?value:`${value}+03:00`);
  if(!Number.isFinite(date))throw new Error('operational_returns_invalid_response');
  return date;
}
function operationDate(value){
  changedAt(value);
  // WB reports these timestamps in Moscow time. Explicit offsets are converted.
  if(/Z$|[+-]\d{2}:\d{2}$/.test(value))return dateFor(todayNumber(new Date(value)));
  return validateCalendarDate(value.slice(0,10));
}
export function parsePurchasedReturnsJson(raw){
  try{return JSON.parse(raw.replace(/("(?:nmId|priceWithDisc)"\s*:\s*)(-?\d+(?:\.\d+)?)(?=\s*[,}])/g,'$1"$2"'));}
  catch{throw new Error('operational_returns_invalid_response');}
}

export async function loadWbPurchasedReturns(token,{nmIds,dateFrom,dateTo,now=new Date(),clock=()=>now,fetchImpl=fetch,beforeRequest=async()=>{}}={}){
  if(!Array.isArray(nmIds)||!nmIds.length||nmIds.some(id=>!Number.isSafeInteger(id)||id<=0)||new Set(nmIds).size!==nmIds.length)throw new Error('operational_invalid_nm_ids');
  const from=dayNumber(dateFrom),to=dayNumber(dateTo),today=todayNumber(now);
  if(to<from||to-from>6||to>today||typeof clock!=='function')throw new Error('operational_invalid_period');
  const selected=new Set(nmIds),events=new Map(),pages=[],covered=new Set(),outsideRetention=[],missing=[];
  for(let day=from;day<=to;day++){
    const date=dateFor(day);
    if(day<today-89){outsideRetention.push(date);continue;}
    await beforeRequest({endpoint:wbPurchasedReturnsEndpoint,dateFrom:date,dateTo:date,nmIds});
    if(day<todayNumber(clock())-89){outsideRetention.push(date);continue;}
    const url=new URL(wbPurchasedReturnsEndpoint);url.searchParams.set('dateFrom',date);url.searchParams.set('flag','1');
    let response;
    try{response=await fetchImpl(url.href,{headers:{Authorization:token},signal:AbortSignal.timeout(30000)});}
    catch{throw new Error('operational_returns_unavailable');}
    if(response.status===401||response.status===403)throw new Error('operational_unauthorized');
    if(response.status===402)throw new Error('operational_payment_required');
    if(response.status===429)throw new Error('operational_rate_limited');
    if(!response.ok)throw new Error(response.status>=500?'operational_returns_unavailable':'operational_invalid_request');
    const raw=await response.text();
    if(Buffer.byteLength(raw)>32*1024*1024)throw new Error('operational_returns_too_large');
    const rows=parsePurchasedReturnsJson(raw);
    if(!Array.isArray(rows))throw new Error('operational_returns_invalid_response');
    for(const row of rows){
      const nmId=Number(row.nmId),id=row.saleID;
      if(!Number.isSafeInteger(nmId)||nmId<=0||typeof id!=='string'||!/^\S+$/.test(id)||!['S','R'].includes(id[0]))throw new Error('operational_returns_invalid_response');
      if(operationDate(row.date)!==date)throw new Error('operational_unexpected_date');
      const changed=changedAt(row.lastChangeDate);
      if(!selected.has(nmId))continue;
      if(typeof row.srid!=='string'||!row.srid.trim())throw new Error('operational_returns_invalid_response');
      const previous=events.get(id),encoded=JSON.stringify(row);
      if(previous?.changed===changed&&previous.encoded!==encoded)throw new Error('operational_returns_duplicate_conflict');
      if(!previous||changed>previous.changed)events.set(id,{row,nmId,date,changed,encoded});
    }
    pages.push({date,raw,checksum:checksum(raw)});covered.add(date);
  }
  const sums=new Map();
  for(const event of events.values()){
    if(event.row.saleID[0]!=='R')continue;
    const value=String(event.row.priceWithDisc??'');
    if(!/^-?\d+(?:\.\d{1,4})?$/.test(value))throw new Error('operational_returns_invalid_response');
    const amount=parseScale4Money(value),key=`${event.nmId}:${event.date}`;
    const total=sums.get(key)??{count:0,amount:0n,pending:false};
    total.count++;total.amount+=amount<0n?-amount:amount;total.pending ||= amount===0n;sums.set(key,total);
  }
  const rows=[];
  for(let day=from;day<=to;day++)for(const nmId of nmIds){
    const date=dateFor(day);
    if(!covered.has(date)){missing.push({nmId,date,reason:'operational_returns_history_unavailable'});continue;}
    const total=sums.get(`${nmId}:${date}`)??{count:0,amount:0n,pending:false};
    rows.push({nmId,date,returnCount:total.count,returnSum:total.pending?null:formatScale4Money(total.amount)});
    if(total.pending)missing.push({nmId,date,reason:'operational_returns_amount_pending'});
  }
  const raw=JSON.stringify({endpoint:wbPurchasedReturnsEndpoint,flag:1,aggregation:'return_event_date',amountField:'priceWithDisc',pages,outsideRetention});
  if(Buffer.byteLength(raw)>32*1024*1024)throw new Error('operational_returns_too_large');
  return {rows,missing,raw,rawChecksum:checksum(raw)};
}
