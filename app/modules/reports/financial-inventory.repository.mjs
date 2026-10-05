import { createHash } from 'node:crypto';

export function createFinancialInventoryRepository({ pool }) {
  if (!pool?.query || !pool?.connect) throw new TypeError('financial inventory repository requires pool');

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
    const client = await pool.connect();
    try {
      await client.query('begin');
      const encoded = JSON.stringify(rows);
      const result = (await client.query('select * from mc.apply_financial_inventory($1,$2,$3,$4,$5::jsonb)', [jobId, credentialGeneration, leaseToken, workerId, encoded])).rows[0];
      if(result?.superseded!==true){
        await client.query(
          `update mc.financial_week_inventory wi set summary_raw_data=item.value->'summaryRaw'
             from jsonb_array_elements($2::jsonb) item,mc.jobs j,mc.financial_week_coverage wc
            where j.id=$1 and wi.business_id=j.business_id and wi.store_id=j.store_id
              and wc.id=wi.coverage_id and wc.credential_generation=$3
              and wc.week_start<=(j.payload->'window'->>'dateTo')::date
              and wc.week_end>=(j.payload->'window'->>'dateFrom')::date
              and wi.external_report_id=item.value->>'reportId'
              and wi.inventory_checksum=item.value->>'checksum'`,
          [jobId, encoded, credentialGeneration]
        );
      }
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally { client.release(); }
  }

  async function applyPeriodFallback(jobId, credentialGeneration, leaseToken, workerId) {
    return (await pool.query('select * from mc.apply_financial_period_fallback($1,$2,$3,$4)', [jobId, credentialGeneration, leaseToken, workerId])).rows[0];
  }

  return { getContext, reserveRequestSlot, apply, applyPeriodFallback };
}
