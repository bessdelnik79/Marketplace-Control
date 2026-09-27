BEGIN;

DROP INDEX IF EXISTS mc.active_job_key;
DROP INDEX IF EXISTS mc.ready_jobs;

ALTER TABLE mc.jobs RENAME COLUMN scheduled_at TO available_at;
ALTER TABLE mc.jobs
  ADD COLUMN priority integer NOT NULL DEFAULT 0,
  ADD COLUMN lease_token uuid,
  ADD COLUMN heartbeat_at timestamptz,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN finished_at timestamptz,
  ADD COLUMN last_error_code text,
  ADD COLUMN outcome text;

ALTER TABLE mc.jobs DROP CONSTRAINT jobs_status_check;

UPDATE mc.jobs
   SET status=CASE status
                WHEN 'queued' THEN 'pending'
                WHEN 'cancelled' THEN 'failed'
                WHEN 'running' THEN 'pending'
                ELSE status
              END,
       worker_id=NULL,
       lease_until=NULL,
       last_error=NULL,
       finished_at=CASE WHEN status IN ('succeeded','failed','cancelled') THEN clock_timestamp() ELSE NULL END,
       last_error_code=CASE
                         WHEN status='cancelled' THEN 'legacy_cancelled'
                         WHEN status='failed' THEN 'legacy_failed'
                         ELSE last_error_code
                       END,
       outcome=CASE WHEN status='succeeded' THEN 'completed' ELSE NULL END,
       updated_at=clock_timestamp();

ALTER TABLE mc.jobs
  ALTER COLUMN status SET DEFAULT 'pending',
  ADD CONSTRAINT jobs_status_check CHECK (status IN ('pending','running','succeeded','failed')),
  ADD CONSTRAINT jobs_priority_check CHECK (priority BETWEEN -1000 AND 1000),
  ADD CONSTRAINT jobs_outcome_check CHECK (
    (status='succeeded' AND outcome IN ('completed','superseded'))
    OR (status<>'succeeded' AND outcome IS NULL)
  ),
  ADD CONSTRAINT jobs_lifecycle_check CHECK (
    (status='pending' AND worker_id IS NULL AND lease_token IS NULL AND lease_until IS NULL AND heartbeat_at IS NULL AND finished_at IS NULL)
    OR (status='running' AND worker_id IS NOT NULL AND lease_token IS NOT NULL AND lease_until IS NOT NULL AND heartbeat_at IS NOT NULL AND finished_at IS NULL)
    OR (status IN ('succeeded','failed') AND worker_id IS NULL AND lease_token IS NULL AND lease_until IS NULL AND heartbeat_at IS NULL AND finished_at IS NOT NULL)
  );

CREATE UNIQUE INDEX active_job_key
  ON mc.jobs(business_id,deduplication_key)
  WHERE status IN ('pending','running');
CREATE INDEX ready_jobs
  ON mc.jobs(priority DESC,available_at,created_at,id)
  WHERE status='pending';
CREATE INDEX expired_job_leases
  ON mc.jobs(lease_until,id)
  WHERE status='running';

