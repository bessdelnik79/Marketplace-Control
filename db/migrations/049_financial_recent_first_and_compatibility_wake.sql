BEGIN;

-- Financial report fetches for a one-year bootstrap must become useful to the
-- owner immediately. Keep the generic queue priority, but order equal-priority
-- report fetches from the newest closed period to the oldest one.
ALTER TABLE mc.job_dispatch ADD COLUMN recency_date date;

ALTER TABLE mc.jobs NO FORCE ROW LEVEL SECURITY;
UPDATE mc.job_dispatch dispatch
   SET recency_date=(job.payload->>'periodEnd')::date
  FROM mc.jobs job
 WHERE job.id=dispatch.job_id
   AND dispatch.job_type='financial_report_fetch'
   AND coalesce(job.payload->>'periodEnd','') ~ '^\d{4}-\d{2}-\d{2}$';
ALTER TABLE mc.jobs FORCE ROW LEVEL SECURITY;

CREATE INDEX job_dispatch_financial_recent
  ON mc.job_dispatch(job_type,priority DESC,recency_date DESC,available_at,created_at,job_id)
  WHERE status='pending' AND job_type='financial_report_fetch';

CREATE OR REPLACE FUNCTION mc.enqueue_job(
  p_store_id uuid,
  p_job_type text,
  p_deduplication_key text,
  p_payload jsonb DEFAULT '{}'::jsonb,
  p_available_at timestamptz DEFAULT clock_timestamp(),
  p_priority integer DEFAULT 0,
  p_max_attempts integer DEFAULT 5
)
RETURNS mc.jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mc AS $$
DECLARE
  context_business uuid:=mc.context_business_id();
  context_user uuid:=mc.context_user_id();
  queued mc.jobs;
  queue_recency date;
BEGIN
  IF context_business IS NULL OR context_user IS NULL OR NOT EXISTS(
    SELECT 1 FROM mc.memberships m
     WHERE m.business_id=context_business AND m.user_id=context_user
       AND m.role IN ('owner','editor')
  ) THEN
    RAISE EXCEPTION 'owned business context is required';
  END IF;
  IF p_store_id IS NULL OR NOT EXISTS(
    SELECT 1 FROM mc.stores s WHERE s.business_id=context_business AND s.id=p_store_id
  ) THEN
    RAISE EXCEPTION 'store is outside business context';
  END IF;
  IF nullif(btrim(p_job_type),'') IS NULL OR length(btrim(p_job_type))>100
     OR nullif(btrim(p_deduplication_key),'') IS NULL OR length(btrim(p_deduplication_key))>300 THEN
    RAISE EXCEPTION 'job type and deduplication key are required';
  END IF;
  IF p_payload IS NULL OR jsonb_typeof(p_payload)<>'object' OR octet_length(p_payload::text)>262144 THEN
    RAISE EXCEPTION 'job payload must be an object';
  END IF;
  IF p_priority IS NULL OR p_priority NOT BETWEEN -1000 AND 1000
     OR p_max_attempts IS NULL OR p_max_attempts NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'job limits are invalid';
  END IF;
  IF btrim(p_job_type)='financial_report_fetch'
     AND coalesce(p_payload->>'periodEnd','') ~ '^\d{4}-\d{2}-\d{2}$' THEN
    queue_recency:=(p_payload->>'periodEnd')::date;
  END IF;

  INSERT INTO mc.jobs(
    business_id,store_id,job_type,deduplication_key,payload,status,
    available_at,priority,max_attempts
  ) VALUES(
    context_business,p_store_id,btrim(p_job_type),btrim(p_deduplication_key),p_payload,'pending',
    coalesce(p_available_at,clock_timestamp()),p_priority,p_max_attempts
  )
  ON CONFLICT(business_id,deduplication_key) WHERE status IN ('pending','running')
  DO NOTHING
  RETURNING * INTO queued;
  IF FOUND THEN
    INSERT INTO mc.job_dispatch(job_id,business_id,job_type,priority,available_at,status,attempt_count,max_attempts,created_at,recency_date)
    VALUES(queued.id,queued.business_id,queued.job_type,queued.priority,queued.available_at,'pending',queued.attempt_count,queued.max_attempts,queued.created_at,queue_recency);
    INSERT INTO mc.audit_events(business_id,store_id,actor_user_id,action,entity_type,entity_id,safe_details)
    VALUES(queued.business_id,queued.store_id,context_user,'job_enqueued','jobs',queued.id,
      jsonb_build_object('jobType',queued.job_type,'deduplicationKey',queued.deduplication_key));
  ELSE
    SELECT * INTO queued FROM mc.jobs
     WHERE business_id=context_business AND deduplication_key=btrim(p_deduplication_key)
       AND status IN ('pending','running');
  END IF;
  RETURN queued;
END $$;

