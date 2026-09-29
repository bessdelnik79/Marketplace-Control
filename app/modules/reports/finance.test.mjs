import test from 'node:test';
import assert from 'node:assert/strict';
import { decimal, financialComponentScope, financialDateRange, financialHistoricalWeekRange, financialParserVersion, financialReportPeriodMatches, financialRequestDelaySeconds, isResolvedNonProductOperation, loadWbFinancialReports, normalizeFinancialOperation, normalizeFinancialReports, parseFinancialJson, unverifiedFinancialComponents } from './finance.mjs';

const row = (overrides = {}) => ({
  reportId: '90071992547409931', dateFrom: '2026-09-01', dateTo: '2026-09-07', createDate: '2026-09-08', currency: 'RUB',
  rrdId: '90071992547409941', nmId: '1234567', docTypeName: 'Продажа', sellerOperName: 'Продажа', rrDate: '2026-09-07',
  quantity: 1, retailAmount: '367.00', ...overrides
});

test('financial JSON keeps 64-bit WB identifiers as strings', () => {
  const parsed = parseFinancialJson('[{"reportId":90071992547409931,"rrdId":90071992547409941,"nmId":123}]');
  assert.deepEqual(parsed, [{ reportId: '90071992547409931', rrdId: '90071992547409941', nmId: '123' }]);
});

test('stored PostgreSQL dates match the same financial report calendar period', () => {
  const stored={period_start:new Date(2026,7,10),period_end:new Date(2026,7,16)};
  assert.equal(financialReportPeriodMatches(stored,{periodStart:'2026-08-10',periodEnd:'2026-08-16'}),true);
  assert.equal(financialReportPeriodMatches(stored,{periodStart:'2026-08-10',periodEnd:'2026-08-17'}),false);
  assert.equal(financialReportPeriodMatches({period_start:'2026-08-10',period_end:'2026-08-16'},{periodStart:'2026-08-10',periodEnd:'2026-08-16'}),true);
});

test('financial reports reserve every request and paginate by exact rrdId until 204', async () => {
  const bodies = [], reservations = [];
  const first = row(), second = row({ rrdId: '90071992547409999', reportId: '90071992547409932', dateFrom: '2026-09-08', dateTo: '2026-09-14' });
  const responses = [new Response(JSON.stringify([first])), new Response(JSON.stringify([second])), new Response(null, { status: 204 })];
  const result = await loadWbFinancialReports('token', {
    dateFrom: '2026-09-01', dateTo: '2026-09-15', limit: 1,
    fetchImpl: async (_url, options) => { bodies.push(options.body); return responses.shift(); },
    beforeRequest: async request => reservations.push(request)
  });
  assert.equal(result.pageCount, 2);
  assert.equal(result.reports.length, 2);
  assert.match(bodies[1], /"rrdId":90071992547409941/);
  assert.equal(reservations.length, 3);
  assert.deepEqual(reservations.map(request=>request.rrdId),['0','90071992547409941','90071992547409999']);
});

test('financial loader stops after the first rate limit response', async () => {
  let calls = 0;
  await assert.rejects(()=>loadWbFinancialReports('token', {
    dateFrom: '2026-09-01', dateTo: '2026-09-07',
    fetchImpl: async () => {
      calls++;
      return new Response('{}', { status: 429, headers: { 'retry-after': '2' } });
    }
  }),/financial_rate_limited/);
  assert.equal(calls,1);
});

test('financial request jitter is an integer from 65 through 75 seconds',()=>{
  assert.equal(financialRequestDelaySeconds(()=>0),65);
  assert.equal(financialRequestDelaySeconds(()=>0.999999),75);
  assert.throws(()=>financialRequestDelaySeconds(()=>1),/financial_invalid_random/);
});

test('normalization rejects changed duplicate rows and foreign currency', () => {
  assert.throws(() => normalizeFinancialReports([row(), row({ retailAmount: '368' })]), /financial_duplicate_row_conflict/);
  assert.throws(() => normalizeFinancialReports([row({ currency: 'USD' })]), /financial_invalid_row/);
});

test('financial decimals are canonical and never use floating point', () => {
  assert.equal(decimal('001.2300'), '1.23');
  assert.equal(decimal('-14.8900'), '-14.89');
  assert.equal(decimal('14.89', { negative: true }), '-14.89');
  assert.throws(() => decimal('NaN'), /financial_invalid_amount/);
});

