import assert from 'node:assert/strict';
import test from 'node:test';
import {createBillingRoutes} from './billing.routes.mjs';
function fixture({origin=true,error=null}={}){
  const calls=[];
  const handler=createBillingRoutes({requestTariff:async(...args)=>{calls.push(args);if(error)throw new Error(error);},
    listStores:async()=>[],getBillingSummary:async()=>({current:{code:'free'}}),tariffPage:(user,stores,billing,options)=>({billing,options}),
    sameOrigin:()=>origin,form:async()=>({plan:'plus'}),send:(res,status,body)=>Object.assign(res,{status,body}),redirect:(res,url)=>{res.location=url;}});
  return {handler,calls};
}
test('tariff choice persists intent while current access stays free',async()=>{
  const {handler,calls}=fixture(),res={};
  assert.equal(await handler({method:'POST'},res,new URL('http://localhost/tariff/select'),{user_id:'owner'}),true);
  assert.deepEqual(calls,[['owner','plus']]);assert.equal(res.body.billing.current.code,'free');assert.match(res.body.options.notice,/доступ не изменён/);
});
test('unauthenticated, cross-origin and viewer choices do not issue paid access',async()=>{
  for(const options of [{user:null},{origin:false,user:{user_id:'owner'}},{error:'tariff_write_forbidden',user:{user_id:'viewer'}}]){
    const {handler,calls}=fixture(options),res={};
    await handler({method:'POST'},res,new URL('http://localhost/tariff/select'),options.user);
    if(!options.user)assert.equal(res.location,'/login');else assert.equal(res.status,403);
    if(!options.error)assert.equal(calls.length,0);
  }
});
