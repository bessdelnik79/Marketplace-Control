import assert from 'node:assert/strict';
import test from 'node:test';
import {accountErasureCsrf,createAccountErasureRoutes} from './account-erasure.routes.mjs';
import {hashToken} from './auth.mjs';

function fixture({credential={password_hash:'stored'},origin=true,allowed=true,error}={}){
  const deleted=[],verified=[],token='secret-session-token',data={csrf:accountErasureCsrf(token),confirmation:'УДАЛИТЬ',currentPassword:'correct'};
  const handler=createAccountErasureRoutes({getSessionToken:()=>token,getPasswordCredential:async()=>credential,
    verifyPassword:async(password)=>{verified.push(password);return password==='correct';},
    requestAccountErasure:async(...args)=>{deleted.push(args);if(error)throw Error(error);},takeLimit:async()=>({allowed}),
    form:async()=>data,sameOrigin:()=>origin,send:(res,status,body,headers)=>Object.assign(res,{status,body,headers}),
    redirect:(res,location,cookie)=>Object.assign(res,{location,cookie}),cookie:(token,max)=>`${token}:${max}`,
    accountErasurePage:(user,options)=>options});
  const call=async(method='POST',current={user_id:'user'})=>{const res={};await handler({method},res,new URL('http://localhost/account/delete'),current);return res;};
  return {call,data,deleted,verified,token};
}
test('deletion requires explicit confirmation, current password and session-bound CSRF',async()=>{
  const f=fixture();const res=await f.call();
  assert.equal(res.location,'/login?account=deleted');assert.equal(res.cookie,':0');
  assert.deepEqual(f.deleted,[['user',{sessionTokenHash:hashToken(f.token),expectedPasswordHash:'stored'}]]);
  for(const change of [{confirmation:''},{currentPassword:'wrong'},{csrf:'other-session'}]){
    const blocked=fixture();Object.assign(blocked.data,change);assert.ok([403,422].includes((await blocked.call()).status));assert.equal(blocked.deleted.length,0);
  }
});
test('GET, unauthenticated, cross-origin and rate-limited requests never delete',async()=>{
  const get=fixture();assert.equal((await get.call('GET')).headers['cache-control'],'no-store');assert.equal(get.deleted.length,0);
  for(const options of [{origin:false},{allowed:false}]){const f=fixture(options);assert.ok([403,429].includes((await f.call()).status));assert.equal(f.deleted.length,0);}
  const anonymous=fixture();assert.equal((await anonymous.call('POST',null)).location,'/login');assert.equal(anonymous.deleted.length,0);
});
test('OAuth deletion delegates recent-session proof and credential races fail closed',async()=>{
  const oauth=fixture({credential:null,error:'account_erasure_reauthentication_required'});
  assert.equal((await oauth.call()).status,409);assert.equal(oauth.verified.length,0);
  assert.equal(oauth.deleted[0][1].expectedPasswordHash,null);
  const race=fixture({error:'account_erasure_credential_changed'});assert.equal((await race.call()).status,409);
});
