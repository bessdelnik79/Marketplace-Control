import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readFinancialPage, storeFinancialPages } from './source-storage.mjs';

test('financial source pages are encrypted, compressed and recoverable', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mc-source-'));
  const masterKey = Buffer.alloc(32, 7);
  try {
    const stored = await storeFinancialPages({
      businessId: '11111111-1111-4111-8111-111111111111',
      storeId: '22222222-2222-4222-8222-222222222222',
      documentId: '33333333-3333-4333-8333-333333333333',
      root, masterKey,
      pages: [{ partNumber: 0, raw: '[{"reportId":123}]' }]
    });
    assert.equal(stored.objects.length, 1);
    assert.equal(stored.objects[0].contentType, 'application/json+gzip+aes-256-gcm');
    assert.equal(await readFinancialPage(stored.objects[0].storageKey, { root, masterKey }), '[{"reportId":123}]');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('source storage rejects traversal keys', async () => {
  await assert.rejects(() => readFinancialPage('../secret', { root: os.tmpdir(), masterKey: Buffer.alloc(32, 8) }), /source_storage_invalid_key/);
});