test('financial date range uses a deterministic Moscow calendar date', () => {
  assert.deepEqual(financialDateRange(new Date('2026-09-15T22:30:00Z'), 7), { dateFrom: '2026-09-09', dateTo: '2026-09-16' });
});

test('historical deep check rotates complete Monday-Sunday weeks before recent overlap',()=>{
  assert.deepEqual(financialHistoricalWeekRange('2026-07-15','2026-09-16'),{dateFrom:'2026-07-13',dateTo:'2026-07-19'});
  assert.deepEqual(financialHistoricalWeekRange('2026-07-15','2026-09-16','2026-07-13'),{dateFrom:'2026-07-20',dateTo:'2026-07-26'});
  assert.deepEqual(financialHistoricalWeekRange('2026-07-15','2026-09-16','2026-09-07'),{dateFrom:'2026-07-13',dateTo:'2026-07-19'});
  assert.equal(financialHistoricalWeekRange('2026-09-15','2026-09-16'),null);
  assert.equal(financialHistoricalWeekRange(null,'2026-09-16'),null);
});

test('financial operation creates signed components without counting payout as revenue', () => {
  const operation = normalizeFinancialOperation(row({
    retailAmount: '1000', ppvzSalesCommission: '200', acquiringFee: '12.50', deliveryService: '70',
    paidStorage: '5', paidAcceptance: '3', penalty: '10', deduction: '4', additionalPayment: '20', forPay: '715.50'
  }));
  assert.equal(operation.operationType, 'sale');
  assert.deepEqual(Object.fromEntries(operation.components.map(component => [component.componentKey, component.amountSigned])), {
    retailAmount: '1000', ppvzSalesCommission: '-200', acquiringFee: '-12.5', deliveryService: '-70', paidStorage: '-5',
    paidAcceptance: '-3', penalty: '-10', deduction: '-4', additionalPayment: '-20', forPay: '715.5'
  });
  assert.equal(operation.components.find(component => component.componentKey === 'forPay').categoryCode, 'payout');
  assert.equal(operation.components.find(component => component.componentKey === 'additionalPayment').categoryCode, 'commission_adjustment');
});

test('return quantity and revenue are negative', () => {
  const operation = normalizeFinancialOperation(row({ docTypeName: 'Возврат', sellerOperName: 'Возврат', quantity: '2', retailAmount: '500' }));
  assert.equal(operation.operationType, 'return');
  assert.equal(operation.quantity, '-2');
  assert.equal(operation.components.find(component => component.categoryCode === 'revenue_return').amountSigned, '-500');
});

test('financial corrections preserve reversal direction and names containing return are not product returns', () => {
  const correction=normalizeFinancialOperation(row({docTypeName:'Продажа',sellerOperName:'Корректировка вознаграждения',deduction:'-4',additionalPayment:'-20'}));
  assert.equal(correction.operationType,'adjustment');
  assert.deepEqual(Object.fromEntries(correction.components.map(component=>[component.componentKey,component.amountSigned])),{deduction:'4',additionalPayment:'20'});
  const compensation=normalizeFinancialOperation(row({docTypeName:'Продажа',sellerOperName:'Добровольная компенсация при возврате',additionalPayment:'10'}));
  assert.equal(compensation.operationType,'adjustment');
  assert.equal(compensation.quantity,'1');
});

test('financial JSON preserves the lexical precision of every known monetary field',()=>{
  const parsed=parseFinancialJson('[{"rrdId":3135408992540,"retailAmount":500.0000,"vw":56.5360655737704918,"vwNds":12.108,"ppvzReward":0.004,"deliveryService":1.234567,"forPay":431.36,"quantity":1}]');
  assert.deepEqual(parsed,[{
    rrdId:'3135408992540',retailAmount:'500.0000',vw:'56.5360655737704918',vwNds:'12.108',ppvzReward:'0.004',deliveryService:'1.234567',forPay:'431.36',quantity:1
  }]);
});

test('negative delivery service is a verified global expense reversal without mutable WB labels',()=>{
  const source=row({retailAmount:null,docTypeName:'Изменяемый текст',sellerOperName:'Новое название WB',deliveryService:'-14.64'});
  const operation=normalizeFinancialOperation(source);
  const component=operation.components.find(item=>item.sourceField==='deliveryService');
  assert.equal(operation.operationType,'service_charge');
  assert.equal(component.categoryCode,'logistics');
  assert.equal(component.amountSigned,'14.64');
  assert.deepEqual(unverifiedFinancialComponents(source,operation,true),[]);
});

