import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,access,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const databaseUrl=process.env.ACCOUNT_ERASURE_HTTP_INTEGRATION_DATABASE_URL;
if(!databaseUrl||!new URL(databaseUrl).pathname.toLowerCase().includes('test'))throw new Error('A disposable test database is required');
process.env.DATABASE_URL=databaseUrl;
const {pool,withOwnedBusinessContext}=await import('../../app/infrastructure/database/client.mjs');
const {findPasswordUser}=await import('../../app/modules/auth/auth.repository.mjs');
const {createAccountErasureWorker}=await import('../../app/modules/auth/account-erasure.worker.mjs');
const {cleanupAccountSourceData}=await import('../../app/infrastructure/storage/account-erasure-storage.mjs');
const {storeFinancialPages}=await import('../../app/infrastructure/storage/source-storage.mjs');
const root=await mkdtemp(path.join(os.tmpdir(),'mc-erasure-http-'));
const sourceRoot=path.join(root,'financial'),operationalRoot=path.join(root,'operational');
const port=Number(process.env.ACCOUNT_ERASURE_HTTP_PORT??31377),base=`http://127.0.0.1:${port}`;
const child=spawn(process.execPath,['app/server.mjs'],{env:{...process.env,PORT:String(port),NODE_ENV:'test',
  EMAIL_VERIFICATION_REQUIRED:'false',SOURCE_DATA_DIR:sourceRoot,OPERATIONAL_SOURCE_DATA_DIR:operationalRoot},stdio:['ignore','pipe','pipe']});
let startup='';child.stdout.on('data',data=>{startup+=data;});child.stderr.on('data',()=>{});
const exit=once(child,'exit');
const request=(route,{cookie='',data}={})=>fetch(base+route,{redirect:'manual',method:data?'POST':'GET',
  headers:{cookie,origin:base,...(data?{'content-type':'application/x-www-form-urlencoded'}:{})},body:data?new URLSearchParams(data):undefined});
const sessionCookie=response=>response.headers.get('set-cookie')?.split(';')[0];
try{
  for(let attempt=0;attempt<150&&!startup.includes('Marketplace Control:');attempt++){
    if(child.exitCode!==null)throw new Error('Isolated server failed to start');
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.equal((await request('/health')).status,200);
  const email=`erase-http-${randomUUID()}@example.test`,password='Test-account-password-123';
  const registration=await request('/register',{data:{name:'Delete HTTP test',email,password}});
  assert.equal(registration.status,303);const cookie=sessionCookie(registration);assert.ok(cookie);
  const user=await findPasswordUser(email);assert.ok(user);
  const store=await request('/stores',{cookie,data:{name:'HTTP fixture store'}});assert.equal(store.status,303);
  const {businessId,storeId}=await withOwnedBusinessContext(user.id,async(client,businessId)=>({businessId,
    storeId:(await client.query('select id from mc.stores where business_id=$1',[businessId])).rows[0].id}));
  for(const directory of [path.join(sourceRoot,businessId,storeId),path.join(operationalRoot,businessId,storeId)]){
    await mkdir(directory,{recursive:true});await writeFile(path.join(directory,'fixture'),'private-test-fixture');
  }
  const settings=await request('/settings',{cookie});assert.equal(settings.status,200);assert.match(await settings.text(),/href="\/account\/delete"/);
  const page=await request('/account/delete',{cookie});assert.equal(page.status,200);
  const html=await page.text(),csrf=html.match(/name="csrf" value="([a-f0-9]+)"/)?.[1];assert.ok(csrf);
  assert.match(html,/HTTP fixture store/);assert.doesNotMatch(html,/Магазинов пока нет|Очистка файлов исходников|Для защиты акций/);
  const payload={confirmation:'УДАЛИТЬ',currentPassword:password,csrf};
  assert.equal((await request('/account/delete',{cookie,data:{...payload,csrf:'forged'}})).status,403);
  assert.equal((await request('/account/delete',{cookie,data:{...payload,currentPassword:'wrong'}})).status,422);
  const deleted=await request('/account/delete',{cookie,data:payload});assert.equal(deleted.status,303);
  assert.equal(deleted.headers.get('location'),'/login?account=deleted');assert.match(deleted.headers.get('set-cookie'),/Max-Age=0/);
  assert.equal((await request('/settings',{cookie})).headers.get('location'),'/login');
  assert.equal(await findPasswordUser(email),null);
  await assert.rejects(storeFinancialPages({businessId,storeId,documentId:randomUUID(),pages:[],root:sourceRoot,masterKey:Buffer.alloc(32)}),/account_erasure_business_unavailable/);
  const worker=createAccountErasureWorker({cleanup:id=>cleanupAccountSourceData(id,{sourceRoot,operationalRoot})});
  assert.equal(await worker.runOnce(),true);await worker.stop();
  for(const directory of [path.join(sourceRoot,businessId),path.join(operationalRoot,businessId)])await assert.rejects(access(directory),{code:'ENOENT'});
  assert.equal((await request('/register',{data:{name:'Replacement',email,password}})).status,303);
  console.log('PASS: HTTP registration, confirmation/CSRF/password, erasure, revoked session, late-write rejection, durable cleanup and same-email registration');
}finally{
  child.kill('SIGTERM');await exit;await pool.end();await rm(root,{recursive:true,force:true});
}
