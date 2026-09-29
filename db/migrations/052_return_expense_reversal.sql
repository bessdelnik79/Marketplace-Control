BEGIN;

INSERT INTO mc.financial_categories(code,name,class,is_promotion)
VALUES('return_wb_expense_reversal','Сторно расходов WB при возврате','expense',false)
ON CONFLICT(code) DO NOTHING;

INSERT INTO mc.method_versions(code,version_no,description,parameters,implementation_version)
VALUES
('financial_result',23,'Недельный результат вычитает подтверждённое сторно расходов WB по точно связанному возврату.',
 '{"periodResults":true,"returnCost":"confirmed-composite-link-v2","returnExpenseReversal":"raw-signed-four-fields-round-sum-v1","selectedSkuOnly":true,"excludedProductNotice":"count-only-v1","taxPeriodSpecific":true,"negativeSkuTax":"signed-offset-v1","availableResult":"selected-plus-store-v1","deliveryServiceReversal":"signed-expense-reversal-v1"}','financial-result-v23'),
('financial_result',24,'Расчёт произвольного периода вычитает подтверждённое сторно расходов WB по точно связанному возврату.',
 '{"periodResults":true,"targetPeriod":true,"returnCost":"confirmed-composite-link-v2","returnExpenseReversal":"raw-signed-four-fields-round-sum-v1","selectedSkuOnly":true,"excludedProductNotice":"count-only-v1","taxPeriodSpecific":true,"negativeSkuTax":"signed-offset-v1","availableResult":"selected-plus-store-v1","deliveryServiceReversal":"signed-expense-reversal-v1"}','financial-result-v24')
ON CONFLICT(code,version_no) DO NOTHING;

ALTER TABLE mc.result_evidence ADD COLUMN report_row_id uuid;
ALTER TABLE mc.result_evidence ADD CONSTRAINT result_evidence_report_row_fk
  FOREIGN KEY(business_id,store_id,report_row_id) REFERENCES mc.report_rows(business_id,store_id,id);
ALTER TABLE mc.result_evidence DROP CONSTRAINT result_evidence_one_source;
ALTER TABLE mc.result_evidence ADD CONSTRAINT result_evidence_one_source
  CHECK(num_nonnulls(financial_component_id,cost_version_id,expense_version_id,tax_computation_id,report_row_id)=1);
ALTER TABLE mc.result_evidence DROP CONSTRAINT result_evidence_operation_link_shape;
ALTER TABLE mc.result_evidence ADD CONSTRAINT result_evidence_operation_link_shape CHECK(
  (operation_link_id IS NULL AND report_row_id IS NULL AND (source_operation_version_id IS NULL OR cost_version_id IS NOT NULL))
  OR (cost_version_id IS NOT NULL AND source_operation_version_id IS NOT NULL AND quantity IS NOT NULL AND report_row_id IS NULL)
  OR (report_row_id IS NOT NULL AND source_operation_version_id IS NOT NULL AND operation_link_id IS NOT NULL
      AND cost_version_id IS NULL AND quantity IS NULL)
);

DO $daily_constraints$
DECLARE constraint_name text;
BEGIN
  SELECT conname INTO constraint_name FROM pg_constraint
   WHERE conrelid='mc.financial_daily_evidence'::regclass AND contype='c'
     AND position('cost_version_id IS NULL' in pg_get_constraintdef(oid))>0
     AND position('source_operation_version_id IS NULL' in pg_get_constraintdef(oid))>0
     AND position('operation_link_id IS NULL' in pg_get_constraintdef(oid))>0
     AND position('quantity IS NULL' in pg_get_constraintdef(oid))>0
     AND position('num_nonnulls' in pg_get_constraintdef(oid))=0;
  IF constraint_name IS NULL THEN RAISE EXCEPTION 'financial_daily_evidence shape constraint not found'; END IF;
  EXECUTE format('ALTER TABLE mc.financial_daily_evidence DROP CONSTRAINT %I',constraint_name);
