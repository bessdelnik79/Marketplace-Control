BEGIN;

-- Keep the exact inventory job that proved an empty week in every immutable
-- calculation provenance row. Composite keys prevent cross-tenant evidence.
ALTER TABLE mc.financial_week_coverage
  ADD CONSTRAINT financial_week_coverage_tenant_identity UNIQUE (business_id,store_id,id),
  ADD CONSTRAINT financial_week_coverage_empty_job_tenant_fk
    FOREIGN KEY (business_id,store_id,empty_confirmed_by_job_id)
    REFERENCES mc.jobs(business_id,store_id,id);

ALTER TABLE mc.financial_input_events
  ADD COLUMN source_financial_week_coverage_id uuid,
  ADD COLUMN source_empty_confirmation_job_id uuid,
  DROP CONSTRAINT financial_input_events_event_type_check,
  DROP CONSTRAINT financial_input_events_source_shape,
  ADD CONSTRAINT financial_input_events_event_type_check CHECK (event_type IN (
    'report_accepted','report_updated','report_empty_confirmed','cost_updated','expense_updated','tax_updated',
    'selection_updated','parser_method_updated','result_method_updated','shadow_backfill'
  )),
  ADD CONSTRAINT financial_input_events_empty_coverage_fk
    FOREIGN KEY (business_id,store_id,source_financial_week_coverage_id)
    REFERENCES mc.financial_week_coverage(business_id,store_id,id),
  ADD CONSTRAINT financial_input_events_empty_job_fk
    FOREIGN KEY (business_id,store_id,source_empty_confirmation_job_id)
    REFERENCES mc.jobs(business_id,store_id,id),
  ADD CONSTRAINT financial_input_events_source_shape CHECK (
    (event_type IN ('report_accepted','report_updated')
      AND source_report_version_id IS NOT NULL AND source_normalization_id IS NOT NULL
      AND num_nonnulls(source_cost_version_id,source_expense_version_id,
        source_tax_setting_version_id,source_selection_id,source_parser_method_version_id,
        source_result_method_version_id,source_financial_week_coverage_id,
        source_empty_confirmation_job_id)=0)
    OR (event_type='report_empty_confirmed'
      AND source_financial_week_coverage_id IS NOT NULL AND source_empty_confirmation_job_id IS NOT NULL
      AND num_nonnulls(source_report_version_id,source_normalization_id,source_cost_version_id,
        source_expense_version_id,source_tax_setting_version_id,source_selection_id,
        source_parser_method_version_id,source_result_method_version_id)=0)
    OR (event_type='cost_updated' AND source_cost_version_id IS NOT NULL
      AND num_nonnulls(source_report_version_id,source_normalization_id,source_expense_version_id,
        source_tax_setting_version_id,source_selection_id,source_parser_method_version_id,
        source_result_method_version_id,source_financial_week_coverage_id,
        source_empty_confirmation_job_id)=0)
    OR (event_type='expense_updated' AND source_expense_version_id IS NOT NULL
      AND num_nonnulls(source_report_version_id,source_normalization_id,source_cost_version_id,
        source_tax_setting_version_id,source_selection_id,source_parser_method_version_id,
        source_result_method_version_id,source_financial_week_coverage_id,
        source_empty_confirmation_job_id)=0)
    OR (event_type='tax_updated' AND source_tax_setting_version_id IS NOT NULL
      AND num_nonnulls(source_report_version_id,source_normalization_id,source_cost_version_id,
        source_expense_version_id,source_selection_id,source_parser_method_version_id,
        source_result_method_version_id,source_financial_week_coverage_id,
        source_empty_confirmation_job_id)=0)
    OR (event_type='selection_updated' AND source_selection_id IS NOT NULL
      AND num_nonnulls(source_report_version_id,source_normalization_id,source_cost_version_id,
        source_expense_version_id,source_tax_setting_version_id,source_parser_method_version_id,
        source_result_method_version_id,source_financial_week_coverage_id,
        source_empty_confirmation_job_id)=0)
    OR (event_type='parser_method_updated' AND source_parser_method_version_id IS NOT NULL
      AND num_nonnulls(source_report_version_id,source_normalization_id,source_cost_version_id,
        source_expense_version_id,source_tax_setting_version_id,source_selection_id,
        source_result_method_version_id,source_financial_week_coverage_id,
        source_empty_confirmation_job_id)=0)
    OR (event_type IN ('result_method_updated','shadow_backfill') AND source_result_method_version_id IS NOT NULL
      AND num_nonnulls(source_report_version_id,source_normalization_id,source_cost_version_id,
        source_expense_version_id,source_tax_setting_version_id,source_selection_id,
        source_parser_method_version_id,source_financial_week_coverage_id,
        source_empty_confirmation_job_id)=0)
  );

