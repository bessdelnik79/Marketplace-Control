import { createHmac } from 'node:crypto';

export function campaignIdentityKey(value = process.env.CAMPAIGN_IDENTITY_HMAC_KEY) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value)) throw new Error('campaign_identity_key_unavailable');
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32 || key.toString('base64') !== value) throw new Error('campaign_identity_key_unavailable');
  return key;
}

export function campaignEmailSubject(email, key = campaignIdentityKey()) {
  if (typeof email !== 'string' || !email.trim()) throw new Error('campaign_email_required');
  return subject('email', [email.trim().toLowerCase()], key);
}

export function campaignCabinetSubject(marketplaceCode, sellerId, key = campaignIdentityKey()) {
  if (typeof marketplaceCode !== 'string' || !marketplaceCode.trim() || typeof sellerId !== 'string' || !sellerId.trim()) {
    throw new Error('campaign_cabinet_identity_required');
  }
  return subject('cabinet', [marketplaceCode.trim().toLowerCase(), sellerId.trim()], key);
}

function subject(kind, identity, key) {
  return { kind, digest: createHmac('sha256', key).update(JSON.stringify(['marketplace-control:campaign-identity:v1', kind, ...identity])).digest('hex') };
}