-- Cross-tenant discovery is kept outside the tenant read model. Worker
-- functions lock this narrow index, then set the exact business context before
-- touching FORCE-RLS-protected mc.jobs.
CREATE TABLE mc.job_dispatch (
  job_id uuid PRIMARY KEY REFERENCES mc.jobs(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES mc.businesses(id),
  job_type text NOT NULL,
  priority integer NOT NULL,
  available_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','running')),
  attempt_count integer NOT NULL CHECK (attempt_count>=0),
  max_attempts integer NOT NULL CHECK (max_attempts>0),
  lease_until timestamptz,
  created_at timestamptz NOT NULL,
  CHECK ((status='pending' AND lease_until IS NULL) OR (status='running' AND lease_until IS NOT NULL))
);
CREATE INDEX job_dispatch_ready
  ON mc.job_dispatch(priority DESC,available_at,created_at,job_id)
  WHERE status='pending';
CREATE INDEX job_dispatch_expired
  ON mc.job_dispatch(lease_until,job_id)
  WHERE status='running';
REVOKE ALL ON mc.job_dispatch FROM PUBLIC;

INSERT INTO mc.job_dispatch(job_id,business_id,job_type,priority,available_at,status,attempt_count,max_attempts,created_at)
SELECT id,business_id,job_type,priority,available_at,'pending',attempt_count,max_attempts,created_at
  FROM mc.jobs WHERE status='pending';

CREATE FUNCTION mc.enqueue_job(
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
    INSERT INTO mc.job_dispatch(job_id,business_id,job_type,priority,available_at,status,attempt_count,max_attempts,created_at)
    VALUES(queued.id,queued.business_id,queued.job_type,queued.priority,queued.available_at,'pending',queued.attempt_count,queued.max_attempts,queued.created_at);
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

CREATE FUNCTION mc.claim_jobs(
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

CREATE FUNCTION mc.heartbeat_job(
  p_job_id uuid,
  p_lease_token uuid,
  p_worker_id text,
  p_lease_seconds integer DEFAULT 300
)
RETURNS mc.jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mc AS $$
DECLARE
  renewed mc.jobs;
  target mc.job_dispatch;
BEGIN
  IF nullif(btrim(p_worker_id),'') IS NULL OR length(btrim(p_worker_id))>200 THEN RAISE EXCEPTION 'worker id is invalid'; END IF;
  IF p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 5 AND 3600 THEN RAISE EXCEPTION 'lease duration is invalid'; END IF;
  SELECT * INTO target FROM mc.job_dispatch WHERE job_id=p_job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'job lease is not owned or has expired'; END IF;
  PERFORM set_config('app.business_id',target.business_id::text,true);
  PERFORM set_config('app.user_id','',true);
  UPDATE mc.jobs
     SET heartbeat_at=clock_timestamp(),lease_until=clock_timestamp()+make_interval(secs=>p_lease_seconds),
         updated_at=clock_timestamp()
   WHERE id=p_job_id AND status='running' AND lease_token=p_lease_token
     AND worker_id=p_worker_id AND lease_until>clock_timestamp()
  RETURNING * INTO renewed;
  IF NOT FOUND THEN RAISE EXCEPTION 'job lease is not owned or has expired'; END IF;
  UPDATE mc.job_dispatch SET lease_until=renewed.lease_until WHERE job_id=renewed.id;
  RETURN renewed;
END $$;

REVOKE ALL ON FUNCTION mc.heartbeat_job(uuid,uuid,text,integer) FROM PUBLIC;

CREATE FUNCTION mc.complete_job(
  p_job_id uuid,
  p_lease_token uuid,
  p_worker_id text,
  p_outcome text DEFAULT 'completed'
)
RETURNS mc.jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mc AS $$
DECLARE
  completed mc.jobs;
  target mc.job_dispatch;
BEGIN
  IF nullif(btrim(p_worker_id),'') IS NULL OR length(btrim(p_worker_id))>200 THEN RAISE EXCEPTION 'worker id is invalid'; END IF;
  IF p_outcome NOT IN ('completed','superseded') THEN RAISE EXCEPTION 'job outcome is invalid'; END IF;
  SELECT * INTO target FROM mc.job_dispatch WHERE job_id=p_job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'job lease is not owned or has expired'; END IF;
  PERFORM set_config('app.business_id',target.business_id::text,true);
  PERFORM set_config('app.user_id','',true);
  UPDATE mc.jobs
     SET status='succeeded',outcome=p_outcome,worker_id=NULL,lease_token=NULL,lease_until=NULL,
         heartbeat_at=NULL,finished_at=clock_timestamp(),updated_at=clock_timestamp(),
         last_error=NULL,last_error_code=NULL
   WHERE id=p_job_id AND status='running' AND lease_token=p_lease_token
     AND worker_id=p_worker_id AND lease_until>clock_timestamp()
  RETURNING * INTO completed;
  IF NOT FOUND THEN RAISE EXCEPTION 'job lease is not owned or has expired'; END IF;
  DELETE FROM mc.job_dispatch WHERE job_id=completed.id;
  INSERT INTO mc.audit_events(business_id,store_id,action,entity_type,entity_id,safe_details)
  VALUES(completed.business_id,completed.store_id,'job_succeeded','jobs',completed.id,
    jsonb_build_object('jobType',completed.job_type,'attemptCount',completed.attempt_count,'outcome',completed.outcome));
  RETURN completed;
END $$;

REVOKE ALL ON FUNCTION mc.complete_job(uuid,uuid,text,text) FROM PUBLIC;

CREATE FUNCTION mc.fail_job(
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

INSERT INTO mc.schema_migrations(version) VALUES(33);

COMMIT;
