BEGIN;

INSERT INTO mc.method_versions(code,version_no,description,parameters,implementation_version)
VALUES('financial_result',5,
  'Недельные сохранённые результаты, fail-closed связь возврата с продажей и себестоимость возврата.',
  '{"periodResults":true,"returnCost":"confirmed-composite-link-v1","taxPeriodSpecific":true}',
  'financial-result-v5')
ON CONFLICT(code,version_no) DO NOTHING;

ALTER TABLE mc.calculation_request_inputs ADD COLUMN report_version_id uuid;
ALTER TABLE mc.calculation_request_inputs ADD CONSTRAINT calculation_request_input_report_version_fk
  FOREIGN KEY(business_id,store_id,report_version_id) REFERENCES mc.report_versions(business_id,store_id,id);
ALTER TABLE mc.calculation_request_inputs ADD COLUMN operation_link_id uuid;
ALTER TABLE mc.calculation_request_inputs ADD CONSTRAINT calculation_request_input_link_fk
  FOREIGN KEY(business_id,store_id,operation_link_id) REFERENCES mc.operation_links(business_id,store_id,id);
ALTER TABLE mc.calculation_inputs ADD COLUMN operation_link_id uuid;
ALTER TABLE mc.calculation_inputs ADD CONSTRAINT calculation_input_link_fk
  FOREIGN KEY(business_id,store_id,operation_link_id) REFERENCES mc.operation_links(business_id,store_id,id);

DO $$ DECLARE c record; BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='mc.calculation_request_inputs'::regclass
    AND contype IN('c','u') AND pg_get_constraintdef(oid) LIKE '%report_normalization_id%cost_version_id%expense_version_id%tax_setting_version_id%'
  LOOP EXECUTE format('ALTER TABLE mc.calculation_request_inputs DROP CONSTRAINT %I',c.conname); END LOOP;
END $$;
ALTER TABLE mc.calculation_request_inputs ADD CONSTRAINT calculation_request_input_one_source_v5
  CHECK(num_nonnulls(report_version_id,report_normalization_id,cost_version_id,expense_version_id,tax_setting_version_id,operation_link_id)=1);
CREATE UNIQUE INDEX calculation_request_input_report_unique ON mc.calculation_request_inputs(request_id,report_version_id)
  WHERE report_version_id IS NOT NULL;
CREATE UNIQUE INDEX calculation_request_input_link_unique ON mc.calculation_request_inputs(request_id,operation_link_id)
  WHERE operation_link_id IS NOT NULL;

ALTER TABLE mc.calculation_inputs DROP CONSTRAINT calculation_input_one_source;
ALTER TABLE mc.calculation_inputs ADD CONSTRAINT calculation_input_one_source_v5
  CHECK(num_nonnulls(report_version_id,report_normalization_id,cost_version_id,expense_version_id,tax_setting_version_id,operation_link_id)=1);
CREATE UNIQUE INDEX calculation_input_link_unique ON mc.calculation_inputs(run_id,operation_link_id)
  WHERE operation_link_id IS NOT NULL;

CREATE TABLE mc.financial_period_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), business_id uuid NOT NULL, store_id uuid NOT NULL,
  run_id uuid NOT NULL, period_start date NOT NULL CHECK(isfinite(period_start)),
  period_end date NOT NULL CHECK(isfinite(period_end)), quality text NOT NULL CHECK(quality IN('complete','partial','unavailable')),
  missing_reasons jsonb NOT NULL DEFAULT '[]', totals jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(business_id,store_id,id), UNIQUE(run_id,period_start,period_end),
  FOREIGN KEY(business_id,store_id,run_id) REFERENCES mc.calculation_runs(business_id,store_id,id),
  CHECK(period_end>=period_start), CHECK(jsonb_typeof(missing_reasons)='array'),
  CHECK(totals IS NULL OR jsonb_typeof(totals)='object')
);
ALTER TABLE mc.result_lines ADD COLUMN financial_period_result_id uuid;
ALTER TABLE mc.result_lines ADD CONSTRAINT result_line_period_result_fk
  FOREIGN KEY(business_id,store_id,financial_period_result_id) REFERENCES mc.financial_period_results(business_id,store_id,id);

