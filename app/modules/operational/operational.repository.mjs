import { createHash } from 'node:crypto';
import { pool, withOwnedBusinessContext } from '../../infrastructure/database/client.mjs';
import { verifyOperationalSnapshotObject } from '../../infrastructure/storage/operational-source-storage.mjs';

const parserVersion='wb-sales-funnel-v1';
const dayMs=86400000;

function calendarDay(value){
  const text=String(value??'');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(text))throw new Error('operational_invalid_period');
  const [year,month,day]=text.split('-').map(Number),time=Date.UTC(year,month-1,day),date=new Date(time);
  if(date.getUTCFullYear()!==year||date.getUTCMonth()!==month-1||date.getUTCDate()!==day)throw new Error('operational_invalid_period');
  return {text,number:Math.trunc(time/dayMs)};
}

function period(dateFrom,dateTo){
  const from=calendarDay(dateFrom),to=calendarDay(dateTo);
  if(to.number<from.number||to.number-from.number>6)throw new Error('operational_invalid_period');
  return {dateFrom:from.text,dateTo:to.text,days:to.number-from.number+1,fromDay:from.number,toDay:to.number};
}

function sha(value){return createHash('sha256').update(value).digest('hex');}
function decimal(value){
  const text=String(value??'');
  if(!/^\d+(?:\.\d+)?$/.test(text))throw new Error('operational_invalid_metric');
  return text;
}

export async function beginOperationalSync(userId,storeId,{force=false,dateFrom,dateTo}={}){
  const range=period(dateFrom,dateTo);
  return withOwnedBusinessContext(userId,async(client,businessId)=>{
    await client.query(
      `insert into mc.sync_streams(business_id,store_id,source_type,next_run_at,status)
       select s.business_id,s.id,'operational_sales_funnel',now(),'active'
         from mc.stores s join mc.connections c on c.business_id=s.business_id and c.store_id=s.id and c.status='active'
        where s.business_id=$1 and s.id=$2 and s.marketplace_code='wb' and s.status='active'
       on conflict(store_id,source_type) do nothing`,[businessId,storeId]
    );
    const row=(await client.query(
      `select ss.id as stream_id,ss.next_run_at,cs.ciphertext,cs.nonce,cs.auth_tag,s.external_account_id as seller_id
         from mc.stores s
         join mc.connections c on c.business_id=s.business_id and c.store_id=s.id and c.status='active'
         join mc.connection_secrets cs on cs.business_id=c.business_id and cs.connection_id=c.id
         join mc.sync_streams ss on ss.business_id=s.business_id and ss.store_id=s.id
           and ss.source_type='operational_sales_funnel' and ss.status='active'
        where s.business_id=$1 and s.id=$2 and s.status='active'
        for update of ss`,[businessId,storeId]
    )).rows[0];
    if(!row)throw new Error('operational_connection_unavailable');
    const products=(await client.query(
      `select p.id as product_id,p.wb_article::text as nm_id
         from mc.product_selections ps
         join mc.product_selection_items i on i.business_id=ps.business_id and i.store_id=ps.store_id and i.selection_id=ps.id
         join mc.products p on p.business_id=i.business_id and p.store_id=i.store_id and p.id=i.product_id
        where ps.business_id=$1 and ps.store_id=$2 and ps.status='confirmed'
        order by p.wb_article,p.id`,[businessId,storeId]
    )).rows;
    if(!products.length)return {started:false,reason:'selection_required'};
    if(products.some(item=>!Number.isSafeInteger(Number(item.nm_id))||Number(item.nm_id)<=0))throw new Error('operational_invalid_nm_id');
    if(!force&&row.next_run_at&&new Date(row.next_run_at)>new Date())return {started:false,reason:'not_due'};
    const running=(await client.query(`select id,started_at from mc.sync_runs where stream_id=$1 and status='running'`,[row.stream_id])).rows[0];
    if(running&&new Date(running.started_at)>new Date(Date.now()-30*60*1000))return {started:false,reason:'running'};
    if(running)await client.query(`update mc.sync_runs set status='failed',finished_at=now(),error_code='operational_interrupted',progress=jsonb_set(progress,'{stage}','"failed"') where id=$1`,[running.id]);
    const run=(await client.query(
      `insert into mc.sync_runs(business_id,store_id,stream_id,requested_from,requested_to,status,started_at,progress)
       values($1,$2,$3,$4,$5,'running',now(),'{"stage":"loading","batches":0,"rows":0}') returning id`,
      [businessId,storeId,row.stream_id,range.dateFrom,range.dateTo]
    )).rows[0];
    await client.query(`update mc.sync_streams set next_run_at=null where id=$1`,[row.stream_id]);
    return {started:true,business_id:businessId,store_id:storeId,stream_id:row.stream_id,run_id:run.id,
      date_from:range.dateFrom,date_to:range.dateTo,seller_id:row.seller_id,ciphertext:row.ciphertext,nonce:row.nonce,auth_tag:row.auth_tag,
      products:products.map(item=>({productId:item.product_id,nmId:Number(item.nm_id)}))};
  });
}