END $daily_constraints$;
ALTER TABLE mc.financial_daily_evidence ADD CONSTRAINT financial_daily_evidence_source_shape CHECK(
  (cost_version_id IS NULL AND report_row_id IS NULL AND source_operation_version_id IS NULL AND operation_link_id IS NULL AND quantity IS NULL)
  OR (cost_version_id IS NOT NULL AND report_row_id IS NULL AND source_operation_version_id IS NOT NULL AND quantity IS NOT NULL)
  OR (report_row_id IS NOT NULL AND cost_version_id IS NULL AND source_operation_version_id IS NOT NULL
      AND operation_link_id IS NOT NULL AND quantity IS NULL)
);

CREATE OR REPLACE FUNCTION mc.guard_confirmed_return_link() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE returned mc.operation_versions; sold mc.operation_versions; return_row jsonb; sale_row jsonb; already_returned numeric;
BEGIN
  IF NEW.status<>'confirmed' THEN RETURN NEW; END IF;
  SELECT * INTO STRICT returned FROM mc.operation_versions WHERE id=NEW.from_operation_version_id;
  SELECT * INTO STRICT sold FROM mc.operation_versions WHERE id=NEW.to_operation_version_id FOR UPDATE;
  SELECT raw_data INTO STRICT return_row FROM mc.report_rows WHERE id=returned.report_row_id;
  SELECT raw_data INTO STRICT sale_row FROM mc.report_rows WHERE id=sold.report_row_id;
  IF NEW.link_type<>'return_to_original_sale' OR returned.operation_type<>'return' OR sold.operation_type<>'sale'
    OR returned.state<>'active' OR sold.state<>'active' OR returned.quantity>=0 OR sold.quantity<=0
    OR returned.product_id IS NULL OR returned.variant_id IS NULL
    OR returned.product_id IS DISTINCT FROM sold.product_id OR returned.variant_id IS DISTINCT FROM sold.variant_id
    OR sold.accounting_date>returned.accounting_date OR nullif(btrim(returned.srid),'') IS NULL
    OR returned.srid IS DISTINCT FROM sold.srid
    OR nullif(btrim(return_row->>'shkId'),'') IS NULL OR return_row->>'shkId' IS DISTINCT FROM sale_row->>'shkId'
    OR nullif(btrim(return_row->>'orderDt'),'') IS NULL OR return_row->>'orderDt' IS DISTINCT FROM sale_row->>'orderDt' THEN
    RAISE EXCEPTION 'confirmed return link does not match its sale evidence' USING ERRCODE='23514'; END IF;
  SELECT coalesce(sum(abs(o.quantity)),0) INTO already_returned FROM mc.operation_links l
    JOIN mc.operation_versions o ON o.id=l.from_operation_version_id
    WHERE l.to_operation_version_id=sold.id AND l.link_type=NEW.link_type AND l.status='confirmed' AND l.method_version_id=NEW.method_version_id;
  IF already_returned+abs(returned.quantity)>sold.quantity THEN
    RAISE EXCEPTION 'confirmed returns exceed original sale quantity' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION mc.guard_p03_run_child() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE request_uuid uuid; line_scope text; line_product uuid; source_product uuid;
  source_quantity numeric; source_normalization uuid; source_report_row uuid;
