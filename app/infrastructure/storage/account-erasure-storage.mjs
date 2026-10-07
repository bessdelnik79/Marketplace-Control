import path from 'node:path';
import { lstat, rm } from 'node:fs/promises';
import { pool } from '../database/client.mjs';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function businessUuid(value) {
  if (typeof value !== 'string' || !uuidPattern.test(value)) throw new Error('account_erasure_invalid_business_id');
  return value.toLowerCase();
}

export async function withAccountSourceWrite(businessId, action, { database = pool } = {}) {
  const id = businessUuid(businessId);
  const client = await database.connect();
  let locked = false;
  try {
    await client.query("select pg_advisory_lock(hashtextextended('account-erasure:'||$1,0))", [id]);
    locked = true;
    const result = await client.query('select mc.account_source_write_allowed($1) as allowed', [id]);
    if (!result.rows[0]?.allowed) throw new Error('account_erasure_business_unavailable');
    return await action();
  } finally {
    if (locked) {
      try { await client.query("select pg_advisory_unlock(hashtextextended('account-erasure:'||$1,0))", [id]); }
      catch (error) { client.release(error); locked = false; throw error; }
    }
    client.release();
  }
}

async function removeBusinessDirectory(root, businessId) {
  const base = path.resolve(root);
  const target = path.resolve(base, businessId);
  if (path.dirname(target) !== base) throw new Error('account_erasure_invalid_path');
  try {
    const rootInfo = await lstat(base);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error('account_erasure_unsafe_root');
    // Inspect each ancestor (realpath string comparisons reject Windows short paths).
    for (let ancestor = path.dirname(base); ancestor !== path.dirname(ancestor); ancestor = path.dirname(ancestor)) {
      if ((await lstat(ancestor)).isSymbolicLink()) throw new Error('account_erasure_unsafe_root');
    }
    const info = await lstat(target);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('account_erasure_unsafe_directory');
    await rm(target, { recursive: true, force: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

export async function cleanupAccountSourceData(businessId, {
  sourceRoot = process.env.SOURCE_DATA_DIR ?? path.join('work', 'source-data'),
  operationalRoot = process.env.OPERATIONAL_SOURCE_DATA_DIR ?? path.join('work', 'operational-source-data')
} = {}) {
  const id = businessUuid(businessId);
  await removeBusinessDirectory(sourceRoot, id);
  await removeBusinessDirectory(operationalRoot, id);
}
