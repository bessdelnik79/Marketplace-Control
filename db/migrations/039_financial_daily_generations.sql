BEGIN;

-- Generalize the report-only outbox without rewriting its immutable history.
ALTER TABLE mc.financial_input_events NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.financial_input_events DISABLE TRIGGER financial_input_events_no_update;
ALTER TABLE mc.financial_input_events
  DROP CONSTRAINT financial_input_events_event_type_check,
  ALTER COLUMN source_report_version_id DROP NOT NULL,
  ALTER COLUMN source_normalization_id DROP NOT NULL,
  ADD COLUMN actor_user_id uuid REFERENCES mc.users(id),
  ADD COLUMN source_cost_version_id uuid,
  ADD COLUMN source_expense_version_id uuid,
  ADD COLUMN source_tax_setting_version_id uuid,
  ADD COLUMN source_selection_id uuid,
  ADD COLUMN source_parser_method_version_id uuid REFERENCES mc.method_versions(id),
  ADD COLUMN source_result_method_version_id uuid REFERENCES mc.method_versions(id);

UPDATE mc.financial_input_events event
   SET actor_user_id=coalesce(
    (SELECT audit.actor_user_id
       FROM mc.audit_events audit
      WHERE audit.business_id=event.business_id AND audit.entity_id=event.dispatch_job_id
        AND audit.actor_user_id IS NOT NULL
      ORDER BY audit.created_at,audit.id LIMIT 1),
    (SELECT membership.user_id
       FROM mc.memberships membership
      WHERE membership.business_id=event.business_id
      ORDER BY CASE membership.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END,
               membership.created_at,membership.user_id
      LIMIT 1)
  );

ALTER TABLE mc.financial_input_events ENABLE TRIGGER financial_input_events_no_update;

ALTER TABLE mc.financial_input_events
  ALTER COLUMN actor_user_id SET NOT NULL,
  ALTER COLUMN actor_user_id SET DEFAULT mc.context_user_id(),
  ADD CONSTRAINT financial_input_events_event_type_check CHECK (event_type IN (
    'report_accepted','report_updated','cost_updated','expense_updated','tax_updated',
    'selection_updated','parser_method_updated','result_method_updated','shadow_backfill'
  )),
  ADD CONSTRAINT financial_input_events_cost_fk
    FOREIGN KEY (business_id,store_id,source_cost_version_id)
    REFERENCES mc.cost_versions(business_id,store_id,id),
  ADD CONSTRAINT financial_input_events_expense_fk
    FOREIGN KEY (business_id,store_id,source_expense_version_id)
    REFERENCES mc.expense_versions(business_id,store_id,id),
  ADD CONSTRAINT financial_input_events_tax_fk
    FOREIGN KEY (business_id,source_tax_setting_version_id)
    REFERENCES mc.tax_setting_versions(business_id,id),
  ADD CONSTRAINT financial_input_events_selection_fk
    FOREIGN KEY (business_id,store_id,source_selection_id)
    REFERENCES mc.product_selections(business_id,store_id,id),
  ADD CONSTRAINT financial_input_events_report_normalization_pair_fk
    FOREIGN KEY (business_id,store_id,source_report_version_id,source_normalization_id)
    REFERENCES mc.report_normalizations(business_id,store_id,report_version_id,id),
  ADD CONSTRAINT financial_input_events_source_shape CHECK (
    (event_type IN ('report_accepted','report_updated')
      AND source_report_version_id IS NOT NULL AND source_normalization_id IS NOT NULL
      AND num_nonnulls(source_cost_version_id,source_expense_version_id,
        source_tax_setting_version_id,source_selection_id,source_parser_method_version_id,
        source_result_method_version_id)=0)
    OR (event_type='cost_updated' AND source_cost_version_id IS NOT NULL
      AND num_nonnulls(source_report_version_id,source_normalization_id,source_expense_version_id,
        source_tax_setting_version_id,source_selection_id,source_parser_method_version_id,
        source_result_method_version_id)=0)
    OR (event_type='expense_updated' AND source_expense_version_id IS NOT NULL
      AND num_nonnulls(source_report_version_id,source_normalization_id,source_cost_version_id,
        source_tax_setting_version_id,source_selection_id,source_parser_method_version_id,
        source_result_method_version_id)=0)
    OR (event_type='tax_updated' AND source_tax_setting_version_id IS NOT NULL
      AND num_nonnulls(source_report_version_id,source_normalization_id,source_cost_version_id,
        source_expense_version_id,source_selection_id,source_parser_method_version_id,
        source_result_method_version_id)=0)
    OR (event_type='selection_updated' AND source_selection_id IS NOT NULL
      AND num_nonnulls(source_report_version_id,source_normalization_id,source_cost_version_id,
        source_expense_version_id,source_tax_setting_version_id,source_parser_method_version_id,
        source_result_method_version_id)=0)
    OR (event_type='parser_method_updated' AND source_parser_method_version_id IS NOT NULL
      AND num_nonnulls(source_report_version_id,source_normalization_id,source_cost_version_id,
        source_expense_version_id,source_tax_setting_version_id,source_selection_id,
        source_result_method_version_id)=0)
    OR (event_type IN ('result_method_updated','shadow_backfill') AND source_result_method_version_id IS NOT NULL
      AND num_nonnulls(source_report_version_id,source_normalization_id,source_cost_version_id,
        source_expense_version_id,source_tax_setting_version_id,source_selection_id,
        source_parser_method_version_id)=0)
  );
ALTER TABLE mc.financial_input_events FORCE ROW LEVEL SECURITY;

CREATE FUNCTION mc.emit_financial_input_event(
  p_store_id uuid,p_event_key text,p_event_type text,p_affected_from date,p_affected_to date,
  p_source_report_version_id uuid DEFAULT NULL,p_source_normalization_id uuid DEFAULT NULL,
  p_source_cost_version_id uuid DEFAULT NULL,p_source_expense_version_id uuid DEFAULT NULL,
  p_source_tax_setting_version_id uuid DEFAULT NULL,p_source_selection_id uuid DEFAULT NULL,
  p_source_parser_method_version_id uuid DEFAULT NULL,p_source_result_method_version_id uuid DEFAULT NULL
)
RETURNS mc.financial_input_events
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mc AS $$
#variable_conflict use_column
DECLARE
  context_business uuid:=mc.context_business_id();
  context_user uuid:=mc.context_user_id();
  generation bigint;
  queued mc.jobs;
  emitted mc.financial_input_events;
  queue_key text;
  predecessor_payload jsonb;
  queue_from date:=p_affected_from;
  queue_to date:=p_affected_to;
