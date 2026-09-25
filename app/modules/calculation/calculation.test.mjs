import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateFinancialResult,
  calculateStoreTaxReference,
  canonicalJson,
  createInputFingerprint,
  isVerifiedWbResultComponent,
  normalizeMoney,
  periodizeExpense
} from './calculation.mjs';

test('only verified WB field, operation and document combinations enter the result', () => {
  const verified = [
    ['retailAmount', 'revenue', 'sale', 'Продажа', 'Продажа'],
    ['retailAmount', 'revenue_return', 'return', 'Возврат', 'Возврат'],
    ['acquiringFee', 'acquiring', 'sale', 'Продажа', 'Продажа'],
    ['deliveryService', 'logistics', 'service_charge', '', 'Логистика'],
    ['deliveryService', 'logistics', 'service_charge', '', 'Доставка'],
    ['deliveryService', 'logistics', 'service_charge', '', 'Коррекция стоимости доставки'],
    ['paidStorage', 'storage', 'service_charge', '', 'Хранение'],
    ['paidStorage', 'storage', 'service_charge', '', 'Коррекция хранения'],
    ['paidAcceptance', 'acceptance', 'service_charge', '', 'Обработка товара'],
    ['penalty', 'penalty', 'adjustment', '', 'Штраф'],
    ['deduction', 'deduction', 'adjustment', '', 'Удержание']
  ];
  for (const [sourceField, categoryCode, operationType, docTypeName, sellerOperName] of verified) {
    assert.equal(isVerifiedWbResultComponent({ sourceField, categoryCode, operationType, docTypeName, sellerOperName, rawValue: '10' }), true, sourceField);
  }
  const unknown = [
    ['acquiringFee', 'acquiring', 'return', 'Возврат', 'Возврат'],
    ['deliveryService', 'logistics', 'service_charge', '', 'Новая услуга'],
    ['deliveryService', 'logistics', 'service_charge', 'Продажа', 'Логистика'],
    ['ppvzReward', 'pickup_reward', 'unclassified', 'Продажа', 'Возмещение за выдачу и возврат товаров на ПВЗ'],
    ['vw', 'wb_reward_without_vat', 'sale', 'Продажа', 'Продажа'],
    ['vwNds', 'wb_reward_vat', 'sale', 'Продажа', 'Продажа'],
    ['cashbackDiscount', 'unclassified_financial_field', 'unclassified', 'Продажа', 'Компенсация скидки по программе лояльности'],
    ['additionalPayment', 'commission_adjustment', 'adjustment', '', 'Удержание']
  ];
  for (const [sourceField, categoryCode, operationType, docTypeName, sellerOperName] of unknown) {
    assert.equal(isVerifiedWbResultComponent({ sourceField, categoryCode, operationType, docTypeName, sellerOperName, rawValue: '10' }), false, sourceField);
  }
  assert.equal(isVerifiedWbResultComponent({sourceField:'acquiringFee',categoryCode:'acquiring',operationType:'sale',docTypeName:'Продажа',sellerOperName:'Продажа',rawValue:'-10'}),false);
  assert.equal(isVerifiedWbResultComponent({sourceField:'deliveryService',categoryCode:'logistics',operationType:'service_charge',docTypeName:'',sellerOperName:'Логистика',rawValue:'-10'}),false);
});

test('money normalization preserves four decimal places without Number precision loss', () => {
  assert.equal(normalizeMoney('9007199254740991.1234'), '9007199254740991.1234');
  assert.equal(normalizeMoney('-00012.3'), '-12.3000');
  assert.equal(normalizeMoney('-0.0000'), '0.0000');
  assert.throws(() => normalizeMoney('0.00001'), /calculation_invalid_money/);
  assert.throws(() => normalizeMoney('NaN'), /calculation_invalid_money/);
  assert.throws(() => normalizeMoney('10000000000000000.0000'), /calculation_money_overflow/);
});

