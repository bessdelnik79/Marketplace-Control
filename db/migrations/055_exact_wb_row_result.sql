BEGIN;

INSERT INTO mc.financial_categories(code,name,class,is_promotion)
VALUES('wb_row_rounding_adjustment','Корректировка округления строки WB','expense',false)
ON CONFLICT(code) DO NOTHING;

INSERT INTO mc.method_versions(code,version_no,description,parameters,implementation_version)
VALUES
('wb_finance_import',13,'Импорт финансового отчёта WB сохраняет исходную точность денежных полей.',
 '{"dataIssueLifecycle":true,"exactSourcePrecision":true,"rowResultRounding":"final-operation-only-v1","storeScope":"missing-product-identifiers-v1","loyaltyCompensation":"reference-only-v1","transportReimbursement":"reference-only-v1","deliveryServiceReversal":"signed-expense-reversal-v1"}','wb-finance-v13'),
('financial_result',29,'Недельный результат округляет только итог каждой строки отчёта WB и сверяет его с forPay.',
 '{"periodResults":true,"rowResult":"exact-source-final-operation-round-v1","rowRoundingAdjustment":"evidenced-scale4-v1","returnCost":"confirmed-composite-link-v2","returnExpenseReversal":"raw-signed-four-fields-single-count-v3","selectedSkuOnly":true,"excludedProductNotice":"count-only-v1","taxPeriodSpecific":true,"negativeSkuTax":"signed-offset-v1","availableResult":"selected-plus-store-v1","deliveryServiceReversal":"signed-expense-reversal-v1"}','financial-result-v29'),
('financial_result',30,'Расчёт произвольного периода округляет только итог каждой строки отчёта WB и сверяет его с forPay.',
 '{"periodResults":true,"targetPeriod":true,"rowResult":"exact-source-final-operation-round-v1","rowRoundingAdjustment":"evidenced-scale4-v1","returnCost":"confirmed-composite-link-v2","returnExpenseReversal":"raw-signed-four-fields-single-count-v3","selectedSkuOnly":true,"excludedProductNotice":"count-only-v1","taxPeriodSpecific":true,"negativeSkuTax":"signed-offset-v1","availableResult":"selected-plus-store-v1","deliveryServiceReversal":"signed-expense-reversal-v1"}','financial-result-v30')
ON CONFLICT(code,version_no) DO NOTHING;

ALTER TABLE mc.financial_components
  ALTER COLUMN amount_signed TYPE numeric USING amount_signed::numeric;

ALTER TABLE mc.result_evidence DROP CONSTRAINT result_evidence_operation_link_shape;
ALTER TABLE mc.result_evidence ADD CONSTRAINT result_evidence_operation_link_shape CHECK(
  (operation_link_id IS NULL AND report_row_id IS NULL AND (source_operation_version_id IS NULL OR cost_version_id IS NOT NULL))
  OR (cost_version_id IS NOT NULL AND source_operation_version_id IS NOT NULL AND quantity IS NOT NULL AND report_row_id IS NULL)
  OR (report_row_id IS NOT NULL AND source_operation_version_id IS NOT NULL
      AND cost_version_id IS NULL AND quantity IS NULL)
);

ALTER TABLE mc.financial_daily_evidence DROP CONSTRAINT financial_daily_evidence_source_shape;
ALTER TABLE mc.financial_daily_evidence ADD CONSTRAINT financial_daily_evidence_source_shape CHECK(
  (cost_version_id IS NULL AND report_row_id IS NULL AND source_operation_version_id IS NULL AND operation_link_id IS NULL AND quantity IS NULL)
  OR (cost_version_id IS NOT NULL AND report_row_id IS NULL AND source_operation_version_id IS NOT NULL AND quantity IS NOT NULL)
  OR (report_row_id IS NOT NULL AND cost_version_id IS NULL AND source_operation_version_id IS NOT NULL AND quantity IS NULL)
);

