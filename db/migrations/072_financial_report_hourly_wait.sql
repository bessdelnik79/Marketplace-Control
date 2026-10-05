BEGIN;

CREATE OR REPLACE FUNCTION mc.apply_financial_inventory(
  p_job_id uuid,
  p_generation bigint,
  p_lease_token uuid,
  p_worker_id text,
  p_rows jsonb
)
RETURNS TABLE(found_reports integer,uncovered_weeks integer,enqueued_fetches integer,superseded boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mc AS $$
#variable_conflict use_column
DECLARE
  target mc.job_dispatch;
  target_job mc.jobs;
  actor uuid;
  item jsonb;
  coverage mc.financial_week_coverage;
  inventory_row mc.financial_week_inventory;
  queued mc.jobs;
  date_from date;
  date_to date;
  awaiting_coverage_ids uuid[];
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
  SELECT j.* INTO target_job FROM mc.jobs j
   WHERE j.id=p_job_id AND j.status='running' AND j.lease_token=p_lease_token
     AND j.worker_id=p_worker_id AND j.lease_until>clock_timestamp();
  IF NOT FOUND THEN RAISE EXCEPTION 'running financial inventory job is required'; END IF;
  IF coalesce(target_job.payload->'window'->>'dateFrom','') !~ '^\d{4}-\d{2}-\d{2}$'
     OR coalesce(target_job.payload->'window'->>'dateTo','') !~ '^\d{4}-\d{2}-\d{2}$' THEN
    RAISE EXCEPTION 'financial inventory job window is required';
  END IF;
  date_from:=(target_job.payload->'window'->>'dateFrom')::date;
  date_to:=(target_job.payload->'window'->>'dateTo')::date;
  IF date_to<date_from THEN RAISE EXCEPTION 'financial inventory job window is invalid'; END IF;
  SELECT m.user_id INTO actor FROM mc.memberships m WHERE m.business_id=target.business_id AND m.role IN ('owner','editor')
    ORDER BY CASE m.role WHEN 'owner' THEN 0 ELSE 1 END,m.created_at,m.user_id LIMIT 1;
  IF actor IS NULL THEN RETURN QUERY SELECT 0,0,0,true; RETURN; END IF;
  PERFORM set_config('app.user_id',actor::text,true);
  IF NOT EXISTS(SELECT 1 FROM mc.connections c
    WHERE c.business_id=target_job.business_id AND c.store_id=target_job.store_id
      AND c.status='active' AND c.credential_generation=p_generation) THEN
    RETURN QUERY SELECT 0,0,0,true; RETURN;
  END IF;

  found_reports:=0;
  enqueued_fetches:=0;
  -- Freeze eligibility before processing rows: several reports can cover one week.
  IF target_job.payload->>'awaitingReportsOnly'='true' THEN
    SELECT coalesce(array_agg(wc.id),ARRAY[]::uuid[]) INTO awaiting_coverage_ids
      FROM mc.financial_week_coverage wc
     WHERE wc.business_id=target_job.business_id AND wc.store_id=target_job.store_id
       AND wc.credential_generation=p_generation
       AND wc.week_start<=date_to AND wc.week_end>=date_from
       AND (wc.inventory_confirmed_at IS NULL OR wc.inventory_confirmed_at<target_job.created_at);
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(p_rows)
  LOOP
    IF coalesce(item->>'reportId','') !~ '^[0-9]+$' OR coalesce(item->>'checksum','') !~ '^[0-9a-f]{64}$'
       OR coalesce(item->>'dateFrom','') !~ '^\d{4}-\d{2}-\d{2}$' OR coalesce(item->>'dateTo','') !~ '^\d{4}-\d{2}-\d{2}$' THEN
      RAISE EXCEPTION 'invalid financial inventory row';
    END IF;
    FOR coverage IN
      SELECT wc.* FROM mc.financial_week_coverage wc
       WHERE wc.business_id=target_job.business_id AND wc.store_id=target_job.store_id
         AND wc.credential_generation=p_generation
         AND wc.week_start<=date_to AND wc.week_end>=date_from
         AND wc.week_start<=(item->>'dateTo')::date AND wc.week_end>=(item->>'dateFrom')::date
         AND (awaiting_coverage_ids IS NULL OR wc.id=ANY(awaiting_coverage_ids))
       FOR UPDATE OF wc
    LOOP
      INSERT INTO mc.financial_week_inventory(
        business_id,store_id,coverage_id,external_report_id,inventory_checksum,report_type,country,period_start,period_end
      )
      VALUES(
        coverage.business_id,coverage.store_id,coverage.id,item->>'reportId',item->>'checksum',
        nullif(item->>'reportType',''),nullif(item->>'country',''),(item->>'dateFrom')::date,(item->>'dateTo')::date
      )
      ON CONFLICT(coverage_id,external_report_id) DO UPDATE SET
        inventory_checksum=excluded.inventory_checksum,
        report_type=excluded.report_type,
        country=excluded.country,
        period_start=excluded.period_start,
        period_end=excluded.period_end,
        last_seen_at=clock_timestamp(),
        fetch_status=CASE
          WHEN mc.financial_week_inventory.inventory_checksum=excluded.inventory_checksum
            AND mc.financial_week_inventory.fetch_status='accepted' THEN 'accepted'
          ELSE 'pending'
        END
      RETURNING * INTO inventory_row;
      found_reports:=found_reports+1;
      IF inventory_row.fetch_status<>'accepted' THEN
        SELECT * INTO queued FROM mc.enqueue_job(
          coverage.store_id,
          'financial_report_fetch',
          format('financial-report-fetch:%s:g%s:r%s:%s',coverage.store_id,p_generation,item->>'reportId',item->>'checksum'),
          jsonb_build_object(
            'schemaVersion',1,'credentialGeneration',p_generation,'coverageId',coverage.id,'mode','by_report_id',
            'reportId',item->>'reportId','periodStart',item->>'dateFrom','periodEnd',item->>'dateTo','inventoryChecksum',item->>'checksum'
          ),
          clock_timestamp(),300,20
        );
        IF queued.id IS NOT NULL THEN enqueued_fetches:=enqueued_fetches+1; END IF;
      END IF;
      UPDATE mc.financial_week_coverage SET
        coverage_status=CASE
          WHEN inventory_row.fetch_status='accepted' AND NOT EXISTS(
            SELECT 1 FROM mc.financial_week_inventory wi WHERE wi.coverage_id=coverage.id AND wi.fetch_status<>'accepted'
          ) THEN 'complete'
          ELSE 'fetching'
        END,
        inventory_confirmed_at=clock_timestamp(),
        empty_confirmed_by_job_id=NULL,
        last_checked_at=clock_timestamp(),
        next_retry_at=NULL,
        last_error_code=NULL,
        updated_at=clock_timestamp()
       WHERE id=coverage.id;
    END LOOP;
  END LOOP;
  UPDATE mc.financial_report_capabilities frc
     SET list_api='supported',observed_at=clock_timestamp(),reason_code=NULL
    FROM mc.connections c
   WHERE c.business_id=target_job.business_id AND c.store_id=target_job.store_id
     AND frc.business_id=c.business_id AND frc.connection_id=c.id AND frc.credential_generation=p_generation;

  -- Absence from the WB list is not proof of a zero financial result.
  UPDATE mc.financial_week_coverage wc SET
    coverage_status='retry',inventory_confirmed_at=NULL,empty_confirmed_by_job_id=NULL,
    last_checked_at=clock_timestamp(),next_retry_at=clock_timestamp()+interval '1 hour',
    last_error_code='financial_inventory_not_confirmed',updated_at=clock_timestamp()
   WHERE wc.business_id=target_job.business_id AND wc.store_id=target_job.store_id
     AND wc.credential_generation=p_generation AND wc.freshness_due_at IS NOT NULL
     AND wc.week_start<=date_to AND wc.week_end>=date_from
     AND NOT EXISTS(SELECT 1 FROM mc.financial_week_inventory wi WHERE wi.coverage_id=wc.id);

  -- A previously known report disappearing from the list is not treated as an
  -- empty financial week; it remains retryable for explicit reconciliation.
  UPDATE mc.financial_week_coverage wc SET
    last_checked_at=clock_timestamp(),
    next_retry_at=clock_timestamp()+interval '1 hour',
    last_error_code='financial_inventory_not_confirmed',
    coverage_status='retry',
    updated_at=clock_timestamp()
   WHERE wc.business_id=target_job.business_id AND wc.store_id=target_job.store_id
     AND wc.credential_generation=p_generation AND wc.freshness_due_at IS NOT NULL
     AND wc.week_start<=date_to AND wc.week_end>=date_from
     AND (wc.inventory_confirmed_at IS NULL OR wc.inventory_confirmed_at<target_job.created_at);
  SELECT count(*)::integer INTO uncovered_weeks
    FROM mc.financial_week_coverage wc
   WHERE wc.business_id=target_job.business_id AND wc.store_id=target_job.store_id
     AND wc.credential_generation=p_generation AND wc.freshness_due_at IS NOT NULL
     AND wc.week_start<=date_to AND wc.week_end>=date_from
     AND (wc.inventory_confirmed_at IS NULL OR wc.inventory_confirmed_at<target_job.created_at);
  superseded:=false;
  RETURN NEXT;
END $$;

REVOKE ALL ON FUNCTION mc.apply_financial_inventory(uuid,bigint,uuid,text,jsonb) FROM PUBLIC;

CREATE OR REPLACE FUNCTION mc.fail_job(
  p_job_id uuid,
  p_lease_token uuid,
  p_worker_id text,
  p_error_code text,
  p_retryable boolean,
  p_retry_delay_seconds integer
)
RETURNS mc.jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mc AS $$
DECLARE
  failed mc.jobs;
  target mc.job_dispatch;
  inventory_wait boolean;
BEGIN
  IF nullif(btrim(p_worker_id),'') IS NULL OR length(btrim(p_worker_id))>200 THEN RAISE EXCEPTION 'worker id is invalid'; END IF;
  IF p_error_code IS NULL OR length(p_error_code) NOT BETWEEN 1 AND 100
     OR p_error_code !~ '^[a-z0-9][a-z0-9_.:-]*$' THEN
    RAISE EXCEPTION 'error code is invalid';
  END IF;
  IF p_retryable IS NULL OR p_retry_delay_seconds IS NULL OR p_retry_delay_seconds NOT BETWEEN 0 AND 86400 THEN
    RAISE EXCEPTION 'retry settings are invalid';
  END IF;
  SELECT * INTO target FROM mc.job_dispatch WHERE job_id=p_job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'job lease is not owned or has expired'; END IF;
  PERFORM set_config('app.business_id',target.business_id::text,true);
  PERFORM set_config('app.user_id','',true);
  inventory_wait:=p_retryable AND target.job_type='financial_inventory_refresh'
    AND p_error_code='financial_inventory_not_confirmed';
  UPDATE mc.jobs
     SET status=CASE WHEN (inventory_wait OR (p_retryable AND attempt_count<max_attempts)) THEN 'pending' ELSE 'failed' END,
         available_at=CASE WHEN (inventory_wait OR (p_retryable AND attempt_count<max_attempts))
                           THEN clock_timestamp()+make_interval(secs=>CASE WHEN inventory_wait THEN 3600 ELSE p_retry_delay_seconds END) ELSE available_at END,
         attempt_count=CASE WHEN inventory_wait THEN greatest(attempt_count-1,0) ELSE attempt_count END,
         payload=CASE WHEN inventory_wait THEN payload||jsonb_build_object('awaitingReportsOnly',true) ELSE payload END,
         worker_id=NULL,lease_token=NULL,lease_until=NULL,heartbeat_at=NULL,outcome=NULL,
         finished_at=CASE WHEN (inventory_wait OR (p_retryable AND attempt_count<max_attempts)) THEN NULL ELSE clock_timestamp() END,
         updated_at=clock_timestamp(),last_error_code=p_error_code,last_error=NULL
   WHERE id=p_job_id AND status='running' AND lease_token=p_lease_token
     AND worker_id=p_worker_id AND lease_until>clock_timestamp()
  RETURNING * INTO failed;
  IF NOT FOUND THEN RAISE EXCEPTION 'job lease is not owned or has expired'; END IF;
  IF failed.status='pending' THEN
    UPDATE mc.job_dispatch
       SET status='pending',available_at=failed.available_at,attempt_count=failed.attempt_count,lease_until=NULL
     WHERE job_id=failed.id;
  ELSE
    DELETE FROM mc.job_dispatch WHERE job_id=failed.id;
    PERFORM mc.mark_financial_inventory_coverage_terminal(
      failed.business_id,failed.store_id,failed.job_type,failed.payload,failed.last_error_code
    );
  END IF;
  INSERT INTO mc.audit_events(business_id,store_id,action,entity_type,entity_id,safe_details)
  VALUES(failed.business_id,failed.store_id,
    CASE WHEN failed.status='pending' THEN 'job_retry_scheduled' ELSE 'job_failed' END,
    'jobs',failed.id,jsonb_build_object(
      'jobType',failed.job_type,'attemptCount',failed.attempt_count,
      'errorCode',failed.last_error_code,'retryable',failed.status='pending'
    ));
  RETURN failed;
END $$;

REVOKE ALL ON FUNCTION mc.fail_job(uuid,uuid,text,text,boolean,integer) FROM PUBLIC;

-- Reopen current unproven empty coverage without changing frozen financial inputs.
-- Revoke old empty evidence across generations, including archived stores:
-- immutable publications can still reference these earlier confirmations.
ALTER TABLE mc.financial_week_coverage NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.financial_week_inventory NO FORCE ROW LEVEL SECURITY;
UPDATE mc.financial_week_coverage wc
   SET coverage_status='unavailable',inventory_confirmed_at=NULL,empty_confirmed_by_job_id=NULL,
       next_retry_at=NULL,last_error_code='financial_inventory_not_confirmed',updated_at=clock_timestamp()
 WHERE wc.coverage_status='empty'
   AND NOT EXISTS(SELECT 1 FROM mc.financial_week_inventory wi WHERE wi.coverage_id=wc.id);
ALTER TABLE mc.financial_week_inventory FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.financial_week_coverage FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.stores NO FORCE ROW LEVEL SECURITY;
DO $$
DECLARE
  target record;
  actor uuid;
  generation bigint;
  gap_from date;
  gap_to date;
BEGIN
  FOR target IN SELECT business_id,id FROM mc.stores
    WHERE status='active' AND marketplace_code='wb' ORDER BY business_id,id
  LOOP
    PERFORM set_config('app.business_id',target.business_id::text,true);
    PERFORM set_config('app.user_id','',true);
    SELECT user_id INTO actor FROM mc.memberships
     WHERE business_id=target.business_id AND role IN ('owner','editor')
     ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END,created_at,user_id LIMIT 1;
    IF actor IS NULL THEN CONTINUE; END IF;
    PERFORM set_config('app.user_id',actor::text,true);
    SELECT credential_generation INTO generation FROM mc.connections
     WHERE business_id=target.business_id AND store_id=target.id
       AND status='active' AND scopes ? 'finance' FOR UPDATE;
    IF generation IS NULL OR generation<1 THEN CONTINUE; END IF;
    WITH reopened AS (
      UPDATE mc.financial_week_coverage wc
         SET coverage_status='retry',inventory_confirmed_at=NULL,empty_confirmed_by_job_id=NULL,
             freshness_due_at=coalesce(freshness_due_at,clock_timestamp()),
             next_retry_at=clock_timestamp(),last_error_code='financial_inventory_not_confirmed',
             updated_at=clock_timestamp()
       WHERE wc.business_id=target.business_id AND wc.store_id=target.id
         AND wc.credential_generation=generation
         AND (wc.coverage_status='empty' OR
           (wc.coverage_status IN ('retry','unavailable') AND wc.last_error_code='financial_inventory_not_confirmed'))
         AND NOT EXISTS(SELECT 1 FROM mc.financial_week_inventory wi WHERE wi.coverage_id=wc.id)
       RETURNING week_start,week_end
    ) SELECT min(week_start),max(week_end) INTO gap_from,gap_to FROM reopened;
    IF gap_from IS NULL THEN CONTINUE; END IF;
    IF NOT EXISTS(SELECT 1 FROM mc.jobs j
      WHERE j.business_id=target.business_id AND j.store_id=target.id
        AND j.job_type='financial_inventory_refresh' AND j.status IN ('pending','running')
        AND j.payload->>'credentialGeneration'=generation::text
        AND j.payload->'window'->>'dateFrom'<=gap_from::text
        AND j.payload->'window'->>'dateTo'>=gap_to::text
    ) THEN
      PERFORM mc.enqueue_job(target.id,'financial_inventory_refresh',
        format('financial-inventory:%s:g%s:hourly-wait-recovery',target.id,generation),
        jsonb_build_object('schemaVersion',1,'credentialGeneration',generation,'reason','hourly_wait_recovery',
          'window',jsonb_build_object('dateFrom',gap_from,'dateTo',gap_to),'timezone','Europe/Moscow'),
        clock_timestamp(),600,20);
    END IF;
  END LOOP;
END $$;
ALTER TABLE mc.stores FORCE ROW LEVEL SECURITY;

INSERT INTO mc.schema_migrations(version) VALUES(72);
COMMIT;
