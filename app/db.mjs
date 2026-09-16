import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { createHash, randomUUID } from 'node:crypto';
import { requiresEmailVerification } from './auth.mjs';
import { financialParserVersion, normalizeFinancialOperation, stableJson } from './finance.mjs';

const { Pool } = pg;
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://marketplace_control:marketplace_control_local@127.0.0.1:5432/marketplace_control',
  max: 10
});

export async function migrate() {
  const exists = await pool.query("select to_regclass('mc.schema_migrations') as table_name");
  const applied = new Set(exists.rows[0].table_name ? (await pool.query('select version from mc.schema_migrations')).rows.map((row) => row.version) : []);
  const directory = path.resolve('db/migrations');
  const files = (await readdir(directory)).filter((name) => /^\d+_.+\.sql$/.test(name)).sort();
  for (const file of files) {
    const version = Number(file.slice(0, 3));
    if (!applied.has(version)) await pool.query(await readFile(path.join(directory, file), 'utf8'));
  }
}

export async function registerUser({ name, email, passwordHash }) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const userId = randomUUID(), businessId = randomUUID();
    await client.query("select set_config('app.user_id',$1,true),set_config('app.business_id',$2,true)", [userId, businessId]);
    const user = (await client.query(
      `insert into mc.users(id,display_name,email) values($1,$2,$3) returning id,display_name,email`, [userId, name, email]
    )).rows[0];
    await client.query(`insert into mc.auth_identities(user_id,provider,subject) values($1,'password',$2)`, [user.id, email]);
    await client.query(`insert into mc.auth_password_credentials(user_id,password_hash) values($1,$2)`, [user.id, passwordHash]);
    const business = (await client.query(`insert into mc.businesses(id,name) values($1,$2) returning id`, [businessId, `Бизнес ${name}`])).rows[0];
    await client.query(`insert into mc.memberships(business_id,user_id,role) values($1,$2,'owner')`, [business.id, user.id]);
    await client.query('commit');
    return user;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

export async function saveChallenge({name,email,passwordHash,codeHash}){await pool.query(`insert into mc.auth_registration_challenges(email,display_name,password_hash,code_hash,expires_at) values($1,$2,$3,$4,now()+interval '10 minutes') on conflict(email) do update set display_name=excluded.display_name,password_hash=excluded.password_hash,code_hash=excluded.code_hash,attempts=0,expires_at=excluded.expires_at`,[email,name,passwordHash,codeHash]);}
export async function consumeChallenge(email,codeHash){const c=await pool.connect();try{await c.query('begin');const row=(await c.query(`select * from mc.auth_registration_challenges where email=$1 and expires_at>now() and attempts<5 for update`,[email])).rows[0];if(!row||row.code_hash!==codeHash){if(row)await c.query(`update mc.auth_registration_challenges set attempts=attempts+1 where email=$1`,[email]);await c.query('commit');return null;}await c.query(`delete from mc.auth_registration_challenges where email=$1`,[email]);await c.query('commit');return row;}catch(e){await c.query('rollback');throw e;}finally{c.release();}}
async function withUserContext(id, action) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.user_id',$1,true)", [id]);
    const result = await action(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally { client.release(); }
}

async function withOwnedBusinessContext(userId, action) {
  return withUserContext(userId, async client => {
    const membership = (await client.query(
      `select business_id,role from mc.memberships where user_id=$1 order by created_at limit 1`,
      [userId]
    )).rows[0];
    if (!membership) throw new Error('business_not_found');
    await client.query("select set_config('app.business_id',$1,true)", [membership.business_id]);
    return action(client, membership.business_id, membership.role);
  });
}

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

