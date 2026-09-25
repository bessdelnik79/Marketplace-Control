BEGIN;

INSERT INTO mc.method_versions(code,version_no,description,parameters,implementation_version)
VALUES('financial_result',4,'Сохранённая оценка УСН по выбранным SKU с доказательствами retailAmount и однократным округлением на SKU.',
  '{"taxMethod":"seller-defined-usn-income-selected-retail-amount-v2","taxPersisted":true,"rounding":"once-per-selected-product"}',
  'financial-result-v4')
ON CONFLICT(code,version_no) DO NOTHING;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM mc.tax_computations) THEN
    RAISE EXCEPTION 'migration 017 requires unused tax computation tables';
  END IF;
END $$;

DROP TABLE mc.tax_basis_evidence;
DROP TABLE mc.tax_computation_segments;
DROP TABLE mc.tax_computations CASCADE;

CREATE TABLE mc.tax_computations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), business_id uuid NOT NULL, store_id uuid NOT NULL,
  run_id uuid NOT NULL, product_id uuid NOT NULL,
  period_start date NOT NULL CHECK(isfinite(period_start)), period_end date NOT NULL CHECK(isfinite(period_end)),
  taxable_base numeric(20,4) NOT NULL, tax_amount numeric(20,4) NOT NULL CHECK(tax_amount>=0),
  method_version_id uuid NOT NULL REFERENCES mc.method_versions(id), created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(business_id,store_id,id), UNIQUE(run_id,product_id), CHECK(period_end>=period_start),
  FOREIGN KEY(business_id,store_id,run_id) REFERENCES mc.calculation_runs(business_id,store_id,id),
  FOREIGN KEY(business_id,store_id,product_id) REFERENCES mc.product_selection_items(business_id,store_id,product_id)
);
CREATE TABLE mc.tax_computation_segments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), business_id uuid NOT NULL, store_id uuid NOT NULL,
  tax_computation_id uuid NOT NULL, tax_setting_version_id uuid NOT NULL,
  segment_start date NOT NULL CHECK(isfinite(segment_start)), segment_end date NOT NULL CHECK(isfinite(segment_end)),
  taxable_base numeric(20,4) NOT NULL, rate_fraction numeric NOT NULL CHECK(rate_fraction BETWEEN 0 AND 1),
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(business_id,store_id,id),
  UNIQUE(tax_computation_id,segment_start,segment_end), CHECK(segment_end>=segment_start),
  FOREIGN KEY(business_id,store_id,tax_computation_id) REFERENCES mc.tax_computations(business_id,store_id,id),
  FOREIGN KEY(business_id,tax_setting_version_id) REFERENCES mc.tax_setting_versions(business_id,id)
);
CREATE TABLE mc.tax_basis_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), business_id uuid NOT NULL, store_id uuid NOT NULL,
  tax_segment_id uuid NOT NULL, financial_component_id uuid NOT NULL,
  taxable_contribution numeric(20,4) NOT NULL, recognition_date date NOT NULL CHECK(isfinite(recognition_date)),
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(business_id,store_id,id),
  UNIQUE(tax_segment_id,financial_component_id),
  FOREIGN KEY(business_id,store_id,tax_segment_id) REFERENCES mc.tax_computation_segments(business_id,store_id,id),
  FOREIGN KEY(business_id,store_id,financial_component_id) REFERENCES mc.financial_components(business_id,store_id,id)
);
ALTER TABLE mc.result_evidence ADD CONSTRAINT result_evidence_tax_computation_fk
  FOREIGN KEY(business_id,store_id,tax_computation_id) REFERENCES mc.tax_computations(business_id,store_id,id);

CREATE FUNCTION mc.guard_selected_tax_artifact() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE run_uuid uuid; request_uuid uuid; product_uuid uuid; computation_uuid uuid; setting_from date;
  next_from date; operation_row mc.operation_versions; component_row mc.financial_components; segment_row mc.tax_computation_segments;
