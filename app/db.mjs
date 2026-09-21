import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { createHash, randomUUID } from 'node:crypto';
import { requiresEmailVerification } from './auth.mjs';
import { financialParserVersion, financialReportPeriodMatches, normalizeFinancialOperation, stableJson } from './finance.mjs';
import { calculateFinancialResult, createInputFingerprint } from './calculation.mjs';

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

export async function getCostState(userId,storeId){
  return withOwnedBusinessContext(userId,async(client,businessId)=>{
    const products=(await client.query(
      `select p.id,p.wb_article,p.seller_article,p.title,p.image_url,
              v.id as variant_id,v.external_variant_id,v.size_label,v.color_label,
              barcode.identifier_value as barcode,cv.id as cost_version_id,
              cv.unit_cost::text,c.effective_from
         from mc.product_selection_items i
         join mc.products p on (p.business_id,p.store_id,p.id)=(i.business_id,i.store_id,i.product_id)
         join mc.variants v on (v.business_id,v.store_id,v.product_id)=(p.business_id,p.store_id,p.id) and v.status='active'
         left join lateral (
           select identifier_value from mc.variant_identifiers vi
            where (vi.business_id,vi.store_id,vi.variant_id)=(v.business_id,v.store_id,v.id)
              and vi.identifier_type='barcode' and vi.valid_to is null
            order by vi.valid_from desc limit 1
         ) barcode on true
         left join lateral (
           select candidate.id,candidate.effective_from,candidate.current_version_id
             from mc.variant_costs candidate
            where (candidate.business_id,candidate.store_id,candidate.product_id,candidate.variant_id)=(v.business_id,v.store_id,v.product_id,v.id)
              and candidate.effective_from<=current_date
            order by candidate.effective_from desc limit 1
         ) c on true
         left join mc.cost_versions cv on (cv.business_id,cv.store_id,cv.cost_id,cv.id)=(v.business_id,v.store_id,c.id,c.current_version_id)
        where i.business_id=$1 and i.store_id=$2
        order by coalesce(p.title,p.seller_article),p.wb_article,v.size_label,v.external_variant_id`,
      [businessId,storeId]
    )).rows;
    const grouped=[];
    const flatRows=[];
    for(const row of products){
      let product=grouped.at(-1);
      if(!product||product.id!==row.id){
        product={id:row.id,wb_article:String(row.wb_article),seller_article:row.seller_article,title:row.title,image_url:row.image_url,variants:[]};
        grouped.push(product);
      }
      const variant={id:row.variant_id,external_variant_id:row.external_variant_id,size_label:row.size_label,color_label:row.color_label,barcode:row.barcode,unit_cost:row.unit_cost,effective_from:row.effective_from,cost_version_id:row.cost_version_id};
      product.variants.push(variant);
      flatRows.push({product_id:product.id,wb_article:product.wb_article,seller_article:product.seller_article,title:product.title,image_url:product.image_url,...variant});
    }
    const lastImport=(await client.query(
      `select b.id,d.external_document_id as file_name,b.status,b.created_at,b.applied_at,
              count(r.id)::int as total_rows,
              count(*) filter(where r.status='applied')::int as applied_rows,
              count(*) filter(where r.status in ('skipped','duplicate'))::int as skipped_rows,
              count(*) filter(where r.status='invalid')::int as invalid_rows
         from mc.import_batches b
         join mc.source_documents d on (d.business_id,d.store_id,d.id)=(b.business_id,b.store_id,b.document_id)
         left join mc.import_rows r on (r.business_id,r.store_id,r.batch_id)=(b.business_id,b.store_id,b.id)
        where b.business_id=$1 and b.store_id=$2 and b.kind='costs'
        group by b.id,d.external_document_id,b.status,b.created_at,b.applied_at
        order by b.created_at desc limit 1`,[businessId,storeId]
    )).rows[0]??null;
    return {products:grouped,rows:flatRows,summary:{totalVariants:flatRows.length,configuredVariants:flatRows.filter(row=>row.unit_cost!=null).length},lastImport};
  });
}

const costError=(rowNumber,code,details={})=>({rowNumber,code,...(Object.keys(details).length?{details}:{})});
const costAmount=value=>{
  const text=String(value??'').trim();
  if(!/^(?:0|[1-9]\d{0,15})(?:\.\d{1,4})?$/.test(text))return null;
  const [whole,fraction='']=text.split('.');
  return `${whole}.${fraction.padEnd(4,'0')}`;
};
const costDate=value=>{
  const text=String(value??'').trim();
  if(!/^\d{4}-\d{2}-\d{2}$/.test(text))return null;
  const parsed=new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime())&&parsed.toISOString().slice(0,10)===text?text:null;
};