BEGIN
  IF context_business IS NULL OR context_user IS NULL OR NOT EXISTS(
    SELECT 1 FROM mc.memberships membership
     WHERE membership.business_id=context_business AND membership.user_id=context_user
       AND membership.role IN ('owner','editor')
  ) THEN RAISE EXCEPTION 'owned business context is required'; END IF;
  IF p_store_id IS NULL OR NOT EXISTS(
    SELECT 1 FROM mc.stores store
     WHERE store.business_id=context_business AND store.id=p_store_id AND store.status='active'
  ) THEN RAISE EXCEPTION 'active store is outside business context'; END IF;
  IF nullif(btrim(p_event_key),'') IS NULL OR length(p_event_key)>200
     OR p_event_type NOT IN ('report_accepted','report_updated','cost_updated','expense_updated',
       'tax_updated','selection_updated','parser_method_updated','result_method_updated','shadow_backfill')
     OR p_affected_from IS NULL OR p_affected_to IS NULL OR NOT isfinite(p_affected_from)
     OR NOT isfinite(p_affected_to) OR p_affected_to<p_affected_from THEN
    RAISE EXCEPTION 'financial input event is invalid';
  END IF;
  INSERT INTO mc.financial_store_event_state(business_id,store_id,next_generation)
  VALUES(context_business,p_store_id,1) ON CONFLICT(business_id,store_id) DO NOTHING;
  SELECT next_generation INTO generation FROM mc.financial_store_event_state
   WHERE business_id=context_business AND store_id=p_store_id FOR UPDATE;
  SELECT * INTO emitted FROM mc.financial_input_events
   WHERE business_id=context_business AND event_key=p_event_key;
  IF FOUND THEN
    IF emitted.store_id IS DISTINCT FROM p_store_id
       OR emitted.event_type IS DISTINCT FROM p_event_type
       OR emitted.affected_from IS DISTINCT FROM p_affected_from
       OR emitted.affected_to IS DISTINCT FROM p_affected_to
       OR emitted.source_report_version_id IS DISTINCT FROM p_source_report_version_id
       OR emitted.source_normalization_id IS DISTINCT FROM p_source_normalization_id
       OR emitted.source_cost_version_id IS DISTINCT FROM p_source_cost_version_id
       OR emitted.source_expense_version_id IS DISTINCT FROM p_source_expense_version_id
       OR emitted.source_tax_setting_version_id IS DISTINCT FROM p_source_tax_setting_version_id
       OR emitted.source_selection_id IS DISTINCT FROM p_source_selection_id
       OR emitted.source_parser_method_version_id IS DISTINCT FROM p_source_parser_method_version_id
       OR emitted.source_result_method_version_id IS DISTINCT FROM p_source_result_method_version_id THEN
      RAISE EXCEPTION 'financial input event key collision';
    END IF;
    RETURN emitted;
  END IF;

  -- A pending successor absorbs every newer cause. If a predecessor is already
  -- running, its complete range is copied into the successor before the older
  -- event may be marked superseded, so no invalidated date can be lost.
  SELECT job.* INTO queued FROM mc.jobs job
   WHERE job.business_id=context_business AND job.store_id=p_store_id
     AND job.job_type='financial_dates_recalculate' AND job.status='pending'
   ORDER BY job.created_at,job.id LIMIT 1 FOR UPDATE;
  IF FOUND THEN
    UPDATE mc.jobs SET payload=jsonb_build_object(
      'schemaVersion',1,
      'eventGeneration',greatest(generation,(payload->>'eventGeneration')::bigint),
      'affectedFrom',least(p_affected_from,(payload->>'affectedFrom')::date),
      'affectedTo',greatest(p_affected_to,(payload->>'affectedTo')::date),
      'allowsWbApi',false),updated_at=clock_timestamp()
     WHERE id=queued.id RETURNING * INTO queued;
  ELSE
    SELECT job.payload INTO predecessor_payload FROM mc.jobs job
     WHERE job.business_id=context_business AND job.store_id=p_store_id
       AND job.job_type='financial_dates_recalculate' AND job.status='running'
     ORDER BY job.created_at DESC,job.id DESC LIMIT 1;
    IF predecessor_payload IS NOT NULL THEN
      queue_from:=least(queue_from,(predecessor_payload->>'affectedFrom')::date);
      queue_to:=greatest(queue_to,(predecessor_payload->>'affectedTo')::date);
    END IF;
    queue_key:=format('financial-dates-recalculate:%s:generation:%s',p_store_id,generation);
    SELECT * INTO queued FROM mc.enqueue_job(p_store_id,'financial_dates_recalculate',queue_key,
      jsonb_build_object('schemaVersion',1,'eventGeneration',generation,
        'affectedFrom',queue_from,'affectedTo',queue_to,'allowsWbApi',false),
      clock_timestamp(),200,20);
  END IF;

  INSERT INTO mc.financial_input_events(
    business_id,store_id,event_generation,event_key,event_type,affected_from,affected_to,
    source_report_version_id,source_normalization_id,source_cost_version_id,
    source_expense_version_id,source_tax_setting_version_id,source_selection_id,
    source_parser_method_version_id,source_result_method_version_id,actor_user_id,
    allows_wb_api,dispatch_job_id
  ) VALUES(
    context_business,p_store_id,generation,p_event_key,p_event_type,p_affected_from,p_affected_to,
    p_source_report_version_id,p_source_normalization_id,p_source_cost_version_id,
    p_source_expense_version_id,p_source_tax_setting_version_id,p_source_selection_id,
    p_source_parser_method_version_id,p_source_result_method_version_id,context_user,false,queued.id
  ) RETURNING * INTO emitted;
  UPDATE mc.financial_store_event_state SET next_generation=generation+1
   WHERE business_id=context_business AND store_id=p_store_id;
  RETURN emitted;
END $$;
REVOKE ALL ON FUNCTION mc.emit_financial_input_event(uuid,text,text,date,date,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid) FROM PUBLIC;