BEGIN
  IF TG_TABLE_NAME='tax_computations' THEN
    run_uuid:=NEW.run_id; product_uuid:=NEW.product_id;
    IF NOT EXISTS(SELECT 1 FROM mc.calculation_runs r WHERE r.id=run_uuid AND r.status='running'
      AND r.period_start=NEW.period_start AND r.period_end=NEW.period_end AND r.method_version_id=NEW.method_version_id) THEN
      RAISE EXCEPTION 'tax computation must match a running calculation period and method' USING ERRCODE='23514';
    END IF;
    SELECT request_id INTO request_uuid FROM mc.calculation_runs WHERE id=run_uuid;
    IF request_uuid IS NULL OR NOT EXISTS(SELECT 1 FROM mc.calculation_request_products WHERE request_id=request_uuid AND product_id=product_uuid) THEN
      RAISE EXCEPTION 'tax computation product is outside frozen request snapshot' USING ERRCODE='23514'; END IF;
  ELSIF TG_TABLE_NAME='tax_computation_segments' THEN
    SELECT run_id,product_id INTO run_uuid,product_uuid FROM mc.tax_computations WHERE id=NEW.tax_computation_id;
    SELECT request_id INTO request_uuid FROM mc.calculation_runs WHERE id=run_uuid AND status='running';
    IF request_uuid IS NULL THEN RAISE EXCEPTION 'calculation is sealed' USING ERRCODE='23514'; END IF;
    IF NOT EXISTS(SELECT 1 FROM mc.calculation_request_inputs WHERE request_id=request_uuid AND tax_setting_version_id=NEW.tax_setting_version_id) THEN
      RAISE EXCEPTION 'tax segment setting is outside frozen request inputs' USING ERRCODE='23514'; END IF;
    SELECT s.effective_from INTO setting_from FROM mc.tax_setting_versions v JOIN mc.tax_settings s ON s.id=v.tax_setting_id
      WHERE v.id=NEW.tax_setting_version_id AND v.state='active' AND v.regime_code='usn_income' AND v.usn_rate_fraction=NEW.rate_fraction;
    SELECT min(s.effective_from) INTO next_from FROM mc.calculation_request_inputs i
      JOIN mc.tax_setting_versions v ON v.id=i.tax_setting_version_id JOIN mc.tax_settings s ON s.id=v.tax_setting_id
      WHERE i.request_id=request_uuid AND s.effective_from>setting_from;
    IF setting_from IS NULL OR NEW.segment_start<>greatest(setting_from,(SELECT period_start FROM mc.calculation_runs WHERE id=run_uuid))
       OR NEW.segment_end<>least(coalesce(next_from-1,(SELECT period_end FROM mc.calculation_runs WHERE id=run_uuid)),(SELECT period_end FROM mc.calculation_runs WHERE id=run_uuid)) THEN
      RAISE EXCEPTION 'tax segment is outside effective setting bounds' USING ERRCODE='23514'; END IF;
  ELSE
    SELECT * INTO STRICT segment_row FROM mc.tax_computation_segments WHERE id=NEW.tax_segment_id;
    SELECT run_id,product_id,id INTO run_uuid,product_uuid,computation_uuid FROM mc.tax_computations WHERE id=segment_row.tax_computation_id;
    IF NOT EXISTS(SELECT 1 FROM mc.calculation_runs WHERE id=run_uuid AND status='running') THEN RAISE EXCEPTION 'calculation is sealed' USING ERRCODE='23514'; END IF;
    SELECT * INTO STRICT component_row FROM mc.financial_components WHERE id=NEW.financial_component_id;
    SELECT * INTO STRICT operation_row FROM mc.operation_versions WHERE id=component_row.operation_version_id;
    IF component_row.source_field<>'retailAmount' OR component_row.result_scope_classification<>'selected_product'
       OR component_row.category_code NOT IN('revenue','revenue_return') OR operation_row.product_id IS DISTINCT FROM product_uuid
       OR NOT ((component_row.category_code='revenue' AND operation_row.operation_type='sale' AND component_row.amount_signed>=0)
            OR (component_row.category_code='revenue_return' AND operation_row.operation_type='return' AND component_row.amount_signed<=0))
       OR operation_row.state='withdrawn' OR operation_row.accounting_date<>NEW.recognition_date
       OR NEW.recognition_date NOT BETWEEN segment_row.segment_start AND segment_row.segment_end
       OR NEW.taxable_contribution<>component_row.amount_signed
       OR NOT EXISTS(SELECT 1 FROM mc.calculation_inputs WHERE run_id=run_uuid AND report_normalization_id=operation_row.report_normalization_id) THEN
      RAISE EXCEPTION 'tax basis evidence is not a verified frozen retailAmount contribution' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tax_computation_guard BEFORE INSERT ON mc.tax_computations FOR EACH ROW EXECUTE FUNCTION mc.guard_selected_tax_artifact();
