import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSituations } from './situations.mjs';

function financial(overrides={}){
  return{
    status:'available',quality:'complete',publicationId:'publication-1',period:{start:'2026-09-14',end:'2026-09-20',timezone:'Europe/Moscow'},
    scope:{type:'selected_products',productIds:['a','b','c','d']},
    situationEvidence:{productLossEligible:true,coveredProductIds:['a','b','c','d'],productResultsBeforeTax:[],penaltyAmount:'0.0000'},
    ...overrides
  };
}

test('creates product losses and net penalty with exact stable priority and three-item limit',()=>{
  const result=buildSituations(financial({situationEvidence:{
    productLossEligible:true,coveredProductIds:['a','b','c','d'],
    productResultsBeforeTax:[{productId:'a',amount:'-10.0000'},{productId:'b',amount:'0.0000'},{productId:'c',amount:'-30.0000'},{productId:'d',amount:'-20.0000'}],
    penaltyAmount:'-5.2500'
  }}));
  assert.equal(result.total,4);
  assert.deepEqual(result.items.map(item=>item.id),['product_loss:c','product_loss:d','product_loss:a']);
  assert.equal(result.items[0].metric.absoluteValue,'30.0000');
  assert.deepEqual(result.evaluatedRules,['product_loss','penalty']);
  assert.deepEqual(result.disabledRules,['return_growth']);
});

test('penalty reversals use signed net and zero net creates no situation',()=>{
  assert.equal(buildSituations(financial()).total,0);
  const result=buildSituations(financial({situationEvidence:{productLossEligible:true,coveredProductIds:[],productResultsBeforeTax:[],penaltyAmount:'12.5000'}}));
  assert.equal(result.items[0].kind,'penalty');
  assert.equal(result.items[0].metric.value,'12.5000');
});

test('partial product inputs fail closed while proven penalty remains visible',()=>{
  const result=buildSituations(financial({quality:'partial',situationEvidence:{productLossEligible:false,coveredProductIds:['a'],productResultsBeforeTax:[{productId:'a',amount:'-100.0000'}],penaltyAmount:'-3.0000'}}));
  assert.deepEqual(result.items.map(item=>item.kind),['penalty']);
  assert.ok(result.missingReasons.includes('product_loss_inputs_incomplete'));
});

test('unavailable financial evidence never becomes a zero situation count',()=>{
  const result=buildSituations({status:'unavailable',quality:'unavailable',situationEvidence:null});
  assert.equal(result.status,'unavailable');
  assert.equal(result.total,null);
  assert.deepEqual(result.items,[]);
});
