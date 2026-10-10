BEGIN;

-- Restrict the current snapshot rows before validating financial evidence.
-- Invoker rights and the existing view/table RLS remain the access boundary.
CREATE FUNCTION mc.current_operational_daily_metrics_for_range(
  target_business uuid,target_store uuid,target_start date,target_end date,target_products uuid[]
) RETURNS SETOF mc.current_operational_daily_metrics
LANGUAGE sql STABLE AS $$
 WITH selected_metrics AS MATERIALIZED (
  SELECT current.business_id,current.store_id,current.product_id,current.metric_date,current.snapshot_id,
    current.currency,current.order_count,current.order_amount,current.buyout_count,current.buyout_amount,
    current.available,current.quality,current.missing_reasons,current.fetched_at,current.accepted_at,
    current.cancel_count,current.cancel_amount,raw.return_count,raw.return_amount,
    current.return_source,current.return_date_basis,current.return_amount_basis,current.return_source_refs
  FROM mc.current_operational_daily_metrics current
  LEFT JOIN mc.operational_daily_metrics raw
    ON raw.business_id=current.business_id AND raw.store_id=current.store_id
    AND raw.snapshot_id=current.snapshot_id AND raw.product_id=current.product_id AND raw.metric_date=current.metric_date
  WHERE current.business_id=target_business AND current.store_id=target_store
    AND current.metric_date BETWEEN target_start AND target_end AND current.product_id=ANY(target_products)
 ), checked_refs AS MATERIALIZED (
  SELECT business_id,store_id,return_source_refs,
    mc.operational_financial_return_refs_current(business_id,store_id,return_source_refs) refs_current
  FROM (SELECT DISTINCT business_id,store_id,return_source_refs FROM selected_metrics WHERE return_source='financial_report') refs
 )
 SELECT m.business_id,m.store_id,m.product_id,m.metric_date,m.snapshot_id,
   m.currency,m.order_count,m.order_amount,m.buyout_count,m.buyout_amount,
   m.available,m.quality,m.missing_reasons,m.fetched_at,m.accepted_at,m.cancel_count,m.cancel_amount,
   CASE WHEN m.return_source='financial_report' AND NOT checked.refs_current THEN NULL ELSE m.return_count END return_count,
   CASE WHEN m.return_source='financial_report' AND NOT checked.refs_current THEN NULL ELSE m.return_amount END::numeric(20,4) return_amount,
   m.return_source,m.return_date_basis,m.return_amount_basis,m.return_source_refs
 FROM selected_metrics m LEFT JOIN checked_refs checked
   ON checked.business_id=m.business_id AND checked.store_id=m.store_id
   AND checked.return_source_refs IS NOT DISTINCT FROM m.return_source_refs;
$$;

INSERT INTO mc.schema_migrations(version) VALUES(83);
COMMIT;
