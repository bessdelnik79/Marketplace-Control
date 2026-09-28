import { randomUUID } from 'node:crypto';
import { decryptSecret } from '../../infrastructure/security/secrets.mjs';
import { removeFinancialDocument, storeFinancialPages } from '../../infrastructure/storage/source-storage.mjs';
import { assertWbFinancialToken, decodeWbToken } from '../stores/wb.mjs';
import { loadWbFinancialReportDetail } from './financial-detail.mjs';
import { financialRequestDelaySeconds, loadWbFinancialReports } from './finance.mjs';

const exactDate=value=>/^\d{4}-\d{2}-\d{2}$/.test(String(value??''))?String(value):null;
const terminalErrors=new Set([
  'financial_detail_invalid_request','financial_detail_invalid_response','financial_detail_invalid_cursor',
  'financial_detail_report_mismatch','financial_detail_period_mismatch','financial_detail_too_large',
  'financial_detail_unauthorized','financial_detail_payment_required',
  'financial_invalid_request','financial_invalid_response','financial_invalid_row','financial_invalid_cursor',
  'financial_too_large','financial_report_period_mismatch','financial_duplicate_row_conflict',
  'financial_unauthorized','financial_payment_required','financial_token_type_unsupported',
  'financial_pipeline_invalid_job','financial_normalize_invalid_source'
]);

export function financialPipelineErrorCode(error,fallback='financial_pipeline_internal_error'){
  const code=String(error?.message??'');
  return /^financial_[a-z0-9_]{1,99}$/.test(code)?code:fallback;
}

function retryDecision(error,errorCode){
  if(typeof error?.retryable==='boolean')return error.retryable;
  return !terminalErrors.has(errorCode);
}

function retryDelay(errorCode,random){
  if(errorCode==='financial_detail_rate_limited'||errorCode==='financial_rate_limited')return 300;
  if(errorCode==='financial_detail_empty')return 900;
  if(errorCode.endsWith('_unavailable'))return 120;
  try{return financialRequestDelaySeconds(random);}catch{return 900;}
}

function hasAttemptsLeft(job){
  return !Number.isInteger(job?.attempt_count)||!Number.isInteger(job?.max_attempts)||job.attempt_count<job.max_attempts;
}

function generation(job){
  const value=Number(job?.payload?.credentialGeneration);
  if(!Number.isSafeInteger(value)||value<1)throw new Error('financial_pipeline_invalid_job');
  return value;
}

function fetchTarget(job){
  const mode=job?.payload?.mode;
  const periodStart=exactDate(job?.payload?.periodStart);
  const periodEnd=exactDate(job?.payload?.periodEnd);
  if(!['by_report_id','period'].includes(mode)||!periodStart||!periodEnd||periodEnd<periodStart){
    throw new Error('financial_pipeline_invalid_job');
  }
  const reportId=job.payload.reportId;
  if(mode==='by_report_id'&&(typeof reportId!=='string'||!/^\d+$/.test(reportId))){
    throw new Error('financial_pipeline_invalid_job');
  }
  return {mode,periodStart,periodEnd,reportId:mode==='by_report_id'?reportId:null};
}

function lifecycle(jobs){
  return jobs?.claimJobs&&jobs?.heartbeatJob&&jobs?.completeJob&&jobs?.failJob;
}

