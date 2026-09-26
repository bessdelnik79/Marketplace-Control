import { acknowledgeFinancialCalculationInvalidation, getFinancialCalculationInvalidation, runFinancialCalculation } from '../../db.mjs';

const activeJobs = new Map();
const expectedUnavailable = new Set([
  'calculation_store_unavailable',
  'calculation_selection_missing',
  'calculation_financial_inputs_missing',
  'calculation_period_coverage_incomplete',
  'calculation_method_missing'
]);

export function scheduleFinancialCalculation(userId, storeId, { onInputsMissing, targetPeriod = null } = {}) {
  const key = `${userId}:${storeId}`;
  const active = activeJobs.get(key);
  if (active) {
    active.rerun = true;
    active.onInputsMissing ??= onInputsMissing;
    active.nextTargetPeriod = targetPeriod ? active.nextTargetPeriod ?? targetPeriod : null;
    return false;
  }
  const state = { rerun: false, onInputsMissing, nextTargetPeriod: undefined };
  activeJobs.set(key, state);
  void getFinancialCalculationInvalidation(userId, storeId)
    .then(async invalidation => {
      const effectiveTarget=invalidation?null:targetPeriod;
      if(invalidation&&targetPeriod){
        state.rerun=true;
        state.nextTargetPeriod=targetPeriod;
      }
      const result=await runFinancialCalculation(userId, storeId,{targetPeriod:effectiveTarget});
      if(invalidation&&!effectiveTarget)await acknowledgeFinancialCalculationInvalidation(userId,storeId,invalidation.generation_token);
      return result;
    })
    .then(result => console.info('[Financial calculation completed]', JSON.stringify({
      time: new Date().toISOString(), userId, storeId, requestId: result.requestId,
      runId: result.runId, quality: result.quality, changed: result.changed
    })))
    .catch(error => {
      const code = String(error?.message ?? 'calculation_failed').slice(0, 100);
      if (code === 'calculation_financial_inputs_missing') state.onInputsMissing?.();
      const log = expectedUnavailable.has(code) ? console.info : console.warn;
      log('[Financial calculation skipped or failed]', JSON.stringify({
        time: new Date().toISOString(), userId, storeId, error: code
      }));
    })
    .finally(() => {
      activeJobs.delete(key);
      if (state.rerun) scheduleFinancialCalculation(userId, storeId, {
        onInputsMissing: state.onInputsMissing,
        targetPeriod: state.nextTargetPeriod ?? null
      });
    });
  return true;
}
