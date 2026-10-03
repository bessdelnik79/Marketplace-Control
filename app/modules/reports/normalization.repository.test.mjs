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