export async function saveWbConnection(userId, {storeId,sellerId,scopes,encrypted}) {
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
    const existing=(await client.query(`select id from mc.connections where business_id=$1 and store_id=$2`,[businessId,storeId])).rows[0];
    const connectionId=existing?.id??randomUUID();
    const connection=(await client.query(
      `insert into mc.connections(id,business_id,store_id,secret_ref,scopes,status,last_checked_at)
       values($1,$2,$3,$4,$5,'active',now())
       on conflict(store_id) do update set secret_ref=excluded.secret_ref,scopes=excluded.scopes,status='active',last_checked_at=now()
       returning id,status,last_checked_at`,
      [connectionId,businessId,storeId,`database:${connectionId}`,JSON.stringify(scopes)]
    )).rows[0];
    await client.query(
      `insert into mc.connection_secrets(business_id,connection_id,ciphertext,nonce,auth_tag,key_version)
       values($1,$2,$3,$4,$5,$6)
       on conflict(connection_id) do update set ciphertext=excluded.ciphertext,nonce=excluded.nonce,auth_tag=excluded.auth_tag,key_version=excluded.key_version,updated_at=now()`,
      [businessId,connection.id,encrypted.ciphertext,encrypted.nonce,encrypted.authTag,encrypted.keyVersion]
    );
    for(const sourceType of ['catalog','financial_reports'])await client.query(
      `insert into mc.sync_streams(business_id,store_id,source_type,next_run_at,status)
       values($1,$2,$3,now(),'active') on conflict(store_id,source_type) do update set status='active',next_run_at=now()`,
      [businessId,storeId,sourceType]
    );
    return connection;
  });
}

export async function beginCatalogSync(userId,storeId,{force=false}={}){
  return withOwnedBusinessContext(userId,async(client,businessId)=>{
    const row=(await client.query(
      `select ss.id as stream_id,ss.next_run_at,cs.ciphertext,cs.nonce,cs.auth_tag
         from mc.stores s
         join mc.connections c on c.business_id=s.business_id and c.store_id=s.id and c.status='active'
         join mc.connection_secrets cs on cs.business_id=c.business_id and cs.connection_id=c.id
         join mc.sync_streams ss on ss.business_id=s.business_id and ss.store_id=s.id and ss.source_type='catalog' and ss.status='active'
        where s.business_id=$1 and s.id=$2 and s.status='active'
        for update of ss`,[businessId,storeId]
    )).rows[0];
    if(!row)throw new Error('catalog_connection_unavailable');
    if(!force&&row.next_run_at&&new Date(row.next_run_at)>new Date())return {started:false,reason:'not_due'};
    const running=(await client.query(`select id,started_at from mc.sync_runs where stream_id=$1 and status='running'`,[row.stream_id])).rows[0];
    if(running&&new Date(running.started_at)>new Date(Date.now()-30*60*1000))return {started:false,reason:'running'};
    if(running)await client.query(`update mc.sync_runs set status='failed',finished_at=now(),error_code='catalog_interrupted' where id=$1`,[running.id]);
    const run=(await client.query(
      `insert into mc.sync_runs(business_id,store_id,stream_id,status,started_at) values($1,$2,$3,'running',now()) returning id`,
      [businessId,storeId,row.stream_id]
    )).rows[0];
    await client.query(`update mc.sync_streams set next_run_at=null where id=$1`,[row.stream_id]);
    return {started:true,business_id:businessId,store_id:storeId,stream_id:row.stream_id,run_id:run.id,ciphertext:row.ciphertext,nonce:row.nonce,auth_tag:row.auth_tag};
  });
}