CREATE TABLE mc.financial_daily_generations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  store_id uuid NOT NULL,
  generation_no bigint NOT NULL CHECK (generation_no>0),
  source_event_generation bigint NOT NULL CHECK (source_event_generation>0),
  watermark_generation bigint NOT NULL CHECK (watermark_generation>=source_event_generation),
  job_id uuid NOT NULL,
  affected_from date NOT NULL CHECK (isfinite(affected_from)),
  affected_to date NOT NULL CHECK (isfinite(affected_to)),
  parser_method_version_id uuid NOT NULL REFERENCES mc.method_versions(id),
  result_method_version_id uuid NOT NULL REFERENCES mc.method_versions(id),
  frozen_input_fingerprint text NOT NULL CHECK (length(frozen_input_fingerprint) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'building' CHECK (status IN ('building','succeeded','failed','superseded')),
  quality text NOT NULL DEFAULT 'unavailable' CHECK (quality IN ('complete','partial','unavailable')),
  failure_code text CHECK (failure_code IS NULL OR failure_code ~ '^[a-z0-9][a-z0-9_.:-]{0,99}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  UNIQUE (business_id,store_id,id),
  UNIQUE (business_id,store_id,generation_no),
  UNIQUE (job_id),
  FOREIGN KEY (business_id,store_id) REFERENCES mc.stores(business_id,id),
  CHECK (affected_to>=affected_from),
  CHECK ((status='building' AND finished_at IS NULL AND failure_code IS NULL)
    OR (status='succeeded' AND finished_at IS NOT NULL AND failure_code IS NULL)
    OR (status IN ('failed','superseded') AND finished_at IS NOT NULL AND failure_code IS NOT NULL))
);

ALTER TABLE mc.jobs ADD CONSTRAINT jobs_tenant_store_identity UNIQUE(business_id,store_id,id);
ALTER TABLE mc.financial_daily_generations ADD CONSTRAINT financial_daily_generation_job_fk
  FOREIGN KEY (business_id,store_id,job_id) REFERENCES mc.jobs(business_id,store_id,id);

CREATE TABLE mc.financial_daily_generation_inputs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),business_id uuid NOT NULL,store_id uuid NOT NULL,generation_id uuid NOT NULL,
  source_kind text NOT NULL CHECK (source_kind IN ('report','cost','expense','tax','selection')),
  report_version_id uuid,report_normalization_id uuid,cost_version_id uuid,expense_version_id uuid,
  tax_setting_version_id uuid,selection_id uuid,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (business_id,store_id,id),
  FOREIGN KEY (business_id,store_id,generation_id) REFERENCES mc.financial_daily_generations(business_id,store_id,id),
  FOREIGN KEY (business_id,store_id,report_version_id) REFERENCES mc.report_versions(business_id,store_id,id),
  FOREIGN KEY (business_id,store_id,report_normalization_id) REFERENCES mc.report_normalizations(business_id,store_id,id),
  FOREIGN KEY (business_id,store_id,report_version_id,report_normalization_id)
    REFERENCES mc.report_normalizations(business_id,store_id,report_version_id,id),
  FOREIGN KEY (business_id,store_id,cost_version_id) REFERENCES mc.cost_versions(business_id,store_id,id),
  FOREIGN KEY (business_id,store_id,expense_version_id) REFERENCES mc.expense_versions(business_id,store_id,id),
  FOREIGN KEY (business_id,tax_setting_version_id) REFERENCES mc.tax_setting_versions(business_id,id),
  FOREIGN KEY (business_id,store_id,selection_id) REFERENCES mc.product_selections(business_id,store_id,id),
  CHECK ((source_kind='report' AND report_version_id IS NOT NULL AND report_normalization_id IS NOT NULL
      AND num_nonnulls(cost_version_id,expense_version_id,tax_setting_version_id,selection_id)=0)
    OR (source_kind='cost' AND cost_version_id IS NOT NULL AND num_nonnulls(report_version_id,report_normalization_id,expense_version_id,tax_setting_version_id,selection_id)=0)
    OR (source_kind='expense' AND expense_version_id IS NOT NULL AND num_nonnulls(report_version_id,report_normalization_id,cost_version_id,tax_setting_version_id,selection_id)=0)
    OR (source_kind='tax' AND tax_setting_version_id IS NOT NULL AND num_nonnulls(report_version_id,report_normalization_id,cost_version_id,expense_version_id,selection_id)=0)
    OR (source_kind='selection' AND selection_id IS NOT NULL AND num_nonnulls(report_version_id,report_normalization_id,cost_version_id,expense_version_id,tax_setting_version_id)=0)),
  UNIQUE NULLS NOT DISTINCT (generation_id,source_kind,report_version_id,report_normalization_id,cost_version_id,expense_version_id,tax_setting_version_id,selection_id)
);

CREATE TABLE mc.financial_daily_generation_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),business_id uuid NOT NULL,store_id uuid NOT NULL,generation_id uuid NOT NULL,
  product_id uuid NOT NULL,variant_id uuid,selected boolean NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (business_id,store_id,id),UNIQUE NULLS NOT DISTINCT(generation_id,product_id,variant_id),
  FOREIGN KEY (business_id,store_id,generation_id) REFERENCES mc.financial_daily_generations(business_id,store_id,id),
  FOREIGN KEY (business_id,store_id,product_id) REFERENCES mc.products(business_id,store_id,id),
  FOREIGN KEY (business_id,store_id,product_id,variant_id) REFERENCES mc.variants(business_id,store_id,product_id,id)
);

CREATE TABLE mc.financial_daily_days (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),business_id uuid NOT NULL,store_id uuid NOT NULL,generation_id uuid NOT NULL,
  accounting_date date NOT NULL CHECK (isfinite(accounting_date)),coverage_complete boolean NOT NULL,
  quality text NOT NULL CHECK (quality IN ('complete','partial','unavailable')),tax_usable boolean NOT NULL,
  store_profit_before_tax numeric(20,4),selected_profit_before_tax numeric(20,4),available_profit_before_tax numeric(20,4),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (business_id,store_id,id),UNIQUE(generation_id,accounting_date),
  FOREIGN KEY (business_id,store_id,generation_id) REFERENCES mc.financial_daily_generations(business_id,store_id,id),
  CHECK (coverage_complete OR quality<>'complete')
);

