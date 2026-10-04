import { createHash } from 'node:crypto';
import { validateCalendarDate } from '../overview/financial-overview.mjs';
import { loadWbSalesFunnelHistory, normalizeSalesFunnelHistory, wbSalesFunnelHistoryEndpoint } from './wb-sales-funnel.mjs';

export const wbFunnelProductsEndpoint='https://seller-analytics-api.wildberries.ru/api/analytics/v3/sales-funnel/products';

export function parseFunnelProductsJson(raw){
  try{return JSON.parse(raw.replace(/("(?:nmId|orderSum|buyoutSum|cancelSum)"\s*:\s*)(-?\d+(?:\.\d+)?)(?=\s*[,}])/g,'$1"$2"'));}
  catch{throw new Error('operational_invalid_response');}
}

export function normalizeFunnelProducts(payload,{nmIds,date}){
  validateCalendarDate(date);
  if(!Array.isArray(nmIds)||!nmIds.length||nmIds.length>1000||nmIds.some(id=>!Number.isSafeInteger(id)||id<=0)||new Set(nmIds).size!==nmIds.length)throw new Error('operational_invalid_nm_ids');
  if(!Array.isArray(payload?.data?.products))throw new Error('operational_invalid_response');
  if(!payload.data.currency)throw new Error('operational_invalid_currency');
  if(payload.data.currency!=='RUB')throw new Error('operational_currency_mismatch');
  const points=[],cancelByNm=new Map();
  for(const item of payload.data.products){
    if(!nmIds.map(String).includes(String(item.product?.nmId)))throw new Error('operational_unexpected_nm_id');
    const metric=item?.statistic?.selected;
    if(!metric || metric.period?.start!==date || metric.period?.end!==date)throw new Error('operational_unexpected_date');
    if(!Number.isSafeInteger(metric.cancelCount)||metric.cancelCount<0||typeof metric.cancelSum!=='string'||!/^\d+(?:\.\d{1,4})?$/.test(metric.cancelSum))throw new Error('operational_invalid_response');
    cancelByNm.set(String(item.product?.nmId),{cancelCount:metric.cancelCount,cancelSum:metric.cancelSum});
    points.push({product:item.product,currency:payload.data.currency,history:[{...metric,date}]});
  }
  const result={rows:[],missing:[]};
  for(let offset=0;offset<nmIds.length;offset+=20){
    const selected=nmIds.slice(offset,offset+20);
    const batch=normalizeSalesFunnelHistory(points.filter(item=>selected.map(String).includes(String(item.product?.nmId))),{nmIds:selected,dateFrom:date,dateTo:date});
    result.rows.push(...batch.rows);result.missing.push(...batch.missing);
  }
  return {...result,rows:result.rows.map(row=>({...row,...cancelByNm.get(String(row.nmId))}))};
}

export async function loadWbFunnelProductsDay(token,{nmIds,date,fetchImpl=fetch,beforeRequest=async()=>{}}={}){
  validateCalendarDate(date);
  if(!Array.isArray(nmIds)||!nmIds.length||nmIds.length>1000||nmIds.some(id=>!Number.isSafeInteger(id)||id<=0)||new Set(nmIds).size!==nmIds.length)throw new Error('operational_invalid_nm_ids');
  const day=Date.parse(`${date}T00:00:00Z`);
  const pastPeriod={start:new Date(day-364*86400000).toISOString().slice(0,10),end:new Date(day-86400000).toISOString().slice(0,10)};
  await beforeRequest({endpoint:wbFunnelProductsEndpoint,dateFrom:date,dateTo:date,nmIds});
  let response;
  try{response=await fetchImpl(wbFunnelProductsEndpoint,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({selectedPeriod:{start:date,end:date},pastPeriod,nmIds,skipDeletedNm:false,limit:1000,offset:0}),signal:AbortSignal.timeout(30000)});}
  catch{throw new Error('operational_unavailable');}
  if(response.status===401||response.status===403)throw new Error('operational_unauthorized');
  if(response.status===402)throw new Error('operational_payment_required');
  if(response.status===429)throw new Error('operational_rate_limited');
  if(!response.ok)throw new Error(response.status>=500?'operational_unavailable':'operational_invalid_request');
  const raw=await response.text();
  return {...normalizeFunnelProducts(parseFunnelProductsJson(raw),{nmIds,date}),raw,rawChecksum:createHash('sha256').update(raw).digest('hex')};
}

export async function loadWbFunnelProductsHistory(token,{nmIds,dateFrom,dateTo,now=new Date(),...options}={}){
  validateCalendarDate(dateFrom);validateCalendarDate(dateTo);
  const start=Date.parse(`${dateFrom}T00:00:00Z`),end=Date.parse(`${dateTo}T00:00:00Z`);
  if(end<start||end-start>6*86400000)throw new Error('operational_invalid_period');
  if(!(now instanceof Date)||Number.isNaN(now.getTime()))throw new Error('operational_invalid_clock');
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now).filter(part=>part.type!=='literal').map(part=>[part.type,part.value]));
  const today=Date.parse(`${parts.year}-${parts.month}-${parts.day}T00:00:00Z`);
  const fallbackStart=Math.max(start,today-6*86400000),fallbackEnd=Math.min(end,today);
  const rows=[],missing=[],pages=[];
  for(let day=start;day<=end;day+=86400000){
    const date=new Date(day).toISOString().slice(0,10);
    const response=await loadWbFunnelProductsDay(token,{nmIds,date,...options});
    rows.push(...response.rows);missing.push(...response.missing);
    pages.push({date,raw:response.raw,checksum:response.rawChecksum});
  }
  const missingKeys=new Set(missing.map(row=>`${row.nmId}:${row.date}`)),fallbackPages=[];
  if(fallbackStart<=fallbackEnd){
    const fallbackFrom=new Date(fallbackStart).toISOString().slice(0,10),fallbackTo=new Date(fallbackEnd).toISOString().slice(0,10);
    const missingIds=new Set(missing.filter(row=>row.date>=fallbackFrom&&row.date<=fallbackTo).map(row=>row.nmId));
    const selected=nmIds.filter(nmId=>missingIds.has(nmId));
    for(let offset=0;offset<selected.length;offset+=20){
      const batch=selected.slice(offset,offset+20);
      const response=await loadWbSalesFunnelHistory(token,{nmIds:batch,dateFrom:fallbackFrom,dateTo:fallbackTo,...options});
      if(response.currency&&response.currency!=='RUB')throw new Error('operational_currency_mismatch');
      for(const row of response.rows){
        const key=`${row.nmId}:${row.date}`;
        if(!missingKeys.has(key))continue;
        rows.push(row);missingKeys.delete(key);
      }
      fallbackPages.push({endpoint:wbSalesFunnelHistoryEndpoint,nmIds:batch,dateFrom:fallbackFrom,dateTo:fallbackTo,raw:response.raw,checksum:response.rawChecksum});
    }
  }
  rows.sort((left,right)=>left.date.localeCompare(right.date)||left.nmId-right.nmId);
  const raw=JSON.stringify({endpoint:wbFunnelProductsEndpoint,pages,fallbackPages});
  return {rows,missing:missing.filter(row=>missingKeys.has(`${row.nmId}:${row.date}`)),raw,rawChecksum:createHash('sha256').update(raw).digest('hex')};
}