test('verified WB expense fields preserve source precision without floating point',()=>{
  const operation=normalizeFinancialOperation(row({vw:'12.5',vwNds:'2.5',ppvzReward:'3',rebillLogisticCost:'4',cashbackAmount:'5'}));
  assert.deepEqual(operation.components.filter(component=>['vw','vwNds','ppvzReward','rebillLogisticCost'].includes(component.componentKey)).map(({componentKey,categoryCode,amountSigned})=>({componentKey,categoryCode,amountSigned})),[
    {componentKey:'vw',categoryCode:'wb_reward_without_vat',amountSigned:'-12.5'},
    {componentKey:'vwNds',categoryCode:'wb_reward_vat',amountSigned:'-2.5'},
    {componentKey:'ppvzReward',categoryCode:'pickup_reward',amountSigned:'-3'},
    {componentKey:'rebillLogisticCost',categoryCode:'rebill_logistic_compensation',amountSigned:'-4'}
  ]);
  assert.deepEqual(operation.components.find(component=>component.componentKey==='cashbackAmount'),{
    componentKey:'cashbackAmount',categoryCode:'unclassified_financial_field',amountSigned:'5',sourceField:'cashbackAmount'
  });
  const reversals=normalizeFinancialOperation(row({vw:'-12.505',vwNds:'-2.505',ppvzReward:'-3.005',rebillLogisticCost:'-4.005'}));
  assert.deepEqual(Object.fromEntries(reversals.components.filter(component=>['vw','vwNds','ppvzReward','rebillLogisticCost'].includes(component.sourceField)).map(component=>[component.sourceField,component.amountSigned])),{
    vw:'12.505',vwNds:'2.505',ppvzReward:'-3.005',rebillLogisticCost:'4.005'
  });
});

test('result components without a real item identifier use store scope regardless of operation name and sign', () => {
  assert.equal(financialParserVersion, 'wb-finance-v13');
  const cases = [
    ['deliveryService', 'Логистика', 'logistics'],
    ['deliveryService', 'Доставка', 'logistics'],
    ['deliveryService', 'Коррекция стоимости доставки', 'logistics'],
    ['paidStorage', 'Хранение', 'storage'],
    ['paidStorage', 'Коррекция хранения', 'storage'],
    ['paidAcceptance', 'Обработка товара', 'acceptance'],
    ['penalty', 'Штраф', 'penalty'],
    ['deduction', 'Удержание', 'deduction']
  ];
  for (const [field, name, category] of cases) {
    const source = row({ nmId: null, retailAmount: null, docTypeName: '', sellerOperName: name, [field]: '10' });
    const operation = normalizeFinancialOperation(source);
    const component = operation.components.find(value => value.sourceField === field);
    assert.equal(component.categoryCode, category);
    assert.equal(financialComponentScope(source, operation, component), 'store', `${field}/${name}`);
    assert.equal(financialComponentScope(source, operation, component, true), 'selected_product');
    for (const itemField of ['nmId', 'sku', 'saName', 'barcode']) {
      assert.equal(financialComponentScope({ ...source, [itemField]: '123' }, operation, component), 'product_expected', itemField);
    }
    assert.equal(financialComponentScope({ ...source, srid: 'transaction-id', shkId: '56877337290' }, operation, component), 'store');
    assert.equal(financialComponentScope({ ...source, docTypeName: 'Продажа' }, operation, component), 'store');
    assert.equal(financialComponentScope({ ...source, sellerOperName: 'Новая услуга' }, operation, component), 'store');
    assert.equal(financialComponentScope({ ...source, [field]: '-10' }, operation, component), 'store');
    assert.equal(financialComponentScope(source, { operationType: 'sale' }, component), 'store');
    assert.equal(financialComponentScope(source, operation, { ...component, categoryCode: 'unclassified_financial_field' }), 'product_expected');
  }
});

