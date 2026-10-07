import assert from 'node:assert/strict';
import test from 'node:test';
import { campaignIdentityKey, campaignEmailSubject, campaignCabinetSubject } from './identity.mjs';

test('campaign subjects normalize email and domain-separate every marketplace and identity kind', () => {
  const key = campaignIdentityKey(Buffer.alloc(32,7).toString('base64'));
  assert.deepEqual(campaignEmailSubject(' Owner@Example.test ',key),campaignEmailSubject('owner@example.test',key));
  const subjects = [campaignEmailSubject('123',key),campaignCabinetSubject('wb','123',key),campaignCabinetSubject('ozon','123',key),campaignCabinetSubject('future-marketplace','123',key),campaignCabinetSubject('wb','124',key)];
  assert.equal(new Set(subjects.map(subject => subject.digest)).size,subjects.length);
  for (const subject of subjects) assert.match(subject.digest,/^[a-f0-9]{64}$/);
  assert.notEqual(campaignEmailSubject('123',key).digest,campaignEmailSubject('123',Buffer.alloc(32,8)).digest);
  assert.notEqual(campaignCabinetSubject('a','b:c',key).digest,campaignCabinetSubject('a:b','c',key).digest);
});

test('claims fail closed for a missing or malformed dedicated stable key and identities', () => {
  for (const value of [undefined,'','password',Buffer.alloc(31).toString('base64'),Buffer.alloc(33).toString('base64')]) {
    assert.throws(() => campaignIdentityKey(value),/campaign_identity_key_unavailable/);
  }
  const key = Buffer.alloc(32);
  assert.throws(() => campaignEmailSubject('',key),/campaign_email_required/);
  assert.throws(() => campaignCabinetSubject('wb','',key),/campaign_cabinet_identity_required/);
});
