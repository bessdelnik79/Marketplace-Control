import { createHash } from 'node:crypto';
import { normalizeFinancialReports, parseFinancialJson } from './finance.mjs';

export const financialDetailEndpoint = 'https://finance-api.wildberries.ru/api/finance/v1/sales-reports/detailed';

const MAX_INT64 = '9223372036854775807';
const exactDatePattern = /^\d{4}-\d{2}-\d{2}$/;

function canonicalPositiveInt64(value, errorCode) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new Error(errorCode);
  const canonical=value.replace(/^0+(?=\d)/,'');
  if (canonical==='0' || canonical.length>19 || (canonical.length===19&&canonical>MAX_INT64)) throw new Error(errorCode);
  return canonical;
}

function exactDate(value) {
  const date=String(value??'');
  if(!exactDatePattern.test(date)||Number.isNaN(Date.parse(`${date}T00:00:00Z`)))throw new Error('financial_detail_invalid_request');
  return date;
}

function requestBody(limit,rrdId) {
  const prefix=JSON.stringify({limit});
  return `${prefix.slice(0,-1)},"rrdId":${rrdId}}`;
}

function retryAfterMs(response) {
  const seconds=Number(response?.headers?.get?.('retry-after'));
  return Number.isFinite(seconds)&&seconds>=0?Math.min(seconds*1000,86400000):undefined;
}

function apiError(code,response,endpoint) {
  const error=new Error(code);
  error.status=response?.status;
  error.endpoint=endpoint;
  const retry=retryAfterMs(response);
  if(retry!==undefined)error.retryAfterMs=retry;
  return error;
}

function unsupportedCountryResponse(raw) {
  if(typeof raw!=='string'||raw.length>4096)return false;
  let value=raw;
  try{
    const body=JSON.parse(raw);
    if(!body||typeof body!=='object'||Array.isArray(body))return false;
    value=body.detail??body.message??body.error??'';
  }catch{}
  if(typeof value!=='string')return false;
  const normalized=value.trim().toLocaleLowerCase('ru-RU').replace(/[.!]+$/,'');
  return new Set([
    'method is unavailable for your registration country',
    'method is unavailable for the registration country',
    'метод недоступен для вашей страны регистрации',
    'метод недоступен для страны регистрации'
  ]).has(normalized);
}

function validateBatch(rows,{reportId,periodStart,periodEnd}) {
  if(!Array.isArray(rows)||rows.length===0)throw new Error('financial_detail_invalid_response');
  for(const row of rows){
    if(!row||typeof row!=='object'||Array.isArray(row))throw new Error('financial_detail_invalid_response');
    let rowReportId;
    try{rowReportId=canonicalPositiveInt64(String(row.reportId??''),'financial_detail_invalid_response');}
    catch{throw new Error('financial_detail_invalid_response');}
    if(rowReportId!==reportId)throw new Error('financial_detail_report_mismatch');
    if(String(row.dateFrom??'').slice(0,10)!==periodStart||String(row.dateTo??'').slice(0,10)!==periodEnd){
      throw new Error('financial_detail_period_mismatch');
    }
  }
}

export async function loadWbFinancialReportDetail(token,{
  reportId,
  periodStart,
  periodEnd,
  fetchImpl=fetch,
  limit=100000,
  maxPages=100,
  beforeRequest=async()=>{},
  onPage=async()=>{}
}={}){
  reportId=canonicalPositiveInt64(reportId,'financial_detail_invalid_request');
  periodStart=exactDate(periodStart);
  periodEnd=exactDate(periodEnd);
  if(periodEnd<periodStart||!Number.isInteger(limit)||limit<1||limit>100000||
      !Number.isInteger(maxPages)||maxPages<1||maxPages>1000||typeof fetchImpl!=='function'){
    throw new Error('financial_detail_invalid_request');
  }
  const endpoint=`${financialDetailEndpoint}/${reportId}`;
  const rows=[],pages=[];
  let rrdId='0';
  for(let page=0;page<maxPages;page++){
    await beforeRequest({page,reportId,rrdId,rowCount:rows.length});
    let response;
    try{
      response=await fetchImpl(endpoint,{
        method:'POST',
        headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
        body:requestBody(limit,rrdId),
        signal:AbortSignal.timeout(30000)
      });
    }catch{throw apiError('financial_detail_unavailable',null,endpoint);}
    if(response.status===204){
      const reports=normalizeFinancialReports(rows);
      if(reports.length>1)throw new Error('financial_detail_report_mismatch');
      return {reportId,periodStart,periodEnd,rows,reports,pages,pageCount:pages.length,finalRrdId:rrdId};
    }
    if(response.status===400||response.status===403){
      const raw=await response.text().catch(()=> '');
      if(unsupportedCountryResponse(raw))throw apiError('financial_detail_unsupported_country',response,endpoint);
      throw apiError(response.status===403?'financial_detail_unauthorized':'financial_detail_invalid_request',response,endpoint);
    }
    if(response.status===401)throw apiError('financial_detail_unauthorized',response,endpoint);
    if(response.status===402)throw apiError('financial_detail_payment_required',response,endpoint);
    if(response.status===429)throw apiError('financial_detail_rate_limited',response,endpoint);
    if(response.status>=500)throw apiError('financial_detail_unavailable',response,endpoint);
    if(!response.ok)throw apiError('financial_detail_invalid_request',response,endpoint);
    const raw=await response.text();
    let batch;
    try{batch=parseFinancialJson(raw);}catch{throw apiError('financial_detail_invalid_response',response,endpoint);}
    validateBatch(batch,{reportId,periodStart,periodEnd});
    let last;
    try{last=canonicalPositiveInt64(String(batch.at(-1)?.rrdId??''),'financial_detail_invalid_cursor');}
    catch{throw new Error('financial_detail_invalid_cursor');}
    if(BigInt(last)<=BigInt(rrdId))throw new Error('financial_detail_invalid_cursor');
    rows.push(...batch);
    pages.push({
      partNumber:page,
      raw,
      checksum:createHash('sha256').update(raw).digest('hex'),
      rowCount:batch.length,
      firstRrdId:canonicalPositiveInt64(String(batch[0].rrdId??''),'financial_detail_invalid_cursor'),
      lastRrdId:last
    });
    rrdId=last;
    await onPage({pageCount:pages.length,reportId,rowCount:rows.length,rrdId});
  }
  throw new Error('financial_detail_too_large');
}
