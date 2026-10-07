import test from 'node:test';
import assert from 'node:assert/strict';
import {readSituationRevenueAbsence} from './situation-absence.repository.mjs';

const context={storeId:'store',publication:{source:'daily',id:'publication'},period:{start:'2026-08-01',end:'2026-08-31'},
  quality:'complete',coverage:{complete:true},scope:{productIds:['product']},method:{version:'financial-result-v36'}};
const input={context,item:{productId:'product',quality:'complete'},reconciliation:{status:'matched'}};
function client(row={sources_complete:true,sold_absent:true,returned_absent:true}){
  const calls=[];
  return {calls,async query(sql,args){calls.push({sql,args});return{rows:row?[row]:[]};}};
}
test('absence proof is bound to the immutable daily publication and does not use money as a proxy',async()=>{
  const db=client();
  const result=await readSituationRevenueAbsence(db,input);
  assert.deepEqual(result,{storeId:'store',productId:'product',period:context.period,publicationId:'publication',publicationSource:'daily',soldAbsent:true,returnedAbsent:true});
  assert.deepEqual(db.calls[0].args,['store','publication','2026-08-01','2026-08-31','product']);
  const sql=db.calls[0].sql;
  assert.match(sql,/mapped\.generation_id owner/);assert.match(sql,/o\.accounting_date=d\.accounting_date/);
  assert.match(sql,/rn\.report_version_id=rv\.id/);assert.match(sql,/rn\.method_version_id=g\.parser_method_version_id/);
  assert.match(sql,/financial_empty_week_evidence_valid/);assert.match(sql,/valid is not true/);
  assert.match(sql,/row_matches is not true/);assert.match(sql,/\(select count\(\*\) from days\)=/);
  assert.doesNotMatch(sql,/amount|current_version|current_publication|latest|insert|update|delete/i);
});
test('legacy absence reads frozen run inputs, never a current normalization',async()=>{
  const db=client();
  await readSituationRevenueAbsence(db,{...input,context:{...context,publication:{source:'legacy',id:'publication',runId:'run'}}});
  assert.equal(db.calls[0].args[1],'run');
  assert.match(db.calls[0].sql,/n\.run_id=\$2.*n\.report_normalization_id=rn\.id/);
  assert.match(db.calls[0].sql,/generate_series/);
  assert.doesNotMatch(db.calls[0].sql,/current_version|financial_empty_week_evidence_valid/);
});
test('partial coverage, unsupported scope or method and money mismatch never confirm zeros',async()=>{
  for(const changed of [{context:{...context,quality:'partial'}},{context:{...context,coverage:{complete:false}}},
    {context:{...context,scope:{productIds:['foreign']}}},{context:{...context,method:{version:'financial-result-v3'}}},
    {context:{...context,publication:{source:'legacy',id:'publication'}}},{item:{...input.item,quality:'partial'}},
    {reconciliation:{status:'mismatch'}}]){
    const db=client();
    assert.deepEqual(await readSituationRevenueAbsence(db,{...input,...changed}),{soldAbsent:false,returnedAbsent:false});
    assert.equal(db.calls.length,0);
  }
});
test('missing or invalid frozen sources cannot become absence; existing operations block each type independently',async()=>{
  for(const row of [null,{sources_complete:false,sold_absent:true,returned_absent:true},
    {sources_complete:null,sold_absent:true,returned_absent:true}])
    assert.deepEqual(await readSituationRevenueAbsence(client(row),input),{soldAbsent:false,returnedAbsent:false});
  const result=await readSituationRevenueAbsence(client({sources_complete:true,sold_absent:false,returned_absent:true}),input);
  assert.equal(result.soldAbsent,false);assert.equal(result.returnedAbsent,true);
});
