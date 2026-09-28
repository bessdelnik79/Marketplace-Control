BEGIN;

ALTER TABLE mc.financial_daily_days
  ADD CONSTRAINT financial_daily_days_tenant_generation_date
  UNIQUE (business_id,store_id,generation_id,accounting_date);

CREATE TABLE mc.financial_daily_publications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  store_id uuid NOT NULL,
  publication_no bigint NOT NULL CHECK (publication_no>0),
  generation_id uuid NOT NULL,
  prior_publication_id uuid,
  affected_from date NOT NULL CHECK (isfinite(affected_from)),
  affected_to date NOT NULL CHECK (isfinite(affected_to)),
  source_event_generation bigint NOT NULL CHECK (source_event_generation>0),
  watermark_generation bigint NOT NULL CHECK (watermark_generation>=source_event_generation),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (business_id,store_id,id),
  UNIQUE (business_id,store_id,publication_no),
  UNIQUE (generation_id),
  FOREIGN KEY (business_id,store_id) REFERENCES mc.stores(business_id,id),
  FOREIGN KEY (business_id,store_id,generation_id)
    REFERENCES mc.financial_daily_generations(business_id,store_id,id),
  FOREIGN KEY (business_id,store_id,prior_publication_id)
    REFERENCES mc.financial_daily_publications(business_id,store_id,id),
  CHECK (affected_to>=affected_from),
  CHECK ((publication_no=1 AND prior_publication_id IS NULL)
    OR (publication_no>1 AND prior_publication_id IS NOT NULL))
);

CREATE TABLE mc.financial_daily_publication_days (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  store_id uuid NOT NULL,
  publication_id uuid NOT NULL,
  accounting_date date NOT NULL CHECK (isfinite(accounting_date)),
  generation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (business_id,store_id,id),
  UNIQUE (publication_id,accounting_date),
  FOREIGN KEY (business_id,store_id,publication_id)
    REFERENCES mc.financial_daily_publications(business_id,store_id,id),
  FOREIGN KEY (business_id,store_id,generation_id,accounting_date)
    REFERENCES mc.financial_daily_days(business_id,store_id,generation_id,accounting_date)
);

CREATE TABLE mc.financial_daily_current_publications (
  business_id uuid NOT NULL,
  store_id uuid NOT NULL,
  publication_id uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (business_id,store_id),
  UNIQUE (business_id,store_id,publication_id),
  FOREIGN KEY (business_id,store_id) REFERENCES mc.stores(business_id,id),
  FOREIGN KEY (business_id,store_id,publication_id)
    REFERENCES mc.financial_daily_publications(business_id,store_id,id)
);

CREATE FUNCTION mc.guard_financial_daily_publication() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(
    SELECT 1 FROM mc.financial_daily_generations generation
     WHERE generation.id=NEW.generation_id AND generation.business_id=NEW.business_id
       AND generation.store_id=NEW.store_id AND generation.status='succeeded'
       AND generation.affected_from=NEW.affected_from AND generation.affected_to=NEW.affected_to
       AND generation.source_event_generation=NEW.source_event_generation
       AND generation.watermark_generation=NEW.watermark_generation
  ) THEN RAISE EXCEPTION 'only a succeeded financial daily generation may be published' USING ERRCODE='23514'; END IF;
  IF NEW.prior_publication_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM mc.financial_daily_publications prior
     WHERE prior.id=NEW.prior_publication_id AND prior.business_id=NEW.business_id
       AND prior.store_id=NEW.store_id AND prior.publication_no=NEW.publication_no-1
  ) THEN RAISE EXCEPTION 'financial daily publication predecessor is invalid' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER financial_daily_publication_guard BEFORE INSERT ON mc.financial_daily_publications
  FOR EACH ROW EXECUTE FUNCTION mc.guard_financial_daily_publication();

CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON mc.financial_daily_publications
  FOR EACH ROW EXECUTE FUNCTION mc.reject_mutation();
CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON mc.financial_daily_publication_days
  FOR EACH ROW EXECUTE FUNCTION mc.reject_mutation();