CREATE TRIGGER tax_segment_guard BEFORE INSERT ON mc.tax_computation_segments FOR EACH ROW EXECUTE FUNCTION mc.guard_selected_tax_artifact();
CREATE TRIGGER tax_basis_guard BEFORE INSERT ON mc.tax_basis_evidence FOR EACH ROW EXECUTE FUNCTION mc.guard_selected_tax_artifact();

CREATE FUNCTION mc.guard_selected_tax_finish() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status='succeeded' AND EXISTS(SELECT 1 FROM mc.tax_computations c WHERE c.run_id=NEW.id AND (
   c.taxable_base<>(SELECT coalesce(sum(s.taxable_base),0) FROM mc.tax_computation_segments s WHERE s.tax_computation_id=c.id)
   OR c.tax_amount<>(SELECT round(coalesce(sum(s.taxable_base*s.rate_fraction),0),4) FROM mc.tax_computation_segments s WHERE s.tax_computation_id=c.id)
   OR EXISTS(SELECT 1 FROM mc.tax_computation_segments s WHERE s.tax_computation_id=c.id AND s.taxable_base<>(SELECT coalesce(sum(e.taxable_contribution),0) FROM mc.tax_basis_evidence e WHERE e.tax_segment_id=s.id))
   OR NOT EXISTS(SELECT 1 FROM mc.tax_computation_segments s WHERE s.tax_computation_id=c.id)
   OR NOT EXISTS(SELECT 1 FROM mc.tax_computation_segments s JOIN mc.tax_basis_evidence e ON e.tax_segment_id=s.id WHERE s.tax_computation_id=c.id)
   OR (c.tax_amount<>0 AND NOT EXISTS(SELECT 1 FROM mc.result_evidence e JOIN mc.result_lines l ON l.id=e.result_line_id WHERE e.tax_computation_id=c.id AND l.run_id=NEW.id))
 )) THEN RAISE EXCEPTION 'tax computation does not reconcile with segments and basis evidence' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER selected_tax_finish_guard BEFORE UPDATE ON mc.calculation_runs FOR EACH ROW EXECUTE FUNCTION mc.guard_selected_tax_finish();

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
  IF EXISTS(SELECT 1 FROM mc.result_lines l LEFT JOIN mc.result_evidence e ON e.result_line_id=l.id WHERE l.run_id=NEW.id GROUP BY l.id,l.amount_signed HAVING count(e.id)=0 OR sum(e.contribution_amount)<>l.amount_signed) THEN
   RAISE EXCEPTION 'result does not reconcile with evidence' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM mc.result_evidence e JOIN mc.result_lines l ON l.id=e.result_line_id JOIN mc.financial_components f ON f.id=e.financial_component_id WHERE l.run_id=NEW.id GROUP BY f.id,f.amount_signed HAVING abs(sum(e.contribution_amount))>abs(f.amount_signed))
    OR EXISTS(SELECT 1 FROM mc.result_evidence e JOIN mc.result_lines l ON l.id=e.result_line_id JOIN mc.expense_versions v ON v.id=e.expense_version_id WHERE l.run_id=NEW.id GROUP BY v.id,v.amount HAVING abs(sum(e.contribution_amount))>v.amount)
    OR EXISTS(SELECT 1 FROM mc.result_evidence e JOIN mc.result_lines l ON l.id=e.result_line_id WHERE l.run_id=NEW.id AND e.cost_version_id IS NOT NULL GROUP BY e.source_operation_version_id HAVING count(*)>1) THEN
   RAISE EXCEPTION 'source amount counted more than once' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM mc.result_evidence e JOIN mc.result_lines l ON l.id=e.result_line_id
    LEFT JOIN mc.financial_components f ON f.id=e.financial_component_id LEFT JOIN mc.operation_versions o ON o.id=f.operation_version_id
    LEFT JOIN mc.report_rows rr ON rr.id=o.report_row_id LEFT JOIN mc.report_normalizations rn ON rn.id=o.report_normalization_id
    WHERE l.run_id=NEW.id AND NOT EXISTS(SELECT 1 FROM mc.calculation_inputs i WHERE i.run_id=NEW.id AND (
      (e.cost_version_id IS NOT NULL AND i.cost_version_id=e.cost_version_id) OR (e.expense_version_id IS NOT NULL AND i.expense_version_id=e.expense_version_id)
      OR (e.tax_computation_id IS NOT NULL AND EXISTS(SELECT 1 FROM mc.tax_computation_segments s WHERE s.tax_computation_id=e.tax_computation_id AND s.tax_setting_version_id=i.tax_setting_version_id))
      OR (e.financial_component_id IS NOT NULL AND (i.report_version_id=rr.report_version_id OR (i.report_normalization_id=o.report_normalization_id AND f.method_version_id=rn.method_version_id)))))) THEN
   RAISE EXCEPTION 'evidence source missing from calculation inputs' USING ERRCODE='23514'; END IF;
 END IF; RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION mc.guard_evidence_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE line mc.result_lines; source_product uuid; source_variant uuid; source_category text; source_amount numeric;
 cost_date date; date_from date; date_to date; source_state text; request_uuid uuid; source_scope text;
