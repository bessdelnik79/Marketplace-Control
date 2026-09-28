BEGIN;

CREATE FUNCTION mc.mark_financial_inventory_coverage_terminal(
  p_business_id uuid,
  p_store_id uuid,
  p_job_type text,
  p_payload jsonb,
  p_error_code text
)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mc AS $$
DECLARE
  generation bigint;
  date_from date;
  date_to date;
  affected integer:=0;
BEGIN
  IF p_job_type<>'financial_inventory_refresh' THEN RETURN 0; END IF;
  BEGIN
    generation:=(p_payload->>'credentialGeneration')::bigint;
    date_from:=(p_payload->'window'->>'dateFrom')::date;
    date_to:=(p_payload->'window'->>'dateTo')::date;
  EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow OR numeric_value_out_of_range THEN
    RETURN 0;
  END;
  IF generation IS NULL OR generation<1 OR date_from IS NULL OR date_to IS NULL OR date_to<date_from THEN RETURN 0; END IF;
  UPDATE mc.financial_week_coverage coverage
     SET coverage_status='unavailable',next_retry_at=NULL,last_error_code=p_error_code,
         last_checked_at=coalesce(coverage.last_checked_at,clock_timestamp()),updated_at=clock_timestamp()
   WHERE coverage.business_id=p_business_id AND coverage.store_id=p_store_id
     AND coverage.credential_generation=generation
     AND coverage.week_start<=date_to AND coverage.week_end>=date_from
     AND coverage.coverage_status IN ('pending','retry');
  GET DIAGNOSTICS affected=ROW_COUNT;
  RETURN affected;
END $$;

