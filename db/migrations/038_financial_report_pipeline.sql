BEGIN;

ALTER TABLE mc.report_versions ADD COLUMN supersedes_version_id uuid;
ALTER TABLE mc.report_versions ADD CONSTRAINT report_version_supersedes_fk
  FOREIGN KEY (business_id,store_id,report_id,supersedes_version_id)
  REFERENCES mc.report_versions(business_id,store_id,report_id,id);

ALTER TABLE mc.financial_week_inventory DROP CONSTRAINT financial_week_inventory_fetch_status_check;
ALTER TABLE mc.financial_week_inventory
  ADD COLUMN summary_raw_data jsonb,
  ADD COLUMN report_version_id uuid,
  ADD COLUMN accepted_normalization_id uuid,
  ADD COLUMN accepted_inventory_checksum text,
  ADD COLUMN accepted_at timestamptz,
  ADD COLUMN last_error_code text,
  ADD CONSTRAINT financial_week_inventory_fetch_status_check
    CHECK (fetch_status IN ('pending','fetching','received','normalizing','accepted','retry','failed')),
  ADD CONSTRAINT financial_week_inventory_error_code_check
    CHECK (last_error_code IS NULL OR last_error_code ~ '^[a-z0-9][a-z0-9_.:-]{0,99}$'),
  ADD CONSTRAINT financial_week_inventory_version_fk
    FOREIGN KEY (business_id,store_id,report_version_id)
    REFERENCES mc.report_versions(business_id,store_id,id),
  ADD CONSTRAINT financial_week_inventory_normalization_fk
    FOREIGN KEY (business_id,store_id,accepted_normalization_id)
    REFERENCES mc.report_normalizations(business_id,store_id,id);

ALTER TABLE mc.report_normalizations
  ADD CONSTRAINT report_normalizations_version_identity UNIQUE (business_id,store_id,report_version_id,id);
ALTER TABLE mc.financial_week_inventory
  ADD CONSTRAINT financial_week_inventory_normalized_version_fk
  FOREIGN KEY (business_id,store_id,report_version_id,accepted_normalization_id)
  REFERENCES mc.report_normalizations(business_id,store_id,report_version_id,id);

-- Rows marked accepted by the stage-2 placeholder had no immutable report
-- evidence. Fail closed and let the next inventory pass fetch them again.
ALTER TABLE mc.financial_week_inventory NO FORCE ROW LEVEL SECURITY;
UPDATE mc.financial_week_inventory
   SET fetch_status='pending',last_error_code='financial_acceptance_evidence_missing'
 WHERE fetch_status='accepted';
ALTER TABLE mc.financial_week_inventory FORCE ROW LEVEL SECURITY;

ALTER TABLE mc.financial_week_inventory ADD CONSTRAINT financial_week_inventory_acceptance_check CHECK (
  (fetch_status='accepted') =
    (report_version_id IS NOT NULL AND accepted_normalization_id IS NOT NULL
     AND accepted_inventory_checksum=inventory_checksum AND accepted_at IS NOT NULL)
);

CREATE FUNCTION mc.guard_financial_inventory_acceptance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- An explicit list refresh is evidence that detail freshness must be checked
  -- again even when WB kept the same summary checksum.
  IF TG_OP='UPDATE' AND NEW.fetch_status='accepted'
     AND NEW.last_seen_at IS DISTINCT FROM OLD.last_seen_at
     AND NEW.accepted_at IS NOT DISTINCT FROM OLD.accepted_at THEN
    NEW.fetch_status:='pending';
  END IF;
  IF NEW.fetch_status<>'accepted' THEN
    NEW.accepted_normalization_id:=NULL;
    NEW.accepted_inventory_checksum:=NULL;
    NEW.accepted_at:=NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER financial_inventory_acceptance_guard
  BEFORE INSERT OR UPDATE ON mc.financial_week_inventory
  FOR EACH ROW EXECUTE FUNCTION mc.guard_financial_inventory_acceptance();

-- The list method being unavailable for the seller's registration country
-- does not prove that the separate detail-by-id method is unavailable.
ALTER TABLE mc.financial_report_capabilities NO FORCE ROW LEVEL SECURITY;
UPDATE mc.financial_report_capabilities
   SET detail_by_id_api='unknown'
 WHERE list_api='unsupported_country' AND detail_by_id_api='unsupported_country';