test('canonical JSON and input fingerprint are stable across object and input array order', () => {
  assert.equal(canonicalJson({ z: 1, a: { y: 2, b: 3 } }), '{"a":{"b":3,"y":2},"z":1}');
  const base = {
    resultMethodVersion: 'result-v1',
    selectedProductIds: ['product-b', 'product-a', 'product-a'],
    reportVersionIds: ['report-2', 'report-1'],
    reportNormalizationIds: ['normalization-2', 'normalization-1'],
    costVersionIds: ['cost-2', 'cost-1'],
    expenseVersionIds: ['expense-1'],
    taxSettingVersionIds: [],
    periodStart: '2026-07-13',
    periodEnd: '2026-07-19'
  };
  const reordered = {
    ...base,
    selectedProductIds: ['product-a', 'product-b'],
    reportVersionIds: [...base.reportVersionIds].reverse(),
    reportNormalizationIds: [...base.reportNormalizationIds].reverse(),
    costVersionIds: [...base.costVersionIds].reverse()
  };
  assert.equal(createInputFingerprint(base), createInputFingerprint(reordered));
  assert.notEqual(createInputFingerprint(base), createInputFingerprint({ ...base, costVersionIds: ['cost-3'] }));
  assert.match(createInputFingerprint(base), /^[a-f0-9]{64}$/);
});

test('on-date expense is recognized once and only inside the calculation period', () => {
  const expense = { id: 'expense-1', amount: '100.2500', periodStart: '2026-07-15', periodEnd: '2026-07-15', recognitionMethod: 'on_date' };
  assert.deepEqual(periodizeExpense(expense), [{ expenseVersionId: 'expense-1', accountingDate: '2026-07-15', amountSigned: '-100.2500' }]);
  assert.deepEqual(periodizeExpense(expense, { periodStart: '2026-07-16', periodEnd: '2026-07-19' }), []);
  assert.throws(() => periodizeExpense({ ...expense, periodEnd: '2026-07-16' }), /calculation_on_date_period_mismatch/);
});

test('even periodization truncates to four places and puts the exact remainder on the last day', () => {
  const expense = { id: 'expense-1', amount: '10.0000', periodStart: '2026-07-13', periodEnd: '2026-07-15', recognitionMethod: 'evenly_over_period' };
  assert.deepEqual(periodizeExpense(expense), [
    { expenseVersionId: 'expense-1', accountingDate: '2026-07-13', amountSigned: '-3.3333' },
    { expenseVersionId: 'expense-1', accountingDate: '2026-07-14', amountSigned: '-3.3333' },
    { expenseVersionId: 'expense-1', accountingDate: '2026-07-15', amountSigned: '-3.3334' }
  ]);
  assert.deepEqual(periodizeExpense(expense, { periodStart: '2026-07-14', periodEnd: '2026-07-15' }).map(row => row.amountSigned), ['-3.3333', '-3.3334']);
});

test('calculation excludes unallocated store charges from selected SKU result', () => {
  const result = calculateFinancialResult({
    periodStart: '2026-07-13',
    periodEnd: '2026-07-19',
    selectedProductIds: ['product-1'],
    financialComponents: [
      { id: 'fc-1', classificationStatus: 'confirmed', scopeCode: 'selected_product', productId: 'product-1', variantId: 'variant-1', accountingDate: '2026-07-13', categoryCode: 'revenue', amountSigned: '100.0000' },
      { id: 'fc-2', classificationStatus: 'confirmed', scopeCode: 'selected_product', productId: 'product-1', variantId: 'variant-1', accountingDate: '2026-07-13', categoryCode: 'commission', amountSigned: '-12.5000' },
      { id: 'fc-3', classificationStatus: 'confirmed', scopeCode: 'store', productId: null, accountingDate: '2026-07-14', categoryCode: 'storage', amountSigned: '-5.1250' },
      { id: 'fc-4', classificationStatus: 'confirmed', scopeCode: 'selected_product', productId: 'not-selected', accountingDate: '2026-07-13', categoryCode: 'revenue', amountSigned: '999.0000' },
      { id: 'fc-5', classificationStatus: 'confirmed', scopeCode: 'reconciliation', accountingDate: '2026-07-13', categoryCode: 'payout', amountSigned: '82.3750' }
    ]
  });
  assert.equal(result.quality, 'partial');
  assert.deepEqual(result.missingReasons, ['store_component_unallocated', 'tax_setting_missing']);
  assert.deepEqual(result.totals, {
    selectedProductsResultBeforeTax: '87.5000',
    storeLevelResultBeforeTax: '0.0000',
    availableResultBeforeTax: '87.5000',
    estimatedUsnTax: '0.0000',
    availableResultAfterTax: null,
    netProfit: null
  });
  assert.equal(result.lines.length, 2);
});

