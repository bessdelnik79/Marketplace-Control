import { pool, withUserContext } from '../../infrastructure/database/client.mjs';

export async function requestAccountErasure(userId, { sessionTokenHash, expectedPasswordHash = null }) {
  try { return await withUserContext(userId, async client => {
    const result = await client.query('select mc.erase_account($1,$2,$3) as business_ids',
      [userId, sessionTokenHash, expectedPasswordHash]);
    return { businessIds: result.rows[0].business_ids };
  }); } catch (error) {
    if (error.code==='23503') throw new Error('account_erasure_shared_business');
    throw error;
  }
}

// Hold the queue row lock through filesystem cleanup. A crash rolls the claim back.
export async function processAccountErasureCleanup(cleanup, { database = pool, logger = console } = {}) {
  const client = await database.connect();
  try {
    await client.query('begin');
    const row = (await client.query(`select erased_business_id from mc.account_erasure_cleanup
      where available_at<=now() order by available_at for update skip locked limit 1`)).rows[0];
    if (!row) { await client.query('commit'); return false; }
    try {
      await cleanup(row.erased_business_id);
      await client.query('delete from mc.account_erasure_cleanup where erased_business_id=$1', [row.erased_business_id]);
    } catch {
      const retry = await client.query(`update mc.account_erasure_cleanup set attempts=attempts+1,
        available_at=now()+interval '1 minute' where erased_business_id=$1 returning attempts`, [row.erased_business_id]);
      logger.error('account_erasure_filesystem_cleanup_retry', { attempts: retry.rows[0]?.attempts });
    }
    await client.query('commit');
    return true;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally { client.release(); }
}