REVOKE ALL ON FUNCTION mc.enqueue_job(uuid,text,text,jsonb,timestamptz,integer,integer) FROM PUBLIC;

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
     ORDER BY d.priority DESC,
       CASE WHEN d.job_type='financial_report_fetch' THEN d.recency_date END DESC NULLS LAST,
       d.available_at,d.created_at,d.job_id
     FOR UPDATE SKIP LOCKED
     LIMIT p_limit
  LOOP
    PERFORM set_config('app.business_id',target.business_id::text,true);
    PERFORM set_config('app.user_id','',true);
    IF target.attempt_count>=target.max_attempts THEN
      UPDATE mc.jobs
         SET status='failed',worker_id=NULL,lease_token=NULL,lease_until=NULL,heartbeat_at=NULL,
             finished_at=clock_timestamp(),updated_at=clock_timestamp(),
             last_error_code=CASE
               WHEN last_error_code='financial_daily_publication_shadow_incompatible' THEN last_error_code
               ELSE 'max_attempts_exhausted'
             END,last_error=NULL
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

-- A daily publication may back off before the compatibility worker has saved
-- a matching legacy period. Wake only that safe, known retry as soon as the
-- compatibility calculation completes; attempts and error evidence remain.
CREATE FUNCTION mc.wake_financial_daily_after_compatibility(p_store_id uuid)
RETURNS mc.jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mc AS $$
DECLARE
  context_business uuid:=mc.context_business_id();
  context_user uuid:=mc.context_user_id();
  target_job_id uuid;
  awakened mc.jobs;
BEGIN
  IF context_business IS NULL OR context_user IS NULL OR NOT EXISTS(
    SELECT 1 FROM mc.memberships membership
     WHERE membership.business_id=context_business AND membership.user_id=context_user
       AND membership.role IN ('owner','editor')
  ) THEN RAISE EXCEPTION 'owned business context is required'; END IF;
  IF p_store_id IS NULL OR NOT EXISTS(
    SELECT 1 FROM mc.stores store
     WHERE store.business_id=context_business AND store.id=p_store_id AND store.status='active'
  ) THEN RAISE EXCEPTION 'store is outside business context'; END IF;

  -- Claiming workers lock dispatch before jobs. Use the same order and skip a
  -- row already being claimed; its short retry will observe the saved legacy
  -- publication without requiring a second wake.
  SELECT dispatch.job_id INTO target_job_id
    FROM mc.job_dispatch dispatch
   WHERE dispatch.business_id=context_business
     AND dispatch.job_type='financial_dates_recalculate'
     AND dispatch.status='pending'
     AND EXISTS(
       SELECT 1 FROM mc.jobs job
        WHERE job.business_id=context_business AND job.id=dispatch.job_id
          AND job.store_id=p_store_id AND job.status='pending'
          AND job.last_error_code='financial_daily_publication_shadow_incompatible'
     )
   ORDER BY dispatch.created_at,dispatch.job_id
   FOR UPDATE SKIP LOCKED
   LIMIT 1;

  UPDATE mc.jobs job
     SET available_at=least(job.available_at,clock_timestamp()),updated_at=clock_timestamp()
   WHERE job.business_id=context_business AND job.id=target_job_id
  RETURNING * INTO awakened;
  IF awakened.id IS NOT NULL THEN
    UPDATE mc.job_dispatch dispatch
       SET available_at=awakened.available_at
     WHERE dispatch.job_id=awakened.id AND dispatch.status='pending';
    RETURN awakened;
  END IF;

  -- A long compatibility wait can exhaust the finite retry budget. Recovery
  -- is allowed only after this compatibility worker has succeeded and only
  -- for the exact shadow-wait failure; unrelated terminal jobs remain sealed.
  -- Never reopen historical work while a newer daily job is pending/running.
  IF EXISTS(
    SELECT 1 FROM mc.jobs active
     WHERE active.business_id=context_business AND active.store_id=p_store_id
       AND active.job_type='financial_dates_recalculate'
       AND active.status IN ('pending','running')
  ) THEN RETURN NULL; END IF;

  SELECT failed.id INTO target_job_id
    FROM mc.jobs failed
   WHERE failed.business_id=context_business AND failed.store_id=p_store_id
     AND failed.job_type='financial_dates_recalculate' AND failed.status='failed'
     AND failed.last_error_code='financial_daily_publication_shadow_incompatible'
     AND NOT EXISTS(SELECT 1 FROM mc.job_dispatch dispatch WHERE dispatch.job_id=failed.id)
   ORDER BY failed.created_at,failed.id
   FOR UPDATE SKIP LOCKED
   LIMIT 1;
  IF target_job_id IS NOT NULL THEN
    UPDATE mc.jobs job
       SET status='pending',attempt_count=0,available_at=clock_timestamp(),
           worker_id=NULL,lease_token=NULL,lease_until=NULL,heartbeat_at=NULL,
           finished_at=NULL,outcome=NULL,last_error=NULL,last_error_code=NULL,
           updated_at=clock_timestamp()
     WHERE job.business_id=context_business AND job.id=target_job_id
    RETURNING * INTO awakened;
    INSERT INTO mc.job_dispatch(
      job_id,business_id,job_type,priority,available_at,status,
      attempt_count,max_attempts,lease_until,created_at,recency_date
    ) VALUES(
      awakened.id,awakened.business_id,awakened.job_type,awakened.priority,
      awakened.available_at,'pending',awakened.attempt_count,awakened.max_attempts,
      NULL,awakened.created_at,NULL
    );
  END IF;
  RETURN awakened;
END $$;

REVOKE ALL ON FUNCTION mc.wake_financial_daily_after_compatibility(uuid) FROM PUBLIC;

INSERT INTO mc.schema_migrations(version) VALUES(49);
COMMIT;
