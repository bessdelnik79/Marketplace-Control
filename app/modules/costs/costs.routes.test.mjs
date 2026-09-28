import test from 'node:test';
import assert from 'node:assert/strict';
import { createCostsRoutes } from './costs.routes.mjs';
import { costImportMaxBytes } from './costs.import.mjs';

const current = { user_id: 'user-1' };
const stores = [{ id: 'store-1', connected: true }];
const csv = Buffer.from('Артикул WB;ID варианта;Себестоимость;Действует с\n123;456;12;2026-01-01');
function setup(overrides = {}) {
  const calls = [];
  const response = {};
  const dependencies = {
    listStores: async id => { assert.equal(id, current.user_id); return stores; },
    getCostState: async () => ({ rows: [] }),
    importVariantCosts: async (id, data) => { calls.push(['import', id, data]); return { ok: true }; },
    costPage: (user, list, state, options) => ({ user, list, state, options }),
    send: (res, status, body, headers) => Object.assign(res, { status, body, headers }),
    sendBuffer: (res, status, body, headers) => Object.assign(res, { status, body, headers }),
    redirect: (res, location) => Object.assign(res, { status: 303, location }),
    sameOrigin: () => true,
    takeLimit: async (...args) => { calls.push(['limit', ...args]); return { allowed: true }; },
    multipart: async (req, limit) => { calls.push(['multipart', limit]); return { fields: { storeId: 'store-1' }, files: { file: { fileName: 'costs.csv', buffer: csv } } }; },
    ...overrides,
  };
  const handler = createCostsRoutes(dependencies);
  return {
    calls, response,
    run: (method = 'POST', route = '/costs/import', user = current) => handler({ method }, response, new URL(route, 'http://localhost'), user),
  };
}

test('cost routes leave unrelated requests unhandled', async () => {
  const state = setup();
  assert.equal(await state.run('GET', '/expenses'), false);
  assert.deepEqual(state.response, {});
  assert.deepEqual(state.calls, []);
});
test('all cost routes require a session', async () => {
  for (const [method, route] of [['GET', '/costs'], ['GET', '/costs/template.csv'], ['POST', '/costs/import']]) {
    const state = setup();
    assert.equal(await state.run(method, route, null), true);
    assert.equal(state.response.location, '/login');
    assert.deepEqual(state.calls, []);
  }
});
test('cross-origin cost upload is rejected before reading a file', async () => {
  const state = setup({ sameOrigin: () => false });
  await state.run();
  assert.equal(state.response.status, 403);
  assert.deepEqual(state.calls, []);
});
test('rate-limited upload does not read or import a file', async () => {
  const state = setup({ takeLimit: async () => ({ allowed: false }) });
  await state.run();
  assert.equal(state.response.status, 429);
  assert.deepEqual(state.calls, []);
});
test('successful upload preserves limits, parsed rows and checksum while database events own recalculation', async () => {
  const state = setup();
  await state.run();
  assert.equal(state.response.location, '/costs?imported=1');
  assert.deepEqual(state.calls[0], ['limit', 'cost-import:user-1', 10, 15]);
  assert.deepEqual(state.calls[1], ['multipart', costImportMaxBytes + 65536]);
  assert.equal(state.calls[2][1], 'user-1');
  assert.equal(state.calls[2][2].storeId, 'store-1');
  assert.equal(state.calls[2][2].rows[0].wbArticle, '123');
  assert.match(state.calls[2][2].checksum, /^[a-f0-9]{64}$/);
  assert.equal(state.calls.length, 3);
});
test('foreign store cannot be imported', async () => {
  const state = setup({ multipart: async () => ({ fields: { storeId: 'foreign' }, files: {} }) });
  await state.run();
  assert.equal(state.response.status, 404);
  assert.equal(state.calls.some(([name]) => name === 'import'), false);
});
test('row errors are shown without applying an import', async () => {
  const errors = [{ rowNumber: 2, code: 'cost_variant_not_found' }];
  const state = setup({ importVariantCosts: async () => ({ ok: false, errors }) });
  await state.run();
  assert.equal(state.response.status, 422);
  assert.deepEqual(state.response.body.options.importErrors, errors);
  assert.equal(state.calls.some(([name]) => name === 'import'), false);
});
test('upload failures retain status and never apply an import', async () => {
  for (const [message, status] of [['too_large', 413], ['cost_file_too_large', 413], ['cost_write_forbidden', 403], ['store_not_found', 404], ['multipart_invalid', 422], ['cost_file_empty', 422]]) {
    const state = setup({ multipart: async () => { throw new Error(message); } });
    await state.run();
    assert.equal(state.response.status, status, message);
    assert.equal(state.calls.some(([name]) => name === 'import'), false);
  }
});
test('cost page displays successful import notice', async () => {
  const state = setup();
  await state.run('GET', '/costs?imported=1');
  assert.equal(state.response.status, 200);
  assert.match(state.response.body.options.notice, /сохранена/);
});
test('CSV template is scoped to an owned store and returned as an attachment', async () => {
  const state = setup({ getCostState: async (id, storeId) => { assert.equal(id, 'user-1'); assert.equal(storeId, 'store-1'); return { rows: [] }; } });
  await state.run('GET', '/costs/template.csv?storeId=store-1');
  assert.equal(state.response.status, 200);
  assert.equal(state.response.headers['content-type'], 'text/csv; charset=utf-8');
  assert.match(state.response.headers['content-disposition'], /^attachment; filename="costs-/);
  assert.match(state.response.body.toString('utf8'), /Артикул WB/);
  const rejected = setup();
  await rejected.run('GET', '/costs/template.csv?storeId=foreign');
  assert.equal(rejected.response.status, 404);
});
