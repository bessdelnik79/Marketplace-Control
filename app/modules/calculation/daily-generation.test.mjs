import assert from 'node:assert/strict';
import test from 'node:test';
import { aggregateDailyFinancialGeneration,buildDailyFinancialGeneration,compareDailyGenerationToLegacy } from './daily-generation.mjs';

const baseResult={quality:'partial',missingReasons:['operation_unclassified'],lines:[
  {accountingDate:'2026-09-21',scopeCode:'selected_product',productId:'product-1',variantId:'variant-1',categoryCode:'revenue',amountSigned:'100.0000',evidence:[{sourceType:'financial_component',sourceId:'component-1',contributionAmount:'100.0000'}]},
  {accountingDate:'2026-09-22',scopeCode:'store',productId:null,variantId:null,categoryCode:'storage',amountSigned:'-10.0000',evidence:[{sourceType:'financial_component',sourceId:'component-2',contributionAmount:'-10.0000'}]},
  {accountingDate:'2026-09-22',scopeCode:'selected_product',productId:'product-1',variantId:null,categoryCode:'estimated_usn_tax',amountSigned:'-5.4000',evidence:[]}
]};

test('daily generation keeps exact non-tax lines and applies range reasons to every day',()=>{
  const generation=buildDailyFinancialGeneration({periodStart:'2026-09-21',periodEnd:'2026-09-22',result:baseResult,taxReference:{usable:false},coverageComplete:true});
  assert.equal(generation.lines.length,2);
  assert.deepEqual(generation.days.map(day=>day.missingReasons),[['operation_unclassified'],['operation_unclassified']]);
  assert.equal(generation.days[0].selectedProductsResultBeforeTax,'100.0000');
  assert.equal(generation.days[1].storeLevelResultBeforeTax,'-10.0000');
});

test('period aggregation rounds one exact tax numerator per SKU after signed daily offsets',()=>{
  const generation=buildDailyFinancialGeneration({periodStart:'2026-09-21',periodEnd:'2026-09-22',result:{...baseResult,quality:'complete',missingReasons:[]},coverageComplete:true,taxReference:{usable:true,segments:[
    {productId:'product-1',taxSettingVersionId:'tax-1',rateFraction:'0.06000000',evidence:[
      {sourceId:'component-1',accountingDate:'2026-09-21',contributionAmount:'100.0000'},
      {sourceId:'component-3',accountingDate:'2026-09-22',contributionAmount:'-10.0000'}
    ]}
  ]}});
  assert.deepEqual(generation.taxFacts.map(fact=>fact.numerator),['6.000000000000','-0.600000000000']);
  assert.deepEqual(aggregateDailyFinancialGeneration(generation).totals,{
    selectedProductsResultBeforeTax:'100.0000',storeLevelResultBeforeTax:'-10.0000',availableResultBeforeTax:'90.0000',
    estimatedUsnTax:'5.4000',availableResultAfterTax:'84.6000',netProfit:null
  });
});

test('usable tax without daily source evidence fails closed',()=>{
  assert.throws(()=>buildDailyFinancialGeneration({periodStart:'2026-09-21',periodEnd:'2026-09-22',result:baseResult,
    taxReference:{usable:true,segments:[{productId:'product-1',taxSettingVersionId:'tax-1',rateFraction:'0.06'}]}}),/daily_tax_evidence_missing/);
});

test('shadow comparison reports exact mismatched fields',()=>{
  const generation=buildDailyFinancialGeneration({periodStart:'2026-09-21',periodEnd:'2026-09-22',result:baseResult,taxReference:{usable:false}});
  const comparison=compareDailyGenerationToLegacy(generation,{period_start:'2026-09-21',period_end:'2026-09-22',quality:'partial',missing_reasons:['operation_unclassified'],totals:{
    selectedProductsResultBeforeTax:'100.0000',storeLevelResultBeforeTax:'-10.0000',availableResultBeforeTax:'91.0000',estimatedUsnTax:null,availableResultAfterTax:null,netProfit:null
  }});
  assert.equal(comparison.status,'mismatch');
  assert.deepEqual(comparison.mismatches,['totals.availableResultBeforeTax']);
});

test('arbitrary range fails closed when signed SKU offsets make the aggregate tax base negative',()=>{
  const generation={
    periodStart:'2026-09-01',periodEnd:'2026-09-01',missingReasons:[],
    days:[{accountingDate:'2026-09-01',coverageComplete:true,taxUsable:true,quality:'complete',missingReasons:[],
      selectedProductsResultBeforeTax:'50.0000',storeLevelResultBeforeTax:'0.0000',availableResultBeforeTax:'50.0000'}],
    taxFacts:[
      {accountingDate:'2026-09-01',productId:'positive',taxableBase:'100.000000000000',numerator:'6.000000000000'},
      {accountingDate:'2026-09-01',productId:'negative',taxableBase:'-150.000000000000',numerator:'-1.500000000000'}
    ]
  };
  assert.deepEqual(aggregateDailyFinancialGeneration(generation),{
    quality:'partial',missingReasons:['tax_base_negative_unverified'],totals:{
      selectedProductsResultBeforeTax:'50.0000',storeLevelResultBeforeTax:'0.0000',availableResultBeforeTax:'50.0000',
      estimatedUsnTax:null,availableResultAfterTax:null,netProfit:null
    }
  });
});