test('calculation sums values beyond Number safe precision exactly', () => {
  const result = calculateFinancialResult({
    periodStart: '2026-07-13', periodEnd: '2026-07-19', selectedProductIds: ['product-1'],
    financialComponents: [
      { id: 'large-a', classificationStatus: 'confirmed', scopeCode: 'selected_product', productId: 'product-1', accountingDate: '2026-07-13', categoryCode: 'revenue', amountSigned: '9007199254740991.1234' },
      { id: 'large-b', classificationStatus: 'confirmed', scopeCode: 'selected_product', productId: 'product-1', accountingDate: '2026-07-13', categoryCode: 'revenue', amountSigned: '0.0001' }
    ]
  });
  assert.equal(result.lines[0].amountSigned, '9007199254740991.1235');
  assert.equal(result.totals.availableResultBeforeTax, '9007199254740991.1235');
});

test('signed commission adjustment is included while legacy additional payment is unclassified', () => {
  const result = calculateFinancialResult({
    periodStart: '2026-07-13', periodEnd: '2026-07-19', selectedProductIds: ['product-1'],
    financialComponents: [
      { id: 'adjustment', classificationStatus: 'confirmed', scopeCode: 'selected_product', productId: 'product-1', accountingDate: '2026-07-13', categoryCode: 'commission_adjustment', amountSigned: '-3.2500' },
      { id: 'legacy', classificationStatus: 'confirmed', scopeCode: 'selected_product', productId: 'product-1', accountingDate: '2026-07-13', categoryCode: 'additional_payment', amountSigned: '99.0000' }
    ]
  });
  assert.equal(result.lines.length, 1);
  assert.equal(result.lines[0].categoryCode, 'commission_adjustment');
  assert.equal(result.lines[0].amountSigned, '-3.2500');
  assert.deepEqual(result.missingReasons, ['operation_unclassified', 'tax_setting_missing']);
});

test('verified charges affect partial result once while PVZ and WB reward fields remain excluded', () => {
  const result = calculateFinancialResult({
    periodStart: '2026-09-14', periodEnd: '2026-09-20', selectedProductIds: ['product-1'],
    financialComponents: [
      { id: 'sale', classificationStatus: 'confirmed', scopeCode: 'selected_product', productId: 'product-1', accountingDate: '2026-09-14', categoryCode: 'revenue', amountSigned: '100.0000' },
      { id: 'delivery', classificationStatus: 'confirmed', scopeCode: 'selected_product', productId: 'product-1', accountingDate: '2026-09-14', categoryCode: 'logistics', amountSigned: '-10.0000' },
      { id: 'delivery-reversal', classificationStatus: 'confirmed', scopeCode: 'selected_product', productId: 'product-1', accountingDate: '2026-09-15', categoryCode: 'logistics', amountSigned: '2.0000' },
      { id: 'pickup', classificationStatus: 'unclassified', scopeCode: 'selected_product', productId: 'product-1', accountingDate: '2026-09-14', categoryCode: 'pickup_reward', amountSigned: '3.0000' },
      { id: 'reward', classificationStatus: 'unclassified', scopeCode: 'selected_product', productId: 'product-1', accountingDate: '2026-09-14', categoryCode: 'wb_reward_without_vat', amountSigned: '-3.0000' }
    ]
  });
  assert.equal(result.quality, 'partial');
  assert.deepEqual(result.missingReasons, ['operation_unclassified', 'tax_setting_missing']);
  assert.equal(result.totals.availableResultBeforeTax, '92.0000');
  assert.deepEqual(result.lines.map(line => line.categoryCode), ['logistics', 'revenue', 'logistics']);
});

test('sales COGS uses the latest effective version and exact rounded multiplication', () => {
  const result = calculateFinancialResult({
    periodStart: '2026-07-13', periodEnd: '2026-07-19', selectedProductIds: ['product-1'],
    operations: [
      { id: 'sale-1', operationType: 'sale', productId: 'product-1', variantId: 'variant-1', accountingDate: '2026-07-14', quantity: '1.234567' },
      { id: 'sale-2', operationType: 'sale', productId: 'product-1', variantId: 'variant-1', accountingDate: '2026-07-16', quantity: '2' }
    ],
    costVersions: [
      { id: 'cost-old', variantId: 'variant-1', effectiveFrom: '2026-01-01', unitCost: '10.0000' },
      { id: 'cost-new', variantId: 'variant-1', effectiveFrom: '2026-07-15', unitCost: '12.3456' }
    ]
  });
  const cogs = result.lines.filter(line => line.categoryCode === 'cost_of_goods');
  assert.deepEqual(cogs.map(line => line.amountSigned), ['-12.3457', '-24.6912']);
  assert.equal(cogs[0].evidence[0].costVersionId, 'cost-old');
  assert.equal(cogs[1].evidence[0].costVersionId, 'cost-new');
});

