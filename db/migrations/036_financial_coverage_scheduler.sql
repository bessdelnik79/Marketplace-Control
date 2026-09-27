BEGIN;

CREATE TABLE mc.financial_week_coverage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  store_id uuid NOT NULL,
  credential_generation bigint NOT NULL CHECK (credential_generation>0),
  week_start date NOT NULL,
  week_end date NOT NULL,
  check_reasons text[] NOT NULL DEFAULT '{}',
  coverage_status text NOT NULL DEFAULT 'pending' CHECK (coverage_status IN ('pending','inventory_confirmed','fetching','complete','partial','retry','unavailable')),
  inventory_confirmed_at timestamptz,
  last_checked_at timestamptz,
  freshness_due_at timestamptz,
  next_retry_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id,store_id,credential_generation,week_start),
  FOREIGN KEY (business_id,store_id) REFERENCES mc.stores(business_id,id),
  CHECK (extract(isodow from week_start)=1 AND week_end=week_start+6),
  CHECK (cardinality(check_reasons)>0),
  CHECK (last_error_code IS NULL OR last_error_code ~ '^[a-z0-9][a-z0-9_.:-]{0,99}$')
);
CREATE INDEX financial_week_coverage_due ON mc.financial_week_coverage(business_id,store_id,freshness_due_at,week_start);

CREATE TABLE mc.financial_week_inventory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  store_id uuid NOT NULL,
  coverage_id uuid NOT NULL REFERENCES mc.financial_week_coverage(id) ON DELETE CASCADE,
  external_report_id text NOT NULL CHECK (external_report_id ~ '^[0-9]+$'),
  inventory_checksum text NOT NULL CHECK (inventory_checksum ~ '^[0-9a-f]{64}$'),
  report_type text,
  country text,
  period_start date NOT NULL,
  period_end date NOT NULL,
  fetch_status text NOT NULL DEFAULT 'pending' CHECK (fetch_status IN ('pending','fetching','accepted','retry','failed')),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (coverage_id,external_report_id),
  UNIQUE (business_id,store_id,id),
  CHECK (period_end>=period_start),
  FOREIGN KEY (business_id,store_id) REFERENCES mc.stores(business_id,id)
);
CREATE INDEX financial_week_inventory_fetch ON mc.financial_week_inventory(business_id,store_id,fetch_status,period_start);

CREATE TABLE mc.financial_report_capabilities (
  business_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  credential_generation bigint NOT NULL CHECK (credential_generation>0),
  list_api text NOT NULL DEFAULT 'unknown' CHECK (list_api IN ('unknown','supported','unsupported_country')),
  detail_by_id_api text NOT NULL DEFAULT 'unknown' CHECK (detail_by_id_api IN ('unknown','supported','unsupported_country')),
  fallback_mode text CHECK (fallback_mode IS NULL OR fallback_mode='period'),
  reason_code text,
  observed_at timestamptz,
  PRIMARY KEY (business_id,connection_id,credential_generation),
  FOREIGN KEY (business_id,connection_id) REFERENCES mc.connections(business_id,id) ON DELETE CASCADE,
  CHECK (reason_code IS NULL OR reason_code ~ '^[a-z0-9][a-z0-9_.:-]{0,99}$')
);

ALTER TABLE mc.financial_week_coverage ENABLE ROW LEVEL SECURITY;
ALTER TABLE mc.financial_week_coverage FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mc.financial_week_coverage USING (business_id=mc.context_business_id()) WITH CHECK (business_id=mc.context_business_id());
ALTER TABLE mc.financial_week_inventory ENABLE ROW LEVEL SECURITY;
ALTER TABLE mc.financial_week_inventory FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mc.financial_week_inventory USING (business_id=mc.context_business_id()) WITH CHECK (business_id=mc.context_business_id());
ALTER TABLE mc.financial_report_capabilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE mc.financial_report_capabilities FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mc.financial_report_capabilities USING (business_id=mc.context_business_id()) WITH CHECK (business_id=mc.context_business_id());

-- Closed cross-tenant scheduler index. Tenant data stays in FORCE-RLS tables;
-- this table contains only eligibility and the last claimed Moscow boundary.
CREATE TABLE mc.financial_schedule_targets (
  store_id uuid PRIMARY KEY,
  business_id uuid NOT NULL,
  requested_by uuid NOT NULL,
  credential_generation bigint NOT NULL CHECK (credential_generation>0),
  store_status text NOT NULL CHECK (store_status IN ('active','paused','archived')),
  connection_status text NOT NULL CHECK (connection_status IN ('pending','active','invalid','revoked')),
  finance_enabled boolean NOT NULL,
  last_schedule_boundary date NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id,store_id) REFERENCES mc.stores(business_id,id)
);
CREATE INDEX financial_schedule_targets_eligible ON mc.financial_schedule_targets(last_schedule_boundary,store_id)
  WHERE store_status='active' AND connection_status='active' AND finance_enabled;
