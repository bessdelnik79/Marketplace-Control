import { decryptSecret } from '../../infrastructure/security/secrets.mjs';
import { financialRequestDelaySeconds } from './finance.mjs';
import { loadWbFinancialSummaries } from './bank-reconciliation.mjs';
import { assertWbFinancialToken, decodeWbToken } from '../stores/wb.mjs';

const exactDate = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? '')) ? String(value) : null;
const terminalErrors = new Set([
  'financial_invalid_request','financial_invalid_summary','financial_duplicate_summary_conflict','financial_summary_too_large',
  'financial_summary_unauthorized','financial_token_type_unsupported'
]);

export function inventoryErrorCode(error) {
  const code = String(error?.message ?? '');
  return code.startsWith('financial_') && /^[a-z0-9_]+$/.test(code) ? code : 'financial_inventory_internal_error';
}

export function inventoryRows(summaries) {
  return [...summaries.entries()].map(([reportId, summary]) => {
    const row = summary.rawData;
    if (Buffer.byteLength(JSON.stringify(row), 'utf8') > 262144) throw new Error('financial_invalid_summary');
    const dateFrom = exactDate(String(row.dateFrom ?? '').slice(0, 10));
    const dateTo = exactDate(String(row.dateTo ?? '').slice(0, 10));
    if (!dateFrom || !dateTo || dateTo < dateFrom) throw new Error('financial_invalid_summary');
    return {
      reportId,
      checksum: summary.checksum,
      dateFrom,
      dateTo,
      reportType: row.reportType == null ? null : String(row.reportType).slice(0, 100),
      country: row.country == null ? null : String(row.country).slice(0, 200),
      summaryRaw: row
    };
  });
}

export function createFinancialInventoryWorker({
  jobs,
  inventory,
  fetchImpl = fetch,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
  random = Math.random,
  workerId = `financial-inventory:${process.pid}`
}) {
  if (!jobs?.claimJobs || !jobs?.heartbeatJob || !jobs?.completeJob || !jobs?.failJob) throw new TypeError('job lifecycle is required');
  if (!inventory?.getContext || !inventory?.reserveRequestSlot || !inventory?.apply || !inventory?.applyPeriodFallback) throw new TypeError('inventory repository is required');

  async function runOnce() {
    const [job] = await jobs.claimJobs({ workerId, jobTypes: ['financial_inventory_refresh'], leaseSeconds: 300, limit: 1 });
    if (!job) return false;
    const generation = Number(job.payload?.credentialGeneration);
    const dateFrom = exactDate(job.payload?.window?.dateFrom);
    const dateTo = exactDate(job.payload?.window?.dateTo);
    try {
      if (!Number.isSafeInteger(generation) || generation < 1 || !dateFrom || !dateTo || dateTo < dateFrom) throw new Error('financial_invalid_request');
      const context = await inventory.getContext(job.id, generation, job.lease_token, workerId);
      if (!context) {
        await jobs.completeJob({ jobId: job.id, leaseToken: job.lease_token, workerId, outcome: 'superseded' });
        return true;
      }
      if (context.list_api === 'unsupported_country') {
        const fallback = await inventory.applyPeriodFallback(job.id, generation, job.lease_token, workerId);
        await jobs.completeJob({ jobId: job.id, leaseToken: job.lease_token, workerId, outcome: fallback?.superseded ? 'superseded' : 'completed' });
        return true;
      }
      const token = decryptSecret({ ciphertext: context.ciphertext, nonce: context.nonce, authTag: context.auth_tag });
      assertWbFinancialToken(decodeWbToken(token));
      const summaries = await loadWbFinancialSummaries(token, {
        dateFrom, dateTo, fetchImpl,
        beforeRequest: async () => {
          const slot = await inventory.reserveRequestSlot(context.seller_id, financialRequestDelaySeconds(random));
          if (slot.waitMs > 0) await wait(slot.waitMs);
          const alive = await jobs.heartbeatJob({ jobId: job.id, leaseToken: job.lease_token, workerId, leaseSeconds: 300 });
          if (!alive) throw new Error('financial_inventory_lease_lost');
        }
      });
      const result = await inventory.apply(job.id, generation, job.lease_token, workerId, inventoryRows(summaries));
      if (result?.superseded === true) {
        await jobs.completeJob({ jobId: job.id, leaseToken: job.lease_token, workerId, outcome: 'superseded' });
        return true;
      }
      if (Number(result?.uncovered_weeks ?? 0) > 0) throw new Error('financial_inventory_not_confirmed');
      await jobs.completeJob({ jobId: job.id, leaseToken: job.lease_token, workerId, outcome: 'completed' });
    } catch (error) {
      const errorCode = inventoryErrorCode(error);
      if (errorCode === 'financial_summary_unsupported_country') {
        try {
          const fallback = await inventory.applyPeriodFallback(job.id, generation, job.lease_token, workerId);
          await jobs.completeJob({ jobId: job.id, leaseToken: job.lease_token, workerId, outcome: fallback?.superseded ? 'superseded' : 'completed' });
          return true;
        } catch {}
      }
      await jobs.failJob({
        jobId: job.id, leaseToken: job.lease_token, workerId, errorCode,
        retryable: !terminalErrors.has(errorCode), retryDelaySeconds: errorCode === 'financial_summary_rate_limited' ? 300 : 900
      }).catch(() => {});
    }
    return true;
  }

  return { runOnce };
}

export function startFinancialInventoryWorker({ runOnce, intervalMs = 5000, onError = console.error } = {}) {
  if (typeof runOnce !== 'function') throw new TypeError('runOnce is required');
  let active = false;
  const tick = async () => {
    if (active) return;
    active = true;
    try { await runOnce(); }
    catch (error) { onError(error); }
    finally { active = false; }
  };
  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
