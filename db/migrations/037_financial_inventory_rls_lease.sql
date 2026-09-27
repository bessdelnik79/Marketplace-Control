BEGIN;

-- Migration 036 installed the inventory functions with a lease join against
-- FORCE-RLS mc.jobs before setting the tenant context. Database owners are
-- also subject to FORCE RLS, so production workers could not read the lease.
-- Rebuild the three entry points so the closed dispatch index establishes the
-- business first and the tenant lease is checked only afterwards.

CREATE OR REPLACE FUNCTION mc.get_financial_inventory_context(p_job_id uuid,p_generation bigint,p_lease_token uuid,p_worker_id text)
RETURNS TABLE(business_id uuid,store_id uuid,seller_id text,credential_generation bigint,ciphertext bytea,nonce bytea,auth_tag bytea,list_api text,fallback_mode text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mc AS $$
#variable_conflict use_column
DECLARE target mc.job_dispatch;
BEGIN
  SELECT d.* INTO target FROM mc.job_dispatch d
   WHERE d.job_id=p_job_id AND d.job_type='financial_inventory_refresh' AND d.status='running' AND d.lease_until>clock_timestamp();
  IF NOT FOUND THEN RAISE EXCEPTION 'running financial inventory job is required'; END IF;
  PERFORM set_config('app.business_id',target.business_id::text,true);
  PERFORM set_config('app.user_id','',true);
  PERFORM 1 FROM mc.jobs j WHERE j.id=p_job_id AND j.status='running' AND j.lease_token=p_lease_token
    AND j.worker_id=p_worker_id AND j.lease_until>clock_timestamp();
  IF NOT FOUND THEN RAISE EXCEPTION 'running financial inventory job is required'; END IF;
  RETURN QUERY
  SELECT c.business_id,c.store_id,s.external_account_id,c.credential_generation,cs.ciphertext,cs.nonce,cs.auth_tag,
         coalesce(cap.list_api,'unknown'),cap.fallback_mode
    FROM mc.connections c
    JOIN mc.stores s ON s.business_id=c.business_id AND s.id=c.store_id
    JOIN mc.connection_secrets cs ON cs.business_id=c.business_id AND cs.connection_id=c.id
    LEFT JOIN mc.financial_report_capabilities cap ON cap.business_id=c.business_id AND cap.connection_id=c.id AND cap.credential_generation=c.credential_generation
   WHERE c.business_id=target.business_id AND c.store_id=(SELECT j.store_id FROM mc.jobs j WHERE j.id=p_job_id)
     AND c.status='active' AND s.status='active' AND c.credential_generation=p_generation;
END $$;
REVOKE ALL ON FUNCTION mc.get_financial_inventory_context(uuid,bigint,uuid,text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION mc.apply_financial_inventory(p_job_id uuid,p_generation bigint,p_lease_token uuid,p_worker_id text,p_rows jsonb)
RETURNS TABLE(found_reports integer,uncovered_weeks integer,enqueued_fetches integer,superseded boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mc AS $$
#variable_conflict use_column
DECLARE
  target mc.job_dispatch;
  actor uuid;
  item jsonb;
  coverage mc.financial_week_coverage;
  inventory_row mc.financial_week_inventory;
  queued mc.jobs;
BEGIN
  IF p_rows IS NULL OR jsonb_typeof(p_rows)<>'array' OR jsonb_array_length(p_rows)>10000 THEN
    RAISE EXCEPTION 'financial inventory rows must be a bounded array';
  END IF;
  SELECT d.* INTO target FROM mc.job_dispatch d
   WHERE d.job_id=p_job_id AND d.job_type='financial_inventory_refresh' AND d.status='running' AND d.lease_until>clock_timestamp()
   FOR UPDATE OF d;
  IF NOT FOUND THEN RAISE EXCEPTION 'running financial inventory job is required'; END IF;
  PERFORM set_config('app.business_id',target.business_id::text,true);
  PERFORM set_config('app.user_id','',true);
  PERFORM 1 FROM mc.jobs j WHERE j.id=p_job_id AND j.status='running' AND j.lease_token=p_lease_token
    AND j.worker_id=p_worker_id AND j.lease_until>clock_timestamp();
  IF NOT FOUND THEN RAISE EXCEPTION 'running financial inventory job is required'; END IF;
  SELECT m.user_id INTO actor FROM mc.memberships m WHERE m.business_id=target.business_id AND m.role IN ('owner','editor')
    ORDER BY CASE m.role WHEN 'owner' THEN 0 ELSE 1 END,m.created_at,m.user_id LIMIT 1;
  IF actor IS NULL THEN RETURN QUERY SELECT 0,0,0,true; RETURN; END IF;
  PERFORM set_config('app.user_id',actor::text,true);
  IF NOT EXISTS(SELECT 1 FROM mc.connections c JOIN mc.jobs j ON j.store_id=c.store_id AND j.business_id=c.business_id
    WHERE j.id=p_job_id AND c.status='active' AND c.credential_generation=p_generation) THEN
    RETURN QUERY SELECT 0,0,0,true; RETURN;
  END IF;

  found_reports:=0;enqueued_fetches:=0;
  FOR item IN SELECT value FROM jsonb_array_elements(p_rows)
  LOOP
    IF coalesce(item->>'reportId','') !~ '^[0-9]+$' OR coalesce(item->>'checksum','') !~ '^[0-9a-f]{64}$'
       OR coalesce(item->>'dateFrom','') !~ '^\d{4}-\d{2}-\d{2}$' OR coalesce(item->>'dateTo','') !~ '^\d{4}-\d{2}-\d{2}$' THEN
      RAISE EXCEPTION 'invalid financial inventory row';
    END IF;
    FOR coverage IN
      SELECT wc.* FROM mc.financial_week_coverage wc JOIN mc.jobs j ON j.business_id=wc.business_id AND j.store_id=wc.store_id
       WHERE j.id=p_job_id AND wc.credential_generation=p_generation
         AND wc.week_start<=(item->>'dateTo')::date AND wc.week_end>=(item->>'dateFrom')::date
       FOR UPDATE OF wc
    LOOP
      INSERT INTO mc.financial_week_inventory(business_id,store_id,coverage_id,external_report_id,inventory_checksum,report_type,country,period_start,period_end)
      VALUES(coverage.business_id,coverage.store_id,coverage.id,item->>'reportId',item->>'checksum',nullif(item->>'reportType',''),nullif(item->>'country',''),
        (item->>'dateFrom')::date,(item->>'dateTo')::date)
      ON CONFLICT(coverage_id,external_report_id) DO UPDATE SET inventory_checksum=excluded.inventory_checksum,report_type=excluded.report_type,
        country=excluded.country,period_start=excluded.period_start,period_end=excluded.period_end,last_seen_at=clock_timestamp(),
        fetch_status=CASE WHEN mc.financial_week_inventory.inventory_checksum=excluded.inventory_checksum AND mc.financial_week_inventory.fetch_status='accepted'
          THEN 'accepted' ELSE 'pending' END
      RETURNING * INTO inventory_row;
      found_reports:=found_reports+1;
      IF inventory_row.fetch_status<>'accepted' THEN
        SELECT * INTO queued FROM mc.enqueue_job(coverage.store_id,'financial_report_fetch',
          format('financial-report-fetch:%s:g%s:r%s:%s',coverage.store_id,p_generation,item->>'reportId',item->>'checksum'),
          jsonb_build_object('schemaVersion',1,'credentialGeneration',p_generation,'coverageId',coverage.id,'mode','by_report_id',
            'reportId',item->>'reportId','periodStart',item->>'dateFrom','periodEnd',item->>'dateTo','inventoryChecksum',item->>'checksum'),
          clock_timestamp(),300,20);
        IF queued.id IS NOT NULL THEN enqueued_fetches:=enqueued_fetches+1; END IF;
      END IF;
      UPDATE mc.financial_week_coverage SET coverage_status=CASE WHEN inventory_row.fetch_status='accepted' AND NOT EXISTS(
          SELECT 1 FROM mc.financial_week_inventory wi WHERE wi.coverage_id=coverage.id AND wi.fetch_status<>'accepted'
        ) THEN 'complete' ELSE 'fetching' END,inventory_confirmed_at=clock_timestamp(),last_checked_at=clock_timestamp(),
        next_retry_at=NULL,last_error_code=NULL,updated_at=clock_timestamp() WHERE id=coverage.id;
    END LOOP;
  END LOOP;
  UPDATE mc.financial_report_capabilities frc SET list_api='supported',observed_at=clock_timestamp(),reason_code=NULL
   FROM mc.connections c JOIN mc.jobs j ON j.business_id=c.business_id AND j.store_id=c.store_id
   WHERE j.id=p_job_id AND frc.business_id=c.business_id AND frc.connection_id=c.id AND frc.credential_generation=p_generation;
  UPDATE mc.financial_week_coverage wc SET last_checked_at=clock_timestamp(),next_retry_at=clock_timestamp()+interval '15 minutes',
    last_error_code='financial_inventory_not_confirmed',coverage_status='retry',updated_at=clock_timestamp()
   FROM mc.jobs j WHERE j.id=p_job_id AND wc.business_id=j.business_id AND wc.store_id=j.store_id
     AND wc.credential_generation=p_generation AND wc.freshness_due_at IS NOT NULL
     AND NOT EXISTS(SELECT 1 FROM mc.financial_week_inventory wi WHERE wi.coverage_id=wc.id);
  SELECT count(*)::integer INTO uncovered_weeks FROM mc.financial_week_coverage wc JOIN mc.jobs j ON j.business_id=wc.business_id AND j.store_id=wc.store_id
   WHERE j.id=p_job_id AND wc.credential_generation=p_generation AND wc.freshness_due_at IS NOT NULL
     AND NOT EXISTS(SELECT 1 FROM mc.financial_week_inventory wi WHERE wi.coverage_id=wc.id);
  superseded:=false;
  RETURN NEXT;
END $$;
REVOKE ALL ON FUNCTION mc.apply_financial_inventory(uuid,bigint,uuid,text,jsonb) FROM PUBLIC;

CREATE OR REPLACE FUNCTION mc.apply_financial_period_fallback(p_job_id uuid,p_generation bigint,p_lease_token uuid,p_worker_id text)
RETURNS TABLE(enqueued_fetches integer,superseded boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mc AS $$
#variable_conflict use_column
DECLARE
  target mc.job_dispatch;
  target_job mc.jobs;
  actor uuid;
  coverage mc.financial_week_coverage;
  queued mc.jobs;
  date_from date;
  date_to date;
BEGIN
  SELECT d.* INTO target FROM mc.job_dispatch d
   WHERE d.job_id=p_job_id AND d.job_type='financial_inventory_refresh' AND d.status='running' AND d.lease_until>clock_timestamp()
   FOR UPDATE OF d;
  IF NOT FOUND THEN RAISE EXCEPTION 'running financial inventory job is required'; END IF;
  PERFORM set_config('app.business_id',target.business_id::text,true);
  PERFORM set_config('app.user_id','',true);
  PERFORM 1 FROM mc.jobs j WHERE j.id=p_job_id AND j.status='running' AND j.lease_token=p_lease_token
    AND j.worker_id=p_worker_id AND j.lease_until>clock_timestamp();
  IF NOT FOUND THEN RAISE EXCEPTION 'running financial inventory job is required'; END IF;
  SELECT * INTO target_job FROM mc.jobs j WHERE j.id=p_job_id;
  SELECT m.user_id INTO actor FROM mc.memberships m WHERE m.business_id=target.business_id AND m.role IN ('owner','editor')
    ORDER BY CASE m.role WHEN 'owner' THEN 0 ELSE 1 END,m.created_at,m.user_id LIMIT 1;
  IF actor IS NULL OR NOT EXISTS(SELECT 1 FROM mc.connections c WHERE c.business_id=target.business_id AND c.store_id=target_job.store_id
    AND c.status='active' AND c.credential_generation=p_generation) THEN
    RETURN QUERY SELECT 0,true; RETURN;
  END IF;
  date_from:=nullif(target_job.payload#>>'{window,dateFrom}','')::date;
  date_to:=nullif(target_job.payload#>>'{window,dateTo}','')::date;
  IF date_from IS NULL OR date_to IS NULL OR date_to<date_from THEN RAISE EXCEPTION 'invalid financial fallback window'; END IF;
  PERFORM set_config('app.user_id',actor::text,true);
  UPDATE mc.financial_report_capabilities frc SET list_api='unsupported_country',detail_by_id_api='unsupported_country',fallback_mode='period',
    reason_code='unsupported_registration_country',observed_at=clock_timestamp()
   FROM mc.connections c WHERE c.business_id=target.business_id AND c.store_id=target_job.store_id
     AND frc.business_id=c.business_id AND frc.connection_id=c.id AND frc.credential_generation=p_generation;
  enqueued_fetches:=0;
  FOR coverage IN SELECT wc.* FROM mc.financial_week_coverage wc
    WHERE wc.business_id=target.business_id AND wc.store_id=target_job.store_id AND wc.credential_generation=p_generation
      AND wc.week_start<=date_to AND wc.week_end>=date_from FOR UPDATE
  LOOP
    SELECT * INTO queued FROM mc.enqueue_job(coverage.store_id,'financial_report_fetch',
      format('financial-report-fetch:%s:g%s:period:%s',coverage.store_id,p_generation,coverage.week_start),
      jsonb_build_object('schemaVersion',1,'credentialGeneration',p_generation,'coverageId',coverage.id,'mode','period',
        'periodStart',coverage.week_start,'periodEnd',coverage.week_end),clock_timestamp(),300,20);
    IF queued.id IS NOT NULL THEN enqueued_fetches:=enqueued_fetches+1; END IF;
    UPDATE mc.financial_week_coverage SET coverage_status='fetching',last_checked_at=clock_timestamp(),next_retry_at=NULL,
      last_error_code=NULL,updated_at=clock_timestamp() WHERE id=coverage.id;
  END LOOP;
  superseded:=false;
  RETURN NEXT;
END $$;
REVOKE ALL ON FUNCTION mc.apply_financial_period_fallback(uuid,bigint,uuid,text) FROM PUBLIC;

INSERT INTO mc.schema_migrations(version) VALUES(37);
COMMIT;
