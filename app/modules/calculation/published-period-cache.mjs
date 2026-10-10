import { AsyncLocalStorage } from 'node:async_hooks';

const publishedPeriodScope=new AsyncLocalStorage();
const identityFields=['businessId','storeId','publicationId','periodStart','periodEnd'];

function cacheIdentity(key){
  if(!key||identityFields.some(field=>typeof key[field]!=='string'||!key[field].trim()))return null;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(key.periodStart)||!/^\d{4}-\d{2}-\d{2}$/.test(key.periodEnd)||key.periodStart>key.periodEnd)return null;
  return JSON.stringify(identityFields.map(field=>key[field]));
}

export async function withPublishedPeriodCache(userId,action){
  const scope={userId,active:typeof userId==='string'&&!!userId.trim(),rows:new Map()};
  return publishedPeriodScope.run(scope,async()=>{
    try{return await action();}
    finally{scope.active=false;scope.rows.clear();}
  });
}

export function cacheDailyPeriodRows(key,rows){
  const scope=publishedPeriodScope.getStore(),identity=cacheIdentity(key);
  if(!scope?.active||!identity||!rows||['days','lines','reasons','taxFacts'].some(field=>!Array.isArray(rows[field])))return false;
  scope.rows.set(identity,structuredClone({days:rows.days,lines:rows.lines,reasons:rows.reasons,taxFacts:rows.taxFacts}));
  return true;
}

export function getCachedDailyPeriodRows(key){
  const scope=publishedPeriodScope.getStore(),identity=cacheIdentity(key);
  if(!scope?.active||!identity||!scope.rows.has(identity))return null;
  return structuredClone(scope.rows.get(identity));
}
