import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export function loadEncryptionKey(env = process.env) {
  const encoded = String(env.WB_TOKEN_ENCRYPTION_KEY ?? '').trim();
  const key = Buffer.from(encoded, 'base64');
  if (!encoded || key.length !== 32) throw new Error('wb_encryption_not_configured');
  return key;
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
