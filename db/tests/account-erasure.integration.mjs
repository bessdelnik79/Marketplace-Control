import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

const databaseUrl = process.env.ACCOUNT_ERASURE_INTEGRATION_DATABASE_URL;
if (databaseUrl && !new URL(databaseUrl).pathname.toLowerCase().includes('test')) {
  throw new Error('Account erasure integration requires a disposable database whose name contains test');
}
let db;
if (databaseUrl) {
  const { Client } = (await import('pg')).default;
  db = new Client({ connectionString: databaseUrl });
  await db.connect();
} else {
  const { PGlite } = await import('@electric-sql/pglite');
  db = new PGlite();
}
const query = (sql, values = []) => db.query(sql, values);
const exec = sql => databaseUrl ? db.query(sql) : db.exec(sql);
const rows = async (sql, values = []) => (await query(sql, values)).rows;
try {
  for (const file of (await readdir(new URL('../migrations/', import.meta.url))).filter(name => /^\d+_.+\.sql$/.test(name)).sort()) {
    await exec(await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
  }
  async function fixture({ shared = false, password = true } = {}) {
    const id = randomUUID(), business = randomUUID(), store = randomUUID(), email = `${id}@example.test`;
    await query("select set_config('app.user_id',$1,false),set_config('app.business_id',$2,false)", [id, business]);
    await query("insert into mc.users(id,display_name,email) values($1,'Erasure test',$2)", [id, email]);
    await query("insert into mc.businesses(id,name) values($1,'Erasure test')", [business]);
    await query("insert into mc.memberships(business_id,user_id,role) values($1,$2,'owner')", [business, id]);
    if (password) await query("insert into mc.auth_password_credentials(user_id,password_hash) values($1,'scrypt$test')", [id]);
    await query("insert into mc.auth_sessions(user_id,token_hash,expires_at) values($1,$2,now()+interval '1 hour')", [id, id]);
    await query("insert into mc.stores(id,business_id,name,status) values($1,$2,'Test','paused')", [store, business]);
    const document = (await rows("insert into mc.source_documents(business_id,store_id,origin,document_type,checksum,completeness) values($1,$2,'wb_api','weekly_realization','test','complete') returning id", [business, store]))[0].id;
    await query(`insert into mc.source_objects(business_id,store_id,document_id,storage_key,
      part_number,byte_size,checksum,content_type) values($1,$2,$3,$4,0,1,'test','application/json')`,
    [business, store, document, `${business}/${store}/${document}.json`]);
    const report = (await rows("insert into mc.reports(business_id,store_id,external_report_id,period_start,period_end) values($1,$2,$3,'2026-09-01','2026-09-07') returning id", [business, store, id]))[0].id;
    const version = (await rows("insert into mc.report_versions(business_id,store_id,report_id,document_id,version_no,checksum,parser_version) values($1,$2,$3,$4,1,'test','test') returning id", [business, store, report, document]))[0].id;
    await query("update mc.report_versions set status='validated' where id=$1", [version]);
    await query("update mc.report_versions set status='accepted',accepted_at=now() where id=$1", [version]);
    await query('update mc.reports set current_version_id=$1 where id=$2', [version, report]);
    if (shared) {
      const other = randomUUID();
      await query("select set_config('app.user_id',$1,false)", [other]);
      await query("insert into mc.users(id,display_name) values($1,'Other member')", [other]);
      await query("insert into mc.memberships(business_id,user_id,role) values($1,$2,'viewer')", [business, other]);
      await query("select set_config('app.user_id',$1,false)", [id]);
    }
    return { id, business, store, version };
  }
  async function erase(account, password = 'scrypt$test') {
    await exec('begin');
    try {
      await query("select set_config('app.user_id',$1,true)", [account.id]);
      const result = await rows('select mc.erase_account($1,$2,$3) as ids', [account.id, account.id, password]);
      await exec('commit');
      return result[0].ids;
    } catch (error) { await exec('rollback'); throw error; }
  }

  async function dailyHistory(account) {
    await query("select set_config('app.user_id',$1,false),set_config('app.business_id',$2,false)", [account.id, account.business]);
    const job = (await rows("select * from mc.enqueue_job($1,'account_erasure_test',$2,'{}'::jsonb)", [account.store, `erasure:${account.id}`]))[0];
    const parser = (await rows("select id from mc.method_versions where code='wb_finance_import' order by version_no desc limit 1"))[0].id;
    const result = (await rows("select id from mc.method_versions where code='financial_result' order by version_no desc limit 1"))[0].id;
    const generation = (await rows(`insert into mc.financial_daily_generations(
      business_id,store_id,generation_no,source_event_generation,watermark_generation,job_id,
      affected_from,affected_to,parser_method_version_id,result_method_version_id,frozen_input_fingerprint)
      values($1,$2,1,1,1,$3,'2026-09-01','2026-09-01',$4,$5,'erasure-test') returning id`,
    [account.business, account.store, job.id, parser, result]))[0].id;
    await query(`insert into mc.financial_daily_days(business_id,store_id,generation_id,accounting_date,
      coverage_complete,quality,tax_usable) values($1,$2,$3,'2026-09-01',false,'partial',false)`,
    [account.business, account.store, generation]);
    await query(`insert into mc.financial_daily_results(business_id,store_id,generation_id,accounting_date,
      category_code,scope,amount_signed,quality) values($1,$2,$3,'2026-09-01',
      (select code from mc.financial_categories order by code limit 1),'store',1,'partial')`,
    [account.business, account.store, generation]);
    await query("update mc.financial_daily_generations set status='succeeded',quality='partial',finished_at=now() where id=$1", [generation]);
    const publication = (await rows(`insert into mc.financial_daily_publications(business_id,store_id,
      publication_no,generation_id,affected_from,affected_to,source_event_generation,watermark_generation)
      values($1,$2,1,$3,'2026-09-01','2026-09-01',1,1) returning id`,
    [account.business, account.store, generation]))[0].id;
    await query(`insert into mc.financial_daily_publication_days(business_id,store_id,publication_id,
      accounting_date,generation_id) values($1,$2,$3,'2026-09-01',$4)`,
    [account.business, account.store, publication, generation]);
    return { generation, publication };
  }

  await test('credential race and shared membership reject atomically', async () => {
    const account = await fixture();
    await query("update mc.auth_password_credentials set password_hash='scrypt$changed' where user_id=$1", [account.id]);
    await assert.rejects(erase(account), /reauthentication_required/);
    assert.equal((await rows('select id from mc.users where id=$1', [account.id])).length, 1);
    const shared = await fixture({ shared: true });
    await assert.rejects(erase(shared), /shared_business/);
    assert.equal((await rows('select id from mc.report_versions where id=$1', [shared.version])).length, 1);
  });

  await test('non-superuser function erases immutable circular histories and preserves foreign tenant', async () => {
    const foreign = await fixture(), account = await fixture();
    const role = `mc_erasure_reader_${randomUUID().replaceAll('-', '')}`;
    await exec(`create role ${role}; grant ${role} to current_user; grant usage on schema mc to ${role};
      grant select on mc.users,mc.report_versions,mc.businesses to ${role};
      grant execute on function mc.context_user_id(),mc.context_business_id(),mc.erase_account(uuid,text,text) to ${role};
      set role ${role};`);
    try {
      await assert.rejects(query('insert into mc_erasure_private.permits values(pg_current_xact_id(),$1)', [account.business]), /permission denied/);
      assert.deepEqual(await erase(account), [account.business]);
      assert.equal((await rows('select id from mc.users where id=$1', [account.id])).length, 0);
      await query("select set_config('app.business_id',$1,false)", [foreign.business]);
      assert.equal((await rows('select id from mc.report_versions where id=$1', [foreign.version])).length, 1);
    } finally { await exec(`reset role; drop owned by ${role}; drop role ${role};`); }
    assert.equal((await rows('select * from mc.account_erasure_cleanup where erased_business_id=$1', [account.business])).length, 1);
    assert.equal((await rows('select * from mc_erasure_private.permits')).length, 0);
  });

  await test('passwordless erasure requires a recent live session', async () => {
    const account = await fixture({ password: false });
    await query("update mc.auth_sessions set created_at=now()-interval '11 minutes' where user_id=$1", [account.id]);
    await assert.rejects(erase(account, null), /reauthentication_required/);
    await query('update mc.auth_sessions set created_at=now() where user_id=$1', [account.id]);
    assert.deepEqual(await erase(account, null), [account.business]);
  });

  await test('erasure revokes every login and releases email while deleting linked challenges and limits', async () => {
    const account = await fixture(), email = `${account.id}@example.test`;
    await query("insert into mc.auth_identities(user_id,provider,subject) values($1,'password',$2)", [account.id,email]);
    await query("insert into mc.auth_sessions(user_id,token_hash,expires_at) values($1,$2,now()+interval '1 hour')", [account.id,randomUUID()]);
    await query(`insert into mc.auth_registration_challenges(email,display_name,password_hash,code_hash,expires_at)
      values($1,'Pending','scrypt$test','test-code',now()+interval '10 minutes')`, [email]);
    const keys = [`verify:${email}`,`login:127.0.0.1:${email}`,`account-erasure:${account.id}`,
      `wb-connect:${account.id}`,`password:${account.id}:127.0.0.1`];
    for (const key of keys) await query(`insert into mc.auth_rate_limits(bucket_key,attempts,window_started_at,expires_at)
      values($1,1,now(),now()+interval '15 minutes')`, [key]);
    await erase(account);
    assert.equal((await rows('select * from mc.auth_sessions where user_id=$1',[account.id])).length,0);
    assert.equal((await rows('select * from mc.auth_password_credentials where user_id=$1',[account.id])).length,0);
    assert.equal((await rows('select * from mc.auth_registration_challenges where email=$1',[email])).length,0);
    assert.equal((await rows('select * from mc.auth_rate_limits where bucket_key=any($1::text[])',[keys])).length,0);
    const replacement = randomUUID();
    await query("select set_config('app.user_id',$1,false)",[replacement]);
    await query("insert into mc.users(id,display_name,email) values($1,'New account',$2)",[replacement,email]);
    await query("insert into mc.auth_identities(user_id,provider,subject) values($1,'password',$2)",[replacement,email]);
    assert.equal((await rows('select user_id from mc.auth_identities where subject=$1',[email]))[0].user_id,replacement);
  });

  await test('foreign-tenant actor reference rolls back the entire erasure', async () => {
    const account = await fixture(), foreign = await fixture();
    await query("insert into mc.audit_events(business_id,actor_user_id,action,entity_type,entity_id) values($1,$2,'updated','foreign-test',$3)", [foreign.business, account.id, foreign.store]);
    await assert.rejects(erase(account), /foreign key constraint/);
    await query("select set_config('app.user_id',$1,false)", [account.id]);
    assert.equal((await rows('select id from mc.users where id=$1', [account.id])).length, 1);
    assert.equal((await rows('select * from mc.account_erasure_cleanup where erased_business_id=$1', [account.business])).length, 0);
  });

  await test('daily-generation delete guard stays closed while account erasure removes frozen published history', async () => {
    const foreign = await fixture();
    const foreignHistory = await dailyHistory(foreign);
    const account = await fixture();
    const history = await dailyHistory(account);
    await query("select set_config('app.account_erasure','true',false)");
    await assert.rejects(query('delete from mc.financial_daily_generations where id=$1', [history.generation]), /append-only/);
    await assert.rejects(query('delete from mc.financial_daily_publications where id=$1', [history.publication]), /immutable/);
    await query("select set_config('app.account_erasure','',false)");
    const role = `mc_erasure_owner_${randomUUID().replaceAll('-', '')}`;
    const originalOwner = (await rows('select quote_ident(current_user) as name'))[0].name;
    await exec(`create role ${role} nosuperuser; grant ${role} to current_user;
      grant usage,create on schema mc to ${role}; grant usage on schema mc_erasure_private to ${role};
      grant all on all tables in schema mc to ${role}; grant execute on all functions in schema mc to ${role};
      grant select,insert,delete on mc_erasure_private.permits to ${role};
      alter function mc.erase_account(uuid,text,text) owner to ${role}; set role ${role};`);
    try {
      assert.equal((await rows('select rolsuper from pg_roles where rolname=current_user'))[0].rolsuper, false);
      assert.deepEqual(await erase(account), [account.business]);
    } finally {
      await exec(`reset role; alter function mc.erase_account(uuid,text,text) owner to ${originalOwner};
        drop owned by ${role}; drop role ${role};`);
    }
    for (const table of ['financial_daily_generations', 'financial_daily_days', 'financial_daily_results',
      'financial_daily_publications', 'financial_daily_publication_days', 'source_objects']) {
      assert.equal((await rows(`select * from mc.${table} where business_id=$1`, [account.business])).length, 0, table);
    }
    assert.equal((await rows('select mc.account_source_write_allowed($1) as allowed', [account.business]))[0].allowed, false);
    await query("select set_config('app.business_id',$1,false)", [foreign.business]);
    assert.equal((await rows('select id from mc.financial_daily_generations where id=$1', [foreignHistory.generation])).length, 1);
    assert.equal((await rows('select id from mc.financial_daily_publications where id=$1', [foreignHistory.publication])).length, 1);
  });

  await test('PostgreSQL erasure waits for a source write and rejects writes after deletion', { skip: !databaseUrl }, async () => {
    const account = await fixture();
    const { Client } = (await import('pg')).default;
    const sourceWriter = new Client({ connectionString: databaseUrl });
    await sourceWriter.connect();
    let pending;
    try {
      await sourceWriter.query("select pg_advisory_lock(hashtextextended('account-erasure:'||$1,0))", [account.business]);
      assert.equal((await sourceWriter.query('select mc.account_source_write_allowed($1) as allowed', [account.business])).rows[0].allowed, true);
      const eraserPid = (await rows('select pg_backend_pid() as pid'))[0].pid;
      // pg_locks provides evidence of the wait, without inferring it from elapsed time.
      pending = erase(account);
      pending.catch(() => {});
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const lock = (await sourceWriter.query("select exists(select 1 from pg_locks where pid=$1 and locktype='advisory' and not granted) as waiting", [eraserPid])).rows[0];
        if (lock.waiting) { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(waiting, true, 'erasure must wait until the in-flight source write releases its lock');
      await sourceWriter.query("select pg_advisory_unlock(hashtextextended('account-erasure:'||$1,0))", [account.business]);
      assert.deepEqual(await pending, [account.business]);
      pending = null;
      assert.equal((await sourceWriter.query('select mc.account_source_write_allowed($1) as allowed', [account.business])).rows[0].allowed, false);
    } finally {
      await sourceWriter.query('select pg_advisory_unlock_all()');
      if (pending) await pending.catch(() => {});
      await sourceWriter.end();
    }
  });
} finally {
  if (databaseUrl) await db.end(); else await db.close();
}
