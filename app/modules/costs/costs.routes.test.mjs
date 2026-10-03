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
    saveVariantCost: async (id, data) => { calls.push(['save', id, data]); return { ok: true, skipped: 0 }; },
    form: async () => ({ storeId: 'store-1', variantId: 'variant-1', unitCost: '12,34', effectiveFrom: '2026-01-01' }),
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
  for (const [method, route] of [['GET', '/costs'], ['GET', '/costs/template.csv'], ['POST', '/costs/import'], ['POST', '/costs/save']]) {
    const state = setup();
    assert.equal(await state.run(method, route, null), true);
    assert.equal(state.response.location, '/login');
    assert.deepEqual(state.calls, []);
  }
});

test('manual save checks origin and rate limit before reading the form', async () => {
  for (const overrides of [{ sameOrigin: () => false }, { takeLimit: async () => ({ allowed: false }) }]) {
    const state = setup({ form: async () => assert.fail('must not read form'), ...overrides });
    await state.run('POST', '/costs/save');
    assert.ok([403, 429].includes(state.response.status));
    assert.deepEqual(state.calls, []);
  }
});

test('manual save preserves decimal text, date and selected store', async () => {
  const state = setup();
  await state.run('POST', '/costs/save');
  assert.deepEqual(state.calls[1], ['save', 'user-1', { storeId: 'store-1', variantId: 'variant-1', unitCost: '12,34', effectiveFrom: '2026-01-01' }]);
  assert.equal(state.response.location, '/costs?saved=1&storeId=store-1');
  const skipped = setup({ saveVariantCost: async () => ({ skipped: 1 }) });
  await skipped.run('POST', '/costs/save');
  assert.equal(skipped.response.location, '/costs?skipped=1&storeId=store-1');
});

test('manual validation and permission errors retain the edited row', async () => {
  for (const [message, status] of [['cost_invalid_amount',422],['cost_invalid_date',422],['cost_write_forbidden',403],['cost_variant_not_found',404]]) {
    const state = setup({ saveVariantCost: async () => { throw new Error(message); } });
    await state.run('POST', '/costs/save');
    assert.equal(state.response.status, status);
    assert.equal(state.response.body.options.manualValues.variantId, 'variant-1');
    assert.equal(state.response.body.options.manualValues.unitCost, '12,34');
    assert.ok(state.response.body.options.manualError);
  }
});

test('manual save rejects foreign stores and duplicate form fields', async () => {
  const foreign = setup({ form: async () => ({ storeId: 'foreign' }) });
  await foreign.run('POST', '/costs/save');
  assert.equal(foreign.response.status, 404);
  assert.equal(foreign.calls.some(([name]) => name === 'save'), false);
  const duplicate = setup({ form: async () => ({ storeId: ['store-1','foreign'] }) });
  await duplicate.run('POST', '/costs/save');
  assert.equal(duplicate.response.status, 404);
});

test('cost page selects the requested owned store and shows manual notices', async () => {
  const list = [{ id: 'store-1' }, { id: 'store-2' }];
  const state = setup({ listStores: async () => list, getCostState: async (id, storeId) => { assert.equal(storeId, 'store-2'); return {}; } });
  await state.run('GET', '/costs?saved=1&storeId=store-2');
  assert.equal(state.response.body.list[0].id, 'store-2');
  assert.match(state.response.body.options.notice, /сохранена/);
  const foreign = setup();
  await foreign.run('GET', '/costs?storeId=foreign');
  assert.equal(foreign.response.status, 404);
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
  assert.equal(state.response.location, '/costs?storeId=store-1&imported=1');
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

test('upload result and validation errors preserve a secondary store', async () => {
  const list = [{ id: 'store-1' }, { id: 'store-2' }];
  const overrides = {
    listStores: async () => list,
    multipart: async () => ({ fields: { storeId: 'store-2' }, files: { file: { fileName: 'costs.csv', buffer: csv } } }),
    getCostState: async (id, storeId) => { assert.equal(storeId, 'store-2'); return {}; },
  };
  const saved = setup(overrides);
  await saved.run();
  assert.equal(saved.response.location, '/costs?storeId=store-2&imported=1');
  const invalid = setup({ ...overrides, importVariantCosts: async () => ({ ok: false, errors: [] }) });
  await invalid.run();
  assert.equal(invalid.response.body.list[0].id, 'store-2');
  const forbidden = setup({ ...overrides, importVariantCosts: async () => { throw new Error('cost_write_forbidden'); } });
  await forbidden.run();
  assert.equal(forbidden.response.status, 403);
  assert.equal(forbidden.response.body.list[0].id, 'store-2');
});