CREATE FUNCTION mc.guard_financial_daily_current_publication() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(
    SELECT 1 FROM mc.financial_daily_publications publication
    JOIN mc.financial_daily_generations generation ON generation.id=publication.generation_id
      AND generation.business_id=publication.business_id AND generation.store_id=publication.store_id
    JOIN mc.financial_store_event_state state ON state.business_id=publication.business_id
      AND state.store_id=publication.store_id
    WHERE publication.id=NEW.publication_id AND publication.business_id=NEW.business_id
      AND publication.store_id=NEW.store_id AND generation.status='succeeded'
      AND generation.watermark_generation=state.next_generation-1
      AND publication.publication_no=(SELECT max(candidate.publication_no)
        FROM mc.financial_daily_publications candidate
        WHERE candidate.business_id=publication.business_id AND candidate.store_id=publication.store_id)
      AND NOT EXISTS(
        SELECT 1 FROM mc.financial_daily_days source_day
         WHERE source_day.generation_id=generation.id
           AND NOT EXISTS(SELECT 1 FROM mc.financial_daily_publication_days mapped_day
             WHERE mapped_day.publication_id=publication.id
               AND mapped_day.accounting_date=source_day.accounting_date
               AND mapped_day.generation_id=generation.id)
      )
      AND NOT EXISTS(
        SELECT 1 FROM mc.financial_daily_publication_days mapped_day
         WHERE mapped_day.publication_id=publication.id
           AND mapped_day.accounting_date BETWEEN generation.affected_from AND generation.affected_to
           AND mapped_day.generation_id<>generation.id
      )
      AND (publication.prior_publication_id IS NULL OR NOT EXISTS(
        SELECT 1 FROM mc.financial_daily_publication_days prior_day
         WHERE prior_day.publication_id=publication.prior_publication_id
           AND (prior_day.accounting_date<generation.affected_from OR prior_day.accounting_date>generation.affected_to)
           AND NOT EXISTS(SELECT 1 FROM mc.financial_daily_publication_days mapped_day
             WHERE mapped_day.publication_id=publication.id
               AND mapped_day.accounting_date=prior_day.accounting_date
               AND mapped_day.generation_id=prior_day.generation_id)
      ))
  ) THEN RAISE EXCEPTION 'financial daily current publication is incomplete' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER current_publication_guard BEFORE INSERT OR UPDATE OF publication_id ON mc.financial_daily_current_publications
  FOR EACH ROW EXECUTE FUNCTION mc.guard_financial_daily_current_publication();
CREATE TRIGGER current_publication_no_delete BEFORE DELETE ON mc.financial_daily_current_publications
  FOR EACH ROW EXECUTE FUNCTION mc.reject_mutation();
CREATE TRIGGER current_publication_identity BEFORE UPDATE ON mc.financial_daily_current_publications
  FOR EACH ROW EXECUTE FUNCTION mc.protect_columns('business_id','store_id');

DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'financial_daily_publications','financial_daily_publication_days','financial_daily_current_publications'
  ] LOOP
    EXECUTE format('ALTER TABLE mc.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE mc.%I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON mc.%I USING (business_id=mc.context_business_id()) WITH CHECK (business_id=mc.context_business_id())',table_name);
  END LOOP;
END $$;

CREATE FUNCTION mc.publish_financial_daily_generation(
  p_job_id uuid,p_lease_token uuid,p_worker_id text,p_generation_id uuid,p_expected_event_generation bigint
) RETURNS mc.financial_daily_publications
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mc AS $$
#variable_conflict use_column
DECLARE
  context record;
  generation mc.financial_daily_generations;
  existing mc.financial_daily_publications;
  prior mc.financial_daily_publications;
  published mc.financial_daily_publications;
  current_watermark bigint;
  next_publication_no bigint;