CREATE TABLE mc.financial_daily_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),business_id uuid NOT NULL,store_id uuid NOT NULL,generation_id uuid NOT NULL,
  accounting_date date NOT NULL CHECK (isfinite(accounting_date)),category_code text NOT NULL,
  scope text NOT NULL CHECK (scope IN ('store','selected_products')),product_id uuid,variant_id uuid,
  amount_signed numeric(20,4) NOT NULL,tax_base_unrounded numeric(30,12),tax_numerator_unrounded numeric(30,12),
  quality text NOT NULL CHECK (quality IN ('complete','partial','unavailable')),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (business_id,store_id,id),UNIQUE (business_id,store_id,generation_id,id),
  UNIQUE NULLS NOT DISTINCT(generation_id,accounting_date,category_code,scope,product_id,variant_id),
  FOREIGN KEY (business_id,store_id,generation_id) REFERENCES mc.financial_daily_generations(business_id,store_id,id),
  FOREIGN KEY (category_code) REFERENCES mc.financial_categories(code),
  FOREIGN KEY (business_id,store_id,product_id) REFERENCES mc.products(business_id,store_id,id),
  FOREIGN KEY (business_id,store_id,product_id,variant_id) REFERENCES mc.variants(business_id,store_id,product_id,id),
  CHECK ((scope='store' AND product_id IS NULL AND variant_id IS NULL) OR (scope='selected_products' AND product_id IS NOT NULL)),
  CHECK (variant_id IS NULL OR product_id IS NOT NULL)
);

CREATE TABLE mc.financial_daily_reasons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),business_id uuid NOT NULL,store_id uuid NOT NULL,generation_id uuid NOT NULL,
  accounting_date date NOT NULL CHECK (isfinite(accounting_date)),reason_code text NOT NULL CHECK (reason_code ~ '^[a-z0-9][a-z0-9_.:-]{0,99}$'),
  scope text NOT NULL CHECK (scope IN ('store','selected_products','product','variant')),product_id uuid,variant_id uuid,
  severity text NOT NULL CHECK (severity IN ('partial','unavailable')),details jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (business_id,store_id,id),UNIQUE NULLS NOT DISTINCT(generation_id,accounting_date,reason_code,scope,product_id,variant_id),
  FOREIGN KEY (business_id,store_id,generation_id) REFERENCES mc.financial_daily_generations(business_id,store_id,id),
  FOREIGN KEY (business_id,store_id,product_id) REFERENCES mc.products(business_id,store_id,id),
  FOREIGN KEY (business_id,store_id,product_id,variant_id) REFERENCES mc.variants(business_id,store_id,product_id,id),
  CHECK ((scope IN ('store','selected_products') AND product_id IS NULL AND variant_id IS NULL)
    OR (scope='product' AND product_id IS NOT NULL AND variant_id IS NULL)
    OR (scope='variant' AND product_id IS NOT NULL AND variant_id IS NOT NULL))
);

CREATE TABLE mc.financial_daily_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),business_id uuid NOT NULL,store_id uuid NOT NULL,generation_id uuid NOT NULL,
  daily_result_id uuid NOT NULL,financial_component_id uuid,cost_version_id uuid,expense_version_id uuid,
  tax_computation_id uuid,report_row_id uuid,source_operation_version_id uuid,operation_link_id uuid,
  quantity numeric(20,6),contribution_amount numeric(20,4) NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (business_id,store_id,id),
  FOREIGN KEY (business_id,store_id,generation_id) REFERENCES mc.financial_daily_generations(business_id,store_id,id),
  FOREIGN KEY (business_id,store_id,generation_id,daily_result_id) REFERENCES mc.financial_daily_results(business_id,store_id,generation_id,id),
  FOREIGN KEY (business_id,store_id,financial_component_id) REFERENCES mc.financial_components(business_id,store_id,id),
  FOREIGN KEY (business_id,store_id,cost_version_id) REFERENCES mc.cost_versions(business_id,store_id,id),
  FOREIGN KEY (business_id,store_id,expense_version_id) REFERENCES mc.expense_versions(business_id,store_id,id),
  FOREIGN KEY (business_id,store_id,tax_computation_id) REFERENCES mc.tax_computations(business_id,store_id,id),
  FOREIGN KEY (business_id,store_id,report_row_id) REFERENCES mc.report_rows(business_id,store_id,id),
  FOREIGN KEY (business_id,store_id,source_operation_version_id) REFERENCES mc.operation_versions(business_id,store_id,id),
  FOREIGN KEY (business_id,store_id,operation_link_id) REFERENCES mc.operation_links(business_id,store_id,id),
  CHECK (num_nonnulls(financial_component_id,cost_version_id,expense_version_id,tax_computation_id,report_row_id)=1),
  CHECK ((cost_version_id IS NULL AND source_operation_version_id IS NULL AND operation_link_id IS NULL AND quantity IS NULL)
    OR (cost_version_id IS NOT NULL AND source_operation_version_id IS NOT NULL AND quantity IS NOT NULL))
);

CREATE TABLE mc.financial_daily_tax_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),business_id uuid NOT NULL,store_id uuid NOT NULL,generation_id uuid NOT NULL,
  accounting_date date NOT NULL CHECK (isfinite(accounting_date)),product_id uuid NOT NULL,tax_setting_version_id uuid NOT NULL,
  tax_base_unrounded numeric(30,12) NOT NULL,tax_numerator_unrounded numeric(30,12) NOT NULL,
  tax_rate_fraction numeric(20,10),tax_amount_rounded numeric(20,4),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (business_id,store_id,id),UNIQUE (business_id,store_id,generation_id,id),
  UNIQUE(generation_id,accounting_date,product_id,tax_setting_version_id),
  FOREIGN KEY (business_id,store_id,generation_id) REFERENCES mc.financial_daily_generations(business_id,store_id,id),
  FOREIGN KEY (business_id,store_id,product_id) REFERENCES mc.products(business_id,store_id,id),
  FOREIGN KEY (business_id,tax_setting_version_id) REFERENCES mc.tax_setting_versions(business_id,id),
  CHECK (tax_rate_fraction IS NULL OR tax_rate_fraction BETWEEN 0 AND 1)
);

CREATE TABLE mc.financial_daily_tax_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),business_id uuid NOT NULL,store_id uuid NOT NULL,generation_id uuid NOT NULL,
  tax_fact_id uuid NOT NULL,financial_component_id uuid NOT NULL,contribution_amount numeric(30,12) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (business_id,store_id,id),UNIQUE(tax_fact_id,financial_component_id),
  FOREIGN KEY (business_id,store_id,generation_id,tax_fact_id)
    REFERENCES mc.financial_daily_tax_facts(business_id,store_id,generation_id,id),
  FOREIGN KEY (business_id,store_id,financial_component_id)
    REFERENCES mc.financial_components(business_id,store_id,id)
);

