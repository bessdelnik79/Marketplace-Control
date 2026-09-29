BEGIN;

INSERT INTO mc.method_versions(code,version_no,description,parameters,implementation_version)
VALUES
('financial_result',27,'Недельный результат заменяет четыре индивидуальных компонента точно связанного возврата одной алгебраической суммой WB.',
 '{"periodResults":true,"returnCost":"confirmed-composite-link-v2","returnExpenseReversal":"raw-signed-four-fields-single-count-v3","selectedSkuOnly":true,"excludedProductNotice":"count-only-v1","taxPeriodSpecific":true,"negativeSkuTax":"signed-offset-v1","availableResult":"selected-plus-store-v1","deliveryServiceReversal":"signed-expense-reversal-v1"}','financial-result-v27'),
('financial_result',28,'Расчёт произвольного периода заменяет четыре индивидуальных компонента точно связанного возврата одной алгебраической суммой WB.',
 '{"periodResults":true,"targetPeriod":true,"returnCost":"confirmed-composite-link-v2","returnExpenseReversal":"raw-signed-four-fields-single-count-v3","selectedSkuOnly":true,"excludedProductNotice":"count-only-v1","taxPeriodSpecific":true,"negativeSkuTax":"signed-offset-v1","availableResult":"selected-plus-store-v1","deliveryServiceReversal":"signed-expense-reversal-v1"}','financial-result-v28')
ON CONFLICT(code,version_no) DO NOTHING;

DO $evidence_guard$
DECLARE definition text; updated text;
BEGIN
  SELECT pg_get_functiondef('mc.guard_evidence_source()'::regprocedure) INTO definition;
  updated:=replace(definition,
    'run_implementation NOT IN(''financial-result-v25'',''financial-result-v26'')',
    'run_implementation NOT IN(''financial-result-v25'',''financial-result-v26'',''financial-result-v27'',''financial-result-v28'')');
  updated:=replace(updated,
    'IF source_category IS DISTINCT FROM line.category_code',
    'IF run_implementation IN(''financial-result-v27'',''financial-result-v28'') AND EXISTS(
       SELECT 1 FROM mc.financial_components component
       JOIN mc.operation_versions operation ON operation.id=component.operation_version_id
       JOIN mc.operation_links link ON link.from_operation_version_id=operation.id
       JOIN mc.calculation_runs run ON run.id=line.run_id
       WHERE component.id=NEW.financial_component_id AND component.source_field IN(''acquiringFee'',''vw'',''vwNds'',''ppvzReward'')
         AND operation.operation_type=''return'' AND link.status=''confirmed'' AND link.link_type=''return_to_original_sale''
         AND link.method_version_id=run.method_version_id
     ) THEN RAISE EXCEPTION ''linked return individual expense component must be replaced by one aggregate'' USING ERRCODE=''23514''; END IF;
   IF source_category IS DISTINCT FROM line.category_code');
  IF updated=definition OR position('financial-result-v28' in updated)=0
    OR position('linked return individual expense component' in updated)=0 THEN
    RAISE EXCEPTION 'return evidence single-count contract not found'; END IF;
  EXECUTE updated;
END $evidence_guard$;

CREATE OR REPLACE FUNCTION mc.guard_daily_return_expense_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE result_row mc.financial_daily_results; generation_row mc.financial_daily_generations;
  source_operation mc.operation_versions; sale_operation mc.operation_versions; link_row mc.operation_links; raw_row jsonb;
  reversal numeric; control_amount numeric; generation_implementation text;
