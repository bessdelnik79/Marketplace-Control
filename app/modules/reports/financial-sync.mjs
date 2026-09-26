import { randomUUID } from 'node:crypto';
import { decryptSecret } from '../../infrastructure/security/secrets.mjs';
import { beginFinancialSync, completeFinancialSync, failFinancialSync, reserveFinancialRequestSlot, updateFinancialSyncProgress } from '../../db.mjs';
import { financialDateRange, financialRequestDelaySeconds, loadWbFinancialReports } from './finance.mjs';
import { removeFinancialDocument, storeFinancialPages } from '../../infrastructure/storage/source-storage.mjs';
import { assertWbFinancialToken, decodeWbToken } from '../stores/wb.mjs';
import { scheduleFinancialCalculation } from '../calculation/calculation-sync.mjs';
import { loadWbFinancialSummaries } from './bank-reconciliation.mjs';

const activeJobs = new Map();
const knownErrors = new Set([
  'financial_connection_unavailable','financial_invalid_request','financial_unauthorized','financial_payment_required',
  'financial_rate_limited','financial_unavailable','financial_invalid_response','financial_invalid_row','financial_invalid_amount',
  'financial_invalid_cursor','financial_too_large','financial_report_period_mismatch','financial_duplicate_row_conflict',
  'financial_token_type_unsupported','financial_sync_superseded','financial_invalid_random','financial_invalid_rate_delay',
  'financial_context_mismatch','financial_method_missing','financial_report_version_not_accepted','financial_row_period_mismatch',
  'financial_summary_unavailable','financial_summary_unauthorized','financial_summary_rate_limited','financial_invalid_summary',
  'financial_duplicate_summary_conflict','financial_summary_too_large'
]);

const safeDiagnosticIdentifier = (value, maxLength = 120) => {
  const result = String(value ?? '').trim();
  return result && result.length <= maxLength && /^[a-zA-Z0-9_.:-]+$/.test(result) ? result : undefined;
};

const safeEndpoint = value => {
  try {
    const url = new URL(String(value));
    return ['https:', 'http:'].includes(url.protocol) ? `${url.origin}${url.pathname}`.slice(0, 240) : undefined;
  } catch { return undefined; }
};

export const financialSyncErrorCode = error => knownErrors.has(error?.message) ? error.message : 'financial_internal_error';

export function financialSyncFailureDiagnostic(error, errorCode = financialSyncErrorCode(error)) {
  const diagnostic = {
    errorCode,
    errorName: safeDiagnosticIdentifier(error?.name),
    databaseCode: safeDiagnosticIdentifier(error?.code),
    constraint: safeDiagnosticIdentifier(error?.constraint),
    wbStatus: Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599 ? error.status : undefined,
    endpoint: safeEndpoint(error?.endpoint)
  };
  return Object.fromEntries(Object.entries(diagnostic).filter(([, value]) => value !== undefined));
}

const exactDate=value=>/^\d{4}-\d{2}-\d{2}$/.test(String(value??''))?String(value):null;

export function normalizeTargetFinancialRanges(targetRanges){
  if(!Array.isArray(targetRanges))return [];
  const seen=new Set(),result=[];
  for(const range of targetRanges){
    const periodStart=exactDate(range?.periodStart??range?.dateFrom);
    const periodEnd=exactDate(range?.periodEnd??range?.dateTo);
    if(!periodStart||!periodEnd||periodStart>periodEnd)throw new Error('financial_invalid_request');
    const key=`${periodStart}:${periodEnd}`;
    if(!seen.has(key)){seen.add(key);result.push({periodStart,periodEnd});}
  }
  return result;
}

export function buildFinancialSyncRequests(targetPeriod,targetRanges){
  const targeted=targetPeriod!==null||targetRanges!==null;
  return targeted
    ?normalizeTargetFinancialRanges(targetRanges).map(requestedRange=>({historical:true,requestedRange}))
    :[{historical:false},{historical:true}];
}

const financialSyncRequestKey=request=>request.targetPeriod
  ?`target:${String(request.targetPeriod.periodStart??request.targetPeriod.dateFrom??'')}:${String(request.targetPeriod.periodEnd??request.targetPeriod.dateTo??'')}`
  :'general';

export function mergeQueuedFinancialSyncRequests(queue,request){
  const result=[...queue],key=financialSyncRequestKey(request);
  const index=result.findIndex(item=>financialSyncRequestKey(item)===key);
  if(index<0)return [...result,{...request,targetRanges:request.targetRanges==null?null:normalizeTargetFinancialRanges(request.targetRanges)}];
  const current=result[index];
  result[index]={...current,...request,force:Boolean(current.force||request.force)};
  if(key!=='general')result[index].targetRanges=normalizeTargetFinancialRanges([...(current.targetRanges??[]),...(request.targetRanges??[])]);
  return result;
}