BEGIN
  SELECT * INTO context FROM mc.establish_financial_daily_context(p_job_id,p_lease_token,p_worker_id);
  SELECT * INTO generation FROM mc.financial_daily_generations
   WHERE id=p_generation_id AND business_id=context.business_id AND store_id=context.store_id
     AND job_id=p_job_id AND source_event_generation=p_expected_event_generation FOR UPDATE;
  IF NOT FOUND OR generation.status<>'succeeded' THEN
    RAISE EXCEPTION 'financial_daily_publication_generation_not_succeeded';
  END IF;

  SELECT * INTO existing FROM mc.financial_daily_publications publication
   WHERE publication.generation_id=generation.id;
  IF FOUND THEN RETURN existing; END IF;

  SELECT state.next_generation-1 INTO current_watermark FROM mc.financial_store_event_state state
   WHERE state.business_id=context.business_id AND state.store_id=context.store_id FOR UPDATE;
  IF current_watermark IS DISTINCT FROM generation.watermark_generation
     OR context.watermark_generation IS DISTINCT FROM generation.watermark_generation THEN
    RAISE EXCEPTION 'financial_daily_publication_watermark_stale';
  END IF;

  SELECT publication.* INTO prior
    FROM mc.financial_daily_current_publications pointer
    JOIN mc.financial_daily_publications publication
      ON publication.id=pointer.publication_id AND publication.business_id=pointer.business_id
     AND publication.store_id=pointer.store_id
   WHERE pointer.business_id=context.business_id AND pointer.store_id=context.store_id FOR UPDATE OF pointer;

  IF prior.id IS NULL THEN
    IF NOT EXISTS(SELECT 1 FROM mc.method_versions method
      WHERE method.id=generation.result_method_version_id AND method.code='financial_result'
        AND method.version_no=20 AND method.implementation_version='financial-result-v20')
      OR NOT EXISTS(
        SELECT 1 FROM mc.financial_daily_shadow_comparisons comparison
        JOIN mc.calculation_runs legacy_run ON legacy_run.id=comparison.legacy_run_id
        JOIN mc.method_versions legacy_method ON legacy_method.id=legacy_run.method_version_id
        WHERE comparison.generation_id=generation.id AND comparison.status='matched'
          AND legacy_method.code='financial_result' AND legacy_method.version_no=20
          AND legacy_method.implementation_version='financial-result-v20' AND legacy_run.request_id IS NOT NULL
          AND NOT EXISTS(
              (SELECT product.product_id FROM mc.financial_daily_generation_products product
                WHERE product.generation_id=generation.id AND product.selected)
              EXCEPT
              (SELECT request_product.product_id FROM mc.calculation_request_products request_product
                WHERE request_product.request_id=legacy_run.request_id)
            ) AND NOT EXISTS(
              (SELECT request_product.product_id FROM mc.calculation_request_products request_product
                WHERE request_product.request_id=legacy_run.request_id)
              EXCEPT
              (SELECT product.product_id FROM mc.financial_daily_generation_products product
                WHERE product.generation_id=generation.id AND product.selected)
            )
      ) THEN RAISE EXCEPTION 'financial_daily_publication_shadow_incompatible'; END IF;
    IF EXISTS(
      SELECT 1 FROM mc.financial_daily_days source_day
       WHERE source_day.generation_id=generation.id
         AND NOT EXISTS(
           SELECT 1 FROM mc.financial_daily_shadow_comparisons comparison
           JOIN mc.calculation_runs legacy_run ON legacy_run.id=comparison.legacy_run_id
           JOIN mc.method_versions legacy_method ON legacy_method.id=legacy_run.method_version_id
           WHERE comparison.generation_id=generation.id AND comparison.status='matched'
             AND source_day.accounting_date BETWEEN comparison.period_start AND comparison.period_end
             AND legacy_method.code='financial_result' AND legacy_method.version_no=20
             AND legacy_method.implementation_version='financial-result-v20' AND legacy_run.request_id IS NOT NULL
             AND NOT EXISTS(
               (SELECT product.product_id FROM mc.financial_daily_generation_products product
                 WHERE product.generation_id=generation.id AND product.selected)
               EXCEPT
               (SELECT request_product.product_id FROM mc.calculation_request_products request_product
                 WHERE request_product.request_id=legacy_run.request_id)
             ) AND NOT EXISTS(
               (SELECT request_product.product_id FROM mc.calculation_request_products request_product
                 WHERE request_product.request_id=legacy_run.request_id)
               EXCEPT
               (SELECT product.product_id FROM mc.financial_daily_generation_products product
                 WHERE product.generation_id=generation.id AND product.selected)
             )
         )
    ) THEN RAISE EXCEPTION 'financial_daily_publication_shadow_incompatible'; END IF;
  ELSE
    IF EXISTS(
      SELECT 1
        FROM mc.financial_daily_publication_days prior_day
        JOIN mc.financial_daily_generations prior_generation ON prior_generation.id=prior_day.generation_id
       WHERE prior_day.publication_id=prior.id
         AND (prior_day.accounting_date<generation.affected_from OR prior_day.accounting_date>generation.affected_to)
         AND (prior_generation.parser_method_version_id<>generation.parser_method_version_id
           OR prior_generation.result_method_version_id<>generation.result_method_version_id
           OR EXISTS(
             (SELECT product.product_id FROM mc.financial_daily_generation_products product
               WHERE product.generation_id=prior_generation.id AND product.selected)
             EXCEPT
             (SELECT product.product_id FROM mc.financial_daily_generation_products product
               WHERE product.generation_id=generation.id AND product.selected)
           ) OR EXISTS(
             (SELECT product.product_id FROM mc.financial_daily_generation_products product
               WHERE product.generation_id=generation.id AND product.selected)
             EXCEPT
             (SELECT product.product_id FROM mc.financial_daily_generation_products product
               WHERE product.generation_id=prior_generation.id AND product.selected)
           ))
    ) THEN RAISE EXCEPTION 'financial_daily_publication_scope_incompatible'; END IF;
  END IF;

  next_publication_no:=coalesce(prior.publication_no,0)+1;
  INSERT INTO mc.financial_daily_publications(
    business_id,store_id,publication_no,generation_id,prior_publication_id,
    affected_from,affected_to,source_event_generation,watermark_generation
  ) VALUES(
    generation.business_id,generation.store_id,next_publication_no,generation.id,prior.id,
    generation.affected_from,generation.affected_to,generation.source_event_generation,generation.watermark_generation
  ) RETURNING * INTO published;

  IF prior.id IS NOT NULL THEN
    INSERT INTO mc.financial_daily_publication_days(
      business_id,store_id,publication_id,accounting_date,generation_id
    ) SELECT day.business_id,day.store_id,published.id,day.accounting_date,day.generation_id
        FROM mc.financial_daily_publication_days day
       WHERE day.publication_id=prior.id
         AND (day.accounting_date<generation.affected_from OR day.accounting_date>generation.affected_to);
  END IF;
  INSERT INTO mc.financial_daily_publication_days(
    business_id,store_id,publication_id,accounting_date,generation_id
  ) SELECT day.business_id,day.store_id,published.id,day.accounting_date,day.generation_id
      FROM mc.financial_daily_days day WHERE day.generation_id=generation.id ORDER BY day.accounting_date;

  INSERT INTO mc.financial_daily_current_publications(business_id,store_id,publication_id)
  VALUES(generation.business_id,generation.store_id,published.id)
  ON CONFLICT(business_id,store_id) DO UPDATE
    SET publication_id=EXCLUDED.publication_id,updated_at=clock_timestamp();
  RETURN published;
