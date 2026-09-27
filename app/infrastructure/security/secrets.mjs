import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

const WB_TOKEN_FINGERPRINT_DOMAIN = 'marketplace-control:wb-token-fingerprint:v1\0';

function loadBase64Key(value, errorCode) {
  const encoded = String(value ?? '').trim();
  if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded)) throw new Error(errorCode);
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32 || key.toString('base64') !== encoded) throw new Error(errorCode);
  return key;
}

export function loadEncryptionKey(env = process.env) {
  return loadBase64Key(env.WB_TOKEN_ENCRYPTION_KEY, 'wb_encryption_not_configured');
}

export function loadFingerprintKey(env = process.env) {
  return loadBase64Key(env.WB_TOKEN_FINGERPRINT_KEY, 'wb_fingerprint_not_configured');
}

export function fingerprintSecret(value, key = loadFingerprintKey()) {
  return createHmac('sha256', key)
    .update(WB_TOKEN_FINGERPRINT_DOMAIN, 'utf8')
    .update(String(value), 'utf8')
    .digest('hex');
}

export function encryptSecret(value, key = loadEncryptionKey()) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return { ciphertext, nonce, authTag: cipher.getAuthTag(), keyVersion: 'v1' };
}

export function decryptSecret(secret, key = loadEncryptionKey()) {
  const decipher = createDecipheriv('aes-256-gcm', key, secret.nonce);
  decipher.setAuthTag(secret.authTag);
  return Buffer.concat([decipher.update(secret.ciphertext), decipher.final()]).toString('utf8');
}