ALTER TABLE mc.financial_daily_generation_inputs
  ADD COLUMN financial_week_coverage_id uuid,
  ADD COLUMN empty_confirmation_job_id uuid,
  DROP CONSTRAINT financial_daily_generation_inputs_source_kind_check,
  DROP CONSTRAINT financial_daily_generation_inputs_check,
  DROP CONSTRAINT financial_daily_generation_in_generation_id_source_kind_rep_key,
  ADD CONSTRAINT financial_daily_generation_inputs_source_kind_check
    CHECK (source_kind IN ('report','empty_week','cost','expense','tax','selection')),
  ADD CONSTRAINT financial_daily_generation_inputs_empty_coverage_fk
    FOREIGN KEY (business_id,store_id,financial_week_coverage_id)
    REFERENCES mc.financial_week_coverage(business_id,store_id,id),
  ADD CONSTRAINT financial_daily_generation_inputs_empty_job_fk
    FOREIGN KEY (business_id,store_id,empty_confirmation_job_id)
    REFERENCES mc.jobs(business_id,store_id,id),
  ADD CONSTRAINT financial_daily_generation_inputs_check CHECK (
    (source_kind='report' AND report_version_id IS NOT NULL AND report_normalization_id IS NOT NULL
      AND num_nonnulls(cost_version_id,expense_version_id,tax_setting_version_id,selection_id,
        financial_week_coverage_id,empty_confirmation_job_id)=0)
    OR (source_kind='empty_week' AND financial_week_coverage_id IS NOT NULL AND empty_confirmation_job_id IS NOT NULL
      AND num_nonnulls(report_version_id,report_normalization_id,cost_version_id,expense_version_id,
        tax_setting_version_id,selection_id)=0)
    OR (source_kind='cost' AND cost_version_id IS NOT NULL
      AND num_nonnulls(report_version_id,report_normalization_id,expense_version_id,
        tax_setting_version_id,selection_id,financial_week_coverage_id,empty_confirmation_job_id)=0)
    OR (source_kind='expense' AND expense_version_id IS NOT NULL
      AND num_nonnulls(report_version_id,report_normalization_id,cost_version_id,
        tax_setting_version_id,selection_id,financial_week_coverage_id,empty_confirmation_job_id)=0)
    OR (source_kind='tax' AND tax_setting_version_id IS NOT NULL
      AND num_nonnulls(report_version_id,report_normalization_id,cost_version_id,expense_version_id,
        selection_id,financial_week_coverage_id,empty_confirmation_job_id)=0)
    OR (source_kind='selection' AND selection_id IS NOT NULL
      AND num_nonnulls(report_version_id,report_normalization_id,cost_version_id,expense_version_id,
        tax_setting_version_id,financial_week_coverage_id,empty_confirmation_job_id)=0)
  ),
  ADD CONSTRAINT financial_daily_generation_inputs_source_unique
    UNIQUE NULLS NOT DISTINCT (
      generation_id,source_kind,report_version_id,report_normalization_id,cost_version_id,
      expense_version_id,tax_setting_version_id,selection_id,financial_week_coverage_id,
      empty_confirmation_job_id
    );

CREATE FUNCTION mc.financial_empty_week_evidence_valid(p_coverage_id uuid,p_confirmation_job_id uuid)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,mc AS $$
DECLARE
  evidence record;
  payload_generation bigint;
  payload_from date;
  payload_to date;
BEGIN
  SELECT coverage.credential_generation,coverage.week_start,coverage.week_end,
         coverage.coverage_status,coverage.inventory_confirmed_at,coverage.empty_confirmed_by_job_id,
         job.job_type,job.status,job.payload
    INTO evidence
    FROM mc.financial_week_coverage coverage
    JOIN mc.jobs job ON job.business_id=coverage.business_id AND job.store_id=coverage.store_id
      AND job.id=p_confirmation_job_id
   WHERE coverage.id=p_coverage_id;
  IF NOT FOUND OR evidence.coverage_status<>'empty' OR evidence.inventory_confirmed_at IS NULL
     OR evidence.empty_confirmed_by_job_id IS DISTINCT FROM p_confirmation_job_id
     OR evidence.job_type<>'financial_inventory_refresh' OR evidence.status NOT IN ('running','succeeded')
     OR jsonb_typeof(evidence.payload->'window') IS DISTINCT FROM 'object' THEN
    RETURN false;
  END IF;
  BEGIN
    payload_generation:=(evidence.payload->>'credentialGeneration')::bigint;
    payload_from:=(evidence.payload->'window'->>'dateFrom')::date;
    payload_to:=(evidence.payload->'window'->>'dateTo')::date;
  EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format
    OR datetime_field_overflow OR numeric_value_out_of_range THEN
    RETURN false;
  END;
  RETURN payload_generation=evidence.credential_generation
    AND payload_from<=evidence.week_start AND payload_to>=evidence.week_end
    AND NOT EXISTS(SELECT 1 FROM mc.financial_week_inventory inventory
      WHERE inventory.coverage_id=p_coverage_id);
