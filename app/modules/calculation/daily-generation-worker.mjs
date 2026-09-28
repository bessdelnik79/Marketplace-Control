const terminalErrors=new Set([
  'financial_daily_invalid_job','financial_daily_selection_missing','financial_daily_inputs_missing',
  'financial_daily_coverage_incomplete','financial_daily_method_missing','daily_generation_invalid_result',
  'daily_generation_invalid_period','daily_tax_evidence_missing','financial_daily_evidence_invalid',
  'financial_daily_publication_generation_not_succeeded','financial_daily_publication_watermark_stale',
  'financial_daily_publication_scope_incompatible','financial_daily_publication_missing'
]);

export function financialDailyErrorCode(error){
  const code=String(error?.message??'');
  if(/^(?:financial_daily|daily_generation|daily_tax)_[a-z0-9_]{1,80}$/.test(code))return code;
  const sqlState=String(error?.code??'').toLowerCase();
  if(/^[0-9a-z]{5}$/.test(sqlState))return`financial_daily_db_${sqlState}`;
  return'financial_daily_internal_error';
}

function attemptsRemain(job){return!Number.isInteger(job?.attempt_count)||!Number.isInteger(job?.max_attempts)||job.attempt_count<job.max_attempts;}

export function createFinancialDailyGenerationWorker({jobs,repository,workerId=`financial-daily:${process.pid}`,random=Math.random}={}){
  if(!jobs?.claimJobs||!jobs?.heartbeatJob||!jobs?.completeJob||!jobs?.failJob)throw new TypeError('job lifecycle is required');
  if(!repository?.build)throw new TypeError('daily generation repository is required');
  async function runOnce({heartbeatIntervalMs=60000}={}){
    const[job]=await jobs.claimJobs({workerId,jobTypes:['financial_dates_recalculate'],leaseSeconds:300,limit:1});
    if(!job)return false;
    let heartbeatTimer=null,heartbeatPromise=null,heartbeatFailure=null;
    const heartbeat=()=>{
      if(heartbeatPromise)return heartbeatPromise;
      heartbeatPromise=jobs.heartbeatJob({jobId:job.id,leaseToken:job.lease_token,workerId,leaseSeconds:300})
        .then(alive=>{if(!alive)heartbeatFailure=new Error('financial_daily_lease_lost');})
        .catch(error=>{heartbeatFailure=error;})
        .finally(()=>{heartbeatPromise=null;});
      return heartbeatPromise;
    };
    try{
      await heartbeat();
      if(heartbeatFailure)throw heartbeatFailure;
      heartbeatTimer=setInterval(()=>void heartbeat(),heartbeatIntervalMs);
      heartbeatTimer.unref?.();
      const result=await repository.build(job.id,job.lease_token,workerId);
      clearInterval(heartbeatTimer);heartbeatTimer=null;
      if(heartbeatPromise)await heartbeatPromise;
      if(heartbeatFailure)throw heartbeatFailure;
      await jobs.completeJob({jobId:job.id,leaseToken:job.lease_token,workerId,outcome:result?.superseded?'superseded':'completed'});
    }catch(error){
      if(heartbeatTimer)clearInterval(heartbeatTimer);
      if(heartbeatPromise)await heartbeatPromise;
      const errorCode=financialDailyErrorCode(error);
      const invalidDailyInput=errorCode.startsWith('daily_generation_')||errorCode.startsWith('daily_tax_');
      const databaseClass=errorCode.match(/^financial_daily_db_([0-9a-z]{2})/)?.[1];
      const retryableDatabase=databaseClass===undefined||['08','40','53','55'].includes(databaseClass);
      const retryable=!terminalErrors.has(errorCode)&&!invalidDailyInput&&retryableDatabase&&attemptsRemain(job);
      await jobs.failJob({
        jobId:job.id,leaseToken:job.lease_token,workerId,errorCode,retryable,
        retryDelaySeconds:retryable?Math.max(30,Math.round((2**Math.min(Number(job.attempt_count??1),8))*30*(0.8+random()*0.4))):0
      }).catch(()=>{});
    }
    return true;
  }
  return{runOnce};
}

export function startFinancialDailyGenerationWorker({runOnce,intervalMs=5000,onError=console.error}={}){
  if(typeof runOnce!=='function')throw new TypeError('runOnce is required');
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
