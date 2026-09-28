import { randomUUID } from 'node:crypto';
import { pool, withOwnedBusinessContext } from '../../infrastructure/database/client.mjs';

const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

export async function listStores(userId) {
  return withOwnedBusinessContext(userId, async (client, businessId) => (await client.query(
    `select s.id,s.name,s.status,s.external_account_id,
            (c.status='active') as connected,c.status as connection_status,c.scopes,c.last_checked_at
       from mc.stores s
       left join mc.connections c on c.business_id=s.business_id and c.store_id=s.id
      where s.business_id=$1 and s.status<>'archived'
      order by s.created_at,s.id`,
    [businessId]
  )).rows);
}

export async function createPendingStore(userId, name) {
  const cleanName = String(name ?? '').trim().replace(/\s+/g, ' ');
  if (cleanName.length < 2 || cleanName.length > 80) throw new Error('invalid_store_name');
  return withOwnedBusinessContext(userId, async (client, businessId, role) => {
    if (!['owner','editor'].includes(role)) throw new Error('store_write_forbidden');
    return (await client.query(
    `insert into mc.stores(business_id,external_account_id,name,status)
     values($1,null,$2,'paused') returning id,name,status`,
    [businessId, cleanName]
    )).rows[0];
  });
}

export async function getBillingSummary(userId) {
  return withOwnedBusinessContext(userId, async (client, businessId) => {
    const current=(await client.query(
      `select p.code,p.name,v.id as plan_version_id,v.product_limit,v.store_limit,
              v.price::text,v.currency,v.billing_period,s.status,s.period_end,s.cancel_at_period_end
         from mc.subscriptions s
         join mc.billing_plan_versions v on v.id=s.plan_version_id
         join mc.billing_plans p on p.id=v.plan_id
        where s.business_id=$1`,[businessId]
    )).rows[0]??null;
    const plans=(await client.query(
      `select p.code,p.name,v.id as plan_version_id,v.product_limit,v.store_limit,
              v.price::text,v.currency,v.billing_period
         from mc.billing_plans p
         join lateral (
           select * from mc.billing_plan_versions candidate
            where candidate.plan_id=p.id order by candidate.version_no desc limit 1
         ) v on true
        order by case p.code when 'free' then 1 when 'minimum' then 2 when 'plus' then 3 when 'pro' then 4 else 5 end`
    )).rows;
    return {current,plans};
  });
}

