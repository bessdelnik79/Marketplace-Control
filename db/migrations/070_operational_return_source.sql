BEGIN;
ALTER TABLE mc.operational_daily_metrics
 ADD COLUMN return_source text CHECK(return_source IN ('financial_report','statistics_sales')),
 ADD COLUMN return_date_basis text CHECK(return_date_basis IN ('accounting_date','return_event_date')),
 ADD COLUMN return_amount_basis text CHECK(return_amount_basis IN ('retail_price_with_discount','price_with_discount')),
 ADD COLUMN return_source_refs jsonb CHECK(return_source_refs IS NULL OR jsonb_typeof(return_source_refs)='object'),
 ADD CONSTRAINT operational_return_source_basis CHECK(coalesce((
   (return_source IS NULL AND return_date_basis IS NULL AND return_amount_basis IS NULL AND return_source_refs IS NULL)
   OR return_count IS NOT NULL AND return_source='statistics_sales' AND return_date_basis='return_event_date' AND return_amount_basis='price_with_discount'
   OR return_count IS NOT NULL AND return_source='financial_report' AND return_date_basis='accounting_date' AND return_amount_basis='retail_price_with_discount'
     AND return_source_refs IS NOT NULL AND return_source_refs ? 'coverageId' AND jsonb_typeof(return_source_refs->'inventory')='array'),false));

-- Invoker rights preserve tenant isolation. Immutable operational values become
-- unavailable when any referenced financial version or normalization changes.
CREATE FUNCTION mc.operational_financial_return_refs_current(target_business uuid,target_store uuid,refs jsonb)
RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM mc.financial_week_coverage wc
  JOIN mc.connections c ON c.business_id=wc.business_id AND c.store_id=wc.store_id AND c.status='active'
    AND c.credential_generation=wc.credential_generation AND c.scopes ? 'finance'
  JOIN mc.stores s ON s.business_id=wc.business_id AND s.id=wc.store_id
  WHERE wc.business_id=target_business AND wc.store_id=target_store AND wc.id::text=refs->>'coverageId'
    AND wc.credential_generation::text=refs->>'credentialGeneration' AND wc.inventory_confirmed_at IS NOT NULL
    AND (wc.coverage_status='empty' AND wc.empty_confirmed_by_job_id::text=refs->>'emptyConfirmationJobId'
      AND EXISTS(SELECT 1 FROM mc.jobs j WHERE j.id=wc.empty_confirmed_by_job_id AND j.business_id=wc.business_id
        AND j.store_id=wc.store_id AND j.status='succeeded' AND j.job_type='financial_inventory_refresh'
        AND j.payload->>'credentialGeneration'=wc.credential_generation::text)
      AND NOT EXISTS(SELECT 1 FROM mc.financial_week_inventory i WHERE i.coverage_id=wc.id)
      AND jsonb_array_length(refs->'inventory')=0
     OR wc.coverage_status='complete' AND jsonb_array_length(refs->'inventory')>0
      AND jsonb_array_length(refs->'inventory')=(SELECT count(*) FROM mc.financial_week_inventory i WHERE i.coverage_id=wc.id)
      AND NOT EXISTS(SELECT 1 FROM mc.financial_week_inventory i
        LEFT JOIN mc.report_versions rv ON rv.id=i.report_version_id AND rv.business_id=i.business_id AND rv.store_id=i.store_id
        LEFT JOIN mc.reports r ON r.id=rv.report_id AND r.business_id=rv.business_id AND r.store_id=rv.store_id
        LEFT JOIN mc.report_normalizations n ON n.id=i.accepted_normalization_id AND n.report_version_id=rv.id AND n.business_id=i.business_id AND n.store_id=i.store_id
        LEFT JOIN mc.method_versions m ON m.id=n.method_version_id
        WHERE i.coverage_id=wc.id AND (i.fetch_status<>'accepted' OR i.accepted_inventory_checksum IS DISTINCT FROM i.inventory_checksum
          OR rv.id IS NULL OR rv.status<>'accepted' OR r.current_version_id IS DISTINCT FROM rv.id
          OR n.id IS NULL OR n.status<>'succeeded' OR n.catalog_revision IS DISTINCT FROM s.catalog_revision
          OR rv.parser_version<>'wb-finance-v13' OR m.implementation_version IS DISTINCT FROM 'wb-finance-v13'
          OR EXISTS(SELECT 1 FROM mc.data_issues issue WHERE issue.report_normalization_id=n.id AND issue.code='financial_operation_unclassified' AND issue.status='open')
          OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(refs->'inventory') item WHERE item->>'inventoryId'=i.id::text
            AND item->>'inventoryChecksum'=i.inventory_checksum AND item->>'reportVersionId'=rv.id::text
            AND item->>'reportNormalizationId'=n.id::text AND item->>'reportChecksum'=rv.checksum))))
 );
$$;

CREATE OR REPLACE VIEW mc.current_operational_daily_metrics WITH (security_invoker=true) AS
WITH candidates AS (
  SELECT sp.business_id,sp.store_id,sp.product_id,day_value::date AS metric_date,
         s.id AS snapshot_id,s.quality,s.missing_reasons,a.fetched_at,s.accepted_at,
         row_number() OVER(
           PARTITION BY sp.business_id,sp.store_id,sp.product_id,day_value::date
           ORDER BY a.fetched_at DESC,a.created_at DESC,a.id DESC
         ) AS freshness_rank
    FROM mc.operational_snapshot_activations a
    JOIN mc.operational_snapshots s ON s.business_id=a.business_id AND s.store_id=a.store_id AND s.id=a.snapshot_id
    JOIN mc.operational_periods p ON p.business_id=s.business_id AND p.store_id=s.store_id AND p.id=s.operational_period_id
    JOIN mc.operational_snapshot_products sp ON sp.business_id=s.business_id AND sp.store_id=s.store_id AND sp.snapshot_id=s.id
    CROSS JOIN LATERAL generate_series(p.period_start,p.period_end,interval '1 day') day_value
   WHERE s.status='accepted'
)
SELECT c.business_id,c.store_id,c.product_id,c.metric_date,c.snapshot_id,
       m.currency,m.order_count,m.order_amount,m.buyout_count,m.buyout_amount,
       (m.id IS NOT NULL) AS available,c.quality,c.missing_reasons,c.fetched_at,c.accepted_at,m.cancel_count,m.cancel_amount,case when m.return_source='financial_report' and not mc.operational_financial_return_refs_current(m.business_id,m.store_id,m.return_source_refs) then null else m.return_count end return_count,case when m.return_source='financial_report' and not mc.operational_financial_return_refs_current(m.business_id,m.store_id,m.return_source_refs) then null else m.return_amount end::numeric(20,4) return_amount,m.return_source,m.return_date_basis,m.return_amount_basis,m.return_source_refs
  FROM candidates c
  LEFT JOIN mc.operational_daily_metrics m
    ON m.business_id=c.business_id AND m.store_id=c.store_id AND m.snapshot_id=c.snapshot_id
   AND m.product_id=c.product_id AND m.metric_date=c.metric_date
 WHERE c.freshness_rank=1;


INSERT INTO mc.schema_migrations(version) VALUES(70);
COMMIT;