export async function completeCatalogSync(userId,job,catalog){
  return withOwnedBusinessContext(userId,async(client,businessId)=>{
    if(businessId!==job.business_id)throw new Error('catalog_context_mismatch');
    const serialized=JSON.stringify(catalog.cards),checksum=createHash('sha256').update(serialized).digest('hex');
    const document=(await client.query(
      `insert into mc.source_documents(business_id,store_id,sync_run_id,origin,document_type,external_document_id,checksum,completeness)
       values($1,$2,$3,'wb_api','catalog',$4,$5,'complete') returning id`,
      [businessId,job.store_id,job.run_id,`catalog:${Date.now()}`,checksum]
    )).rows[0];
    const articleIds=[],variantIds=[];
    for(const card of catalog.cards){
      articleIds.push(card.nmId);
      const product=(await client.query(
        `insert into mc.products(business_id,store_id,wb_article,seller_article,title,image_url,status)
         values($1,$2,$3,$4,$5,$6,'active')
         on conflict(store_id,wb_article) do update set seller_article=excluded.seller_article,title=excluded.title,image_url=excluded.image_url,status='active'
           where (mc.products.seller_article,mc.products.title,mc.products.image_url,mc.products.status) is distinct from (excluded.seller_article,excluded.title,excluded.image_url,excluded.status)
         returning id`,[businessId,job.store_id,card.nmId,card.vendorCode,card.title,card.imageUrl]
      )).rows[0]??(await client.query(`select id from mc.products where store_id=$1 and wb_article=$2`,[job.store_id,card.nmId])).rows[0];
      for(const variant of card.variants){
        variantIds.push(variant.externalId);
        const saved=(await client.query(
          `insert into mc.variants(business_id,store_id,product_id,external_variant_id,size_label,color_label,attributes,status)
           values($1,$2,$3,$4,$5,$6,$7::jsonb,'active')
           on conflict(store_id,product_id,external_variant_id) do update set size_label=excluded.size_label,color_label=excluded.color_label,attributes=excluded.attributes,status='active'
             where (mc.variants.size_label,mc.variants.color_label,mc.variants.attributes,mc.variants.status) is distinct from (excluded.size_label,excluded.color_label,excluded.attributes,excluded.status)
           returning id`,[businessId,job.store_id,product.id,variant.externalId,variant.sizeLabel,variant.colorLabel,JSON.stringify(variant.attributes)]
        )).rows[0]??(await client.query(`select id from mc.variants where store_id=$1 and product_id=$2 and external_variant_id=$3`,[job.store_id,product.id,variant.externalId])).rows[0];
        for(const barcode of variant.barcodes)await client.query(
          `insert into mc.variant_identifiers(business_id,store_id,variant_id,identifier_type,identifier_value)
           values($1,$2,$3,'barcode',$4) on conflict do nothing`,[businessId,job.store_id,saved.id,barcode]
        );
      }
    }
    if(articleIds.length)await client.query(`update mc.products set status='archived' where store_id=$1 and status='active' and not(wb_article=any($2::bigint[]))`,[job.store_id,articleIds]);
    else await client.query(`update mc.products set status='archived' where store_id=$1 and status='active'`,[job.store_id]);
    if(variantIds.length)await client.query(`update mc.variants set status='archived' where store_id=$1 and status='active' and not(external_variant_id=any($2::text[]))`,[job.store_id,variantIds]);
    else await client.query(`update mc.variants set status='archived' where store_id=$1 and status='active'`,[job.store_id]);
    await client.query(`update mc.sync_runs set status='succeeded',finished_at=now(),error_code=null where id=$1 and status='running'`,[job.run_id]);
    await client.query(`update mc.sync_streams set cursor=$2::jsonb,last_success_at=now(),next_run_at=now()+interval '6 hours' where id=$1`,[job.stream_id,JSON.stringify(catalog.cursor??{})]);
    return {documentId:document.id,productCount:catalog.cards.length};
  });
}

export async function failCatalogSync(userId,job,errorCode){
  return withOwnedBusinessContext(userId,async(client,businessId)=>{
    await client.query(`update mc.sync_runs set status='failed',finished_at=now(),error_code=$2 where id=$1 and business_id=$3 and status='running'`,[job.run_id,String(errorCode).slice(0,100),businessId]);
    await client.query(`update mc.sync_streams set next_run_at=now()+interval '5 minutes' where id=$1 and business_id=$2`,[job.stream_id,businessId]);
    if(errorCode==='catalog_unauthorized')await client.query(`update mc.connections set status='invalid',last_checked_at=now() where business_id=$1 and store_id=$2`,[businessId,job.store_id]);
  });
}

export async function getCatalogState(userId,storeId){
  return withOwnedBusinessContext(userId,async(client,businessId)=>{
    const stream=(await client.query(
      `select ss.last_success_at,ss.next_run_at,r.status as run_status,r.error_code,r.started_at,r.finished_at
         from mc.sync_streams ss
         left join lateral (select status,error_code,started_at,finished_at from mc.sync_runs where stream_id=ss.id order by created_at desc limit 1) r on true
        where ss.business_id=$1 and ss.store_id=$2 and ss.source_type='catalog'`,[businessId,storeId]
    )).rows[0]??null;
    const products=(await client.query(
      `select p.id,p.wb_article,p.seller_article,p.title,p.image_url,p.status,
              exists(select 1 from mc.product_selection_items i where i.business_id=p.business_id and i.store_id=p.store_id and i.product_id=p.id) as selected
         from mc.products p where p.business_id=$1 and p.store_id=$2
          and (p.status='active' or exists(select 1 from mc.product_selection_items i where i.business_id=p.business_id and i.store_id=p.store_id and i.product_id=p.id))
        order by coalesce(p.title,p.seller_article),p.wb_article`,[businessId,storeId]
    )).rows;
    const selection=(await client.query(`select id,status,product_limit_snapshot from mc.product_selections where business_id=$1 and store_id=$2`,[businessId,storeId])).rows[0]??null;
    const plan=(await client.query(`select v.product_limit from mc.subscriptions s join mc.billing_plan_versions v on v.id=s.plan_version_id where s.business_id=$1`,[businessId])).rows[0];
    return {stream,products,selection,productLimit:plan?.product_limit??0};
  });
}