BEGIN
  IF TG_TABLE_NAME='result_lines' THEN
    SELECT request_id INTO request_uuid FROM mc.calculation_runs WHERE id=NEW.run_id;
    IF request_uuid IS NOT NULL AND NEW.result_scope='selected_product' AND NOT EXISTS(
      SELECT 1 FROM mc.calculation_request_products WHERE request_id=request_uuid AND product_id=NEW.product_id) THEN
      RAISE EXCEPTION 'result product is outside frozen request snapshot' USING ERRCODE='23514'; END IF;
  ELSIF TG_TABLE_NAME='calculation_inputs' THEN
    SELECT request_id INTO request_uuid FROM mc.calculation_runs WHERE id=NEW.run_id;
    IF request_uuid IS NOT NULL AND NOT EXISTS(SELECT 1 FROM mc.calculation_request_inputs i WHERE i.request_id=request_uuid
      AND i.report_normalization_id IS NOT DISTINCT FROM NEW.report_normalization_id
      AND i.report_version_id IS NOT DISTINCT FROM NEW.report_version_id
      AND i.cost_version_id IS NOT DISTINCT FROM NEW.cost_version_id
      AND i.expense_version_id IS NOT DISTINCT FROM NEW.expense_version_id
      AND i.tax_setting_version_id IS NOT DISTINCT FROM NEW.tax_setting_version_id
      AND i.operation_link_id IS NOT DISTINCT FROM NEW.operation_link_id) THEN
      RAISE EXCEPTION 'calculation input is outside frozen request snapshot' USING ERRCODE='23514'; END IF;
  ELSIF TG_TABLE_NAME='result_evidence' AND NEW.cost_version_id IS NOT NULL THEN
    SELECT r.request_id,l.result_scope,l.product_id INTO request_uuid,line_scope,line_product
      FROM mc.result_lines l JOIN mc.calculation_runs r ON r.id=l.run_id WHERE l.id=NEW.result_line_id;
    IF request_uuid IS NOT NULL AND NEW.source_operation_version_id IS NULL THEN
      RAISE EXCEPTION 'cost evidence requires source operation' USING ERRCODE='23514'; END IF;
    IF NEW.source_operation_version_id IS NOT NULL THEN
      SELECT product_id,quantity,report_normalization_id,report_row_id
        INTO source_product,source_quantity,source_normalization,source_report_row
        FROM mc.operation_versions WHERE id=NEW.source_operation_version_id;
      IF line_scope<>'selected_product' OR source_product IS DISTINCT FROM line_product OR NEW.quantity IS DISTINCT FROM source_quantity
        OR NOT EXISTS(SELECT 1 FROM mc.calculation_request_inputs WHERE request_id=request_uuid AND report_normalization_id=source_normalization) THEN
        RAISE EXCEPTION 'cost source operation is outside frozen normalization or quantity' USING ERRCODE='23514'; END IF;
    END IF;
    IF NEW.operation_link_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM mc.calculation_request_inputs
      WHERE request_id=request_uuid AND operation_link_id=NEW.operation_link_id) THEN
      RAISE EXCEPTION 'return link is outside frozen request inputs' USING ERRCODE='23514'; END IF;
  ELSIF TG_TABLE_NAME='result_evidence' AND NEW.report_row_id IS NOT NULL THEN
    SELECT r.request_id,l.result_scope,l.product_id INTO request_uuid,line_scope,line_product
      FROM mc.result_lines l JOIN mc.calculation_runs r ON r.id=l.run_id WHERE l.id=NEW.result_line_id;
    IF NEW.source_operation_version_id IS NULL THEN
      RAISE EXCEPTION 'return reversal evidence requires source operation' USING ERRCODE='23514'; END IF;
    SELECT product_id,report_normalization_id,report_row_id
      INTO source_product,source_normalization,source_report_row
      FROM mc.operation_versions WHERE id=NEW.source_operation_version_id;
    IF line_scope<>'selected_product' OR source_product IS DISTINCT FROM line_product OR NEW.report_row_id IS DISTINCT FROM source_report_row
      OR NOT EXISTS(SELECT 1 FROM mc.calculation_request_inputs WHERE request_id=request_uuid AND report_normalization_id=source_normalization)
      OR NOT EXISTS(SELECT 1 FROM mc.calculation_request_inputs WHERE request_id=request_uuid AND operation_link_id=NEW.operation_link_id) THEN
      RAISE EXCEPTION 'return reversal evidence is outside frozen request inputs' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION mc.guard_evidence_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE line mc.result_lines; source_product uuid; source_variant uuid; source_category text; source_amount numeric;
  cost_date date; date_from date; date_to date; source_state text; request_uuid uuid; source_scope text;
  source_operation mc.operation_versions; sale_operation mc.operation_versions; link_row mc.operation_links; raw_row jsonb;
  reversal numeric; control_amount numeric;
