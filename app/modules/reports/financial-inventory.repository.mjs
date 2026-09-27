import { createHash } from 'node:crypto';

export function createFinancialInventoryRepository({ pool }) {
  if (!pool?.query) throw new TypeError('financial inventory repository requires pool');

  async function getContext(jobId, credentialGeneration, leaseToken, workerId) {
    return (await pool.query('select * from mc.get_financial_inventory_context($1,$2,$3,$4)', [jobId, credentialGeneration, leaseToken, workerId])).rows[0] ?? null;
  }

  async function reserveRequestSlot(sellerId, delaySeconds) {
    if (!String(sellerId ?? '').trim()) throw new Error('financial_context_mismatch');
    if (!Number.isInteger(delaySeconds) || delaySeconds < 65 || delaySeconds > 75) throw new Error('financial_invalid_rate_delay');
    const rateKey = createHash('sha256').update(`wb:finance:sales-reports:${sellerId}`).digest('hex');
    const row = (await pool.query(
      `insert into mc.wb_api_request_slots(rate_key,next_allowed_at)
       values($1,clock_timestamp()+make_interval(secs=>$2))
       on conflict(rate_key) do update
         set next_allowed_at=greatest(mc.wb_api_request_slots.next_allowed_at,clock_timestamp())+make_interval(secs=>$2),updated_at=clock_timestamp()
       returning next_allowed_at-make_interval(secs=>$2) as scheduled_at,next_allowed_at`,
      [rateKey, delaySeconds]
    )).rows[0];
    return { scheduledAt: row.scheduled_at, nextAllowedAt: row.next_allowed_at, waitMs: Math.max(0, new Date(row.scheduled_at).getTime() - Date.now()) };
  }

  async function apply(jobId, credentialGeneration, leaseToken, workerId, rows) {
    return (await pool.query('select * from mc.apply_financial_inventory($1,$2,$3,$4,$5::jsonb)', [jobId, credentialGeneration, leaseToken, workerId, JSON.stringify(rows)])).rows[0];
  }

  async function applyPeriodFallback(jobId, credentialGeneration, leaseToken, workerId) {
    return (await pool.query('select * from mc.apply_financial_period_fallback($1,$2,$3,$4)', [jobId, credentialGeneration, leaseToken, workerId])).rows[0];
  }

  return { getContext, reserveRequestSlot, apply, applyPeriodFallback };
}