export async function confirmProductSelection(userId,{storeId,productIds}){
  return withOwnedBusinessContext(userId,async(client,businessId,role)=>{
    if(!['owner','editor'].includes(role))throw new Error('selection_write_forbidden');
    const document=(await client.query(
      `select id from mc.source_documents where business_id=$1 and store_id=$2 and origin='wb_api' and document_type='catalog' and completeness='complete' order by received_at desc limit 1`,
      [businessId,storeId]
    )).rows[0];
    if(!document)throw new Error('catalog_not_ready');
    return (await client.query(`select mc.confirm_product_selection($1,$2,$3::uuid[]) as id`,[storeId,document.id,productIds])).rows[0];
  });
}

export async function addProductsToSelection(userId,{storeId,productIds}){
  return withOwnedBusinessContext(userId,async(client,businessId,role)=>{
    if(!['owner','editor'].includes(role))throw new Error('selection_write_forbidden');
    return (await client.query(`select mc.add_products_to_selection($1,$2::uuid[]) as id`,[storeId,productIds])).rows[0];
  });
}

export async function beginFinancialSync(userId,storeId,{force=false,initialRange,recentRange}={}){
  return withOwnedBusinessContext(userId,async(client,businessId)=>{
    const row=(await client.query(
      `select ss.id as stream_id,ss.next_run_at,ss.last_success_at,cs.ciphertext,cs.nonce,cs.auth_tag,s.external_account_id as seller_id,
              exists(select 1 from mc.product_selections ps where ps.business_id=s.business_id and ps.store_id=s.id and ps.status='confirmed') as selected
         from mc.stores s
         join mc.connections c on c.business_id=s.business_id and c.store_id=s.id and c.status='active'
         join mc.connection_secrets cs on cs.business_id=c.business_id and cs.connection_id=c.id
         join mc.sync_streams ss on ss.business_id=s.business_id and ss.store_id=s.id and ss.source_type='financial_reports' and ss.status='active'
        where s.business_id=$1 and s.id=$2 and s.status='active'
        for update of ss`,[businessId,storeId]
    )).rows[0];
    if(!row)throw new Error('financial_connection_unavailable');
    if(!row.selected)return {started:false,reason:'selection_required'};
    if(!force&&row.next_run_at&&new Date(row.next_run_at)>new Date())return {started:false,reason:'not_due'};
    const running=(await client.query(`select id,started_at from mc.sync_runs where stream_id=$1 and status='running'`,[row.stream_id])).rows[0];
    if(running&&new Date(running.started_at)>new Date(Date.now()-3*60*60*1000))return {started:false,reason:'running'};
    if(running)await client.query(`update mc.sync_runs set status='failed',finished_at=now(),error_code='financial_interrupted' where id=$1`,[running.id]);
    const range=row.last_success_at?recentRange:initialRange;
    if(!range?.dateFrom||!range?.dateTo)throw new Error('financial_invalid_request');
    const run=(await client.query(
      `insert into mc.sync_runs(business_id,store_id,stream_id,requested_from,requested_to,status,started_at,progress)
       values($1,$2,$3,$4,$5,'running',now(),'{"stage":"loading","pages":0,"rows":0}') returning id`,
      [businessId,storeId,row.stream_id,range.dateFrom,range.dateTo]
    )).rows[0];
    await client.query(`update mc.sync_streams set next_run_at=null where id=$1`,[row.stream_id]);
    return {started:true,business_id:businessId,store_id:storeId,stream_id:row.stream_id,run_id:run.id,date_from:range.dateFrom,date_to:range.dateTo,seller_id:row.seller_id,ciphertext:row.ciphertext,nonce:row.nonce,auth_tag:row.auth_tag};
  });
}