REVOKE ALL ON FUNCTION mc.mark_financial_inventory_coverage_terminal(uuid,uuid,text,jsonb,text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION mc.claim_jobs(
  p_worker_id text,
  p_job_types text[],
  p_lease_seconds integer DEFAULT 300,
  p_limit integer DEFAULT 1
)
RETURNS SETOF mc.jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mc AS $$
DECLARE
  target mc.job_dispatch;
  claimed mc.jobs;
BEGIN
  IF nullif(btrim(p_worker_id),'') IS NULL OR length(btrim(p_worker_id))>200 THEN
    RAISE EXCEPTION 'worker id is required';
  END IF;
  IF p_job_types IS NULL OR cardinality(p_job_types) NOT BETWEEN 1 AND 50 OR EXISTS(
    SELECT 1 FROM unnest(p_job_types) value
     WHERE nullif(btrim(value),'') IS NULL OR length(btrim(value))>100
  ) THEN
    RAISE EXCEPTION 'at least one valid job type is required';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100
     OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 5 AND 3600 THEN
    RAISE EXCEPTION 'claim limits are invalid';
  END IF;

  FOR target IN
    SELECT d.* FROM mc.job_dispatch d
     WHERE d.job_type=ANY(p_job_types) AND (
       (d.status='pending' AND d.available_at<=clock_timestamp())
       OR (d.status='running' AND d.lease_until<=clock_timestamp())
     )
     ORDER BY d.priority DESC,d.available_at,d.created_at,d.job_id
     FOR UPDATE SKIP LOCKED
     LIMIT p_limit
  LOOP
    PERFORM set_config('app.business_id',target.business_id::text,true);
    PERFORM set_config('app.user_id','',true);
    IF target.attempt_count>=target.max_attempts THEN
      UPDATE mc.jobs
         SET status='failed',worker_id=NULL,lease_token=NULL,lease_until=NULL,heartbeat_at=NULL,
             finished_at=clock_timestamp(),updated_at=clock_timestamp(),
             last_error_code='max_attempts_exhausted',last_error=NULL
       WHERE business_id=target.business_id AND id=target.job_id
      RETURNING * INTO claimed;
      DELETE FROM mc.job_dispatch WHERE job_id=target.job_id;
      PERFORM mc.mark_financial_inventory_coverage_terminal(
        claimed.business_id,claimed.store_id,claimed.job_type,claimed.payload,claimed.last_error_code
      );
      INSERT INTO mc.audit_events(business_id,store_id,action,entity_type,entity_id,safe_details)
      VALUES(claimed.business_id,claimed.store_id,'job_failed','jobs',claimed.id,
        jsonb_build_object('jobType',claimed.job_type,'attemptCount',claimed.attempt_count,'errorCode',claimed.last_error_code));
    ELSE
      UPDATE mc.jobs
         SET status='running',attempt_count=attempt_count+1,worker_id=btrim(p_worker_id),
             lease_token=gen_random_uuid(),lease_until=clock_timestamp()+make_interval(secs=>p_lease_seconds),
             heartbeat_at=clock_timestamp(),finished_at=NULL,outcome=NULL,updated_at=clock_timestamp()
       WHERE business_id=target.business_id AND id=target.job_id
      RETURNING * INTO claimed;
      UPDATE mc.job_dispatch
         SET status='running',attempt_count=claimed.attempt_count,lease_until=claimed.lease_until
       WHERE job_id=claimed.id;
      INSERT INTO mc.audit_events(business_id,store_id,action,entity_type,entity_id,safe_details)
      VALUES(claimed.business_id,claimed.store_id,'job_claimed','jobs',claimed.id,
        jsonb_build_object('jobType',claimed.job_type,'attemptCount',claimed.attempt_count,'workerId',claimed.worker_id));
      RETURN NEXT claimed;
    END IF;
  END LOOP;
END $$;

REVOKE ALL ON FUNCTION mc.claim_jobs(text,text[],integer,integer) FROM PUBLIC;

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
  UPDATE mc.jobs
     SET status=CASE WHEN p_retryable AND attempt_count<max_attempts THEN 'pending' ELSE 'failed' END,
         available_at=CASE WHEN p_retryable AND attempt_count<max_attempts
                           THEN clock_timestamp()+make_interval(secs=>p_retry_delay_seconds) ELSE available_at END,
         worker_id=NULL,lease_token=NULL,lease_until=NULL,heartbeat_at=NULL,outcome=NULL,
         finished_at=CASE WHEN p_retryable AND attempt_count<max_attempts THEN NULL ELSE clock_timestamp() END,
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

ALTER TABLE mc.financial_week_coverage NO FORCE ROW LEVEL SECURITY;
WITH terminal_failures AS (
  SELECT DISTINCT ON (coverage.id) coverage.id,job.last_error_code
    FROM mc.financial_week_coverage coverage
    JOIN mc.jobs job ON job.business_id=coverage.business_id AND job.store_id=coverage.store_id
     AND job.job_type='financial_inventory_refresh' AND job.status='failed'
     AND CASE WHEN pg_input_is_valid(job.payload->>'credentialGeneration','bigint')
              THEN (job.payload->>'credentialGeneration')::bigint END=coverage.credential_generation
     AND coverage.week_start<=CASE WHEN pg_input_is_valid(job.payload->'window'->>'dateTo','date')
                                   THEN (job.payload->'window'->>'dateTo')::date END
     AND coverage.week_end>=CASE WHEN pg_input_is_valid(job.payload->'window'->>'dateFrom','date')
                                 THEN (job.payload->'window'->>'dateFrom')::date END
     AND job.finished_at>=coverage.updated_at
   WHERE coverage.coverage_status='retry'
     AND NOT EXISTS(
       SELECT 1 FROM mc.jobs active
        WHERE active.business_id=coverage.business_id AND active.store_id=coverage.store_id
          AND active.job_type='financial_inventory_refresh' AND active.status IN ('pending','running')
          AND CASE WHEN pg_input_is_valid(active.payload->>'credentialGeneration','bigint')
                   THEN (active.payload->>'credentialGeneration')::bigint END=coverage.credential_generation
          AND coverage.week_start<=CASE WHEN pg_input_is_valid(active.payload->'window'->>'dateTo','date')
                                        THEN (active.payload->'window'->>'dateTo')::date END
          AND coverage.week_end>=CASE WHEN pg_input_is_valid(active.payload->'window'->>'dateFrom','date')
                                      THEN (active.payload->'window'->>'dateFrom')::date END
     )
   ORDER BY coverage.id,job.finished_at DESC NULLS LAST,job.id DESC
)
UPDATE mc.financial_week_coverage coverage
   SET coverage_status='unavailable',next_retry_at=NULL,
       last_error_code=coalesce(terminal_failures.last_error_code,coverage.last_error_code,'financial_inventory_not_confirmed'),
       updated_at=clock_timestamp()
  FROM terminal_failures
 WHERE coverage.id=terminal_failures.id;
ALTER TABLE mc.financial_week_coverage FORCE ROW LEVEL SECURITY;

INSERT INTO mc.schema_migrations(version) VALUES(43);

COMMIT;
