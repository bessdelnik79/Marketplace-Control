import { createHash } from 'node:crypto';
import { withOwnedBusinessContext } from '../../infrastructure/database/client.mjs';
import { reconcileHistoricalCatalogLinks } from '../reports/normalization.repository.mjs';

export function createCatalogChecksum(cards){
  return createHash('sha256').update(JSON.stringify(cards)).digest('hex');
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
    await client.query(`select id from mc.businesses where id=$1 for update`,[businessId]);
    const checksum=createCatalogChecksum(catalog.cards);
    const document=(await client.query(
      `insert into mc.source_documents(business_id,store_id,sync_run_id,origin,document_type,external_document_id,checksum,completeness)
       values($1,$2,$3,'wb_api','catalog',$4,$5,'complete') returning id`,
      [businessId,job.store_id,job.run_id,`catalog:${Date.now()}`,checksum]
    )).rows[0];
    const articleIds=[],variantIds=[];
    let linksChanged=false;
    for(const card of catalog.cards){
      articleIds.push(card.nmId);
      const previousProduct=(await client.query(`select id,historical_deleted from mc.products where store_id=$1 and wb_article=$2`,[job.store_id,card.nmId])).rows[0];
      linksChanged=linksChanged||!previousProduct||previousProduct.historical_deleted;
      const product=(await client.query(
        `insert into mc.products(business_id,store_id,wb_article,seller_article,title,image_url,status)
         values($1,$2,$3,$4,$5,$6,'active')
         on conflict(store_id,wb_article) do update set seller_article=excluded.seller_article,title=excluded.title,image_url=excluded.image_url,status='active',historical_deleted=false,historical_source_row_id=null
           where (mc.products.seller_article,mc.products.title,mc.products.image_url,mc.products.status,mc.products.historical_deleted) is distinct from (excluded.seller_article,excluded.title,excluded.image_url,excluded.status,false)
         returning id`,[businessId,job.store_id,card.nmId,card.vendorCode,card.title,card.imageUrl]
      )).rows[0]??(await client.query(`select id from mc.products where store_id=$1 and wb_article=$2`,[job.store_id,card.nmId])).rows[0];
      for(const variant of card.variants){
        variantIds.push(variant.externalId);
        // Adopt the historical variant so existing cost history retains its ID.
        let existing=(await client.query(`select id from mc.variants where store_id=$1 and product_id=$2 and (external_variant_id=$3 or wb_external_variant_id=$3)`,[job.store_id,product.id,variant.externalId])).rows[0];
        if(!existing){
          const historical=(await client.query(`select distinct v.id from mc.variants v join mc.variant_identifiers i on i.variant_id=v.id
            where v.store_id=$1 and v.product_id=$2 and v.historical_report_only
              and i.identifier_type='barcode' and i.valid_to is null and i.identifier_value=any($3::text[]) order by v.id`,[job.store_id,product.id,variant.barcodes])).rows;
          // Multiple report barcodes can become one WB size. Keep every cost
          // variant and barcode identity; adopt one as the live external size.
          if(historical.length){
            existing=historical[0];
            await client.query(`update mc.variants set wb_external_variant_id=$2,historical_report_only=false where id=$1`,[existing.id,variant.externalId]);
          }
          linksChanged=true;
        }
        const saved=existing?(await client.query(`update mc.variants set size_label=$2,color_label=$3,attributes=$4::jsonb,status='active',historical_report_only=false where id=$1 returning id`,[existing.id,variant.sizeLabel,variant.colorLabel,JSON.stringify(variant.attributes)])).rows[0]:(await client.query(
          `insert into mc.variants(business_id,store_id,product_id,external_variant_id,size_label,color_label,attributes,status)
           values($1,$2,$3,$4,$5,$6,$7::jsonb,'active')
           on conflict(store_id,product_id,external_variant_id) do update set size_label=excluded.size_label,color_label=excluded.color_label,attributes=excluded.attributes,status='active',historical_report_only=false
             where (mc.variants.size_label,mc.variants.color_label,mc.variants.attributes,mc.variants.status,mc.variants.historical_report_only) is distinct from (excluded.size_label,excluded.color_label,excluded.attributes,excluded.status,false)
           returning id`,[businessId,job.store_id,product.id,variant.externalId,variant.sizeLabel,variant.colorLabel,JSON.stringify(variant.attributes)]
        )).rows[0]??(await client.query(`select id from mc.variants where store_id=$1 and product_id=$2 and external_variant_id=$3`,[job.store_id,product.id,variant.externalId])).rows[0];
        for(const barcode of variant.barcodes){const identifier=await client.query(
          `insert into mc.variant_identifiers(business_id,store_id,variant_id,identifier_type,identifier_value)
           values($1,$2,$3,'barcode',$4) on conflict do nothing`,[businessId,job.store_id,saved.id,barcode]
        );
          linksChanged=linksChanged||identifier.rowCount>0;
        }
      }
    }
    if(articleIds.length)await client.query(`update mc.products set status='archived' where store_id=$1 and status='active' and not historical_deleted and not(wb_article=any($2::bigint[]))`,[job.store_id,articleIds]);
    else await client.query(`update mc.products set status='archived' where store_id=$1 and status='active' and not historical_deleted`,[job.store_id]);
    if(variantIds.length)await client.query(`update mc.variants v set status='archived' where store_id=$1 and status='active' and not historical_report_only and not(coalesce(wb_external_variant_id,external_variant_id)=any($2::text[])) and not exists(select 1 from mc.products p where p.id=v.product_id and p.historical_deleted)`,[job.store_id,variantIds]);
    else await client.query(`update mc.variants v set status='archived' where store_id=$1 and status='active' and not historical_report_only and not exists(select 1 from mc.products p where p.id=v.product_id and p.historical_deleted)`,[job.store_id]);
    await client.query(`update mc.sync_runs set status='succeeded',finished_at=now(),error_code=null where id=$1 and status='running'`,[job.run_id]);
    await client.query(`update mc.sync_streams set cursor=$2::jsonb,last_success_at=now(),next_run_at=now()+interval '6 hours' where id=$1`,[job.stream_id,JSON.stringify(catalog.cursor??{})]);
    if(linksChanged)await client.query(`update mc.stores set catalog_revision=catalog_revision+1 where id=$1`,[job.store_id]);
    await reconcileHistoricalCatalogLinks(client,{businessId,storeId:job.store_id});
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
      `select p.id,p.wb_article,p.seller_article,p.title,p.image_url,p.status,p.historical_deleted,
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