END $$;
REVOKE ALL ON FUNCTION mc.financial_empty_week_evidence_valid(uuid,uuid) FROM PUBLIC;

CREATE FUNCTION mc.guard_financial_empty_week_event_source() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,mc AS $$
BEGIN
  IF NEW.event_type='report_empty_confirmed' AND NOT EXISTS(
    SELECT 1 FROM mc.financial_week_coverage coverage
     WHERE coverage.id=NEW.source_financial_week_coverage_id
       AND coverage.business_id=NEW.business_id
       AND coverage.store_id=NEW.store_id
       AND coverage.week_start=NEW.affected_from
       AND coverage.week_end=NEW.affected_to
       AND mc.financial_empty_week_evidence_valid(
         coverage.id,NEW.source_empty_confirmation_job_id)
  ) THEN
    RAISE EXCEPTION 'financial empty week event evidence is invalid' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER financial_empty_week_event_source_guard
  BEFORE INSERT ON mc.financial_input_events
  FOR EACH ROW EXECUTE FUNCTION mc.guard_financial_empty_week_event_source();

CREATE FUNCTION mc.guard_financial_empty_week_input() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,mc AS $$
BEGIN
  IF NEW.source_kind='empty_week' AND NOT EXISTS(
    SELECT 1
      FROM mc.financial_week_coverage coverage
      JOIN mc.financial_daily_generations generation
        ON generation.id=NEW.generation_id
       AND generation.business_id=NEW.business_id
       AND generation.store_id=NEW.store_id
     WHERE coverage.id=NEW.financial_week_coverage_id
       AND coverage.business_id=NEW.business_id
       AND coverage.store_id=NEW.store_id
       AND coverage.week_start<=generation.affected_to
       AND coverage.week_end>=generation.affected_from
       AND mc.financial_empty_week_evidence_valid(coverage.id,NEW.empty_confirmation_job_id)
  ) THEN
    RAISE EXCEPTION 'financial empty week evidence is invalid' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER financial_empty_week_input_guard
  BEFORE INSERT ON mc.financial_daily_generation_inputs
  FOR EACH ROW EXECUTE FUNCTION mc.guard_financial_empty_week_input();

CREATE OR REPLACE FUNCTION mc.financial_daily_shadow_day_compatible(
  p_generation_id uuid,p_accounting_date date
)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,mc AS $$
  SELECT EXISTS(
    SELECT 1 FROM mc.financial_daily_generations generation
    JOIN mc.method_versions generation_method ON generation_method.id=generation.result_method_version_id
    JOIN mc.financial_daily_shadow_comparisons comparison ON comparison.generation_id=generation.id
    JOIN mc.calculation_runs legacy_run ON legacy_run.id=comparison.legacy_run_id
    JOIN mc.method_versions legacy_method ON legacy_method.id=legacy_run.method_version_id
    WHERE generation.id=p_generation_id
      AND generation_method.code='financial_result' AND generation_method.version_no=20
      AND generation_method.implementation_version='financial-result-v20'
      AND comparison.status='matched' AND p_accounting_date BETWEEN comparison.period_start AND comparison.period_end
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
  ) OR EXISTS(
    SELECT 1
      FROM mc.financial_daily_generations generation
      JOIN mc.method_versions generation_method ON generation_method.id=generation.result_method_version_id
      JOIN mc.financial_daily_days day
        ON day.generation_id=generation.id AND day.accounting_date=p_accounting_date
      JOIN mc.financial_daily_generation_inputs input
        ON input.generation_id=generation.id AND input.source_kind='empty_week'
      JOIN mc.financial_week_coverage coverage
        ON coverage.id=input.financial_week_coverage_id
       AND coverage.business_id=generation.business_id
       AND coverage.store_id=generation.store_id
     WHERE generation.id=p_generation_id
       AND generation_method.code='financial_result' AND generation_method.version_no=20
       AND generation_method.implementation_version='financial-result-v20'
       AND day.coverage_complete AND day.quality IN ('complete','partial')
       AND mc.financial_empty_week_evidence_valid(coverage.id,input.empty_confirmation_job_id)
       AND p_accounting_date BETWEEN coverage.week_start AND coverage.week_end
       AND NOT EXISTS(
         SELECT 1
           FROM mc.financial_daily_generation_inputs report_input
           JOIN mc.report_versions report_version ON report_version.id=report_input.report_version_id
           JOIN mc.reports report ON report.id=report_version.report_id
          WHERE report_input.generation_id=generation.id
            AND report_input.source_kind='report'
            AND p_accounting_date BETWEEN report.period_start AND report.period_end
       )
  )