ALTER TABLE mc.publications ADD CONSTRAINT publications_tenant_identity UNIQUE(business_id,store_id,id);

CREATE TABLE mc.financial_daily_shadow_comparisons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),business_id uuid NOT NULL,store_id uuid NOT NULL,generation_id uuid NOT NULL,
  publication_id uuid NOT NULL,period_result_id uuid NOT NULL,legacy_run_id uuid NOT NULL,
  period_start date NOT NULL CHECK(isfinite(period_start)),period_end date NOT NULL CHECK(isfinite(period_end)),
  status text NOT NULL CHECK(status IN ('matched','mismatch','not_comparable')),
  compared_metrics jsonb NOT NULL DEFAULT '{}',difference_details jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (business_id,store_id,id),UNIQUE(generation_id,publication_id,period_result_id),
  FOREIGN KEY (business_id,store_id,generation_id) REFERENCES mc.financial_daily_generations(business_id,store_id,id),
  FOREIGN KEY (business_id,store_id,publication_id) REFERENCES mc.publications(business_id,store_id,id),
  FOREIGN KEY (business_id,store_id,period_result_id) REFERENCES mc.financial_period_results(business_id,store_id,id),
  FOREIGN KEY (business_id,store_id,legacy_run_id) REFERENCES mc.calculation_runs(business_id,store_id,id),
  CHECK(period_end>=period_start)
);

CREATE FUNCTION mc.guard_financial_daily_generation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NOT EXISTS(SELECT 1 FROM mc.method_versions WHERE id=NEW.parser_method_version_id AND code='wb_finance_import')
       OR NOT EXISTS(SELECT 1 FROM mc.method_versions WHERE id=NEW.result_method_version_id AND code='financial_result') THEN
      RAISE EXCEPTION 'financial daily method contract is invalid' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'financial daily generations are append-only' USING ERRCODE='23514'; END IF;
  IF (NEW.id,NEW.business_id,NEW.store_id,NEW.generation_no,NEW.source_event_generation,
      NEW.watermark_generation,NEW.job_id,NEW.affected_from,NEW.affected_to,
      NEW.parser_method_version_id,NEW.result_method_version_id,NEW.frozen_input_fingerprint,NEW.created_at)
    IS DISTINCT FROM
     (OLD.id,OLD.business_id,OLD.store_id,OLD.generation_no,OLD.source_event_generation,
      OLD.watermark_generation,OLD.job_id,OLD.affected_from,OLD.affected_to,
      OLD.parser_method_version_id,OLD.result_method_version_id,OLD.frozen_input_fingerprint,OLD.created_at)
     OR OLD.status<>'building' OR NEW.status='building' THEN
    RAISE EXCEPTION 'financial daily generation transition is invalid' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER financial_daily_generation_guard BEFORE INSERT OR UPDATE OR DELETE ON mc.financial_daily_generations
  FOR EACH ROW EXECUTE FUNCTION mc.guard_financial_daily_generation();

CREATE FUNCTION mc.guard_financial_daily_child_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM mc.financial_daily_generations generation
    WHERE generation.id=NEW.generation_id AND generation.business_id=NEW.business_id
      AND generation.store_id=NEW.store_id AND generation.status='building') THEN
    RAISE EXCEPTION 'financial daily generation is frozen' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION mc.guard_financial_daily_shadow_comparison() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(
    SELECT 1 FROM mc.financial_daily_generations generation
    JOIN mc.publications publication ON publication.id=NEW.publication_id
      AND publication.business_id=NEW.business_id AND publication.store_id=NEW.store_id
    JOIN mc.financial_period_results period_result ON period_result.id=NEW.period_result_id
      AND period_result.business_id=NEW.business_id AND period_result.store_id=NEW.store_id
    WHERE generation.id=NEW.generation_id AND generation.business_id=NEW.business_id
      AND generation.store_id=NEW.store_id AND generation.status='building'
      AND publication.run_id=NEW.legacy_run_id AND period_result.run_id=NEW.legacy_run_id
      AND period_result.period_start=NEW.period_start AND period_result.period_end=NEW.period_end
  ) THEN RAISE EXCEPTION 'shadow comparison does not match a published period' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;

DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'financial_daily_generation_inputs','financial_daily_generation_products','financial_daily_days','financial_daily_results',
    'financial_daily_reasons','financial_daily_evidence','financial_daily_tax_facts','financial_daily_tax_evidence',
    'financial_daily_shadow_comparisons'
  ] LOOP
    EXECUTE format('CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON mc.%I FOR EACH ROW EXECUTE FUNCTION mc.reject_mutation()',table_name);
  END LOOP;
END $$;

DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'financial_daily_generation_inputs','financial_daily_generation_products','financial_daily_days',
    'financial_daily_results','financial_daily_reasons','financial_daily_evidence',
    'financial_daily_tax_facts','financial_daily_tax_evidence'
  ] LOOP
    EXECUTE format('CREATE TRIGGER generation_building_guard BEFORE INSERT ON mc.%I FOR EACH ROW EXECUTE FUNCTION mc.guard_financial_daily_child_insert()',table_name);
  END LOOP;
END $$;
CREATE TRIGGER shadow_comparison_scope_guard BEFORE INSERT ON mc.financial_daily_shadow_comparisons
  FOR EACH ROW EXECUTE FUNCTION mc.guard_financial_daily_shadow_comparison();

DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'financial_daily_generations','financial_daily_generation_inputs','financial_daily_generation_products','financial_daily_days',
    'financial_daily_results','financial_daily_reasons','financial_daily_evidence','financial_daily_tax_facts','financial_daily_tax_evidence',
    'financial_daily_shadow_comparisons'
  ] LOOP
    EXECUTE format('ALTER TABLE mc.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE mc.%I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON mc.%I USING (business_id=mc.context_business_id()) WITH CHECK (business_id=mc.context_business_id())',table_name);
  END LOOP;
END $$;

CREATE FUNCTION mc.establish_financial_daily_context(p_job_id uuid,p_lease_token uuid,p_worker_id text)
RETURNS TABLE(business_id uuid,store_id uuid,actor_user_id uuid,payload jsonb,event_generation bigint,
  watermark_generation bigint,affected_from date,affected_to date)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mc AS $$
