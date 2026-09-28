import assert from 'node:assert/strict';
import test from 'node:test';
import { financialDetailEndpoint, loadWbFinancialReportDetail } from './financial-detail.mjs';

const reportId='90071992547409931';
const period={periodStart:'2026-09-07',periodEnd:'2026-09-13'};
const row=(rrdId,overrides={})=>({
  reportId,dateFrom:period.periodStart,dateTo:period.periodEnd,currency:'RUB',rrdId,
  rrDate:'2026-09-08',docTypeName:'Продажа',sellerOperName:'Продажа',...overrides
});
const numericJson=value=>JSON.stringify(value)
  .replaceAll(`"${reportId}"`,reportId)
  .replace(/"rrdId":"(\d+)"/g,'"rrdId":$1');

test('detail-by-reportId keeps int64 IDs exact, paginates to 204 and preserves raw pages',async()=>{
  const rawOne=numericJson([row('90071992547409941')]);
  const rawTwo=numericJson([row('90071992547409999')]);
  const responses=[new Response(rawOne),new Response(rawTwo),new Response(null,{status:204})];
  const calls=[],reservations=[],progress=[];
  const loaded=await loadWbFinancialReportDetail('secret-token',{
    reportId,...period,limit:1,
    fetchImpl:async(url,options)=>{calls.push({url,options});return responses.shift();},
    beforeRequest:value=>reservations.push(value),onPage:value=>progress.push(value)
  });
  assert.equal(calls.every(call=>call.url===`${financialDetailEndpoint}/${reportId}`),true);
  assert.deepEqual(calls.map(call=>call.options.method),['POST','POST','POST']);
  assert.deepEqual(calls.map(call=>call.options.body),[
    '{"limit":1,"rrdId":0}',
    '{"limit":1,"rrdId":90071992547409941}',
    '{"limit":1,"rrdId":90071992547409999}'
  ]);
  assert.deepEqual(reservations.map(value=>value.rrdId),['0','90071992547409941','90071992547409999']);
  assert.deepEqual(progress.map(value=>value.rrdId),['90071992547409941','90071992547409999']);
  assert.equal(loaded.rows[0].reportId,reportId);
  assert.equal(loaded.rows[1].rrdId,'90071992547409999');
  assert.deepEqual(loaded.pages.map(page=>page.raw),[rawOne,rawTwo]);
  assert.deepEqual(loaded.pages.map(page=>page.partNumber),[0,1]);
  assert.equal(loaded.reports.length,1);
  assert.equal(loaded.reports[0].externalReportId,reportId);
  assert.equal(loaded.finalRrdId,'90071992547409999');
});

test('detail transport rejects unsafe report IDs, bounds and periods before fetch',async()=>{
  let calls=0;
  const attempt=options=>loadWbFinancialReportDetail('token',{reportId,...period,fetchImpl:async()=>{calls++;return new Response(null,{status:204});},...options});
  await assert.rejects(()=>attempt({reportId:Number(reportId)}),/financial_detail_invalid_request/);
  await assert.rejects(()=>attempt({reportId:'9223372036854775808'}),/financial_detail_invalid_request/);
  await assert.rejects(()=>attempt({reportId:'12/not-safe'}),/financial_detail_invalid_request/);
  await assert.rejects(()=>attempt({limit:100001}),/financial_detail_invalid_request/);
  await assert.rejects(()=>attempt({periodStart:'2026-09-14',periodEnd:'2026-09-13'}),/financial_detail_invalid_request/);
  assert.equal(calls,0);
});

test('detail transport accepts only the requested report and declared period',async()=>{
  const load=raw=>loadWbFinancialReportDetail('token',{
    reportId,...period,fetchImpl:async()=>new Response(raw)
  });
  await assert.rejects(()=>load(numericJson([row('1',{reportId:'90071992547409932'})])),/financial_detail_report_mismatch/);
  await assert.rejects(()=>load(numericJson([row('1',{dateTo:'2026-09-14'})])),/financial_detail_period_mismatch/);
  await assert.rejects(()=>load('{}'),/financial_detail_invalid_response/);
});

test('detail transport distinguishes an exact country limitation from generic errors',async()=>{
  const failure=(status,body)=>loadWbFinancialReportDetail('token',{
    reportId,...period,fetchImpl:async()=>new Response(body,{status})
  });
  await assert.rejects(()=>failure(400,JSON.stringify({detail:'Method is unavailable for your registration country.'})),error=>{
    assert.equal(error.message,'financial_detail_unsupported_country');
    assert.equal(error.status,400);
    return true;
  });
  await assert.rejects(()=>failure(400,JSON.stringify({detail:'Method is unavailable for your registration country while account is blocked.'})),/financial_detail_invalid_request/);
  await assert.rejects(()=>failure(403,JSON.stringify({detail:'access denied'})),/financial_detail_unauthorized/);
});

test('detail transport exposes safe network, rate and cursor failures',async()=>{
  await assert.rejects(()=>loadWbFinancialReportDetail('token',{
    reportId,...period,fetchImpl:async()=>{throw new Error('socket included unsafe diagnostics');}
  }),error=>error.message==='financial_detail_unavailable'&&!String(error.message).includes('socket'));
  await assert.rejects(()=>loadWbFinancialReportDetail('token',{
    reportId,...period,fetchImpl:async()=>new Response(null,{status:429,headers:{'retry-after':'2'}})
  }),error=>error.message==='financial_detail_rate_limited'&&error.retryAfterMs===2000);
  const raw=numericJson([row('1')]);
  let calls=0;
  await assert.rejects(()=>loadWbFinancialReportDetail('token',{
    reportId,...period,fetchImpl:async()=>{calls++;return new Response(raw);}
  }),/financial_detail_invalid_cursor/);
  assert.equal(calls,2);
});