BEGIN
  SELECT * INTO STRICT generation_row FROM mc.financial_daily_generations WHERE id=NEW.generation_id;
  SELECT implementation_version INTO STRICT generation_implementation FROM mc.method_versions WHERE id=generation_row.result_method_version_id;
  IF NEW.financial_component_id IS NOT NULL AND generation_implementation IN('financial-result-v27','financial-result-v28')
    AND EXISTS(
      SELECT 1 FROM mc.financial_components component
      JOIN mc.operation_versions operation ON operation.id=component.operation_version_id
      JOIN mc.operation_links link ON link.from_operation_version_id=operation.id
      WHERE component.id=NEW.financial_component_id AND component.source_field IN('acquiringFee','vw','vwNds','ppvzReward')
        AND operation.operation_type='return' AND link.status='confirmed' AND link.link_type='return_to_original_sale'
        AND link.method_version_id=generation_row.result_method_version_id
    ) THEN
    RAISE EXCEPTION 'linked daily return individual expense component must be replaced by one aggregate' USING ERRCODE='23514';
  END IF;
  IF NEW.report_row_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO STRICT result_row FROM mc.financial_daily_results WHERE id=NEW.daily_result_id;
  SELECT * INTO STRICT source_operation FROM mc.operation_versions WHERE id=NEW.source_operation_version_id;
  SELECT raw_data INTO STRICT raw_row FROM mc.report_rows WHERE id=NEW.report_row_id;
  SELECT * INTO STRICT link_row FROM mc.operation_links WHERE id=NEW.operation_link_id;
  SELECT * INTO STRICT sale_operation FROM mc.operation_versions WHERE id=link_row.to_operation_version_id;
  reversal:=round(coalesce(nullif(raw_row->>'acquiringFee','')::numeric,0)+coalesce(nullif(raw_row->>'vw','')::numeric,0)
    +coalesce(nullif(raw_row->>'vwNds','')::numeric,0)+coalesce(nullif(raw_row->>'ppvzReward','')::numeric,0),2);
  control_amount:=round(coalesce(nullif(raw_row->>'retailAmount','')::numeric,0)-coalesce(nullif(raw_row->>'forPay','')::numeric,0),2);
  IF result_row.category_code<>'return_wb_expense_reversal' OR result_row.scope<>'selected_products'
    OR source_operation.report_row_id<>NEW.report_row_id OR source_operation.product_id IS DISTINCT FROM result_row.product_id
    OR source_operation.variant_id IS DISTINCT FROM result_row.variant_id OR source_operation.accounting_date<>result_row.accounting_date
    OR source_operation.operation_type<>'return' OR source_operation.state<>'active'
    OR link_row.status<>'confirmed' OR link_row.link_type<>'return_to_original_sale'
    OR link_row.from_operation_version_id<>source_operation.id OR link_row.method_version_id<>generation_row.result_method_version_id
    OR sale_operation.operation_type<>'sale' OR sale_operation.product_id IS DISTINCT FROM source_operation.product_id
    OR sale_operation.variant_id IS DISTINCT FROM source_operation.variant_id OR sale_operation.accounting_date>source_operation.accounting_date
    OR nullif(btrim(raw_row->>'retailAmount'),'') IS NULL OR nullif(btrim(raw_row->>'forPay'),'') IS NULL
    OR reversal=0 OR (generation_implementation NOT IN('financial-result-v25','financial-result-v26','financial-result-v27','financial-result-v28') AND reversal<0)
    OR reversal<>control_amount OR NEW.contribution_amount<>reversal
    OR NOT EXISTS(SELECT 1 FROM mc.financial_daily_generation_products selected WHERE selected.generation_id=NEW.generation_id
      AND selected.product_id=source_operation.product_id AND selected.selected)
    OR NOT EXISTS(SELECT 1 FROM mc.financial_daily_generation_inputs input WHERE input.generation_id=NEW.generation_id
      AND input.report_normalization_id=source_operation.report_normalization_id) THEN
    RAISE EXCEPTION 'daily return expense reversal evidence is invalid' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION mc.guard_signed_tax_period_finish() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE implementation text;
