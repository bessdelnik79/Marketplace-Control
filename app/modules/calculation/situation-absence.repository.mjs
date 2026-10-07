// Absence of result lines is not absence of operations: zero amounts are omitted
// by the calculator. Read only the immutable inputs of the selected publication.
export async function readSituationRevenueAbsence(client, {context, item, reconciliation}) {
  const unavailable = {soldAbsent:false, returnedAbsent:false};
  const {publication, period, storeId} = context;
  if (context.quality !== 'complete' || context.coverage?.complete !== true || item.quality !== 'complete'
    || reconciliation.status !== 'matched' || !context.scope.productIds.includes(item.productId)
    || !/^financial-result-v(?:29|3[0-6])$/.test(context.method.version)) return unavailable;
  const daily = publication.source === 'daily';
  if (!daily && (publication.source !== 'legacy' || !publication.runId)) return unavailable;
  const days = daily ? `select mapped.accounting_date,mapped.generation_id owner,g.parser_method_version_id
    from mc.financial_daily_publication_days mapped join mc.financial_daily_generations g on g.id=mapped.generation_id
    where mapped.store_id=$1 and mapped.publication_id=$2 and mapped.accounting_date between $3 and $4`
    : `select date::date accounting_date,$2::uuid owner,null::uuid parser_method_version_id
      from generate_series($3::date,$4::date,'1 day'::interval) date`;
  const reports = daily ? `select i.generation_id owner,i.report_version_id,i.report_normalization_id,
      r.period_start,r.period_end,(rn.status='succeeded' and rn.report_version_id=rv.id
        and rn.method_version_id=g.parser_method_version_id and r.store_id=$1) valid
    from mc.financial_daily_generation_inputs i join mc.financial_daily_generations g on g.id=i.generation_id
    left join mc.report_versions rv on rv.id=i.report_version_id and rv.store_id=$1
    left join mc.reports r on r.id=rv.report_id and r.store_id=$1
    left join mc.report_normalizations rn on rn.id=i.report_normalization_id and rn.store_id=$1
    where i.store_id=$1 and i.source_kind='report' and i.generation_id in (select owner from days)`
    : `select i.run_id owner,i.report_version_id,rn.id report_normalization_id,r.period_start,r.period_end,
      (rn.status='succeeded' and r.store_id=$1) valid
    from mc.calculation_inputs i
    left join mc.report_versions rv on rv.id=i.report_version_id and rv.store_id=$1
    left join mc.reports r on r.id=rv.report_id and r.store_id=$1
    left join mc.report_normalizations rn on rn.report_version_id=rv.id and rn.store_id=$1
      and exists(select 1 from mc.calculation_inputs n where n.run_id=$2 and n.store_id=$1 and n.report_normalization_id=rn.id)
    where i.run_id=$2 and i.store_id=$1 and i.report_version_id is not null`;
  const emptyDay = daily ? `exists(select 1 from mc.financial_daily_generation_inputs i
    join mc.financial_week_coverage c on c.id=i.financial_week_coverage_id and c.store_id=$1
    where i.generation_id=d.owner and i.store_id=$1 and i.source_kind='empty_week'
      and d.accounting_date between c.week_start and c.week_end
      and mc.financial_empty_week_evidence_valid(c.id,i.empty_confirmation_job_id))
    and not exists(select 1 from reports r where r.owner=d.owner and d.accounting_date between r.period_start and r.period_end)` : 'false';
  const orphanNormalization = daily ? 'false' : `exists(select 1 from mc.calculation_inputs i
    where i.run_id=$2 and i.store_id=$1 and i.report_normalization_id is not null
      and not exists(select 1 from reports r where r.report_normalization_id=i.report_normalization_id))`;
  const row = (await client.query(`with days as (${days}), reports as (${reports}),
    operations as (select distinct o.id,o.operation_type,o.state,rr.report_version_id=r.report_version_id row_matches
      from days d join reports r on r.owner=d.owner and r.valid
        and d.accounting_date between r.period_start and r.period_end
      join mc.operation_versions o on o.report_normalization_id=r.report_normalization_id and o.store_id=$1
        and o.accounting_date=d.accounting_date and o.product_id=$5
      left join mc.report_rows rr on rr.id=o.report_row_id and rr.store_id=$1)
    select (select count(*) from days)=($4::date-$3::date+1)
      and not exists(select 1 from reports where valid is not true)
      and not (${orphanNormalization})
      and not exists(select 1 from operations where row_matches is not true)
      and not exists(select 1 from days d where not (
        exists(select 1 from reports r where r.owner=d.owner and r.valid and d.accounting_date between r.period_start and r.period_end)
        or (${emptyDay}))) sources_complete,
      not exists(select 1 from operations where operation_type='sale' and state='active') sold_absent,
      not exists(select 1 from operations where operation_type='return' and state='active') returned_absent`,
  [storeId, daily ? publication.id : publication.runId, period.start, period.end, item.productId])).rows[0];
  return row?.sources_complete === true ? {
    storeId, productId:item.productId, period, publicationId:publication.id, publicationSource:publication.source,
    soldAbsent:row.sold_absent === true, returnedAbsent:row.returned_absent === true
  } : unavailable;
}