export async function reserveFinancialRequestSlot(userId,job,delaySeconds){
  if(!Number.isInteger(delaySeconds)||delaySeconds<65||delaySeconds>75)throw new Error('financial_invalid_rate_delay');
  return withOwnedBusinessContext(userId,async(client,businessId)=>{
    if(businessId!==job.business_id||!job.seller_id)throw new Error('financial_context_mismatch');
    const rateKey=createHash('sha256').update(`wb:finance:sales-reports:${job.seller_id}`).digest('hex');
    const slot=(await client.query(
      `insert into mc.wb_api_request_slots(rate_key,next_allowed_at)
       values($1,clock_timestamp()+make_interval(secs=>$2))
       on conflict(rate_key) do update
         set next_allowed_at=greatest(mc.wb_api_request_slots.next_allowed_at,clock_timestamp())+make_interval(secs=>$2),
             updated_at=clock_timestamp()
       returning next_allowed_at-make_interval(secs=>$2) as scheduled_at,next_allowed_at`,
      [rateKey,delaySeconds]
    )).rows[0];
    return {scheduledAt:slot.scheduled_at,nextAllowedAt:slot.next_allowed_at,waitMs:Math.max(0,new Date(slot.scheduled_at).getTime()-Date.now())};
  });
}

export async function updateFinancialSyncProgress(userId,job,progress){
  return withOwnedBusinessContext(userId,async(client,businessId)=>{
    if(businessId!==job.business_id)throw new Error('financial_context_mismatch');
    await client.query(`update mc.sync_runs set progress=$2::jsonb where id=$1 and business_id=$3 and status='running'`,[job.run_id,JSON.stringify(progress),businessId]);
  });
}