ALTER TABLE mc.result_evidence ADD COLUMN operation_link_id uuid;
ALTER TABLE mc.result_evidence ADD CONSTRAINT result_evidence_operation_link_fk
  FOREIGN KEY(business_id,store_id,operation_link_id) REFERENCES mc.operation_links(business_id,store_id,id);
ALTER TABLE mc.result_evidence DROP CONSTRAINT result_evidence_operation_only_for_cost;
ALTER TABLE mc.result_evidence ADD CONSTRAINT result_evidence_operation_link_shape
  CHECK((operation_link_id IS NULL) OR (cost_version_id IS NOT NULL AND source_operation_version_id IS NOT NULL));

DO $$ DECLARE c text; BEGIN
  SELECT conname INTO c FROM pg_constraint WHERE conrelid='mc.tax_computations'::regclass AND contype='u'
    AND pg_get_constraintdef(oid)='UNIQUE (run_id, product_id)';
  IF c IS NOT NULL THEN EXECUTE format('ALTER TABLE mc.tax_computations DROP CONSTRAINT %I',c); END IF;
END $$;
ALTER TABLE mc.tax_computations ADD CONSTRAINT tax_computation_period_product_unique
  UNIQUE(run_id,period_start,period_end,product_id);

CREATE FUNCTION mc.guard_period_result() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE run_row mc.calculation_runs; period_row mc.financial_period_results; method_code text;
BEGIN
  IF TG_TABLE_NAME='financial_period_results' THEN
    SELECT * INTO STRICT run_row FROM mc.calculation_runs WHERE id=NEW.run_id;
    IF run_row.status<>'running' OR NEW.period_start<run_row.period_start OR NEW.period_end>run_row.period_end THEN
      RAISE EXCEPTION 'period result must be inside a running calculation' USING ERRCODE='23514'; END IF;
  ELSE
    IF NEW.financial_period_result_id IS NULL THEN
      SELECT m.implementation_version INTO method_code FROM mc.calculation_runs cr JOIN mc.method_versions m ON m.id=cr.method_version_id WHERE cr.id=NEW.run_id;
      IF method_code='financial-result-v5' THEN RAISE EXCEPTION 'v5 result line requires a period result' USING ERRCODE='23514'; END IF;
      RETURN NEW;
    END IF;
    SELECT * INTO STRICT period_row FROM mc.financial_period_results WHERE id=NEW.financial_period_result_id;
    IF period_row.run_id<>NEW.run_id OR NEW.accounting_date NOT BETWEEN period_row.period_start AND period_row.period_end THEN
      RAISE EXCEPTION 'result line is outside its persisted period' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER financial_period_result_guard BEFORE INSERT ON mc.financial_period_results FOR EACH ROW EXECUTE FUNCTION mc.guard_period_result();
CREATE TRIGGER result_line_period_guard BEFORE INSERT ON mc.result_lines FOR EACH ROW EXECUTE FUNCTION mc.guard_period_result();

CREATE FUNCTION mc.guard_confirmed_return_link() RETURNS trigger LANGUAGE plpgsql AS $$
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
    OR sold.accounting_date>=returned.accounting_date OR nullif(btrim(returned.srid),'') IS NULL
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
CREATE TRIGGER confirmed_return_link_guard BEFORE INSERT ON mc.operation_links FOR EACH ROW EXECUTE FUNCTION mc.guard_confirmed_return_link();