#variable_conflict use_column
DECLARE target mc.job_dispatch; target_job mc.jobs; actor uuid; state_generation bigint;
BEGIN
  IF nullif(btrim(p_worker_id),'') IS NULL OR length(p_worker_id)>200 THEN RAISE EXCEPTION 'worker id is invalid'; END IF;
  SELECT dispatch.* INTO target FROM mc.job_dispatch dispatch
   WHERE dispatch.job_id=p_job_id AND dispatch.job_type='financial_dates_recalculate'
     AND dispatch.status='running' AND dispatch.lease_until>clock_timestamp();
  IF NOT FOUND THEN RAISE EXCEPTION 'running financial daily job is required'; END IF;
  PERFORM set_config('app.business_id',target.business_id::text,true);
  PERFORM set_config('app.user_id','',true);
  SELECT job.* INTO target_job FROM mc.jobs job
   WHERE job.id=p_job_id AND job.status='running' AND job.lease_token=p_lease_token
     AND job.worker_id=btrim(p_worker_id) AND job.lease_until>clock_timestamp();
  IF NOT FOUND OR target_job.store_id IS NULL OR jsonb_typeof(target_job.payload) IS DISTINCT FROM 'object'
     OR target_job.payload->>'schemaVersion' IS DISTINCT FROM '1'
     OR target_job.payload->>'allowsWbApi' IS DISTINCT FROM 'false'
     OR target_job.payload->>'eventGeneration' IS NULL OR (target_job.payload->>'eventGeneration')::bigint<1
     OR target_job.payload->>'affectedFrom' IS NULL OR target_job.payload->>'affectedTo' IS NULL
     OR NOT isfinite((target_job.payload->>'affectedFrom')::date)
     OR NOT isfinite((target_job.payload->>'affectedTo')::date)
     OR (target_job.payload->>'affectedTo')::date<(target_job.payload->>'affectedFrom')::date THEN
    RAISE EXCEPTION 'financial daily job contract is invalid';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM mc.financial_input_events event
    WHERE event.business_id=target.business_id AND event.store_id=target_job.store_id
      AND event.dispatch_job_id=p_job_id
      AND event.event_generation=(target_job.payload->>'eventGeneration')::bigint)
     OR EXISTS(SELECT 1 FROM mc.financial_input_events event
       WHERE event.business_id=target.business_id AND event.store_id=target_job.store_id
         AND event.dispatch_job_id=p_job_id
         AND (event.affected_from<(target_job.payload->>'affectedFrom')::date
           OR event.affected_to>(target_job.payload->>'affectedTo')::date)) THEN
    RAISE EXCEPTION 'financial daily event linkage is invalid';
  END IF;
  SELECT membership.user_id INTO actor FROM mc.memberships membership
   WHERE membership.business_id=target.business_id AND membership.role IN ('owner','editor')
   ORDER BY CASE membership.role WHEN 'owner' THEN 0 ELSE 1 END,membership.created_at,membership.user_id LIMIT 1;
  IF actor IS NULL THEN RAISE EXCEPTION 'financial daily actor is unavailable'; END IF;
  PERFORM set_config('app.user_id',actor::text,true);
  SELECT state.next_generation-1 INTO state_generation FROM mc.financial_store_event_state state
   WHERE state.business_id=target.business_id AND state.store_id=target_job.store_id;
  IF state_generation IS NULL OR state_generation<(target_job.payload->>'eventGeneration')::bigint THEN
    RAISE EXCEPTION 'financial daily event watermark is invalid';
  END IF;
  RETURN QUERY SELECT target.business_id,target_job.store_id,actor,target_job.payload,
    (target_job.payload->>'eventGeneration')::bigint,state_generation,
    (target_job.payload->>'affectedFrom')::date,(target_job.payload->>'affectedTo')::date;
END $$;
REVOKE ALL ON FUNCTION mc.establish_financial_daily_context(uuid,uuid,text) FROM PUBLIC;

CREATE FUNCTION mc.start_financial_daily_generation(
  p_job_id uuid,p_lease_token uuid,p_worker_id text,p_event_generation bigint,
  p_frozen_input_fingerprint text,p_parser_method_version_id uuid,p_result_method_version_id uuid
) RETURNS mc.financial_daily_generations
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mc AS $$
#variable_conflict use_column
DECLARE context record; generation mc.financial_daily_generations;
BEGIN
  SELECT * INTO context FROM mc.establish_financial_daily_context(p_job_id,p_lease_token,p_worker_id);
  IF context.event_generation<>p_event_generation OR nullif(btrim(p_frozen_input_fingerprint),'') IS NULL
     OR length(p_frozen_input_fingerprint)>200
     OR NOT EXISTS(SELECT 1 FROM mc.method_versions WHERE id=p_parser_method_version_id AND code='wb_finance_import')
     OR NOT EXISTS(SELECT 1 FROM mc.method_versions WHERE id=p_result_method_version_id AND code='financial_result') THEN
    RAISE EXCEPTION 'financial daily generation contract is invalid';
  END IF;
  SELECT * INTO generation FROM mc.financial_daily_generations WHERE job_id=p_job_id;
  IF FOUND THEN RETURN generation; END IF;
  INSERT INTO mc.financial_daily_generations(
    business_id,store_id,generation_no,source_event_generation,watermark_generation,job_id,
    affected_from,affected_to,parser_method_version_id,result_method_version_id,frozen_input_fingerprint
  ) VALUES(context.business_id,context.store_id,context.event_generation,context.event_generation,
    context.watermark_generation,p_job_id,context.affected_from,context.affected_to,
    p_parser_method_version_id,p_result_method_version_id,p_frozen_input_fingerprint)
  RETURNING * INTO generation;
  RETURN generation;
END $$;
REVOKE ALL ON FUNCTION mc.start_financial_daily_generation(uuid,uuid,text,bigint,text,uuid,uuid) FROM PUBLIC;

