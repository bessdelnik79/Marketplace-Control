import assert from 'node:assert/strict';
import test from 'node:test';
import { exactFinancialCutoverPlan,createFinancialPipelineRepository } from './financial-pipeline.repository.mjs';

test('superseded incoming report never restores catalog or consumes a tariff slot',async()=>{
  const statements=[];
  const client={release(){},async query(sql){
    statements.push(sql);
    if(sql.includes('establish_financial_pipeline_context'))return{rows:[{business_id:'business',store_id:'store',actor_user_id:'owner',payload:{reportVersionId:'incoming',coverageId:'coverage',inventoryChecksum:'checksum',expectedCurrentVersionId:'old'}}]};
    if(sql.includes('select rv.id,rv.status'))return{rows:[{id:'incoming',status:'received',external_report_id:'report',current_version_id:'newer'}]};
    if(sql.includes('select inventory_checksum,report_version_id'))return{rows:[{inventory_checksum:'checksum',report_version_id:'incoming'}]};
    if(sql.includes('select id from mc.method_versions'))return{rows:[{id:'method'}]};
    return{rows:[]};
  }};
  const repository=createFinancialPipelineRepository({pool:{query:client.query,async connect(){return client;}}});
  const result=await repository.normalize('job','lease','worker');
  assert.equal(result.superseded,true);
  assert.equal(statements.some(sql=>/recover_historical_catalog|insert into mc.report_normalizations|status='validated'/.test(sql)),false);
});

test('v30 cutover repair keys remain idempotent for one range and change when the full range expands',()=>{
  const base={storeId:'store-1',currentResultVersionNo:28,parserEventId:'parser-event',resultEventId:'result-event'};
  const first=exactFinancialCutoverPlan({...base,affectedFrom:'2026-09-21',affectedTo:'2026-09-27'});
  const repeated=exactFinancialCutoverPlan({...base,affectedFrom:'2026-09-21',affectedTo:'2026-09-27'});
  const expanded=exactFinancialCutoverPlan({...base,affectedFrom:'2025-11-24',affectedTo:'2026-09-27'});
  assert.deepEqual(repeated,first);
  assert.notEqual(expanded.resultEventKey,first.resultEventKey);
  assert.match(expanded.resultEventKey,/2025-11-24:2026-09-27/);
});

test('v30 cutover stops after the exact or a newer daily publication is current and skips an already covered parser event',()=>{
  assert.equal(exactFinancialCutoverPlan({storeId:'store-1',currentResultVersionNo:30,
    affectedFrom:'2025-11-24',affectedTo:'2026-09-27'}),null);
  assert.equal(exactFinancialCutoverPlan({storeId:'store-1',currentResultVersionNo:32,
    affectedFrom:'2025-11-24',affectedTo:'2026-09-27'}),null);
  const plan=exactFinancialCutoverPlan({storeId:'store-1',currentResultVersionNo:28,
    affectedFrom:'2025-11-24',affectedTo:'2026-09-27',parserEventId:'parser-event',parserEventCovers:true});
  assert.equal(plan.parserEventKey,null);
  assert.equal(plan.resultEventKey,'financial-result-upgrade:v30:store:store-1');
});
