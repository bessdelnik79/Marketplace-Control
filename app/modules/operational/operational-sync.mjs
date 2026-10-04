import { randomUUID } from 'node:crypto';
import { decryptSecret } from '../../infrastructure/security/secrets.mjs';
import {
  storeOperationalSnapshot,
  removeOperationalSnapshot
} from '../../infrastructure/storage/operational-source-storage.mjs';
import {
  beginOperationalSync,
  reserveOperationalRequestSlot,
  updateOperationalSyncProgress,
  completeOperationalSync,
  failOperationalSync
} from './operational.repository.mjs';
import { loadWbFunnelProductsHistory } from './wb-funnel-products.mjs';
import { decodeWbToken } from '../stores/wb.mjs';

const DAY_MS = 86400000;
const batchSize = 1000;
const activeJobs = new Set();
const knownErrors = new Set([
  'operational_connection_unavailable',
  'operational_invalid_clock',
  'operational_invalid_period',
  'operational_invalid_nm_id',
  'operational_invalid_nm_ids',
  'operational_duplicate_nm_id',
  'operational_invalid_request',
  'operational_unauthorized',
  'operational_payment_required',
  'operational_rate_limited',
  'operational_unavailable',
  'operational_invalid_response',
  'operational_invalid_date',
  'operational_invalid_currency',
  'operational_currency_mismatch',
  'operational_unexpected_nm_id',
  'operational_unexpected_date',
  'operational_duplicate_row',
  'operational_invalid_selection',
  'operational_invalid_rate_slot',
  'operational_invalid_rate_delay',
  'operational_context_mismatch',
  'operational_invalid_result',
  'operational_invalid_metric',
  'operational_duplicate_metric',
  'operational_invalid_object',
  'operational_sync_superseded',
  'operational_selection_changed',
  'operational_snapshot_not_accepted',
  'operational_storage_invalid_id',
  'operational_storage_invalid_key',
  'operational_storage_invalid_raw',
  'operational_storage_raw_too_large',
  'operational_storage_invalid_part',
  'operational_storage_checksum_mismatch',
  'operational_storage_unavailable',
  'operational_storage_already_exists',
  'operational_storage_invalid_payload',
  'operational_storage_decryption_failed',
  'operational_storage_invalid_object',
  'operational_storage_size_mismatch',
  'operational_cleanup_failed'
]);

const defaultOperations = {
  begin: beginOperationalSync,
  reserve: reserveOperationalRequestSlot,
  progress: updateOperationalSyncProgress,
  complete: completeOperationalSync,
  fail: failOperationalSync,
  decrypt: decryptSecret,
  load: loadWbFunnelProductsHistory,
  store: storeOperationalSnapshot,
  remove: removeOperationalSnapshot,
  randomUUID
};

function failure(code) {
  return new Error(code);
}

