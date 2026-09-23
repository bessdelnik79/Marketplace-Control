import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { gzip, gunzip } from 'node:zlib';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { loadEncryptionKey } from '../security/secrets.mjs';

const zip = promisify(gzip);
const unzip = promisify(gunzip);
const magic = Buffer.from('MCF1');

function safeId(value) {
  const result = String(value ?? '');
  if (!/^[0-9a-f-]{36}$/i.test(result)) throw new Error('source_storage_invalid_id');
  return result;
}

function dataKey(masterKey) {
  return Buffer.from(hkdfSync('sha256', masterKey, Buffer.alloc(0), Buffer.from('marketplace-control/financial-source/v1'), 32));
}

function rootPath(root) {
  return path.resolve(root ?? process.env.SOURCE_DATA_DIR ?? path.join('work', 'source-data'));
}

export async function storeFinancialPages({ businessId, storeId, documentId, pages, root, masterKey = loadEncryptionKey() }) {
  const directory = path.join(rootPath(root), safeId(businessId), safeId(storeId), 'financial-reports', safeId(documentId));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const key = dataKey(masterKey), objects = [];
  try {
    for (const page of pages) {
      if (!Number.isInteger(page.partNumber) || page.partNumber < 0) throw new Error('source_storage_invalid_part');
      const raw = Buffer.from(String(page.raw), 'utf8');
      const checksum = createHash('sha256').update(raw).digest('hex');
      if (page.checksum && page.checksum !== checksum) throw new Error('source_storage_checksum_mismatch');
      const compressed = await zip(raw, { level: 9 });
      const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
      const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()]);
      const payload = Buffer.concat([magic, nonce, cipher.getAuthTag(), ciphertext]);
      const file = `part-${String(page.partNumber).padStart(5, '0')}.json.gz.enc`;
      const temporary = path.join(directory, `${file}.${randomBytes(6).toString('hex')}.tmp`);
      const target = path.join(directory, file);
      await writeFile(temporary, payload, { mode: 0o600, flag: 'wx' });
      await rename(temporary, target);
      const storageKey = path.relative(rootPath(root), target).split(path.sep).join('/');
      objects.push({ storageKey, partNumber: page.partNumber, byteSize: payload.length, checksum, contentType: 'application/json+gzip+aes-256-gcm' });
    }
    return { directory, objects };
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function readFinancialPage(storageKey, { root, masterKey = loadEncryptionKey() } = {}) {
  const base = rootPath(root), target = path.resolve(base, String(storageKey));
  if (!target.startsWith(`${base}${path.sep}`)) throw new Error('source_storage_invalid_key');
  const payload = await readFile(target);
  if (payload.length < 33 || !payload.subarray(0, 4).equals(magic)) throw new Error('source_storage_invalid_payload');
  const nonce = payload.subarray(4, 16), authTag = payload.subarray(16, 32), ciphertext = payload.subarray(32);
  const decipher = createDecipheriv('aes-256-gcm', dataKey(masterKey), nonce);
  decipher.setAuthTag(authTag);
  const compressed = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return (await unzip(compressed)).toString('utf8');
}

export async function removeFinancialDocument({ businessId, storeId, documentId, root }) {
  const directory = path.join(rootPath(root), safeId(businessId), safeId(storeId), 'financial-reports', safeId(documentId));
  await rm(directory, { recursive: true, force: true });
}