CREATE FUNCTION mc.expected_wb_row_rounding_adjustment(
  p_operation_version_id uuid,p_result_method_version_id uuid,p_operation_link_id uuid DEFAULT NULL
) RETURNS numeric LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,mc AS $$
DECLARE operation_row mc.operation_versions; raw_row jsonb; result_implementation text; parser_implementation text;
  component record; exact_sum numeric:=0; rounded_sum numeric:=0; payout numeric; payout_count integer:=0;
  reversal numeric:=0; target numeric; transport_zero boolean:=false; link_count integer:=0;
BEGIN
  SELECT * INTO STRICT operation_row FROM mc.operation_versions WHERE id=p_operation_version_id;
  SELECT result_method.implementation_version,parser_method.implementation_version,report_row.raw_data
    INTO result_implementation,parser_implementation,raw_row
    FROM mc.method_versions result_method
    JOIN mc.report_normalizations normalization ON normalization.id=operation_row.report_normalization_id
    JOIN mc.method_versions parser_method ON parser_method.id=normalization.method_version_id
    JOIN mc.report_rows report_row ON report_row.id=operation_row.report_row_id
   WHERE result_method.id=p_result_method_version_id;
  IF result_implementation NOT IN('financial-result-v29','financial-result-v30') OR parser_implementation<>'wb-finance-v13'
    OR operation_row.state<>'active' OR operation_row.operation_type NOT IN('sale','return')
    OR operation_row.product_id IS NULL OR nullif(btrim(raw_row->>'forPay'),'') IS NULL THEN RETURN NULL; END IF;
  IF operation_row.operation_type='sale' AND p_operation_link_id IS NOT NULL THEN RETURN NULL; END IF;
  IF operation_row.operation_type='return' THEN
    SELECT count(*) INTO link_count FROM mc.operation_links link
     WHERE link.id=p_operation_link_id AND link.from_operation_version_id=operation_row.id
       AND link.method_version_id=p_result_method_version_id AND link.status='confirmed'
       AND link.link_type='return_to_original_sale';
    IF link_count<>1 THEN RETURN NULL; END IF;
  END IF;
  SELECT count(*)=3 AND count(DISTINCT source_field)=3 AND coalesce(sum(amount_signed),0)=0
    INTO transport_zero FROM mc.financial_components
   WHERE operation_version_id=operation_row.id AND source_field IN('rebillLogisticCost','vw','vwNds')
  ;
  FOR component IN SELECT * FROM mc.financial_components WHERE operation_version_id=operation_row.id LOOP
    IF component.source_field='forPay' AND component.category_code='payout' THEN
      payout_count:=payout_count+1; payout:=component.amount_signed; CONTINUE;
    END IF;
    IF component.category_code IN('payout','commission','loyalty_compensation','loyalty_discount_reference','rebill_logistic_compensation') THEN CONTINUE; END IF;
    IF transport_zero AND component.source_field IN('vw','vwNds') THEN CONTINUE; END IF;
    IF operation_row.operation_type='return' AND component.source_field IN('acquiringFee','vw','vwNds','ppvzReward') THEN CONTINUE; END IF;
    IF component.result_scope_classification<>'selected_product' OR component.category_code NOT IN(
      'revenue','revenue_return','acquiring','logistics','storage','acceptance','penalty','deduction','commission_adjustment',
      'other_adjustment','promotion','pickup_reward','wb_reward_without_vat','wb_reward_vat','return_wb_expense_reversal'
    ) THEN RETURN NULL; END IF;
    exact_sum:=exact_sum+component.amount_signed;
    rounded_sum:=rounded_sum+round(component.amount_signed,4);
  END LOOP;
  IF payout_count<>1 THEN RETURN NULL; END IF;
  IF operation_row.operation_type='return' THEN
    IF nullif(btrim(raw_row->>'retailAmount'),'') IS NULL THEN RETURN NULL; END IF;
    reversal:=coalesce(nullif(raw_row->>'acquiringFee','')::numeric,0)+coalesce(nullif(raw_row->>'vw','')::numeric,0)
      +coalesce(nullif(raw_row->>'vwNds','')::numeric,0)+coalesce(nullif(raw_row->>'ppvzReward','')::numeric,0);
    IF round(reversal,2)<>round((raw_row->>'retailAmount')::numeric-(raw_row->>'forPay')::numeric,2) THEN RETURN NULL; END IF;
    exact_sum:=exact_sum+reversal; rounded_sum:=rounded_sum+round(reversal,4);
  END IF;
  target:=round(exact_sum,2);
  IF payout<>target THEN RETURN NULL; END IF;
  RETURN target-rounded_sum;