END $$;
REVOKE ALL ON FUNCTION mc.publish_financial_daily_generation(uuid,uuid,text,uuid,bigint) FROM PUBLIC;

CREATE FUNCTION mc.retry_financial_daily_job(p_store_id uuid,p_period_start date,p_period_end date)
RETURNS mc.jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mc AS $$
DECLARE
  context_business uuid:=mc.context_business_id();
  context_user uuid:=mc.context_user_id();
  retried mc.jobs;
  previous_attempt_count integer;
BEGIN
  IF context_business IS NULL OR context_user IS NULL OR NOT EXISTS(
    SELECT 1 FROM mc.memberships membership
     WHERE membership.business_id=context_business AND membership.user_id=context_user
       AND membership.role IN ('owner','editor')
  ) THEN RAISE EXCEPTION 'owned business context is required'; END IF;
  IF p_period_start IS NULL OR p_period_end IS NULL OR NOT isfinite(p_period_start)
     OR NOT isfinite(p_period_end) OR p_period_end<p_period_start OR p_period_end-p_period_start>365 THEN
    RAISE EXCEPTION 'financial daily retry period is invalid';
  END IF;
  SELECT job.* INTO retried FROM mc.jobs job
   WHERE job.business_id=context_business AND job.store_id=p_store_id
     AND job.job_type='financial_dates_recalculate' AND job.status='failed'
     AND job.payload->>'allowsWbApi'='false'
     AND (job.payload->>'affectedFrom')::date<=p_period_end
     AND (job.payload->>'affectedTo')::date>=p_period_start
   ORDER BY job.created_at DESC,job.id DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'financial_daily_retry_unavailable'; END IF;
  previous_attempt_count:=retried.attempt_count;
  UPDATE mc.jobs SET status='pending',available_at=clock_timestamp(),worker_id=NULL,lease_token=NULL,
    lease_until=NULL,heartbeat_at=NULL,finished_at=NULL,last_error=NULL,last_error_code=NULL,outcome=NULL,
    attempt_count=0,updated_at=clock_timestamp()
   WHERE id=retried.id RETURNING * INTO retried;
  INSERT INTO mc.job_dispatch(job_id,business_id,job_type,priority,available_at,status,attempt_count,max_attempts,created_at)
  VALUES(retried.id,retried.business_id,retried.job_type,retried.priority,retried.available_at,'pending',
    retried.attempt_count,retried.max_attempts,retried.created_at);
  INSERT INTO mc.audit_events(business_id,store_id,actor_user_id,action,entity_type,entity_id,safe_details)
  VALUES(retried.business_id,retried.store_id,context_user,'financial_daily_job_retried','jobs',retried.id,
    jsonb_build_object('periodStart',p_period_start,'periodEnd',p_period_end,'previousAttemptCount',previous_attempt_count));
  RETURN retried;