test('only selected product expenses enter result; unallocated store expense is explicit', () => {
  const result = calculateFinancialResult({
    periodStart: '2026-07-14', periodEnd: '2026-07-15', selectedProductIds: ['product-1'],
    expenses: [
      { id: 'expense-product', state: 'active', scopeCode: 'selected_product', productId: 'product-1', variantId: null, category: 'packaging', amount: '9.0000', periodStart: '2026-07-13', periodEnd: '2026-07-15', recognitionMethod: 'evenly_over_period' },
      { id: 'expense-store', state: 'active', scopeCode: 'store', category: 'software_services', amount: '2.5000', periodStart: '2026-07-14', periodEnd: '2026-07-14', recognitionMethod: 'on_date' }
    ]
  });
  assert.equal(result.totals.selectedProductsResultBeforeTax, '-6.0000');
  assert.equal(result.totals.storeLevelResultBeforeTax, '0.0000');
  assert.ok(result.missingReasons.includes('store_expense_unallocated'));
  assert.deepEqual(result.lines.map(line => line.categoryCode), ['packaging', 'packaging']);
  assert.deepEqual(result.lines.map(line => [line.scopeCode, line.accountingDate, line.amountSigned]), [
    ['selected_product', '2026-07-14', '-3.0000'],
    ['selected_product', '2026-07-15', '-3.0000']
  ]);
});

test('expenses reject unknown categories and store scope rejects product linkage', () => {
  const base = { periodStart: '2026-07-13', periodEnd: '2026-07-19', selectedProductIds: ['product-1'] };
  assert.throws(() => calculateFinancialResult({
    ...base,
    expenses: [{ id: 'expense', scopeCode: 'store', category: 'mystery', amount: '1.0000', periodStart: '2026-07-13', periodEnd: '2026-07-13', recognitionMethod: 'on_date' }]
  }), /calculation_invalid_expense_category/);
  assert.throws(() => calculateFinancialResult({
    ...base,
    financialComponents: [{ id: 'component', classificationStatus: 'confirmed', scopeCode: 'store', productId: 'product-1', accountingDate: '2026-07-13', categoryCode: 'storage', amountSigned: '-1.0000' }]
  }), /calculation_store_scope_contradiction/);
  assert.throws(() => calculateFinancialResult({
    ...base,
    financialComponents: [{ id: 'payout', classificationStatus: 'confirmed', scopeCode: 'store', productId: 'product-1', accountingDate: '2026-07-13', categoryCode: 'payout', amountSigned: '1.0000' }]
  }), /calculation_store_scope_contradiction/);
  assert.throws(() => calculateFinancialResult({
    ...base,
    expenses: [{ id: 'expense', scopeCode: 'store', variantId: 'variant-1', category: 'packaging', amount: '1.0000', periodStart: '2026-07-13', periodEnd: '2026-07-13', recognitionMethod: 'on_date' }]
  }), /calculation_store_scope_contradiction/);
});