function dateFromDay(value) {
  const date = new Date(value * DAY_MS);
  return `${String(date.getUTCFullYear()).padStart(4, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function moscowCalendarDate(now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw failure('operational_invalid_clock');
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function dayNumber(value) {
  const [year, month, day] = value.split('-').map(Number);
  return Math.trunc(Date.UTC(year, month - 1, day) / DAY_MS);
}

export function operationalRollingMoscowRange(now = new Date(), days = 7) {
  if (!Number.isInteger(days) || days < 1 || days > 7) throw failure('operational_invalid_period');
  const dateTo = moscowCalendarDate(now);
  return { dateFrom: dateFromDay(dayNumber(dateTo) - days + 1), dateTo };
}

export function operationalSyncErrorCode(error) {
  return knownErrors.has(error?.message) ? error.message : 'operational_internal_error';
}

function selectedProducts(job) {
  if (!Array.isArray(job?.products) || !job.products.length) throw failure('operational_invalid_selection');
  const seen = new Set();
  return job.products.map(product => {
    if (!product || !Number.isSafeInteger(product.nmId) || product.nmId <= 0 || !String(product.productId ?? '').trim()) {
      throw failure('operational_invalid_selection');
    }
    if (seen.has(product.nmId)) throw failure('operational_invalid_selection');
    seen.add(product.nmId);
    return product;
  });
}

function operationalToken(value, job, now) {
  let decoded;
  try { decoded = decodeWbToken(value); } catch { throw failure('operational_unauthorized'); }
  if (decoded.expiresAt.getTime() <= now.getTime() || decoded.isTest || ![1, 3].includes(decoded.accountType) ||
      !decoded.readOnly || !decoded.scopes.includes('analytics') || decoded.sellerId !== String(job.seller_id ?? '')) {
    throw failure('operational_unauthorized');
  }
  return decoded.token;
}

function batches(values) {
  const result = [];
  for (let index = 0; index < values.length; index += batchSize) result.push(values.slice(index, index + batchSize));
  return result;
}

function storageOptions(sourceRoot, masterKey) {
  return { ...(sourceRoot === undefined ? {} : { root: sourceRoot }), ...(masterKey === undefined ? {} : { masterKey }) };
}

function safeLogger(logger) {
  return logger && typeof logger.info === 'function' && typeof logger.warn === 'function' ? logger : { info() {}, warn() {} };
}

export async function runOperationalSync(userId, storeId, {
  force = false,
  businessId,
  fetchImpl = fetch,
  waitImpl = ms => new Promise(resolve => setTimeout(resolve, ms)),
  clock = () => new Date(),
  sourceRoot,
  masterKey,
  rateDelaySeconds = 20,
  logger = console,
  dependencies = {}
} = {}) {
  const operations = { ...defaultOperations, ...dependencies };
  const log = safeLogger(logger);
  let job, snapshotId, range, published = false;
  try {
    range = operationalRollingMoscowRange(clock());
    job = await operations.begin(userId, storeId, { force, ...(businessId ? { businessId } : {}), ...range });
    if (!job?.started) return { status: 'not_started', reason: job?.reason ?? 'unknown', range };
    range={dateFrom:job.date_from,dateTo:job.date_to};
    const products = selectedProducts(job);
    const token = operationalToken(
      operations.decrypt({ ciphertext: job.ciphertext, nonce: job.nonce, authTag: job.auth_tag }),
      job,
      clock()
    );
    const documentId = operations.randomUUID();
    snapshotId = operations.randomUUID();
    const productBatches = batches(products), objects = [], metrics = [];
    let missingCount = 0;

    for (const [partNumber, productBatch] of productBatches.entries()) {
      const response = await operations.load(token, {
        nmIds: productBatch.map(product => product.nmId),
        dateFrom: job.date_from,
        dateTo: job.date_to,
        fetchImpl,
        beforeRequest: async () => {
          const slot = await operations.reserve(userId, job, rateDelaySeconds);
          if (!slot || !Number.isFinite(slot.waitMs) || slot.waitMs < 0) throw failure('operational_invalid_rate_slot');
          if (slot.waitMs > 0) await waitImpl(slot.waitMs);
        }
      });
      const stored = await operations.store({
        businessId: job.business_id,
        storeId: job.store_id,
        snapshotId,
        partNumber,
        raw: response.raw,
        checksum: response.rawChecksum,
        ...storageOptions(sourceRoot, masterKey)
      });
      objects.push(stored);
      metrics.push(...response.rows);
      missingCount += response.missing.length;
      await operations.progress(userId, job, {
        stage: 'loading',
        batches: partNumber + 1,
        batchCount: productBatches.length,
        products: Math.min((partNumber + 1) * batchSize, products.length),
        rows: metrics.length,
        missing: missingCount
      });
    }

    await operations.progress(userId, job, {
      stage: 'saving', batches: objects.length, batchCount: productBatches.length,
      products: products.length, rows: metrics.length, missing: missingCount
    });
    const completed = await operations.complete(userId, job, {
      documentId,
      snapshotId,
      objects,
      metrics,
      fetchedAt: clock(),
      storage: storageOptions(sourceRoot, masterKey)
    });
    published = true;
    try { log.info('[WB operational sync complete]', { userId, storeId, batches: objects.length, rows: metrics.length, quality: completed.quality }); } catch {}
    return { status: 'completed', range, ...completed };
  } catch (error) {
    let code = operationalSyncErrorCode(error);
    if (job?.started && snapshotId && !published) {
      try {
        await operations.remove({ businessId: job.business_id, storeId: job.store_id, snapshotId, ...storageOptions(sourceRoot) });
      } catch {
        code = 'operational_cleanup_failed';
      }
    }
    if (job?.run_id) {
      const retryDelaySeconds = code === 'operational_rate_limited' ? rateDelaySeconds : 60;
      await operations.fail(userId, job, code, { retryDelaySeconds }).catch(() => {});
    }
    try { log.warn('[WB operational sync failed]', { userId, storeId, error: code, status: error?.status, endpoint: error?.endpoint }); } catch {}
    return { status: 'failed', range, errorCode: code };
  }
}

export function scheduleOperationalSync(userId, storeId, options = {}) {
  const key = `${userId}:${storeId}`;
  if (activeJobs.has(key)) return false;
  activeJobs.add(key);
  void runOperationalSync(userId, storeId, options).finally(() => activeJobs.delete(key));
  return true;
}
