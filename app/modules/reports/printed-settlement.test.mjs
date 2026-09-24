import test from 'node:test';
import assert from 'node:assert/strict';
import { printedSellerSettlement } from './printed-settlement.mjs';

test('seller-directed printed form formula adds damage compensation and other payouts',()=>{
  assert.equal(printedSellerSettlement({1:'100.00',2:'20.00',3:'3.00',4:'4.00',5:'5.00',6:'6.00',7:'7.00'}),'73.00');
});

test('explicit dashes are zero but missing print fields are not assumed zero',()=>{
  assert.equal(printedSellerSettlement({1:'6 816,00',2:'2 702,83',3:'—',4:'—',5:'—',6:'—',7:'—'}),'4113.17');
  assert.equal(printedSellerSettlement({1:'12094.00',2:'4673.64',3:'—',4:'—',5:'—',6:'—',7:'—'}),'7420.36');
  assert.equal(printedSellerSettlement({1:'6816',2:'2702.83'}),null);
});