test('loyalty discount compensation is reference-only regardless of linkage, sign or operation label',()=>{
  for(const [raw,amountSigned] of [['2','2'],['-2','-2']]){
    const linked=row({nmId:'517676362',retailAmount:null,docTypeName:'Продажа',sellerOperName:'Компенсация скидки по программе лояльности',cashbackDiscount:raw});
    const linkedOperation=normalizeFinancialOperation(linked);
    const linkedComponent=linkedOperation.components.find(component=>component.sourceField==='cashbackDiscount');
    assert.equal(linkedOperation.operationType,'adjustment');
    assert.equal(linkedComponent.categoryCode,'loyalty_discount_reference');
    assert.equal(linkedComponent.amountSigned,amountSigned);
    assert.equal(financialComponentScope(linked,linkedOperation,linkedComponent),'reconciliation');
    assert.deepEqual(unverifiedFinancialComponents(linked,linkedOperation,false),[]);
    assert.equal(financialComponentScope(linked,linkedOperation,linkedComponent,true),'reconciliation');
    assert.deepEqual(unverifiedFinancialComponents(linked,linkedOperation,true),[]);

    const unlinked={...linked,nmId:0,sku:'',saName:'',barcode:''};
    const unlinkedOperation=normalizeFinancialOperation(unlinked);
    const unlinkedComponent=unlinkedOperation.components.find(component=>component.sourceField==='cashbackDiscount');
    assert.equal(unlinkedComponent.categoryCode,'loyalty_discount_reference');
    assert.equal(unlinkedComponent.amountSigned,amountSigned);
    assert.equal(financialComponentScope(unlinked,unlinkedOperation,unlinkedComponent),'reconciliation');
    assert.deepEqual(unverifiedFinancialComponents(unlinked,unlinkedOperation,false),[]);
    assert.equal(isResolvedNonProductOperation(unlinked,unlinkedOperation,false),true);
  }
  const other=row({nmId:0,retailAmount:null,docTypeName:'Продажа',sellerOperName:'Иная компенсация',cashbackDiscount:'2'});
  const otherOperation=normalizeFinancialOperation(other);
  assert.equal(otherOperation.components.find(component=>component.sourceField==='cashbackDiscount').categoryCode,'loyalty_discount_reference');
  assert.equal(financialComponentScope(other,otherOperation,otherOperation.components.find(component=>component.sourceField==='cashbackDiscount')),'reconciliation');
  assert.deepEqual(unverifiedFinancialComponents(other,otherOperation,false),[]);
  const linkedOther={...other,nmId:'517676362'};
  assert.equal(isResolvedNonProductOperation(linkedOther,normalizeFinancialOperation(linkedOther),true),true);
  const wrongDocument=row({nmId:0,retailAmount:null,docTypeName:'Возврат',sellerOperName:'Компенсация скидки по программе лояльности',cashbackDiscount:'2'});
  const wrongDocumentOperation=normalizeFinancialOperation(wrongDocument);
  assert.equal(wrongDocumentOperation.components.find(component=>component.sourceField==='cashbackDiscount').categoryCode,'loyalty_discount_reference');
  assert.deepEqual(unverifiedFinancialComponents(wrongDocument,wrongDocumentOperation,false),[]);
  const unexpectedRetail=row({nmId:'517676362',retailAmount:'100',docTypeName:'Продажа',sellerOperName:'Компенсация скидки по программе лояльности',cashbackDiscount:'2'});
  const unexpectedRetailOperation=normalizeFinancialOperation(unexpectedRetail);
  assert.deepEqual(unverifiedFinancialComponents(unexpectedRetail,unexpectedRetailOperation,true),['retailAmount']);
});

test('additional payment without item linkage is a store result for charge and reversal',()=>{
  for(const [raw,amountSigned] of [['1458.34','-1458.34'],['-1458.34','1458.34']]){
    const source=row({nmId:0,sku:'',saName:'',barcode:'',retailAmount:null,docTypeName:'',sellerOperName:'Любое основание',additionalPayment:raw});
    const operation=normalizeFinancialOperation(source);
    const component=operation.components.find(item=>item.sourceField==='additionalPayment');
    assert.equal(component.categoryCode,'commission_adjustment');
    assert.equal(component.amountSigned,amountSigned);
    assert.equal(financialComponentScope(source,operation,component),'store');
    assert.deepEqual(unverifiedFinancialComponents(source,operation,false),[]);
    const linked={...source,nmId:'517676362'};
    const linkedOperation=normalizeFinancialOperation(linked);
    const linkedComponent=linkedOperation.components.find(item=>item.sourceField==='additionalPayment');
    assert.equal(financialComponentScope(linked,linkedOperation,linkedComponent),'product_expected');
    assert.deepEqual(unverifiedFinancialComponents(linked,linkedOperation,false),['additionalPayment']);
  }
});