ALTER TABLE mc.financial_report_capabilities FORCE ROW LEVEL SECURITY;
CREATE FUNCTION mc.guard_financial_capability_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.list_api='unsupported_country' AND NEW.reason_code='unsupported_registration_country' THEN
    NEW.detail_by_id_api:=OLD.detail_by_id_api;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER financial_capability_evidence_guard
  BEFORE UPDATE ON mc.financial_report_capabilities
  FOR EACH ROW EXECUTE FUNCTION mc.guard_financial_capability_evidence();

CREATE TABLE mc.financial_store_event_state (
  business_id uuid NOT NULL,
  store_id uuid NOT NULL,
  next_generation bigint NOT NULL DEFAULT 1 CHECK (next_generation>0),
  PRIMARY KEY (business_id,store_id),
  FOREIGN KEY (business_id,store_id) REFERENCES mc.stores(business_id,id)
);

CREATE TABLE mc.financial_input_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  store_id uuid NOT NULL,
  event_generation bigint NOT NULL CHECK (event_generation>0),
  event_key text NOT NULL CHECK (length(event_key) BETWEEN 1 AND 200),
  event_type text NOT NULL CHECK (event_type IN ('report_accepted','report_updated')),
  affected_from date NOT NULL,
  affected_to date NOT NULL,
  source_report_version_id uuid NOT NULL,
  source_normalization_id uuid NOT NULL,
  allows_wb_api boolean NOT NULL DEFAULT false CHECK (allows_wb_api=false),
  dispatch_job_id uuid NOT NULL REFERENCES mc.jobs(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id,store_id,event_generation),
  UNIQUE (business_id,event_key),
  UNIQUE (business_id,store_id,id),
  FOREIGN KEY (business_id,store_id) REFERENCES mc.stores(business_id,id),
  FOREIGN KEY (business_id,store_id,source_report_version_id)
    REFERENCES mc.report_versions(business_id,store_id,id),
  FOREIGN KEY (business_id,store_id,source_normalization_id)
    REFERENCES mc.report_normalizations(business_id,store_id,id),
  CHECK (affected_to>=affected_from)
);
CREATE INDEX financial_input_events_store_generation
  ON mc.financial_input_events(business_id,store_id,event_generation);

ALTER TABLE mc.financial_store_event_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE mc.financial_store_event_state FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mc.financial_store_event_state
  USING (business_id=mc.context_business_id()) WITH CHECK (business_id=mc.context_business_id());
ALTER TABLE mc.financial_input_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE mc.financial_input_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mc.financial_input_events
  USING (business_id=mc.context_business_id()) WITH CHECK (business_id=mc.context_business_id());

CREATE TRIGGER financial_input_events_no_update BEFORE UPDATE OR DELETE ON mc.financial_input_events
  FOR EACH ROW EXECUTE FUNCTION mc.reject_mutation();