test('missing cost, unsupported return COGS, unclassified and lost product links produce stable reasons', () => {
  const result = calculateFinancialResult({
    periodStart: '2026-07-13', periodEnd: '2026-07-19', selectedProductIds: ['product-1'],
    financialComponents: [
      { id: 'unknown', classificationStatus: 'unclassified', scopeCode: 'selected_product', productId: 'product-1', accountingDate: '2026-07-13', categoryCode: 'deduction', amountSigned: '-1.0000' },
      { id: 'unknown-category', classificationStatus: 'confirmed', scopeCode: 'store', accountingDate: '2026-07-13', categoryCode: 'future_money_field', amountSigned: '-1.0000' },
      { id: 'lost-link', classificationStatus: 'confirmed', scopeCode: 'product_expected', accountingDate: '2026-07-13', categoryCode: 'commission', amountSigned: '-1.0000' },
      { id: 'unreconciled', classificationStatus: 'confirmed', reconciliationStatus: 'failed', scopeCode: 'store', accountingDate: '2026-07-13', categoryCode: 'storage', amountSigned: '-1.0000' }
    ],
    operations: [
      { id: 'sale-missing-cost', operationType: 'sale', productId: 'product-1', variantId: 'variant-1', accountingDate: '2026-07-13', quantity: '1' },
      { id: 'return-1', operationType: 'return', productId: 'product-1', variantId: 'variant-1', accountingDate: '2026-07-14', quantity: '-1' }
    ],
    reportCoverageComplete: false
  });
  assert.equal(result.quality, 'unavailable');
  assert.equal(result.totals, null);
  assert.deepEqual(result.missingReasons, [
    'cost_missing', 'return_original_sale_unmatched', 'operation_unclassified', 'product_link_missing',
    'tax_setting_missing', 'report_coverage_incomplete', 'source_unreconciled'
  ]);
});

test('selected-SKU tax reference does not silently enter profit, and VAT stays unsupported', () => {
  const result = calculateFinancialResult({
    periodStart: '2026-07-13', periodEnd: '2026-07-19', selectedProductIds: ['product-1'],
    financialComponents: [
      { id: 'revenue', classificationStatus: 'confirmed', scopeCode: 'selected_product', productId: 'product-1', accountingDate: '2026-07-13', categoryCode: 'revenue', amountSigned: '10.0000' }
    ],
    taxSetting: { regimeCode: 'usn_income', usnRateFraction: '0.06', vatMode: 'standard' }
  });
  assert.equal(result.quality, 'partial');
  assert.deepEqual(result.missingReasons, ['tax_selected_reference_only', 'vat_method_unsupported']);
  assert.equal(result.totals.availableResultBeforeTax, '10.0000');
  assert.equal(result.totals.availableResultAfterTax, null);
  assert.equal(result.totals.netProfit, null);
});

test('seller-defined USN reference uses selected SKU sale less return and effective-dated rates', () => {
  const sourceRows = [
    { id:'a', productId:'sku-1', accountingDate:'2026-09-14', docTypeName:'Продажа', sellerOperName:'Продажа', retailAmount:'100.00' },
    { id:'b', productId:'sku-1', accountingDate:'2026-09-15', docTypeName:'Возврат', sellerOperName:'Возврат', retailAmount:'20.00' },
    { id:'c', productId:'sku-2', accountingDate:'2026-09-16', docTypeName:'Продажа', sellerOperName:'Продажа', retailAmount:'50.00' },
    { id:'d', productId:'unselected', accountingDate:'2026-09-16', docTypeName:'Продажа', sellerOperName:'Продажа', retailAmount:'999.00' }
  ];
  const taxSettings = [
    { id:'rate-6', effectiveFrom:'2026-01-01', regimeCode:'usn_income', usnRateFraction:'0.06000000000000000000' },
    { id:'rate-5', effectiveFrom:'2026-09-16', regimeCode:'usn_income', usnRateFraction:'0.05' }
  ];
  const selectedProductIds=['sku-1','sku-2'];
  const result = calculateStoreTaxReference({periodStart:'2026-09-14',periodEnd:'2026-09-20',selectedProductIds,sourceRows,taxSettings});
  assert.equal(result.scope,'selected_products');
  assert.equal(result.quality,'complete');
  assert.equal(result.taxableBase,'130.0000');
  assert.equal(result.estimatedTax,'7.3000');
  assert.deepEqual(result.products.map(row=>[row.productId,row.taxableBase,row.estimatedTax]),[['sku-1','80.0000','4.8000'],['sku-2','50.0000','2.5000']]);
  assert.deepEqual(result.segments.map(row=>[row.productId,row.taxSettingVersionId,row.taxableBase]),[
    ['sku-1','rate-6','80.0000'],['sku-1','rate-5','0.0000'],['sku-2','rate-6','0.0000'],['sku-2','rate-5','50.0000']
  ]);
  assert.deepEqual(calculateStoreTaxReference({periodStart:'2026-09-14',periodEnd:'2026-09-20',selectedProductIds:[...selectedProductIds].reverse(),sourceRows:[...sourceRows].reverse(),taxSettings:[...taxSettings].reverse()}),result);
});

