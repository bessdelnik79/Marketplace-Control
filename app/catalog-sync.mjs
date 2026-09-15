import{decryptSecret}from'./secrets.mjs';
import{beginCatalogSync,completeCatalogSync,failCatalogSync}from'./db.mjs';
import{loadWbCatalog}from'./catalog.mjs';

const activeJobs=new Set();
const safeCode=error=>['catalog_unauthorized','catalog_rate_limited','catalog_unavailable','catalog_invalid_response','catalog_too_large'].includes(error?.message)?error.message:'catalog_internal_error';

export function scheduleCatalogSync(userId,storeId,{force=false,fetchImpl=fetch}={}){
  const key=`${userId}:${storeId}`;
  if(activeJobs.has(key))return false;
  activeJobs.add(key);
  void(async()=>{
    let job;
    try{
      job=await beginCatalogSync(userId,storeId,{force});
      if(!job?.started)return;
      const token=decryptSecret({ciphertext:job.ciphertext,nonce:job.nonce,authTag:job.auth_tag});
      const catalog=await loadWbCatalog(token,{fetchImpl});
      const saved=await completeCatalogSync(userId,job,catalog);
      console.info('[WB catalog synced]',JSON.stringify({time:new Date().toISOString(),userId,storeId,products:saved.productCount,pages:catalog.pageCount}));
    }catch(error){
      const code=safeCode(error);
      if(job?.run_id)await failCatalogSync(userId,job,code).catch(()=>{});
      console.warn('[WB catalog failed]',JSON.stringify({time:new Date().toISOString(),error:code,wbStatus:error?.status,endpoint:error?.endpoint,userId,storeId}));
    }finally{activeJobs.delete(key);}
  })();
  return true;
}
