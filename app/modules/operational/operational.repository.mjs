import { createHash } from 'node:crypto';
import { pool, withBusinessContext, withOwnedBusinessContext } from '../../infrastructure/database/client.mjs';
import { verifyOperationalSnapshotObject } from '../../infrastructure/storage/operational-source-storage.mjs';
import { validateCalendarDate } from '../overview/financial-overview.mjs';
import { readFinancialReturnsCache } from './financial-returns-cache.mjs';

const parserVersion='wb-operational-cache-returns-v4';
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

async function cachedSources(client,businessId,job,now){
  const range=period(job.date_from,job.date_to),today=operationalDisplayRange({now}).today;
  const productIds=job.products.map(product=>product.productId);
  const rows=(await client.query(`with candidates as (
    select s.id snapshot_id,a.fetched_at,day::date metric_date,
      row_number() over(partition by day::date order by a.fetched_at desc,a.created_at desc,a.id desc) rank
    from mc.operational_snapshots s
    join mc.operational_snapshot_activations a on a.business_id=s.business_id and a.store_id=s.store_id and a.snapshot_id=s.id
    join mc.operational_periods p on p.id=s.operational_period_id
    cross join lateral generate_series(greatest(p.period_start,$4::date),least(p.period_end,$5::date),interval '1 day') day
    where s.business_id=$1 and s.store_id=$2 and s.status='accepted'
      and p.period_start<=$5::date and p.period_end>=$4::date
      and (day::date<$7::date or a.fetched_at>=$6::timestamptz-interval '1 hour')
      and (select count(*) from mc.operational_snapshot_products sp where sp.snapshot_id=s.id)=cardinality($3::uuid[])
      and not exists(select 1 from mc.operational_snapshot_products sp where sp.snapshot_id=s.id and not(sp.product_id=any($3::uuid[])))
      and (select count(*) from mc.operational_daily_metrics m where m.snapshot_id=s.id and m.metric_date=day::date)=cardinality($3::uuid[])
  ) select m.*,m.metric_date::text metric_day,m.order_count::text orders,m.buyout_count::text buyouts,m.cancel_count::text cancels,
      m.return_count::text returns,p.wb_article::text nm_id,c.fetched_at
    from candidates c join mc.operational_daily_metrics m on m.snapshot_id=c.snapshot_id and m.metric_date=c.metric_date
    join mc.products p on p.business_id=m.business_id and p.store_id=m.store_id and p.id=m.product_id
    where c.rank=1 order by m.metric_date,m.product_id`,[businessId,job.store_id,productIds,range.dateFrom,range.dateTo,now,today])).rows;
  const funnelRows=rows.filter(row=>Number.isSafeInteger(Number(row.orders))&&Number.isSafeInteger(Number(row.buyouts))).map(row=>({
    nmId:Number(row.nm_id),date:row.metric_day,currency:row.currency,orderCount:Number(row.orders),orderSum:row.order_amount,
    buyoutCount:Number(row.buyouts),buyoutSum:row.buyout_amount,cancelCount:row.cancels==null?null:Number(row.cancels),cancelSum:row.cancel_amount}));
  const financial=await readFinancialReturnsCache(client,businessId,job.store_id,job.products,{dateFrom:range.dateFrom,dateTo:range.dateTo,today});
  const financialKeys=new Set(financial.map(row=>`${row.nmId}:${row.date}`));
  const statistics=rows.filter(row=>row.returns!=null&&row.return_amount!=null&&row.return_source!=='financial_report'
    &&Number.isSafeInteger(Number(row.returns))&&!financialKeys.has(`${row.nm_id}:${row.metric_day}`)).map(row=>({
    nmId:Number(row.nm_id),date:row.metric_day,returnCount:Number(row.returns),returnSum:row.return_amount,
    returnSource:'statistics_sales',returnDateBasis:'return_event_date',returnAmountBasis:'price_with_discount',
    returnSourceRefs:row.return_source_refs??{snapshotId:row.snapshot_id,rowChecksum:row.row_checksum}}));
  const returnsRows=[...financial,...statistics];
  const raw=JSON.stringify({source:'accepted_database_cache',period:range,funnel:rows.map(row=>({snapshotId:row.snapshot_id,
    productId:row.product_id,date:row.metric_day,rowChecksum:row.row_checksum,fetchedAt:row.fetched_at})),returns:returnsRows});
  return {funnelRows,returnsRows,raw,rawChecksum:sha(raw)};
}

