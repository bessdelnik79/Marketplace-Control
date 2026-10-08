import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const url=process.env.TARIFF_LIFECYCLE_INTEGRATION_DATABASE_URL;
if(!url)throw new Error('Set TARIFF_LIFECYCLE_INTEGRATION_DATABASE_URL to an empty disposable PostgreSQL database whose name contains "test".');
if(!new URL(url).pathname.slice(1).toLowerCase().includes('test'))throw new Error('Refusing tariff lifecycle integration outside a database whose name contains "test".');
process.env.DATABASE_URL=url;
const {pool,migrate}=await import('../../app/infrastructure/database/client.mjs');
const {getCatalogState}=await import('../../app/modules/catalog/catalog.repository.mjs');
test.after(async()=>{await pool.end();});

async function context(scope,action,role){
  const client=await pool.connect();
  try{
    await client.query('begin');
    if(role)await client.query(`set local role ${role}`);
    await client.query("select set_config('app.business_id',$1,true),set_config('app.user_id',$2,true)",[scope.business,scope.user]);
    const result=await action(client);
    await client.query('commit');
    return result;
  }catch(error){await client.query('rollback');throw error;}finally{client.release();}
}
async function fixture(paid=false){
  const scope={business:randomUUID(),user:randomUUID(),store:randomUUID(),products:[]};
  await context(scope,async client=>{
    await client.query(`insert into mc.users(id,display_name) values($1,'Tariff lifecycle owner')`,[scope.user]);
    await client.query(`insert into mc.businesses(id,name) values($1,'Tariff lifecycle')`,[scope.business]);
    await client.query(`insert into mc.memberships(business_id,user_id,role) values($1,$2,'owner')`,[scope.business,scope.user]);
    if(paid)await client.query(`update mc.subscriptions set plan_version_id=(select v.id from mc.billing_plan_versions v join mc.billing_plans p on p.id=v.plan_id where p.code='plus' order by v.version_no desc limit 1) where business_id=$1`,[scope.business]);
    await client.query(`insert into mc.stores(id,business_id,external_account_id,name,status) values($1,$2,$3,'Lifecycle store','active')`,[scope.store,scope.business,scope.store]);
    scope.catalog=(await client.query(`insert into mc.source_documents(business_id,store_id,origin,document_type,checksum,completeness) values($1,$2,'wb_api','catalog',$3,'complete') returning id`,[scope.business,scope.store,randomUUID()])).rows[0].id;
    for(let i=0;i<30;i++)scope.products.push((await client.query(`insert into mc.products(business_id,store_id,wb_article,seller_article) values($1,$2,$3,$4) returning id`,[scope.business,scope.store,980001+i,`TARIFF-${i}`])).rows[0].id);
  });
  return scope;
}
const choose=(scope,products,mode='replace',role)=>context(scope,async client=>(await client.query(`select mc.choose_tariff_profile_products($1,$2,$3::uuid[],$4) id`,[scope.store,scope.catalog,products,mode])).rows[0].id,role);
const effective=scope=>context(scope,async client=>(await client.query(`select c.*,p.code from mc.effective_tariff_context() c join mc.billing_plan_versions v on v.id=c.plan_version_id join mc.billing_plans p on p.id=v.plan_id`)).rows[0]);
const selected=scope=>context(scope,async client=>(await client.query(`select product_id from mc.active_profile_products where business_id=$1 order by product_id`,[scope.business])).rows.map(row=>row.product_id));
const issue=(scope,key=randomUUID(),at=new Date(Date.now()-1000),plan='plus')=>context(scope,async client=>(await client.query(`select mc.apply_tariff_period($1,$2,$3,$4) expires`,[scope.business,plan,key,at])).rows[0].expires);
async function forceExpired(scope){
  await context(scope,client=>client.query(`update mc.subscriptions set period_start='2020-01-01',period_end='2020-02-01' where business_id=$1`,[scope.business]));
}

