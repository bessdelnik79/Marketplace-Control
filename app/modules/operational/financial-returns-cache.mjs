import { financialParserVersion } from '../reports/finance.mjs';

const dayMs=86400000;
const maxOperationalAmount=10n**20n-1n; // PostgreSQL numeric(20,4), scaled by 10,000.
const money=value=>{
  const match=/^-?(\d+)(?:\.(\d{1,4}))?$/.exec(String(value??''));
  return match?BigInt(match[1])*10000n+BigInt((match[2]??'').padEnd(4,'0')):null;
};
const format=value=>`${value/10000n}.${String(value%10000n).padStart(4,'0')}`;
const quantity=value=>{
  const match=/^-([1-9]\d*)(?:\.0+)?$/.exec(String(value??''));
  return match?BigInt(match[1]):null;
};

// Zero is evidence only when the whole closed accounting week is confirmed.
export function financialReturnRows(weeks,operations,products,{dateFrom,dateTo,today}){
  const rows=[];
  for(const week of weeks){
    if(!week.proven||week.week_end>=today)continue;
    const source=operations.filter(row=>row.coverage_id===week.id);
    const relevant=source.filter(row=>row.operation_type==='return');
    if(source.some(row=>row.operation_type==='unclassified')||relevant.some(row=>
      row.state!=='active'||row.doc_type_name!=='Возврат'||row.seller_oper_name!=='Возврат'
      ||quantity(row.quantity)==null||money(row.unit_price)==null||money(row.unit_price)===0n
      ||row.accounting_date<week.week_start||row.accounting_date>week.week_end))continue;
    const refs={coverageId:week.id,credentialGeneration:String(week.credential_generation),
      emptyConfirmationJobId:week.empty_confirmed_by_job_id??null,inventory:week.inventory??[]};
    for(let day=Math.max(Date.parse(week.week_start),Date.parse(dateFrom));day<=Math.min(Date.parse(week.week_end),Date.parse(dateTo));day+=dayMs){
      const date=new Date(day).toISOString().slice(0,10);
      for(const product of products){
        const events=relevant.filter(row=>row.accounting_date===date&&String(row.nm_id)===String(product.nmId));
        let count=0n,sum=0n;
        for(const event of events){const units=quantity(event.quantity);count+=units;sum+=money(event.unit_price)*units;}
        if(count>BigInt(Number.MAX_SAFE_INTEGER)||sum>maxOperationalAmount)continue;
        rows.push({nmId:Number(product.nmId),date,returnCount:Number(count),returnSum:format(sum),
          returnSource:'financial_report',returnDateBasis:'accounting_date',returnAmountBasis:'retail_price_with_discount',
          returnSourceRefs:{...refs,rows:events.map(row=>({reportRowId:row.report_row_id,operationVersionId:row.id,
            reportVersionId:row.report_version_id,reportNormalizationId:row.report_normalization_id,rowChecksum:row.row_checksum}))}});
      }
    }
  }
  return rows;
}

