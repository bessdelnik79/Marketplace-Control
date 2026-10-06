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
 let business;
 async function scoped(action){
  const client=await pool.connect();try{
   await client.query('begin');await client.query("select set_config('app.user_id',$1,true)",[user.id]);
   business??=(await client.query('select business_id from mc.memberships where user_id=$1',[user.id])).rows[0].business_id;
   await client.query("select set_config('app.business_id',$1,true)",[business]);
   const result=await action(client);await client.query('commit');return result;
  }catch(error){await client.query('rollback');throw error;}finally{client.release();}
 }
 await saveSession({userId:user.id,tokenHash,expiresAt:new Date(Date.now()+300000)});
 const headers={cookie:`mc_session=${token}`};
 async function create(name){
  const response=await fetch(`${base}/stores`,{method:'POST',redirect:'manual',headers:{...headers,origin:base,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({name})});
  assert.equal(response.status,303);const target=new URL(response.headers.get('location'),base);
  assert.equal(target.pathname,'/settings');assert.equal(target.hash,'#store');assert.ok(target.searchParams.get('storeId'));
  return target.searchParams.get('storeId');
 }
 const first=await create('Первый тестовый');
 assert.equal((await fetch(`${base}/settings?storeId=${first}`,{headers})).status,200,'first paused store remains selectable during free onboarding');
 await scoped(async client=>{
  await client.query("update mc.stores set external_account_id=$2,status='active' where id=$1",[first,randomUUID()]);
  const catalog=(await client.query(`insert into mc.source_documents(business_id,store_id,origin,document_type,checksum,completeness)
   values($1,$2,'wb_api','catalog',$3,'complete') returning id`,[business,first,randomUUID()])).rows[0].id;
  const product=(await client.query(`insert into mc.products(business_id,store_id,wb_article,seller_article)
   values($1,$2,780001,'HTTP-FREE') returning id`,[business,first])).rows[0].id;
  await client.query('select mc.choose_tariff_profile_products($1,$2,$3::uuid[])',[first,catalog,[product]]);
  await client.query("select mc.apply_tariff_period($1,'plus',$2,clock_timestamp())",[business,randomUUID()]);
 });
 const second=await create('Второй тестовый');assert.notEqual(first,second);
 for(const id of [second,first]){
  const response=await fetch(`${base}/settings?storeId=${id}`,{headers});assert.equal(response.status,200);const html=await response.text();
  assert.ok(html.includes(`data-store-id="${id}"`));assert.ok(html.includes(`name="storeId" value="${id}"`));
  assert.ok(html.includes(`href="/settings?storeId=${id}"`));assert.equal(html.includes('Создать новый магазин'),false,'full paid store limit hides creation too');
  assert.equal(html.includes('Управление магазинами'),false);assert.equal(html.includes('Добавить магазин →'),false);
 }
 assert.equal((await fetch(`${base}/settings?storeId=${randomUUID()}`,{headers})).status,404);
 assert.equal((await fetch(`${base}/settings?storeId=${second}`,{redirect:'manual'})).status,303);
 const denied=await fetch(`${base}/stores`,{method:'POST',headers:{...headers,origin:'https://foreign.example','content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({name:'Denied store'})});assert.equal(denied.status,403);
 await scoped(client=>client.query("update mc.subscriptions set period_start='2020-01-01',period_end='2020-02-01' where business_id=$1",[business]));
 const freePage=await fetch(`${base}/settings?storeId=${first}`,{headers});assert.equal(freePage.status,200);
 const freeHtml=await freePage.text();
 assert.ok(freeHtml.includes('<strong>Второй тестовый</strong>'),'retained store remains visible in the header');
 assert.ok(freeHtml.includes('aria-disabled="true"><strong>Второй тестовый</strong>'));
 assert.equal(freeHtml.includes(`href="/settings?storeId=${second}"`),false,'expired paid store has no switching link');
 assert.equal(freeHtml.includes('Создать новый магазин'),false,'confirmed free slot cannot offer another store');
 for(const route of ['/','/settings','/products','/overview','/sku','/costs','/costs/template.csv','/financial-reports/status','/overview/financial-status','/overview/operational']){
  const response=await fetch(`${base}${route}?storeId=${second}`,{headers,redirect:'manual'});
  assert.equal(response.status,404,`inactive retained store must be denied at ${route}`);
 }
 async function retainedState(){return scoped(async client=>{
  const snapshot={};
  for(const table of ['jobs','connections','products','product_selections','product_selection_items','tariff_profile_stores','tariff_profile_products','operational_sync_targets','source_documents']){
   snapshot[table]=(await client.query(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb) rows from mc.${table} t where business_id=$1`,[business])).rows[0].rows;
  }
  return snapshot;
 });}
 const before=await retainedState();
 for(const [route,fields] of [['/catalog/sync',{returnTo:'/products'}],['/products/select',{productIds:randomUUID()}],['/connections/wb',{token:'invalid-token-must-never-be-verified'}],['/financial-reports/sync',{}]]){
  const response=await fetch(`${base}${route}`,{method:'POST',redirect:'manual',headers:{...headers,origin:base,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({storeId:second,...fields})});
  assert.equal(response.status,404,`inactive retained store must be denied before processing ${route}`);
 }
 assert.deepEqual(await retainedState(),before,'denied posts cannot alter retained data, credentials or scheduled jobs');
 await scoped(client=>client.query("select mc.apply_tariff_period($1,'plus',$2,clock_timestamp())",[business,randomUUID()]));
 for(const id of [first,second]){
  const response=await fetch(`${base}/settings?storeId=${id}`,{headers});assert.equal(response.status,200);
  assert.ok((await response.text()).includes(`href="/settings?storeId=${id}"`),'paid renewal restores saved store links');
 }
 console.log('PASS: HTTP switching supports paused onboarding, denies expired paid stores before reads and writes, and restores saved stores on renewal');
}finally{await deleteSession(tokenHash);await pool.end();}
