import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
const url=process.env.STORE_SWITCH_INTEGRATION_DATABASE_URL;
if(!url||!new URL(url).pathname.endsWith('_test'))throw new Error('A disposable store switch test database is required');
process.env.DATABASE_URL=url;
const {pool}=await import('../../app/infrastructure/database/client.mjs');
const {registerUser,saveSession,deleteSession}=await import('../../app/modules/auth/auth.repository.mjs');
const {createSessionToken,hashPassword}=await import('../../app/modules/auth/auth.mjs');
const {token,tokenHash}=createSessionToken(),base=process.env.STORE_SWITCH_HTTP_BASE??'http://127.0.0.1:3807';
try{
 const user=await registerUser({name:'Store switch test',email:`${randomUUID()}@example.test`,passwordHash:await hashPassword(randomUUID())});
 const client=await pool.connect();try{
  await client.query('begin');await client.query("select set_config('app.user_id',$1,true)",[user.id]);
  const business=(await client.query('select business_id from mc.memberships where user_id=$1',[user.id])).rows[0].business_id;
  await client.query("select set_config('app.business_id',$1,true)",[business]);
  await client.query("update mc.subscriptions set plan_version_id=(select v.id from mc.billing_plan_versions v join mc.billing_plans p on p.id=v.plan_id where p.code='plus' order by v.version_no desc limit 1),period_end=now()+interval '1 month' where business_id=$1",[business]);
  await client.query('commit');
 }catch(error){await client.query('rollback');throw error;}finally{client.release();}
 await saveSession({userId:user.id,tokenHash,expiresAt:new Date(Date.now()+60000)});
 const headers={cookie:`mc_session=${token}`};
 async function create(name){
  const response=await fetch(`${base}/stores`,{method:'POST',redirect:'manual',headers:{...headers,origin:base,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({name})});
  assert.equal(response.status,303);const target=new URL(response.headers.get('location'),base);
  assert.equal(target.pathname,'/settings');assert.equal(target.hash,'#store');assert.ok(target.searchParams.get('storeId'));
  return target.searchParams.get('storeId');
 }
 const first=await create('Первый тестовый'),second=await create('Второй тестовый');assert.notEqual(first,second);
 for(const id of [second,first]){
  const response=await fetch(`${base}/settings?storeId=${id}`,{headers});assert.equal(response.status,200);const html=await response.text();
  assert.ok(html.includes(`data-store-id="${id}"`));assert.ok(html.includes(`name="storeId" value="${id}"`));
  assert.ok(html.includes(`href="/settings?storeId=${id}"`));assert.ok(html.includes('Создать новый магазин'));
  assert.equal(html.includes('Управление магазинами'),false);assert.equal(html.includes('Добавить магазин →'),false);
 }
 assert.equal((await fetch(`${base}/settings?storeId=${randomUUID()}`,{headers})).status,404);
 assert.equal((await fetch(`${base}/settings?storeId=${second}`,{redirect:'manual'})).status,303);
 const denied=await fetch(`${base}/stores`,{method:'POST',headers:{...headers,origin:'https://foreign.example','content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({name:'Denied store'})});assert.equal(denied.status,403);
 console.log('PASS: HTTP create selects the new store, switching changes the token form, foreign IDs and origins are rejected');
}finally{await deleteSession(tokenHash);await pool.end();}
