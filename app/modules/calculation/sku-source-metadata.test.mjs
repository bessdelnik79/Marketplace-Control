import test from 'node:test';
import assert from 'node:assert/strict';
import {applySkuSourceMetadata,completeSkuWeeks,loadSkuSourceMetadata} from './sku-source-metadata.mjs';
function sample(){return {items:[{productId:'p',quality:'complete',groups:[{groupKey:'revenue-p',categoryCode:'revenue',lineRefs:[{source:'daily',dailyResultId:'line',generationId:'old-generation',accountingDate:'2026-08-03'}]}]}],storeLines:[{groupKey:'storage',categoryCode:'storage',lineRefs:[]}]};}
test('metadata deduplicates report identities and sale quantity across repeated evidence',()=>{
  const model=sample(),base={group_key:'revenue-p',category_code:'revenue',report_id:'828181666',operation_id:'sale',operation_type:'sale',quantity:'2.000000',line_id:'line',line_amount:'100.0000',evidence_id:'proof',contribution_amount:'100.0000'};
  applySkuSourceMetadata(model,[base,base,{...base,group_key:'storage',report_id:'799960224'}]);
  assert.deepEqual(model.items[0].reportIds,['828181666']);assert.deepEqual(model.storeLines[0].reportIds,['799960224']);
  assert.equal(model.items[0].salesCount,2);assert.equal(model.items[0].returnsCount,0);
});
test('missing or partial quantity evidence is not a zero count',()=>{
  for(const rows of [[],[{group_key:'revenue-p',category_code:'revenue',operation_id:'sale',operation_type:'sale',quantity:'1',line_id:'line',line_amount:'100.0000',evidence_id:'proof',contribution_amount:'50.0000'}]]){
    const model=sample();applySkuSourceMetadata(model,rows);assert.equal(model.items[0].salesCount,null);assert.equal(model.items[0].returnsCount,null);
  }
});
test('only fully included Monday–Sunday weeks across years and months are returned',()=>{
  assert.deepEqual(completeSkuWeeks({start:'2026-08-01',end:'2026-08-31'}),[{start:'2026-08-03',end:'2026-08-09'},{start:'2026-08-10',end:'2026-08-16'},{start:'2026-08-17',end:'2026-08-23'},{start:'2026-08-24',end:'2026-08-30'}]);
  assert.deepEqual(completeSkuWeeks({start:'2025-12-29',end:'2026-01-04'}),[{start:'2025-12-29',end:'2026-01-04'}]);
  assert.deepEqual(completeSkuWeeks({start:'2026-08-04',end:'2026-08-08'}),[]);
});
test('batched metadata SQL binds exact owner/date and frozen report-normalization pair',async()=>{
  for(const source of ['daily','legacy']){
    const model=sample();if(source==='legacy')model.items[0].groups[0].lineRefs=[{source,runId:'run',resultLineId:'line',periodResultId:'period'}];
    let query;await loadSkuSourceMetadata({query:async(sql,args)=>{query={sql,args};return{rows:[]}}},{context:{storeId:'store',publication:{source}},model,businessId:'business'});
    assert.match(query.sql,/rn.report_version_id=rr.report_version_id/);assert.match(query.sql,/rn.status='succeeded'/);
    assert.match(query.sql,/i.report_normalization_id=o.report_normalization_id/);assert.match(query.sql,/rr.business_id=\$1 and rr.store_id=\$2/);
    assert.deepEqual(query.args.slice(0,2),['business','store']);assert.equal(JSON.parse(query.args[2])[0].owner,source==='daily'?'old-generation':'run');
    if(source==='daily')assert.match(query.sql,/i.generation_id=r.owner/);else assert.match(query.sql,/l.financial_period_result_id=r.period/);
  }
});
