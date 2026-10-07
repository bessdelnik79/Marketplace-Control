import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile,readdir } from 'node:fs/promises';
import test from 'node:test';

const integrationUrl=process.env.CAMPAIGN_INTEGRATION_DATABASE_URL;
if(integrationUrl){
  if(!new URL(integrationUrl).pathname.toLowerCase().includes('test'))throw new Error('Campaign integration requires a disposable database whose name contains test');
  process.env.DATABASE_URL=integrationUrl;
}
process.env.CAMPAIGN_IDENTITY_HMAC_KEY=Buffer.alloc(32,9).toString('base64');
const {pool,migrate,withOwnedBusinessContext}=await import('../../app/infrastructure/database/client.mjs');
const {participateCampaign,bindActiveCampaignCabinet}=await import('../../app/modules/campaigns/campaigns.repository.mjs');
let local;
if(!integrationUrl){
  const {PGlite}=await import('../node_modules/@electric-sql/pglite/dist/index.js');
  local=new PGlite();
  pool.query=(sql,params)=>local.query(sql,params);
  pool.connect=async()=>({query:(sql,params)=>local.query(sql,params),release(){}});
  for(const name of (await readdir(new URL('../migrations/',import.meta.url))).filter(name=>/^\d+_.+\.sql$/.test(name)).sort()){
    await local.exec(await readFile(new URL(`../migrations/${name}`,import.meta.url),'utf8'));
  }
}else await migrate();

const prefix=`campaign-test-${randomUUID()}`;
let sequence=0;
const query=(sql,params=[])=>pool.query(sql,params);
async function account(email=`${prefix}-${sequence++}@example.test`,cabinets=[{id:`${prefix}-${sequence++}-default`}]){
  const id=randomUUID(),business=randomUUID();
  const client=await pool.connect();
  try{
    await client.query('begin');
    await client.query("select set_config('app.user_id',$1,true),set_config('app.business_id',$2,true)",[id,business]);
    await client.query(`insert into mc.users(id,display_name,email) values($1,'Campaign test',$2)`,[id,email]);
    await client.query(`insert into mc.businesses(id,name) values($1,'Campaign test')`,[business]);
    await client.query(`insert into mc.memberships(business_id,user_id) values($1,$2)`,[business,id]);
    await client.query(`select mc.apply_tariff_period($1,'plus',$2,now())`,[business,`${prefix}-fixture-${sequence++}`]);
    for(const cabinet of cabinets)await client.query(
      `insert into mc.stores(business_id,marketplace_code,external_account_id,name,identity_verified_at) values($1,$2,$3,'Cabinet',$4)`,
      [business,cabinet.marketplace??'wb',cabinet.id,cabinet.verified===false?null:new Date()]);
    await client.query('commit');
  }catch(error){await client.query('rollback');throw error;}finally{client.release();}
  return {id,business,email};
}
async function campaign({group=`${prefix}-${sequence++}`,enabled=true,scope='account',duration=3600,from=null,until=null,requireCabinet=true}={}){
  const code=`${prefix}-${sequence++}`;
  await query(`insert into mc_campaign_private.campaigns(code,eligibility_group,enabled,available_from,available_until,benefit_kind,benefit_parameters,benefit_scope,duration_seconds,require_verified_cabinet)
    values($1,$2,$3,$4,$5,'test-benefit','{"quantity":1}',$6,$7,$8)`,[code,group,enabled,from,until,scope,duration,requireCabinet]);
  return {code,group};
}
const join=(a,c,applyBenefit=async()=>{})=>participateCampaign(a.id,c.code,{applyBenefit});
const bind=(a,id,verified=true,marketplaceCode='wb')=>withOwnedBusinessContext(a.id,async(client,business)=>{
  await client.query('select id from mc.businesses where id=$1 for update',[business]);
  await bindActiveCampaignCabinet(client,business,{marketplaceCode,sellerId:id,verified});
  await client.query(`insert into mc.stores(business_id,marketplace_code,external_account_id,name,identity_verified_at)
    values($1,$2,$3,'New cabinet',$4)`,[business,marketplaceCode,id,verified?new Date():null]);
});