EXCEPTION WHEN no_data_found THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION mc.expected_wb_row_rounding_adjustment(uuid,uuid,uuid) FROM PUBLIC;

DO $p03_guard$
DECLARE definition text; updated text;
BEGIN
  SELECT pg_get_functiondef('mc.guard_p03_run_child()'::regprocedure) INTO definition;
  updated:=replace(definition,
    'OR NOT EXISTS(SELECT 1 FROM mc.calculation_request_inputs WHERE request_id=request_uuid AND operation_link_id=NEW.operation_link_id) THEN',
    'OR (NEW.operation_link_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM mc.calculation_request_inputs WHERE request_id=request_uuid AND operation_link_id=NEW.operation_link_id)) THEN');
  IF updated=definition THEN RAISE EXCEPTION 'guard_p03_run_child exact-row contract not found'; END IF;
  EXECUTE updated;
END $p03_guard$;

DO $evidence_guard$
DECLARE definition text; updated text;
BEGIN
  SELECT pg_get_functiondef('mc.guard_evidence_source()'::regprocedure) INTO definition;
  updated:=replace(definition,
    'run_implementation IN(''financial-result-v27'',''financial-result-v28'')',
    'run_implementation IN(''financial-result-v27'',''financial-result-v28'',''financial-result-v29'',''financial-result-v30'')');
  updated:=replace(updated,
    'OR NEW.contribution_amount*source_amount<0 OR abs(NEW.contribution_amount)>abs(source_amount)',
    'OR NEW.contribution_amount*source_amount<0 OR (CASE WHEN run_implementation IN(''financial-result-v29'',''financial-result-v30'') THEN NEW.contribution_amount<>round(source_amount,4) ELSE abs(NEW.contribution_amount)>abs(source_amount) END)');
  updated:=replace(updated,
    'ELSIF NEW.report_row_id IS NOT NULL THEN',
    'ELSIF NEW.report_row_id IS NOT NULL AND line.category_code=''wb_row_rounding_adjustment'' THEN
   SELECT * INTO STRICT source_operation FROM mc.operation_versions WHERE id=NEW.source_operation_version_id;
   SELECT raw_data INTO STRICT raw_row FROM mc.report_rows WHERE id=NEW.report_row_id;
   IF run_implementation NOT IN(''financial-result-v29'',''financial-result-v30'') OR line.result_scope<>''selected_product''
      OR source_operation.report_row_id<>NEW.report_row_id OR source_operation.product_id IS DISTINCT FROM line.product_id
      OR source_operation.variant_id IS DISTINCT FROM line.variant_id OR source_operation.accounting_date<>line.accounting_date
      OR source_operation.operation_type NOT IN(''sale'',''return'') OR source_operation.state<>''active''
      OR NEW.contribution_amount IS DISTINCT FROM mc.expected_wb_row_rounding_adjustment(
        source_operation.id,(SELECT method_version_id FROM mc.calculation_runs WHERE id=line.run_id),NEW.operation_link_id)
   THEN RAISE EXCEPTION ''WB row rounding evidence is invalid'' USING ERRCODE=''23514''; END IF;
 ELSIF NEW.report_row_id IS NOT NULL THEN');
  updated:=replace(updated,
    'run_implementation NOT IN(''financial-result-v25'',''financial-result-v26'',''financial-result-v27'',''financial-result-v28'')',
    'run_implementation NOT IN(''financial-result-v25'',''financial-result-v26'',''financial-result-v27'',''financial-result-v28'',''financial-result-v29'',''financial-result-v30'')');
  updated:=replace(updated,'reversal:=round(coalesce(', 'reversal:=coalesce(');
  updated:=replace(updated,
    '+coalesce(nullif(raw_row->>''ppvzReward'','''')::numeric,0),2);',
    '+coalesce(nullif(raw_row->>''ppvzReward'','''')::numeric,0);');
  updated:=replace(updated,
    'OR reversal<>control_amount OR NEW.contribution_amount<>reversal THEN',
    'OR round(reversal,2)<>control_amount OR NEW.contribution_amount<>(CASE WHEN run_implementation IN(''financial-result-v29'',''financial-result-v30'') THEN round(reversal,4) ELSE round(reversal,2) END) THEN');
  IF updated=definition OR position('WB row rounding evidence is invalid' in updated)=0
    OR position('financial-result-v30' in updated)=0 THEN
    RAISE EXCEPTION 'guard_evidence_source exact-row contract not found';
  END IF;
  EXECUTE updated;
END $evidence_guard$;

CREATE OR REPLACE FUNCTION mc.guard_daily_return_expense_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE result_row mc.financial_daily_results; generation_row mc.financial_daily_generations;
  source_operation mc.operation_versions; sale_operation mc.operation_versions; link_row mc.operation_links; raw_row jsonb;
  reversal numeric; control_amount numeric; generation_implementation text; expected_adjustment numeric;
BEGIN
  SELECT * INTO STRICT generation_row FROM mc.financial_daily_generations WHERE id=NEW.generation_id;
  SELECT implementation_version INTO STRICT generation_implementation FROM mc.method_versions WHERE id=generation_row.result_method_version_id;
  IF NEW.financial_component_id IS NOT NULL AND generation_implementation IN('financial-result-v27','financial-result-v28','financial-result-v29','financial-result-v30')
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
  IF result_row.category_code='wb_row_rounding_adjustment' THEN
    expected_adjustment:=mc.expected_wb_row_rounding_adjustment(source_operation.id,generation_row.result_method_version_id,NEW.operation_link_id);
    IF generation_implementation NOT IN('financial-result-v29','financial-result-v30') OR result_row.scope<>'selected_products'
      OR source_operation.report_row_id<>NEW.report_row_id OR source_operation.product_id IS DISTINCT FROM result_row.product_id
      OR source_operation.variant_id IS DISTINCT FROM result_row.variant_id OR source_operation.accounting_date<>result_row.accounting_date
      OR source_operation.operation_type NOT IN('sale','return') OR source_operation.state<>'active'
      OR NEW.contribution_amount IS DISTINCT FROM expected_adjustment
      OR NOT EXISTS(SELECT 1 FROM mc.financial_daily_generation_products selected WHERE selected.generation_id=NEW.generation_id
        AND selected.product_id=source_operation.product_id AND selected.selected)
      OR NOT EXISTS(SELECT 1 FROM mc.financial_daily_generation_inputs input WHERE input.generation_id=NEW.generation_id
        AND input.report_normalization_id=source_operation.report_normalization_id) THEN
      RAISE EXCEPTION 'daily WB row rounding evidence is invalid' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO STRICT link_row FROM mc.operation_links WHERE id=NEW.operation_link_id;
  SELECT * INTO STRICT sale_operation FROM mc.operation_versions WHERE id=link_row.to_operation_version_id;
  reversal:=coalesce(nullif(raw_row->>'acquiringFee','')::numeric,0)+coalesce(nullif(raw_row->>'vw','')::numeric,0)
    +coalesce(nullif(raw_row->>'vwNds','')::numeric,0)+coalesce(nullif(raw_row->>'ppvzReward','')::numeric,0);
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
    OR reversal=0 OR (generation_implementation NOT IN('financial-result-v25','financial-result-v26','financial-result-v27','financial-result-v28','financial-result-v29','financial-result-v30') AND reversal<0)
    OR round(reversal,2)<>control_amount OR NEW.contribution_amount<>(CASE WHEN generation_implementation IN('financial-result-v29','financial-result-v30') THEN round(reversal,4) ELSE round(reversal,2) END)
    OR NOT EXISTS(SELECT 1 FROM mc.financial_daily_generation_products selected WHERE selected.generation_id=NEW.generation_id
      AND selected.product_id=source_operation.product_id AND selected.selected)
    OR NOT EXISTS(SELECT 1 FROM mc.financial_daily_generation_inputs input WHERE input.generation_id=NEW.generation_id
      AND input.report_normalization_id=source_operation.report_normalization_id) THEN
    RAISE EXCEPTION 'daily return expense reversal evidence is invalid' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;

DO $guards$
DECLARE definition text; updated text;
BEGIN
  SELECT pg_get_functiondef('mc.guard_signed_tax_period_finish()'::regprocedure) INTO definition;
  updated:=replace(definition,'''financial-result-v27'',''financial-result-v28'')','''financial-result-v27'',''financial-result-v28'',''financial-result-v29'',''financial-result-v30'')');
  IF updated=definition THEN RAISE EXCEPTION 'signed tax v29/v30 contract not found'; END IF; EXECUTE updated;
  SELECT pg_get_functiondef('mc.guard_period_result()'::regprocedure) INTO definition;
  updated:=replace(definition,'''financial-result-v27'',''financial-result-v28'')','''financial-result-v27'',''financial-result-v28'',''financial-result-v29'',''financial-result-v30'')');
  IF updated=definition THEN RAISE EXCEPTION 'period result v29/v30 contract not found'; END IF; EXECUTE updated;
  SELECT pg_get_functiondef('mc.guard_selected_tax_artifact()'::regprocedure) INTO definition;
  updated:=replace(definition,'''financial-result-v27'',''financial-result-v28'')','''financial-result-v27'',''financial-result-v28'',''financial-result-v29'',''financial-result-v30'')');
  IF updated=definition THEN RAISE EXCEPTION 'selected tax artifact v29/v30 contract not found'; END IF; EXECUTE updated;
  SELECT pg_get_functiondef('mc.guard_selected_tax_finish()'::regprocedure) INTO definition;
  updated:=replace(definition,'''financial-result-v27'',''financial-result-v28'')','''financial-result-v27'',''financial-result-v28'',''financial-result-v29'',''financial-result-v30'')');
  IF updated=definition THEN RAISE EXCEPTION 'selected tax finish v29/v30 contract not found'; END IF; EXECUTE updated;
  SELECT pg_get_functiondef('mc.guard_run_finish()'::regprocedure) INTO definition;
  updated:=replace(definition,'''financial-result-v23'',''financial-result-v25'',''financial-result-v27'')','''financial-result-v23'',''financial-result-v25'',''financial-result-v27'',''financial-result-v29'')');
  IF updated=definition THEN RAISE EXCEPTION 'run finish v29 contract not found'; END IF; EXECUTE updated;
  SELECT pg_get_functiondef('mc.guard_target_period_finish()'::regprocedure) INTO definition;
  updated:=replace(definition,'''financial-result-v24'',''financial-result-v26'',''financial-result-v28'')','''financial-result-v24'',''financial-result-v26'',''financial-result-v28'',''financial-result-v30'')');
  updated:=replace(updated,'WHEN ''financial-result-v28'' THEN ''wb-finance-v12'' END','WHEN ''financial-result-v28'' THEN ''wb-finance-v12'' WHEN ''financial-result-v30'' THEN ''wb-finance-v13'' END');
  IF updated=definition OR position('WHEN ''financial-result-v30'' THEN ''wb-finance-v13''' in updated)=0 THEN RAISE EXCEPTION 'target finish v30 contract not found'; END IF; EXECUTE updated;
  SELECT pg_get_functiondef('mc.financial_daily_shadow_day_compatible(uuid,date)'::regprocedure) INTO definition;
  updated:=replace(definition,'financial-result-v28','financial-result-v30');
  updated:=replace(replace(updated,'generation_method.version_no=28','generation_method.version_no=30'),
    'generation_method.version_no = 28','generation_method.version_no = 30');
  updated:=replace(updated,'legacy_method.version_no BETWEEN 9 AND 28','legacy_method.version_no BETWEEN 9 AND 30');
  IF updated=definition OR position('financial-result-v30' in updated)=0 OR position('generation_method.version_no=30' in replace(updated,' ',''))=0
    OR position('BETWEEN 9 AND 30' in updated)=0 THEN RAISE EXCEPTION 'daily compatibility v30 contract not found'; END IF; EXECUTE updated;
END $guards$;

CREATE OR REPLACE FUNCTION mc.emit_financial_method_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mc AS $$
DECLARE target record; date_from date; date_to date; actor uuid;
  prior_business text:=current_setting('app.business_id',true); prior_user text:=current_setting('app.user_id',true);
BEGIN
  IF NEW.code<>'financial_result' OR NEW.version_no<>30 THEN RETURN NEW; END IF;
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
ALTER TABLE mc.connections NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.financial_week_coverage NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.financial_week_inventory NO FORCE ROW LEVEL SECURITY;

DO $refetch$
DECLARE target record; actor uuid;
  prior_business text:=current_setting('app.business_id',true); prior_user text:=current_setting('app.user_id',true);
BEGIN
  FOR target IN
    SELECT inventory.business_id,inventory.store_id,inventory.coverage_id,inventory.external_report_id,
           inventory.inventory_checksum,inventory.period_start,inventory.period_end,connection.credential_generation
      FROM mc.financial_week_inventory inventory
      JOIN mc.financial_week_coverage coverage ON coverage.id=inventory.coverage_id
      JOIN mc.stores store ON store.business_id=inventory.business_id AND store.id=inventory.store_id AND store.status='active'
      JOIN mc.connections connection ON connection.business_id=inventory.business_id AND connection.store_id=inventory.store_id
        AND connection.status='active' AND connection.scopes ? 'finance'
        AND coverage.credential_generation=connection.credential_generation
     WHERE inventory.fetch_status='accepted'
     ORDER BY inventory.business_id,inventory.store_id,inventory.period_end DESC,inventory.external_report_id
  LOOP
    SELECT user_id INTO actor FROM mc.memberships WHERE business_id=target.business_id AND role IN ('owner','editor')
      ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END,created_at,user_id LIMIT 1;
    IF actor IS NULL THEN CONTINUE; END IF;
    PERFORM set_config('app.business_id',target.business_id::text,true); PERFORM set_config('app.user_id',actor::text,true);
    UPDATE mc.financial_week_inventory SET fetch_status='pending',last_error_code=NULL WHERE coverage_id=target.coverage_id AND external_report_id=target.external_report_id;
    UPDATE mc.financial_week_coverage SET coverage_status='fetching',next_retry_at=NULL,last_error_code=NULL,updated_at=clock_timestamp() WHERE id=target.coverage_id;
    PERFORM mc.enqueue_job(target.store_id,'financial_report_fetch',
      format('financial-report-fetch:%s:g%s:r%s:%s:wb-finance-v13',target.store_id,target.credential_generation,target.external_report_id,target.inventory_checksum),
      jsonb_build_object('schemaVersion',1,'credentialGeneration',target.credential_generation,'coverageId',target.coverage_id,'mode','by_report_id',
        'reportId',target.external_report_id,'periodStart',target.period_start,'periodEnd',target.period_end,'inventoryChecksum',target.inventory_checksum),
      clock_timestamp(),300,20);
  END LOOP;
  PERFORM set_config('app.business_id',coalesce(prior_business,''),true); PERFORM set_config('app.user_id',coalesce(prior_user,''),true);
END $refetch$;

ALTER TABLE mc.financial_week_inventory FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.financial_week_coverage FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.connections FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.stores FORCE ROW LEVEL SECURITY;

INSERT INTO mc.schema_migrations(version) VALUES(55);
COMMIT;