export async function reserveOperationalRequestSlot(userId,job,delaySeconds=20){
  if(!Number.isInteger(delaySeconds)||delaySeconds<20||delaySeconds>60)throw new Error('operational_invalid_rate_delay');
  return withOwnedBusinessContext(userId,async(client,businessId)=>{
    if(businessId!==job.business_id||!job.seller_id)throw new Error('operational_context_mismatch');
    const rateKey=sha(`wb:analytics:sales-funnel:${job.seller_id}`);
    const slot=(await client.query(
      `insert into mc.wb_api_request_slots(rate_key,next_allowed_at)
       values($1,clock_timestamp()+make_interval(secs=>$2))
       on conflict(rate_key) do update
         set next_allowed_at=greatest(mc.wb_api_request_slots.next_allowed_at,clock_timestamp())+make_interval(secs=>$2),updated_at=clock_timestamp()
       returning next_allowed_at-make_interval(secs=>$2) as scheduled_at,next_allowed_at`,[rateKey,delaySeconds]
    )).rows[0];
    return {scheduledAt:slot.scheduled_at,nextAllowedAt:slot.next_allowed_at,waitMs:Math.max(0,new Date(slot.scheduled_at).getTime()-Date.now())};
  });
}

export async function updateOperationalSyncProgress(userId,job,progress){
  return withOwnedBusinessContext(userId,async(client,businessId)=>{
    if(businessId!==job.business_id)throw new Error('operational_context_mismatch');
    await client.query(`update mc.sync_runs set progress=$2::jsonb where id=$1 and business_id=$3 and status='running'`,[job.run_id,JSON.stringify(progress),businessId]);
  });
}