export async function importVariantCosts(userId,{storeId,fileName,checksum,rows}){
  const cleanName=String(fileName??'').trim().slice(0,255);
  const cleanChecksum=String(checksum??'').trim().toLowerCase();
  if(!storeId||!cleanName||!Array.isArray(rows)||!rows.length||rows.length>10000||!/^[a-f0-9]{64}$/.test(cleanChecksum))throw new Error('cost_import_invalid');
  return withOwnedBusinessContext(userId,async(client,businessId,role)=>{
    if(!['owner','editor'].includes(role))throw new Error('cost_write_forbidden');
    const store=(await client.query(`select id from mc.stores where business_id=$1 and id=$2 and status='active'`,[businessId,storeId])).rows[0];
    if(!store)throw new Error('store_not_found');
    const document=(await client.query(
      `insert into mc.source_documents(business_id,store_id,origin,document_type,external_document_id,checksum,completeness)
       values($1,$2,'user_file','variant_costs',$3,$4,'unknown') returning id`,
      [businessId,storeId,cleanName,cleanChecksum]
    )).rows[0];
    const batch=(await client.query(
      `insert into mc.import_batches(business_id,store_id,document_id,kind,uploaded_by,status,column_mapping)
       values($1,$2,$3,'costs',$4,'validating',$5::jsonb) returning id`,
      [businessId,storeId,document.id,userId,JSON.stringify({fileName:cleanName,checksum:cleanChecksum})]
    )).rows[0];
    const variants=(await client.query(
      `select p.id as product_id,p.wb_article::text,v.id as variant_id,v.external_variant_id,
              array_remove(array_agg(vi.identifier_value),null) as barcodes
         from mc.product_selection_items i
         join mc.products p on (p.business_id,p.store_id,p.id)=(i.business_id,i.store_id,i.product_id)
         join mc.variants v on (v.business_id,v.store_id,v.product_id)=(p.business_id,p.store_id,p.id) and v.status='active'
         left join mc.variant_identifiers vi on (vi.business_id,vi.store_id,vi.variant_id)=(v.business_id,v.store_id,v.id)
           and vi.identifier_type='barcode' and vi.valid_to is null
        where i.business_id=$1 and i.store_id=$2
        group by p.id,p.wb_article,v.id,v.external_variant_id`,[businessId,storeId]
    )).rows;
    const byExternal=new Map(),byBarcode=new Map();
    for(const variant of variants){
      byExternal.set(`${variant.wb_article}\0${variant.external_variant_id}`,variant);
      for(const barcode of variant.barcodes)byBarcode.set(`${variant.wb_article}\0${barcode}`,variant);
    }
    const prepared=[],errors=[],rowNumbers=new Set(),storageRowNumbers=new Set(),targets=new Map();
    for(let index=0;index<rows.length;index++){
      const source=rows[index]??{},rowNumber=Number(source.rowNumber),rowErrors=[];
      if(!Number.isInteger(rowNumber)||rowNumber<1||rowNumber>2147483647||rowNumbers.has(rowNumber))rowErrors.push(costError(Number.isInteger(rowNumber)?rowNumber:index+1,'cost_row_number_invalid'));
      else rowNumbers.add(rowNumber);
      let storageRowNumber=Number.isInteger(rowNumber)&&rowNumber>0&&rowNumber<=2147483647&&!storageRowNumbers.has(rowNumber)?rowNumber:1;
      while(storageRowNumbers.has(storageRowNumber))storageRowNumber++;
      storageRowNumbers.add(storageRowNumber);
      const wbArticle=String(source.wbArticle??'').trim(),externalVariantId=String(source.externalVariantId??'').trim(),barcode=String(source.barcode??'').trim();
      const unitCost=costAmount(source.unitCost),effectiveFrom=costDate(source.effectiveFrom);
      if(!/^\d+$/.test(wbArticle)||wbArticle==='0')rowErrors.push(costError(rowNumber,'cost_invalid_article'));
      if(!externalVariantId&&!barcode)rowErrors.push(costError(rowNumber,'cost_variant_missing'));
      if(!unitCost)rowErrors.push(costError(rowNumber,'cost_invalid_amount'));
      if(!effectiveFrom)rowErrors.push(costError(rowNumber,'cost_invalid_date'));
      const external=externalVariantId?byExternal.get(`${wbArticle}\0${externalVariantId}`):null;
      const barcodeVariant=barcode?byBarcode.get(`${wbArticle}\0${barcode}`):null;
      let variant=external??barcodeVariant??null;
      if(external&&barcodeVariant&&external.variant_id!==barcodeVariant.variant_id){variant=null;rowErrors.push(costError(rowNumber,'cost_variant_mismatch'));}
      else if(((externalVariantId&&!external)||(barcode&&!barcodeVariant)||!variant)&&!rowErrors.some(error=>['cost_invalid_article','cost_variant_missing'].includes(error.code))){variant=null;rowErrors.push(costError(rowNumber,'cost_variant_not_found',{wbArticle,externalVariantId,barcode}));}
      const target=variant&&effectiveFrom?`${variant.variant_id}\0${effectiveFrom}`:null;
      let duplicate=false;
      if(target&&targets.has(target)){
        const prior=targets.get(target);
        if(prior.unitCost!==unitCost)rowErrors.push(costError(rowNumber,'cost_duplicate_conflict',{previousRowNumber:prior.rowNumber}));
        else duplicate=true;
      }else{
        if(target)targets.set(target,{rowNumber,unitCost});
      }
      prepared.push({duplicate,storageRowNumber,rowNumber,source,variant,wbArticle,externalVariantId,barcode,unitCost,effectiveFrom,target,rowErrors});
      errors.push(...rowErrors);
    }
    if(errors.length){
      for(const row of prepared)await client.query(
        `insert into mc.import_rows(business_id,store_id,batch_id,row_number,raw_values,status,errors)
         values($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb)`,
        [businessId,storeId,batch.id,row.storageRowNumber,JSON.stringify(row.source.rawValues??{wbArticle:row.wbArticle,externalVariantId:row.externalVariantId,barcode:row.barcode,unitCost:row.unitCost,effectiveFrom:row.effectiveFrom}),row.rowErrors.length?'invalid':row.duplicate?'duplicate':'valid',JSON.stringify(row.rowErrors)]
      );
      await client.query(`update mc.import_batches set status='failed' where id=$1`,[batch.id]);
      await client.query(`update mc.source_documents set completeness='partial' where id=$1`,[document.id]);
      return {ok:false,batchId:batch.id,documentId:document.id,applied:0,skipped:0,total:rows.length,errors};
    }
    await client.query(`update mc.import_batches set status='applying' where id=$1`,[batch.id]);
    let applied=0,skipped=0;
    for(const row of prepared){
      const rawValues=JSON.stringify(row.source.rawValues??{wbArticle:row.wbArticle,externalVariantId:row.externalVariantId,barcode:row.barcode,unitCost:row.unitCost,effectiveFrom:row.effectiveFrom});
      if(row.duplicate){
        await client.query(`insert into mc.import_rows(business_id,store_id,batch_id,row_number,raw_values,status) values($1,$2,$3,$4,$5::jsonb,'duplicate')`,[businessId,storeId,batch.id,row.storageRowNumber,rawValues]);
        skipped++;continue;
      }
      let cost=(await client.query(
        `insert into mc.variant_costs(business_id,store_id,product_id,variant_id,effective_from)
         values($1,$2,$3,$4,$5) on conflict(variant_id,effective_from) do nothing returning id,current_version_id`,
        [businessId,storeId,row.variant.product_id,row.variant.variant_id,row.effectiveFrom]
      )).rows[0];
      if(!cost)cost=(await client.query(
        `select id,current_version_id from mc.variant_costs where business_id=$1 and store_id=$2 and variant_id=$3 and effective_from=$4 for update`,
        [businessId,storeId,row.variant.variant_id,row.effectiveFrom]
      )).rows[0];
      else cost=(await client.query(`select id,current_version_id from mc.variant_costs where id=$1 for update`,[cost.id])).rows[0];
      const current=cost.current_version_id?(await client.query(`select unit_cost::text from mc.cost_versions where id=$1`,[cost.current_version_id])).rows[0]:null;
      if(current&&costAmount(current.unit_cost)===row.unitCost){
        await client.query(`insert into mc.import_rows(business_id,store_id,batch_id,row_number,raw_values,status) values($1,$2,$3,$4,$5::jsonb,'skipped')`,[businessId,storeId,batch.id,row.storageRowNumber,rawValues]);
        skipped++;continue;
      }
      const importRow=(await client.query(
        `insert into mc.import_rows(business_id,store_id,batch_id,row_number,raw_values,status)
         values($1,$2,$3,$4,$5::jsonb,'applied') returning id`,[businessId,storeId,batch.id,row.storageRowNumber,rawValues]
      )).rows[0];
      const versionNo=(await client.query(`select coalesce(max(version_no),0)+1 as n from mc.cost_versions where cost_id=$1`,[cost.id])).rows[0].n;
      const version=(await client.query(
        `insert into mc.cost_versions(business_id,store_id,cost_id,version_no,unit_cost,origin,import_row_id,changed_by)
         values($1,$2,$3,$4,$5,'file',$6,$7) returning id`,
        [businessId,storeId,cost.id,versionNo,row.unitCost,importRow.id,userId]
      )).rows[0];
      await client.query(`update mc.variant_costs set current_version_id=$1 where id=$2`,[version.id,cost.id]);
      applied++;
    }
    await client.query(`update mc.import_batches set status='completed',applied_at=now() where id=$1`,[batch.id]);
    await client.query(`update mc.source_documents set completeness='complete' where id=$1`,[document.id]);
    return {ok:true,batchId:batch.id,documentId:document.id,applied,skipped,total:rows.length};
  });
}

const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const expenseCategories=new Set(['packaging','external_promotion','agency_services','software_services','other_external']);
const recognitionMethods=new Set(['on_date','evenly_over_period']);
const taxRegimes=new Set(['usn_income','usn_income_expenses','osno']);
const vatModes=new Set(['unmodeled','exempt','general','special']);
const exactPositiveAmount=value=>{
  const text=String(value??'').trim().replace(',','.');
  if(!/^(?:0|[1-9]\d{0,15})(?:\.\d{1,4})?$/.test(text)||/^0(?:\.0{1,4})?$/.test(text))return null;
  const[whole,fraction='']=text.split('.');return`${whole}.${fraction.padEnd(4,'0')}`;
};
const exactDate=value=>{
  const text=String(value??'').trim();if(!/^\d{4}-\d{2}-\d{2}$/.test(text))return null;
  const parsed=new Date(`${text}T00:00:00Z`);return !Number.isNaN(parsed.getTime())&&parsed.toISOString().slice(0,10)===text?text:null;
};
const cleanText=(value,max)=>{const text=String(value??'').trim().replace(/\s+/g,' ');return text.length<=max?text:null;};
const percentRate=value=>{
  const text=String(value??'').trim().replace(',','.');
  return /^(?:100(?:\.0{1,6})?|(?:0|[1-9]\d?)(?:\.\d{1,6})?)$/.test(text)?text:null;
};