BEGIN
 SELECT * INTO STRICT line FROM mc.result_lines WHERE id=NEW.result_line_id;
 SELECT request_id INTO request_uuid FROM mc.calculation_runs WHERE id=line.run_id;
 IF NEW.tax_computation_id IS NOT NULL THEN
   SELECT product_id,tax_amount INTO source_product,source_amount FROM mc.tax_computations WHERE id=NEW.tax_computation_id AND run_id=line.run_id;
   IF line.result_scope<>'selected_product' OR line.product_id IS DISTINCT FROM source_product OR line.category_code<>'estimated_usn_tax' OR NEW.contribution_amount<>-source_amount
   THEN RAISE EXCEPTION 'tax evidence must match selected product and exact negative tax' USING ERRCODE='23514'; END IF;
 ELSIF NEW.financial_component_id IS NOT NULL THEN
   SELECT o.product_id,o.variant_id,f.category_code,f.amount_signed,f.result_scope_classification INTO source_product,source_variant,source_category,source_amount,source_scope
     FROM mc.financial_components f JOIN mc.operation_versions o ON o.id=f.operation_version_id WHERE f.id=NEW.financial_component_id;
   IF source_category IS DISTINCT FROM line.category_code OR (line.result_scope='selected_product' AND source_product IS DISTINCT FROM line.product_id)
      OR (line.variant_id IS NOT NULL AND source_variant IS DISTINCT FROM line.variant_id) OR NEW.contribution_amount*source_amount<0 OR abs(NEW.contribution_amount)>abs(source_amount)
      OR (line.result_scope='store' AND source_product IS NOT NULL) OR (request_uuid IS NOT NULL AND source_scope<>line.result_scope)
   THEN RAISE EXCEPTION 'financial evidence has incompatible scope, category, variant or amount' USING ERRCODE='23514'; END IF;
 ELSIF NEW.report_row_id IS NOT NULL THEN
   SELECT * INTO STRICT source_operation FROM mc.operation_versions WHERE id=NEW.source_operation_version_id;
   SELECT raw_data INTO STRICT raw_row FROM mc.report_rows WHERE id=NEW.report_row_id;
   SELECT * INTO STRICT link_row FROM mc.operation_links WHERE id=NEW.operation_link_id;
   SELECT * INTO STRICT sale_operation FROM mc.operation_versions WHERE id=link_row.to_operation_version_id;
   reversal:=round(coalesce(nullif(raw_row->>'acquiringFee','')::numeric,0)+coalesce(nullif(raw_row->>'vw','')::numeric,0)
     +coalesce(nullif(raw_row->>'vwNds','')::numeric,0)+coalesce(nullif(raw_row->>'ppvzReward','')::numeric,0),2);
   control_amount:=round(coalesce(nullif(raw_row->>'retailAmount','')::numeric,0)-coalesce(nullif(raw_row->>'forPay','')::numeric,0),2);
   IF line.category_code<>'return_wb_expense_reversal' OR line.result_scope<>'selected_product'
      OR source_operation.report_row_id<>NEW.report_row_id OR source_operation.product_id IS DISTINCT FROM line.product_id
      OR source_operation.variant_id IS DISTINCT FROM line.variant_id OR source_operation.accounting_date<>line.accounting_date
      OR source_operation.operation_type<>'return' OR source_operation.state<>'active'
      OR link_row.status<>'confirmed' OR link_row.link_type<>'return_to_original_sale'
      OR link_row.from_operation_version_id<>source_operation.id OR link_row.method_version_id<>(SELECT method_version_id FROM mc.calculation_runs WHERE id=line.run_id)
      OR sale_operation.operation_type<>'sale' OR sale_operation.product_id IS DISTINCT FROM source_operation.product_id
      OR sale_operation.variant_id IS DISTINCT FROM source_operation.variant_id OR sale_operation.accounting_date>source_operation.accounting_date
      OR nullif(btrim(raw_row->>'retailAmount'),'') IS NULL OR nullif(btrim(raw_row->>'forPay'),'') IS NULL
      OR reversal<=0 OR reversal<>control_amount OR NEW.contribution_amount<>reversal THEN
     RAISE EXCEPTION 'return expense reversal evidence is invalid' USING ERRCODE='23514'; END IF;
 ELSIF NEW.cost_version_id IS NOT NULL THEN
   SELECT c.product_id,c.variant_id,c.effective_from,v.unit_cost INTO source_product,source_variant,cost_date,source_amount FROM mc.cost_versions v JOIN mc.variant_costs c ON c.id=v.cost_id WHERE v.id=NEW.cost_version_id;
   IF line.result_scope<>'selected_product' OR source_product IS DISTINCT FROM line.product_id OR source_variant IS DISTINCT FROM line.variant_id OR line.category_code<>'cost_of_goods'
      OR NEW.quantity IS NULL OR NEW.contribution_amount<>round(-source_amount*NEW.quantity,4)
   THEN RAISE EXCEPTION 'cost evidence must match product, variant, effective date and quantity' USING ERRCODE='23514'; END IF;
   IF NEW.source_operation_version_id IS NULL THEN
     IF cost_date>line.accounting_date OR NEW.operation_link_id IS NOT NULL THEN
       RAISE EXCEPTION 'cost evidence must match product, variant, effective date and quantity' USING ERRCODE='23514'; END IF;
   ELSE
    SELECT * INTO STRICT source_operation FROM mc.operation_versions WHERE id=NEW.source_operation_version_id;
    IF NEW.operation_link_id IS NULL THEN
     IF source_operation.operation_type<>'sale' OR cost_date>source_operation.accounting_date OR NEW.contribution_amount>0 THEN
       RAISE EXCEPTION 'sale cost evidence has invalid sign or effective date' USING ERRCODE='23514'; END IF;
    ELSE
     SELECT * INTO STRICT link_row FROM mc.operation_links WHERE id=NEW.operation_link_id;
     SELECT * INTO STRICT sale_operation FROM mc.operation_versions WHERE id=link_row.to_operation_version_id;
     IF link_row.status<>'confirmed' OR link_row.link_type<>'return_to_original_sale' OR link_row.from_operation_version_id<>source_operation.id
        OR source_operation.operation_type<>'return' OR sale_operation.operation_type<>'sale'
        OR sale_operation.product_id IS DISTINCT FROM source_operation.product_id OR sale_operation.variant_id IS DISTINCT FROM source_operation.variant_id
        OR sale_operation.accounting_date>source_operation.accounting_date OR cost_date>sale_operation.accounting_date OR NEW.contribution_amount<0 THEN
       RAISE EXCEPTION 'return cost evidence has invalid confirmed sale link or cost date' USING ERRCODE='23514'; END IF;
    END IF;
   END IF;
 ELSIF NEW.expense_version_id IS NOT NULL THEN
   SELECT e.product_id,v.category,v.amount,v.period_start,v.period_end,v.state INTO source_product,source_category,source_amount,date_from,date_to,source_state FROM mc.expense_versions v JOIN mc.expenses e ON e.id=v.expense_id WHERE v.id=NEW.expense_version_id;
   IF source_category IS DISTINCT FROM line.category_code OR source_state<>'active' OR line.accounting_date NOT BETWEEN date_from AND date_to OR NEW.contribution_amount>0 OR abs(NEW.contribution_amount)>source_amount
      OR (line.result_scope='selected_product' AND source_product IS DISTINCT FROM line.product_id) OR (line.result_scope='store' AND source_product IS NOT NULL)
   THEN RAISE EXCEPTION 'expense evidence has incompatible scope, period or amount' USING ERRCODE='23514'; END IF;
 END IF; RETURN NEW;
