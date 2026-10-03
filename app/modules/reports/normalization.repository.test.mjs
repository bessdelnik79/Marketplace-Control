import test from 'node:test';
import assert from 'node:assert/strict';
import { persistFinancialNormalization,reconcileHistoricalCatalogLinks } from './normalization.repository.mjs';

test('normalization cache is scoped to the current catalog revision and preserves immutable evidence',async()=>{
  const calls=[];
  const client={async query(sql,args){
    calls.push({sql,args});
    if(sql.includes('select rv.document_id'))return{rows:[{document_id:'document',parser_version:'wb-finance-v13',external_report_id:'report',period_start:'2026-04-06',period_end:'2026-04-12'}]};
    if(sql.includes('select id from mc.method_versions'))return{rows:[{id:'method'}]};
    if(sql.includes('select id from mc.report_normalizations'))return{rows:[{id:'cached'}]};
    return{rows:[]};
  }};
  const result=await persistFinancialNormalization(client,{businessId:'business',storeId:'store',reportVersionId:'version',catalogRevision:'7'});
  assert.equal(result.cached,true);
  assert.deepEqual(calls.find(call=>call.sql.includes('select id from mc.report_normalizations')).args,['version','method','7']);
  assert.equal(calls.some(call=>/update mc.operation_versions|delete from|insert into mc.operation_versions/.test(call.sql)),false);
});

test('old rounded source cannot be relabeled as an exact normalization',async()=>{
  const calls=[];
  const client={async query(sql){calls.push(sql);return{rows:[{parser_version:'wb-finance-v12'}]};}};
  await assert.rejects(persistFinancialNormalization(client,{businessId:'business',storeId:'store',reportVersionId:'old',catalogRevision:1}),/financial_exact_source_required/);
  assert.equal(calls.length,1);
});

test('historical reconciliation with current saved normalization is idempotent',async()=>{
  const calls=[];
  const client={async query(sql,args){
    calls.push({sql,args});
    if(sql.includes('context_business_id'))return{rows:[{business_id:'business'}]};
    if(sql.includes('recover_historical_catalog'))return{rows:[{result:{catalogRevision:'3',changed:false}}]};
    return{rows:[]};
  }};
  const result=await reconcileHistoricalCatalogLinks(client,{businessId:'business',storeId:'store'});
  assert.equal(result.normalizedReports,0);
  assert.equal(calls.some(call=>call.sql.includes('emit_financial_input_event')),false);
  assert.deepEqual(calls.at(-1).args.slice(0,3),['business','store','3']);
});

async function normalizeVariant({raw={},products,variants}={}){
  const calls=[];
  const businessId='business',storeId='store',productId='product';
  products??=[{id:productId,businessId,storeId,wbArticle:'517676362'}];
  variants??=[{id:'size-variant',businessId,storeId,productId,sizeLabel:'0',status:'active',barcode:'correct-barcode'}];
  const rawData={nmId:'517676362',sku:'2048630844135',techSize:'0',docTypeName:'Продажа',sellerOperName:'Продажа',rrDate:'2026-04-06',quantity:1,...raw};
  const client={async query(sql,args){
    calls.push({sql,args});
    if(sql.includes('select rv.document_id'))return{rows:[{document_id:'document',parser_version:'wb-finance-v13',external_report_id:'report',period_start:'2026-04-06',period_end:'2026-04-12'}]};
    if(sql.includes('select id from mc.method_versions'))return{rows:[{id:'method'}]};
    if(sql.includes('insert into mc.report_normalizations'))return{rows:[{id:'normalization'}]};
    if(sql.includes('select id,external_row_key,raw_data'))return{rows:[{id:'row',external_row_key:'1',raw_data:rawData}]};
    if(sql.includes('select id from mc.products'))return{rows:products.filter(p=>p.businessId===args[0]&&p.storeId===args[1]&&p.wbArticle===args[2])};
    if(sql.includes('select v.id from mc.variants'))return{rows:variants.filter(v=>v.businessId===args[0]&&v.storeId===args[1]&&v.productId===args[2]&&v.barcode===args[3]).slice(0,1)};
    if(sql.includes('select id from mc.variants'))return{rows:variants.filter(v=>v.businessId===args[0]&&v.storeId===args[1]&&v.productId===args[2]&&v.status==='active'&&v.sizeLabel?.trim()===args[3]).slice(0,2)};
    if(sql.includes('insert into mc.operations('))return{rows:[{id:'operation'}]};
    if(sql.includes('coalesce(max(version_no)'))return{rows:[{n:1}]};
    if(sql.includes('insert into mc.operation_versions'))return{rows:[{id:'operation-version'}]};
    return{rows:[]};
  }};
  const result=await persistFinancialNormalization(client,{businessId,storeId,reportVersionId:'version',catalogRevision:'8'});
  return{calls,result,operation:calls.find(call=>call.sql.includes('insert into mc.operation_versions')).args,
    issues:calls.filter(call=>call.sql.includes('insert into mc.data_issues')).map(call=>({code:call.args[5],severity:call.args[6],details:JSON.parse(call.args[7])}))};
}