CREATE FUNCTION mc.establish_financial_pipeline_context(
  p_job_id uuid,p_generation bigint,p_lease_token uuid,p_worker_id text,p_job_type text
)
RETURNS TABLE(
  business_id uuid,store_id uuid,actor_user_id uuid,seller_id text,
  credential_generation bigint,ciphertext bytea,nonce bytea,auth_tag bytea,
  detail_by_id_api text,fallback_mode text,payload jsonb
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mc AS $$
#variable_conflict use_column
DECLARE target mc.job_dispatch; target_job mc.jobs; actor uuid;
BEGIN
  IF p_job_type NOT IN ('financial_report_fetch','financial_report_normalize') THEN
    RAISE EXCEPTION 'unsupported financial pipeline job type';
  END IF;
  SELECT d.* INTO target FROM mc.job_dispatch d
   WHERE d.job_id=p_job_id AND d.job_type=p_job_type AND d.status='running'
     AND d.lease_until>clock_timestamp();
  IF NOT FOUND THEN RAISE EXCEPTION 'running financial pipeline job is required'; END IF;
  PERFORM set_config('app.business_id',target.business_id::text,true);
  PERFORM set_config('app.user_id','',true);
  SELECT * INTO target_job FROM mc.jobs j
   WHERE j.id=p_job_id AND j.status='running' AND j.lease_token=p_lease_token
     AND j.worker_id=p_worker_id AND j.lease_until>clock_timestamp();
  IF NOT FOUND THEN RAISE EXCEPTION 'running financial pipeline job is required'; END IF;
  IF p_generation IS NOT NULL AND coalesce((target_job.payload->>'credentialGeneration')::bigint,0)<>p_generation THEN
    RAISE EXCEPTION 'financial pipeline generation mismatch';
  END IF;
  SELECT m.user_id INTO actor FROM mc.memberships m
   WHERE m.business_id=target.business_id AND m.role IN ('owner','editor')
   ORDER BY CASE m.role WHEN 'owner' THEN 0 ELSE 1 END,m.created_at,m.user_id LIMIT 1;
  IF actor IS NULL THEN RETURN; END IF;
  PERFORM set_config('app.user_id',actor::text,true);
  RETURN QUERY
  SELECT c.business_id,c.store_id,actor,s.external_account_id,c.credential_generation,
         cs.ciphertext,cs.nonce,cs.auth_tag,coalesce(cap.detail_by_id_api,'unknown'),cap.fallback_mode,target_job.payload
    FROM mc.connections c
    JOIN mc.stores s ON s.business_id=c.business_id AND s.id=c.store_id
    JOIN mc.connection_secrets cs ON cs.business_id=c.business_id AND cs.connection_id=c.id
    LEFT JOIN mc.financial_report_capabilities cap ON cap.business_id=c.business_id
      AND cap.connection_id=c.id AND cap.credential_generation=c.credential_generation
   WHERE c.business_id=target.business_id AND c.store_id=target_job.store_id
     AND c.status='active' AND s.status='active'
     AND c.credential_generation=coalesce(p_generation,(target_job.payload->>'credentialGeneration')::bigint);
END $$;
REVOKE ALL ON FUNCTION mc.establish_financial_pipeline_context(uuid,bigint,uuid,text,text) FROM PUBLIC;

CREATE FUNCTION mc.fallback_financial_detail_to_period(
  p_job_id uuid,p_generation bigint,p_lease_token uuid,p_worker_id text
)
RETURNS TABLE(job_id uuid,superseded boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mc AS $$
#variable_conflict use_column
DECLARE context record; queued mc.jobs; coverage uuid; period_start date; period_end date;
BEGIN
  SELECT * INTO context FROM mc.establish_financial_pipeline_context(
    p_job_id,p_generation,p_lease_token,p_worker_id,'financial_report_fetch');
  IF context.business_id IS NULL THEN RETURN QUERY SELECT NULL::uuid,true; RETURN; END IF;
  IF context.payload->>'mode'<>'by_report_id' THEN RAISE EXCEPTION 'by-report job is required'; END IF;
  coverage:=(context.payload->>'coverageId')::uuid;
  period_start:=(context.payload->>'periodStart')::date;
  period_end:=(context.payload->>'periodEnd')::date;
  UPDATE mc.financial_report_capabilities cap
     SET detail_by_id_api='unsupported_country',fallback_mode='period',
         reason_code='unsupported_registration_country',observed_at=clock_timestamp()
    FROM mc.connections c WHERE c.business_id=context.business_id AND c.store_id=context.store_id
      AND cap.business_id=c.business_id AND cap.connection_id=c.id AND cap.credential_generation=p_generation;
  SELECT * INTO queued FROM mc.enqueue_job(context.store_id,'financial_report_fetch',
    format('financial-report-fetch:%s:g%s:period:%s',context.store_id,p_generation,coverage),
    jsonb_build_object('schemaVersion',1,'credentialGeneration',p_generation,'coverageId',coverage,
      'mode','period','periodStart',period_start,'periodEnd',period_end),clock_timestamp(),300,20);
  RETURN QUERY SELECT queued.id,false;
END $$;
REVOKE ALL ON FUNCTION mc.fallback_financial_detail_to_period(uuid,bigint,uuid,text) FROM PUBLIC;

INSERT INTO mc.schema_migrations(version) VALUES(38);
COMMIT;