test('an unrecognized operation name is resolved when every component is a known store or reconciliation field',()=>{
  const source=row({nmId:0,retailAmount:null,docTypeName:'',sellerOperName:'Новое основание',vw:'10'});
  const operation=normalizeFinancialOperation(source);
  assert.equal(operation.operationType,'unclassified');
  assert.equal(isResolvedNonProductOperation(source,operation,false),true);
  const unknown={...source,cashbackDiscount:'3'};
  assert.equal(isResolvedNonProductOperation(unknown,normalizeFinancialOperation(unknown),false),true);
  assert.equal(isResolvedNonProductOperation({...source,nmId:'517676362'},normalizeFinancialOperation({...source,nmId:'517676362'}),true),false);
});

test('zero sentinels do not create a product link for verified store storage',()=>{
  const source=row({nmId:0,sku:'000',saName:'',srid:null,shkId:'0',barcode:'',retailAmount:null,docTypeName:'',sellerOperName:'Хранение',paidStorage:'5.51'});
  const operation=normalizeFinancialOperation(source);
  assert.equal(operation.wbArticle,null);
  assert.equal(operation.variantBarcode,null);
  const storage=operation.components.find(component=>component.sourceField==='paidStorage');
  assert.equal(financialComponentScope(source,operation,storage),'store');
  assert.equal(financialComponentScope({...source,nmId:'517676362'},operation,storage),'product_expected');
});

test('verified WB promotion is a distinct store expense while generic deductions stay generic',()=>{
  const source=row({nmId:0,retailAmount:null,docTypeName:'',sellerOperName:'Удержание',bonusTypeName:'Оказание услуг «WB Продвижение», документ №315213683',deduction:'304'});
  const operation=normalizeFinancialOperation(source);
  const deduction=operation.components.find(component=>component.sourceField==='deduction');
  assert.equal(deduction.categoryCode,'promotion');
  assert.equal(financialComponentScope(source,operation,deduction),'store');
  const generic={...source,bonusTypeName:'Иная услуга'};
  assert.equal(normalizeFinancialOperation(generic).components.find(component=>component.sourceField==='deduction').categoryCode,'deduction');
  const similar={...source,bonusTypeName:'Оказание услуг «WB Продвижение», иной документ'};
  assert.equal(normalizeFinancialOperation(similar).components.find(component=>component.sourceField==='deduction').categoryCode,'deduction');
  const linked={...source,nmId:'517676362'};
  assert.equal(normalizeFinancialOperation(linked).components.find(component=>component.sourceField==='deduction').categoryCode,'deduction');
});

test('each exact PVZ source component is an independent store result without netting requirements',()=>{
  const source=row({nmId:0,sku:'',srid:'eAF.i9ad683fb4437520a3c2be26a00cb2b98.0.0',shkId:'56877337290',retailAmount:null,docTypeName:'Продажа',sellerOperName:'Возмещение за выдачу и возврат товаров на ПВЗ',ppvzReward:'16.2900',vw:'-13.3522',vwNds:'-2.9400'});
  const operation=normalizeFinancialOperation(source);
  assert.equal(operation.operationType,'other');
  assert.deepEqual(operation.components.map(component=>[component.sourceField,financialComponentScope(source,operation,component)]),[
    ['vw','store'],['vwNds','store'],['ppvzReward','store']
  ]);
  assert.deepEqual(operation.components.map(component=>[component.sourceField,component.amountSigned]),[
    ['vw','13.3522'],['vwNds','2.94'],['ppvzReward','-16.29']
  ]);
  assert.deepEqual(unverifiedFinancialComponents(source,operation,false),[]);
  const rewardOnly={...source,vw:null,vwNds:null};
  const rewardOperation=normalizeFinancialOperation(rewardOnly);
  assert.equal(rewardOperation.operationType,'other');
  assert.deepEqual(rewardOperation.components.map(component=>[component.sourceField,financialComponentScope(rewardOnly,rewardOperation,component)]),[['ppvzReward','store']]);
  const linked={...source,nmId:'517676362'};
  const linkedOperation=normalizeFinancialOperation(linked);
  assert.equal(linkedOperation.operationType,'unclassified');
  assert.deepEqual(unverifiedFinancialComponents(linked,linkedOperation,false),['ppvzReward','vw','vwNds']);
  assert.deepEqual(linkedOperation.components.map(component=>financialComponentScope(linked,linkedOperation,component,true)),['selected_product','selected_product','selected_product']);
  assert.deepEqual(unverifiedFinancialComponents(linked,linkedOperation,true),[]);
  const wrongSign={...rewardOnly,ppvzReward:'-16.29'};
  const wrongSignOperation=normalizeFinancialOperation(wrongSign);
  assert.equal(wrongSignOperation.components[0].amountSigned,'-16.29');
  assert.equal(financialComponentScope(wrongSign,wrongSignOperation,wrongSignOperation.components[0]),'store');
  assert.deepEqual(unverifiedFinancialComponents(wrongSign,wrongSignOperation,false),[]);
});

