BEGIN;

ALTER TABLE mc.financial_week_coverage
 DROP CONSTRAINT financial_week_coverage_coverage_status_check,
 ADD CONSTRAINT financial_week_coverage_coverage_status_check
 CHECK (coverage_status IN ('pending','inventory_confirmed','fetching','complete','empty','partial','retry','unavailable','absent'));

-- Called only after a complete list has been applied. Absence is not zero-sale evidence.
CREATE FUNCTION mc.reconcile_financial_history_inventory(p_job_id uuid,p_generation bigint)
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,mc AS $$
DECLARE target mc.jobs; date_from date; date_to date; fresh_start date;
 wait_from date; wait_to date; uncovered integer;
BEGIN
 SELECT * INTO target FROM mc.jobs WHERE id=p_job_id AND business_id=mc.context_business_id()
  AND job_type='financial_inventory_refresh' AND payload->>'credentialGeneration'=p_generation::text;
 IF NOT FOUND THEN RAISE EXCEPTION 'financial inventory context is required'; END IF;
 date_from:=(target.payload->'window'->>'dateFrom')::date;
 date_to:=(target.payload->'window'->>'dateTo')::date;
 fresh_start:=CASE WHEN target.payload->>'reason' IN ('credential_generation','scheduled_freshness')
  THEN date_to-6
  ELSE date_trunc('week',target.created_at AT TIME ZONE 'Europe/Moscow')::date-7 END;
 -- Pin the expectation to the original request, not today's moving week.
 UPDATE mc.financial_week_coverage wc SET
  check_reasons=(SELECT array_agg(DISTINCT reason ORDER BY reason)
   FROM unnest(wc.check_reasons||ARRAY['awaiting_fresh_report']) reason)
 WHERE wc.business_id=target.business_id AND wc.store_id=target.store_id
  AND wc.credential_generation=p_generation AND wc.week_start=fresh_start
  AND wc.week_start<=date_to AND wc.week_end>=date_from
  AND NOT EXISTS(SELECT 1 FROM mc.financial_week_inventory wi WHERE wi.coverage_id=wc.id);

 UPDATE mc.financial_week_coverage wc SET coverage_status='absent',
  inventory_confirmed_at=NULL,empty_confirmed_by_job_id=NULL,freshness_due_at=NULL,
  next_retry_at=NULL,last_error_code=NULL,last_checked_at=clock_timestamp(),updated_at=clock_timestamp()
 WHERE wc.business_id=target.business_id AND wc.store_id=target.store_id
  AND wc.credential_generation=p_generation AND wc.week_start<=date_to AND wc.week_end>=date_from
  AND NOT ('awaiting_fresh_report'=ANY(wc.check_reasons))
  AND NOT EXISTS(SELECT 1 FROM mc.financial_week_inventory wi WHERE wi.coverage_id=wc.id);

 UPDATE mc.financial_week_coverage wc SET coverage_status='retry',
  next_retry_at=clock_timestamp()+interval '1 hour',last_error_code='financial_inventory_not_confirmed',
  last_checked_at=clock_timestamp(),updated_at=clock_timestamp()
 WHERE wc.business_id=target.business_id AND wc.store_id=target.store_id
  AND wc.credential_generation=p_generation AND wc.week_start<=date_to AND wc.week_end>=date_from
  AND ('awaiting_fresh_report'=ANY(wc.check_reasons)
    OR EXISTS(SELECT 1 FROM mc.financial_week_inventory wi WHERE wi.coverage_id=wc.id))
  AND (wc.inventory_confirmed_at IS NULL OR wc.inventory_confirmed_at<target.created_at);

 SELECT min(wc.week_start),max(wc.week_end),count(*)::integer INTO wait_from,wait_to,uncovered
 FROM mc.financial_week_coverage wc
 WHERE wc.business_id=target.business_id AND wc.store_id=target.store_id
  AND wc.credential_generation=p_generation AND wc.week_start<=date_to AND wc.week_end>=date_from
  AND wc.coverage_status<>'absent'
  AND (wc.inventory_confirmed_at IS NULL OR wc.inventory_confirmed_at<target.created_at);
 IF target.payload->>'reason'='credential_generation' AND uncovered>0 THEN
  PERFORM mc.enqueue_job(target.store_id,'financial_inventory_refresh',
   format('financial-inventory:%s:g%s:fresh-wait:%s',target.store_id,p_generation,target.id),
   jsonb_build_object('schemaVersion',1,'credentialGeneration',p_generation,'reason','fresh_report_wait',
    'awaitingReportsOnly',true,'window',jsonb_build_object('dateFrom',wait_from,'dateTo',wait_to),
    'timezone','Europe/Moscow'),clock_timestamp()+interval '1 hour',600,20);
  RETURN 0;
 END IF;
 RETURN uncovered;
END $$;
REVOKE ALL ON FUNCTION mc.reconcile_financial_history_inventory(uuid,bigint) FROM PUBLIC;

-- Retain the lease, generation and bounded-row validation of the existing importer.
DO $$
DECLARE definition text; updated text; tail_start integer; tail_end integer;
BEGIN
 definition:=pg_get_functiondef('mc.apply_financial_inventory(uuid,bigint,uuid,text,jsonb)'::regprocedure);
 tail_start:=strpos(definition,'  -- Absence from the WB list is not proof of a zero financial result.');
 tail_end:=strpos(definition,'  superseded:=false;');
 IF tail_start=0 OR tail_end<=tail_start THEN RAISE EXCEPTION 'financial inventory importer contract missing'; END IF;
 updated:=left(definition,tail_start-1)||
  '  uncovered_weeks:=mc.reconcile_financial_history_inventory(p_job_id,p_generation);'||chr(10)||
  substr(definition,tail_end);
 EXECUTE updated;
