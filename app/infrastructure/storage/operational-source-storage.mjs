import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { gzip, gunzip } from 'node:zlib';
import { link, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { loadEncryptionKey } from '../security/secrets.mjs';

const zip = promisify(gzip);
const unzip = promisify(gunzip);
const magic = Buffer.from('MCO1');
const associatedData = Buffer.from('marketplace-control/operational-snapshot/v1');
const maximumRawBytes = 50 * 1024 * 1024;

function failure(code) {
  return new Error(code);
}

function safeId(value) {
  const result = String(value ?? '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(result)) {
    throw failure('operational_storage_invalid_id');
  }
  return result;
}

function dataKey(masterKey) {
  return Buffer.from(hkdfSync('sha256', masterKey, Buffer.alloc(0), associatedData, 32));
}

function rootPath(root) {
  return path.resolve(root ?? process.env.OPERATIONAL_SOURCE_DATA_DIR ?? path.join('work', 'operational-source-data'));
}

function snapshotDirectory({ businessId, storeId, snapshotId, root }) {
  return path.join(rootPath(root), safeId(businessId), safeId(storeId), 'operational-snapshots', safeId(snapshotId));
}

function targetFromStorageKey(storageKey, root) {
  if (typeof storageKey !== 'string' || !storageKey.trim()) throw failure('operational_storage_invalid_key');
  const base = rootPath(root);
  const target = path.resolve(base, storageKey);
  const relative = path.relative(base, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw failure('operational_storage_invalid_key');
  return target;
}

function rawBuffer(raw) {
  if (typeof raw !== 'string') throw failure('operational_storage_invalid_raw');
  const buffer = Buffer.from(raw, 'utf8');
  if (buffer.length > maximumRawBytes) throw failure('operational_storage_raw_too_large');
  return buffer;
}

function safePartNumber(value) {
  if (!Number.isInteger(value) || value < 0 || value > 9999) throw failure('operational_storage_invalid_part');
  return value;
}

export async function storeOperationalSnapshot({
  businessId,
  storeId,
  snapshotId,
  raw,
  checksum,
  partNumber = 0,
  root,
  masterKey
}) {
  const source = rawBuffer(raw);
  partNumber = safePartNumber(partNumber);
  const actualChecksum = createHash('sha256').update(source).digest('hex');
  if (checksum !== undefined && checksum !== actualChecksum) throw failure('operational_storage_checksum_mismatch');
  const directory = snapshotDirectory({ businessId, storeId, snapshotId, root });
  masterKey ??= loadEncryptionKey();
  const target = path.join(directory, `part-${String(partNumber).padStart(4, '0')}.json.gz.enc`);
  const temporary = path.join(directory, `.part-${String(partNumber).padStart(4, '0')}.${randomBytes(8).toString('hex')}.tmp`);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const compressed = await zip(source, { level: 9 });
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', dataKey(masterKey), nonce);
    cipher.setAAD(associatedData);
    const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()]);
    const payload = Buffer.concat([magic, nonce, cipher.getAuthTag(), ciphertext]);
    await writeFile(temporary, payload, { mode: 0o600, flag: 'wx' });
    await link(temporary, target);
    await rm(temporary, { force: true });
    const storageKey = path.relative(rootPath(root), target).split(path.sep).join('/');
    return {
      storageKey,
      partNumber,
      byteSize: payload.length,
      checksum: actualChecksum,
      contentType: 'application/json+gzip+aes-256-gcm',
      encryptionDomain: 'operational-snapshot-v1'
    };
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    if (error?.code === 'EEXIST') throw failure('operational_storage_already_exists');
    if (String(error?.message ?? '').startsWith('operational_storage_')) throw error;
    throw failure('operational_storage_unavailable');
  }
}

export async function readOperationalSnapshot(storageKey, { root, masterKey } = {}) {
  const target = targetFromStorageKey(storageKey, root);
  masterKey ??= loadEncryptionKey();
  let payload;
  try {
    payload = await readFile(target);
  } catch {
    throw failure('operational_storage_unavailable');
  }
  if (payload.length < 33 || !payload.subarray(0, 4).equals(magic)) throw failure('operational_storage_invalid_payload');
  try {
    const nonce = payload.subarray(4, 16), authTag = payload.subarray(16, 32), ciphertext = payload.subarray(32);
    const decipher = createDecipheriv('aes-256-gcm', dataKey(masterKey), nonce);
    decipher.setAAD(associatedData);
    decipher.setAuthTag(authTag);
    const compressed = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return (await unzip(compressed)).toString('utf8');
  } catch {
    throw failure('operational_storage_decryption_failed');
  }
}

export async function verifyOperationalSnapshotObject(object, { root, masterKey } = {}) {
  if (!object || object.contentType !== 'application/json+gzip+aes-256-gcm' || !Number.isInteger(object.byteSize) || object.byteSize < 33
    || typeof object.checksum !== 'string' || !/^[0-9a-f]{64}$/.test(object.checksum)) throw failure('operational_storage_invalid_object');
  const target = targetFromStorageKey(object.storageKey, root);
  let info;
  try { info = await stat(target); } catch { throw failure('operational_storage_unavailable'); }
  if (!info.isFile() || info.size !== object.byteSize) throw failure('operational_storage_size_mismatch');
  const raw = await readOperationalSnapshot(object.storageKey, { root, masterKey });
  if (createHash('sha256').update(raw).digest('hex') !== object.checksum) throw failure('operational_storage_checksum_mismatch');
  return true;
}

export async function removeOperationalSnapshot({ businessId, storeId, snapshotId, root }) {
  const directory = snapshotDirectory({ businessId, storeId, snapshotId, root });
  try {
    await rm(directory, { recursive: true, force: true });
  } catch {
    throw failure('operational_storage_unavailable');
  }
}