END $$;

CREATE FUNCTION mc.guard_daily_return_expense_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE result_row mc.financial_daily_results; generation_row mc.financial_daily_generations;
  source_operation mc.operation_versions; sale_operation mc.operation_versions; link_row mc.operation_links; raw_row jsonb;
  reversal numeric; control_amount numeric;
BEGIN
  IF NEW.report_row_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO STRICT result_row FROM mc.financial_daily_results WHERE id=NEW.daily_result_id;
  SELECT * INTO STRICT generation_row FROM mc.financial_daily_generations WHERE id=NEW.generation_id;
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
    OR reversal<=0 OR reversal<>control_amount OR NEW.contribution_amount<>reversal
    OR NOT EXISTS(SELECT 1 FROM mc.financial_daily_generation_products selected WHERE selected.generation_id=NEW.generation_id
      AND selected.product_id=source_operation.product_id AND selected.selected)
    OR NOT EXISTS(SELECT 1 FROM mc.financial_daily_generation_inputs input WHERE input.generation_id=NEW.generation_id
      AND input.report_normalization_id=source_operation.report_normalization_id) THEN
    RAISE EXCEPTION 'daily return expense reversal evidence is invalid' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER daily_return_expense_evidence_guard BEFORE INSERT ON mc.financial_daily_evidence
  FOR EACH ROW EXECUTE FUNCTION mc.guard_daily_return_expense_evidence();

