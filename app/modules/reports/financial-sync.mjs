import { randomUUID } from 'node:crypto';
import { decryptSecret } from '../../infrastructure/security/secrets.mjs';
import { beginFinancialSync, completeFinancialSync, failFinancialSync, reserveFinancialRequestSlot, updateFinancialSyncProgress } from '../../db.mjs';
import { financialDateRange, financialRequestDelaySeconds, loadWbFinancialReports } from './finance.mjs';
import { removeFinancialDocument, storeFinancialPages } from '../../infrastructure/storage/source-storage.mjs';
import { assertWbFinancialToken, decodeWbToken } from '../stores/wb.mjs';
import { scheduleFinancialCalculation } from '../calculation/calculation-sync.mjs';

const activeJobs = new Set();
const knownErrors = new Set([
  'financial_connection_unavailable','financial_invalid_request','financial_unauthorized','financial_payment_required',
  'financial_rate_limited','financial_unavailable','financial_invalid_response','financial_invalid_row','financial_invalid_amount',
  'financial_invalid_cursor','financial_too_large','financial_report_period_mismatch','financial_duplicate_row_conflict',
  'financial_token_type_unsupported'
]);
const safeCode = error => knownErrors.has(error?.message) ? error.message : 'financial_internal_error';

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
      job = await beginFinancialSync(userId, storeId, {
        force,
        initialRange: financialDateRange(now, 91),
        recentRange: financialDateRange(now, 35)
      });
      if (!job?.started) return;
      const token = decryptSecret({ ciphertext: job.ciphertext, nonce: job.nonce, authTag: job.auth_tag });
      assertWbFinancialToken(decodeWbToken(token));
      const wait = waitImpl ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
      const financial = await loadWbFinancialReports(token, {
        dateFrom: job.date_from,
        dateTo: job.date_to,
        fetchImpl,
        beforeRequest: async () => {
          const delaySeconds=financialRequestDelaySeconds(random);
          const slot=await reserveFinancialRequestSlot(userId,job,delaySeconds);
          if(slot.waitMs>0)await wait(slot.waitMs);
        },
        onPage: progress => updateFinancialSyncProgress(userId, job, { stage: 'loading', pages: progress.pageCount, rows: progress.rowCount, rrdId: progress.rrdId })
      });
      await updateFinancialSyncProgress(userId, job, { stage: 'saving', pages: financial.pageCount, rows: financial.rows.length, reports: financial.reports.length });
      documentId = randomUUID();
      stored = await storeFinancialPages({ businessId: job.business_id, storeId: job.store_id, documentId, pages: financial.pages, root: sourceRoot, ...(masterKey ? { masterKey } : {}) });
      const saved = await completeFinancialSync(userId, job, { documentId, reports: financial.reports, objects: stored.objects });
      console.info('[WB financial reports synced]', JSON.stringify({ time: new Date().toISOString(), userId, storeId, reports: financial.reports.length, rows: financial.rows.length, insertedReports: saved.insertedReports, unchangedReports: saved.unchangedReports, issues: saved.issues }));
      scheduleFinancialCalculation(userId, storeId);
    } catch (error) {
      const code = safeCode(error);
      const retryDelaySeconds=code==='financial_rate_limited'?financialRequestDelaySeconds(random):70;
      if (job?.run_id) await failFinancialSync(userId, job, code, { retryDelaySeconds }).catch(() => {});
      if (stored && documentId) await removeFinancialDocument({ businessId: job.business_id, storeId: job.store_id, documentId, root: sourceRoot }).catch(() => {});
      console.warn('[WB financial reports failed]', JSON.stringify({ time: new Date().toISOString(), error: code, wbStatus: error?.status, endpoint: error?.endpoint, userId, storeId }));
    } finally {
      activeJobs.delete(key);
    }
  })();
  return true;
}
