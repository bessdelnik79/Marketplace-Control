BEGIN;

-- Negative deliveryService is a WB logistics-expense reversal for every store
-- and period. Old normalizations and results remain immutable.
INSERT INTO mc.method_versions(code,version_no,description,parameters,implementation_version)
VALUES
('wb_finance_import',12,'Отрицательный deliveryService учитывается как сторно логистического расхода WB.',
 '{"dataIssueLifecycle":true,"unverifiedMoneyIssues":true,"storeScope":"missing-product-identifiers-v1","loyaltyCompensation":"reference-only-v1","transportReimbursement":"reference-only-v1","deliveryServiceReversal":"signed-expense-reversal-v1"}','wb-finance-v12'),
('financial_result',21,'Недельный результат учитывает сторно логистического расхода WB.',
 '{"periodResults":true,"returnCost":"confirmed-composite-link-v1","taxPeriodSpecific":true,"zeroSaleTaxBase":"complete-coverage-v1","negativeSkuTax":"signed-offset-v1","availableResult":"selected-plus-store-v1","storeScope":"missing-product-identifiers-v1","loyaltyCompensation":"reference-only-v1","rebillLogisticCost":"reconciliation-only-v1","unclassifiedOperation":"component-quality-v1","transportReimbursement":"reference-only-v1","deliveryServiceReversal":"signed-expense-reversal-v1"}','financial-result-v21'),
('financial_result',22,'Расчёт произвольного периода учитывает сторно логистического расхода WB.',
 '{"periodResults":true,"targetPeriod":true,"returnCost":"confirmed-composite-link-v1","taxPeriodSpecific":true,"zeroSaleTaxBase":"complete-coverage-v1","negativeSkuTax":"signed-offset-v1","availableResult":"selected-plus-store-v1","storeScope":"missing-product-identifiers-v1","loyaltyCompensation":"reference-only-v1","rebillLogisticCost":"reconciliation-only-v1","unclassifiedOperation":"component-quality-v1","transportReimbursement":"reference-only-v1","deliveryServiceReversal":"signed-expense-reversal-v1"}','financial-result-v22')
ON CONFLICT(code,version_no) DO NOTHING;

CREATE OR REPLACE FUNCTION mc.guard_signed_tax_period_finish() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE implementation text;
BEGIN
  IF NEW.status='succeeded' THEN
    SELECT implementation_version INTO implementation FROM mc.method_versions WHERE id=NEW.method_version_id;
    IF implementation IN('financial-result-v19','financial-result-v20','financial-result-v21','financial-result-v22') THEN
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
  updated:=replace(definition,'''financial-result-v15'',''financial-result-v16'',''financial-result-v17'',''financial-result-v18'',''financial-result-v19'',''financial-result-v20'')','''financial-result-v15'',''financial-result-v16'',''financial-result-v17'',''financial-result-v18'',''financial-result-v19'',''financial-result-v20'',''financial-result-v21'',''financial-result-v22'')');
  IF updated=definition THEN RAISE EXCEPTION 'guard_period_result contract not found'; END IF; EXECUTE updated;
  SELECT pg_get_functiondef('mc.guard_selected_tax_artifact()'::regprocedure) INTO definition;
  updated:=replace(definition,'''financial-result-v15'',''financial-result-v16'',''financial-result-v17'',''financial-result-v18'',''financial-result-v19'',''financial-result-v20'')','''financial-result-v15'',''financial-result-v16'',''financial-result-v17'',''financial-result-v18'',''financial-result-v19'',''financial-result-v20'',''financial-result-v21'',''financial-result-v22'')');
  IF updated=definition THEN RAISE EXCEPTION 'guard_selected_tax_artifact contract not found'; END IF; EXECUTE updated;
  SELECT pg_get_functiondef('mc.guard_selected_tax_finish()'::regprocedure) INTO definition;
  updated:=replace(definition,'''financial-result-v15'',''financial-result-v16'',''financial-result-v17'',''financial-result-v18'',''financial-result-v19'',''financial-result-v20'')','''financial-result-v15'',''financial-result-v16'',''financial-result-v17'',''financial-result-v18'',''financial-result-v19'',''financial-result-v20'',''financial-result-v21'',''financial-result-v22'')');
  IF updated=definition THEN RAISE EXCEPTION 'guard_selected_tax_finish contract not found'; END IF; EXECUTE updated;
  SELECT pg_get_functiondef('mc.guard_run_finish()'::regprocedure) INTO definition;
  updated:=replace(definition,'''financial-result-v13'',''financial-result-v15'',''financial-result-v17'',''financial-result-v19'')','''financial-result-v13'',''financial-result-v15'',''financial-result-v17'',''financial-result-v19'',''financial-result-v21'')');
  IF updated=definition THEN RAISE EXCEPTION 'guard_run_finish contract not found'; END IF; EXECUTE updated;
  SELECT pg_get_functiondef('mc.guard_target_period_finish()'::regprocedure) INTO definition;
  updated:=replace(definition,'''financial-result-v14'',''financial-result-v16'',''financial-result-v18'',''financial-result-v20'')','''financial-result-v14'',''financial-result-v16'',''financial-result-v18'',''financial-result-v20'',''financial-result-v22'')');
  updated:=replace(updated,'WHEN ''financial-result-v16'' THEN ''wb-finance-v11'' WHEN ''financial-result-v18'' THEN ''wb-finance-v11'' WHEN ''financial-result-v20'' THEN ''wb-finance-v11'' END','WHEN ''financial-result-v16'' THEN ''wb-finance-v11'' WHEN ''financial-result-v18'' THEN ''wb-finance-v11'' WHEN ''financial-result-v20'' THEN ''wb-finance-v11'' WHEN ''financial-result-v22'' THEN ''wb-finance-v12'' END');
  IF updated=definition OR position('wb-finance-v12' in updated)=0 THEN RAISE EXCEPTION 'guard_target_period_finish contract not found'; END IF; EXECUTE updated;