test('PostgreSQL-padded tax rates keep exact bounds and reject significant extra precision', () => {
  const input={periodStart:'2026-09-14',periodEnd:'2026-09-20',selectedProductIds:['sku-1'],sourceRows:[{id:'sale',productId:'sku-1',accountingDate:'2026-09-14',docTypeName:'Продажа',sellerOperName:'Продажа',retailAmount:'100'}]};
  const atRate=rate=>calculateStoreTaxReference({...input,taxSettings:[{id:'rate',effectiveFrom:'2026-01-01',regimeCode:'usn_income',usnRateFraction:rate}]});
  assert.equal(atRate('0.00000000000000000000').estimatedTax,'0.0000');
  assert.equal(atRate('1.00000000000000000000').estimatedTax,'100.0000');
  assert.throws(()=>atRate('0.06000000000000000001'),/calculation_invalid_tax_rate/);
});

test('unsupported rows, missing rates and incomplete coverage prevent a misleading tax amount', () => {
  const base = {periodStart:'2026-09-14',periodEnd:'2026-09-20',selectedProductIds:['sku-1'],taxSettings:[{id:'r',effectiveFrom:'2026-09-15',regimeCode:'usn_income',usnRateFraction:'0.06'}]};
  const result=calculateStoreTaxReference({...base,sourceRows:[
    {id:'early',productId:'sku-1',accountingDate:'2026-09-14',docTypeName:'Продажа',sellerOperName:'Продажа',retailAmount:'100'},
    {id:'other',productId:'sku-1',accountingDate:'2026-09-16',docTypeName:'Иное',sellerOperName:'Иное',retailAmount:'20'}
  ],reportCoverageComplete:false});
  assert.equal(result.quality,'partial');
  assert.equal(result.estimatedTax,null);
  assert.deepEqual(result.missingReasons,['report_coverage_incomplete','tax_setting_missing','tax_source_unverified']);
});

test('persistable selected-SKU tax is deducted once while before-tax total remains unchanged',()=>{
  const sourceRows=[{id:'component-1',productId:'product-1',accountingDate:'2026-07-13',docTypeName:'Продажа',sellerOperName:'Продажа',retailAmount:'100'}];
  const taxSettings=[{id:'setting-1',effectiveFrom:'2026-01-01',regimeCode:'usn_income',usnRateFraction:'0.06'}];
  const taxReference=calculateStoreTaxReference({periodStart:'2026-07-13',periodEnd:'2026-07-19',selectedProductIds:['product-1'],sourceRows,taxSettings});
  const result=calculateFinancialResult({periodStart:'2026-07-13',periodEnd:'2026-07-19',selectedProductIds:['product-1'],
    financialComponents:[{id:'component-1',classificationStatus:'confirmed',scopeCode:'selected_product',productId:'product-1',accountingDate:'2026-07-13',categoryCode:'revenue',amountSigned:'100'}],
    taxSetting:{regimeCode:'usn_income',usnRateFraction:'0.06',vatMode:'exempt'},taxReference});
  assert.equal(result.quality,'complete');
  assert.deepEqual(result.lines.map(row=>[row.categoryCode,row.amountSigned]),[['revenue','100.0000'],['estimated_usn_tax','-6.0000']]);
  assert.deepEqual(result.totals,{selectedProductsResultBeforeTax:'100.0000',storeLevelResultBeforeTax:'0.0000',availableResultBeforeTax:'100.0000',estimatedUsnTax:'6.0000',availableResultAfterTax:'94.0000',netProfit:null});
});

test('complete report proves zero tax while a voided effective boundary never falls back',()=>{
  const base={periodStart:'2026-07-13',periodEnd:'2026-07-19',selectedProductIds:['product-1'],sourceRows:[
    {id:'sale',productId:'product-1',accountingDate:'2026-07-13',docTypeName:'Продажа',sellerOperName:'Продажа',retailAmount:'100'},
    {id:'return',productId:'product-1',accountingDate:'2026-07-14',docTypeName:'Возврат',sellerOperName:'Возврат',retailAmount:'100'}
  ]};
  const zero=calculateStoreTaxReference({...base,taxSettings:[{id:'active',effectiveFrom:'2026-01-01',regimeCode:'usn_income',usnRateFraction:'0.06'}]});
  assert.equal(zero.usable,true);
  assert.deepEqual(zero.products,[{productId:'product-1',taxableBase:'0.0000',estimatedTax:'0.0000'}]);
  const voided=calculateStoreTaxReference({...base,taxSettings:[
    {id:'active',effectiveFrom:'2026-01-01',regimeCode:'usn_income',usnRateFraction:'0.06'},
    {id:'voided',effectiveFrom:'2026-07-16',regimeCode:'usn_income',usnRateFraction:'0.06',state:'voided'}
  ]});
  assert.equal(voided.usable,false);
  assert.ok(voided.missingReasons.includes('tax_setting_missing'));
});

