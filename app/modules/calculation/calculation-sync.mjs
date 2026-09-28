import { acknowledgeFinancialCalculationInvalidation, getFinancialCompatibilityBootstrapState, listFinancialCalculationInvalidations, runFinancialCalculation, wakeFinancialDailyAfterCompatibility } from '../../db.mjs';

const expectedUnavailable = new Set([
  'calculation_store_unavailable',
  'calculation_selection_missing',
  'calculation_financial_inputs_missing',
  'calculation_period_coverage_incomplete',
  'calculation_method_missing'
]);

export function createFinancialCalculationWorker({
  list=listFinancialCalculationInvalidations,
  bootstrap=getFinancialCompatibilityBootstrapState,
  run=runFinancialCalculation,
  wakeDaily=wakeFinancialDailyAfterCompatibility,
  acknowledge=acknowledgeFinancialCalculationInvalidation
}={}){
  if(typeof list!=='function'||typeof bootstrap!=='function'||typeof run!=='function'||typeof wakeDaily!=='function'||typeof acknowledge!=='function')throw new TypeError('financial calculation worker dependencies are required');
  async function runOnce(){
    const pendingItems=await list();
    for(const pending of pendingItems){
      try{
        const state=await bootstrap(pending.requested_by,pending.store_id);
        if(!state.selectionReady)throw new Error('calculation_selection_missing');
        if(state.waitingForPipeline&&!state.targets?.length)continue;
        let result={requestId:null,runId:null,quality:null,changed:false};
        for(const targetPeriod of state.targets)result=await run(pending.requested_by,pending.store_id,{targetPeriod});
        if(state.targets.length)await wakeDaily(pending.requested_by,pending.store_id);
        await acknowledge(pending.requested_by,pending.store_id,pending.generation_token);
        console.info('[Financial compatibility calculation completed]',JSON.stringify({
          time:new Date().toISOString(),storeId:pending.store_id,requestId:result.requestId,
          runId:result.runId,quality:result.quality,changed:result.changed
        }));
      }catch(error){
        const code=String(error?.message??'calculation_failed').slice(0,100);
        const log=expectedUnavailable.has(code)?console.info:console.warn;
        log('[Financial compatibility calculation skipped or failed]',JSON.stringify({time:new Date().toISOString(),storeId:pending.store_id,error:code}));
      }
    }
    return pendingItems.length>0;
  }
  return{runOnce};
}

export function startFinancialCalculationWorker({runOnce,intervalMs=60000,onError=console.error}={}){
  if(typeof runOnce!=='function')throw new TypeError('runOnce is required');
  if(!Number.isInteger(intervalMs)||intervalMs<1000)throw new TypeError('intervalMs must be at least 1000');
  let active=false;
  const tick=async()=>{
    if(active)return;
    active=true;
    try{await runOnce();}catch(error){onError(error);}finally{active=false;}
  };
  void tick();
  const timer=setInterval(()=>void tick(),intervalMs);
  timer.unref?.();
  return()=>clearInterval(timer);
}