CREATE OR REPLACE FUNCTION mc.guard_p03_run_child() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE request_uuid uuid; line_scope text; line_product uuid; source_product uuid;
  source_quantity numeric; source_normalization uuid;
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
      SELECT product_id,quantity,report_normalization_id INTO source_product,source_quantity,source_normalization
        FROM mc.operation_versions WHERE id=NEW.source_operation_version_id;
      IF line_scope<>'selected_product' OR source_product IS DISTINCT FROM line_product OR NEW.quantity IS DISTINCT FROM source_quantity
        OR NOT EXISTS(SELECT 1 FROM mc.calculation_request_inputs WHERE request_id=request_uuid AND report_normalization_id=source_normalization) THEN
        RAISE EXCEPTION 'cost source operation is outside frozen normalization or quantity' USING ERRCODE='23514'; END IF;
    END IF;
    IF NEW.operation_link_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM mc.calculation_request_inputs WHERE request_id=request_uuid AND operation_link_id=NEW.operation_link_id) THEN
      RAISE EXCEPTION 'return link is outside frozen request inputs' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION mc.guard_evidence_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE line mc.result_lines; source_product uuid; source_variant uuid; source_category text; source_amount numeric;
  cost_date date; date_from date; date_to date; source_state text; request_uuid uuid; source_scope text;
  source_operation mc.operation_versions; sale_operation mc.operation_versions; link_row mc.operation_links;
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
        OR sale_operation.accounting_date>=source_operation.accounting_date OR cost_date>sale_operation.accounting_date OR NEW.contribution_amount<0 THEN
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

CREATE OR REPLACE FUNCTION mc.guard_selected_tax_artifact() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE run_uuid uuid; request_uuid uuid; product_uuid uuid; computation_uuid uuid; setting_from date; next_from date;
  operation_row mc.operation_versions; component_row mc.financial_components; segment_row mc.tax_computation_segments; computation_row mc.tax_computations;
  implementation text;
