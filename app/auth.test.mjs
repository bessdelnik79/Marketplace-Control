// The VM deploy script runs this path as an authentication smoke test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEmail } from './modules/auth/auth.mjs';

test('authentication module loads from its feature directory', () => {
  assert.equal(normalizeEmail(' USER@EXAMPLE.COM '), 'user@example.com');
});