CREATE OR REPLACE FUNCTION mc.guard_signed_tax_period_finish() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE implementation text;
BEGIN
  IF NEW.status='succeeded' THEN
    SELECT implementation_version INTO implementation FROM mc.method_versions WHERE id=NEW.method_version_id;
    IF implementation IN('financial-result-v19','financial-result-v20','financial-result-v21','financial-result-v22','financial-result-v23','financial-result-v24') THEN
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
  updated:=replace(definition,'''financial-result-v21'',''financial-result-v22'')','''financial-result-v21'',''financial-result-v22'',''financial-result-v23'',''financial-result-v24'')');
  IF updated=definition THEN RAISE EXCEPTION 'guard_period_result contract not found'; END IF; EXECUTE updated;
  SELECT pg_get_functiondef('mc.guard_selected_tax_artifact()'::regprocedure) INTO definition;
  updated:=replace(definition,'''financial-result-v21'',''financial-result-v22'')','''financial-result-v21'',''financial-result-v22'',''financial-result-v23'',''financial-result-v24'')');
  IF updated=definition THEN RAISE EXCEPTION 'guard_selected_tax_artifact contract not found'; END IF; EXECUTE updated;
  SELECT pg_get_functiondef('mc.guard_selected_tax_finish()'::regprocedure) INTO definition;
  updated:=replace(definition,'''financial-result-v21'',''financial-result-v22'')','''financial-result-v21'',''financial-result-v22'',''financial-result-v23'',''financial-result-v24'')');
  IF updated=definition THEN RAISE EXCEPTION 'guard_selected_tax_finish contract not found'; END IF; EXECUTE updated;
  SELECT pg_get_functiondef('mc.guard_run_finish()'::regprocedure) INTO definition;
  updated:=replace(definition,'''financial-result-v21'')','''financial-result-v21'',''financial-result-v23'')');
  IF updated=definition THEN RAISE EXCEPTION 'guard_run_finish contract not found'; END IF; EXECUTE updated;
  SELECT pg_get_functiondef('mc.guard_target_period_finish()'::regprocedure) INTO definition;
  updated:=replace(definition,'''financial-result-v22'')','''financial-result-v22'',''financial-result-v24'')');
  updated:=replace(updated,'WHEN ''financial-result-v22'' THEN ''wb-finance-v12'' END','WHEN ''financial-result-v22'' THEN ''wb-finance-v12'' WHEN ''financial-result-v24'' THEN ''wb-finance-v12'' END');
  IF updated=definition OR position('financial-result-v24' in updated)=0 THEN RAISE EXCEPTION 'guard_target_period_finish contract not found'; END IF; EXECUTE updated;
  SELECT pg_get_functiondef('mc.financial_daily_shadow_day_compatible(uuid,date)'::regprocedure) INTO definition;
  updated:=replace(definition,'financial-result-v22','financial-result-v24');
  updated:=replace(replace(updated,'generation_method.version_no=22','generation_method.version_no=24'),
    'generation_method.version_no = 22','generation_method.version_no = 24');
  updated:=replace(updated,'legacy_method.version_no BETWEEN 9 AND 22','legacy_method.version_no BETWEEN 9 AND 24');
  IF updated=definition OR position('financial-result-v24' in updated)=0 OR position('generation_method.version_no=24' in replace(updated,' ',''))=0
    OR position('BETWEEN 9 AND 24' in updated)=0
    THEN RAISE EXCEPTION 'daily compatibility contract not found'; END IF; EXECUTE updated;