test('missing tax basis evidence never becomes a silent zero',()=>{
  const result=calculateStoreTaxReference({periodStart:'2026-07-13',periodEnd:'2026-07-19',selectedProductIds:['product-1'],sourceRows:[],
    taxSettings:[{id:'active',effectiveFrom:'2026-01-01',regimeCode:'usn_income',usnRateFraction:'0.06'}]});
  assert.equal(result.usable,false);
  assert.equal(result.estimatedTax,null);
  assert.ok(result.missingReasons.includes('tax_base_missing'));
});

test('every selected SKU needs its own tax basis evidence',()=>{
  const result=calculateStoreTaxReference({periodStart:'2026-07-13',periodEnd:'2026-07-19',selectedProductIds:['product-1','product-2'],
    sourceRows:[{id:'sale',productId:'product-1',accountingDate:'2026-07-13',docTypeName:'Продажа',sellerOperName:'Продажа',retailAmount:'100'}],
    taxSettings:[{id:'active',effectiveFrom:'2026-01-01',regimeCode:'usn_income',usnRateFraction:'0.06'}]});
  assert.equal(result.usable,false);
  assert.equal(result.estimatedTax,null);
  assert.ok(result.missingReasons.includes('tax_base_missing'));
});

test('missing tax setting does not invent missing VAT or tax base when retail evidence exists',()=>{
  const sourceRows=[{id:'sale',productId:'product-1',accountingDate:'2026-07-13',docTypeName:'Продажа',sellerOperName:'Продажа',retailAmount:'100'}];
  const taxReference=calculateStoreTaxReference({periodStart:'2026-07-13',periodEnd:'2026-07-19',selectedProductIds:['product-1'],sourceRows,taxSettings:[]});
  const result=calculateFinancialResult({periodStart:'2026-07-13',periodEnd:'2026-07-19',selectedProductIds:['product-1'],taxReference});
  assert.deepEqual(taxReference.missingReasons,['tax_setting_missing']);
  assert.deepEqual(result.missingReasons,['tax_setting_missing']);
});

test('unsupported VAT keeps persisted USN deduction but result remains partial',()=>{
  const sourceRows=[{id:'component-1',productId:'product-1',accountingDate:'2026-07-13',docTypeName:'Продажа',sellerOperName:'Продажа',retailAmount:'100'}];
  const taxReference=calculateStoreTaxReference({periodStart:'2026-07-13',periodEnd:'2026-07-19',selectedProductIds:['product-1'],sourceRows,
    taxSettings:[{id:'setting-1',effectiveFrom:'2026-01-01',regimeCode:'usn_income',usnRateFraction:'0.06'}]});
  const result=calculateFinancialResult({periodStart:'2026-07-13',periodEnd:'2026-07-19',selectedProductIds:['product-1'],
    financialComponents:[{id:'component-1',classificationStatus:'confirmed',scopeCode:'selected_product',productId:'product-1',accountingDate:'2026-07-13',categoryCode:'revenue',amountSigned:'100'}],
    taxSetting:{regimeCode:'usn_income',usnRateFraction:'0.06',vatMode:'general'},taxReference});
  assert.equal(result.quality,'partial');
  assert.deepEqual(result.missingReasons,['vat_method_unsupported']);
  assert.equal(result.totals.availableResultAfterTax,'94.0000');
  assert.equal(result.totals.netProfit,null);
});