export async function completeOperationalSync(userId,job,{documentId,snapshotId,objects,metrics,fetchedAt=new Date(),storage}={}){
  const range=period(job.date_from,job.date_to);
  if(!Array.isArray(objects)||!objects.length||!Array.isArray(metrics))throw new Error('operational_invalid_result');
  return withOwnedBusinessContext(userId,async(client,businessId)=>{
    if(businessId!==job.business_id||!Array.isArray(job.products)||!job.products.length)throw new Error('operational_context_mismatch');
    await client.query(`select 1 from mc.businesses where id=$1 for update`,[businessId]);
    const stream=(await client.query(`select id from mc.sync_streams where id=$1 and business_id=$2 and store_id=$3 for update`,[job.stream_id,businessId,job.store_id])).rows[0];
    const run=stream&&(await client.query(`select status from mc.sync_runs where id=$1 and business_id=$2 and store_id=$3 and stream_id=$4 for update`,[job.run_id,businessId,job.store_id,job.stream_id])).rows[0];
    if(run?.status!=='running')throw new Error('operational_sync_superseded');
    const currentProducts=(await client.query(
      `select p.id as product_id,p.wb_article::text as nm_id
         from mc.product_selections ps
         join mc.product_selection_items i on i.business_id=ps.business_id and i.store_id=ps.store_id and i.selection_id=ps.id
         join mc.products p on p.business_id=i.business_id and p.store_id=i.store_id and p.id=i.product_id
        where ps.business_id=$1 and ps.store_id=$2 and ps.status='confirmed'
        order by p.wb_article,p.id`,[businessId,job.store_id]
    )).rows;
    const frozenScope=job.products.map(item=>`${item.productId}:${item.nmId}`);
    const currentScope=currentProducts.map(item=>`${item.product_id}:${item.nm_id}`);
    if(frozenScope.length!==currentScope.length||frozenScope.some((item,index)=>item!==currentScope[index]))throw new Error('operational_selection_changed');
    const byNm=new Map(job.products.map(item=>[String(item.nmId),item.productId]));
    if(byNm.size!==job.products.length)throw new Error('operational_context_mismatch');
    const seen=new Set(),normalized=[];
    for(const metric of metrics){
      const productId=byNm.get(String(metric.nmId)),date=calendarDay(metric.date);
      if(!productId||date.number<range.fromDay||date.number>range.toDay||metric.currency!=='RUB'||!Number.isSafeInteger(metric.orderCount)||metric.orderCount<0||!Number.isSafeInteger(metric.buyoutCount)||metric.buyoutCount<0)throw new Error('operational_invalid_metric');
      const key=`${productId}:${date.text}`;
      if(seen.has(key))throw new Error('operational_duplicate_metric');
      seen.add(key);
      const row={productId,date:date.text,currency:'RUB',orderCount:metric.orderCount,orderAmount:decimal(metric.orderSum),buyoutCount:metric.buyoutCount,buyoutAmount:decimal(metric.buyoutSum)};
      normalized.push({...row,rowChecksum:sha(JSON.stringify(row))});
    }
    normalized.sort((a,b)=>a.date.localeCompare(b.date)||a.productId.localeCompare(b.productId));
    const expected=job.products.length*range.days;
    const missingReasons=[];
    if(!normalized.length)missingReasons.push('source_empty');
    else{
      if(job.products.some(product=>!normalized.some(metric=>metric.productId===product.productId)))missingReasons.push('selected_product_missing');
      if(normalized.length<expected)missingReasons.push('metric_date_missing');
    }
    if(normalized.length>expected)throw new Error('operational_invalid_metric');
    const quality=normalized.length===expected?'complete':normalized.length?'partial':'unavailable';
    const normalizedObjects=objects.map((object,index)=>({...object,partNumber:object.partNumber??index})).sort((a,b)=>a.partNumber-b.partNumber);
    const expectedPrefix=`${businessId}/${job.store_id}/operational-snapshots/${snapshotId}/`.toLowerCase();
    if(normalizedObjects.some((object,index)=>object.partNumber!==index||!Number.isInteger(object.byteSize)||object.byteSize<33
      ||object.contentType!=='application/json+gzip+aes-256-gcm'
      ||String(object.storageKey??'').toLowerCase()!==`${expectedPrefix}part-${String(index).padStart(4,'0')}.json.gz.enc`))throw new Error('operational_invalid_object');
    const objectChecksums=normalizedObjects.map(object=>String(object.checksum??'')).sort();
    if(objectChecksums.some(checksum=>! /^[0-9a-f]{64}$/.test(checksum)))throw new Error('operational_invalid_object');
    for(const object of normalizedObjects)await verifyOperationalSnapshotObject(object,storage);
    const checksum=sha(JSON.stringify({parserVersion,period:[range.dateFrom,range.dateTo],scope:job.products.map(item=>String(item.nmId)).sort(),objects:objectChecksums}));
    const documentChecksum=sha(objectChecksums.join(':'));
    await client.query(
      `insert into mc.source_documents(id,business_id,store_id,sync_run_id,origin,document_type,external_document_id,checksum,completeness)
       values($1,$2,$3,$4,'wb_api','operational_sales_funnel',$5,$6,'complete')`,
      [documentId,businessId,job.store_id,job.run_id,`sales-funnel:${range.dateFrom}:${range.dateTo}:${checksum.slice(0,16)}`,documentChecksum]
    );
    for(const object of normalizedObjects)await client.query(
      `insert into mc.source_objects(business_id,store_id,document_id,storage_key,part_number,byte_size,checksum,content_type)
       values($1,$2,$3,$4,$5,$6,$7,$8)`,
      [businessId,job.store_id,documentId,object.storageKey,object.partNumber,object.byteSize,object.checksum,object.contentType]
    );
    const operationalPeriod=(await client.query(
      `insert into mc.operational_periods(business_id,store_id,period_start,period_end)
       values($1,$2,$3,$4) on conflict(store_id,source_code,period_start,period_end) do update set source_code=excluded.source_code returning id,current_snapshot_id`,
      [businessId,job.store_id,range.dateFrom,range.dateTo]
    )).rows[0];
    let snapshot=(await client.query(`select id,status from mc.operational_snapshots where operational_period_id=$1 and checksum=$2 order by version_no desc limit 1`,[operationalPeriod.id,checksum])).rows[0];
    let reused=Boolean(snapshot);
    if(!snapshot){
      const versionNo=(await client.query(`select coalesce(max(version_no),0)+1 as n from mc.operational_snapshots where operational_period_id=$1`,[operationalPeriod.id])).rows[0].n;
      snapshot=(await client.query(
        `insert into mc.operational_snapshots(id,business_id,store_id,operational_period_id,document_id,version_no,checksum,parser_version,fetched_at,quality,missing_reasons)
         values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb) returning id,status`,
        [snapshotId,businessId,job.store_id,operationalPeriod.id,documentId,versionNo,checksum,parserVersion,fetchedAt,quality,JSON.stringify(missingReasons)]
      )).rows[0];
      for(const [position,product] of job.products.entries())await client.query(
        `insert into mc.operational_snapshot_products(business_id,store_id,snapshot_id,product_id,request_position) values($1,$2,$3,$4,$5)`,
        [businessId,job.store_id,snapshot.id,product.productId,position+1]
      );
      for(const metric of normalized)await client.query(
        `insert into mc.operational_daily_metrics(business_id,store_id,snapshot_id,product_id,metric_date,currency,order_count,order_amount,buyout_count,buyout_amount,row_checksum)
         values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [businessId,job.store_id,snapshot.id,metric.productId,metric.date,metric.currency,metric.orderCount,metric.orderAmount,metric.buyoutCount,metric.buyoutAmount,metric.rowChecksum]
      );
      await client.query(`update mc.operational_snapshots set status='validated' where id=$1`,[snapshot.id]);
      await client.query(`update mc.operational_snapshots set status='accepted',accepted_at=now() where id=$1`,[snapshot.id]);
    }else if(snapshot.status!=='accepted')throw new Error('operational_snapshot_not_accepted');
    await client.query(
      `insert into mc.operational_snapshot_activations(business_id,store_id,operational_period_id,snapshot_id,document_id,fetched_at)
       values($1,$2,$3,$4,$5,$6)`,[businessId,job.store_id,operationalPeriod.id,snapshot.id,documentId,fetchedAt]
    );
    await client.query(`update mc.operational_periods set current_snapshot_id=$1 where id=$2`,[snapshot.id,operationalPeriod.id]);
    const progress={stage:'complete',quality,products:job.products.length,rows:normalized.length,batches:normalizedObjects.length,reused};
    await client.query(`update mc.sync_runs set status=$2,finished_at=now(),error_code=null,progress=$3::jsonb where id=$1 and status='running'`,[job.run_id,quality==='complete'?'succeeded':'partial',JSON.stringify(progress)]);
    await client.query(
      `update mc.sync_streams set cursor=coalesce(cursor,'{}'::jsonb)||$2::jsonb,last_success_at=now(),next_run_at=now()+interval '1 hour' where id=$1`,
      [job.stream_id,JSON.stringify({dateFrom:range.dateFrom,dateTo:range.dateTo,snapshotId:snapshot.id,quality})]
    );
    return {documentId,snapshotId:snapshot.id,quality,missingReasons,rowCount:normalized.length,reused};
  });
}

export async function failOperationalSync(userId,job,errorCode,{retryDelaySeconds=20}={}){
  if(!Number.isInteger(retryDelaySeconds)||retryDelaySeconds<20||retryDelaySeconds>300)throw new Error('operational_invalid_rate_delay');
  return withOwnedBusinessContext(userId,async(client,businessId)=>{
    const stream=(await client.query(`select id from mc.sync_streams where id=$1 and business_id=$2 and store_id=$3 for update`,[job.stream_id,businessId,job.store_id])).rows[0];
    if(!stream)return;
    const code=String(errorCode).slice(0,100);
    const failed=await client.query(`update mc.sync_runs set status='failed',finished_at=now(),error_code=$2,progress=jsonb_set(progress,'{stage}','"failed"') where id=$1 and business_id=$3 and store_id=$4 and stream_id=$5 and status='running'`,[job.run_id,code,businessId,job.store_id,job.stream_id]);
    if(!failed.rowCount)return;
    if(['operational_unauthorized','operational_payment_required','operational_invalid_request','operational_token_expired','operational_token_type_unsupported','operational_test_token_unsupported','operational_write_token_forbidden','operational_scope_missing'].includes(code))await client.query(`update mc.sync_streams set status='blocked',next_run_at=null where id=$1`,[job.stream_id]);
    else if(code==='operational_rate_limited')await client.query(`update mc.sync_streams set next_run_at=now()+make_interval(secs=>$2) where id=$1`,[job.stream_id,retryDelaySeconds]);
    else if(code==='operational_selection_changed')await client.query(`update mc.sync_streams set next_run_at=now() where id=$1`,[job.stream_id]);
    else await client.query(`update mc.sync_streams set next_run_at=now()+interval '15 minutes' where id=$1`,[job.stream_id]);
  });
}

export async function getOperationalSyncState(userId,storeId){
  return withOwnedBusinessContext(userId,async(client,businessId)=>(await client.query(
    `with selected as (
       select count(*)::int as product_count
         from mc.product_selections ps
         join mc.product_selection_items i
           on i.business_id=ps.business_id and i.store_id=ps.store_id and i.selection_id=ps.id
        where ps.business_id=$1 and ps.store_id=$2 and ps.status='confirmed'
     ),history as (
       select count(*)::int as complete_week_count
         from (
           select date_trunc('week',m.metric_date::timestamp)::date as week_start,
                  count(*) filter(where m.available) as available_count,
                  count(distinct m.product_id) filter(where m.available) as product_count,
                  min(m.metric_date) as first_day,max(m.metric_date) as last_day
             from mc.current_operational_daily_metrics m
            where m.business_id=$1 and m.store_id=$2
              and m.metric_date<date_trunc('week',clock_timestamp() at time zone 'Europe/Moscow')::date
              and exists (
                select 1 from mc.product_selections ps
                join mc.product_selection_items i
                  on i.business_id=ps.business_id and i.store_id=ps.store_id and i.selection_id=ps.id
               where ps.business_id=m.business_id and ps.store_id=m.store_id and ps.status='confirmed' and i.product_id=m.product_id
              )
            group by date_trunc('week',m.metric_date::timestamp)::date
         ) weeks
        cross join selected
        where first_day=week_start and last_day=week_start+6 and selected.product_count>0
          and weeks.product_count=selected.product_count and available_count=selected.product_count*7
     )
     select ss.status as stream_status,ss.last_success_at,ss.next_run_at,ss.cursor,
            r.status as run_status,r.error_code,r.started_at,r.finished_at,r.requested_from,r.requested_to,r.progress,
            p.period_start,p.period_end,s.id as snapshot_id,s.version_no,s.quality,s.missing_reasons,s.fetched_at,s.accepted_at,
            (select count(*)::int from mc.operational_daily_metrics m where m.snapshot_id=s.id) as metric_count,
            history.complete_week_count,(history.complete_week_count>=4) as comparison_ready,
            case when history.complete_week_count>=4 then null else 'operational_history_insufficient' end as comparison_reason
       from mc.sync_streams ss
       cross join history
       left join lateral (select status,error_code,started_at,finished_at,requested_from,requested_to,progress from mc.sync_runs where stream_id=ss.id order by created_at desc limit 1) r on true
       left join lateral (select * from mc.operational_periods where business_id=ss.business_id and store_id=ss.store_id and current_snapshot_id is not null order by period_end desc limit 1) p on true
       left join mc.operational_snapshots s on s.id=p.current_snapshot_id
      where ss.business_id=$1 and ss.store_id=$2 and ss.source_type='operational_sales_funnel'`,[businessId,storeId]
  )).rows[0]??null);
}

export async function listOperationalSyncCandidates(limit=50){
  if(!Number.isInteger(limit)||limit<1||limit>100)throw new Error('operational_invalid_candidate_limit');
  return (await pool.query(`select * from mc.list_operational_sync_candidates($1)`,[limit])).rows;
}
