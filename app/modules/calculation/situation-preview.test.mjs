import test from 'node:test';
import assert from 'node:assert/strict';
import { readSituationRevenuePreview } from './situation-preview.mjs';

const groups = [{groupKey:'sales', categoryCode:'revenue'}, {groupKey:'returns', categoryCode:'revenue_return'}];
function row(id, quantity='1', overrides={}) {
  return {id, contributionAmount:'10.1234', evidenceStatus:'matched', missingReasons:[], source:{
    operationVersionId:`op-${id}`, operationType:'sale', accountingDate:'2026-07-14', quantity,
    productId:'product', reportRowId:`report-${id}`, raw:{sellerOperName:'<script>alert(1)</script>'}, ...overrides}};
}
function page(items=[], overrides={}) {
  return {items, totalItems:items.length, nextCursor:null, evidenceStatus:'matched',
    reconciliation:{status:'matched'}, moneyReconciliation:{status:'matched'}, ...overrides};
}
function preview(sales, returns=page(), selected=groups) {
  return readSituationRevenuePreview('viewer', {publicationId:'old'}, {productId:'product', groups:selected},
    async(_user, input) => input.groupKey === 'sales' ? sales : returns);
}

test('counts exact quantities above one, decimals and large integers; returns do not count', async() => {
  const sales = [row('1','2'), row('2','0.125'), row('3','9007199254740993'), row('4','0.875')];
  const returned = row('5','-7',{operationType:'return',originalSale:{quantity:'7',operationType:'sale'}});
  returned.contributionAmount = '-20.5000';
  const result = await preview(page(sales), page([returned]));
  assert.equal(result.soldQuantity, '9007199254740996');
  assert.equal(result.quantityReason, null);
  assert.equal(result.rows.find(item=>item.id==='5').contributionAmount, '-20.5000');
  assert.equal(result.rows[0].source.raw.sellerOperName, '<script>alert(1)</script>');
  assert.equal(result.hasMore, false);
});

test('de-duplicates consistent operation quantities without changing contribution rows', async() => {
  const original = row('1','2.500');
  const repeated = {...original, id:'2', source:{...original.source, quantity:'2.5'}};
  const result = await preview(page([original,repeated]));
  assert.equal(result.soldQuantity, '2.5');
  assert.equal(result.rows.length, 2);
  for (const changed of [{quantity:'3'}, {accountingDate:'2026-07-15'}, {reportVersionId:'different'}]) {
    const inconsistent = await preview(page([original, {...repeated, source:{...repeated.source,...changed}}]));
    assert.equal(inconsistent.soldQuantity, null);
    assert.equal(inconsistent.quantityReason, 'situation_sale_operation_inconsistent');
  }
});

test('unknown, zero or negative sale quantities and unknown operations remain unavailable', async() => {
  for (const value of [null,undefined,'','0','0.000','-2','NaN','1e3',2]) {
    const result = await preview(page([row('1','1',{quantity:value})]));
    assert.equal(result.soldQuantity, null, String(value));
    assert.equal(result.quantityReason, 'situation_sale_quantity_unverified');
  }
  const unknown = await preview(page([row('1','2',{operationType:'unknown'})]));
  assert.equal(unknown.soldQuantity, null);
});

test('empty or return-only groups do not fabricate zero sales', async() => {
  for (const selected of [[],[groups[1]]]) {
    const result = await preview(page(), page(), selected);
    assert.equal(result.soldQuantity, null);
    assert.equal(result.quantityReason, 'situation_revenue_groups_missing');
  }
});

test('quantity needs every full page, source and both money reconciliations', async() => {
  for (const overrides of [{nextCursor:'next',totalItems:101}, {totalItems:2}]) {
    const result = await preview(page([row('1','2')]), page([row('2','-1',{operationType:'return'})],overrides));
    assert.equal(result.soldQuantity, null);
    assert.equal(result.quantityReason, 'situation_revenue_page_incomplete');
    assert.equal(result.hasMore, true);
  }
  for (const overrides of [{reconciliation:{status:'mismatch'}}, {moneyReconciliation:{status:'mismatch'}}]) {
    const result = await preview(page([row('1','2')],overrides));
    assert.equal(result.soldQuantity, null);
    assert.equal(result.quantityReason, 'drilldown_reconciliation_mismatch');
  }
  const missing = {...row('1','2'), source:null, evidenceStatus:'unavailable'};
  const result = await preview(page([missing],{evidenceStatus:'unavailable'}));
  assert.equal(result.soldQuantity, null);
  assert.equal(result.quantityReason, 'drilldown_frozen_source_missing');
  assert.equal(result.rows[0].contributionAmount, '10.1234');
  assert.equal(result.rows[0].source, null);
});

test('preview sorts confirmed dates then IDs, bounds rows to ten and leaves unavailable dates unknown', async() => {
  const items = Array.from({length:100}, (_,index) => row(String(index).padStart(3,'0'),'1',{
    accountingDate:index < 5 ? '2026-07-15' : '2026-07-14'})).reverse();
  const result = await preview(page(items,{totalItems:101,nextCursor:'bound',evidenceStatus:'unchecked'}));
  assert.equal(result.rows.length, 10);
  assert.deepEqual(result.rows.map(row=>row.id), ['005','006','007','008','009','010','011','012','013','014']);
  assert.equal(result.hasMore, true);
  assert.equal(result.soldQuantity, null);
  assert.deepEqual(result.groups[0], {groupKey:'sales',categoryCode:'revenue',totalItems:101,nextCursor:'bound',
    evidenceStatus:'unchecked',reconciliation:{status:'matched'}});
  const unproven = {...row('unknown'), evidenceStatus:'unavailable'};
  const unknown = await preview(page([unproven,row('known')]));
  assert.equal(unknown.rows[1].source, null);
  const mismatch = await preview(page([row('1')],{reconciliation:{status:'mismatch'}}));
  assert.equal(mismatch.rows[0].source, null);
});

test('unexpected contribution reader failures propagate', async() => {
  await assert.rejects(readSituationRevenuePreview('viewer', {}, {productId:'product',groups},
    async() => {throw new Error('database unavailable');}), /database unavailable/);
});