test('cross-product barcode falls back to the authoritative nmId product unique active size zero',async()=>{
  const variants=[
    {id:'wrong-product-variant',businessId:'business',storeId:'store',productId:'wrong-product',sizeLabel:'0',status:'active',barcode:'2048630844135'},
    {id:'correct-variant',businessId:'business',storeId:'store',productId:'product',sizeLabel:' 0 ',status:'active',barcode:'correct-barcode'}
  ];
  const original=structuredClone(variants);
  const {calls,operation,issues}=await normalizeVariant({variants,raw:{techSize:' 0 '}});
  assert.equal(operation[7],'product');
  assert.equal(operation[8],'correct-variant');
  assert.deepEqual(issues,[{code:'financial_variant_matched_by_size',severity:'warning',details:{wbArticle:'517676362',sourceBarcode:'2048630844135',sizeLabel:'0',variantId:'correct-variant'}}]);
  const sizeQuery=calls.find(call=>call.sql.includes('select id from mc.variants'));
  assert.deepEqual(sizeQuery.args,['business','store','product','0']);
  assert.match(sizeQuery.sql,/business_id=\$1 and store_id=\$2 and product_id=\$3 and status='active'/);
  assert.match(sizeQuery.sql,/btrim\(size_label\)=\$4 limit 2/);
  assert.equal(calls.some(call=>/\b(?:update|insert into|delete from) mc\.(?:variants|variant_identifiers|variant_costs)/.test(call.sql)),false);
  assert.deepEqual(variants,original);
});

test('exact barcode on the nmId product takes precedence over a different size match',async()=>{
  const {calls,operation,issues}=await normalizeVariant({variants:[
    {id:'exact-variant',businessId:'business',storeId:'store',productId:'product',sizeLabel:'M',status:'active',barcode:'2048630844135'},
    {id:'size-variant',businessId:'business',storeId:'store',productId:'product',sizeLabel:'0',status:'active',barcode:'other'}
  ]});
  assert.equal(operation[8],'exact-variant');
  assert.deepEqual(issues,[]);
  assert.equal(calls.some(call=>call.sql.includes('select id from mc.variants')),false);
});

test('ambiguous active sizes remain unmatched',async()=>{
  const {operation,issues}=await normalizeVariant({variants:['one','two'].map(id=>({id,businessId:'business',storeId:'store',productId:'product',sizeLabel:'0',status:'active'}))});
  assert.equal(operation[8],null);
  assert.deepEqual(issues.map(issue=>issue.code),['financial_variant_not_matched']);
});

test('missing or blank size never uses a single variant shortcut',async()=>{
  for(const techSize of [undefined,null,'','   ']){
    const {calls,operation,issues}=await normalizeVariant({raw:{techSize}});
    assert.equal(operation[8],null);
    assert.deepEqual(issues.map(issue=>issue.code),['financial_variant_not_matched']);
    assert.equal(calls.some(call=>call.sql.includes('select id from mc.variants')),false);
  }
});

test('size fallback accepts numeric zero and preserves return classification and quantity',async()=>{
  const {operation,issues}=await normalizeVariant({raw:{techSize:0,docTypeName:'Возврат',sellerOperName:'Возврат',quantity:2}});
  assert.equal(operation[6],'return');
  assert.equal(operation[8],'size-variant');
  assert.equal(operation[11],'-2');
  assert.equal(issues[0].code,'financial_variant_matched_by_size');
});

test('size fallback is restricted to sale and return on a matched product',async()=>{
  for(const raw of [{docTypeName:'',sellerOperName:'',deliveryService:1},{nmId:'0'},{nmId:'999'},{nmId:'invalid'}]){
    const {calls,operation,issues}=await normalizeVariant({raw});
    assert.equal(operation[8],null);
    assert.equal(issues.some(issue=>issue.code==='financial_variant_matched_by_size'),false);
    assert.equal(calls.some(call=>call.sql.includes('select id from mc.variants')),false);
  }
});

test('size fallback excludes other businesses, stores, products, archived variants and mismatched sizes',async()=>{
  const base={businessId:'business',storeId:'store',productId:'product',sizeLabel:'0',status:'active'};
  const variants=[{businessId:'other-business'},{storeId:'other-store'},{productId:'other-product'},{status:'archived'},{sizeLabel:'00'}].map((overrides,index)=>({...base,id:`excluded-${index}`,...overrides}));
  const {operation,issues}=await normalizeVariant({variants});
  assert.equal(operation[8],null);
  assert.deepEqual(issues.map(issue=>issue.code),['financial_variant_not_matched']);
  const matched=await normalizeVariant({variants:[...variants,{...base,id:'allowed'}]});
  assert.equal(matched.operation[8],'allowed');
});