BEGIN
  IF NEW.status='succeeded' THEN
    SELECT implementation_version INTO implementation FROM mc.method_versions WHERE id=NEW.method_version_id;
    IF implementation IN('financial-result-v19','financial-result-v20','financial-result-v21','financial-result-v22','financial-result-v23','financial-result-v24','financial-result-v25','financial-result-v26','financial-result-v27','financial-result-v28') THEN
      IF EXISTS(SELECT 1 FROM mc.tax_computations c WHERE c.run_id=NEW.id GROUP BY c.run_id,c.period_start,c.period_end HAVING sum(c.taxable_base)<0 OR sum(c.tax_amount)<0)
      THEN RAISE EXCEPTION 'signed tax period total must not be negative' USING ERRCODE='23514'; END IF;
    ELSIF EXISTS(SELECT 1 FROM mc.tax_computations c WHERE c.run_id=NEW.id AND c.tax_amount<0) THEN
      RAISE EXCEPTION 'negative product tax requires signed tax methodology' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DO $guards$
DECLARE definition text; updated text;
BEGIN
  SELECT pg_get_functiondef('mc.guard_period_result()'::regprocedure) INTO definition;
  updated:=replace(definition,'''financial-result-v25'',''financial-result-v26'')','''financial-result-v25'',''financial-result-v26'',''financial-result-v27'',''financial-result-v28'')');
  IF updated=definition THEN RAISE EXCEPTION 'guard_period_result v27/v28 contract not found'; END IF; EXECUTE updated;
  SELECT pg_get_functiondef('mc.guard_selected_tax_artifact()'::regprocedure) INTO definition;
  updated:=replace(definition,'''financial-result-v25'',''financial-result-v26'')','''financial-result-v25'',''financial-result-v26'',''financial-result-v27'',''financial-result-v28'')');
  IF updated=definition THEN RAISE EXCEPTION 'guard_selected_tax_artifact v27/v28 contract not found'; END IF; EXECUTE updated;
  SELECT pg_get_functiondef('mc.guard_selected_tax_finish()'::regprocedure) INTO definition;
  updated:=replace(definition,'''financial-result-v25'',''financial-result-v26'')','''financial-result-v25'',''financial-result-v26'',''financial-result-v27'',''financial-result-v28'')');
  IF updated=definition THEN RAISE EXCEPTION 'guard_selected_tax_finish v27/v28 contract not found'; END IF; EXECUTE updated;
  SELECT pg_get_functiondef('mc.guard_run_finish()'::regprocedure) INTO definition;
  updated:=replace(definition,'''financial-result-v23'',''financial-result-v25'')','''financial-result-v23'',''financial-result-v25'',''financial-result-v27'')');
  IF updated=definition THEN RAISE EXCEPTION 'guard_run_finish v27 contract not found'; END IF; EXECUTE updated;
  SELECT pg_get_functiondef('mc.guard_target_period_finish()'::regprocedure) INTO definition;
  updated:=replace(definition,'''financial-result-v24'',''financial-result-v26'')','''financial-result-v24'',''financial-result-v26'',''financial-result-v28'')');
  updated:=replace(updated,'WHEN ''financial-result-v26'' THEN ''wb-finance-v12'' END','WHEN ''financial-result-v26'' THEN ''wb-finance-v12'' WHEN ''financial-result-v28'' THEN ''wb-finance-v12'' END');
  IF updated=definition OR position('WHEN ''financial-result-v28'' THEN ''wb-finance-v12''' in updated)=0 THEN
    RAISE EXCEPTION 'guard_target_period_finish v28 contract not found'; END IF; EXECUTE updated;
  SELECT pg_get_functiondef('mc.financial_daily_shadow_day_compatible(uuid,date)'::regprocedure) INTO definition;
  updated:=replace(definition,'financial-result-v26','financial-result-v28');
  updated:=replace(replace(updated,'generation_method.version_no=26','generation_method.version_no=28'),
    'generation_method.version_no = 26','generation_method.version_no = 28');
  updated:=replace(updated,'legacy_method.version_no BETWEEN 9 AND 26','legacy_method.version_no BETWEEN 9 AND 28');
  IF updated=definition OR position('financial-result-v28' in updated)=0 OR position('generation_method.version_no=28' in replace(updated,' ',''))=0
    OR position('BETWEEN 9 AND 28' in updated)=0
    THEN RAISE EXCEPTION 'daily compatibility v28 contract not found'; END IF; EXECUTE updated;
END $guards$;