$$;

CREATE FUNCTION mc.emit_financial_empty_week_event(p_coverage_id uuid)
RETURNS mc.financial_input_events
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mc AS $$
#variable_conflict use_column
DECLARE
  context_business uuid:=mc.context_business_id();
  context_user uuid:=mc.context_user_id();
  coverage mc.financial_week_coverage;
  generation bigint;
  queued mc.jobs;
  emitted mc.financial_input_events;
  key_value text;
  queue_key text;
  predecessor_payload jsonb;
  queue_from date;
  queue_to date;
BEGIN
  IF context_business IS NULL OR context_user IS NULL OR NOT EXISTS(
    SELECT 1 FROM mc.memberships membership
     WHERE membership.business_id=context_business AND membership.user_id=context_user
       AND membership.role IN ('owner','editor')
  ) THEN RAISE EXCEPTION 'owned business context is required'; END IF;
  SELECT * INTO coverage FROM mc.financial_week_coverage item
   WHERE item.id=p_coverage_id AND item.business_id=context_business FOR UPDATE;
  IF NOT FOUND OR NOT mc.financial_empty_week_evidence_valid(
       coverage.id,coverage.empty_confirmed_by_job_id)
     OR NOT EXISTS(SELECT 1 FROM mc.stores store
       WHERE store.business_id=context_business AND store.id=coverage.store_id AND store.status='active') THEN
    RAISE EXCEPTION 'confirmed empty financial week is required';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM mc.connections connection
    WHERE connection.business_id=context_business AND connection.store_id=coverage.store_id
      AND connection.status='active' AND connection.scopes ? 'finance'
      AND connection.credential_generation=coverage.credential_generation) THEN
    RAISE EXCEPTION 'active financial connection for empty week is required';
  END IF;
  key_value:=format('financial-week-empty:%s:job:%s',coverage.id,coverage.empty_confirmed_by_job_id);
  SELECT * INTO emitted FROM mc.financial_input_events event
   WHERE event.business_id=context_business AND event.event_key=key_value;
  IF FOUND THEN
    IF emitted.store_id IS DISTINCT FROM coverage.store_id
       OR emitted.event_type IS DISTINCT FROM 'report_empty_confirmed'
       OR emitted.affected_from IS DISTINCT FROM coverage.week_start
       OR emitted.affected_to IS DISTINCT FROM coverage.week_end
       OR emitted.source_financial_week_coverage_id IS DISTINCT FROM coverage.id
       OR emitted.source_empty_confirmation_job_id IS DISTINCT FROM coverage.empty_confirmed_by_job_id THEN
      RAISE EXCEPTION 'financial input event key collision';
    END IF;
    RETURN emitted;
  END IF;

  INSERT INTO mc.financial_store_event_state(business_id,store_id,next_generation)
  VALUES(context_business,coverage.store_id,1) ON CONFLICT(business_id,store_id) DO NOTHING;
  SELECT next_generation INTO generation FROM mc.financial_store_event_state
   WHERE business_id=context_business AND store_id=coverage.store_id FOR UPDATE;
  queue_from:=coverage.week_start;
  queue_to:=coverage.week_end;
  SELECT job.* INTO queued FROM mc.jobs job
   WHERE job.business_id=context_business AND job.store_id=coverage.store_id
     AND job.job_type='financial_dates_recalculate' AND job.status='pending'
   ORDER BY job.created_at,job.id LIMIT 1 FOR UPDATE;
  IF FOUND THEN
    UPDATE mc.jobs SET payload=jsonb_build_object(
      'schemaVersion',1,
      'eventGeneration',greatest(generation,(payload->>'eventGeneration')::bigint),
      'affectedFrom',least(coverage.week_start,(payload->>'affectedFrom')::date),
      'affectedTo',greatest(coverage.week_end,(payload->>'affectedTo')::date),
      'allowsWbApi',false),updated_at=clock_timestamp()
     WHERE id=queued.id RETURNING * INTO queued;
  ELSE
    SELECT job.payload INTO predecessor_payload FROM mc.jobs job
     WHERE job.business_id=context_business AND job.store_id=coverage.store_id
       AND job.job_type='financial_dates_recalculate' AND job.status='running'
     ORDER BY job.created_at DESC,job.id DESC LIMIT 1;
    IF predecessor_payload IS NOT NULL THEN
      queue_from:=least(queue_from,(predecessor_payload->>'affectedFrom')::date);
      queue_to:=greatest(queue_to,(predecessor_payload->>'affectedTo')::date);
    END IF;
    queue_key:=format('financial-dates-recalculate:%s:generation:%s',coverage.store_id,generation);
    SELECT * INTO queued FROM mc.enqueue_job(coverage.store_id,'financial_dates_recalculate',queue_key,
      jsonb_build_object('schemaVersion',1,'eventGeneration',generation,
        'affectedFrom',queue_from,'affectedTo',queue_to,'allowsWbApi',false),
      clock_timestamp(),200,20);
  END IF;

  INSERT INTO mc.financial_input_events(
    business_id,store_id,event_generation,event_key,event_type,affected_from,affected_to,
    source_financial_week_coverage_id,source_empty_confirmation_job_id,actor_user_id,
    allows_wb_api,dispatch_job_id
  ) VALUES(
    context_business,coverage.store_id,generation,key_value,'report_empty_confirmed',
    coverage.week_start,coverage.week_end,coverage.id,coverage.empty_confirmed_by_job_id,
    context_user,false,queued.id
  ) RETURNING * INTO emitted;
  UPDATE mc.financial_store_event_state SET next_generation=generation+1
   WHERE business_id=context_business AND store_id=coverage.store_id;
  RETURN emitted;