export async function getExpenseState(userId,storeId){
  return withOwnedBusinessContext(userId,async(client,businessId)=>{
    const store=(await client.query(`select id from mc.stores where business_id=$1 and id=$2 and status<>'archived'`,[businessId,storeId])).rows[0];
    if(!store)throw new Error('store_not_found');
    const products=(await client.query(
      `select p.id,p.wb_article::text,p.seller_article,p.title
         from mc.product_selection_items i
         join mc.products p on (p.business_id,p.store_id,p.id)=(i.business_id,i.store_id,i.product_id)
        where i.business_id=$1 and i.store_id=$2 order by coalesce(p.title,p.seller_article),p.wb_article`,[businessId,storeId]
    )).rows;
    const expenses=(await client.query(
      `select e.id,e.product_id,e.external_entry_key,e.created_at,v.id as version_id,v.version_no,v.category,
              v.amount::text,v.period_start,v.period_end,v.channel_name,v.description,v.recognition_method,v.state,v.origin,v.created_at as version_created_at,
              p.wb_article::text,p.seller_article,p.title
         from mc.expenses e
         join mc.expense_versions v on (v.business_id,v.store_id,v.expense_id,v.id)=(e.business_id,e.store_id,e.id,e.current_version_id)
         left join mc.products p on (p.business_id,p.store_id,p.id)=(e.business_id,e.store_id,e.product_id)
        where e.business_id=$1 and e.store_id=$2
        order by v.period_start desc,v.created_at desc,e.id`,[businessId,storeId]
    )).rows;
    const history=(await client.query(
      `select v.id as version_id,v.expense_id,v.version_no,v.category,v.amount::text,v.period_start,v.period_end,
              v.channel_name,v.description,v.recognition_method,v.state,v.origin,v.created_at
         from mc.expense_versions v join mc.expenses e on (e.business_id,e.store_id,e.id)=(v.business_id,v.store_id,v.expense_id)
        where v.business_id=$1 and v.store_id=$2 order by v.created_at desc,v.version_no desc`,[businessId,storeId]
    )).rows;
    const lastImport=(await client.query(
      `select b.id,d.external_document_id as file_name,b.status,b.created_at,b.applied_at,
              count(r.id)::int as total_rows,count(*) filter(where r.status='applied')::int as applied_rows,
              count(*) filter(where r.status in ('skipped','duplicate'))::int as skipped_rows,
              count(*) filter(where r.status='invalid')::int as invalid_rows
         from mc.import_batches b join mc.source_documents d on (d.business_id,d.store_id,d.id)=(b.business_id,b.store_id,b.document_id)
         left join mc.import_rows r on (r.business_id,r.store_id,r.batch_id)=(b.business_id,b.store_id,b.id)
        where b.business_id=$1 and b.store_id=$2 and b.kind='expenses'
        group by b.id,d.external_document_id,b.status,b.created_at,b.applied_at order by b.created_at desc limit 1`,[businessId,storeId]
    )).rows[0]??null;
    return{products,expenses,history,lastImport,summary:{active:expenses.filter(row=>row.state==='active').length,voided:expenses.filter(row=>row.state==='voided').length}};
  });
}

function validateExpenseInput(input){
  const category=String(input.category??'').trim(),amount=exactPositiveAmount(input.amount),periodStart=exactDate(input.periodStart),periodEnd=exactDate(input.periodEnd??input.periodStart),recognitionMethod=String(input.recognitionMethod??'').trim();
  const productId=String(input.productId??'').trim()||null,channelName=cleanText(input.channelName,120),description=cleanText(input.description,500);
  if(!expenseCategories.has(category))throw new Error('expense_category_invalid');
  if(!amount)throw new Error('expense_amount_invalid');
  if(!periodStart||!periodEnd||periodEnd<periodStart)throw new Error('expense_period_invalid');
  if(!recognitionMethods.has(recognitionMethod)||(recognitionMethod==='on_date'&&periodStart!==periodEnd))throw new Error('expense_recognition_invalid');
  if(productId&&!uuidPattern.test(productId))throw new Error('expense_product_invalid');
  if(channelName===null||description===null)throw new Error('expense_text_invalid');
  return{category,amount,periodStart,periodEnd,recognitionMethod,productId,channelName:channelName||null,description:description||null};
}

export async function saveExpense(userId,{storeId,expenseId,...input}){
  const value=validateExpenseInput(input),id=String(expenseId??'').trim()||null;
  if(id&&!uuidPattern.test(id))throw new Error('expense_id_invalid');
  return withOwnedBusinessContext(userId,async(client,businessId,role)=>{
    if(!['owner','editor'].includes(role))throw new Error('expense_write_forbidden');
    const store=(await client.query(`select id from mc.stores where business_id=$1 and id=$2 and status='active'`,[businessId,storeId])).rows[0];if(!store)throw new Error('store_not_found');
    if(value.productId){const product=(await client.query(`select product_id from mc.product_selection_items where business_id=$1 and store_id=$2 and product_id=$3`,[businessId,storeId,value.productId])).rows[0];if(!product)throw new Error('expense_product_invalid');}
    let expense=id?(await client.query(`select id,product_id,current_version_id from mc.expenses where business_id=$1 and store_id=$2 and id=$3 for update`,[businessId,storeId,id])).rows[0]:null;
    if(id&&!expense)throw new Error('expense_not_found');
    if(expense&&expense.product_id!==value.productId)throw new Error('expense_scope_immutable');
    if(!expense){const createdId=randomUUID();expense=(await client.query(
      `insert into mc.expenses(id,business_id,store_id,product_id,external_entry_key) values($1,$2,$3,$4,$5) returning id,product_id,current_version_id`,
      [createdId,businessId,storeId,value.productId,`manual:${createdId}`]
    )).rows[0];}
    const current=expense.current_version_id?(await client.query(`select category,amount::text,period_start::text,period_end::text,channel_name,description,recognition_method,state from mc.expense_versions where id=$1`,[expense.current_version_id])).rows[0]:null;
    if(current&&current.state==='active'&&current.category===value.category&&exactPositiveAmount(current.amount)===value.amount&&current.period_start===value.periodStart&&current.period_end===value.periodEnd&&(current.channel_name??null)===value.channelName&&(current.description??null)===value.description&&current.recognition_method===value.recognitionMethod)return{expenseId:expense.id,versionId:expense.current_version_id,changed:false};
    const versionNo=(await client.query(`select coalesce(max(version_no),0)+1 as n from mc.expense_versions where expense_id=$1`,[expense.id])).rows[0].n;
    const version=(await client.query(
      `insert into mc.expense_versions(business_id,store_id,expense_id,version_no,category,amount,period_start,period_end,channel_name,description,recognition_method,state,origin,changed_by)
       values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'active','manual',$12) returning id`,
      [businessId,storeId,expense.id,versionNo,value.category,value.amount,value.periodStart,value.periodEnd,value.channelName,value.description,value.recognitionMethod,userId]
    )).rows[0];
    await client.query(`update mc.expenses set current_version_id=$1 where id=$2`,[version.id,expense.id]);
    return{expenseId:expense.id,versionId:version.id,changed:true};
  });
}

