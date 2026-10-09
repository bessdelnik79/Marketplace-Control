import {randomUUID} from 'node:crypto';
import {decryptSecret} from '../../infrastructure/security/secrets.mjs';
import {storeOperationalSnapshot,removeOperationalSnapshot} from '../../infrastructure/storage/operational-source-storage.mjs';
import {decodeWbToken} from '../stores/wb.mjs';
import {loadWbOrderOutcomes} from './wb-order-outcomes.mjs';
import {createOrderOutcomeRepository} from './order-outcomes.repository.mjs';
import {pool as defaultPool} from '../../infrastructure/database/client.mjs';

const dayMs=86400000;
const day=now=>new Date(now.getTime()+3*3600000).toISOString().slice(0,10);
export function orderOutcomeRange(job,now){
  const end=day(now),start=new Date(Date.parse(end)-89*dayMs).toISOString().slice(0,10);
  const floor=Date.parse(`${start}T00:00:00+03:00`),dateFrom={};
  for(const kind of ['orders','sales']){
    const cursor=job.cursors?.[kind];
    const parsed=cursor?Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(cursor)?`${cursor}T00:00:00+03:00`:/Z$|[+-]\d{2}:\d{2}$/.test(cursor)?cursor:`${cursor}+03:00`):NaN;
    dateFrom[kind]=!job.reset&&Number.isFinite(parsed)?new Date(Math.max(floor,parsed-3600000)).toISOString():start;
  }
  return {dateFrom,sourceFrom:[...Object.values(dateFrom)].map(value=>value.length===10?value:day(new Date(value))).sort().at(-1),coverageEnd:end};
}
export function orderOutcomeErrorCode(error){
  const safe=new Set(['operational_interrupted','operational_unauthorized','operational_payment_required','operational_rate_limited','operational_refresh_forbidden','operational_connection_unavailable','operational_sync_superseded','operational_invalid_selection','operational_invalid_clock','operational_invalid_request','operational_invalid_result','operational_outcomes_unavailable','operational_outcomes_invalid_response','operational_outcomes_duplicate_conflict','operational_outcomes_too_large','operational_outcomes_cursor_stalled','operational_outcomes_page_limit','operational_storage_checksum_mismatch','operational_storage_unavailable','operational_storage_already_exists']);
  return safe.has(error?.message)?error.message:'operational_internal_error';
}
function wait(ms,signal){
  if(!Number.isFinite(ms)||ms<0)throw new Error('operational_invalid_request');
  signal.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const done=()=>{signal.removeEventListener('abort',abort);resolve();};
    const timer=setTimeout(done,ms);
    const abort=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);reject(new Error('operational_interrupted'));};
    signal.addEventListener('abort',abort,{once:true});
  });
}
export function createOrderOutcomeDispatcher({pool=defaultPool,dependencies={},clock=()=>new Date(),fetchImpl,sourceRoot,masterKey,logger=console}={}){
  const repository=createOrderOutcomeRepository({pool});
  const operations={...repository,decrypt:decryptSecret,load:loadWbOrderOutcomes,store:storeOperationalSnapshot,remove:removeOperationalSnapshot,randomUUID,wait,...dependencies};
  const storage={...(sourceRoot===undefined?{}:{root:sourceRoot}),...(masterKey===undefined?{}:{masterKey})};
  const active=new Map();let stopped=false,selecting=false;
  async function run(target,controller){
    let lease,job,batchId,wrote=false,committed=false,completeAttempted=false;
    try{
      lease=await operations.acquire(target);if(!lease)return;
      job=await operations.begin(lease,target,clock());if(!job)return;
      let decoded;
      try{decoded=decodeWbToken(operations.decrypt({ciphertext:job.ciphertext,nonce:job.nonce,authTag:job.auth_tag}));}catch{throw new Error('operational_unauthorized');}
      if(decoded.expiresAt<=clock()||decoded.isTest||!decoded.readOnly||![1,3].includes(decoded.accountType)||!decoded.scopes.includes('statistics')||decoded.sellerId!==String(job.seller_id))throw new Error('operational_unauthorized');
      const range=orderOutcomeRange(job,clock());
      const result=await operations.load(decoded.token,{dateFrom:range.dateFrom,clock,fetchImpl,signal:controller.signal,beforeRequest:async({endpoint})=>{
        controller.signal.throwIfAborted();lease.assertActive();
        const slot=await operations.reserve(lease,job,endpoint);await operations.wait(slot.waitMs,controller.signal);
        lease.assertActive();controller.signal.throwIfAborted();
        if(decoded.expiresAt<=clock())throw new Error('operational_unauthorized');
      }});
      controller.signal.throwIfAborted();lease.assertActive();
      batchId=operations.randomUUID();const objects=[];
      for(const [partNumber,page] of result.pages.entries()){
        const object=await operations.store({businessId:job.business_id,storeId:job.store_id,snapshotId:batchId,partNumber,raw:page.raw,checksum:page.checksum,...storage});
        wrote=true;objects.push({...object,endpoint:page.endpoint.endsWith('/sales')?'sales':'orders'});
      }
      controller.signal.throwIfAborted();lease.assertActive();
      completeAttempted=true;
      await operations.complete(lease,job,{batchId,result,objects,sourceFrom:range.sourceFrom,coverageEnd:range.coverageEnd,storage});committed=true;
    }catch(error){
      const code=orderOutcomeErrorCode(error);
      if(lease)await operations.fail(lease,target,code).catch(()=>{});
      logger.warn?.('sku_order_sync_failed',{storeId:target.store_id,errorCode:code});
    }finally{
      if(wrote&&!committed){
        let absent=!completeAttempted;
        if(completeAttempted){
          try{absent=await operations.hasBatch(target,batchId)===false;}catch{absent=false;}
        }
        if(absent)await operations.remove({businessId:target.business_id,storeId:target.store_id,snapshotId:batchId,...storage}).catch(()=>logger.warn?.('sku_order_cleanup_failed',{storeId:target.store_id}));
      }
      if(lease)await lease.release();
    }
  }
  return {
    async dispatch(){
      if(stopped||selecting||active.size>=2)return;
      selecting=true;
      try{
        const targets=await operations.candidates(2-active.size);
        for(const target of targets){
          if(stopped||active.size>=2)break;
          const key=`${target.business_id}:${target.store_id}`;if(active.has(key))continue;
          const controller=new AbortController();
          const promise=run(target,controller).catch(()=>logger.warn?.('sku_order_sync_failed',{storeId:target.store_id,errorCode:'operational_internal_error'})).finally(()=>active.delete(key));
          active.set(key,{controller,promise});
        }
      }finally{selecting=false;}
    },
    async stop(){stopped=true;for(const job of active.values())job.controller.abort();await Promise.allSettled([...active.values()].map(job=>job.promise));}
  };
}