END $$;
REVOKE ALL ON FUNCTION mc.emit_financial_empty_week_event(uuid) FROM PUBLIC;

CREATE FUNCTION mc.emit_financial_empty_week_event_on_transition() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mc AS $$
BEGIN
  IF NEW.coverage_status='empty'
     AND (OLD.coverage_status<>'empty'
       OR OLD.empty_confirmed_by_job_id IS DISTINCT FROM NEW.empty_confirmed_by_job_id) THEN
    PERFORM mc.emit_financial_empty_week_event(NEW.id);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER financial_empty_week_event
  AFTER UPDATE OF coverage_status,empty_confirmed_by_job_id ON mc.financial_week_coverage
  FOR EACH ROW EXECUTE FUNCTION mc.emit_financial_empty_week_event_on_transition();

-- Existing confirmed empty weeks predate the trigger. Emit the same idempotent
-- evidence and coalesce their ranges into one pending recalculation per store.
ALTER TABLE mc.financial_week_coverage NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.memberships NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.stores NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.connections NO FORCE ROW LEVEL SECURITY;
DO $$
DECLARE
  target record;
  prior_business text:=current_setting('app.business_id',true);
  prior_user text:=current_setting('app.user_id',true);
BEGIN
  FOR target IN
    SELECT coverage.id,coverage.business_id,
      (SELECT membership.user_id FROM mc.memberships membership
        WHERE membership.business_id=coverage.business_id AND membership.role IN ('owner','editor')
        ORDER BY CASE membership.role WHEN 'owner' THEN 0 ELSE 1 END,
          membership.created_at,membership.user_id LIMIT 1) actor_user_id
      FROM mc.financial_week_coverage coverage
      JOIN mc.stores store ON store.business_id=coverage.business_id AND store.id=coverage.store_id
      JOIN mc.connections connection ON connection.business_id=coverage.business_id
       AND connection.store_id=coverage.store_id AND connection.status='active'
       AND connection.scopes ? 'finance'
       AND connection.credential_generation=coverage.credential_generation
     WHERE coverage.coverage_status='empty'
       AND store.status='active'
       AND coverage.inventory_confirmed_at IS NOT NULL
       AND coverage.empty_confirmed_by_job_id IS NOT NULL
  LOOP
    IF target.actor_user_id IS NULL THEN CONTINUE; END IF;
    PERFORM set_config('app.business_id',target.business_id::text,true);
    PERFORM set_config('app.user_id',target.actor_user_id::text,true);
    PERFORM mc.emit_financial_empty_week_event(target.id);
  END LOOP;
  PERFORM set_config('app.business_id',coalesce(prior_business,''),true);
  PERFORM set_config('app.user_id',coalesce(prior_user,''),true);
END $$;
ALTER TABLE mc.financial_week_coverage FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.stores FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.connections FORCE ROW LEVEL SECURITY;

INSERT INTO mc.schema_migrations(version) VALUES(47);

COMMIT;