export async function completeFinancialSync(userId,job,{documentId,reports,objects=[]}){
  return withOwnedBusinessContext(userId,async(client,businessId)=>{
    if(businessId!==job.business_id)throw new Error('financial_context_mismatch');
    const documentChecksum=createHash('sha256').update(stableJson(reports.map(report=>({id:report.externalReportId,checksum:report.checksum})))).digest('hex');
    await client.query(
      `insert into mc.source_documents(id,business_id,store_id,sync_run_id,origin,document_type,external_document_id,checksum,completeness)
       values($1,$2,$3,$4,'wb_api','weekly_realization',$5,$6,'complete')`,
      [documentId,businessId,job.store_id,job.run_id,`financial:${job.date_from}:${job.date_to}:${documentChecksum.slice(0,16)}`,documentChecksum]
    );
    for(const object of objects)await client.query(
      `insert into mc.source_objects(business_id,store_id,document_id,storage_key,part_number,byte_size,checksum,content_type)
       values($1,$2,$3,$4,$5,$6,$7,$8)`,
      [businessId,job.store_id,documentId,object.storageKey,object.partNumber,object.byteSize,object.checksum,object.contentType]
    );
    const method=(await client.query(`select id from mc.method_versions where code='wb_finance_import' and implementation_version=$1 order by version_no desc limit 1`,[financialParserVersion])).rows[0];
    if(!method)throw new Error('financial_method_missing');
    let insertedReports=0,unchangedReports=0,insertedRows=0,issues=0;
    for(const source of reports){
      let report=(await client.query(`select id,period_start,period_end from mc.reports where store_id=$1 and report_type='weekly_realization' and external_report_id=$2`,[job.store_id,source.externalReportId])).rows[0];
      if(report&&(String(report.period_start).slice(0,10)!==source.periodStart||String(report.period_end).slice(0,10)!==source.periodEnd))throw new Error('financial_report_period_mismatch');
      if(!report)report=(await client.query(
        `insert into mc.reports(business_id,store_id,external_report_id,report_type,period_start,period_end)
         values($1,$2,$3,'weekly_realization',$4,$5) returning id,period_start,period_end`,
        [businessId,job.store_id,source.externalReportId,source.periodStart,source.periodEnd]
      )).rows[0];
      const same=(await client.query(`select id,status from mc.report_versions where report_id=$1 and checksum=$2`,[report.id,source.checksum])).rows[0];
      if(same){unchangedReports++;continue;}
      const versionNo=(await client.query(`select coalesce(max(version_no),0)+1 as n from mc.report_versions where report_id=$1`,[report.id])).rows[0].n;
      const version=(await client.query(
        `insert into mc.report_versions(business_id,store_id,report_id,document_id,version_no,checksum,parser_version)
         values($1,$2,$3,$4,$5,$6,$7) returning id`,
        [businessId,job.store_id,report.id,documentId,versionNo,source.checksum,financialParserVersion]
      )).rows[0];
      let rowNumber=0;
      for(const sourceRow of source.rows){
        rowNumber++;
        const reportRow=(await client.query(
          `insert into mc.report_rows(business_id,store_id,report_version_id,external_row_key,row_number,raw_data,row_checksum)
           values($1,$2,$3,$4,$5,$6::jsonb,$7) returning id`,
          [businessId,job.store_id,version.id,sourceRow.externalRowKey,rowNumber,JSON.stringify(sourceRow.rawData),sourceRow.rowChecksum]
        )).rows[0];
        const normalized=normalizeFinancialOperation(sourceRow.rawData);
        let product=null,variant=null;
        if(normalized.wbArticle&&/^\d+$/.test(normalized.wbArticle))product=(await client.query(
          `select id from mc.products where business_id=$1 and store_id=$2 and wb_article=$3::bigint`,
          [businessId,job.store_id,normalized.wbArticle]
        )).rows[0]??null;
        if(product&&normalized.variantBarcode)variant=(await client.query(
          `select v.id from mc.variants v join mc.variant_identifiers i on i.business_id=v.business_id and i.store_id=v.store_id and i.variant_id=v.id
            where v.business_id=$1 and v.store_id=$2 and v.product_id=$3 and i.identifier_type='barcode' and i.identifier_value=$4 limit 1`,
          [businessId,job.store_id,product.id,normalized.variantBarcode]
        )).rows[0]??null;
        const addIssue=async(code,severity,details)=>{issues++;await client.query(
          `insert into mc.data_issues(business_id,store_id,document_id,report_row_id,code,severity,details)
           values($1,$2,$3,$4,$5,$6,$7::jsonb)`,
          [businessId,job.store_id,documentId,reportRow.id,code,severity,JSON.stringify(details)]
        );};
        if(normalized.wbArticle&&!product)await addIssue('financial_product_not_in_catalog','warning',{wbArticle:normalized.wbArticle});
        if(product&&normalized.variantBarcode&&!variant)await addIssue('financial_variant_not_matched','warning',{wbArticle:normalized.wbArticle});
        if(normalized.operationType==='unclassified')await addIssue('financial_operation_unclassified','blocking',{docTypeName:String(sourceRow.rawData.docTypeName??''),sellerOperName:String(sourceRow.rawData.sellerOperName??'')});
        const sourceOperationKey=`${source.externalReportId}/${sourceRow.externalRowKey}`;
        let operation=(await client.query(`select id from mc.operations where store_id=$1 and source_code='wb_finance' and source_operation_key=$2`,[job.store_id,sourceOperationKey])).rows[0];
        if(!operation)operation=(await client.query(
          `insert into mc.operations(business_id,store_id,source_code,source_operation_key) values($1,$2,'wb_finance',$3) returning id`,
          [businessId,job.store_id,sourceOperationKey]
        )).rows[0];
        const operationVersionNo=(await client.query(`select coalesce(max(version_no),0)+1 as n from mc.operation_versions where operation_id=$1`,[operation.id])).rows[0].n;
        const operationVersion=(await client.query(
          `insert into mc.operation_versions(business_id,store_id,operation_id,report_row_id,version_no,srid,operation_type,product_id,variant_id,accounting_date,source_occurred_at,quantity,currency)
           values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'RUB') returning id`,
          [businessId,job.store_id,operation.id,reportRow.id,operationVersionNo,normalized.srid,normalized.operationType,product?.id??null,variant?.id??null,normalized.accountingDate,normalized.sourceOccurredAt,normalized.quantity]
        )).rows[0];
        for(const component of normalized.components)await client.query(
          `insert into mc.financial_components(business_id,store_id,operation_version_id,component_key,category_code,amount_signed,method_version_id,source_field)
           values($1,$2,$3,$4,$5,$6,$7,$8)`,
          [businessId,job.store_id,operationVersion.id,component.componentKey,component.categoryCode,component.amountSigned,method.id,component.sourceField]
        );
        insertedRows++;
      }
      await client.query(`update mc.report_versions set status='validated' where id=$1`,[version.id]);
      await client.query(`update mc.report_versions set status='accepted',accepted_at=now() where id=$1`,[version.id]);
      await client.query(`update mc.reports set current_version_id=$1 where id=$2`,[version.id,report.id]);
      insertedReports++;
    }
    await client.query(
      `insert into mc.coverage_intervals(business_id,store_id,stream_id,source_document_id,date_from,date_to,status)
       values($1,$2,$3,$4,$5,$6,'complete')`,
      [businessId,job.store_id,job.stream_id,documentId,job.date_from,job.date_to]
    );
    const progress={stage:'complete',reports:reports.length,insertedReports,unchangedReports,rows:insertedRows,issues};
    await client.query(`update mc.sync_runs set status='succeeded',finished_at=now(),error_code=null,progress=$2::jsonb where id=$1 and status='running'`,[job.run_id,JSON.stringify(progress)]);
    await client.query(`update mc.sync_streams set cursor=$2::jsonb,last_success_at=now(),next_run_at=now()+interval '24 hours' where id=$1`,[job.stream_id,JSON.stringify({dateTo:job.date_to,reports:reports.length,rows:insertedRows})]);
    return {documentId,insertedReports,unchangedReports,insertedRows,issues};
  });
}