CREATE FUNCTION mc.finalize_financial_daily_generation(
  p_job_id uuid,p_lease_token uuid,p_worker_id text,p_generation_id uuid,
  p_expected_event_generation bigint,p_status text,p_quality text,p_failure_code text DEFAULT NULL
) RETURNS mc.financial_daily_generations
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mc AS $$
#variable_conflict use_column
DECLARE context record; generation mc.financial_daily_generations; current_watermark bigint; final_status text:=p_status; final_code text:=p_failure_code;
BEGIN
  SELECT * INTO context FROM mc.establish_financial_daily_context(p_job_id,p_lease_token,p_worker_id);
  SELECT * INTO generation FROM mc.financial_daily_generations
   WHERE id=p_generation_id AND business_id=context.business_id AND store_id=context.store_id
     AND job_id=p_job_id AND source_event_generation=p_expected_event_generation FOR UPDATE;
  IF NOT FOUND OR generation.status<>'building' THEN RAISE EXCEPTION 'building financial daily generation is required'; END IF;
  IF p_status NOT IN ('succeeded','failed','superseded') OR p_quality NOT IN ('complete','partial','unavailable')
     OR (p_failure_code IS NOT NULL AND p_failure_code !~ '^[a-z0-9][a-z0-9_.:-]{0,99}$') THEN
    RAISE EXCEPTION 'financial daily final state is invalid';
  END IF;
  SELECT next_generation-1 INTO current_watermark FROM mc.financial_store_event_state
   WHERE business_id=context.business_id AND store_id=context.store_id FOR UPDATE;
  IF final_status='succeeded' AND current_watermark<>generation.watermark_generation THEN
    final_status:='superseded'; final_code:='financial_daily_watermark_advanced';
  END IF;
  IF final_status='succeeded' AND (
    (SELECT count(*) FROM mc.financial_daily_days day WHERE day.generation_id=generation.id)
      <> generation.affected_to-generation.affected_from+1
    OR (SELECT min(accounting_date) FROM mc.financial_daily_days day WHERE day.generation_id=generation.id)<>generation.affected_from
    OR (SELECT max(accounting_date) FROM mc.financial_daily_days day WHERE day.generation_id=generation.id)<>generation.affected_to
    OR NOT EXISTS(SELECT 1 FROM mc.financial_daily_generation_inputs input WHERE input.generation_id=generation.id)
    OR NOT EXISTS(SELECT 1 FROM mc.financial_daily_generation_products product WHERE product.generation_id=generation.id)
    OR EXISTS(SELECT 1 FROM mc.financial_daily_results result WHERE result.generation_id=generation.id
      AND NOT EXISTS(SELECT 1 FROM mc.financial_daily_evidence evidence WHERE evidence.daily_result_id=result.id))
    OR EXISTS(SELECT 1 FROM mc.financial_daily_tax_facts fact WHERE fact.generation_id=generation.id
      AND NOT EXISTS(SELECT 1 FROM mc.financial_daily_tax_evidence evidence WHERE evidence.tax_fact_id=fact.id))
  ) THEN RAISE EXCEPTION 'financial daily generation evidence is incomplete'; END IF;
  IF final_status='succeeded' THEN final_code:=NULL;
  ELSIF final_code IS NULL THEN final_code:=CASE final_status WHEN 'failed' THEN 'financial_daily_failed' ELSE 'financial_daily_superseded' END;
  END IF;
  UPDATE mc.financial_daily_generations SET status=final_status,quality=p_quality,
    failure_code=final_code,finished_at=clock_timestamp() WHERE id=generation.id RETURNING * INTO generation;
  RETURN generation;
END $$;
REVOKE ALL ON FUNCTION mc.finalize_financial_daily_generation(uuid,uuid,text,uuid,bigint,text,text,text) FROM PUBLIC;

CREATE FUNCTION mc.emit_financial_pointer_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mc AS $$
DECLARE date_from date; date_to date; max_coverage date; next_effective date; selection uuid;
  old_from date; old_to date; new_from date; new_to date;
BEGIN
  IF NEW.current_version_id IS NOT DISTINCT FROM OLD.current_version_id OR NEW.current_version_id IS NULL THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME='variant_costs' THEN
    date_from:=NEW.effective_from;
    SELECT min(effective_from) INTO next_effective FROM mc.variant_costs
     WHERE business_id=NEW.business_id AND store_id=NEW.store_id AND variant_id=NEW.variant_id
       AND effective_from>NEW.effective_from;
    SELECT max(period_end) INTO max_coverage FROM mc.reports
     WHERE business_id=NEW.business_id AND store_id=NEW.store_id AND current_version_id IS NOT NULL;
    IF max_coverage IS NULL OR max_coverage<date_from THEN RETURN NEW; END IF;
    date_to:=least(coalesce(next_effective-1,max_coverage),max_coverage);
    IF date_to<date_from THEN RETURN NEW; END IF;
    PERFORM mc.emit_financial_input_event(NEW.store_id,'cost-version:'||NEW.current_version_id,'cost_updated',date_from,date_to,
      p_source_cost_version_id=>NEW.current_version_id);
  ELSIF TG_TABLE_NAME='expenses' THEN
    SELECT period_start,period_end INTO new_from,new_to FROM mc.expense_versions WHERE id=NEW.current_version_id;
    SELECT period_start,period_end INTO old_from,old_to FROM mc.expense_versions WHERE id=OLD.current_version_id;
    IF old_from IS NULL OR new_from<=old_to+1 AND old_from<=new_to+1 THEN
      date_from:=least(coalesce(old_from,new_from),new_from); date_to:=greatest(coalesce(old_to,new_to),new_to);
      PERFORM mc.emit_financial_input_event(NEW.store_id,'expense-version:'||NEW.current_version_id,'expense_updated',date_from,date_to,
        p_source_expense_version_id=>NEW.current_version_id);
    ELSE
      PERFORM mc.emit_financial_input_event(NEW.store_id,'expense-version:'||NEW.current_version_id||':old','expense_updated',old_from,old_to,
        p_source_expense_version_id=>NEW.current_version_id);
      PERFORM mc.emit_financial_input_event(NEW.store_id,'expense-version:'||NEW.current_version_id||':new','expense_updated',new_from,new_to,
        p_source_expense_version_id=>NEW.current_version_id);
    END IF;
  ELSIF TG_TABLE_NAME='tax_settings' THEN
    SELECT effective_from INTO date_from FROM mc.tax_settings WHERE id=NEW.id;
    SELECT min(effective_from) INTO next_effective FROM mc.tax_settings
     WHERE business_id=NEW.business_id AND effective_from>date_from;
    FOR selection IN SELECT store.id FROM mc.stores store WHERE store.business_id=NEW.business_id AND store.status='active' LOOP
      SELECT max(report.period_end) INTO max_coverage FROM mc.reports report
       WHERE report.business_id=NEW.business_id AND report.store_id=selection AND report.current_version_id IS NOT NULL;
      IF max_coverage IS NULL OR max_coverage<date_from THEN CONTINUE; END IF;
      date_to:=least(coalesce(next_effective-1,max_coverage),max_coverage);
      IF date_to<date_from THEN CONTINUE; END IF;
      PERFORM mc.emit_financial_input_event(selection,'tax-version:'||NEW.current_version_id||':store:'||selection,
        'tax_updated',date_from,date_to,p_source_tax_setting_version_id=>NEW.current_version_id);
    END LOOP;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION mc.emit_financial_pointer_event() FROM PUBLIC;
