import assert from 'node:assert/strict';
import test from 'node:test';
import { exactFinancialCutoverPlan } from './financial-pipeline.repository.mjs';

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