export async function readFinancialReturnsCache(client,businessId,storeId,products,{dateFrom,dateTo,today}){
  const weeks=(await client.query(`select wc.id,wc.week_start::text,wc.week_end::text,wc.credential_generation,wc.empty_confirmed_by_job_id,
    (wc.week_end<$5::date and wc.inventory_confirmed_at is not null and (
      wc.coverage_status='empty' and wc.empty_confirmed_by_job_id is not null
        and not exists(select 1 from mc.financial_week_inventory i where i.coverage_id=wc.id)
        and exists(select 1 from mc.jobs j where j.id=wc.empty_confirmed_by_job_id and j.business_id=wc.business_id
          and j.store_id=wc.store_id and j.status='succeeded' and j.job_type='financial_inventory_refresh'
          and j.payload->>'credentialGeneration'=wc.credential_generation::text)
      or wc.coverage_status='complete' and exists(select 1 from mc.financial_week_inventory i where i.coverage_id=wc.id)
        and not exists(select 1 from generate_series(wc.week_start,wc.week_end,interval '1 day') day
          where not exists(select 1 from mc.financial_week_inventory i where i.coverage_id=wc.id
            and day::date between i.period_start and i.period_end))
        and not exists(select 1 from mc.financial_week_inventory i
          left join mc.reports r on r.business_id=i.business_id and r.store_id=i.store_id and r.external_report_id=i.external_report_id and r.report_type='weekly_realization'
          left join mc.report_versions rv on rv.business_id=i.business_id and rv.store_id=i.store_id and rv.id=i.report_version_id and rv.report_id=r.id
          left join mc.source_documents d on d.id=rv.document_id and d.business_id=rv.business_id and d.store_id=rv.store_id
          left join mc.report_normalizations n on n.business_id=i.business_id and n.store_id=i.store_id and n.id=i.accepted_normalization_id and n.report_version_id=rv.id
          left join mc.method_versions m on m.id=n.method_version_id
          where i.coverage_id=wc.id and (i.fetch_status<>'accepted' or i.accepted_inventory_checksum is distinct from i.inventory_checksum
            or i.accepted_at is null or rv.id is null or r.current_version_id is distinct from rv.id or rv.status<>'accepted'
            or rv.parser_version<>$6 or d.origin is distinct from 'wb_api' or d.completeness is distinct from 'complete'
            or r.period_start is distinct from i.period_start or r.period_end is distinct from i.period_end
            or i.period_start is null or i.period_end is null or i.period_start>i.period_end
            or i.period_start<wc.week_start or i.period_end>wc.week_end
            or n.id is null or n.status<>'succeeded' or n.catalog_revision is distinct from s.catalog_revision
            or m.code is distinct from 'wb_finance_import' or m.implementation_version is distinct from $6
            or exists(select 1 from mc.data_issues issue where issue.report_normalization_id=n.id
              and issue.code='financial_operation_unclassified' and issue.status='open')
            or (select count(*) from mc.operation_versions o where o.report_normalization_id=n.id)<>
               (select count(*) from mc.report_rows rr where rr.report_version_id=rv.id))))) as proven,
    coalesce((select jsonb_agg(jsonb_build_object('inventoryId',i.id,'inventoryChecksum',i.inventory_checksum,
      'reportVersionId',i.report_version_id,'reportNormalizationId',i.accepted_normalization_id,'reportChecksum',rv.checksum)
      order by i.external_report_id) from mc.financial_week_inventory i left join mc.report_versions rv on rv.id=i.report_version_id
      where i.coverage_id=wc.id),'[]'::jsonb) inventory
    from mc.financial_week_coverage wc
    join mc.stores s on s.business_id=wc.business_id and s.id=wc.store_id
    join mc.connections c on c.business_id=wc.business_id and c.store_id=wc.store_id and c.status='active'
      and c.credential_generation=wc.credential_generation and c.scopes ? 'finance'
    where wc.business_id=$1 and wc.store_id=$2 and wc.week_start<=$4::date and wc.week_end>=$3::date
    order by wc.week_start,wc.id`,[businessId,storeId,dateFrom,dateTo,today,financialParserVersion])).rows;
  const ids=weeks.filter(week=>week.proven).map(week=>week.id);
  const operations=ids.length?(await client.query(`select i.coverage_id,o.id,o.report_row_id,o.report_normalization_id,
    rr.report_version_id,rr.row_checksum,o.operation_type,o.state,o.quantity::text,o.accounting_date::text,
    rr.raw_data->>'nmId' nm_id,rr.raw_data->>'docTypeName' doc_type_name,rr.raw_data->>'sellerOperName' seller_oper_name,
    rr.raw_data->>'retailPriceWithdiscRub' unit_price
    from mc.financial_week_inventory i
    join mc.operation_versions o on o.business_id=i.business_id and o.store_id=i.store_id and o.report_normalization_id=i.accepted_normalization_id
    join mc.report_rows rr on rr.business_id=o.business_id and rr.store_id=o.store_id and rr.id=o.report_row_id and rr.report_version_id=i.report_version_id
    where i.coverage_id=any($1::uuid[]) order by i.coverage_id,o.id`,[ids])).rows:[];
  return financialReturnRows(weeks,operations,products,{dateFrom,dateTo,today});
}