CREATE TRIGGER financial_cost_event AFTER UPDATE OF current_version_id ON mc.variant_costs
  FOR EACH ROW EXECUTE FUNCTION mc.emit_financial_pointer_event();
CREATE TRIGGER financial_expense_event AFTER UPDATE OF current_version_id ON mc.expenses
  FOR EACH ROW EXECUTE FUNCTION mc.emit_financial_pointer_event();
CREATE TRIGGER financial_tax_event AFTER UPDATE OF current_version_id ON mc.tax_settings
  FOR EACH ROW EXECUTE FUNCTION mc.emit_financial_pointer_event();

CREATE FUNCTION mc.emit_financial_selection_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mc AS $$
DECLARE date_from date; date_to date; target record;
BEGIN
  FOR target IN SELECT DISTINCT business_id,store_id,selection_id FROM inserted_items LOOP
    SELECT min(period_start),max(period_end) INTO date_from,date_to FROM mc.reports
     WHERE business_id=target.business_id AND store_id=target.store_id AND current_version_id IS NOT NULL;
    IF date_from IS NOT NULL THEN
      PERFORM mc.emit_financial_input_event(target.store_id,
        format('selection-statement:%s:%s',target.selection_id,txid_current()),
        'selection_updated',date_from,date_to,p_source_selection_id=>target.selection_id);
    END IF;
  END LOOP;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION mc.emit_financial_selection_event() FROM PUBLIC;
CREATE TRIGGER financial_selection_event AFTER INSERT ON mc.product_selection_items
  REFERENCING NEW TABLE AS inserted_items FOR EACH STATEMENT EXECUTE FUNCTION mc.emit_financial_selection_event();

CREATE FUNCTION mc.emit_financial_method_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mc AS $$
DECLARE target record; date_from date; date_to date; actor uuid; event_type text;
  prior_business text:=current_setting('app.business_id',true); prior_user text:=current_setting('app.user_id',true);
BEGIN
  IF NEW.code NOT IN ('wb_finance_import','financial_result') THEN RETURN NEW; END IF;
  -- Runtime formulas and saved normalizations are explicitly version-gated.
  -- A future method must install its local compatibility/backfill path before
  -- it can emit recalculation events; silently running v20/v11 is forbidden.
  IF (NEW.code='wb_finance_import' AND NEW.version_no<>11)
     OR (NEW.code='financial_result' AND NEW.version_no<>20) THEN RETURN NEW; END IF;
  event_type:=CASE NEW.code WHEN 'wb_finance_import' THEN 'parser_method_updated' ELSE 'result_method_updated' END;
  FOR target IN SELECT store.business_id,store.id FROM mc.stores store WHERE store.status='active' LOOP
    SELECT min(period_start),max(period_end) INTO date_from,date_to FROM mc.reports
     WHERE business_id=target.business_id AND store_id=target.id AND current_version_id IS NOT NULL;
    IF date_from IS NULL THEN CONTINUE; END IF;
    SELECT user_id INTO actor FROM mc.memberships WHERE business_id=target.business_id AND role IN ('owner','editor')
     ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END,created_at,user_id LIMIT 1;
    IF actor IS NULL THEN CONTINUE; END IF;
    PERFORM set_config('app.business_id',target.business_id::text,true);
    PERFORM set_config('app.user_id',actor::text,true);
    IF NEW.code='wb_finance_import' THEN
      PERFORM mc.emit_financial_input_event(target.id,'parser-method:'||NEW.id||':store:'||target.id,event_type,date_from,date_to,
        p_source_parser_method_version_id=>NEW.id);
    ELSE
      PERFORM mc.emit_financial_input_event(target.id,'result-method:'||NEW.id||':store:'||target.id,event_type,date_from,date_to,
        p_source_result_method_version_id=>NEW.id);
    END IF;
  END LOOP;
  PERFORM set_config('app.business_id',coalesce(prior_business,''),true);
  PERFORM set_config('app.user_id',coalesce(prior_user,''),true);
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION mc.emit_financial_method_event() FROM PUBLIC;
CREATE TRIGGER financial_method_event AFTER INSERT ON mc.method_versions
  FOR EACH ROW EXECUTE FUNCTION mc.emit_financial_method_event();

-- Existing report acceptance emits its event manually in the pipeline; do not
-- attach a report-pointer trigger here, or one accepted version would emit twice.

-- One-time shadow backfill: only persisted successful publications are inputs.
DO $$ DECLARE target record; actor uuid; BEGIN
  FOR target IN
    SELECT publication.business_id,publication.store_id,min(period.period_start) period_start,
           max(period.period_end) period_end,method.id method_version_id
      FROM mc.publications publication JOIN mc.calculation_runs run ON run.id=publication.run_id
      JOIN mc.financial_period_results period ON period.run_id=run.id
      JOIN mc.stores store ON store.id=publication.store_id AND store.status='active'
      CROSS JOIN mc.method_versions method
     WHERE run.status='succeeded' AND method.code='financial_result' AND method.version_no=20
     GROUP BY publication.business_id,publication.store_id,method.id
  LOOP
    SELECT user_id INTO actor FROM mc.memberships WHERE business_id=target.business_id AND role IN ('owner','editor')
     ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END,created_at,user_id LIMIT 1;
    IF actor IS NULL THEN CONTINUE; END IF;
    PERFORM set_config('app.business_id',target.business_id::text,true);
    PERFORM set_config('app.user_id',actor::text,true);
    PERFORM mc.emit_financial_input_event(target.store_id,'shadow-backfill:published-history:store:'||target.store_id,
      'shadow_backfill',target.period_start,target.period_end,p_source_result_method_version_id=>target.method_version_id);
  END LOOP;
END $$;

INSERT INTO mc.schema_migrations(version) VALUES(39);
COMMIT;