try{
  await test('campaign grant and mandatory benefit share one rollback boundary; retries preserve dates',async()=>{
    const a=await account(),c=await campaign();
    await assert.rejects(()=>participateCampaign(a.id,c.code),/campaign_benefit_callback_required/);
    await assert.rejects(()=>join(a,c,async client=>{await client.query(`update mc.businesses set name='Must roll back' where id=$1`,[a.business]);throw new Error('benefit_failed');}),/benefit_failed/);
    assert.equal((await query('select count(*)::int count from mc_campaign_private.claims where eligibility_group=$1',[c.group])).rows[0].count,0);
    assert.equal(await withOwnedBusinessContext(a.id,async client=>(await client.query('select name from mc.businesses where id=$1',[a.business])).rows[0].name),'Campaign test');
    let calls=0;
    const first=await join(a,c,async()=>{calls++;});
    const retry=await join(a,c,async()=>{calls++;});
    assert.equal(calls,1);assert.equal(retry.alreadyParticipated,true);
    assert.equal(first.claimId,retry.claimId);assert.deepEqual(first.benefitEndsAt,retry.benefitEndsAt);
    assert.equal(await withOwnedBusinessContext(a.id,async client=>(await client.query(`select g.benefit_starts_at=c.benefit_starts_at and g.benefit_ends_at=c.benefit_ends_at same
      from mc.campaign_grants g join mc_campaign_private.claims c on c.id=g.claim_id where g.business_id=$1`,[a.business])).rows[0].same),true);
    const sibling=await campaign({group:c.group});
    assert.equal((await join(a,sibling)).claimId,first.claimId);
    const independent=await campaign();assert.notEqual((await join(a,independent)).claimId,first.claimId);
  });
  await test('same email or any shared cabinet consumes group across accounts and campaign codes',async()=>{
    const cabinet=`${prefix}-shared`,other=`${prefix}-other`;
    const first=await account(undefined,[{id:cabinet},{id:other,marketplace:'ozon'}]),c=await campaign();
    await join(first,c);
    const sameEmail=await account(first.email),sameCabinet=await account(undefined,[{id:cabinet}]);
    await assert.rejects(()=>join(sameEmail,c),/campaign_already_consumed/);
    await assert.rejects(()=>join(sameCabinet,c),/campaign_already_consumed/);
    const otherCabinet=await account(undefined,[{id:other,marketplace:'ozon'}]);
    await assert.rejects(()=>join(otherCabinet,c),/campaign_already_consumed/);
    const differentMarketplace=await account(undefined,[{id:cabinet,marketplace:'future-marketplace'}]);
    await join(differentMarketplace,c);
    const changedCode=await campaign({group:c.group});
    await assert.rejects(()=>join(sameCabinet,changedCode),/campaign_already_consumed/);
  });
  await test('disabled, future, expired, missing-key and unverified claims are rejected without consumption',async()=>{
    const a=await account();
    for(const options of [{enabled:false},{from:new Date(Date.now()+86400000)},{until:new Date(Date.now()-86400000)}]){
      const c=await campaign(options);await assert.rejects(()=>join(a,c),/campaign_unavailable/);
    }
    const c=await campaign(),key=process.env.CAMPAIGN_IDENTITY_HMAC_KEY;
    const noCabinet=await account(undefined,[]);
    await assert.rejects(()=>join(noCabinet,c),/campaign_verified_cabinet_required/);
    delete process.env.CAMPAIGN_IDENTITY_HMAC_KEY;
    try{await assert.rejects(()=>join(a,c),/campaign_identity_key_unavailable/);await bind(a,`${prefix}-ordinary`,false);}finally{process.env.CAMPAIGN_IDENTITY_HMAC_KEY=key;}
    const unverified=await account(undefined,[{id:`${prefix}-unverified`,verified:false}]);
    await assert.rejects(()=>join(unverified,c),/campaign_cabinet_unverified/);
    await assert.rejects(()=>campaign({requireCabinet:false}),/check constraint/);
    const emailEvent=await campaign({scope:'event',requireCabinet:false});
    await join(noCabinet,emailEvent);
  });
  await test('active account benefit binds future cabinets atomically; event and expired benefits do not',async()=>{
    const c=await campaign(),old=await account(undefined,[{id:`${prefix}-used`}]),fresh=await account();
    await join(old,c);const grant=await join(fresh,c);
    await assert.rejects(()=>bind(fresh,`${prefix}-used`),/campaign_already_consumed/);
    await assert.rejects(()=>bind(fresh,`${prefix}-unverified-new`,false),/campaign_cabinet_unverified/);
    await bind(fresh,`${prefix}-new`);
    await withOwnedBusinessContext(fresh.id,client=>client.query(`update mc.stores set status='archived' where business_id=$1 and external_account_id<>$2`,[fresh.business,`${prefix}-new`]));
    await bind(fresh,`${prefix}-new-ozon`,true,'ozon');
    assert.equal((await query('select count(*)::int count from mc_campaign_private.subjects where claim_id=$1',[grant.claimId])).rows[0].count,4);
    const attacker=await account(undefined,[{id:`${prefix}-new`}]);await assert.rejects(()=>join(attacker,c),/campaign_already_consumed/);
    const event=await campaign({scope:'event'}),eventAccount=await account();await join(eventAccount,event);await bind(eventAccount,`${prefix}-event`,false);
    const expired=await campaign({duration:1}),expiredAccount=await account();await join(expiredAccount,expired);
    await withOwnedBusinessContext(expiredAccount.id,client=>client.query(`select set_config('app.business_id',$1,true)`,[expiredAccount.business]));
    if(local)await new Promise(resolve=>setTimeout(resolve,1100));else await query('select pg_sleep(1.1)');
    await bind(expiredAccount,`${prefix}-expired`,false);
  });
  await test('account erasure removes grant but immutable consumption survives re-registration',async()=>{
    const a=await account(undefined,[{id:`${prefix}-erased-cabinet`}]),c=await campaign();
    const grant=await join(a,c);
    await withOwnedBusinessContext(a.id,async client=>{
      await client.query(`insert into mc.auth_password_credentials(user_id,password_hash) values($1,'scrypt$16384$8$1$salt$hash')`,[a.id]);
      await client.query(`insert into mc.auth_sessions(user_id,token_hash,expires_at) values($1,$2,now()+interval '1 hour')`,[a.id,'f'.repeat(64)]);
      await client.query(`select mc.erase_account($1,$2,'scrypt$16384$8$1$salt$hash')`,[a.id,'f'.repeat(64)]);
    });
    assert.equal((await query('select count(*)::int count from mc_campaign_private.claims where id=$1',[grant.claimId])).rows[0].count,1);
    await assert.rejects(()=>query('delete from mc_campaign_private.subjects where claim_id=$1',[grant.claimId]),/campaign_evidence_immutable/);
    await assert.rejects(()=>join(a,c),/business_not_found/);
    const replacement=await account(a.email,[{id:`${prefix}-erased-cabinet`}]);
    await assert.rejects(()=>join(replacement,c),/campaign_already_consumed/);
  });
  await test('concurrent claims serialize shared cabinet and commit exactly one benefit',{skip:!integrationUrl},async()=>{
    const cabinet=`${prefix}-concurrent`,c=await campaign();
    const a=await account(undefined,[{id:cabinet}]),b=await account(undefined,[{id:cabinet}]);
    let rewards=0;const results=await Promise.allSettled([join(a,c,async()=>{rewards++;}),join(b,c,async()=>{rewards++;})]);
    assert.equal(results.filter(result=>result.status==='fulfilled').length,1);assert.equal(rewards,1);
    assert.match(results.find(result=>result.status==='rejected').reason.message,/campaign_already_consumed/);
  });
  await test('private evidence is inaccessible to tenant role; grants retain forced tenant isolation',async()=>{
    const a=await account(),b=await account(),c=await campaign();await join(a,c);await join(b,c);
    const role=`campaign_test_${randomUUID().replaceAll('-','')}`;
    await query(`create role ${role}`);
    await query(`grant ${role} to current_user`);
    await query(`grant usage on schema mc to ${role}`);
    await query(`grant select on mc.campaign_grants to ${role}`);
    await query(`grant execute on function mc.context_business_id() to ${role}`);
    const client=await pool.connect();
    try{
      await client.query('begin');
      await client.query(`set local role ${role}`);
      await client.query("select set_config('app.business_id',$1,true)",[a.business]);
      const visible=(await client.query('select business_id from mc.campaign_grants')).rows;
      assert.deepEqual(visible.map(row=>row.business_id),[a.business]);
      await assert.rejects(()=>client.query('select * from mc_campaign_private.subjects'),/permission denied/);
    }finally{
      await client.query('rollback');client.release();
      await query(`drop owned by ${role}`);await query(`drop role ${role}`);
    }
  });
}finally{if(local)await local.close();await pool.end();}