export async function failFinancialSync(userId,job,errorCode,{retryDelaySeconds=70}={}){
  if(!Number.isInteger(retryDelaySeconds)||retryDelaySeconds<65||retryDelaySeconds>75)throw new Error('financial_invalid_rate_delay');
  return withOwnedBusinessContext(userId,async(client,businessId)=>{
    const code=String(errorCode).slice(0,100);
    await client.query(`update mc.sync_runs set status='failed',finished_at=now(),error_code=$2,progress=jsonb_set(progress,'{stage}','"failed"') where id=$1 and business_id=$3 and status='running'`,[job.run_id,code,businessId]);
    if(['financial_unauthorized','financial_payment_required','financial_invalid_request','financial_token_type_unsupported'].includes(code))await client.query(`update mc.sync_streams set status='blocked',next_run_at=null where id=$1 and business_id=$2`,[job.stream_id,businessId]);
    else if(code==='financial_rate_limited')await client.query(`update mc.sync_streams set next_run_at=now()+make_interval(secs=>$3) where id=$1 and business_id=$2`,[job.stream_id,businessId,retryDelaySeconds]);
    else await client.query(`update mc.sync_streams set next_run_at=now()+interval '15 minutes' where id=$1 and business_id=$2`,[job.stream_id,businessId]);
  });
}

export async function getFinancialSyncState(userId,storeId){
  return withOwnedBusinessContext(userId,async(client,businessId)=>(await client.query(
    `select ss.status as stream_status,ss.last_success_at,ss.next_run_at,
            r.status as run_status,r.error_code,r.started_at,r.finished_at,r.requested_from,r.requested_to,r.progress,
            (select max(ci.date_to) from mc.coverage_intervals ci where ci.business_id=ss.business_id and ci.store_id=ss.store_id and ci.stream_id=ss.id and ci.status='complete') as coverage_to,
            (select count(*)::int from mc.reports rp where rp.business_id=ss.business_id and rp.store_id=ss.store_id and rp.current_version_id is not null) as report_count,
            (select count(*)::int from mc.data_issues di where di.business_id=ss.business_id and di.store_id=ss.store_id and di.status='open') as issue_count,
            exists(select 1 from mc.product_selections ps where ps.business_id=ss.business_id and ps.store_id=ss.store_id and ps.status='confirmed') as selection_ready
       from mc.sync_streams ss
       left join lateral (select status,error_code,started_at,finished_at,requested_from,requested_to,progress from mc.sync_runs where stream_id=ss.id order by created_at desc limit 1) r on true
      where ss.business_id=$1 and ss.store_id=$2 and ss.source_type='financial_reports'`,[businessId,storeId]
  )).rows[0]??null);
}

export async function updateProfile(userId, displayName) {
  const cleanName = String(displayName ?? '').trim().replace(/\s+/g, ' ');
  if (cleanName.length < 2 || cleanName.length > 80) throw new Error('invalid_display_name');
  return withUserContext(userId, async client => (await client.query(
    `update mc.users set display_name=$2 where id=$1 returning id,display_name,email`,
    [userId, cleanName]
  )).rows[0]);
}

export async function getPasswordCredential(userId) {
  return withUserContext(userId, async client => (await client.query(
    `select password_hash,password_changed_at from mc.auth_password_credentials where user_id=$1`,
    [userId]
  )).rows[0] ?? null);
}

export async function replacePassword(userId, passwordHash, currentTokenHash) {
  return withUserContext(userId, async client => {
    const updated = await client.query(
      `update mc.auth_password_credentials
          set password_hash=$2,password_changed_at=now()
        where user_id=$1`,
      [userId, passwordHash]
    );
    if (updated.rowCount !== 1) throw new Error('password_login_not_available');
    await client.query(
      `delete from mc.auth_sessions where user_id=$1 and token_hash<>$2`,
      [userId, currentTokenHash]
    );
  });
}

