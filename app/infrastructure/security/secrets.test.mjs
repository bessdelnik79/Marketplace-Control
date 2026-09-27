import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { decryptSecret, encryptSecret, fingerprintSecret, loadEncryptionKey, loadFingerprintKey } from './secrets.mjs';

test('WB token encryption round-trips without storing plaintext', () => {
  const key=randomBytes(32), token='test.wb.token-that-must-stay-secret';
  const encrypted=encryptSecret(token,key);
  assert.equal(encrypted.nonce.length,12);
  assert.equal(encrypted.authTag.length,16);
  assert.equal(encrypted.ciphertext.includes(Buffer.from(token)),false);
  assert.equal(decryptSecret(encrypted,key),token);
});

test('WB encryption key must contain exactly 32 bytes', () => {
  assert.throws(()=>loadEncryptionKey({}),/wb_encryption_not_configured/);
  assert.throws(()=>loadEncryptionKey({WB_TOKEN_ENCRYPTION_KEY:Buffer.alloc(16).toString('base64')}),/wb_encryption_not_configured/);
  assert.throws(()=>loadEncryptionKey({WB_TOKEN_ENCRYPTION_KEY:`${Buffer.alloc(32).toString('base64')}ignored`}),/wb_encryption_not_configured/);
  assert.equal(loadEncryptionKey({WB_TOKEN_ENCRYPTION_KEY:Buffer.alloc(32).toString('base64')}).length,32);
});

test('WB token fingerprint uses a separate 32-byte key and is stable', () => {
  const key=randomBytes(32),token='test.wb.token-that-must-stay-secret';
  assert.throws(()=>loadFingerprintKey({}),/wb_fingerprint_not_configured/);
  assert.throws(()=>loadFingerprintKey({WB_TOKEN_FINGERPRINT_KEY:Buffer.alloc(31).toString('base64')}),/wb_fingerprint_not_configured/);
  assert.equal(loadFingerprintKey({WB_TOKEN_FINGERPRINT_KEY:key.toString('base64')}).equals(key),true);
  assert.match(fingerprintSecret(token,key),/^[0-9a-f]{64}$/);
  assert.equal(fingerprintSecret(token,key),fingerprintSecret(token,key));
  assert.notEqual(fingerprintSecret(token,key),fingerprintSecret(`${token}.changed`,key));
  assert.notEqual(fingerprintSecret(token,key),fingerprintSecret(`marketplace-control:wb-token-fingerprint:v1\0${token}`,key));
});