test('full tariff lifecycle uses profile limits, frozen free selection, exact expiry and private idempotent confirmations',async t=>{
  assert.equal((await pool.query("select to_regclass('mc.schema_migrations') name")).rows[0].name,null,'use an empty disposable database');
  const directory=path.resolve('db/migrations');
  for(const file of (await readdir(directory)).filter(name=>/^\d+_.+\.sql$/.test(name)&&Number(name.slice(0,3))<73).sort())await pool.query(await readFile(path.join(directory,file),'utf8'));
  const legacyFree=await fixture(),legacyPaid=await fixture(true);
  for(const scope of [legacyFree,legacyPaid])await context(scope,client=>client.query(`select mc.confirm_product_selection($1,$2,$3::uuid[])`,[scope.store,scope.catalog,scope.products.slice(0,2)]));
  await pool.query(await readFile(path.join(directory,'073_tariff_profile_foundation.sql'),'utf8'));
  await context(legacyPaid,client=>client.query(`select mc.add_products_to_selection($1,$2::uuid[])`,[legacyPaid.store,legacyPaid.products.slice(2,4)]));
  for(const file of (await readdir(directory)).filter(name=>/^\d+_.+\.sql$/.test(name)&&Number(name.slice(0,3))>=74&&Number(name.slice(0,3))<80).sort())await pool.query(await readFile(path.join(directory,file),'utf8'));
  const recoverable=await fixture(),renewedEmpty=await fixture(),unconfirmedEmpty=await fixture(),editedPaid=await fixture();
  for(const candidate of [recoverable,renewedEmpty,editedPaid])await choose(candidate,candidate.products.slice(0,3));
  for(const candidate of [recoverable,renewedEmpty,unconfirmedEmpty,editedPaid])await issue(candidate);
  await issue(renewedEmpty);
  await choose(editedPaid,editedPaid.products.slice(0,20));
  const recoveryBefore=await effective(recoverable),editedBefore=await effective(editedPaid);
  await migrate();
  assert.deepEqual(await selected(recoverable),recoverable.products.slice(0,3).sort(),'recover untouched first paid activation from authoritative free selection');
  const recoveryAfter=await effective(recoverable);
  assert.equal(recoveryAfter.selection_confirmed,true);
  assert.equal((await getCatalogState(recoverable.user,recoverable.store)).selectionInherited,true,'catalog explains the recovered inherited selection');
  assert.equal(recoveryAfter.period_end.toISOString(),recoveryBefore.period_end.toISOString(),'recovery preserves paid period');
  assert.notEqual(recoveryAfter.scope_token,recoveryBefore.scope_token,'recovery invalidates the empty paid financial scope');
  await context(recoverable,async client=>{
    assert.deepEqual((await client.query(`select member.product_id from mc.tariff_profile_products member
      join mc.tariff_profile_state state on state.business_id=member.business_id and state.free_profile_id=member.profile_id
      where member.business_id=$1 order by member.product_id`,[recoverable.business])).rows.map(row=>row.product_id),recoverable.products.slice(0,3).sort(),'recovery never mutates the free subset');
    assert.equal((await client.query(`select count(*)::int count from mc.tariff_lifecycle_events
      where business_id=$1 and details->>'source'='upgrade_selection_recovery'`,[recoverable.business])).rows[0].count,1);
  });
  assert.deepEqual(await selected(renewedEmpty),[],'renewed empty profile is not inferred');
  assert.equal((await effective(unconfirmedEmpty)).selection_confirmed,false,'unconfirmed free choice is never invented');
  assert.deepEqual(await selected(editedPaid),editedPaid.products.slice(0,20).sort(),'existing edited paid subset is preserved');
  assert.equal((await effective(editedPaid)).scope_token,editedBefore.scope_token);
  assert.deepEqual(await selected(legacyPaid),legacyPaid.products.slice(0,4).sort(),'reconcile changes after the inert foundation snapshot');
  assert.deepEqual(await selected(legacyFree),[],'unknown original free subset is not inferred from history');
  assert.equal((await effective(legacyFree)).selection_confirmed,false);
  await context(legacyFree,async client=>assert.equal((await client.query(`select * from mc.active_profile_stores where store_id=$1`,[legacyFree.store])).rowCount,1,'preserve existing free store for explicit reselection'));
  await choose(legacyFree,legacyFree.products.slice(0,3));
  assert.deepEqual(await selected(legacyFree),legacyFree.products.slice(0,3).sort());

  const scope=await fixture();
  const role=`tariff_lifecycle_${randomUUID().replaceAll('-','')}`;
  await pool.query(`create role ${role} nologin nosuperuser nobypassrls`);
  t.after(async()=>{await pool.query(`drop owned by ${role}`);await pool.query(`drop role ${role}`);});
  await pool.query(`grant ${role} to current_user`);
  await pool.query(`grant usage on schema mc to ${role}`);
  await pool.query(`grant select on all tables in schema mc to ${role}`);
  for(const signature of ['mc.context_business_id()','mc.context_user_id()','mc.effective_tariff_context(uuid)','mc.assert_active_profile_store(uuid)','mc.choose_tariff_profile_products(uuid,uuid,uuid[],text)','mc.financial_tariff_scope_matches(uuid,uuid[],text)'])await pool.query(`grant execute on function ${signature} to ${role}`);
  await choose(scope,scope.products.slice(0,3),'replace',role);
  const freeScope=await effective(scope);
  assert.equal(freeScope.code,'free');
  assert.equal(freeScope.selection_confirmed,true);
  await assert.rejects(()=>choose(scope,scope.products.slice(1,4),'replace',role),{code:'23514'});
  await assert.rejects(()=>choose(scope,[scope.products[3]],'add',role),{code:'23514'});
  await choose(scope,scope.products.slice(0,3),'replace',role);
  assert.equal((await effective(scope)).scope_token,freeScope.scope_token,'identical confirmation is a no-op');
  const overflowPlan=(await pool.query(`insert into mc.billing_plans(code,name) values('test_tiny_paid','Synthetic two-product tariff') returning id`)).rows[0].id;
  await pool.query(`insert into mc.billing_plan_versions(plan_id,version_no,product_limit,store_limit,billing_period)
    values($1,1,2,1,'month')`,[overflowPlan]);
  const overflowKey=randomUUID();
  await assert.rejects(()=>issue(scope,overflowKey,new Date(Date.now()-1000),'test_tiny_paid'),{code:'23514'},'inheritance never truncates a selection exceeding target limits');
  assert.equal((await effective(scope)).scope_token,freeScope.scope_token,'failed overflow activation preserves the free financial scope');
  assert.deepEqual(await selected(scope),scope.products.slice(0,3).sort());
  await context(scope,async client=>{
    assert.equal((await client.query(`select count(*)::int count from mc.tariff_profiles where business_id=$1 and plan_id=$2`,[scope.business,overflowPlan])).rows[0].count,0,'overflow rolls back the new paid profile');
    assert.equal((await client.query(`select count(*)::int count from mc.tariff_lifecycle_events where event_key=$1`,[overflowKey])).rows[0].count,0,'overflow rolls back payment confirmation');
  });
  await assert.rejects(()=>context(scope,client=>client.query(`select mc.apply_tariff_period($1,'plus',$2,now())`,[scope.business,randomUUID()]),role),{code:'42501'});
  await assert.rejects(()=>context(scope,client=>client.query(`select mc.expire_due_tariff_subscriptions()`),role),{code:'42501'});
  await assert.rejects(()=>context(scope,client=>client.query(`select mc.inherit_tariff_profile_selection($1,$2,$2,$3)`,[scope.business,freeScope.profile_id,freeScope.plan_version_id]),role),{code:'42501'});
  await context(scope,async client=>{
    assert.equal((await client.query(`select * from mc.effective_tariff_context($1)`,[legacyPaid.business])).rowCount,0);
    assert.equal((await client.query(`select * from mc.active_profile_products where business_id=$1`,[legacyPaid.business])).rowCount,0);
  },role);
  await assert.rejects(()=>choose({...scope,store:legacyPaid.store,catalog:legacyPaid.catalog},legacyPaid.products.slice(0,1),'replace',role),{code:'42501'});

  await context(scope,async client=>{
    const document=(await client.query(`insert into mc.source_documents(business_id,store_id,origin,document_type,checksum,completeness) values($1,$2,'wb_api','weekly_realization',$3,'complete') returning id`,[scope.business,scope.store,randomUUID()])).rows[0];
    const report=(await client.query(`insert into mc.reports(business_id,store_id,external_report_id,period_start,period_end) values($1,$2,$3,'2025-01-01','2025-01-31') returning id`,[scope.business,scope.store,randomUUID()])).rows[0];
    const version=(await client.query(`insert into mc.report_versions(business_id,store_id,report_id,document_id,version_no,checksum,parser_version) values($1,$2,$3,$4,1,$5,'tariff-fixture') returning id`,[scope.business,scope.store,report.id,document.id,randomUUID()])).rows[0];
    await client.query(`update mc.report_versions set status='validated' where id=$1`,[version.id]);
    await client.query(`update mc.report_versions set status='accepted',accepted_at=now() where id=$1`,[version.id]);
    await client.query(`update mc.reports set current_version_id=$1 where id=$2`,[version.id,report.id]);
  });

  const key=randomUUID(),confirmed=new Date(Date.now()-1000);
  const expires=await issue(scope,key,confirmed);
  const paidScope=await effective(scope);
  assert.equal(paidScope.code,'plus');
  assert.equal(paidScope.selection_confirmed,true);
  assert.deepEqual(await selected(scope),scope.products.slice(0,3).sort(),'first paid activation inherits the effective confirmed selection');
  assert.equal((await getCatalogState(scope.user,scope.store)).selectionInherited,true,'catalog explains the first inherited paid selection');
  await context(scope,async client=>{
    const details=(await client.query(`select details from mc.tariff_lifecycle_events where event_key=$1`,[key])).rows[0].details;
    assert.equal(details.selectionInherited,true);
    assert.equal(details.selectionSourceProfileId,freeScope.profile_id);
  });
  await context(scope,async client=>assert.equal((await client.query(`select mc.financial_tariff_scope_matches($1,$2::uuid[],$3) matches`,[scope.store,scope.products.slice(0,3),freeScope.scope_token])).rows[0].matches,false,'old free aggregate cannot represent the new paid scope'),role);
  assert.equal((await issue(scope,key,confirmed)).toISOString(),expires.toISOString());
  assert.equal((await effective(scope)).scope_token,paidScope.scope_token,'duplicate confirmation is a no-op');
  await choose(scope,scope.products.slice(0,3),'replace',role);
  assert.equal((await effective(scope)).scope_token,paidScope.scope_token,'confirming the inherited set unchanged is a no-op');
  assert.equal((await getCatalogState(scope.user,scope.store)).selectionInherited,true,'duplicate payment and identical selection preserve the inheritance notice');
  await assert.rejects(()=>issue(scope,key,confirmed,'minimum'),{code:'23514'});
  await assert.rejects(()=>issue(scope,randomUUID(),confirmed,'minimum'),{code:'23514'},'no implicit cross-paid transition');
  await choose(scope,scope.products.slice(0,8),'replace',role);
  assert.equal((await getCatalogState(scope.user,scope.store)).selectionInherited,false,'user selection replaces the inheritance notice');
  await choose(scope,scope.products.slice(3,23),'replace',role);
  const paidProducts=scope.products.slice(3,23).sort();
  assert.deepEqual(await selected(scope),paidProducts);
  await context(scope,async client=>{
    assert.equal((await client.query(`select count(*)::int count from mc.product_selection_items where business_id=$1`,[scope.business])).rows[0].count,23,'replacement preserves historical registry');
    assert.deepEqual((await client.query(`select product_id from mc.tariff_profile_products where business_id=$1 and profile_id=$2 order by product_id`,[scope.business,freeScope.profile_id])).rows.map(row=>row.product_id),scope.products.slice(0,3).sort(),'paid replacement preserves initial free subset');
  });
  const beforeRenewal=await effective(scope);
  const renewed=await issue(scope);
  assert.equal(renewed.toISOString(),(await pool.query(`select mc.tariff_calendar_month($1) expires`,[expires])).rows[0].expires.toISOString(),'early renewal extends from paid end');
  assert.equal((await effective(scope)).scope_token,beforeRenewal.scope_token,'renewal of an unchanged active set does not change financial scope');
  await context(scope,async client=>{
    const events=(await client.query(`select * from mc.financial_input_events where business_id=$1 and event_key like 'tariff-scope:%'`,[scope.business])).rows;
    assert.ok(events.length>=3,'profile activation and replacements queue local calculation');
    for(const event of events){
      assert.equal(event.allows_wb_api,false);
      assert.equal(event.affected_from.toISOString().slice(0,10),'2025-01-01');
      assert.equal(event.affected_to.toISOString().slice(0,10),'2025-01-31');
    }
  });
  const extraStore=randomUUID();
  await context(scope,client=>client.query(`insert into mc.stores(id,business_id,external_account_id,name,status) values($1,$2,$3,'Paid second store','active')`,[extraStore,scope.business,extraStore]));
  const beforeExpiry=await effective(scope);
  await forceExpired(scope);
  const fallback=await effective(scope);
  assert.equal(fallback.code,'free');
  assert.equal((await getCatalogState(scope.user,scope.store)).selectionInherited,false,'expired paid access never shows the inheritance notice on free');
  assert.ok(Number(fallback.activation_revision)<0);
  assert.notEqual(fallback.scope_token,beforeExpiry.scope_token);
  assert.deepEqual(await selected(scope),scope.products.slice(0,3).sort(),'exact access fallback precedes the background transition');
  await context(scope,async client=>assert.equal((await client.query(`select mc.financial_tariff_scope_matches($1,$2::uuid[],$3) matches`,[scope.store,paidProducts,beforeExpiry.scope_token])).rows[0].matches,false,'expired paid aggregate is rejected before the daily sweep'),role);
  await assert.rejects(()=>context(scope,client=>client.query(`select mc.assert_active_profile_store($1)`,[extraStore]),role),{code:'42501'});
  const auditBefore=await context(scope,async client=>(await client.query(`select count(*)::int count from mc.tariff_lifecycle_events where business_id=$1`,[scope.business])).rows[0].count);
  await effective(scope);await selected(scope);
  assert.equal(await context(scope,async client=>(await client.query(`select count(*)::int count from mc.tariff_lifecycle_events where business_id=$1`,[scope.business])).rows[0].count),auditBefore,'read-only expiry checks do not write transitions');
  assert.equal(await context(scope,async client=>(await client.query(`select mc.expire_tariff_subscription($1) expired`,[scope.business])).rows[0].expired),true);
  assert.equal(await context(scope,async client=>(await client.query(`select mc.expire_tariff_subscription($1) expired`,[scope.business])).rows[0].expired),false);
  assert.ok(Number((await effective(scope)).activation_revision)>0);
  await issue(scope);
  assert.deepEqual(await selected(scope),paidProducts,'repayment restores last saved paid subset');
  assert.equal((await getCatalogState(scope.user,scope.store)).selectionInherited,false,'restoring an edited saved paid set does not revive the inheritance notice');
  await context(scope,async client=>assert.equal((await client.query(`select status from mc.stores where id=$1`,[extraStore])).rows[0].status,'active','expiry does not archive retained paid stores'));

  const beforeFree=await fixture();
  await issue(beforeFree);
  assert.equal((await effective(beforeFree)).selection_confirmed,false);
  assert.deepEqual(await selected(beforeFree),[],'unconfirmed free profile keeps explicit product choice on first paid activation');
  await choose(beforeFree,beforeFree.products.slice(0,7));
  await forceExpired(beforeFree);
  assert.equal((await effective(beforeFree)).selection_confirmed,false);
  assert.deepEqual(await selected(beforeFree),[],'payment before first free choice must never invent three products');
  await choose(beforeFree,beforeFree.products.slice(8,11));
  assert.deepEqual(await selected(beforeFree),beforeFree.products.slice(8,11).sort(),'explicit first free choice can reuse retained store and history');

  const concurrentKey=randomUUID(),concurrentAt=new Date(Date.now()-1000);
  const confirmations=await Promise.all([issue(scope,concurrentKey,concurrentAt),issue(scope,concurrentKey,concurrentAt)]);
  assert.equal(confirmations[0].toISOString(),confirmations[1].toISOString());
  assert.equal(await context(scope,async client=>(await client.query(`select count(*)::int count from mc.tariff_lifecycle_events where event_key=$1`,[concurrentKey])).rows[0].count),1);
  await forceExpired(scope);
  await Promise.all([context(scope,client=>client.query(`select mc.expire_tariff_subscription($1)`,[scope.business])),issue(scope)]);
  assert.equal((await effective(scope)).code,'plus','expiration and renewal lock the same business');

  const monthCases=[['2026-01-31T09:34:56.789Z','2026-02-28T09:34:56.789Z'],['2024-01-31T09:34:56.789Z','2024-02-29T09:34:56.789Z'],['2026-10-15T09:34:56.789Z','2026-11-15T09:34:56.789Z']];
  for(const [start,end] of monthCases)assert.equal((await pool.query(`select mc.tariff_calendar_month($1) result`,[start])).rows[0].result.toISOString(),end);
  await forceExpired(scope);
  const processed=(await pool.query(`select mc.expire_due_tariff_subscriptions() processed`)).rows[0].processed;
  assert.ok(processed>=1,'daily sweep catches overdue tenants after downtime');
  assert.equal((await pool.query(`select mc.expire_due_tariff_subscriptions() processed`)).rows[0].processed,0,'one durable sweep per Moscow day');
  assert.equal((await effective(scope)).code,'free');
  await migrate();
  assert.equal((await effective(scope)).code,'free','migration rerun does not reset saved lifecycle state');
  assert.equal((await effective(recoverable)).scope_token,recoveryAfter.scope_token,'migration rerun does not repeat recovered inheritance');
});

test('operational scheduler filters an inactive prefix before applying its candidate limit and restores context',async()=>{
  const inactive=await fixture(),eligible=await fixture();
  await choose(eligible,eligible.products.slice(0,1));
  await context(inactive,client=>client.query(`insert into mc.operational_sync_targets(business_id,store_id,requested_by,next_run_at,status)
    values($1,$2,$3,'2000-01-01','active')`,[inactive.business,inactive.store,inactive.user]));
  await context(eligible,client=>client.query(`insert into mc.operational_sync_targets(business_id,store_id,requested_by,next_run_at,status)
    values($1,$2,$3,'2000-01-02','active')`,[eligible.business,eligible.store,eligible.user]));
  await context(inactive,async client=>{
    const candidate=(await client.query(`select * from mc.list_operational_sync_candidates(1)`)).rows;
    assert.deepEqual(candidate,[{user_id:eligible.user,business_id:eligible.business,store_id:eligible.store}],
      'an earlier due unconfirmed profile must not consume the only scheduler slot');
    const restored=(await client.query(`select mc.context_business_id() business,mc.context_user_id() user_id`)).rows[0];
    assert.deepEqual(restored,{business:inactive.business,user_id:inactive.user});
  });
});