test('unsupported VAT anywhere in the effective period remains visible after a later exemption',()=>{
  const sourceRows=[
    {id:'early',productId:'product-1',accountingDate:'2026-07-13',docTypeName:'Продажа',sellerOperName:'Продажа',retailAmount:'50'},
    {id:'late',productId:'product-1',accountingDate:'2026-07-17',docTypeName:'Продажа',sellerOperName:'Продажа',retailAmount:'50'}
  ];
  const taxReference=calculateStoreTaxReference({periodStart:'2026-07-13',periodEnd:'2026-07-19',selectedProductIds:['product-1'],sourceRows,taxSettings:[
    {id:'general',effectiveFrom:'2026-01-01',regimeCode:'usn_income',usnRateFraction:'0.06',vatMode:'general'},
    {id:'exempt',effectiveFrom:'2026-07-16',regimeCode:'usn_income',usnRateFraction:'0.06',vatMode:'exempt'}
  ]});
  assert.equal(taxReference.usable,true);
  assert.ok(taxReference.missingReasons.includes('vat_method_unsupported'));
  const result=calculateFinancialResult({periodStart:'2026-07-13',periodEnd:'2026-07-19',selectedProductIds:['product-1'],taxSetting:{regimeCode:'usn_income',vatMode:'exempt'},taxReference});
  assert.equal(result.quality,'partial');
  assert.ok(result.missingReasons.includes('vat_method_unsupported'));
  assert.equal(result.totals.availableResultAfterTax,'-6.0000');
});

test('selected sale with missing amount and unlinked sale suppress tax estimate', () => {
  const base={periodStart:'2026-09-14',periodEnd:'2026-09-20',selectedProductIds:['sku-1'],taxSettings:[{id:'r',effectiveFrom:'2026-01-01',regimeCode:'usn_income',usnRateFraction:'0.06'}]};
  const valid={id:'sale',productId:'sku-1',accountingDate:'2026-09-14',docTypeName:'Продажа',sellerOperName:'Продажа',retailAmount:'100'};
  const missing=calculateStoreTaxReference({...base,sourceRows:[valid,{...valid,id:'missing',retailAmount:null}]});
  assert.equal(missing.estimatedTax,null);
  assert.ok(missing.missingReasons.includes('tax_source_unverified'));
  const unlinked=calculateStoreTaxReference({...base,sourceRows:[valid,{...valid,id:'unlinked',productId:null,retailAmount:'10'}]});
  assert.equal(unlinked.estimatedTax,null);
  assert.ok(unlinked.missingReasons.includes('tax_source_unlinked'));
});

test('output is deterministic regardless of source order and aggregates evidence', () => {
  const components = [
    { id: 'b', classificationStatus: 'confirmed', scopeCode: 'selected_product', productId: 'product-1', accountingDate: '2026-07-13', categoryCode: 'revenue', amountSigned: '2.0000' },
    { id: 'a', classificationStatus: 'confirmed', scopeCode: 'selected_product', productId: 'product-1', accountingDate: '2026-07-13', categoryCode: 'revenue', amountSigned: '1.0000' }
  ];
  const input = { periodStart: '2026-07-13', periodEnd: '2026-07-19', selectedProductIds: ['product-1'] };
  const first = calculateFinancialResult({ ...input, financialComponents: components });
  const second = calculateFinancialResult({ ...input, financialComponents: [...components].reverse() });
  assert.deepEqual(first, second);
  assert.equal(first.lines[0].amountSigned, '3.0000');
  assert.deepEqual(first.lines[0].evidence.map(item => item.sourceId), ['a', 'b']);
});

test('duplicate sources and ambiguous effective cost versions are rejected instead of double counted', () => {
  const component = { id: 'same', classificationStatus: 'confirmed', scopeCode: 'store', accountingDate: '2026-07-13', categoryCode: 'storage', amountSigned: '-1.0000' };
  const base = { periodStart: '2026-07-13', periodEnd: '2026-07-19', selectedProductIds: ['product-1'] };
  assert.throws(
    () => calculateFinancialResult({ ...base, financialComponents: [component, component] }),
    /calculation_duplicate_source/
  );
  assert.throws(() => calculateFinancialResult({
    ...base,
    operations: [{ id: 'sale', operationType: 'sale', productId: 'product-1', variantId: 'variant-1', accountingDate: '2026-07-13', quantity: '1' }],
    costVersions: [
      { id: 'cost-a', variantId: 'variant-1', effectiveFrom: '2026-01-01', unitCost: '1.0000' },
      { id: 'cost-b', variantId: 'variant-1', effectiveFrom: '2026-01-01', unitCost: '2.0000' }
    ]
  }), /calculation_ambiguous_cost_version/);
});