export async function voidExpense(userId,{storeId,expenseId}){
  if(!uuidPattern.test(String(expenseId??'')))throw new Error('expense_id_invalid');
  return withOwnedBusinessContext(userId,async(client,businessId,role)=>{
    if(!['owner','editor'].includes(role))throw new Error('expense_write_forbidden');
    const row=(await client.query(
      `select e.id,e.current_version_id,v.* from mc.expenses e join mc.expense_versions v on v.id=e.current_version_id
        where e.business_id=$1 and e.store_id=$2 and e.id=$3 for update of e`,[businessId,storeId,expenseId]
    )).rows[0];if(!row)throw new Error('expense_not_found');if(row.state==='voided')return{expenseId,versionId:row.current_version_id,changed:false};
    const versionNo=(await client.query(`select coalesce(max(version_no),0)+1 as n from mc.expense_versions where expense_id=$1`,[expenseId])).rows[0].n;
    const version=(await client.query(
      `insert into mc.expense_versions(business_id,store_id,expense_id,version_no,category,amount,currency,period_start,period_end,channel_name,description,recognition_method,state,origin,changed_by)
       values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'voided','manual',$13) returning id`,
      [businessId,storeId,expenseId,versionNo,row.category,row.amount,row.currency,row.period_start,row.period_end,row.channel_name,row.description,row.recognition_method,userId]
    )).rows[0];await client.query(`update mc.expenses set current_version_id=$1 where id=$2`,[version.id,expenseId]);return{expenseId,versionId:version.id,changed:true};
  });
}

const expenseRowError=(rowNumber,code,details={})=>({rowNumber,code,...(Object.keys(details).length?{details}:{})});
const expenseComparable=value=>JSON.stringify([value.productId??null,value.category,value.amount,value.periodStart,value.periodEnd,value.recognitionMethod,value.channelName??null,value.description??null]);

export async function importExpenses(userId,{storeId,fileName,checksum,rows}){
  const cleanName=String(fileName??'').trim().slice(0,255),cleanChecksum=String(checksum??'').trim().toLowerCase();
  if(!storeId||!cleanName||!Array.isArray(rows)||!rows.length||rows.length>10000||!/^[a-f0-9]{64}$/.test(cleanChecksum))throw new Error('expense_import_invalid');
  return withOwnedBusinessContext(userId,async(client,businessId,role)=>{
    if(!['owner','editor'].includes(role))throw new Error('expense_write_forbidden');
    const store=(await client.query(`select id from mc.stores where business_id=$1 and id=$2 and status='active'`,[businessId,storeId])).rows[0];if(!store)throw new Error('store_not_found');
    const document=(await client.query(
      `insert into mc.source_documents(business_id,store_id,origin,document_type,external_document_id,checksum,completeness)
       values($1,$2,'user_file','additional_expenses',$3,$4,'unknown') returning id`,[businessId,storeId,cleanName,cleanChecksum]
    )).rows[0];
    const batch=(await client.query(
      `insert into mc.import_batches(business_id,store_id,document_id,kind,uploaded_by,status,column_mapping)
       values($1,$2,$3,'expenses',$4,'validating',$5::jsonb) returning id`,[businessId,storeId,document.id,userId,JSON.stringify({fileName:cleanName,checksum:cleanChecksum})]
    )).rows[0];
    const products=(await client.query(
      `select p.id,p.wb_article::text from mc.product_selection_items i join mc.products p on (p.business_id,p.store_id,p.id)=(i.business_id,i.store_id,i.product_id)
        where i.business_id=$1 and i.store_id=$2`,[businessId,storeId]
    )).rows,productsByArticle=new Map(products.map(row=>[row.wb_article,row]));
    const requestedIds=[...new Set(rows.map(row=>String(row?.expenseId??'').trim()).filter(Boolean))];
    const existingById=new Map();
    if(requestedIds.length){for(const row of(await client.query(`select id,product_id,current_version_id,external_entry_key from mc.expenses where business_id=$1 and store_id=$2 and id=any($3::uuid[])`,[businessId,storeId,requestedIds])).rows)existingById.set(row.id,row);}
    const prepared=[],errors=[],targets=new Map(),rowNumbers=new Set(),storageRowNumbers=new Set();
    for(let index=0;index<rows.length;index++){
      const source=rows[index]??{},rowNumber=Number(source.rowNumber),rowErrors=[];
      if(!Number.isInteger(rowNumber)||rowNumber<1||rowNumber>2147483647||rowNumbers.has(rowNumber))rowErrors.push(expenseRowError(Number.isInteger(rowNumber)?rowNumber:index+1,'expense_row_number_invalid'));else rowNumbers.add(rowNumber);
      let storageRowNumber=Number.isInteger(rowNumber)&&rowNumber>0&&rowNumber<=2147483647&&!storageRowNumbers.has(rowNumber)?rowNumber:1;while(storageRowNumbers.has(storageRowNumber))storageRowNumber++;storageRowNumbers.add(storageRowNumber);
      const expenseId=String(source.expenseId??'').trim(),wbArticle=String(source.wbArticle??'').trim(),product=wbArticle?productsByArticle.get(wbArticle):null;
      if(expenseId&&!uuidPattern.test(expenseId))rowErrors.push(expenseRowError(rowNumber,'expense_id_invalid'));
      if(wbArticle&&!/^\d+$/.test(wbArticle))rowErrors.push(expenseRowError(rowNumber,'expense_article_invalid'));
      if(wbArticle&&!product)rowErrors.push(expenseRowError(rowNumber,'expense_product_not_found',{wbArticle}));
      const existing=expenseId?existingById.get(expenseId):null;
      if(expenseId&&!existing)rowErrors.push(expenseRowError(rowNumber,'expense_not_found',{expenseId}));
      if(existing&&(existing.product_id??null)!==(product?.id??null))rowErrors.push(expenseRowError(rowNumber,'expense_scope_immutable',{expenseId}));
      let value=null;
      try{value=validateExpenseInput({...source,productId:product?.id??null});}catch(error){rowErrors.push(expenseRowError(rowNumber,error.message));}
      const externalKey=expenseId?existing?.external_entry_key:`file:${cleanChecksum}:${rowNumber}`,target=expenseId?`id:${expenseId}`:`key:${externalKey}`;
      let duplicate=false;
      if(value&&targets.has(target)){const prior=targets.get(target);if(prior.comparable!==expenseComparable(value))rowErrors.push(expenseRowError(rowNumber,'expense_duplicate_conflict',{previousRowNumber:prior.rowNumber}));else duplicate=true;}
      else if(value)targets.set(target,{rowNumber,comparable:expenseComparable(value)});
      prepared.push({source,rowNumber,storageRowNumber,rowErrors,expenseId,existing,externalKey,value,duplicate});errors.push(...rowErrors);
    }
    if(errors.length){
      for(const row of prepared)await client.query(
        `insert into mc.import_rows(business_id,store_id,batch_id,row_number,raw_values,status,errors) values($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb)`,
        [businessId,storeId,batch.id,row.storageRowNumber,JSON.stringify(row.source.rawValues??row.source),row.rowErrors.length?'invalid':row.duplicate?'duplicate':'valid',JSON.stringify(row.rowErrors)]
      );
      await client.query(`update mc.import_batches set status='failed' where id=$1`,[batch.id]);await client.query(`update mc.source_documents set completeness='partial' where id=$1`,[document.id]);
      return{ok:false,batchId:batch.id,documentId:document.id,applied:0,skipped:0,total:rows.length,errors};
    }
    await client.query(`update mc.import_batches set status='applying' where id=$1`,[batch.id]);let applied=0,skipped=0;
    for(const row of prepared){
      const rawValues=JSON.stringify(row.source.rawValues??row.source);
      if(row.duplicate){await client.query(`insert into mc.import_rows(business_id,store_id,batch_id,row_number,raw_values,status) values($1,$2,$3,$4,$5::jsonb,'duplicate')`,[businessId,storeId,batch.id,row.storageRowNumber,rawValues]);skipped++;continue;}
      let expense=row.existing;
      if(!expense){expense=(await client.query(
        `insert into mc.expenses(business_id,store_id,product_id,external_entry_key) values($1,$2,$3,$4)
         on conflict(store_id,external_entry_key) do nothing returning id,product_id,current_version_id,external_entry_key`,[businessId,storeId,row.value.productId,row.externalKey]
      )).rows[0];if(!expense)expense=(await client.query(`select id,product_id,current_version_id,external_entry_key from mc.expenses where business_id=$1 and store_id=$2 and external_entry_key=$3 for update`,[businessId,storeId,row.externalKey])).rows[0];}
      else expense=(await client.query(`select id,product_id,current_version_id,external_entry_key from mc.expenses where id=$1 for update`,[expense.id])).rows[0];
      const current=expense.current_version_id?(await client.query(`select category,amount::text,period_start::text,period_end::text,channel_name,description,recognition_method,state from mc.expense_versions where id=$1`,[expense.current_version_id])).rows[0]:null;
      if(current&&current.state==='active'&&expenseComparable({productId:expense.product_id,...current,amount:exactPositiveAmount(current.amount),periodStart:current.period_start,periodEnd:current.period_end,recognitionMethod:current.recognition_method,channelName:current.channel_name,description:current.description})===expenseComparable(row.value)){
        await client.query(`insert into mc.import_rows(business_id,store_id,batch_id,row_number,raw_values,status) values($1,$2,$3,$4,$5::jsonb,'skipped')`,[businessId,storeId,batch.id,row.storageRowNumber,rawValues]);skipped++;continue;
      }
      const importRow=(await client.query(`insert into mc.import_rows(business_id,store_id,batch_id,row_number,raw_values,status) values($1,$2,$3,$4,$5::jsonb,'applied') returning id`,[businessId,storeId,batch.id,row.storageRowNumber,rawValues])).rows[0];
      const versionNo=(await client.query(`select coalesce(max(version_no),0)+1 as n from mc.expense_versions where expense_id=$1`,[expense.id])).rows[0].n;
      const version=(await client.query(
        `insert into mc.expense_versions(business_id,store_id,expense_id,version_no,category,amount,period_start,period_end,channel_name,description,recognition_method,state,origin,import_row_id,changed_by)
         values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'active','file',$12,$13) returning id`,
        [businessId,storeId,expense.id,versionNo,row.value.category,row.value.amount,row.value.periodStart,row.value.periodEnd,row.value.channelName,row.value.description,row.value.recognitionMethod,importRow.id,userId]
      )).rows[0];await client.query(`update mc.expenses set current_version_id=$1 where id=$2`,[version.id,expense.id]);applied++;
    }
    await client.query(`update mc.import_batches set status='completed',applied_at=now() where id=$1`,[batch.id]);await client.query(`update mc.source_documents set completeness='complete' where id=$1`,[document.id]);
    return{ok:true,batchId:batch.id,documentId:document.id,applied,skipped,total:rows.length};
  });
}