BEGIN
  IF TG_TABLE_NAME='tax_computations' THEN
    run_uuid:=NEW.run_id; product_uuid:=NEW.product_id;
    SELECT m.implementation_version INTO implementation FROM mc.calculation_runs r JOIN mc.method_versions m ON m.id=r.method_version_id
      WHERE r.id=run_uuid AND r.status='running' AND r.method_version_id=NEW.method_version_id;
    IF implementation IS NULL OR (implementation='financial-result-v5' AND NOT EXISTS(SELECT 1 FROM mc.financial_period_results p WHERE p.run_id=run_uuid AND p.period_start=NEW.period_start AND p.period_end=NEW.period_end))
      OR (implementation<>'financial-result-v5' AND NOT EXISTS(SELECT 1 FROM mc.calculation_runs r WHERE r.id=run_uuid AND r.period_start=NEW.period_start AND r.period_end=NEW.period_end)) THEN
      RAISE EXCEPTION 'tax computation must match a persisted running calculation period and method' USING ERRCODE='23514'; END IF;
    SELECT request_id INTO request_uuid FROM mc.calculation_runs WHERE id=run_uuid;
    IF request_uuid IS NULL OR NOT EXISTS(SELECT 1 FROM mc.calculation_request_products WHERE request_id=request_uuid AND product_id=product_uuid) THEN
      RAISE EXCEPTION 'tax computation product is outside frozen request snapshot' USING ERRCODE='23514'; END IF;
  ELSIF TG_TABLE_NAME='tax_computation_segments' THEN
    SELECT * INTO STRICT computation_row FROM mc.tax_computations WHERE id=NEW.tax_computation_id;
    run_uuid:=computation_row.run_id; product_uuid:=computation_row.product_id;
    SELECT request_id INTO request_uuid FROM mc.calculation_runs WHERE id=run_uuid AND status='running';
    IF request_uuid IS NULL THEN RAISE EXCEPTION 'calculation is sealed' USING ERRCODE='23514'; END IF;
    IF NOT EXISTS(SELECT 1 FROM mc.calculation_request_inputs WHERE request_id=request_uuid AND tax_setting_version_id=NEW.tax_setting_version_id) THEN
      RAISE EXCEPTION 'tax segment setting is outside frozen request inputs' USING ERRCODE='23514'; END IF;
    SELECT s.effective_from INTO setting_from FROM mc.tax_setting_versions v JOIN mc.tax_settings s ON s.id=v.tax_setting_id
      WHERE v.id=NEW.tax_setting_version_id AND v.state='active' AND v.regime_code='usn_income' AND v.usn_rate_fraction=NEW.rate_fraction;
    SELECT min(s.effective_from) INTO next_from FROM mc.calculation_request_inputs i JOIN mc.tax_setting_versions v ON v.id=i.tax_setting_version_id JOIN mc.tax_settings s ON s.id=v.tax_setting_id
      WHERE i.request_id=request_uuid AND s.effective_from>setting_from;
    IF setting_from IS NULL OR NEW.segment_start<>greatest(setting_from,computation_row.period_start)
      OR NEW.segment_end<>least(coalesce(next_from-1,computation_row.period_end),computation_row.period_end) THEN
      RAISE EXCEPTION 'tax segment is outside effective setting bounds' USING ERRCODE='23514'; END IF;
  ELSE
    SELECT * INTO STRICT segment_row FROM mc.tax_computation_segments WHERE id=NEW.tax_segment_id;
    SELECT * INTO STRICT computation_row FROM mc.tax_computations WHERE id=segment_row.tax_computation_id;
    run_uuid:=computation_row.run_id; product_uuid:=computation_row.product_id;
    IF NOT EXISTS(SELECT 1 FROM mc.calculation_runs WHERE id=run_uuid AND status='running') THEN RAISE EXCEPTION 'calculation is sealed' USING ERRCODE='23514'; END IF;
    SELECT * INTO STRICT component_row FROM mc.financial_components WHERE id=NEW.financial_component_id;
    SELECT * INTO STRICT operation_row FROM mc.operation_versions WHERE id=component_row.operation_version_id;
    IF component_row.source_field<>'retailAmount' OR component_row.result_scope_classification<>'selected_product'
      OR component_row.category_code NOT IN('revenue','revenue_return') OR operation_row.product_id IS DISTINCT FROM product_uuid
      OR NOT((component_row.category_code='revenue' AND operation_row.operation_type='sale' AND component_row.amount_signed>=0) OR (component_row.category_code='revenue_return' AND operation_row.operation_type='return' AND component_row.amount_signed<=0))
      OR operation_row.state='withdrawn' OR operation_row.accounting_date<>NEW.recognition_date OR NEW.recognition_date NOT BETWEEN segment_row.segment_start AND segment_row.segment_end
      OR NEW.taxable_contribution<>component_row.amount_signed OR NOT EXISTS(SELECT 1 FROM mc.calculation_inputs WHERE run_id=run_uuid AND report_normalization_id=operation_row.report_normalization_id) THEN
      RAISE EXCEPTION 'tax basis evidence is not a verified frozen retailAmount contribution' USING ERRCODE='23514'; END IF;
  END IF; RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION mc.guard_run_finish() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.status<>'running' OR NEW.status NOT IN('succeeded','failed') OR (to_jsonb(OLD)-ARRAY['status','quality','missing_reasons','finished_at']) IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['status','quality','missing_reasons','finished_at']) THEN
   RAISE EXCEPTION 'only finishing a running calculation is allowed' USING ERRCODE='23514'; END IF;
 IF NEW.status='succeeded' THEN
  IF NEW.request_id IS NULL AND NOT EXISTS(SELECT 1 FROM mc.calculation_inputs WHERE run_id=NEW.id AND report_version_id IS NOT NULL) THEN
   RAISE EXCEPTION 'successful calculation needs financial inputs' USING ERRCODE='23514';
  ELSIF NEW.request_id IS NOT NULL AND (NOT EXISTS(SELECT 1 FROM mc.calculation_inputs i JOIN mc.report_normalizations n ON n.id=i.report_normalization_id WHERE i.run_id=NEW.id AND n.status='succeeded')
    OR EXISTS(SELECT 1 FROM mc.calculation_inputs i JOIN mc.report_normalizations n ON n.id=i.report_normalization_id WHERE i.run_id=NEW.id AND n.status<>'succeeded')) THEN
   RAISE EXCEPTION 'successful calculation needs normalized financial inputs' USING ERRCODE='23514'; END IF;
  IF (SELECT implementation_version='financial-result-v5' FROM mc.method_versions WHERE id=NEW.method_version_id) AND NOT EXISTS(SELECT 1 FROM mc.financial_period_results WHERE run_id=NEW.id) THEN
   RAISE EXCEPTION 'v5 calculation requires persisted period results' USING ERRCODE='23514'; END IF;
  IF (SELECT implementation_version='financial-result-v5' FROM mc.method_versions WHERE id=NEW.method_version_id) THEN
   IF EXISTS(
     SELECT 1 FROM mc.financial_period_results pr
     WHERE pr.run_id=NEW.id AND NOT EXISTS(
       SELECT 1 FROM mc.calculation_inputs i JOIN mc.report_versions rv ON rv.id=i.report_version_id JOIN mc.reports rp ON rp.id=rv.report_id
       WHERE i.run_id=NEW.id AND rp.period_start=pr.period_start AND rp.period_end=pr.period_end)
   ) OR EXISTS(
     SELECT 1 FROM mc.calculation_inputs i JOIN mc.report_versions rv ON rv.id=i.report_version_id JOIN mc.reports rp ON rp.id=rv.report_id
     WHERE i.run_id=NEW.id AND NOT EXISTS(
       SELECT 1 FROM mc.financial_period_results pr WHERE pr.run_id=NEW.id AND pr.period_start=rp.period_start AND pr.period_end=rp.period_end)
   ) THEN RAISE EXCEPTION 'period results must match frozen report periods' USING ERRCODE='23514'; END IF;
   IF EXISTS(
     SELECT 1
     FROM mc.financial_period_results pr
     LEFT JOIN LATERAL(
       SELECT count(*)::int AS line_count,
         coalesce(sum(l.amount_signed) FILTER(WHERE l.result_scope='selected_product' AND l.category_code<>'estimated_usn_tax'),0) AS selected_before_tax,
         coalesce(sum(l.amount_signed) FILTER(WHERE l.result_scope='store' AND l.category_code<>'estimated_usn_tax'),0) AS store_before_tax,
         coalesce(-sum(l.amount_signed) FILTER(WHERE l.category_code='estimated_usn_tax'),0) AS estimated_tax,
         bool_and(l.quality=pr.quality) AS line_quality_matches
       FROM mc.result_lines l WHERE l.financial_period_result_id=pr.id
     ) sums ON true
     WHERE pr.run_id=NEW.id AND(
       (pr.quality='complete' AND jsonb_array_length(pr.missing_reasons)<>0)
       OR (pr.quality IN('complete','partial') AND sums.line_count=0)
       OR (pr.quality='partial' AND(jsonb_array_length(pr.missing_reasons)=0 OR sums.line_count=0))
       OR (pr.quality='unavailable' AND(sums.line_count<>0 OR pr.totals IS NOT NULL))
       OR (pr.quality<>'unavailable' AND(
         pr.totals IS NULL OR NOT(pr.totals ?& ARRAY['selectedProductsResultBeforeTax','storeLevelResultBeforeTax','availableResultBeforeTax','estimatedUsnTax','availableResultAfterTax','netProfit'])
         OR pr.totals-ARRAY['selectedProductsResultBeforeTax','storeLevelResultBeforeTax','availableResultBeforeTax','estimatedUsnTax','availableResultAfterTax','netProfit']<>'{}'::jsonb
         OR (pr.totals->>'selectedProductsResultBeforeTax')::numeric IS DISTINCT FROM sums.selected_before_tax
         OR (pr.totals->>'storeLevelResultBeforeTax')::numeric IS DISTINCT FROM sums.store_before_tax
         OR (pr.totals->>'availableResultBeforeTax')::numeric IS DISTINCT FROM sums.selected_before_tax
         OR (pr.totals->>'estimatedUsnTax')::numeric IS DISTINCT FROM sums.estimated_tax
         OR CASE WHEN EXISTS(SELECT 1 FROM mc.tax_computations c WHERE c.run_id=NEW.id AND c.period_start=pr.period_start AND c.period_end=pr.period_end)
              THEN (pr.totals->>'availableResultAfterTax')::numeric IS DISTINCT FROM sums.selected_before_tax-sums.estimated_tax
              ELSE pr.totals->>'availableResultAfterTax' IS NOT NULL END
         OR pr.totals->>'netProfit' IS NOT NULL OR sums.line_quality_matches IS NOT TRUE
       ))
       OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(pr.missing_reasons) reason(value) WHERE value NOT IN(
         'cost_missing','return_original_sale_unmatched','operation_unclassified','product_link_missing',
         'store_component_unallocated','store_expense_unallocated','tax_setting_missing','tax_selected_reference_only',
         'tax_method_unsupported','tax_source_unverified','tax_source_unlinked','tax_base_missing',
         'tax_base_negative_unverified','vat_method_unsupported','report_coverage_incomplete','source_unreconciled'))
     )
   ) THEN RAISE EXCEPTION 'period result totals, quality or reasons do not reconcile' USING ERRCODE='23514'; END IF;
   IF NEW.quality IS DISTINCT FROM(
      SELECT CASE WHEN bool_or(pr.quality='unavailable') THEN 'unavailable'
                  WHEN bool_or(pr.quality='partial') THEN 'partial' ELSE 'complete' END
      FROM mc.financial_period_results pr WHERE pr.run_id=NEW.id
    ) OR NOT(
      NEW.missing_reasons @> (SELECT coalesce(jsonb_agg(reason.value),'[]'::jsonb) FROM(
        SELECT DISTINCT value FROM mc.financial_period_results pr CROSS JOIN LATERAL jsonb_array_elements_text(pr.missing_reasons) item(value)
        WHERE pr.run_id=NEW.id) reason)
      AND NEW.missing_reasons <@ (SELECT coalesce(jsonb_agg(reason.value),'[]'::jsonb) FROM(
        SELECT DISTINCT value FROM mc.financial_period_results pr CROSS JOIN LATERAL jsonb_array_elements_text(pr.missing_reasons) item(value)
        WHERE pr.run_id=NEW.id) reason)
    ) THEN RAISE EXCEPTION 'run quality and reasons do not aggregate persisted periods' USING ERRCODE='23514'; END IF;
  END IF;
  IF EXISTS(SELECT 1 FROM mc.result_lines l LEFT JOIN mc.result_evidence e ON e.result_line_id=l.id WHERE l.run_id=NEW.id GROUP BY l.id,l.amount_signed HAVING count(e.id)=0 OR sum(e.contribution_amount)<>l.amount_signed) THEN
   RAISE EXCEPTION 'result does not reconcile with evidence' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM mc.result_evidence e JOIN mc.result_lines l ON l.id=e.result_line_id JOIN mc.financial_components f ON f.id=e.financial_component_id WHERE l.run_id=NEW.id GROUP BY f.id,f.amount_signed HAVING abs(sum(e.contribution_amount))>abs(f.amount_signed))
    OR EXISTS(SELECT 1 FROM mc.result_evidence e JOIN mc.result_lines l ON l.id=e.result_line_id JOIN mc.expense_versions v ON v.id=e.expense_version_id WHERE l.run_id=NEW.id GROUP BY v.id,v.amount HAVING abs(sum(e.contribution_amount))>v.amount)
    OR EXISTS(SELECT 1 FROM mc.result_evidence e JOIN mc.result_lines l ON l.id=e.result_line_id WHERE l.run_id=NEW.id AND e.cost_version_id IS NOT NULL GROUP BY e.source_operation_version_id HAVING count(*)>1) THEN
   RAISE EXCEPTION 'source amount counted more than once' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM mc.result_evidence e JOIN mc.result_lines l ON l.id=e.result_line_id LEFT JOIN mc.financial_components f ON f.id=e.financial_component_id
    LEFT JOIN mc.operation_versions o ON o.id=f.operation_version_id LEFT JOIN mc.report_rows rr ON rr.id=o.report_row_id LEFT JOIN mc.report_normalizations rn ON rn.id=o.report_normalization_id
    WHERE l.run_id=NEW.id AND NOT(
      (e.cost_version_id IS NOT NULL AND EXISTS(SELECT 1 FROM mc.calculation_inputs i WHERE i.run_id=NEW.id AND i.cost_version_id=e.cost_version_id))
      OR (e.expense_version_id IS NOT NULL AND EXISTS(SELECT 1 FROM mc.calculation_inputs i WHERE i.run_id=NEW.id AND i.expense_version_id=e.expense_version_id))
      OR (e.tax_computation_id IS NOT NULL AND EXISTS(SELECT 1 FROM mc.tax_computation_segments s JOIN mc.calculation_inputs i ON i.tax_setting_version_id=s.tax_setting_version_id WHERE s.tax_computation_id=e.tax_computation_id AND i.run_id=NEW.id))
      OR (e.financial_component_id IS NOT NULL AND EXISTS(SELECT 1 FROM mc.calculation_inputs i WHERE i.run_id=NEW.id AND(i.report_version_id=rr.report_version_id OR(i.report_normalization_id=o.report_normalization_id AND f.method_version_id=rn.method_version_id))))
    )) THEN
   RAISE EXCEPTION 'evidence source missing from calculation inputs' USING ERRCODE='23514'; END IF;
 END IF; RETURN NEW;
