import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readFinancialPage, storeFinancialPages } from './source-storage.mjs';
import {
  readOperationalSnapshot,
  removeOperationalSnapshot,
  storeOperationalSnapshot,
  verifyOperationalSnapshotObject
} from './operational-source-storage.mjs';

const ids = {
  businessId: '11111111-1111-4111-8111-111111111111',
  storeId: '22222222-2222-4222-8222-222222222222',
  snapshotId: '33333333-3333-4333-8333-333333333333'
};

test('operational raw snapshot is encrypted, compressed, recoverable and removable', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mc-operational-source-'));
  const masterKey = Buffer.alloc(32, 7);
  const raw = '[{"product":{"nmId":101},"history":[]}]';
  try {
    const stored = await storeOperationalSnapshot({ ...ids, raw, root, masterKey });
    assert.match(stored.storageKey, /operational-snapshots/);
    assert.equal(stored.contentType, 'application/json+gzip+aes-256-gcm');
    assert.equal(stored.encryptionDomain, 'operational-snapshot-v1');
    assert.equal(stored.partNumber, 0);
    const payload = await readFile(path.join(root, ...stored.storageKey.split('/')));
    assert.equal(payload.includes(Buffer.from(raw)), false);
    assert.equal(await readOperationalSnapshot(stored.storageKey, { root, masterKey }), raw);
    assert.equal(await verifyOperationalSnapshotObject(stored, { root, masterKey }), true);
    await assert.rejects(() => verifyOperationalSnapshotObject({ ...stored, byteSize: stored.byteSize + 1 }, { root, masterKey }), {
      message: 'operational_storage_size_mismatch'
    });
    await assert.rejects(() => readOperationalSnapshot(stored.storageKey, { root, masterKey: Buffer.alloc(32, 8) }), {
      message: 'operational_storage_decryption_failed'
    });
    await removeOperationalSnapshot({ ...ids, root });
    await assert.rejects(() => readOperationalSnapshot(stored.storageKey, { root, masterKey }), {
      message: 'operational_storage_unavailable'
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('operational storage keeps multiple batch parts under one snapshot', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mc-operational-parts-'));
  const masterKey = Buffer.alloc(32, 6);
  try {
    const first = await storeOperationalSnapshot({ ...ids, raw: '[1]', partNumber: 0, root, masterKey });
    const second = await storeOperationalSnapshot({ ...ids, raw: '[2]', partNumber: 1, root, masterKey });
    assert.notEqual(first.storageKey, second.storageKey);
    assert.equal(await readOperationalSnapshot(first.storageKey, { root, masterKey }), '[1]');
    assert.equal(await readOperationalSnapshot(second.storageKey, { root, masterKey }), '[2]');
    await assert.rejects(() => storeOperationalSnapshot({ ...ids, raw: '[changed]', partNumber: 0, root, masterKey }), {
      message: 'operational_storage_already_exists'
    });
    assert.equal(await readOperationalSnapshot(first.storageKey, { root, masterKey }), '[1]');
    await assert.rejects(() => storeOperationalSnapshot({ ...ids, raw: '[]', partNumber: -1, root, masterKey }), {
      message: 'operational_storage_invalid_part'
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('operational and financial source domains cannot decrypt each other', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mc-source-domains-'));
  const masterKey = Buffer.alloc(32, 9);
  const raw = '[{"value":"same plaintext"}]';
  try {
    const operational = await storeOperationalSnapshot({ ...ids, raw, root, masterKey });
    const financial = await storeFinancialPages({
      businessId: ids.businessId,
      storeId: ids.storeId,
      documentId: '44444444-4444-4444-8444-444444444444',
      pages: [{ partNumber: 0, raw }],
      root,
      masterKey
    });
    assert.notEqual(operational.storageKey, financial.objects[0].storageKey);
    const operationalPath = path.join(root, ...operational.storageKey.split('/'));
    const operationalPayload = await readFile(operationalPath);
    Buffer.from('MCF1').copy(operationalPayload, 0);
    await writeFile(operationalPath, operationalPayload);
    await assert.rejects(() => readFinancialPage(operational.storageKey, { root, masterKey }));
    const financialPath = path.join(root, ...financial.objects[0].storageKey.split('/'));
    const financialPayload = await readFile(financialPath);
    Buffer.from('MCO1').copy(financialPayload, 0);
    await writeFile(financialPath, financialPayload);
    await assert.rejects(() => readOperationalSnapshot(financial.objects[0].storageKey, { root, masterKey }), {
      message: 'operational_storage_decryption_failed'
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('operational storage rejects traversal, unsafe IDs and checksum mismatches', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mc-operational-guards-'));
  const masterKey = Buffer.alloc(32, 5);
  try {
    await assert.rejects(() => readOperationalSnapshot('../secret', { root, masterKey }), {
      message: 'operational_storage_invalid_key'
    });
    await assert.rejects(() => storeOperationalSnapshot({ ...ids, snapshotId: '../escape', raw: '[]', root, masterKey }), {
      message: 'operational_storage_invalid_id'
    });
    await assert.rejects(() => removeOperationalSnapshot({ ...ids, businessId: 'not-a-uuid', root }), {
      message: 'operational_storage_invalid_id'
    });
    await assert.rejects(() => storeOperationalSnapshot({ ...ids, raw: '[]', checksum: '0'.repeat(64), root, masterKey }), {
      message: 'operational_storage_checksum_mismatch'
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