END $guards$;

CREATE OR REPLACE FUNCTION mc.financial_daily_shadow_day_compatible(p_generation_id uuid,p_accounting_date date)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,mc AS $$
  SELECT EXISTS(
    SELECT 1 FROM mc.financial_daily_generations generation
    JOIN mc.method_versions generation_method ON generation_method.id=generation.result_method_version_id
    JOIN mc.financial_daily_shadow_comparisons comparison ON comparison.generation_id=generation.id
    JOIN mc.calculation_runs legacy_run ON legacy_run.id=comparison.legacy_run_id
    JOIN mc.method_versions legacy_method ON legacy_method.id=legacy_run.method_version_id
    WHERE generation.id=p_generation_id
      AND generation_method.code='financial_result' AND generation_method.version_no=22
      AND generation_method.implementation_version='financial-result-v22'
      AND comparison.status='matched' AND p_accounting_date BETWEEN comparison.period_start AND comparison.period_end
      AND legacy_method.code='financial_result' AND legacy_method.version_no BETWEEN 9 AND 22
      AND legacy_method.implementation_version='financial-result-v'||legacy_method.version_no
      AND legacy_run.request_id IS NOT NULL
      AND NOT EXISTS((SELECT product_id FROM mc.financial_daily_generation_products WHERE generation_id=generation.id AND selected)
        EXCEPT (SELECT product_id FROM mc.calculation_request_products WHERE request_id=legacy_run.request_id))
      AND NOT EXISTS((SELECT product_id FROM mc.calculation_request_products WHERE request_id=legacy_run.request_id)
        EXCEPT (SELECT product_id FROM mc.financial_daily_generation_products WHERE generation_id=generation.id AND selected))
  ) OR EXISTS(
    SELECT 1 FROM mc.financial_daily_generations generation
    JOIN mc.method_versions generation_method ON generation_method.id=generation.result_method_version_id
    JOIN mc.financial_daily_days day ON day.generation_id=generation.id AND day.accounting_date=p_accounting_date
    JOIN mc.financial_daily_generation_inputs input ON input.generation_id=generation.id AND input.source_kind='empty_week'
    JOIN mc.financial_week_coverage coverage ON coverage.id=input.financial_week_coverage_id
      AND coverage.business_id=generation.business_id AND coverage.store_id=generation.store_id
    WHERE generation.id=p_generation_id
      AND generation_method.code='financial_result' AND generation_method.version_no=22
      AND generation_method.implementation_version='financial-result-v22'
      AND day.coverage_complete AND day.quality IN ('complete','partial')
      AND mc.financial_empty_week_evidence_valid(coverage.id,input.empty_confirmation_job_id)
      AND p_accounting_date BETWEEN coverage.week_start AND coverage.week_end
      AND NOT EXISTS(SELECT 1 FROM mc.financial_daily_generation_inputs report_input
        JOIN mc.report_versions report_version ON report_version.id=report_input.report_version_id
        JOIN mc.reports report ON report.id=report_version.report_id
        WHERE report_input.generation_id=generation.id AND report_input.source_kind='report'
          AND p_accounting_date BETWEEN report.period_start AND report.period_end)
  )
$$;

-- The method rows above were inserted while the old trigger intentionally
-- ignored unknown versions. Their one-time cutover is emitted only by the v12
-- normalization completion barrier, avoiding a race with local reprocessing.
CREATE OR REPLACE FUNCTION mc.emit_financial_method_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mc AS $$
DECLARE target record; date_from date; date_to date; actor uuid; event_type text;
  prior_business text:=current_setting('app.business_id',true); prior_user text:=current_setting('app.user_id',true);
