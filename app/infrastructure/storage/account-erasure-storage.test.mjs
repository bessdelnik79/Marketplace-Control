import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, access, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cleanupAccountSourceData, withAccountSourceWrite } from './account-erasure-storage.mjs';

test('cleanup removes only the UUID tenant from both roots and is repeatable', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'account-erasure-'));
  const id = randomUUID(), other = randomUUID();
  const roots = { sourceRoot: path.join(root, 'financial'), operationalRoot: path.join(root, 'operational') };
  try {
    for (const base of Object.values(roots)) {
      await mkdir(path.join(base, id, 'nested'), { recursive: true });
      await writeFile(path.join(base, id, 'nested', 'raw'), 'private');
      await mkdir(path.join(base, other));
    }
    await cleanupAccountSourceData(id, roots);
    await cleanupAccountSourceData(id, roots);
    for (const base of Object.values(roots)) {
      await assert.rejects(access(path.join(base, id)), { code: 'ENOENT' });
      await access(path.join(base, other));
    }
    await assert.rejects(cleanupAccountSourceData('../foreign', roots), /invalid_business_id/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('cleanup refuses a symlinked tenant and preserves the external directory', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'account-erasure-link-'));
  const id = randomUUID();
  try {
    await mkdir(path.join(root, 'outside'));
    await mkdir(path.join(root, 'source'));
    await symlink(path.join(root, 'outside'), path.join(root, 'source', id), 'junction');
    await assert.rejects(cleanupAccountSourceData(id, { sourceRoot: path.join(root, 'source'), operationalRoot: path.join(root, 'missing') }), /unsafe_directory/);
    await access(path.join(root, 'outside'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('source guard releases its advisory lock on failure and refuses erased business writes', async () => {
  for (const allowed of [true, false]) {
    const queries = []; let released = 0, writes = 0;
    const database = { connect: async () => ({
      query: async sql => { queries.push(sql); return { rows: [{ allowed }] }; },
      release: () => { released++; }
    }) };
    await assert.rejects(withAccountSourceWrite(randomUUID(), async () => { writes++; throw new Error('write_failed'); }, { database }),
      allowed ? /write_failed/ : /business_unavailable/);
    assert.equal(writes, allowed ? 1 : 0);
    assert.equal(released, 1);
    assert.match(queries.at(-1), /pg_advisory_unlock/);
  }
});