END $$;

CREATE OR REPLACE FUNCTION mc.operational_financial_bootstrap_ready(p_store uuid) RETURNS boolean
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
 -- A completed period-fallback planner is not evidence that a complete list
 -- was obtained. Without list support, every requested period must finish.
 IF NOT EXISTS(
  SELECT 1 FROM mc.financial_report_capabilities cap
  JOIN mc.connections c ON c.id=cap.connection_id AND c.business_id=cap.business_id
  WHERE c.business_id=factory.business_id AND c.store_id=p_store AND c.status='active'
   AND c.credential_generation=generation AND cap.credential_generation=generation
   AND cap.list_api='supported'
 ) AND EXISTS(
  SELECT 1 FROM generate_series(date_from,date_to,interval '7 days') day
  LEFT JOIN mc.financial_week_coverage wc ON wc.business_id=factory.business_id AND wc.store_id=p_store
   AND wc.credential_generation=generation AND wc.week_start=day::date AND wc.week_end=day::date+6
  WHERE wc.id IS NULL OR wc.inventory_confirmed_at IS NULL OR wc.coverage_status<>'complete'
   OR NOT EXISTS(SELECT 1 FROM mc.financial_week_inventory wi
    WHERE wi.business_id=factory.business_id AND wi.store_id=p_store AND wi.coverage_id=wc.id)
 ) THEN RETURN false; END IF;
 -- Only reports actually listed by WB must be fetched and normalized.
 IF EXISTS(
  SELECT 1 FROM mc.financial_week_inventory wi
  JOIN mc.financial_week_coverage wc ON wc.id=wi.coverage_id AND wc.business_id=wi.business_id AND wc.store_id=wi.store_id
  LEFT JOIN mc.report_versions rv ON rv.business_id=wi.business_id AND rv.store_id=wi.store_id AND rv.id=wi.report_version_id
  LEFT JOIN mc.reports r ON r.business_id=rv.business_id AND r.store_id=rv.store_id AND r.id=rv.report_id
  LEFT JOIN mc.report_normalizations rn ON rn.business_id=wi.business_id AND rn.store_id=wi.store_id
   AND rn.report_version_id=wi.report_version_id AND rn.id=wi.accepted_normalization_id
  WHERE wc.business_id=factory.business_id AND wc.store_id=p_store AND wc.credential_generation=generation
   AND wc.week_start<=date_to AND wc.week_end>=date_from
   AND (wi.fetch_status<>'accepted' OR wi.accepted_inventory_checksum IS DISTINCT FROM wi.inventory_checksum
    OR rv.status IS DISTINCT FROM 'accepted' OR r.current_version_id IS DISTINCT FROM wi.report_version_id
    OR rn.status IS DISTINCT FROM 'succeeded')
 ) THEN RETURN false; END IF;
 UPDATE mc.operational_history_factories SET financial_ready_at=clock_timestamp() WHERE store_id=p_store;
 RETURN true;
END $$;

-- The old retry code is written only after the full, paginated list was applied.
-- Failed/incomplete requests have other codes and remain untouched.
ALTER TABLE mc.stores NO FORCE ROW LEVEL SECURITY;
DO $$
DECLARE store_row record; job_row mc.jobs; actor uuid; generation bigint; remaining integer;
BEGIN
 FOR store_row IN SELECT business_id,id FROM mc.stores WHERE status='active' AND marketplace_code='wb'
 LOOP
  PERFORM set_config('app.business_id',store_row.business_id::text,true);
  PERFORM set_config('app.user_id','',true);
  SELECT user_id INTO actor FROM mc.memberships WHERE business_id=store_row.business_id AND role IN ('owner','editor')
   ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END,created_at,user_id LIMIT 1;
  IF actor IS NULL THEN CONTINUE; END IF;
  PERFORM set_config('app.user_id',actor::text,true);
  SELECT credential_generation INTO generation FROM mc.connections WHERE business_id=store_row.business_id
   AND store_id=store_row.id AND status='active' AND scopes ? 'finance';
  IF generation IS NULL THEN CONTINUE; END IF;
  FOR job_row IN SELECT j.* FROM mc.jobs j WHERE j.business_id=store_row.business_id AND j.store_id=store_row.id
   AND j.job_type='financial_inventory_refresh' AND j.status='pending'
   AND j.payload->>'credentialGeneration'=generation::text
   AND j.last_error_code='financial_inventory_not_confirmed'
   ORDER BY j.created_at,j.id FOR UPDATE OF j
  LOOP
   remaining:=mc.reconcile_financial_history_inventory(job_row.id,generation);
   IF remaining=0 THEN
    UPDATE mc.jobs SET status='succeeded',outcome='completed',finished_at=clock_timestamp(),
     updated_at=clock_timestamp(),last_error_code=NULL,last_error=NULL,
     worker_id=NULL,lease_token=NULL,lease_until=NULL,heartbeat_at=NULL WHERE id=job_row.id;
    DELETE FROM mc.job_dispatch WHERE job_id=job_row.id;
   END IF;
  END LOOP;
 END LOOP;
END $$;
ALTER TABLE mc.stores FORCE ROW LEVEL SECURITY;

INSERT INTO mc.schema_migrations(version) VALUES(79);
COMMIT;