END $$;

DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['financial_period_results'] LOOP
 EXECUTE format('CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON mc.%I FOR EACH ROW EXECUTE FUNCTION mc.reject_mutation()',t);
 EXECUTE format('ALTER TABLE mc.%I ENABLE ROW LEVEL SECURITY',t); EXECUTE format('ALTER TABLE mc.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_isolation ON mc.%I USING (business_id=mc.context_business_id()) WITH CHECK (business_id=mc.context_business_id())',t);
END LOOP; END $$;
CREATE INDEX financial_period_results_run ON mc.financial_period_results(run_id,period_start,period_end);
CREATE INDEX result_lines_period_result ON mc.result_lines(financial_period_result_id);
CREATE INDEX result_evidence_operation_link ON mc.result_evidence(operation_link_id) WHERE operation_link_id IS NOT NULL;

ALTER TABLE mc.stores NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.memberships NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.product_selections NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.reports NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.calculation_requests NO FORCE ROW LEVEL SECURITY;
INSERT INTO mc.calculation_invalidations(business_id,store_id,requested_by,reason)
SELECT s.business_id,s.id,member.user_id,'p03_period_return_upgrade'
FROM mc.stores s
JOIN mc.product_selections ps ON ps.business_id=s.business_id AND ps.store_id=s.id AND ps.status='confirmed'
JOIN LATERAL(SELECT m.user_id FROM mc.memberships m WHERE m.business_id=s.business_id
  ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END,m.created_at LIMIT 1) member ON true
LEFT JOIN mc.calculation_requests q ON q.business_id=s.business_id AND q.store_id=s.id AND q.is_latest
LEFT JOIN mc.method_versions method ON method.id=q.method_version_id
WHERE s.status='active' AND EXISTS(SELECT 1 FROM mc.reports r WHERE r.business_id=s.business_id AND r.store_id=s.id AND r.current_version_id IS NOT NULL)
  AND(q.id IS NULL OR method.version_no<5 OR q.status='failed')
ON CONFLICT(store_id) DO UPDATE SET requested_by=excluded.requested_by,reason=excluded.reason,generation_token=gen_random_uuid(),invalidated_at=clock_timestamp();
ALTER TABLE mc.calculation_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.reports FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.product_selections FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.stores FORCE ROW LEVEL SECURITY;

INSERT INTO mc.schema_migrations(version) VALUES(19);
COMMIT;
