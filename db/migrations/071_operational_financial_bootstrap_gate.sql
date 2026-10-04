BEGIN;
ALTER TABLE mc.operational_history_factories
 ADD COLUMN financial_ready_at timestamptz,
 ADD COLUMN financial_bootstrap_generation bigint,
 ADD COLUMN financial_bootstrap_from date,
 ADD COLUMN financial_bootstrap_to date;

-- Existing factories keep working. Only newly created stores wait for finance.
ALTER TABLE mc.operational_history_factories NO FORCE ROW LEVEL SECURITY;
UPDATE mc.operational_history_factories SET financial_ready_at=clock_timestamp();
ALTER TABLE mc.operational_history_factories FORCE ROW LEVEL SECURITY;

CREATE FUNCTION mc.operational_financial_bootstrap_waiting(p_store uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,mc AS $$
 SELECT EXISTS(SELECT 1 FROM mc.operational_history_factories
  WHERE business_id=mc.context_business_id() AND store_id=p_store AND financial_ready_at IS NULL)
$$;

CREATE FUNCTION mc.operational_financial_bootstrap_ready(p_store uuid) RETURNS boolean
 LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,mc AS $$
DECLARE factory mc.operational_history_factories; bootstrap mc.jobs; generation bigint;
 date_from date; date_to date;
BEGIN
 SELECT * INTO factory FROM mc.operational_history_factories
  WHERE business_id=mc.context_business_id() AND store_id=p_store FOR UPDATE;
 IF NOT FOUND OR factory.financial_ready_at IS NOT NULL THEN RETURN true; END IF;
 SELECT credential_generation INTO generation FROM mc.connections
  WHERE business_id=factory.business_id AND store_id=p_store AND status='active' AND scopes ? 'finance';
 IF generation IS NULL THEN RETURN false; END IF;
 SELECT * INTO bootstrap FROM mc.jobs WHERE business_id=factory.business_id AND store_id=p_store
  AND job_type='financial_inventory_refresh' AND payload->>'reason'='credential_generation'
  AND payload->>'credentialGeneration'=generation::text ORDER BY created_at DESC,id DESC LIMIT 1;
 IF NOT FOUND OR coalesce(bootstrap.payload->'window'->>'dateFrom','') !~ '^\d{4}-\d{2}-\d{2}$'
  OR coalesce(bootstrap.payload->'window'->>'dateTo','') !~ '^\d{4}-\d{2}-\d{2}$' THEN RETURN false; END IF;
 date_from:=(bootstrap.payload->'window'->>'dateFrom')::date;
 date_to:=(bootstrap.payload->'window'->>'dateTo')::date;
 UPDATE mc.operational_history_factories SET financial_bootstrap_generation=generation,
  financial_bootstrap_from=date_from,financial_bootstrap_to=date_to WHERE store_id=p_store;
 IF bootstrap.status<>'succeeded' OR date_to<date_from THEN RETURN false; END IF;
 IF EXISTS(
  SELECT 1 FROM generate_series(date_from,date_to,interval '7 days') day
   LEFT JOIN mc.financial_week_coverage wc ON wc.business_id=factory.business_id AND wc.store_id=p_store
    AND wc.credential_generation=generation AND wc.week_start=day::date AND wc.week_end=day::date+6
  WHERE wc.id IS NULL OR wc.inventory_confirmed_at IS NULL OR wc.coverage_status NOT IN ('complete','empty')
   OR (wc.coverage_status='empty' AND (EXISTS(SELECT 1 FROM mc.financial_week_inventory wi WHERE wi.coverage_id=wc.id)
    OR NOT EXISTS(SELECT 1 FROM mc.jobs ej WHERE ej.id=wc.empty_confirmed_by_job_id AND ej.business_id=factory.business_id
      AND ej.store_id=p_store AND ej.job_type='financial_inventory_refresh' AND ej.status='succeeded' AND ej.payload->>'credentialGeneration'=generation::text)))
   OR (wc.coverage_status='complete' AND (
    NOT EXISTS(SELECT 1 FROM mc.financial_week_inventory wi WHERE wi.coverage_id=wc.id)
    OR EXISTS(SELECT 1 FROM mc.financial_week_inventory wi
     LEFT JOIN mc.report_versions rv ON rv.business_id=wi.business_id AND rv.store_id=wi.store_id AND rv.id=wi.report_version_id
     LEFT JOIN mc.reports r ON r.business_id=rv.business_id AND r.store_id=rv.store_id AND r.id=rv.report_id
     LEFT JOIN mc.report_normalizations rn ON rn.business_id=wi.business_id AND rn.store_id=wi.store_id
      AND rn.report_version_id=wi.report_version_id AND rn.id=wi.accepted_normalization_id
     WHERE wi.coverage_id=wc.id AND (wi.fetch_status<>'accepted'
      OR wi.accepted_inventory_checksum IS DISTINCT FROM wi.inventory_checksum OR rv.status IS DISTINCT FROM 'accepted'
      OR r.current_version_id IS DISTINCT FROM wi.report_version_id OR rn.status IS DISTINCT FROM 'succeeded'))))
 ) THEN RETURN false; END IF;
 UPDATE mc.operational_history_factories SET financial_ready_at=clock_timestamp() WHERE store_id=p_store;
 RETURN true;
END $$;
INSERT INTO mc.schema_migrations(version) VALUES(71);
COMMIT;