export async function saveWbConnection(userId, {storeId,sellerId,scopes,encrypted,fingerprint,now=new Date()}) {
  if(!FINGERPRINT_PATTERN.test(String(fingerprint??'')))throw new TypeError('invalid_credential_fingerprint');
  return withOwnedBusinessContext(userId, async (client, businessId, role) => {
    if (!['owner','editor'].includes(role)) throw new Error('connection_write_forbidden');
    const store=(await client.query(
      `select id,external_account_id from mc.stores
        where business_id=$1 and id=$2 and marketplace_code='wb' and status<>'archived'
        for update`,[businessId,storeId]
    )).rows[0];
    if(!store)throw new Error('store_not_found');
    if(store.external_account_id&&store.external_account_id!==sellerId)throw new Error('store_account_mismatch');
    await client.query(`update mc.stores set external_account_id=$3,status='active' where business_id=$1 and id=$2`,[businessId,storeId,sellerId]);
    const existing=(await client.query(
      `select id,credential_generation from mc.connections where business_id=$1 and store_id=$2 for update`,
      [businessId,storeId]
    )).rows[0];
    const existingSecret=existing?(await client.query(
      `select credential_fingerprint from mc.connection_secrets where business_id=$1 and connection_id=$2 for update`,
      [businessId,existing.id]
    )).rows[0]:null;
    const currentGeneration=Number(existing?.credential_generation??0);
    const credentialChanged=currentGeneration<1||existingSecret?.credential_fingerprint!==fingerprint;
    const generation=credentialChanged?Math.max(1,currentGeneration+1):currentGeneration;
    const connectionId=existing?.id??randomUUID();
    const connection=(await client.query(
      `insert into mc.connections(id,business_id,store_id,secret_ref,scopes,status,last_checked_at,credential_generation)
       values($1,$2,$3,$4,$5,'active',now(),$6)
       on conflict(store_id) do update set secret_ref=excluded.secret_ref,scopes=excluded.scopes,status='active',last_checked_at=now(),credential_generation=excluded.credential_generation
       returning id,status,last_checked_at,credential_generation`,
      [connectionId,businessId,storeId,`database:${connectionId}`,JSON.stringify(scopes),generation]
    )).rows[0];
    await client.query(
      `insert into mc.connection_secrets(business_id,connection_id,ciphertext,nonce,auth_tag,key_version,credential_fingerprint)
       values($1,$2,$3,$4,$5,$6,$7)
       on conflict(connection_id) do update set ciphertext=excluded.ciphertext,nonce=excluded.nonce,auth_tag=excluded.auth_tag,key_version=excluded.key_version,credential_fingerprint=excluded.credential_fingerprint,updated_at=now()`,
      [businessId,connection.id,encrypted.ciphertext,encrypted.nonce,encrypted.authTag,encrypted.keyVersion,fingerprint]
    );
    for(const sourceType of ['catalog','financial_reports','operational_sales_funnel'])await client.query(
      `insert into mc.sync_streams(business_id,store_id,source_type,next_run_at,status)
       values($1,$2,$3,now(),'active') on conflict(store_id,source_type) do update set status='active',next_run_at=now()`,
      [businessId,storeId,sourceType]
    );
    let jobId=null;
    if(credentialChanged){
      await client.query(
        `insert into mc.financial_store_event_state(business_id,store_id,next_generation)
         values($1,$2,2)
         on conflict(business_id,store_id) do update
           set next_generation=mc.financial_store_event_state.next_generation+1`,
        [businessId,storeId]
      );
      const planned=(await client.query(
        `select week_count,job_id from mc.plan_financial_credential_refresh($1,$2,$3)`,
        [storeId,generation,now]
      )).rows[0];
      jobId=planned.job_id;
    }
    await client.query(
      `insert into mc.audit_events(business_id,store_id,actor_user_id,action,entity_type,entity_id,safe_details)
       values($1,$2,$3,'wb_credential_saved','connections',$4,$5::jsonb)`,
      [businessId,storeId,userId,connection.id,JSON.stringify({credentialChanged,generation,jobEnqueued:Boolean(jobId)})]
    );
    const safeConnection={...connection};
    delete safeConnection.credential_generation;
    return {...safeConnection,credentialChanged,generation,jobId};
  });
}

export async function listFinancialCredentialBackfill(limit=100) {
  if(!Number.isInteger(limit)||limit<1||limit>500)throw new TypeError('invalid_backfill_limit');
  return (await pool.query(`select * from mc.list_financial_credential_backfill($1)`,[limit])).rows;
}

export async function deferFinancialCredentialBackfill(connectionId,delaySeconds=900) {
  if(!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(String(connectionId??''))||!Number.isInteger(delaySeconds)||delaySeconds<60||delaySeconds>86400)throw new TypeError('invalid_backfill_retry');
  return Boolean((await pool.query(`select mc.defer_financial_credential_backfill($1,$2) as deferred`,[connectionId,delaySeconds])).rows[0]?.deferred);
}

export async function hasActiveWbConnection(userId){return (await pool.query(`select exists(select 1 from mc.memberships m join mc.stores s on s.business_id=m.business_id join mc.connections c on c.business_id=s.business_id and c.store_id=s.id where m.user_id=$1 and s.marketplace_code='wb' and s.status='active' and c.status='active') allowed`,[userId])).rows[0].allowed;}