export function scheduleFinancialSync(userId, storeId, options = {}) {
  const key = `${userId}:${storeId}`;
  const active = activeJobs.get(key);
  if(active){
    active.queue=mergeQueuedFinancialSyncRequests(active.queue,options);
    return false;
  }
  startFinancialSync(userId,storeId,options,[]);
  return true;
}

function startFinancialSync(userId, storeId, {
  force = false,
  fetchImpl = fetch,
  waitImpl,
  now = new Date(),
  sourceRoot,
  masterKey,
  random = Math.random,
  targetPeriod = null,
  targetRanges = null
} = {}, queued = []) {
  const key = `${userId}:${storeId}`;
  const state={queue:queued};
  activeJobs.set(key,state);
  void (async () => {
    let job, documentId, stored;
    try {
      const wait = waitImpl ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
      const initialRange=financialDateRange(now,91),recentRange=financialDateRange(now,35);
      const targeted=targetPeriod!==null||targetRanges!==null;
      const requests=buildFinancialSyncRequests(targetPeriod,targetRanges);
      for(const request of requests){
        const historical=request.historical;
        job=await beginFinancialSync(userId,storeId,{force:force||historical,historical,initialRange,recentRange,requestedRange:request.requestedRange,targetPeriod});
        if(!job?.started){
          if(targeted&&job?.reason==='target_range_not_needed')continue;
          return;
        }
        const token=decryptSecret({ciphertext:job.ciphertext,nonce:job.nonce,authTag:job.auth_tag});
        assertWbFinancialToken(decodeWbToken(token));
        const financial=await loadWbFinancialReports(token,{
          dateFrom:job.date_from,
          dateTo:job.date_to,
          fetchImpl,
          beforeRequest:async()=>{
            const delaySeconds=financialRequestDelaySeconds(random);
            const slot=await reserveFinancialRequestSlot(userId,job,delaySeconds);
            if(slot.waitMs>0)await wait(slot.waitMs);
          },
          onPage:progress=>updateFinancialSyncProgress(userId,job,{stage:'loading',pages:progress.pageCount,rows:progress.rowCount,rrdId:progress.rrdId})
        });
        if(historical&&financial.reports.some(report=>report.periodStart<job.date_from||report.periodEnd>job.date_to))throw new Error('financial_report_period_mismatch');
        let summaries = new Map(), summaryError = null;
        if(financial.reports.length){
          try {
            summaries = await loadWbFinancialSummaries(token, {
              dateFrom: job.date_from, dateTo: job.date_to, fetchImpl,
              beforeRequest: async () => {
                const slot = await reserveFinancialRequestSlot(userId, job, financialRequestDelaySeconds(random));
                if(slot.waitMs > 0)await wait(slot.waitMs);
              }
            });
          } catch(error) {
            summaryError = String(error?.message ?? '').startsWith('financial_') ? error.message : 'financial_summary_unavailable';
            console.warn('[WB financial summary unavailable]', JSON.stringify({ time: new Date().toISOString(), userId, storeId, error: summaryError }));
          }
        }
        await updateFinancialSyncProgress(userId,job,{stage:'saving',pages:financial.pageCount,rows:financial.rows.length,reports:financial.reports.length});
        documentId=randomUUID();
        stored=await storeFinancialPages({businessId:job.business_id,storeId:job.store_id,documentId,pages:financial.pages,root:sourceRoot,...(masterKey?{masterKey}:{})});
        const saved=await completeFinancialSync(userId,job,{documentId,reports:financial.reports,summaries,summaryError,objects:stored.objects});
        console.info('[WB financial reports synced]',JSON.stringify({time:new Date().toISOString(),userId,storeId,historical,reports:financial.reports.length,rows:financial.rows.length,insertedReports:saved.insertedReports,reselectedReports:saved.reselectedReports,unchangedReports:saved.unchangedReports,issues:saved.issues,bankChecks:saved.bankChecks}));
        stored=undefined;
        documentId=undefined;
        job=undefined;
        if(!targeted)scheduleFinancialCalculation(userId,storeId);
      }
      if(targeted)scheduleFinancialCalculation(userId,storeId,{targetPeriod});
    } catch (error) {
      const code = financialSyncErrorCode(error);
      const retryDelaySeconds=code==='financial_rate_limited'?financialRequestDelaySeconds(random):70;
      if (job?.run_id) await failFinancialSync(userId, job, code, { retryDelaySeconds }).catch(() => {});
      if (stored && documentId) await removeFinancialDocument({ businessId: job.business_id, storeId: job.store_id, documentId, root: sourceRoot }).catch(() => {});
      console.warn('[WB financial reports failed]', JSON.stringify({
        time: new Date().toISOString(), userId, storeId, error: code, ...financialSyncFailureDiagnostic(error, code)
      }));
    } finally {
      activeJobs.delete(key);
      const [next,...remaining]=state.queue;
      if(next)startFinancialSync(userId,storeId,next,remaining);
    }
  })();
}