export function createFinancialReportFetchWorker({
  jobs,
  repository,
  fetchImpl=fetch,
  wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),
  random=Math.random,
  workerId=`financial-pipeline:${process.pid}:fetch`,
  sourceRoot,
  masterKey,
  encryptionKey,
  storage={storeFinancialPages,removeFinancialDocument}
}={}){
  if(!lifecycle(jobs))throw new TypeError('job lifecycle is required');
  if(!repository?.getFetchContext||!repository?.reserveRequestSlot||!repository?.persistRaw||!repository?.fallbackToPeriod){
    throw new TypeError('financial pipeline repository is required');
  }
  if(!storage?.storeFinancialPages||!storage?.removeFinancialDocument)throw new TypeError('financial source storage is required');

  async function heartbeat(job){
    const alive=await jobs.heartbeatJob({jobId:job.id,leaseToken:job.lease_token,workerId,leaseSeconds:300});
    if(!alive)throw new Error('financial_pipeline_lease_lost');
  }

  async function beforeRequest(job,context){
    const slot=await repository.reserveRequestSlot(context.seller_id,financialRequestDelaySeconds(random));
    if(slot?.waitMs>0)await wait(slot.waitMs);
    await heartbeat(job);
  }

  async function completeFallback(job,credentialGeneration){
    const fallback=await repository.fallbackToPeriod(job.id,credentialGeneration,job.lease_token,workerId);
    await jobs.completeJob({
      jobId:job.id,leaseToken:job.lease_token,workerId,
      outcome:fallback?.superseded?'superseded':'completed'
    });
  }

  async function runOnce(){
    const [job]=await jobs.claimJobs({workerId,jobTypes:['financial_report_fetch'],leaseSeconds:300,limit:1});
    if(!job)return false;
    try{
      const credentialGeneration=generation(job);
      const target=fetchTarget(job);
      const context=await repository.getFetchContext(job.id,credentialGeneration,job.lease_token,workerId);
      if(!context){
        await jobs.completeJob({jobId:job.id,leaseToken:job.lease_token,workerId,outcome:'superseded'});
        return true;
      }
      if(target.mode==='by_report_id'&&context.detail_by_id_api==='unsupported_country'){
        await completeFallback(job,credentialGeneration);
        return true;
      }
      const token=decryptSecret({ciphertext:context.ciphertext,nonce:context.nonce,authTag:context.auth_tag},encryptionKey);
      assertWbFinancialToken(decodeWbToken(token));
      let loaded;
      try{
        loaded=target.mode==='by_report_id'
          ?await loadWbFinancialReportDetail(token,{
            reportId:target.reportId,periodStart:target.periodStart,periodEnd:target.periodEnd,fetchImpl,
            beforeRequest:()=>beforeRequest(job,context)
          })
          :await loadWbFinancialReports(token,{
            dateFrom:target.periodStart,dateTo:target.periodEnd,fetchImpl,
            beforeRequest:()=>beforeRequest(job,context)
          });
      }catch(error){
        if(target.mode==='by_report_id'&&error?.message==='financial_detail_unsupported_country'){
          await completeFallback(job,credentialGeneration);
          return true;
        }
        throw error;
      }
      if(target.mode==='by_report_id'&&loaded.reports.length!==1)throw new Error('financial_detail_invalid_response');
      const documentId=randomUUID();
      const stored=loaded.pages.length
        ?await storage.storeFinancialPages({
          businessId:context.business_id,storeId:context.store_id,documentId,pages:loaded.pages,
          root:sourceRoot,...(masterKey?{masterKey}:{})
        })
        :{objects:[]};
      let saved;
      try{
        saved=await repository.persistRaw(job.id,credentialGeneration,job.lease_token,workerId,{
          documentId,
          coverageId:job.payload.coverageId??null,
          inventoryChecksum:job.payload.inventoryChecksum??null,
          mode:target.mode,
          reportId:target.reportId,
          periodStart:target.periodStart,
          periodEnd:target.periodEnd,
          reports:loaded.reports,
          objects:stored.objects,
          pageCount:loaded.pageCount,
          rowCount:loaded.rows.length,
          finalRrdId:loaded.finalRrdId
        });
      }catch(error){
        await storage.removeFinancialDocument({
          businessId:context.business_id,storeId:context.store_id,documentId,root:sourceRoot
        }).catch(()=>{});
        throw error;
      }
      if(saved?.superseded){
        if(loaded.pages.length)await storage.removeFinancialDocument({
          businessId:context.business_id,storeId:context.store_id,documentId,root:sourceRoot
        }).catch(()=>{});
      }
      if(saved?.empty)throw new Error('financial_detail_empty');
      await jobs.completeJob({
        jobId:job.id,leaseToken:job.lease_token,workerId,
        outcome:saved?.superseded?'superseded':'completed'
      });
      return true;
    }catch(error){
      const errorCode=financialPipelineErrorCode(error,'financial_fetch_internal_error');
      const retryable=retryDecision(error,errorCode)&&hasAttemptsLeft(job);
      await repository.recordFailure?.(job.id,Number(job.payload?.credentialGeneration),job.lease_token,workerId,'financial_report_fetch',errorCode,!retryable).catch(()=>{});
      await jobs.failJob({
        jobId:job.id,leaseToken:job.lease_token,workerId,errorCode,
        retryable,retryDelaySeconds:retryDelay(errorCode,random)
      }).catch(()=>{});
      return true;
    }
  }

  return {runOnce};
}

export function createFinancialReportNormalizeWorker({
  jobs,
  repository,
  random=Math.random,
  workerId=`financial-pipeline:${process.pid}:normalize`
}={}){
  if(!lifecycle(jobs))throw new TypeError('job lifecycle is required');
  if(!repository?.normalize)throw new TypeError('financial pipeline repository is required');

  async function runOnce(){
    const [job]=await jobs.claimJobs({workerId,jobTypes:['financial_report_normalize'],leaseSeconds:300,limit:1});
    if(!job)return false;
    try{
      const result=await repository.normalize(job.id,job.lease_token,workerId);
      await jobs.completeJob({
        jobId:job.id,leaseToken:job.lease_token,workerId,
        outcome:result?.superseded?'superseded':'completed'
      });
    }catch(error){
      const errorCode=financialPipelineErrorCode(error,'financial_normalize_internal_error');
      const retryable=retryDecision(error,errorCode)&&hasAttemptsLeft(job);
      await repository.recordFailure?.(job.id,null,job.lease_token,workerId,'financial_report_normalize',errorCode,!retryable).catch(()=>{});
      await jobs.failJob({
        jobId:job.id,leaseToken:job.lease_token,workerId,errorCode,
        retryable,retryDelaySeconds:retryDelay(errorCode,random)
      }).catch(()=>{});
    }
    return true;
  }

  return {runOnce};
}

export function createFinancialPipelineWorker(options={}){
  const fetchWorker=createFinancialReportFetchWorker(options);
  const normalizeWorker=createFinancialReportNormalizeWorker(options);
  let next='fetch';
  async function runOnce(){
    const primary=next==='fetch'?fetchWorker:normalizeWorker;
    const secondary=next==='fetch'?normalizeWorker:fetchWorker;
    next=next==='fetch'?'normalize':'fetch';
    return await primary.runOnce()||await secondary.runOnce();
  }
  return {runOnce};
}

export function startFinancialPipelineWorker({runOnce,intervalMs=5000,onError=console.error}={}){
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