export async function getOperationalCachedSources(userId,job,{now=new Date()}={}){
  return withBusinessContext(userId,job.business_id,async(client,businessId)=>{
    const store=(await client.query(`select s.id,c.credential_generation from mc.stores s
      join mc.connections c on c.business_id=s.business_id and c.store_id=s.id and c.status='active'
      where s.business_id=$1 and s.id=$2 and s.status='active'`,[businessId,job.store_id])).rows[0];
    if(!store||Number(store.credential_generation)!==job.credential_generation)throw new Error('operational_sync_superseded');
    const selected=(await client.query(`select p.id product_id,p.wb_article::text nm_id from mc.product_selections s
      join mc.product_selection_items i on i.selection_id=s.id and i.business_id=s.business_id and i.store_id=s.store_id
      join mc.products p on p.business_id=i.business_id and p.store_id=i.store_id and p.id=i.product_id
      where s.business_id=$1 and s.store_id=$2 and s.status='confirmed' order by p.wb_article,p.id`,[businessId,job.store_id])).rows;
    if(selected.length!==job.products.length||selected.some((row,index)=>`${row.product_id}:${row.nm_id}`!==`${job.products[index].productId}:${job.products[index].nmId}`))throw new Error('operational_selection_changed');
    return cachedSources(client,businessId,job,now);
  });
}

export async function beginOperationalSync(userId,storeId,{force=false,dateFrom,dateTo,businessId:targetBusinessId}={}){
  let range=period(dateFrom,dateTo);
  const inContext=targetBusinessId
    ? action=>withBusinessContext(userId,targetBusinessId,action)
    : action=>withOwnedBusinessContext(userId,action);
  return inContext(async(client,businessId,role)=>{
    if(!['owner','editor'].includes(role))throw new Error('operational_refresh_forbidden');
    await client.query(`select 1 from mc.businesses where id=$1 for update`,[businessId]);
    await client.query(
      `insert into mc.sync_streams(business_id,store_id,source_type,next_run_at,status)
       select s.business_id,s.id,'operational_sales_funnel',now(),'active'
         from mc.stores s join mc.connections c on c.business_id=s.business_id and c.store_id=s.id and c.status='active'
        where s.business_id=$1 and s.id=$2 and s.marketplace_code='wb' and s.status='active'
       on conflict(store_id,source_type) do nothing`,[businessId,storeId]
    );
    const row=(await client.query(
      `select ss.id as stream_id,ss.next_run_at,c.credential_generation,c.scopes,cs.ciphertext,cs.nonce,cs.auth_tag,s.external_account_id as seller_id
         from mc.stores s
         join mc.connections c on c.business_id=s.business_id and c.store_id=s.id and c.status='active'
         join mc.connection_secrets cs on cs.business_id=c.business_id and cs.connection_id=c.id
         join mc.sync_streams ss on ss.business_id=s.business_id and ss.store_id=s.id
           and ss.source_type='operational_sales_funnel' and ss.status='active'
        where s.business_id=$1 and s.id=$2 and s.status='active'
        for update of ss`,[businessId,storeId]
    )).rows[0];
    if(!row)throw new Error('operational_connection_unavailable');
    if(!row.scopes.includes('analytics'))return {started:false,reason:'operational_scope_missing'};
    if(!row.scopes.includes('statistics'))return {started:false,reason:'operational_statistics_scope_missing'};
    if(!(await client.query(`select mc.operational_financial_bootstrap_ready($1) ready`,[storeId])).rows[0].ready)return {started:false,reason:'waiting_financial'};
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
    const pending=(await client.query(`select metric_date::text from mc.operational_range_requests where business_id=$1 and store_id=$2 and (status='pending' or status='failed' and retryable) order by case status when 'pending' then 0 else 1 end,metric_date desc limit 1`,[businessId,storeId])).rows[0];
    if(pending){
      const ending=calendarDay(pending.metric_date);
      const starting=(await client.query(`select min(metric_date)::text as start from mc.operational_range_requests where business_id=$1 and store_id=$2 and (status='pending' or status='failed' and retryable) and metric_date between $3::date-6 and $3::date`,[businessId,storeId,ending.text])).rows[0].start;
      range=period(starting,ending.text);
    }
    const run=(await client.query(
      `insert into mc.sync_runs(business_id,store_id,stream_id,requested_from,requested_to,status,started_at,progress)
       values($1,$2,$3,$4,$5,'running',now(),'{"stage":"queued","batches":0,"rows":0}') returning id`,
      [businessId,storeId,row.stream_id,range.dateFrom,range.dateTo]
    )).rows[0];
    await client.query(`update mc.sync_streams set next_run_at=null where id=$1`,[row.stream_id]);
    return {started:true,business_id:businessId,store_id:storeId,stream_id:row.stream_id,run_id:run.id,
      date_from:range.dateFrom,date_to:range.dateTo,credential_generation:Number(row.credential_generation),scopes:row.scopes,seller_id:row.seller_id,ciphertext:row.ciphertext,nonce:row.nonce,auth_tag:row.auth_tag,
      products:products.map(item=>({productId:item.product_id,nmId:Number(item.nm_id)}))};
  });
}