REVOKE ALL ON mc.financial_schedule_targets FROM PUBLIC;

CREATE TABLE mc.financial_credential_backfill_targets (
  connection_id uuid PRIMARY KEY,
  business_id uuid NOT NULL,
  store_id uuid NOT NULL,
  requested_by uuid NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count>=0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON mc.financial_credential_backfill_targets FROM PUBLIC;

ALTER TABLE mc.connections NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.stores NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.memberships NO FORCE ROW LEVEL SECURITY;
INSERT INTO mc.financial_credential_backfill_targets(connection_id,business_id,store_id,requested_by)
SELECT c.id,c.business_id,c.store_id,member.user_id
  FROM mc.connections c
  JOIN mc.stores s ON s.business_id=c.business_id AND s.id=c.store_id
  JOIN LATERAL (
    SELECT m.user_id FROM mc.memberships m WHERE m.business_id=c.business_id AND m.role IN ('owner','editor')
     ORDER BY CASE m.role WHEN 'owner' THEN 0 ELSE 1 END,m.created_at,m.user_id LIMIT 1
  ) member ON true
 WHERE c.credential_generation=0 AND c.status='active' AND s.status='active' AND s.marketplace_code='wb' AND c.scopes ? 'finance';
ALTER TABLE mc.connections FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.stores FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.memberships FORCE ROW LEVEL SECURITY;

CREATE FUNCTION mc.plan_financial_credential_refresh(p_store_id uuid,p_generation bigint,p_event_at timestamptz DEFAULT clock_timestamp())
RETURNS TABLE(week_count integer,job_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mc AS $$
#variable_conflict use_column
DECLARE
  context_business uuid:=mc.context_business_id();
  context_user uuid:=mc.context_user_id();
  event_date date:=(p_event_at AT TIME ZONE 'Europe/Moscow')::date;
  lookback_date date;
  first_monday date;
  current_monday date;
  last_sunday date;
  target_connection mc.connections;
  queued mc.jobs;
BEGIN
  IF context_business IS NULL OR context_user IS NULL OR NOT EXISTS(
    SELECT 1 FROM mc.memberships m WHERE m.business_id=context_business AND m.user_id=context_user AND m.role IN ('owner','editor')
  ) THEN RAISE EXCEPTION 'owned business context is required'; END IF;
  SELECT c.* INTO target_connection FROM mc.connections c
    JOIN mc.stores s ON s.business_id=c.business_id AND s.id=c.store_id
   WHERE c.business_id=context_business AND c.store_id=p_store_id AND c.status='active'
     AND s.status='active' AND s.marketplace_code='wb' AND c.credential_generation=p_generation
   FOR UPDATE OF c;
  IF NOT FOUND THEN RAISE EXCEPTION 'active credential generation is required'; END IF;

  lookback_date:=(event_date-interval '1 year')::date;
  first_monday:=lookback_date-(extract(isodow from lookback_date)::integer-1);
  current_monday:=event_date-(extract(isodow from event_date)::integer-1);
  last_sunday:=current_monday-1;

  INSERT INTO mc.financial_schedule_targets(store_id,business_id,requested_by,credential_generation,store_status,connection_status,finance_enabled,last_schedule_boundary,updated_at)
  SELECT s.id,s.business_id,context_user,p_generation,s.status,target_connection.status,
         target_connection.scopes ? 'finance',current_monday,clock_timestamp()
    FROM mc.stores s WHERE s.business_id=context_business AND s.id=p_store_id
  ON CONFLICT(store_id) DO UPDATE SET requested_by=excluded.requested_by,credential_generation=excluded.credential_generation,
    store_status=excluded.store_status,connection_status=excluded.connection_status,finance_enabled=excluded.finance_enabled,
    last_schedule_boundary=excluded.last_schedule_boundary,updated_at=clock_timestamp();

  INSERT INTO mc.financial_report_capabilities(business_id,connection_id,credential_generation)
  VALUES(context_business,target_connection.id,p_generation) ON CONFLICT DO NOTHING;

  INSERT INTO mc.financial_week_coverage(business_id,store_id,credential_generation,week_start,week_end,check_reasons,freshness_due_at)
  SELECT context_business,p_store_id,p_generation,week_start::date,(week_start+interval '6 days')::date,
         ARRAY['credential_generation'],clock_timestamp()
    FROM generate_series(first_monday,last_sunday,interval '7 days') week_start
  ON CONFLICT(business_id,store_id,credential_generation,week_start) DO UPDATE
    SET check_reasons=(SELECT array_agg(DISTINCT reason ORDER BY reason) FROM unnest(mc.financial_week_coverage.check_reasons||excluded.check_reasons) reason),
        freshness_due_at=least(mc.financial_week_coverage.freshness_due_at,excluded.freshness_due_at),updated_at=clock_timestamp();
  GET DIAGNOSTICS week_count=ROW_COUNT;

  SELECT * INTO queued FROM mc.enqueue_job(p_store_id,'financial_inventory_refresh',
    format('financial-inventory:%s:g%s:credential',p_store_id,p_generation),
    jsonb_build_object('schemaVersion',1,'credentialGeneration',p_generation,'reason','credential_generation',
      'window',jsonb_build_object('dateFrom',first_monday,'dateTo',last_sunday),'timezone','Europe/Moscow'),
    clock_timestamp(),100,20);
  job_id:=queued.id;
  DELETE FROM mc.financial_credential_backfill_targets WHERE connection_id=target_connection.id;
  RETURN NEXT;
END $$;
REVOKE ALL ON FUNCTION mc.plan_financial_credential_refresh(uuid,bigint,timestamptz) FROM PUBLIC;

CREATE FUNCTION mc.schedule_financial_inventory(p_now timestamptz DEFAULT clock_timestamp(),p_limit integer DEFAULT 100)
RETURNS TABLE(store_id uuid,credential_generation bigint,schedule_boundary date,job_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mc AS $$
#variable_conflict use_column
DECLARE
  target mc.financial_schedule_targets;
  actor uuid;
  boundary date:=(p_now AT TIME ZONE 'Europe/Moscow')::date;
  due_start date;
  window_start date;
  queued mc.jobs;
BEGIN
  boundary:=boundary-(extract(isodow from boundary)::integer-1);
  due_start:=boundary-7;
  window_start:=due_start-28;
  FOR target IN
    SELECT * FROM mc.financial_schedule_targets t
     WHERE t.store_status='active' AND t.connection_status='active' AND t.finance_enabled
       AND t.last_schedule_boundary<boundary
     ORDER BY t.last_schedule_boundary,t.store_id FOR UPDATE SKIP LOCKED
     LIMIT greatest(1,least(coalesce(p_limit,100),500))
  LOOP
    PERFORM set_config('app.business_id',target.business_id::text,true);
    PERFORM set_config('app.user_id','',true);
    SELECT m.user_id INTO actor FROM mc.memberships m WHERE m.business_id=target.business_id AND m.role IN ('owner','editor')
      ORDER BY CASE m.role WHEN 'owner' THEN 0 ELSE 1 END,m.created_at,m.user_id LIMIT 1;
    IF actor IS NULL THEN
      UPDATE mc.financial_schedule_targets fst SET finance_enabled=false,updated_at=clock_timestamp() WHERE fst.store_id=target.store_id;
      CONTINUE;
    END IF;
    PERFORM set_config('app.user_id',actor::text,true);
    INSERT INTO mc.financial_week_coverage(business_id,store_id,credential_generation,week_start,week_end,check_reasons,freshness_due_at)
    SELECT target.business_id,target.store_id,target.credential_generation,week_start::date,(week_start+interval '6 days')::date,
           ARRAY['scheduled_freshness'],p_now
      FROM generate_series(window_start,due_start,interval '7 days') week_start
    ON CONFLICT(business_id,store_id,credential_generation,week_start) DO UPDATE
      SET check_reasons=(SELECT array_agg(DISTINCT reason ORDER BY reason) FROM unnest(mc.financial_week_coverage.check_reasons||excluded.check_reasons) reason),
          freshness_due_at=excluded.freshness_due_at,coverage_status=CASE WHEN mc.financial_week_coverage.coverage_status='unavailable' THEN 'unavailable' ELSE 'pending' END,
          updated_at=clock_timestamp();
    SELECT * INTO queued FROM mc.enqueue_job(target.store_id,'financial_inventory_refresh',
      format('financial-inventory:%s:g%s:monday:%s',target.store_id,target.credential_generation,boundary),
      jsonb_build_object('schemaVersion',1,'credentialGeneration',target.credential_generation,'reason','scheduled_freshness',
        'scheduleBoundary',boundary,'window',jsonb_build_object('dateFrom',window_start,'dateTo',due_start+6),'timezone','Europe/Moscow'),
      p_now,500,20);
    UPDATE mc.financial_schedule_targets fst SET last_schedule_boundary=boundary,updated_at=clock_timestamp() WHERE fst.store_id=target.store_id;
    store_id:=target.store_id;credential_generation:=target.credential_generation;schedule_boundary:=boundary;job_id:=queued.id;
    RETURN NEXT;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION mc.schedule_financial_inventory(timestamptz,integer) FROM PUBLIC;

CREATE FUNCTION mc.refresh_financial_target_store_status()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mc AS $$
BEGIN
  UPDATE mc.financial_schedule_targets SET store_status=NEW.status,updated_at=clock_timestamp()
   WHERE business_id=NEW.business_id AND store_id=NEW.id;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION mc.refresh_financial_target_store_status() FROM PUBLIC;
CREATE TRIGGER store_financial_schedule_eligibility AFTER UPDATE OF status ON mc.stores
FOR EACH ROW EXECUTE FUNCTION mc.refresh_financial_target_store_status();

CREATE FUNCTION mc.refresh_financial_target_connection_status()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mc AS $$
BEGIN
  UPDATE mc.financial_schedule_targets SET connection_status=NEW.status,finance_enabled=NEW.scopes ? 'finance',
    credential_generation=greatest(credential_generation,NEW.credential_generation),updated_at=clock_timestamp()
   WHERE business_id=NEW.business_id AND store_id=NEW.store_id;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION mc.refresh_financial_target_connection_status() FROM PUBLIC;
CREATE TRIGGER connection_financial_schedule_eligibility AFTER UPDATE OF status,scopes,credential_generation ON mc.connections
FOR EACH ROW EXECUTE FUNCTION mc.refresh_financial_target_connection_status();

CREATE FUNCTION mc.list_financial_credential_backfill(p_limit integer DEFAULT 100)
RETURNS TABLE(connection_id uuid,user_id uuid,store_id uuid,seller_id text,scopes jsonb,ciphertext bytea,nonce bytea,auth_tag bytea,key_version text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mc AS $$
#variable_conflict use_column
DECLARE target mc.financial_credential_backfill_targets; actor uuid;
BEGIN
  FOR target IN SELECT * FROM mc.financial_credential_backfill_targets t WHERE t.next_attempt_at<=clock_timestamp() ORDER BY t.created_at,t.connection_id
    LIMIT greatest(1,least(coalesce(p_limit,100),500))
  LOOP
    PERFORM set_config('app.business_id',target.business_id::text,true);
    PERFORM set_config('app.user_id','',true);
    SELECT m.user_id INTO actor FROM mc.memberships m WHERE m.business_id=target.business_id AND m.role IN ('owner','editor')
      ORDER BY CASE m.role WHEN 'owner' THEN 0 ELSE 1 END,m.created_at,m.user_id LIMIT 1;
    IF actor IS NULL THEN CONTINUE; END IF;
    PERFORM set_config('app.user_id',actor::text,true);
    RETURN QUERY SELECT target.connection_id,actor,c.store_id,s.external_account_id,c.scopes,cs.ciphertext,cs.nonce,cs.auth_tag,cs.key_version
      FROM mc.connections c JOIN mc.stores s ON s.business_id=c.business_id AND s.id=c.store_id
      JOIN mc.connection_secrets cs ON cs.business_id=c.business_id AND cs.connection_id=c.id
     WHERE c.id=target.connection_id AND c.business_id=target.business_id AND c.credential_generation=0
       AND c.status='active' AND s.status='active';
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION mc.list_financial_credential_backfill(integer) FROM PUBLIC;

CREATE FUNCTION mc.defer_financial_credential_backfill(p_connection_id uuid,p_delay_seconds integer DEFAULT 900)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mc AS $$
BEGIN
  IF p_delay_seconds IS NULL OR p_delay_seconds NOT BETWEEN 60 AND 86400 THEN RAISE EXCEPTION 'invalid backfill delay'; END IF;
  UPDATE mc.financial_credential_backfill_targets SET attempt_count=attempt_count+1,
    next_attempt_at=clock_timestamp()+make_interval(secs=>p_delay_seconds) WHERE connection_id=p_connection_id;
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION mc.defer_financial_credential_backfill(uuid,integer) FROM PUBLIC;

CREATE FUNCTION mc.get_financial_inventory_context(p_job_id uuid,p_generation bigint,p_lease_token uuid,p_worker_id text)
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

CREATE FUNCTION mc.apply_financial_inventory(p_job_id uuid,p_generation bigint,p_lease_token uuid,p_worker_id text,p_rows jsonb)
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

CREATE FUNCTION mc.apply_financial_period_fallback(p_job_id uuid,p_generation bigint,p_lease_token uuid,p_worker_id text)
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

INSERT INTO mc.schema_migrations(version) VALUES(36);
COMMIT;
