import { randomUUID } from 'node:crypto';
import { decryptSecret } from './secrets.mjs';
import { beginFinancialSync, completeFinancialSync, failFinancialSync, updateFinancialSyncProgress } from './db.mjs';
import { financialDateRange, loadWbFinancialReports } from './finance.mjs';
import { removeFinancialDocument, storeFinancialPages } from './source-storage.mjs';

const activeJobs = new Set();
const knownErrors = new Set([
  'financial_connection_unavailable','financial_invalid_request','financial_unauthorized','financial_payment_required',
  'financial_rate_limited','financial_unavailable','financial_invalid_response','financial_invalid_row','financial_invalid_amount',
  'financial_invalid_cursor','financial_too_large','financial_report_period_mismatch','financial_duplicate_row_conflict'
]);
const safeCode = error => knownErrors.has(error?.message) ? error.message : 'financial_internal_error';

export function scheduleFinancialSync(userId, storeId, {
  force = false,
  fetchImpl = fetch,
  waitImpl,
  minIntervalMs,
  now = new Date(),
  sourceRoot,
  masterKey
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
      const financial = await loadWbFinancialReports(token, {
        dateFrom: job.date_from,
        dateTo: job.date_to,
        fetchImpl,
        ...(waitImpl ? { waitImpl } : {}),
        ...(minIntervalMs == null ? {} : { minIntervalMs }),
        onPage: progress => updateFinancialSyncProgress(userId, job, { stage: 'loading', pages: progress.pageCount, rows: progress.rowCount, rrdId: progress.rrdId })
      });
      await updateFinancialSyncProgress(userId, job, { stage: 'saving', pages: financial.pageCount, rows: financial.rows.length, reports: financial.reports.length });
      documentId = randomUUID();
      stored = await storeFinancialPages({ businessId: job.business_id, storeId: job.store_id, documentId, pages: financial.pages, root: sourceRoot, ...(masterKey ? { masterKey } : {}) });
      const saved = await completeFinancialSync(userId, job, { documentId, reports: financial.reports, objects: stored.objects });
      console.info('[WB financial reports synced]', JSON.stringify({ time: new Date().toISOString(), userId, storeId, reports: financial.reports.length, rows: financial.rows.length, insertedReports: saved.insertedReports, unchangedReports: saved.unchangedReports, issues: saved.issues }));
    } catch (error) {
      const code = safeCode(error);
      if (job?.run_id) await failFinancialSync(userId, job, code).catch(() => {});
      if (stored && documentId) await removeFinancialDocument({ businessId: job.business_id, storeId: job.store_id, documentId, root: sourceRoot }).catch(() => {});
      console.warn('[WB financial reports failed]', JSON.stringify({ time: new Date().toISOString(), error: code, wbStatus: error?.status, endpoint: error?.endpoint, userId, storeId }));
    } finally {
      activeJobs.delete(key);
    }
  })();
  return true;
}