END $$;
REVOKE ALL ON FUNCTION mc.retry_financial_daily_job(uuid,date,date) FROM PUBLIC;

CREATE INDEX financial_daily_publication_days_generation
  ON mc.financial_daily_publication_days(generation_id,accounting_date);

-- Stage-4 backfill jobs may already be terminal by the time the publication
-- pointer exists. Emit one fresh, uniquely keyed event so every store with
-- persisted financial history gets a deterministic cutover attempt.
ALTER TABLE mc.financial_input_events NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.memberships NO FORCE ROW LEVEL SECURITY;
DO $$
DECLARE
  target record;
  prior_business text:=current_setting('app.business_id',true);
  prior_user text:=current_setting('app.user_id',true);
BEGIN
  FOR target IN
    SELECT event.business_id,event.store_id,min(event.affected_from) affected_from,
           max(event.affected_to) affected_to,method.id method_version_id,
           (SELECT membership.user_id FROM mc.memberships membership
             WHERE membership.business_id=event.business_id AND membership.role IN ('owner','editor')
             ORDER BY CASE membership.role WHEN 'owner' THEN 0 ELSE 1 END,membership.created_at,membership.user_id LIMIT 1) actor_user_id
      FROM mc.financial_input_events event
      CROSS JOIN mc.method_versions method
     WHERE method.code='financial_result' AND method.version_no=20
     GROUP BY event.business_id,event.store_id,method.id
  LOOP
    IF target.actor_user_id IS NULL THEN CONTINUE; END IF;
    PERFORM set_config('app.business_id',target.business_id::text,true);
    PERFORM set_config('app.user_id',target.actor_user_id::text,true);
    PERFORM mc.emit_financial_input_event(target.store_id,
      'daily-publication-cutover:v1:store:'||target.store_id,'shadow_backfill',
      target.affected_from,target.affected_to,p_source_result_method_version_id=>target.method_version_id);
  END LOOP;
  PERFORM set_config('app.business_id',coalesce(prior_business,''),true);
  PERFORM set_config('app.user_id',coalesce(prior_user,''),true);
END $$;
ALTER TABLE mc.financial_input_events FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.memberships FORCE ROW LEVEL SECURITY;

INSERT INTO mc.schema_migrations(version) VALUES(40);
COMMIT;