END $guards$;

CREATE OR REPLACE FUNCTION mc.emit_financial_method_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mc AS $$
DECLARE target record; date_from date; date_to date; actor uuid;
  prior_business text:=current_setting('app.business_id',true); prior_user text:=current_setting('app.user_id',true);
BEGIN
  IF NEW.code<>'financial_result' OR NEW.version_no<>24 THEN RETURN NEW; END IF;
  FOR target IN SELECT business_id,id FROM mc.stores WHERE status='active' LOOP
    SELECT min(period_start),max(period_end) INTO date_from,date_to FROM mc.reports WHERE business_id=target.business_id AND store_id=target.id AND current_version_id IS NOT NULL;
    IF date_from IS NULL THEN CONTINUE; END IF;
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
  SELECT id INTO STRICT result_method FROM mc.method_versions WHERE code='financial_result' AND version_no=24;
  FOR target IN SELECT business_id,id FROM mc.stores WHERE status='active' LOOP
    SELECT min(period_start),max(period_end) INTO date_from,date_to FROM mc.reports WHERE business_id=target.business_id AND store_id=target.id AND current_version_id IS NOT NULL;
    IF date_from IS NULL OR NOT EXISTS(SELECT 1 FROM mc.product_selections WHERE business_id=target.business_id AND store_id=target.id AND status='confirmed') THEN CONTINUE; END IF;
    SELECT user_id INTO actor FROM mc.memberships WHERE business_id=target.business_id AND role IN ('owner','editor') ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END,created_at,user_id LIMIT 1;
    IF actor IS NULL THEN CONTINUE; END IF;
    PERFORM set_config('app.business_id',target.business_id::text,true); PERFORM set_config('app.user_id',actor::text,true);
    INSERT INTO mc.calculation_invalidations(business_id,store_id,requested_by,reason,invalidated_at)
      VALUES(target.business_id,target.id,actor,'return_expense_reversal_v23',clock_timestamp())
      ON CONFLICT(store_id) DO UPDATE SET requested_by=excluded.requested_by,reason=excluded.reason,generation_token=gen_random_uuid(),invalidated_at=excluded.invalidated_at;
    PERFORM mc.emit_financial_input_event(target.id,'financial-result-upgrade:v24:store:'||target.id,'result_method_updated',date_from,date_to,p_source_result_method_version_id=>result_method);
  END LOOP;
  PERFORM set_config('app.business_id',coalesce(prior_business,''),true); PERFORM set_config('app.user_id',coalesce(prior_user,''),true);
END $backfill$;

ALTER TABLE mc.calculation_invalidations FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.reports FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.stores FORCE ROW LEVEL SECURITY;

INSERT INTO mc.schema_migrations(version) VALUES(52);
COMMIT;