export async function getTaxState(userId,{asOf=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Moscow'}).format(new Date())}={}){
  const date=exactDate(asOf);if(!date)throw new Error('tax_date_invalid');
  return withOwnedBusinessContext(userId,async(client,businessId)=>{
    const current=(await client.query(
      `select s.id as setting_id,s.effective_from,v.id as version_id,v.version_no,v.regime_code,v.usn_rate_fraction::text,v.vat_mode,v.state,v.comment,v.created_at
         from mc.tax_settings s join mc.tax_setting_versions v on (v.business_id,v.tax_setting_id,v.id)=(s.business_id,s.id,s.current_version_id)
        where s.business_id=$1 and s.effective_from<=$2 order by s.effective_from desc limit 1`,[businessId,date]
    )).rows[0]??null;
    const history=(await client.query(
      `select s.id as setting_id,s.effective_from,v.id as version_id,v.version_no,v.regime_code,v.usn_rate_fraction::text,v.vat_mode,v.state,v.comment,v.created_at
         from mc.tax_settings s join mc.tax_setting_versions v on (v.business_id,v.tax_setting_id)=(s.business_id,s.id)
        where s.business_id=$1 order by s.effective_from desc,v.version_no desc`,[businessId]
    )).rows;
    return{current,history,asOf:date};
  });
}

export async function saveTaxSetting(userId,{effectiveFrom,regimeCode='usn_income',usnRatePercent,vatMode,comment}){
  const date=exactDate(effectiveFrom),regime=String(regimeCode??'').trim(),vat=String(vatMode??'').trim(),rate=percentRate(usnRatePercent),note=cleanText(comment,500);
  if(!date)throw new Error('tax_date_invalid');if(!taxRegimes.has(regime))throw new Error('tax_regime_invalid');if(!vatModes.has(vat)||vat==='unmodeled')throw new Error('tax_vat_invalid');
  if(regime!=='usn_income')throw new Error('tax_method_unsupported');if(!rate)throw new Error('tax_rate_invalid');if(note===null)throw new Error('tax_comment_invalid');
  return withOwnedBusinessContext(userId,async(client,businessId,role)=>{
    if(!['owner','editor'].includes(role))throw new Error('tax_write_forbidden');
    let setting=(await client.query(`insert into mc.tax_settings(business_id,effective_from) values($1,$2) on conflict(business_id,effective_from) do nothing returning id,current_version_id`,[businessId,date])).rows[0];
    if(!setting)setting=(await client.query(`select id,current_version_id from mc.tax_settings where business_id=$1 and effective_from=$2 for update`,[businessId,date])).rows[0];
    else setting=(await client.query(`select id,current_version_id from mc.tax_settings where id=$1 for update`,[setting.id])).rows[0];
    const current=setting.current_version_id?(await client.query(`select regime_code,usn_rate_fraction::text,vat_mode,state,comment from mc.tax_setting_versions where id=$1`,[setting.current_version_id])).rows[0]:null;
    const sameRate=current?(await client.query(`select $1::numeric=($2::numeric/100) as matches`,[current.usn_rate_fraction,rate])).rows[0].matches:false;
    if(current&&current.regime_code===regime&&sameRate&&current.vat_mode===vat&&current.state==='active'&&(current.comment??'')===(note??''))return{settingId:setting.id,versionId:setting.current_version_id,changed:false};
    const versionNo=(await client.query(`select coalesce(max(version_no),0)+1 as n from mc.tax_setting_versions where tax_setting_id=$1`,[setting.id])).rows[0].n;
    const version=(await client.query(
      `insert into mc.tax_setting_versions(business_id,tax_setting_id,version_no,regime_code,usn_rate_fraction,vat_mode,state,changed_by,comment)
       values($1,$2,$3,$4,$5::numeric/100,$6,'active',$7,$8) returning id`,
      [businessId,setting.id,versionNo,regime,rate,vat,userId,note||null]
    )).rows[0];await client.query(`update mc.tax_settings set current_version_id=$1 where id=$2`,[version.id,setting.id]);return{settingId:setting.id,versionId:version.id,changed:true};
  });
}

export async function voidTaxSetting(userId,{settingId}){
  if(!uuidPattern.test(String(settingId??'')))throw new Error('tax_setting_invalid');
  return withOwnedBusinessContext(userId,async(client,businessId,role)=>{
    if(!['owner','editor'].includes(role))throw new Error('tax_write_forbidden');
    const row=(await client.query(
      `select s.id,s.current_version_id,v.* from mc.tax_settings s join mc.tax_setting_versions v on v.id=s.current_version_id
        where s.business_id=$1 and s.id=$2 for update of s`,[businessId,settingId]
    )).rows[0];if(!row)throw new Error('tax_setting_not_found');if(row.state==='voided')return{settingId,versionId:row.current_version_id,changed:false};
    const versionNo=(await client.query(`select coalesce(max(version_no),0)+1 as n from mc.tax_setting_versions where tax_setting_id=$1`,[settingId])).rows[0].n;
    const version=(await client.query(
      `insert into mc.tax_setting_versions(business_id,tax_setting_id,version_no,regime_code,usn_rate_fraction,vat_mode,state,currency,changed_by,comment)
       values($1,$2,$3,$4,$5,$6,'voided',$7,$8,$9) returning id`,
      [businessId,settingId,versionNo,row.regime_code,row.usn_rate_fraction,row.vat_mode,row.currency,userId,row.comment]
    )).rows[0];await client.query(`update mc.tax_settings set current_version_id=$1 where id=$2`,[version.id,settingId]);return{settingId,versionId:version.id,changed:true};
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
    let insertedReports=0,unchangedReports=0,normalizedReports=0,insertedRows=0,issues=0;
    for(const source of reports){
      let report=(await client.query(`select id,period_start,period_end from mc.reports where store_id=$1 and report_type='weekly_realization' and external_report_id=$2`,[job.store_id,source.externalReportId])).rows[0];
      if(report&&!financialReportPeriodMatches(report,source))throw new Error('financial_report_period_mismatch');
      if(!report)report=(await client.query(
        `insert into mc.reports(business_id,store_id,external_report_id,report_type,period_start,period_end)
         values($1,$2,$3,'weekly_realization',$4,$5) returning id,period_start,period_end`,
        [businessId,job.store_id,source.externalReportId,source.periodStart,source.periodEnd]
      )).rows[0];
      const same=(await client.query(`select id,status from mc.report_versions where report_id=$1 and checksum=$2`,[report.id,source.checksum])).rows[0];
      let version,reuseRows=false;
      if(same){
        const existingNormalization=(await client.query(`select id from mc.report_normalizations where report_version_id=$1 and method_version_id=$2`,[same.id,method.id])).rows[0];
        if(existingNormalization){unchangedReports++;continue;}
        version=same;reuseRows=true;
      }else{
        const versionNo=(await client.query(`select coalesce(max(version_no),0)+1 as n from mc.report_versions where report_id=$1`,[report.id])).rows[0].n;
        version=(await client.query(
          `insert into mc.report_versions(business_id,store_id,report_id,document_id,version_no,checksum,parser_version)
           values($1,$2,$3,$4,$5,$6,$7) returning id`,
          [businessId,job.store_id,report.id,documentId,versionNo,source.checksum,financialParserVersion]
        )).rows[0];
      }
      const normalization=(await client.query(
        `insert into mc.report_normalizations(business_id,store_id,report_version_id,method_version_id,normalization_key,status)
         values($1,$2,$3,$4,$5,'succeeded') returning id`,
        [businessId,job.store_id,version.id,method.id,`${financialParserVersion}:${version.id}`]
      )).rows[0];
      let rowNumber=0;
      for(const sourceRow of source.rows){
        rowNumber++;
        const reportRow=reuseRows
          ?(await client.query(`select id,row_checksum from mc.report_rows where report_version_id=$1 and external_row_key=$2`,[version.id,sourceRow.externalRowKey])).rows[0]
          :(await client.query(
            `insert into mc.report_rows(business_id,store_id,report_version_id,external_row_key,row_number,raw_data,row_checksum)
             values($1,$2,$3,$4,$5,$6::jsonb,$7) returning id,row_checksum`,
            [businessId,job.store_id,version.id,sourceRow.externalRowKey,rowNumber,JSON.stringify(sourceRow.rawData),sourceRow.rowChecksum]
          )).rows[0];
        if(!reportRow||reportRow.row_checksum!==sourceRow.rowChecksum)throw new Error('financial_duplicate_row_conflict');
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
          `insert into mc.operation_versions(business_id,store_id,operation_id,report_row_id,version_no,srid,operation_type,product_id,variant_id,accounting_date,source_occurred_at,quantity,currency,report_normalization_id)
           values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'RUB',$13) returning id`,
          [businessId,job.store_id,operation.id,reportRow.id,operationVersionNo,normalized.srid,normalized.operationType,product?.id??null,variant?.id??null,normalized.accountingDate,normalized.sourceOccurredAt,normalized.quantity,normalization.id]
        )).rows[0];
        for(const component of normalized.components)await client.query(
          `insert into mc.financial_components(business_id,store_id,operation_version_id,component_key,category_code,amount_signed,method_version_id,source_field,result_scope_classification)
           values($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [businessId,job.store_id,operationVersion.id,component.componentKey,component.categoryCode,component.amountSigned,method.id,component.sourceField,product?'selected_product':'product_expected']
        );
        insertedRows++;
      }
      if(!reuseRows){
        await client.query(`update mc.report_versions set status='validated' where id=$1`,[version.id]);
        await client.query(`update mc.report_versions set status='accepted',accepted_at=now() where id=$1`,[version.id]);
        await client.query(`update mc.reports set current_version_id=$1 where id=$2`,[version.id,report.id]);
        insertedReports++;
      }else normalizedReports++;
    }
    await client.query(
      `insert into mc.coverage_intervals(business_id,store_id,stream_id,source_document_id,date_from,date_to,status)
       values($1,$2,$3,$4,$5,$6,'complete')`,
      [businessId,job.store_id,job.stream_id,documentId,job.date_from,job.date_to]
    );
    if(insertedReports||normalizedReports)await client.query(
      `insert into mc.calculation_invalidations(business_id,store_id,requested_by,reason,invalidated_at)
       values($1,$2,$3,'financial_normalization_changed',clock_timestamp())
       on conflict(store_id) do update set requested_by=excluded.requested_by,
         reason=excluded.reason,generation_token=gen_random_uuid(),invalidated_at=excluded.invalidated_at`,[businessId,job.store_id,userId]
    );
    const progress={stage:'complete',reports:reports.length,insertedReports,normalizedReports,unchangedReports,rows:insertedRows,issues};
    await client.query(`update mc.sync_runs set status='succeeded',finished_at=now(),error_code=null,progress=$2::jsonb where id=$1 and status='running'`,[job.run_id,JSON.stringify(progress)]);
    await client.query(`update mc.sync_streams set cursor=$2::jsonb,last_success_at=now(),next_run_at=now()+interval '24 hours' where id=$1`,[job.stream_id,JSON.stringify({dateTo:job.date_to,reports:reports.length,rows:insertedRows})]);
    return {documentId,insertedReports,normalizedReports,unchangedReports,insertedRows,issues};
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

export async function getFinancialCalculationState(userId,storeId){
  return withOwnedBusinessContext(userId,async(client,businessId)=>(await client.query(
    `select q.id as request_id,q.status as request_status,q.period_start,q.period_end,
            q.last_error_code,q.requested_at,q.updated_at,
            p.id as publication_id,p.created_at as published_at,
            r.id as run_id,r.quality,r.missing_reasons,r.finished_at,
            m.implementation_version as method_version,
            (p.id is not null and r.request_id=q.id) as publication_is_latest
       from mc.calculation_requests q
       left join lateral (
         select p.id,p.run_id,p.created_at from mc.publications p
          where p.business_id=q.business_id and p.store_id=q.store_id and p.is_current
          order by p.created_at desc limit 1
       ) p on true
       left join mc.calculation_runs r on r.id=p.run_id
       left join mc.method_versions m on m.id=r.method_version_id
      where q.business_id=$1 and q.store_id=$2 and q.is_latest`,[businessId,storeId]
  )).rows[0]??null);
}

export async function listFinancialCalculationInvalidations(){
  return (await pool.query(`select * from mc.list_calculation_invalidations()`)).rows;
}

export async function getFinancialCalculationInvalidation(userId,storeId){
  return withOwnedBusinessContext(userId,async(client,businessId)=>(await client.query(
    `select generation_token from mc.calculation_invalidations where business_id=$1 and store_id=$2`,[businessId,storeId]
  )).rows[0]??null);
}

export async function acknowledgeFinancialCalculationInvalidation(userId,storeId,generationToken){
  if(!generationToken)return false;
  return (await pool.query(
    `select mc.ack_calculation_invalidation($1,$2,$3) as acknowledged`,[userId,storeId,generationToken]
  )).rows[0]?.acknowledged===true;
}

export async function getCurrentFinancialResult(userId,storeId){
  return withOwnedBusinessContext(userId,async(client,businessId)=>{
    const publication=(await client.query(
      `select p.id as publication_id,p.created_at as published_at,r.id as run_id,
              r.period_start,r.period_end,r.quality,r.missing_reasons,
              m.code as method_code,m.implementation_version as method_version
         from mc.publications p join mc.calculation_runs r on r.id=p.run_id
         join mc.method_versions m on m.id=r.method_version_id
        where p.business_id=$1 and p.store_id=$2 and p.is_current
        order by p.created_at desc limit 1`,[businessId,storeId]
    )).rows[0];
    if(!publication)return null;
    const lines=(await client.query(
      `select result_scope,product_id,variant_id,accounting_date,category_code,
              amount_signed::text,quality
         from mc.result_lines where run_id=$1
        order by accounting_date,result_scope,product_id nulls last,variant_id nulls last,category_code,id`,[publication.run_id]
    )).rows;
    return{...publication,lines};
  });
}

export async function prepareFinancialCalculation(userId,storeId){
  return withOwnedBusinessContext(userId,async(client,businessId)=>{
    const store=(await client.query(`select id from mc.stores where business_id=$1 and id=$2 and status='active' for update`,[businessId,storeId])).rows[0];
    if(!store)throw new Error('calculation_store_unavailable');
    const selection=(await client.query(`select id from mc.product_selections where business_id=$1 and store_id=$2 and status='confirmed'`,[businessId,storeId])).rows[0];
    if(!selection)throw new Error('calculation_selection_missing');
    const products=(await client.query(`select product_id from mc.product_selection_items where selection_id=$1 order by product_id`,[selection.id])).rows.map(row=>row.product_id);
    const reports=(await client.query(
      `select r.id as report_id,rv.id as report_version_id,r.period_start::text,r.period_end::text,rn.id as normalization_id
         from mc.reports r join mc.report_versions rv on rv.id=r.current_version_id
         left join lateral (
           select n.id from mc.report_normalizations n join mc.method_versions m on m.id=n.method_version_id
            where n.report_version_id=rv.id and n.status='succeeded' and m.implementation_version=$3
            order by m.version_no desc limit 1
         ) rn on true
        where r.business_id=$1 and r.store_id=$2
        order by r.period_start,r.external_report_id`,[businessId,storeId,financialParserVersion]
    )).rows;
    const normalized=reports.filter(row=>row.normalization_id);
    if(!normalized.length)throw new Error('calculation_financial_inputs_missing');
    const periodStart=reports[0].period_start,periodEnd=reports.reduce((value,row)=>row.period_end>value?row.period_end:value,reports[0].period_end);
    const costs=(await client.query(
      `select v.id from mc.variant_costs c join mc.cost_versions v on v.id=c.current_version_id
        where c.business_id=$1 and c.store_id=$2 and c.product_id=any($3::uuid[]) order by v.id`,[businessId,storeId,products]
    )).rows.map(row=>row.id);
    const expenses=(await client.query(
      `select v.id from mc.expenses e join mc.expense_versions v on v.id=e.current_version_id
        where e.business_id=$1 and e.store_id=$2 and v.state='active' and v.period_end>=$3 and v.period_start<=$4
          and (e.product_id is null or e.product_id=any($5::uuid[])) order by v.id`,[businessId,storeId,periodStart,periodEnd,products]
    )).rows.map(row=>row.id);
    const taxes=(await client.query(
      `select v.id from mc.tax_settings s join mc.tax_setting_versions v on v.id=s.current_version_id
        where s.business_id=$1 and s.effective_from<=$2 and v.state='active' order by s.effective_from,v.id`,[businessId,periodEnd]
    )).rows.map(row=>row.id);
    const method=(await client.query(`select id,implementation_version from mc.method_versions where code='financial_result' and version_no=1`)).rows[0];
    if(!method)throw new Error('calculation_method_missing');
    const fingerprint=createInputFingerprint({resultMethodVersion:`${method.id}:${method.implementation_version}`,selectedProductIds:products,reportVersionIds:normalized.map(row=>row.report_version_id),reportNormalizationIds:normalized.map(row=>row.normalization_id),costVersionIds:costs,expenseVersionIds:expenses,taxSettingVersionIds:taxes,periodStart,periodEnd});
    const current=(await client.query(`select id,input_fingerprint,status from mc.calculation_requests where business_id=$1 and store_id=$2 and is_latest for update`,[businessId,storeId])).rows[0];
    if(current?.input_fingerprint===fingerprint)return{id:current.id,status:current.status,changed:false};
    if(current)await client.query(`update mc.calculation_requests set is_latest=false,status='superseded',updated_at=now() where id=$1`,[current.id]);
    const generation=(await client.query(`select coalesce(max(generation_no),0)+1 as n from mc.calculation_requests where store_id=$1`,[storeId])).rows[0].n;
    const request=(await client.query(
      `insert into mc.calculation_requests(business_id,store_id,generation_no,selection_id,method_version_id,period_start,period_end,input_fingerprint)
       values($1,$2,$3,$4,$5,$6,$7,$8) returning id,status`,[businessId,storeId,generation,selection.id,method.id,periodStart,periodEnd,fingerprint]
    )).rows[0];
    for(const productId of products)await client.query(`insert into mc.calculation_request_products(business_id,store_id,request_id,product_id) values($1,$2,$3,$4)`,[businessId,storeId,request.id,productId]);
    for(const normalizationId of normalized.map(row=>row.normalization_id))await client.query(`insert into mc.calculation_request_inputs(business_id,store_id,request_id,report_normalization_id) values($1,$2,$3,$4)`,[businessId,storeId,request.id,normalizationId]);
    for(const costId of costs)await client.query(`insert into mc.calculation_request_inputs(business_id,store_id,request_id,cost_version_id) values($1,$2,$3,$4)`,[businessId,storeId,request.id,costId]);
    for(const expenseId of expenses)await client.query(`insert into mc.calculation_request_inputs(business_id,store_id,request_id,expense_version_id) values($1,$2,$3,$4)`,[businessId,storeId,request.id,expenseId]);
    for(const taxId of taxes)await client.query(`insert into mc.calculation_request_inputs(business_id,store_id,request_id,tax_setting_version_id) values($1,$2,$3,$4)`,[businessId,storeId,request.id,taxId]);
    return{id:request.id,status:request.status,changed:true};
  });
}

async function executeFinancialCalculation(userId,requestId){
  const outcome=await withOwnedBusinessContext(userId,async(client,businessId)=>{
    const request=(await client.query(`select q.*,q.period_start::text as period_start,q.period_end::text as period_end from mc.calculation_requests q where business_id=$1 and id=$2 and is_latest for update`,[businessId,requestId])).rows[0];
    if(!request)throw new Error('calculation_request_stale');
    if(request.status==='published')return{requestId,changed:false};
    const attemptNo=(await client.query(`select coalesce(max(attempt_no),0)+1 as n from mc.calculation_runs where request_id=$1`,[requestId])).rows[0].n;
    const run=(await client.query(
      `insert into mc.calculation_runs(business_id,store_id,selection_id,method_version_id,period_start,period_end,input_fingerprint,request_id,attempt_no)
       values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,[businessId,request.store_id,request.selection_id,request.method_version_id,request.period_start,request.period_end,request.input_fingerprint,request.id,attemptNo]
    )).rows[0];
    await client.query(`update mc.calculation_requests set status='running',last_error_code=null,updated_at=now() where id=$1`,[request.id]);
    await client.query('savepoint calculation_attempt');
    try{
    const inputs=(await client.query(`select * from mc.calculation_request_inputs where request_id=$1 order by id`,[request.id])).rows;
    for(const input of inputs)await client.query(
      `insert into mc.calculation_inputs(business_id,store_id,run_id,report_normalization_id,cost_version_id,expense_version_id,tax_setting_version_id)
       values($1,$2,$3,$4,$5,$6,$7)`,[businessId,request.store_id,run.id,input.report_normalization_id,input.cost_version_id,input.expense_version_id,input.tax_setting_version_id]
    );
    const selected=(await client.query(`select product_id from mc.calculation_request_products where request_id=$1 order by product_id`,[request.id])).rows.map(row=>row.product_id);
    const normalizationIds=inputs.map(row=>row.report_normalization_id).filter(Boolean);
    const components=(await client.query(
      `select f.id,f.category_code,f.amount_signed::text,f.result_scope_classification,o.product_id,o.variant_id,o.accounting_date::text,o.state
         from mc.operation_versions o join mc.financial_components f on f.operation_version_id=o.id
        where o.report_normalization_id=any($1::uuid[]) order by f.id`,[normalizationIds]
    )).rows.map(row=>({id:row.id,categoryCode:row.category_code,amountSigned:row.amount_signed,productId:row.product_id,variantId:row.variant_id,accountingDate:row.accounting_date,state:row.state,classificationStatus:['revenue','revenue_return'].includes(row.category_code)?'confirmed':'unclassified',scopeCode:row.result_scope_classification}));
    const operations=(await client.query(
      `select id,operation_type,product_id,variant_id,accounting_date::text,quantity::text,state
         from mc.operation_versions where report_normalization_id=any($1::uuid[]) and operation_type in ('sale','return') order by id`,[normalizationIds]
    )).rows.map(row=>({id:row.id,operationType:row.operation_type,productId:row.product_id,variantId:row.variant_id,accountingDate:row.accounting_date,quantity:row.quantity,state:row.state,scopeCode:'selected_product'}));
    const costIds=inputs.map(row=>row.cost_version_id).filter(Boolean);
    const costs=costIds.length?(await client.query(
      `select v.id,c.variant_id,c.effective_from::text,v.unit_cost::text,v.state from mc.cost_versions v join mc.variant_costs c on c.id=v.cost_id where v.id=any($1::uuid[]) order by v.id`,[costIds]
    )).rows.map(row=>({id:row.id,variantId:row.variant_id,effectiveFrom:row.effective_from,unitCost:row.unit_cost,state:row.state})):[];
    const expenseIds=inputs.map(row=>row.expense_version_id).filter(Boolean);
    const expenses=expenseIds.length?(await client.query(
      `select v.id,e.product_id,v.category,v.amount::text,v.period_start::text,v.period_end::text,v.recognition_method,v.state
         from mc.expense_versions v join mc.expenses e on e.id=v.expense_id where v.id=any($1::uuid[]) order by v.id`,[expenseIds]
    )).rows.map(row=>({id:row.id,productId:row.product_id,category:row.category,amount:row.amount,periodStart:row.period_start,periodEnd:row.period_end,recognitionMethod:row.recognition_method,state:row.state,scopeCode:row.product_id?'selected_product':'store'})):[];
    const taxIds=inputs.map(row=>row.tax_setting_version_id).filter(Boolean);
    const tax=taxIds.length?(await client.query(
      `select v.regime_code,v.usn_rate_fraction::text,v.vat_mode
         from mc.tax_setting_versions v join mc.tax_settings s on s.id=v.tax_setting_id
        where v.id=any($1::uuid[]) and s.effective_from<=$2
        order by s.effective_from desc,v.version_no desc limit 1`,[taxIds,request.period_end]
    )).rows[0]:null;
    const currentReportCount=Number((await client.query(`select count(*)::int as n from mc.reports where business_id=$1 and store_id=$2 and current_version_id is not null`,[businessId,request.store_id])).rows[0].n);
    const result=calculateFinancialResult({periodStart:request.period_start,periodEnd:request.period_end,selectedProductIds:selected,financialComponents:components,operations,costVersions:costs,expenses,taxSetting:tax?{regimeCode:tax.regime_code,usnRateFraction:tax.usn_rate_fraction,vatMode:tax.vat_mode}:null,reportCoverageComplete:normalizationIds.length===currentReportCount});
    for(const line of result.lines){
      const saved=(await client.query(
        `insert into mc.result_lines(business_id,store_id,run_id,product_id,variant_id,accounting_date,category_code,amount_signed,quality,result_scope)
         values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,[businessId,request.store_id,run.id,line.productId,line.variantId,line.accountingDate,line.categoryCode,line.amountSigned,result.quality,line.scopeCode]
      )).rows[0];
      for(const evidence of line.evidence){
        if(evidence.sourceType==='financial_component')await client.query(`insert into mc.result_evidence(business_id,store_id,result_line_id,financial_component_id,contribution_amount) values($1,$2,$3,$4,$5)`,[businessId,request.store_id,saved.id,evidence.sourceId,evidence.contributionAmount]);
        else if(evidence.sourceType==='sale_cost')await client.query(`insert into mc.result_evidence(business_id,store_id,result_line_id,cost_version_id,source_operation_version_id,quantity,contribution_amount) values($1,$2,$3,$4,$5,$6,$7)`,[businessId,request.store_id,saved.id,evidence.costVersionId,evidence.sourceId,evidence.quantity,evidence.contributionAmount]);
        else if(evidence.sourceType==='expense_version')await client.query(`insert into mc.result_evidence(business_id,store_id,result_line_id,expense_version_id,contribution_amount) values($1,$2,$3,$4,$5)`,[businessId,request.store_id,saved.id,evidence.sourceId,evidence.contributionAmount]);
      }
    }
    await client.query(`update mc.calculation_runs set status='succeeded',quality=$2,missing_reasons=$3::jsonb,finished_at=now() where id=$1`,[run.id,result.quality,JSON.stringify(result.missingReasons)]);
    const publication=(await client.query(`select mc.publish_latest_calculation($1) as id`,[run.id])).rows[0];
    return{requestId:request.id,runId:run.id,publicationId:publication.id,quality:result.quality,missingReasons:result.missingReasons,totals:result.totals,changed:true};
    }catch(error){
      const errorCode=String(error?.message??'calculation_failed').slice(0,100);
      await client.query('rollback to savepoint calculation_attempt');
      await client.query(`update mc.calculation_runs set status='failed',quality='unavailable',missing_reasons='[]'::jsonb,finished_at=now() where id=$1`,[run.id]);
      await client.query(`update mc.calculation_requests set status='failed',last_error_code=$2,updated_at=now() where id=$1`,[request.id,errorCode]);
      return{requestId:request.id,runId:run.id,errorCode};
    }
  });
  if(outcome.errorCode)throw new Error(outcome.errorCode);
  return outcome;
}

export async function runFinancialCalculation(userId,storeId){
  const request=await prepareFinancialCalculation(userId,storeId);
  try{return await executeFinancialCalculation(userId,request.id);}catch(error){
    await withOwnedBusinessContext(userId,async(client,businessId)=>client.query(
      `update mc.calculation_requests set status='failed',last_error_code=$3,updated_at=now() where business_id=$1 and id=$2 and is_latest`,[businessId,request.id,String(error?.message??'calculation_failed').slice(0,100)]
    )).catch(()=>{});
    throw error;
  }
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