CREATE OR REPLACE FUNCTION mc.emit_financial_method_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mc AS $$
DECLARE target record; date_from date; date_to date; actor uuid;
  prior_business text:=current_setting('app.business_id',true); prior_user text:=current_setting('app.user_id',true);
BEGIN
  IF NEW.code<>'financial_result' OR NEW.version_no<>28 THEN RETURN NEW; END IF;
  FOR target IN SELECT business_id,id FROM mc.stores WHERE status='active' LOOP
    SELECT min(period_start),max(period_end) INTO date_from,date_to FROM mc.reports WHERE business_id=target.business_id AND store_id=target.id AND current_version_id IS NOT NULL;
    IF date_from IS NULL OR NOT EXISTS(SELECT 1 FROM mc.product_selections WHERE business_id=target.business_id AND store_id=target.id AND status='confirmed') THEN CONTINUE; END IF;
    SELECT user_id INTO actor FROM mc.memberships WHERE business_id=target.business_id AND role IN ('owner','editor') ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END,created_at,user_id LIMIT 1;
    IF actor IS NULL THEN CONTINUE; END IF;
    PERFORM set_config('app.business_id',target.business_id::text,true); PERFORM set_config('app.user_id',actor::text,true);
    PERFORM mc.emit_financial_input_event(target.id,'result-method:'||NEW.id||':store:'||target.id,'result_method_updated',date_from,date_to,p_source_result_method_version_id=>NEW.id);
  END LOOP;
  PERFORM set_config('app.business_id',coalesce(prior_business,''),true); PERFORM set_config('app.user_id',coalesce(prior_user,''),true);
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION mc.emit_financial_method_event() FROM PUBLIC;

ALTER TABLE mc.stores NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.memberships NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.reports NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.calculation_invalidations NO FORCE ROW LEVEL SECURITY;

DO $backfill$
DECLARE target record; actor uuid; result_method uuid; date_from date; date_to date;
  prior_business text:=current_setting('app.business_id',true); prior_user text:=current_setting('app.user_id',true);
BEGIN
  SELECT id INTO STRICT result_method FROM mc.method_versions WHERE code='financial_result' AND version_no=28;
  FOR target IN SELECT business_id,id FROM mc.stores WHERE status='active' LOOP
    SELECT min(period_start),max(period_end) INTO date_from,date_to FROM mc.reports WHERE business_id=target.business_id AND store_id=target.id AND current_version_id IS NOT NULL;
    IF date_from IS NULL OR NOT EXISTS(SELECT 1 FROM mc.product_selections WHERE business_id=target.business_id AND store_id=target.id AND status='confirmed') THEN CONTINUE; END IF;
    SELECT user_id INTO actor FROM mc.memberships WHERE business_id=target.business_id AND role IN ('owner','editor') ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END,created_at,user_id LIMIT 1;
    IF actor IS NULL THEN CONTINUE; END IF;
    PERFORM set_config('app.business_id',target.business_id::text,true); PERFORM set_config('app.user_id',actor::text,true);
    INSERT INTO mc.calculation_invalidations(business_id,store_id,requested_by,reason,invalidated_at)
      VALUES(target.business_id,target.id,actor,'single_count_return_expense_reversal_v27',clock_timestamp())
      ON CONFLICT(store_id) DO UPDATE SET requested_by=excluded.requested_by,reason=excluded.reason,generation_token=gen_random_uuid(),invalidated_at=excluded.invalidated_at;
    PERFORM mc.emit_financial_input_event(target.id,'financial-result-upgrade:v28:store:'||target.id,'result_method_updated',date_from,date_to,p_source_result_method_version_id=>result_method);
  END LOOP;
  PERFORM set_config('app.business_id',coalesce(prior_business,''),true); PERFORM set_config('app.user_id',coalesce(prior_user,''),true);
END $backfill$;

ALTER TABLE mc.calculation_invalidations FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.reports FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.stores FORCE ROW LEVEL SECURITY;

INSERT INTO mc.schema_migrations(version) VALUES(54);
COMMIT;
