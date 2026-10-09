import {createHash} from 'node:crypto';
import {verifyOperationalSnapshotObject} from '../../infrastructure/storage/operational-source-storage.mjs';
import {pool as defaultPool} from '../../infrastructure/database/client.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
export const orderOutcomeSignature=job=>sha(JSON.stringify([String(job.credential_generation),job.products.map(p=>`${p.productId}:${p.nmId}`).sort()]));
const chunks=values=>Array.from({length:Math.ceil(values.length/1000)},(_,i)=>values.slice(i*1000,i*1000+1000));

export function createOrderOutcomeRepository({pool=defaultPool,verify=verifyOperationalSnapshotObject}={}){
  const leases=new WeakMap();
  async function transaction(lease,target,action){
    const saved=leases.get(lease);
    if(!saved||saved.error||saved.target.user_id!==target.user_id||saved.target.business_id!==target.business_id||saved.target.store_id!==target.store_id)throw new Error('operational_sync_superseded');
    const {client}=saved;
    await client.query('begin');
    try{
      await client.query("select pg_advisory_xact_lock(hashtextextended('account-erasure:'||$1,0))",[target.business_id]);
      await client.query("select set_config('app.user_id',$1,true),set_config('app.business_id',$2,true)",[target.user_id,target.business_id]);
      const membership=(await client.query(`select role from mc.memberships where user_id=$1 and business_id=$2 for share`,[target.user_id,target.business_id])).rows[0];
      if(!['owner','editor'].includes(membership?.role))throw new Error('operational_refresh_forbidden');
      await client.query('select id from mc.businesses where id=$1 for update',[target.business_id]);
      const result=await action(client);
      if(saved.error)throw new Error('operational_sync_superseded');
      await client.query('commit');return result;
    }catch(error){await client.query('rollback').catch(()=>{});throw error;}
  }
  async function current(client,target){
    const {business_id:business,store_id:store}=target;
    const connection=(await client.query(`select c.credential_generation,c.scopes,s.external_account_id seller_id,cs.ciphertext,cs.nonce,cs.auth_tag
      from mc.stores s join mc.connections c on c.business_id=s.business_id and c.store_id=s.id
      join mc.connection_secrets cs on cs.business_id=c.business_id and cs.connection_id=c.id
      where s.business_id=$1 and s.id=$2 and s.status='active' and c.status='active' and c.scopes ? 'statistics'
      and exists(select 1 from mc.active_profile_stores a where a.business_id=s.business_id and a.store_id=s.id)
      for share of s,c,cs`,[business,store])).rows[0];
    if(!connection)throw new Error('operational_connection_unavailable');
    const selected=(await client.query(`select p.id product_id,p.wb_article::text nm_id from mc.product_selections ps
      join mc.active_profile_products a on a.business_id=ps.business_id and a.store_id=ps.store_id and a.selection_id=ps.id
      join mc.products p on p.business_id=a.business_id and p.store_id=a.store_id and p.id=a.product_id
      where ps.business_id=$1 and ps.store_id=$2 and ps.status='confirmed' order by p.id for share of ps,p`,[business,store])).rows;
    const products=selected.map(p=>({productId:p.product_id,nmId:Number(p.nm_id)}));
    if(!products.length||products.some(p=>!Number.isSafeInteger(p.nmId)||p.nmId<=0)||new Set(products.map(p=>p.nmId)).size!==products.length)throw new Error('operational_invalid_selection');
    return {...target,...connection,credential_generation:String(connection.credential_generation),products};
  }
  return {
    async candidates(limit=2){return (await pool.query('select * from mc.list_sku_order_sync_candidates($1)',[Math.min(2,Math.max(1,limit))])).rows;},
    async hasBatch(target,batchId){
      let client,broken;
      try{
        client=await pool.connect();
        await client.query('begin');
        await client.query("set local lock_timeout='5s'; set local statement_timeout='10s'");
        await client.query("select pg_advisory_xact_lock(hashtextextended('account-erasure:'||$1,0))",[target.business_id]);
        await client.query("select set_config('app.user_id',$1,true),set_config('app.business_id',$2,true)",[target.user_id,target.business_id]);
        const membership=(await client.query('select role from mc.memberships where user_id=$1 and business_id=$2 for share',[target.user_id,target.business_id])).rows[0];
        if(!['owner','editor'].includes(membership?.role))throw new Error('operational_refresh_forbidden');
        // Wait for an uncertain publication transaction to finish before reading.
        await client.query('select id from mc.businesses where id=$1 for update',[target.business_id]);
        const present=(await client.query('select exists(select 1 from mc.sku_order_batches where business_id=$1 and store_id=$2 and id=$3) present',[target.business_id,target.store_id,batchId])).rows[0]?.present;
        await client.query('commit');return typeof present==='boolean'?present:null;
      }catch(error){broken=error;if(client)await client.query('rollback').catch(()=>{});return null;}
      finally{client?.release(broken);}
    },
    async acquire(target){
      const client=await pool.connect(),key=`sku-order-outcomes:${target.business_id}:${target.store_id}`;
      const saved={client,target,error:null};
      const onError=error=>{saved.error=error;};client.on('error',onError);
      try{
        if((await client.query('select pg_try_advisory_lock(hashtextextended($1,0)) locked',[key])).rows[0]?.locked!==true){client.removeListener('error',onError);client.release();return null;}
        let released=false;
        const lease={assertActive(){if(released||saved.error)throw new Error('operational_sync_superseded');},async release(){
          if(released)return;released=true;leases.delete(lease);
          try{if(!saved.error&&(await client.query('select pg_advisory_unlock(hashtextextended($1,0)) unlocked',[key])).rows[0]?.unlocked!==true)saved.error=new Error('operational_sync_superseded');}
          catch(error){saved.error=error;}
          finally{client.removeListener('error',onError);client.release(saved.error||undefined);}
        }};
        leases.set(lease,saved);return lease;
      }catch(error){client.removeListener('error',onError);client.release(error);throw error;}
    },
    async begin(lease,target,now){return transaction(lease,target,async client=>{
      const job=await current(client,target);
      const state=(await client.query('select * from mc.sku_order_sync_state where business_id=$1 and store_id=$2 for update',[target.business_id,target.store_id])).rows[0];
      if(state?.next_run_at&&new Date(state.next_run_at)>now)return null;
      job.signature=orderOutcomeSignature(job);job.reset=state?.scope_signature!==job.signature;
      job.cursors=job.reset?{}:{orders:state.orders_cursor,sales:state.sales_cursor};
      return job;
    });},
    async reserve(lease,job,endpoint){return transaction(lease,job,async client=>{
      const kind=endpoint.endsWith('/sales')?'sales':endpoint.endsWith('/orders')?'orders':null;
      if(!kind)throw new Error('operational_invalid_request');
      const fresh=await current(client,job);
      if(orderOutcomeSignature(fresh)!==job.signature)throw new Error('operational_sync_superseded');
      const result=(await client.query(`insert into mc.wb_api_request_slots(rate_key,next_allowed_at) values($1,clock_timestamp()+interval '65 seconds')
        on conflict(rate_key) do update set next_allowed_at=greatest(mc.wb_api_request_slots.next_allowed_at,clock_timestamp())+interval '65 seconds',updated_at=clock_timestamp()
        returning greatest(0,extract(epoch from(next_allowed_at-interval '65 seconds'-clock_timestamp()))*1000)::bigint wait_ms`,[sha(`wb:statistics:${kind}:${job.seller_id}`)])).rows[0];
      return {waitMs:Number(result.wait_ms)};
    });},
    async complete(lease,job,{batchId,result,objects,sourceFrom,coverageEnd,storage}){
      if(result.complete!==true||!objects.length||objects.length!==result.pages.length)throw new Error('operational_invalid_result');
      for(const [index,object] of objects.entries()){
        const page=result.pages[index],endpoint=page?.endpoint?.endsWith('/sales')?'sales':page?.endpoint?.endsWith('/orders')?'orders':null;
        if(!endpoint||object.endpoint!==endpoint||object.partNumber!==index||object.checksum!==page.checksum)throw new Error('operational_invalid_result');
        await verify(object,storage);
      }
      return transaction(lease,job,async client=>{
        const fresh=await current(client,job);
        if(orderOutcomeSignature(fresh)!==job.signature||fresh.seller_id!==job.seller_id)throw new Error('operational_sync_superseded');
        const args=[job.business_id,job.store_id];
        await client.query(`insert into mc.sku_order_batches(id,business_id,store_id,observed_at,credential_generation,source_from) values($3,$1,$2,$4,$5,$6)`,[...args,batchId,result.observedThrough,job.credential_generation,sourceFrom]);
        for(const object of objects)await client.query(`insert into mc.sku_order_source_objects(business_id,store_id,batch_id,part_no,endpoint,storage_key,checksum,byte_size) values($1,$2,$3,$4,$5,$6,$7,$8)`,[...args,batchId,object.partNumber,object.endpoint,object.storageKey,object.checksum,object.byteSize]);
        const selected=new Map(job.products.map(p=>[p.nmId,p.productId]));
        const identities=result.orders.filter(o=>selected.has(o.nmId)).map(o=>({srid:o.srid,product_id:selected.get(o.nmId),ordered_at:o.orderedAt}));
        const events=result.events.filter(e=>selected.has(e.nmId)).map(e=>({source_key:e.sourceKey,changed_at:e.changedAt,srid:e.srid,product_id:selected.get(e.nmId),outcome:e.outcome,outcome_at:e.outcomeAt}));
        for(const rows of chunks(identities)){
          const values=[...args,batchId,JSON.stringify(rows)];
          await client.query(`insert into mc.sku_order_identities(business_id,store_id,batch_id,srid,product_id,ordered_at)
            select $1,$2,$3,r.srid,r.product_id,r.ordered_at from jsonb_to_recordset($4::jsonb) as r(srid text,product_id uuid,ordered_at timestamptz) on conflict do nothing`,values);
          const conflict=(await client.query(`select exists(select 1 from jsonb_to_recordset($3::jsonb) as r(srid text,product_id uuid,ordered_at timestamptz)
            join mc.sku_order_identities o on o.business_id=$1 and o.store_id=$2 and o.srid=r.srid where o.product_id<>r.product_id or o.ordered_at<>r.ordered_at) conflict`,[...args,JSON.stringify(rows)])).rows[0];
          if(conflict.conflict)throw new Error('operational_outcomes_duplicate_conflict');
        }
        for(const rows of chunks(events)){
          const values=[...args,batchId,JSON.stringify(rows)];
          await client.query(`insert into mc.sku_order_events(business_id,store_id,batch_id,source_key,changed_at,srid,product_id,outcome,outcome_at)
            select $1,$2,$3,r.source_key,r.changed_at,r.srid,r.product_id,r.outcome,r.outcome_at from jsonb_to_recordset($4::jsonb) as r(source_key text,changed_at timestamptz,srid text,product_id uuid,outcome text,outcome_at timestamptz) on conflict do nothing`,values);
          const conflict=(await client.query(`select exists(select 1 from jsonb_to_recordset($3::jsonb) as r(source_key text,changed_at timestamptz,srid text,product_id uuid,outcome text,outcome_at timestamptz)
            join mc.sku_order_events e on e.business_id=$1 and e.store_id=$2 and e.source_key=r.source_key and e.changed_at=r.changed_at
            where e.srid<>r.srid or e.product_id<>r.product_id or e.outcome<>r.outcome or e.outcome_at<>r.outcome_at) conflict`,[...args,JSON.stringify(rows)])).rows[0];
          if(conflict.conflict)throw new Error('operational_outcomes_duplicate_conflict');
        }
        const touched=[...new Set([...identities,...events].map(row=>row.srid))];
        for(const srids of chunks(touched)){
          const mismatch=(await client.query(`select exists(
            select 1 from mc.sku_order_events e join mc.sku_order_identities o
              on o.business_id=e.business_id and o.store_id=e.store_id and o.srid=e.srid
              where e.business_id=$1 and e.store_id=$2 and e.srid=any($3::text[])
                and (e.product_id<>o.product_id or e.outcome_at<o.ordered_at)
            union all select 1 from mc.sku_order_events e join mc.sku_order_events other
              on other.business_id=e.business_id and other.store_id=e.store_id and other.srid=e.srid
              where e.business_id=$1 and e.store_id=$2 and e.srid=any($3::text[]) and e.product_id<>other.product_id
          ) conflict`,[...args,srids])).rows[0];
          if(mismatch.conflict)throw new Error('operational_outcomes_duplicate_conflict');
        }
        await client.query(`insert into mc.sku_order_coverage(business_id,store_id,product_id,coverage_start,coverage_end,batch_id)
          select $1,$2,unnest($3::uuid[]),$4::date,$5::date,$6
          on conflict(business_id,store_id,product_id) do update set coverage_start=case when excluded.coverage_start>mc.sku_order_coverage.coverage_end+1 then excluded.coverage_start else least(mc.sku_order_coverage.coverage_start,excluded.coverage_start) end,
          coverage_end=excluded.coverage_end,batch_id=excluded.batch_id`,[...args,job.products.map(p=>p.productId),sourceFrom,coverageEnd,batchId]);
        await client.query(`insert into mc.sku_order_sync_state(business_id,store_id,orders_cursor,sales_cursor,scope_signature,next_run_at,observed_at)
          values($1,$2,$3,$4,$5,clock_timestamp()+interval '1 hour',$6)
          on conflict(store_id) do update set orders_cursor=excluded.orders_cursor,sales_cursor=excluded.sales_cursor,scope_signature=excluded.scope_signature,next_run_at=excluded.next_run_at,observed_at=excluded.observed_at,last_error_code=null,updated_at=clock_timestamp()`,[...args,result.cursors.orders,result.cursors.sales,job.signature,result.observedThrough]);
      });
    },
    async fail(lease,target,code){return transaction(lease,target,client=>client.query(`insert into mc.sku_order_sync_state(business_id,store_id,next_run_at,last_error_code)
      values($1,$2,clock_timestamp()+interval '15 minutes',$3) on conflict(store_id) do update set next_run_at=excluded.next_run_at,last_error_code=excluded.last_error_code,updated_at=clock_timestamp()`,[target.business_id,target.store_id,code]));}
  };
}