test('WB expense rows keep exact source values until result calculation',()=>{
  const samples=[
    row({rrdId:'1',vw:'1000.004',vwNds:'300.004',rebillLogisticCost:'100.235',ppvzReward:'200.004'}),
    row({rrdId:'2',vw:'870.735',vwNds:'111.545',ppvzReward:'3.375'})
  ];
  const totals=new Map();
  for(const source of samples){
    for(const component of normalizeFinancialOperation(source).components){
      if(!['vw','vwNds','rebillLogisticCost','ppvzReward'].includes(component.sourceField))continue;
      const prior=totals.get(component.sourceField)??0n;
      const negative=component.amountSigned.startsWith('-');
      const [whole,fraction='']=component.amountSigned.replace('-','').split('.');
      const millionths=BigInt(whole)*1000000n+BigInt(fraction.padEnd(6,'0'));
      totals.set(component.sourceField,prior+(negative?-millionths:millionths));
    }
  }
  assert.deepEqual(Object.fromEntries(totals),{
    vw:-1870739000n,vwNds:-411549000n,rebillLogisticCost:-100235000n,ppvzReward:-203379000n
  });
});

test('rebill logistic cost is retained for reconciliation without creating a result issue',()=>{
  const source=row({rebillLogisticCost:'100.235'});
  const operation=normalizeFinancialOperation(source);
  const component=operation.components.find(item=>item.sourceField==='rebillLogisticCost');
  assert.equal(component.amountSigned,'-100.235');
  assert.equal(financialComponentScope(source,operation,component,true),'reconciliation');
  assert.deepEqual(unverifiedFinancialComponents(source,operation,true),[]);
});

test('payout is retained only for reconciliation regardless of item linkage or sign',()=>{
  for(const raw of ['1458.34','-1458.34']){
    const source=row({nmId:0,retailAmount:null,docTypeName:'',sellerOperName:'Перечисление продавцу',forPay:raw});
    const operation=normalizeFinancialOperation(source);
    const component=operation.components.find(item=>item.sourceField==='forPay');
    assert.equal(financialComponentScope(source,operation,component),'reconciliation');
    assert.deepEqual(unverifiedFinancialComponents(source,operation,false),[]);
  }
});

test('settlement commission is retained only for reconciliation',()=>{
  const source=row({nmId:0,retailAmount:null,docTypeName:'',sellerOperName:'Удержание',ppvzSalesCommission:'3300.09'});
  const operation=normalizeFinancialOperation(source);
  const component=operation.components.find(item=>item.sourceField==='ppvzSalesCommission');
  assert.equal(financialComponentScope(source,operation,component),'reconciliation');
  assert.deepEqual(unverifiedFinancialComponents(source,operation,false),[]);
});

test('known result fields without item linkage use store scope while loyalty stays reference-only', () => {
  const source = row({ nmId: null, retailAmount: null, docTypeName: '', sellerOperName: 'Штраф', penalty: '10', ppvzReward: '2', cashbackDiscount: '3' });
  const operation = normalizeFinancialOperation(source);
  assert.deepEqual(operation.components.filter(component => financialComponentScope(source, operation, component) === 'store').map(component => component.sourceField), ['ppvzReward','penalty']);
  assert.equal(financialComponentScope(source,operation,operation.components.find(component=>component.sourceField==='cashbackDiscount')),'reconciliation');
  assert.deepEqual(unverifiedFinancialComponents(source,operation,false),[]);
});

test('unverified monetary fields and reverse signs are exposed for durable issues',()=>{
  const source=row({nmId:null,retailAmount:null,docTypeName:'',sellerOperName:'Штраф',penalty:'-10',ppvzReward:'2',cashbackDiscount:'3'});
  const operation=normalizeFinancialOperation(source);
  assert.deepEqual(unverifiedFinancialComponents(source,operation,false),[]);
  const verified=row({nmId:null,retailAmount:null,docTypeName:'',sellerOperName:'Штраф',penalty:'10'});
  assert.deepEqual(unverifiedFinancialComponents(verified,normalizeFinancialOperation(verified),false),[]);
});