BEGIN
 SELECT * INTO STRICT line FROM mc.result_lines WHERE id=NEW.result_line_id;
 SELECT request_id INTO request_uuid FROM mc.calculation_runs WHERE id=line.run_id;
 IF NEW.tax_computation_id IS NOT NULL THEN
   SELECT product_id,tax_amount INTO source_product,source_amount FROM mc.tax_computations WHERE id=NEW.tax_computation_id AND run_id=line.run_id;
   IF line.result_scope<>'selected_product' OR line.product_id IS DISTINCT FROM source_product OR line.category_code<>'estimated_usn_tax'
      OR NEW.contribution_amount<>-source_amount THEN RAISE EXCEPTION 'tax evidence must match selected product and exact negative tax' USING ERRCODE='23514'; END IF;
 ELSIF NEW.financial_component_id IS NOT NULL THEN
   SELECT o.product_id,o.variant_id,f.category_code,f.amount_signed,f.result_scope_classification INTO source_product,source_variant,source_category,source_amount,source_scope
   FROM mc.financial_components f JOIN mc.operation_versions o ON o.id=f.operation_version_id WHERE f.id=NEW.financial_component_id;
   IF source_category IS DISTINCT FROM line.category_code OR (line.result_scope='selected_product' AND source_product IS DISTINCT FROM line.product_id)
      OR (line.variant_id IS NOT NULL AND source_variant IS DISTINCT FROM line.variant_id) OR NEW.contribution_amount*source_amount<0 OR abs(NEW.contribution_amount)>abs(source_amount)
      OR (line.result_scope='store' AND source_product IS NOT NULL) OR (request_uuid IS NOT NULL AND source_scope<>line.result_scope)
   THEN RAISE EXCEPTION 'financial evidence has incompatible scope, category, variant or amount' USING ERRCODE='23514'; END IF;
 ELSIF NEW.cost_version_id IS NOT NULL THEN
   SELECT c.product_id,c.variant_id,c.effective_from,v.unit_cost INTO source_product,source_variant,cost_date,source_amount FROM mc.cost_versions v JOIN mc.variant_costs c ON c.id=v.cost_id WHERE v.id=NEW.cost_version_id;
   IF line.result_scope<>'selected_product' OR source_product IS DISTINCT FROM line.product_id OR source_variant IS DISTINCT FROM line.variant_id OR line.category_code<>'cost_of_goods' OR cost_date>line.accounting_date OR NEW.quantity IS NULL OR NEW.contribution_amount<>round(-source_amount*NEW.quantity,4)
   THEN RAISE EXCEPTION 'cost evidence must match product, variant, effective date and quantity' USING ERRCODE='23514'; END IF;
 ELSIF NEW.expense_version_id IS NOT NULL THEN
   SELECT e.product_id,v.category,v.amount,v.period_start,v.period_end,v.state INTO source_product,source_category,source_amount,date_from,date_to,source_state FROM mc.expense_versions v JOIN mc.expenses e ON e.id=v.expense_id WHERE v.id=NEW.expense_version_id;
   IF source_category IS DISTINCT FROM line.category_code OR source_state<>'active' OR line.accounting_date NOT BETWEEN date_from AND date_to OR NEW.contribution_amount>0 OR abs(NEW.contribution_amount)>source_amount OR (line.result_scope='selected_product' AND source_product IS DISTINCT FROM line.product_id) OR (line.result_scope='store' AND source_product IS NOT NULL)
   THEN RAISE EXCEPTION 'expense evidence has incompatible scope, period or amount' USING ERRCODE='23514'; END IF;
 END IF; RETURN NEW;
