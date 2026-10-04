import test from 'node:test';
import assert from 'node:assert/strict';
import { isWbStoreAlreadyAdded } from './connection-errors.mjs';

test('duplicate WB account is recognized without depending on token identity', () => {
  assert.equal(isWbStoreAlreadyAdded({code:'23505',constraint:'stores_business_id_marketplace_code_external_account_id_key'}),true);
});

test('unrelated database and connection errors remain internal errors', () => {
  for (const error of [undefined, new Error('store_account_mismatch'), {code:'23505',constraint:'connections_store_id_key'}, {code:'23514',constraint:'stores_business_id_marketplace_code_external_account_id_key'}]) {
    assert.equal(isWbStoreAlreadyAdded(error),false);
  }
});