export async function reserveOperationalRequestSlot(userId,job,delaySeconds=20){
  if(!Number.isInteger(delaySeconds)||delaySeconds<20||delaySeconds>60)throw new Error('operational_invalid_rate_delay');
  return withBusinessContext(userId,job.business_id,async(client,businessId)=>{
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

export async function reserveOperationalPurchasedReturnsSlot(userId,job,delaySeconds=65){
  if(!Number.isInteger(delaySeconds)||delaySeconds<65||delaySeconds>300)throw new Error('operational_invalid_rate_delay');
  return withBusinessContext(userId,job.business_id,async(client,businessId)=>{
    if(businessId!==job.business_id||!job.seller_id)throw new Error('operational_context_mismatch');
    const rateKey=sha(`wb:statistics:sales:${job.seller_id}`);
    const slot=(await client.query(
      `insert into mc.wb_api_request_slots(rate_key,next_allowed_at)
       values($1,clock_timestamp()+make_interval(secs=>$2))
       on conflict(rate_key) do update set next_allowed_at=greatest(mc.wb_api_request_slots.next_allowed_at,clock_timestamp())+make_interval(secs=>$2),updated_at=clock_timestamp()
       returning next_allowed_at-make_interval(secs=>$2) scheduled_at,next_allowed_at`,[rateKey,delaySeconds]
    )).rows[0];
    return {scheduledAt:slot.scheduled_at,nextAllowedAt:slot.next_allowed_at,waitMs:Math.max(0,new Date(slot.scheduled_at).getTime()-Date.now())};
  });
}

export async function updateOperationalSyncProgress(userId,job,progress){
  return withBusinessContext(userId,job.business_id,async(client,businessId)=>{
    if(businessId!==job.business_id)throw new Error('operational_context_mismatch');
    await client.query(`update mc.sync_runs set progress=$2::jsonb where id=$1 and business_id=$3 and status='running'`,[job.run_id,JSON.stringify(progress),businessId]);
  });
}

export async function completeOperationalSync(userId,job,{documentId,snapshotId,objects,metrics,fetchedAt=new Date(),storage}={}){
  const range=period(job.date_from,job.date_to);
  if(!Array.isArray(objects)||!objects.length||!Array.isArray(metrics))throw new Error('operational_invalid_result');
  return withBusinessContext(userId,job.business_id,async(client,businessId)=>{
    if(businessId!==job.business_id||!Array.isArray(job.products)||!job.products.length)throw new Error('operational_context_mismatch');
    await client.query(`select 1 from mc.businesses where id=$1 for update`,[businessId]);
    const stream=(await client.query(`select id from mc.sync_streams where id=$1 and business_id=$2 and store_id=$3 for update`,[job.stream_id,businessId,job.store_id])).rows[0];
    const run=stream&&(await client.query(`select status from mc.sync_runs where id=$1 and business_id=$2 and store_id=$3 and stream_id=$4 for update`,[job.run_id,businessId,job.store_id,job.stream_id])).rows[0];
    if(run?.status!=='running')throw new Error('operational_sync_superseded');
    const connection=(await client.query(`select credential_generation from mc.connections where business_id=$1 and store_id=$2 and status='active'`,[businessId,job.store_id])).rows[0];
    if(!connection||Number(connection.credential_generation)!==job.credential_generation)throw new Error('operational_sync_superseded');
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
      if((metric.cancelCount==null)!==(metric.cancelSum==null)||metric.cancelCount!=null&&(!Number.isSafeInteger(metric.cancelCount)||metric.cancelCount<0))throw new Error('operational_invalid_metric');
      if(metric.returnCount==null&&metric.returnSum!=null||metric.returnCount!=null&&(!Number.isSafeInteger(metric.returnCount)||metric.returnCount<0))throw new Error('operational_invalid_metric');
      const returnSource=metric.returnCount==null?null:metric.returnSource??'statistics_sales';
      const returnDateBasis=returnSource==='financial_report'?'accounting_date':returnSource?'return_event_date':null;
      const returnAmountBasis=returnSource==='financial_report'?'retail_price_with_discount':returnSource?'price_with_discount':null;
      if(returnSource&&!['financial_report','statistics_sales'].includes(returnSource)
        ||metric.returnDateBasis&&metric.returnDateBasis!==returnDateBasis||metric.returnAmountBasis&&metric.returnAmountBasis!==returnAmountBasis
        ||returnSource==='financial_report'&&(!metric.returnSourceRefs?.coverageId||!Array.isArray(metric.returnSourceRefs.inventory)))throw new Error('operational_invalid_metric');
      if(returnSource==='financial_report'&&!(await client.query(`select mc.operational_financial_return_refs_current($1,$2,$3::jsonb) valid`,
        [businessId,job.store_id,JSON.stringify(metric.returnSourceRefs)])).rows[0].valid)throw new Error('operational_financial_cache_changed');
      const row={productId,date:date.text,currency:'RUB',orderCount:metric.orderCount,orderAmount:decimal(metric.orderSum),buyoutCount:metric.buyoutCount,buyoutAmount:decimal(metric.buyoutSum),cancelCount:metric.cancelCount??null,cancelAmount:metric.cancelSum==null?null:decimal(metric.cancelSum),returnCount:metric.returnCount??null,returnAmount:metric.returnSum==null?null:decimal(metric.returnSum),returnSource,returnDateBasis,returnAmountBasis,returnSourceRefs:metric.returnSourceRefs??null};
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
        `insert into mc.operational_daily_metrics(business_id,store_id,snapshot_id,product_id,metric_date,currency,order_count,order_amount,buyout_count,buyout_amount,row_checksum,cancel_count,cancel_amount,return_count,return_amount,return_source,return_date_basis,return_amount_basis,return_source_refs)
         values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb)`,
        [businessId,job.store_id,snapshot.id,metric.productId,metric.date,metric.currency,metric.orderCount,metric.orderAmount,metric.buyoutCount,metric.buyoutAmount,metric.rowChecksum,metric.cancelCount,metric.cancelAmount,metric.returnCount,metric.returnAmount,metric.returnSource,metric.returnDateBasis,metric.returnAmountBasis,metric.returnSourceRefs==null?null:JSON.stringify(metric.returnSourceRefs)]
      );
      await client.query(`update mc.operational_snapshots set status='validated' where id=$1`,[snapshot.id]);
      await client.query(`update mc.operational_snapshots set status='accepted',accepted_at=now() where id=$1`,[snapshot.id]);
    }else if(snapshot.status!=='accepted')throw new Error('operational_snapshot_not_accepted');
    for(let day=range.fromDay;day<=range.toDay;day++){
      const date=new Date(day*dayMs).toISOString().slice(0,10);
      const dayRows=normalized.filter(row=>row.date===date),returnsRequired=operationalReturnsRequired(date,fetchedAt);
      const complete=dayRows.filter(row=>!returnsRequired||row.returnCount!=null&&row.returnAmount!=null).length===job.products.length;
      const amountPending=returnsRequired&&dayRows.length===job.products.length&&dayRows.some(row=>row.returnCount>0&&row.returnAmount==null);
      await client.query(`update mc.operational_range_requests set status=$4,retryable=$5,
        initial_status=case when initial_status='complete' then initial_status when initial_status is not null then $4 else null end
        where business_id=$1 and store_id=$2 and metric_date=$3`,[businessId,job.store_id,date,complete?'complete':'failed',amountPending]);
    }
    await client.query(
      `insert into mc.operational_snapshot_activations(business_id,store_id,operational_period_id,snapshot_id,document_id,fetched_at)
       values($1,$2,$3,$4,$5,$6)`,[businessId,job.store_id,operationalPeriod.id,snapshot.id,documentId,fetchedAt]
    );
    await client.query(`update mc.operational_periods set current_snapshot_id=$1 where id=$2`,[snapshot.id,operationalPeriod.id]);
    const progress={stage:'complete',quality,products:job.products.length,rows:normalized.length,batches:normalizedObjects.length,reused};
    await client.query(`update mc.sync_runs set status=$2,finished_at=now(),error_code=null,progress=$3::jsonb where id=$1 and status='running'`,[job.run_id,quality==='complete'?'succeeded':'partial',JSON.stringify(progress)]);
    await client.query(
      `update mc.sync_streams set cursor=coalesce(cursor,'{}'::jsonb)||$2::jsonb,last_success_at=now(),next_run_at=case when exists(select 1 from mc.operational_range_requests where store_id=mc.sync_streams.store_id and status='pending') then now() when exists(select 1 from mc.operational_range_requests where store_id=mc.sync_streams.store_id and status='failed' and retryable) then now()+interval '15 minutes' else now()+interval '1 hour' end where id=$1`,
      [job.stream_id,JSON.stringify({dateFrom:range.dateFrom,dateTo:range.dateTo,snapshotId:snapshot.id,quality})]
    );
    return {documentId,snapshotId:snapshot.id,quality,missingReasons,rowCount:normalized.length,reused};
  });
}

export async function failOperationalSync(userId,job,errorCode,{retryDelaySeconds=20}={}){
  if(!Number.isInteger(retryDelaySeconds)||retryDelaySeconds<20||retryDelaySeconds>300)throw new Error('operational_invalid_rate_delay');
  return withBusinessContext(userId,job.business_id,async(client,businessId)=>{
    await client.query(`select 1 from mc.businesses where id=$1 for update`,[businessId]);
    const stream=(await client.query(`select id from mc.sync_streams where id=$1 and business_id=$2 and store_id=$3 for update`,[job.stream_id,businessId,job.store_id])).rows[0];
    if(!stream)return;
    const code=String(errorCode).slice(0,100);
    const failed=await client.query(`update mc.sync_runs set status='failed',finished_at=now(),error_code=$2,progress=jsonb_set(progress,'{stage}','"failed"') where id=$1 and business_id=$3 and store_id=$4 and stream_id=$5 and status='running'`,[job.run_id,code,businessId,job.store_id,job.stream_id]);
    if(!failed.rowCount)return;
    await client.query(`update mc.operational_range_requests set status='failed',retryable=true,
      initial_status=case when initial_status='complete' then initial_status when initial_status is not null then 'failed' else null end
      where business_id=$1 and store_id=$2 and metric_date between $3 and $4 and status<>'complete'`,[businessId,job.store_id,job.date_from,job.date_to]);
    if(['operational_unauthorized','operational_payment_required','operational_invalid_request','operational_token_expired','operational_token_type_unsupported','operational_test_token_unsupported','operational_write_token_forbidden','operational_scope_missing','operational_statistics_scope_missing'].includes(code))await client.query(`update mc.sync_streams set status='blocked',next_run_at=null where id=$1`,[job.stream_id]);
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

export function operationalDisplayRange({periodStart=null,periodEnd=null,now=new Date()}={}){
  if(!(now instanceof Date)||Number.isNaN(now.getTime()))throw new Error('operational_invalid_clock');
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
  if(periodStart==null&&periodEnd==null){periodEnd=today;periodStart=new Date((calendarDay(today).number-6)*dayMs).toISOString().slice(0,10);}
  validateCalendarDate(periodStart);validateCalendarDate(periodEnd);
  const from=calendarDay(periodStart),to=calendarDay(periodEnd);
  if(to.number<from.number||to.number-from.number>365||periodEnd>today)throw new Error('operational_invalid_period');
  return {start:from.text,end:to.text,days:to.number-from.number+1,today};
}

export async function requestOperationalRangeRefresh(userId,storeId,start,end,{now=new Date()}={}){
  const range=operationalDisplayRange({periodStart:start,periodEnd:end,now});
  const earliest=operationalRefreshStart(range);
  return withOwnedBusinessContext(userId,async(client,businessId,role)=>{
    if(!['owner','editor'].includes(role))throw new Error('operational_refresh_forbidden');
    await client.query(`select 1 from mc.businesses where id=$1 for share`,[businessId]);
    const store=(await client.query(`select s.id,c.scopes from mc.stores s join mc.connections c on c.business_id=s.business_id and c.store_id=s.id and c.status='active' where s.business_id=$1 and s.id=$2 and s.status='active' and s.marketplace_code='wb'`,[businessId,storeId])).rows[0];
    if(!store)throw new Error('operational_connection_unavailable');
    if(earliest>range.end)return {queued:0,pendingDays:0,status:'unavailable',errorCode:'operational_history_out_of_range'};
    const products=(await client.query(`select i.product_id,p.wb_article::text nm_id from mc.product_selections ps
      join mc.product_selection_items i on i.selection_id=ps.id and i.business_id=ps.business_id and i.store_id=ps.store_id
      join mc.products p on p.business_id=i.business_id and p.store_id=i.store_id and p.id=i.product_id
      where ps.business_id=$1 and ps.store_id=$2 and ps.status='confirmed'`,[businessId,storeId])).rows;
    if(!products.length)return {queued:0,status:'unavailable'};
    await client.query(`insert into mc.sync_streams(business_id,store_id,source_type,status,next_run_at) values($1,$2,'operational_sales_funnel','active',now()) on conflict(store_id,source_type) do nothing`,[businessId,storeId]);
    const stream=(await client.query(`select id,status from mc.sync_streams where business_id=$1 and store_id=$2 and source_type='operational_sales_funnel' for update`,[businessId,storeId])).rows[0];
    if(stream.status==='blocked'){
      const lastRun=(await client.query(`select status,error_code from mc.sync_runs where stream_id=$1 order by created_at desc,id desc limit 1`,[stream.id])).rows[0];
      if(lastRun?.status!=='failed'||lastRun.error_code!=='operational_invalid_request'||(!store.scopes?.includes('analytics')||!store.scopes?.includes('statistics')))return {queued:0,status:'blocked',errorCode:lastRun?.error_code??'operational_scope_missing'};
      await client.query(`update mc.sync_streams set status='active',next_run_at=now() where id=$1`,[stream.id]);
    }
    // A newly confirmed financial report upgrades an existing operational day
    // locally, including dates older than Statistics' retention window.
    const financialRows=await readFinancialReturnsCache(client,businessId,storeId,products.map(product=>({nmId:product.nm_id})),
      {dateFrom:earliest,dateTo:range.end,today:range.today});
    const financialByDate=new Map();
    for(const metric of financialRows){const covered=financialByDate.get(metric.date)??new Set();covered.add(String(metric.nmId));financialByDate.set(metric.date,covered);}
    const financialDates=[...financialByDate].filter(([,covered])=>products.every(product=>covered.has(String(product.nm_id)))).map(([date])=>date);
    const queued=await client.query(`insert into mc.operational_range_requests(business_id,store_id,metric_date,status,requested_at)
      select $1,$2,day::date,'pending',$6::timestamptz from generate_series($3::date,$4::date,interval '1 day') day
      where (select count(*) from mc.current_operational_daily_metrics m where m.business_id=$1 and m.store_id=$2 and m.metric_date=day::date and m.product_id=any($5::uuid[]) and m.available
        and (case when day::date=any($8::date[]) then m.return_source='financial_report' and m.return_count is not null and m.return_amount is not null
          else day::date<$7::date-89 or m.return_count is not null and m.return_amount is not null end)
        and (day::date<$7::date or m.fetched_at>=$6::timestamptz-interval '1 hour'))<cardinality($5::uuid[])
      on conflict(store_id,metric_date) do update set status='pending',retryable=false,requested_at=excluded.requested_at where mc.operational_range_requests.status in ('complete','failed')`,[businessId,storeId,earliest,range.end,products.map(row=>row.product_id),now,range.today,financialDates]);
    await client.query(`insert into mc.sync_streams(business_id,store_id,source_type,status,next_run_at) values($1,$2,'operational_sales_funnel','active',now()) on conflict(store_id,source_type) do update set next_run_at=case when $3::int>0 then now() else mc.sync_streams.next_run_at end where mc.sync_streams.status='active'`,[businessId,storeId,queued.rowCount]);
    const pendingDays=(await client.query(`select count(*)::int count from mc.operational_range_requests where business_id=$1 and store_id=$2 and status='pending' and metric_date between $3 and $4`,[businessId,storeId,earliest,range.end])).rows[0].count;
    return {queued:queued.rowCount,pendingDays,status:pendingDays?'pending':'current'};
  });
}

export function operationalRefreshStart(range){
  return new Date(Math.max(calendarDay(range.start).number-range.days*4,calendarDay(range.today).number-364)*dayMs).toISOString().slice(0,10);
}

export function operationalReturnsRequired(date,now=new Date()){
  const today=operationalDisplayRange({now}).today;
  return calendarDay(date).number>=calendarDay(today).number-89;
}

export function deriveOperationalProgress({start,end,completeDays=0,pendingDays=0,failedDays=0,retryableDays=0,retryEligible=false,nextRunAt=null,run=null,blocked=false,waitingFinancial=false,errorCode=null,selected=true,factory=false,now=new Date()}={}){
  const totalDays=calendarDay(end).number-calendarDay(start).number+1;
  const missingDays=Math.max(0,totalDays-completeDays-pendingDays-failedDays);
  const overlaps=run&&String(run.requested_from).slice(0,10)<=end&&String(run.requested_to).slice(0,10)>=start;
  const live=overlaps&&run.status==='running'&&new Date(run.started_at).getTime()>now.getTime()-30*60*1000;
  const status=blocked?'blocked':waitingFinancial?'waiting_financial':factory&&!selected?'waiting_selection':live?'running':pendingDays?'pending':failedDays?'failed':missingDays?'unavailable':'current';
  const retryScheduled=retryableDays>0&&retryEligible&&!blocked&&!waitingFinancial&&selected&&nextRunAt!=null&&Number.isFinite(new Date(nextRunAt).getTime());
  return {start,end,totalDays,completeDays,pendingDays,failedDays,missingDays,status,retryScheduled,
    runFrom:live?String(run.requested_from).slice(0,10):null,runTo:live?String(run.requested_to).slice(0,10):null,
    startedAt:live?run.started_at:null,finishedAt:overlaps&&!live?run.finished_at??null:null,
    progress:live?run.progress??null:null,errorCode:blocked?errorCode??'operational_scope_missing':failedDays?(overlaps&&run.status==='failed'?run.error_code:null)??'operational_metric_unavailable':null};
}

async function readOperationalProgress(client,businessId,storeId,range,products,rows,now){
  const waitingFinancial=(await client.query(`select mc.operational_financial_bootstrap_waiting($1) waiting`,[storeId])).rows[0].waiting;
  const returnsStart=new Date((calendarDay(range.today).number-89)*dayMs).toISOString().slice(0,10);
  const clippedStart=operationalRefreshStart(range);
  const outOfRange=clippedStart>range.end;
  const start=outOfRange?new Date((calendarDay(range.start).number-range.days*4)*dayMs).toISOString().slice(0,10):clippedStart;
  const marker=(await client.query(`select period_start::text start,period_end::text end from mc.operational_history_factories where business_id=$1 and store_id=$2`,[businessId,storeId])).rows[0];
  const state=(await client.query(`select ss.status,ss.next_run_at,c.scopes,r.error_code,s.status store_status from mc.sync_streams ss
    join mc.stores s on s.business_id=ss.business_id and s.id=ss.store_id
    left join mc.connections c on c.business_id=ss.business_id and c.store_id=ss.store_id and c.status='active'
    left join lateral(select error_code from mc.sync_runs where stream_id=ss.id order by created_at desc,id desc limit 1) r on true
    where ss.business_id=$1 and ss.store_id=$2 and ss.source_type='operational_sales_funnel'`,[businessId,storeId])).rows[0];
  const requests=(await client.query(`select metric_date::text,status,initial_status,retryable from mc.operational_range_requests where business_id=$1 and store_id=$2 and metric_date between $3 and $4`,[businessId,storeId,marker&&marker.start<start?marker.start:start,marker&&marker.end>range.end?marker.end:range.end])).rows;
  const runFor=async(from,to)=>(await client.query(`select status,error_code,requested_from::text,requested_to::text,started_at,finished_at,progress
    from mc.sync_runs where business_id=$1 and store_id=$2 and stream_id=(select id from mc.sync_streams where business_id=$1 and store_id=$2 and source_type='operational_sales_funnel')
    and requested_from<=$5::date and requested_to>=$4::date
    order by (status='running' and started_at>$3::timestamptz-interval '30 minutes') desc,created_at desc,id desc limit 1`,[businessId,storeId,now,from,to])).rows[0]??null;
  const byDate=new Map();
  for(const row of rows)if(row.available&&(row.metric_date<returnsStart||row.return_count!=null&&row.return_amount!=null)){
    const ids=byDate.get(row.metric_date)??new Set();ids.add(row.product_id);byDate.set(row.metric_date,ids);
  }
  let completeDays=0,pendingDays=0,failedDays=0,retryableDays=0;
  const requested=new Map(requests.map(row=>[row.metric_date,row]));
  for(let day=calendarDay(start).number;day<=calendarDay(range.end).number;day++){
    const date=new Date(day*dayMs).toISOString().slice(0,10),request=requested.get(date);
    if(request?.status==='pending')pendingDays++;
    else if(request?.status==='failed'){failedDays++;if(request.retryable)retryableDays++;}
    else if(request?.status!=='pending'&&products.length&&byDate.get(date)?.size===products.length)completeDays++;
  }
  const blocked=state?.status==='blocked'||Boolean(state&& (!state.scopes?.includes('analytics')||!state.scopes?.includes('statistics')));
  const errorCode=!state?.scopes?.includes('analytics')?'operational_scope_missing':!state?.scopes?.includes('statistics')?'operational_statistics_scope_missing':state?.error_code;
  const retryEligible=state?.status==='active'&&state?.store_status==='active'&&state?.scopes?.includes('analytics')&&state?.scopes?.includes('statistics');
  const updateStatus=deriveOperationalProgress({start,end:range.end,completeDays,pendingDays,failedDays,retryableDays,retryEligible,nextRunAt:state?.next_run_at,selected:products.length>0,blocked,waitingFinancial,errorCode,run:await runFor(start,range.end),now});
  if(outOfRange&&updateStatus.status==='unavailable')updateStatus.errorCode='operational_history_out_of_range';
  const factoryRows=marker&&products.length?(await client.query(`select product_id,metric_date::text,available,return_count,return_amount
    from mc.current_operational_daily_metrics where business_id=$1 and store_id=$2 and metric_date between $3 and $4
      and product_id=any($5::uuid[])`,[businessId,storeId,marker.start,marker.end,products.map(row=>row.product_id)])).rows:[];
  const factoryCompleteDates=new Map();
  for(const row of factoryRows)if(row.available&&(row.metric_date<returnsStart||row.return_count!=null&&row.return_amount!=null)){
    const ids=factoryCompleteDates.get(row.metric_date)??new Set();ids.add(row.product_id);factoryCompleteDates.set(row.metric_date,ids);
  }
  const factoryComplete=row=>row.initial_status==='complete'&&products.length>0&&factoryCompleteDates.get(row.metric_date)?.size===products.length;
  updateStatus.factory=marker?deriveOperationalProgress({...marker,
    completeDays:requests.filter(row=>row.metric_date>=marker.start&&row.metric_date<=marker.end&&factoryComplete(row)).length,
    pendingDays:requests.filter(row=>row.metric_date>=marker.start&&row.metric_date<=marker.end&&!factoryComplete(row)&&row.status==='pending').length,
    failedDays:requests.filter(row=>row.metric_date>=marker.start&&row.metric_date<=marker.end&&!factoryComplete(row)&&row.status==='failed').length,
    retryableDays:requests.filter(row=>row.metric_date>=marker.start&&row.metric_date<=marker.end&&!factoryComplete(row)&&row.status==='failed'&&row.retryable).length,
    retryEligible,nextRunAt:state?.next_run_at,blocked,waitingFinancial,errorCode,selected:products.length>0,factory:true,run:await runFor(marker.start,marker.end),now}):null;
  return updateStatus;
}

export async function getOperationalOverviewData(userId,storeId,options={}){
  const range=operationalDisplayRange(options);
  return withOwnedBusinessContext(userId,async(client,businessId)=>{
    await client.query(`select 1 from mc.businesses where id=$1 for share`,[businessId]);
    const store=(await client.query(
      `select s.id,s.name,s.status,s.marketplace_code,(c.status='active') as connected
         from mc.stores s
         left join mc.connections c on c.business_id=s.business_id and c.store_id=s.id
        where s.business_id=$1 and s.id=$2 and s.status<>'archived'`,[businessId,storeId]
    )).rows[0];
    if(!store)return null;
    const products=(await client.query(`select i.product_id from mc.product_selections ps join mc.product_selection_items i on i.business_id=ps.business_id and i.store_id=ps.store_id and i.selection_id=ps.id where ps.business_id=$1 and ps.store_id=$2 and ps.status='confirmed' order by i.product_id`,[businessId,storeId])).rows;
    if(!products.length)return {store,current:null,rows:[],today:range.today,period:{start:range.start,end:range.end,timezone:'Europe/Moscow'},
      updateStatus:await readOperationalProgress(client,businessId,storeId,range,products,[],options.now??new Date())};
    const current={period_start:range.start,period_end:range.end,quality:'complete',missing_reasons:[],product_ids:products.map(row=>row.product_id),fetched_at:options.now??new Date()};
    const rows=(await client.query(
      `select m.product_id,m.metric_date::text,m.snapshot_id,m.currency,m.available,
              m.order_count::text,m.order_amount::text,m.buyout_count::text,m.buyout_amount::text,
              m.quality,m.missing_reasons,m.fetched_at,m.accepted_at,m.cancel_count::text,m.cancel_amount::text,m.return_count::text,m.return_amount::text,
              m.return_source,m.return_date_basis,m.return_amount_basis,m.return_source_refs
         from mc.current_operational_daily_metrics m
        where m.business_id=$1 and m.store_id=$2
          and m.product_id=any($3::uuid[])
          and m.metric_date between $4::date-$6::int*4 and $5::date
        order by m.metric_date,m.product_id`,
      [businessId,storeId,current.product_ids,current.period_start,current.period_end,range.days]
    )).rows;
    // A failed newer refresh must not erase a complete saved day for the same scope.
    const savedRows=(await client.query(
      `with candidates as (
        select s.business_id,s.store_id,s.id snapshot_id,day::date metric_date,a.fetched_at,s.accepted_at,
          row_number() over(partition by day::date order by a.fetched_at desc,a.created_at desc,a.id desc) rank
        from mc.operational_snapshots s
        join mc.operational_snapshot_activations a on a.snapshot_id=s.id and a.business_id=s.business_id and a.store_id=s.store_id
        join mc.operational_periods p on p.id=s.operational_period_id
        cross join lateral generate_series(greatest(p.period_start,$4::date),least(p.period_end,$5::date),interval '1 day') day
        where s.business_id=$1 and s.store_id=$2 and s.status='accepted' and s.quality='complete'
          and p.period_start<=$5::date and p.period_end>=$4::date
          and (select count(*) from mc.operational_snapshot_products sp where sp.snapshot_id=s.id)=cardinality($3::uuid[])
          and not exists(select 1 from mc.operational_snapshot_products sp where sp.snapshot_id=s.id and not(sp.product_id=any($3::uuid[])))
      ) select m.product_id,c.metric_date::text,c.snapshot_id,m.currency,true available,
          m.order_count::text,m.order_amount::text,m.buyout_count::text,m.buyout_amount::text,
          'complete' quality,'[]'::jsonb missing_reasons,c.fetched_at,c.accepted_at,m.cancel_count::text,m.cancel_amount::text,
          case when m.return_source='financial_report' and not mc.operational_financial_return_refs_current(m.business_id,m.store_id,m.return_source_refs) then null else m.return_count::text end return_count,
          case when m.return_source='financial_report' and not mc.operational_financial_return_refs_current(m.business_id,m.store_id,m.return_source_refs) then null else m.return_amount::text end return_amount,
          m.return_source,m.return_date_basis,m.return_amount_basis,m.return_source_refs
        from candidates c join mc.operational_daily_metrics m on m.business_id=c.business_id and m.store_id=c.store_id and m.snapshot_id=c.snapshot_id and m.metric_date=c.metric_date
        where c.rank=1 order by c.metric_date,m.product_id`,[businessId,storeId,current.product_ids,range.start,range.end]
    )).rows;
    const updateStatus=await readOperationalProgress(client,businessId,storeId,range,products,rows,options.now??new Date());
    return {store,current,rows,savedRows,updateStatus,today:range.today};
  });
}

export async function listOperationalSyncCandidates(limit=50){
  if(!Number.isInteger(limit)||limit<1||limit>100)throw new Error('operational_invalid_candidate_limit');
  return (await pool.query(`select * from mc.list_operational_sync_candidates($1)`,[limit])).rows;
}
