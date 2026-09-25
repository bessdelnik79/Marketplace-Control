import { randomUUID } from 'node:crypto';
import { decryptSecret } from '../../infrastructure/security/secrets.mjs';
import { beginFinancialSync, completeFinancialSync, failFinancialSync, reserveFinancialRequestSlot, updateFinancialSyncProgress } from '../../db.mjs';
import { financialDateRange, financialRequestDelaySeconds, loadWbFinancialReports } from './finance.mjs';
import { removeFinancialDocument, storeFinancialPages } from '../../infrastructure/storage/source-storage.mjs';
import { assertWbFinancialToken, decodeWbToken } from '../stores/wb.mjs';
import { scheduleFinancialCalculation } from '../calculation/calculation-sync.mjs';
import { loadWbFinancialSummaries } from './bank-reconciliation.mjs';

const activeJobs = new Set();
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

export function scheduleFinancialSync(userId, storeId, {
  force = false,
  fetchImpl = fetch,
  waitImpl,
  now = new Date(),
  sourceRoot,
  masterKey,
  random = Math.random
} = {}) {
  const key = `${userId}:${storeId}`;
  if (activeJobs.has(key)) return false;
  activeJobs.add(key);
  void (async () => {
    let job, documentId, stored;
    try {
      const wait = waitImpl ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
      const initialRange=financialDateRange(now,91),recentRange=financialDateRange(now,35);
      for(const historical of [false,true]){
        job=await beginFinancialSync(userId,storeId,{force:force||historical,historical,initialRange,recentRange});
        if(!job?.started)return;
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
        scheduleFinancialCalculation(userId,storeId);
      }
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
    }
  })();
  return true;
}