export async function markVerified(id){await withUserContext(id, client => client.query(`update mc.users set email_verified_at=now() where id=$1`,[id]));}
export async function takeLimit(key,limit,minutes=15){return (await pool.query(`insert into mc.auth_rate_limits(bucket_key,attempts,window_started_at,expires_at) values($1,1,now(),now()+make_interval(mins=>$3)) on conflict(bucket_key) do update set attempts=case when mc.auth_rate_limits.expires_at<=now() then 1 else mc.auth_rate_limits.attempts+1 end,window_started_at=case when mc.auth_rate_limits.expires_at<=now() then now() else mc.auth_rate_limits.window_started_at end,expires_at=case when mc.auth_rate_limits.expires_at<=now() then now()+make_interval(mins=>$3) else mc.auth_rate_limits.expires_at end returning attempts,attempts<=$2 allowed`,[key,limit,minutes])).rows[0];}
export async function saveOauthState(hash){await pool.query(`insert into mc.auth_oauth_states(state_hash,provider,expires_at) values($1,'yandex',now()+interval '10 minutes')`,[hash]);}
export async function consumeOauthState(hash){return (await pool.query(`delete from mc.auth_oauth_states where state_hash=$1 and expires_at>now() returning state_hash`,[hash])).rowCount===1;}
export async function findOrCreateYandexUser({subject,email,name}){const old=(await pool.query(`select u.* from mc.auth_identities i join mc.users u on u.id=i.user_id where i.provider='yandex' and i.subject=$1`,[subject])).rows[0];if(old)return old;const c=await pool.connect();try{await c.query('begin');const u=(await c.query(`insert into mc.users(display_name,email,email_verified_at) values($1,$2,now()) returning *`,[name,email])).rows[0];await c.query(`insert into mc.auth_identities(user_id,provider,subject) values($1,'yandex',$2)`,[u.id,subject]);const b=(await c.query(`insert into mc.businesses(name) values($1) returning id`,[`Бизнес ${name}`])).rows[0];await c.query(`insert into mc.memberships(business_id,user_id,role) values($1,$2,'owner')`,[b.id,u.id]);await c.query('commit');return u;}catch(e){await c.query('rollback');throw e;}finally{c.release();}}

export async function findPasswordUser(email) {
  const client = await pool.connect();
  try {
  await client.query('begin');
  await client.query("select set_config('app.auth_email',$1,true)", [email]);
  const identity = (await client.query("select user_id from mc.auth_identities where provider='password' and subject=$1", [email])).rows[0];
  if (!identity) { await client.query('commit'); return null; }
  await client.query("select set_config('app.user_id',$1,true)", [identity.user_id]);
  const result = await client.query(
    `select u.id,u.display_name,u.email,u.status,c.password_hash
       from mc.auth_identities i
       join mc.users u on u.id=i.user_id
       join mc.auth_password_credentials c on c.user_id=u.id
      where i.provider='password' and i.subject=$1`, [email]
  );
  await client.query('commit');
  return result.rows[0] ?? null;
  } catch (error) { await client.query('rollback'); throw error; }
  finally { client.release(); }
}

export async function saveSession({ userId, tokenHash, expiresAt }) {
  await pool.query(`insert into mc.auth_sessions(user_id,token_hash,expires_at) values($1,$2,$3)`, [userId, tokenHash, expiresAt]);
}

export async function findSession(tokenHash) {
  const session = (await pool.query('select user_id from mc.auth_sessions where token_hash=$1 and expires_at>now()', [tokenHash])).rows[0];
  if (!session) return null;
  const result = await withUserContext(session.user_id, client => client.query(
    `select s.id,u.id as user_id,u.display_name,u.email
       from mc.auth_sessions s join mc.users u on u.id=s.user_id
      where s.token_hash=$1 and s.expires_at>now() and u.status='active' and ($2 or u.email_verified_at is not null)`, [tokenHash, !requiresEmailVerification()]
  ));
  return result.rows[0] ?? null;
}

export async function deleteSession(tokenHash) {
  await pool.query(`delete from mc.auth_sessions where token_hash=$1`, [tokenHash]);
}

export async function hasActiveWbConnection(userId){return (await pool.query(`select exists(select 1 from mc.memberships m join mc.stores s on s.business_id=m.business_id join mc.connections c on c.business_id=s.business_id and c.store_id=s.id where m.user_id=$1 and s.marketplace_code='wb' and s.status='active' and c.status='active') allowed`,[userId])).rows[0].allowed;}