BEGIN
  IF NEW.code NOT IN ('wb_finance_import','financial_result') THEN RETURN NEW; END IF;
  IF (NEW.code='wb_finance_import' AND NEW.version_no<>12) OR (NEW.code='financial_result' AND NEW.version_no<>22) THEN RETURN NEW; END IF;
  event_type:=CASE NEW.code WHEN 'wb_finance_import' THEN 'parser_method_updated' ELSE 'result_method_updated' END;
  FOR target IN SELECT business_id,id FROM mc.stores WHERE status='active' LOOP
    SELECT min(period_start),max(period_end) INTO date_from,date_to FROM mc.reports WHERE business_id=target.business_id AND store_id=target.id AND current_version_id IS NOT NULL;
    IF date_from IS NULL THEN CONTINUE; END IF;
    SELECT user_id INTO actor FROM mc.memberships WHERE business_id=target.business_id AND role IN ('owner','editor') ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END,created_at,user_id LIMIT 1;
    IF actor IS NULL THEN CONTINUE; END IF;
    PERFORM set_config('app.business_id',target.business_id::text,true); PERFORM set_config('app.user_id',actor::text,true);
    IF NEW.code='wb_finance_import' THEN
      PERFORM mc.emit_financial_input_event(target.id,'parser-method:'||NEW.id||':store:'||target.id,event_type,date_from,date_to,p_source_parser_method_version_id=>NEW.id);
    ELSE
      PERFORM mc.emit_financial_input_event(target.id,'result-method:'||NEW.id||':store:'||target.id,event_type,date_from,date_to,p_source_result_method_version_id=>NEW.id);
    END IF;
  END LOOP;
  PERFORM set_config('app.business_id',coalesce(prior_business,''),true); PERFORM set_config('app.user_id',coalesce(prior_user,''),true);
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION mc.emit_financial_method_event() FROM PUBLIC;

ALTER TABLE mc.stores NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.memberships NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.connections NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.reports NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.report_versions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.financial_week_coverage NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.financial_week_inventory NO FORCE ROW LEVEL SECURITY;

DO $queue$
DECLARE target record; actor uuid; prior_business text:=current_setting('app.business_id',true); prior_user text:=current_setting('app.user_id',true);
BEGIN
  FOR target IN
    SELECT report.business_id,report.store_id,report.current_version_id report_version_id,
           inventory.coverage_id,inventory.inventory_checksum,connection.credential_generation
    FROM mc.reports report
    JOIN mc.stores store ON store.business_id=report.business_id AND store.id=report.store_id AND store.status='active'
    JOIN mc.report_versions version ON version.id=report.current_version_id AND version.status='accepted'
    JOIN mc.financial_week_inventory inventory ON inventory.business_id=report.business_id
      AND inventory.store_id=report.store_id AND inventory.report_version_id=version.id AND inventory.fetch_status='accepted'
    JOIN mc.financial_week_coverage coverage ON coverage.id=inventory.coverage_id
    JOIN mc.connections connection ON connection.business_id=report.business_id AND connection.store_id=report.store_id
      AND connection.status='active' AND connection.scopes ? 'finance'
    WHERE NOT EXISTS(SELECT 1 FROM mc.report_normalizations normalization
      JOIN mc.method_versions method ON method.id=normalization.method_version_id
      WHERE normalization.report_version_id=version.id AND normalization.status='succeeded'
        AND method.implementation_version='wb-finance-v12')
    ORDER BY report.business_id,report.store_id,report.period_end DESC,report.id
  LOOP
    SELECT user_id INTO actor FROM mc.memberships WHERE business_id=target.business_id AND role IN ('owner','editor')
      ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END,created_at,user_id LIMIT 1;
    IF actor IS NULL THEN CONTINUE; END IF;
    PERFORM set_config('app.business_id',target.business_id::text,true); PERFORM set_config('app.user_id',actor::text,true);
    PERFORM mc.enqueue_job(target.store_id,'financial_report_normalize',
      'financial-report-normalize:'||target.report_version_id||':wb-finance-v12:g'||target.credential_generation||':c'||target.coverage_id,
      jsonb_build_object('schemaVersion',1,'credentialGeneration',target.credential_generation,'coverageId',target.coverage_id,
        'reportVersionId',target.report_version_id,'inventoryChecksum',target.inventory_checksum,'expectedCurrentVersionId',target.report_version_id),
      clock_timestamp(),275,20);
  END LOOP;
  PERFORM set_config('app.business_id',coalesce(prior_business,''),true); PERFORM set_config('app.user_id',coalesce(prior_user,''),true);
END $queue$;

ALTER TABLE mc.financial_week_inventory FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.financial_week_coverage FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.report_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.reports FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.connections FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.stores FORCE ROW LEVEL SECURITY;

INSERT INTO mc.schema_migrations(version) VALUES(51);
COMMIT;