END $$;

DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['tax_computations','tax_computation_segments','tax_basis_evidence'] LOOP
 EXECUTE format('CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON mc.%I FOR EACH ROW EXECUTE FUNCTION mc.reject_mutation()',t);
 EXECUTE format('ALTER TABLE mc.%I ENABLE ROW LEVEL SECURITY',t); EXECUTE format('ALTER TABLE mc.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_isolation ON mc.%I USING (business_id=mc.context_business_id()) WITH CHECK (business_id=mc.context_business_id())',t);
END LOOP; END $$;
CREATE INDEX tax_computations_run ON mc.tax_computations(run_id);
CREATE INDEX tax_segments_computation ON mc.tax_computation_segments(tax_computation_id,segment_start);
CREATE INDEX tax_basis_segment ON mc.tax_basis_evidence(tax_segment_id);
CREATE UNIQUE INDEX result_evidence_one_tax_line ON mc.result_evidence(tax_computation_id) WHERE tax_computation_id IS NOT NULL;

-- Existing publications use financial_result v3 and must be recalculated once
-- so the persisted tax evidence and after-tax total become available.
ALTER TABLE mc.stores NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.memberships NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.product_selections NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.reports NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.calculation_requests NO FORCE ROW LEVEL SECURITY;
INSERT INTO mc.calculation_invalidations(business_id,store_id,requested_by,reason)
SELECT s.business_id,s.id,member.user_id,'p03_persisted_tax_upgrade'
FROM mc.stores s
JOIN mc.product_selections ps ON ps.business_id=s.business_id AND ps.store_id=s.id AND ps.status='confirmed'
JOIN LATERAL (
  SELECT m.user_id FROM mc.memberships m WHERE m.business_id=s.business_id
  ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END,m.created_at LIMIT 1
) member ON true
LEFT JOIN mc.calculation_requests q ON q.business_id=s.business_id AND q.store_id=s.id AND q.is_latest
LEFT JOIN mc.method_versions method ON method.id=q.method_version_id
WHERE s.status='active'
  AND EXISTS (SELECT 1 FROM mc.reports r WHERE r.business_id=s.business_id AND r.store_id=s.id AND r.current_version_id IS NOT NULL)
  AND (q.id IS NULL OR method.version_no<4 OR q.status='failed')
ON CONFLICT(store_id) DO UPDATE SET
  requested_by=excluded.requested_by,reason=excluded.reason,generation_token=gen_random_uuid(),invalidated_at=clock_timestamp();
ALTER TABLE mc.calculation_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.reports FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.product_selections FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.stores FORCE ROW LEVEL SECURITY;

INSERT INTO mc.schema_migrations(version) VALUES(17);
COMMIT;
