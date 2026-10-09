import {buyoutBounds} from './sku-buyout.mjs';

// Caller has already verified store/publication access in its read-only tenant
// transaction. Limit order identities first, never sale/return event rows.
export async function loadSkuOrderHistories(client,{businessId,storeId,periodEnd,productIds}){
  const bounds=buyoutBounds(periodEnd);
  if(!bounds||!productIds.length)return {};
  const rows=(await client.query(`select coverage.product_id,coverage.coverage_start::text,coverage.coverage_end::text,
      batch.observed_at,batch.id as batch_id,coalesce(history.records,'[]'::jsonb) records
    from mc.sku_order_coverage coverage join mc.sku_order_batches batch
      on batch.business_id=coverage.business_id and batch.store_id=coverage.store_id and batch.id=coverage.batch_id
    left join lateral (
      select jsonb_agg(jsonb_build_object('sku',orders.product_id,'srid',orders.srid,
        'orderedAt',orders.ordered_at,'outcomeAt',events.outcome_at,'outcome',events.outcome)) records
      from (
        select identity.* from mc.sku_order_identities identity
        where identity.business_id=coverage.business_id and identity.store_id=coverage.store_id
          and identity.product_id=coverage.product_id
          and identity.ordered_at>=((greatest($4::date,coverage.coverage_start))::timestamp at time zone 'Europe/Moscow')
          and identity.ordered_at<(($5::date+1)::timestamp at time zone 'Europe/Moscow')
          and exists(select 1 from mc.sku_order_events confirmed where confirmed.business_id=identity.business_id
            and confirmed.store_id=identity.store_id and confirmed.srid=identity.srid
            and confirmed.outcome_at<((least($6::date,coverage.coverage_end)+1)::timestamp at time zone 'Europe/Moscow'))
        order by identity.ordered_at desc,identity.srid collate "C" limit 100
      ) orders join mc.sku_order_events events on events.business_id=orders.business_id
        and events.store_id=orders.store_id and events.srid=orders.srid
        and events.outcome_at<((least($6::date,coverage.coverage_end)+1)::timestamp at time zone 'Europe/Moscow')
    ) history on true
    where coverage.business_id=$1 and coverage.store_id=$2 and coverage.product_id=any($3::uuid[])`,
  [businessId,storeId,productIds,bounds.start,bounds.cutoff,bounds.end])).rows;
  return Object.fromEntries(rows.map(row=>[row.product_id,{
    coverage:{complete:true,start:row.coverage_start,end:row.coverage_end,
      observedAt:new Date(row.observed_at).toISOString(),generationId:row.batch_id,sourceLimited:true},
    records:row.records.map(record=>({...record,
      orderedAt:new Date(record.orderedAt).toISOString(),outcomeAt:new Date(record.outcomeAt).toISOString()}))
  }]));
}
