BEGIN;

-- P0.3 separates an immutable WB payload from every reproducible pass that
-- interprets it. Re-running a newer normalizer never mutates old operations.
CREATE TABLE mc.report_normalizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  store_id uuid NOT NULL,
  report_version_id uuid NOT NULL,
  method_version_id uuid NOT NULL REFERENCES mc.method_versions(id),
  normalization_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('succeeded','failed')),
  normalized_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, store_id, id),
  UNIQUE (report_version_id, method_version_id),
  UNIQUE (store_id, normalization_key),
  FOREIGN KEY (business_id, store_id, report_version_id)
    REFERENCES mc.report_versions(business_id, store_id, id)
);

ALTER TABLE mc.operation_versions ADD COLUMN report_normalization_id uuid;
ALTER TABLE mc.operation_versions ADD CONSTRAINT operation_normalization_fk
  FOREIGN KEY (business_id, store_id, report_normalization_id)
  REFERENCES mc.report_normalizations(business_id, store_id, id);

-- These source tables use FORCE RLS and operation_versions is append-only.
-- The migration owner temporarily bypasses both protections only for the
-- deterministic one-time backfill, inside this transaction.
ALTER TABLE mc.report_versions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.report_rows NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.operation_versions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.operation_versions DISABLE TRIGGER immutable_history;

INSERT INTO mc.report_normalizations(
  business_id,store_id,report_version_id,method_version_id,normalization_key,status,normalized_at
)
SELECT rv.business_id,rv.store_id,rv.id,m.id,
  'wb-finance-v1:' || rv.id::text,'succeeded',coalesce(rv.accepted_at,rv.created_at)
FROM mc.report_versions rv
CROSS JOIN mc.method_versions m
WHERE m.code='wb_finance_import' AND m.version_no=1
  AND EXISTS (
    SELECT 1 FROM mc.report_rows rr
    JOIN mc.operation_versions ov ON ov.report_row_id=rr.id
    WHERE rr.report_version_id=rv.id
  )
ON CONFLICT (report_version_id,method_version_id) DO NOTHING;

UPDATE mc.operation_versions ov SET report_normalization_id=rn.id
FROM mc.report_rows rr, mc.report_normalizations rn
WHERE rr.id=ov.report_row_id
  AND rn.report_version_id=rr.report_version_id
  AND rn.normalization_key='wb-finance-v1:' || rr.report_version_id::text
  AND ov.report_normalization_id IS NULL;

ALTER TABLE mc.operation_versions ENABLE TRIGGER immutable_history;
ALTER TABLE mc.operation_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.report_rows FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.report_versions FORCE ROW LEVEL SECURITY;

INSERT INTO mc.financial_categories(code,name,class,is_promotion) VALUES
  ('commission_adjustment','Корректировка вознаграждения Wildberries','expense',false),
  ('wb_reward_without_vat','Вознаграждение Wildberries без НДС — до подтверждения','informational',false),
  ('wb_reward_vat','НДС с вознаграждения Wildberries — до подтверждения','informational',false),
  ('pickup_reward','Возмещение за выдачу и возврат на ПВЗ — до подтверждения','informational',false),
  ('rebill_logistic_compensation','Возмещение перемещения и обработки — до подтверждения','informational',false),
  ('unclassified_financial_field','Неподтверждённое денежное поле WB','informational',false),
  ('estimated_usn_tax','Расчётный налог УСН по доступной базе до уменьшений','expense',false)
ON CONFLICT(code) DO NOTHING;

ALTER TABLE mc.financial_components ADD COLUMN result_scope_classification text NOT NULL DEFAULT 'unclassified'
  CHECK (result_scope_classification IN ('selected_product','store','product_expected','unclassified','reconciliation'));

INSERT INTO mc.method_versions(code,version_no,description,parameters,implementation_version)
VALUES(
  'wb_finance_import',
  2,
  'Консервативная нормализация WB: точные типы продажи/возврата, сохранение направления сторно и раздельные показатели вознаграждения. Неподтверждённые компоненты не делают результат полным.',
  '{"endpoint":"/api/finance/v1/sales-reports/detailed","period":"weekly","accountingDate":"rrDate","classificationVerified":false}',
  'wb-finance-v2'
)
ON CONFLICT(code,version_no) DO NOTHING;

INSERT INTO mc.method_versions(code,version_no,description,parameters,implementation_version)
VALUES(
  'financial_result',
  1,
  'Контракт результата P0.3. До подтверждения методики создаёт только воспроизводимый каркас и не разрешает объявлять расчёт полным.',
  '{"classificationVerified":false,"taxMethodVerified":false,"returnCostLinkVerified":false,"wbReconciliationsVerified":false}',
  'financial-result-v1'
)
ON CONFLICT(code,version_no) DO NOTHING;

-- One row is one desired generation. Its children freeze products and inputs;
-- attempts are calculation_runs and may be retried without changing generation.
CREATE TABLE mc.calculation_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  store_id uuid NOT NULL,
  generation_no bigint NOT NULL CHECK (generation_no > 0),
  selection_id uuid NOT NULL,
  method_version_id uuid NOT NULL REFERENCES mc.method_versions(id),
  period_start date NOT NULL CHECK (isfinite(period_start)),
  period_end date NOT NULL CHECK (isfinite(period_end)),
  input_fingerprint text NOT NULL CHECK (input_fingerprint <> ''),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','running','published','failed','superseded')),
  is_latest boolean NOT NULL DEFAULT true,
  last_error_code text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, store_id, id),
  UNIQUE (store_id, generation_no),
  FOREIGN KEY (business_id, store_id) REFERENCES mc.stores(business_id, id),
  FOREIGN KEY (business_id, store_id, selection_id)
    REFERENCES mc.product_selections(business_id, store_id, id),
  CHECK (period_end >= period_start)
);
CREATE UNIQUE INDEX one_latest_calculation_request
  ON mc.calculation_requests(store_id) WHERE is_latest;

-- Transactional invalidation/outbox. Input writers only mark a store dirty;
-- the app may crash before calculation and safely recover this row on startup.
CREATE TABLE mc.calculation_invalidations (
  store_id uuid PRIMARY KEY,
  business_id uuid NOT NULL,
  requested_by uuid REFERENCES mc.users(id),
  reason text NOT NULL,
  generation_token uuid NOT NULL DEFAULT gen_random_uuid(),
  invalidated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (business_id, store_id),
  FOREIGN KEY (business_id, store_id) REFERENCES mc.stores(business_id, id)
);

CREATE FUNCTION mc.mark_calculation_invalidated() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,mc AS $$
DECLARE target_business uuid; target_store uuid; target_reason text;
BEGIN
  IF TG_TABLE_NAME='tax_settings' THEN
    IF NEW.current_version_id IS NOT DISTINCT FROM OLD.current_version_id THEN RETURN NEW; END IF;
    INSERT INTO mc.calculation_invalidations(business_id,store_id,requested_by,reason,invalidated_at)
      SELECT NEW.business_id,s.id,mc.context_user_id(),'tax_setting_changed',clock_timestamp()
      FROM mc.stores s WHERE s.business_id=NEW.business_id AND s.status='active'
    ON CONFLICT(store_id) DO UPDATE SET requested_by=excluded.requested_by,
      reason=excluded.reason,generation_token=gen_random_uuid(),invalidated_at=excluded.invalidated_at;
    RETURN NEW;
  END IF;
  target_business=NEW.business_id;
  target_store=NEW.store_id;
  target_reason=CASE TG_TABLE_NAME
    WHEN 'reports' THEN 'financial_report_changed'
    WHEN 'variant_costs' THEN 'cost_changed'
    WHEN 'expenses' THEN 'expense_changed'
    ELSE 'selection_changed' END;
  IF TG_TABLE_NAME<>'product_selection_items' THEN
    IF NEW.current_version_id IS NOT DISTINCT FROM OLD.current_version_id THEN RETURN NEW; END IF;
  END IF;
  INSERT INTO mc.calculation_invalidations(business_id,store_id,requested_by,reason,invalidated_at)
    VALUES(target_business,target_store,mc.context_user_id(),target_reason,clock_timestamp())
  ON CONFLICT(store_id) DO UPDATE SET requested_by=excluded.requested_by,
    reason=excluded.reason,generation_token=gen_random_uuid(),invalidated_at=excluded.invalidated_at;
  RETURN NEW;
END $$;
CREATE TRIGGER calculation_report_invalidation AFTER UPDATE OF current_version_id ON mc.reports
  FOR EACH ROW EXECUTE FUNCTION mc.mark_calculation_invalidated();
CREATE TRIGGER calculation_cost_invalidation AFTER UPDATE OF current_version_id ON mc.variant_costs
  FOR EACH ROW EXECUTE FUNCTION mc.mark_calculation_invalidated();
CREATE TRIGGER calculation_expense_invalidation AFTER UPDATE OF current_version_id ON mc.expenses
  FOR EACH ROW EXECUTE FUNCTION mc.mark_calculation_invalidated();
CREATE TRIGGER calculation_tax_invalidation AFTER UPDATE OF current_version_id ON mc.tax_settings
  FOR EACH ROW EXECUTE FUNCTION mc.mark_calculation_invalidated();
CREATE TRIGGER calculation_selection_invalidation AFTER INSERT ON mc.product_selection_items
  FOR EACH ROW EXECUTE FUNCTION mc.mark_calculation_invalidated();

-- Existing eligible stores receive a one-time recovery marker during upgrade.
ALTER TABLE mc.stores NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.memberships NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.product_selections NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.reports NO FORCE ROW LEVEL SECURITY;
INSERT INTO mc.calculation_invalidations(business_id,store_id,requested_by,reason)
SELECT s.business_id,s.id,member.user_id,'p03_upgrade_backfill'
FROM mc.stores s
JOIN mc.product_selections ps ON ps.store_id=s.id AND ps.status='confirmed'
JOIN LATERAL (
  SELECT m.user_id FROM mc.memberships m WHERE m.business_id=s.business_id
  ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END,m.created_at LIMIT 1
) member ON true
WHERE s.status='active' AND EXISTS (
  SELECT 1 FROM mc.reports r WHERE r.store_id=s.id AND r.current_version_id IS NOT NULL
)
ON CONFLICT(store_id) DO NOTHING;
ALTER TABLE mc.reports FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.product_selections FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.stores FORCE ROW LEVEL SECURITY;

ALTER TABLE mc.calculation_invalidations ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mc.calculation_invalidations
  USING (business_id=mc.context_business_id()) WITH CHECK (business_id=mc.context_business_id());

CREATE FUNCTION mc.list_calculation_invalidations()
RETURNS TABLE(store_id uuid,requested_by uuid,generation_token uuid)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,mc AS $$
  SELECT i.store_id,i.requested_by,i.generation_token
  FROM mc.calculation_invalidations i
  WHERE i.requested_by IS NOT NULL
  ORDER BY i.invalidated_at,i.store_id
$$;

CREATE FUNCTION mc.ack_calculation_invalidation(p_user_id uuid,p_store_id uuid,p_generation_token uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mc AS $$
DECLARE target_business uuid;
BEGIN
  SELECT business_id INTO target_business FROM mc.calculation_invalidations
    WHERE store_id=p_store_id AND generation_token=p_generation_token;
  IF target_business IS NULL THEN RETURN false; END IF;
  PERFORM set_config('app.user_id',p_user_id::text,true);
  PERFORM set_config('app.business_id',target_business::text,true);
  IF NOT EXISTS (SELECT 1 FROM mc.memberships
      WHERE business_id=target_business AND user_id=p_user_id) THEN RETURN false; END IF;
  DELETE FROM mc.calculation_invalidations
    WHERE business_id=target_business AND store_id=p_store_id
      AND generation_token=p_generation_token;
  RETURN FOUND;
END $$;

CREATE TABLE mc.calculation_request_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  store_id uuid NOT NULL,
  request_id uuid NOT NULL,
  product_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, store_id, id),
  UNIQUE (request_id, product_id),
  FOREIGN KEY (business_id, store_id, request_id)
    REFERENCES mc.calculation_requests(business_id, store_id, id),
  FOREIGN KEY (business_id, store_id, product_id)
    REFERENCES mc.product_selection_items(business_id, store_id, product_id)
);
CREATE TABLE mc.calculation_request_inputs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  store_id uuid NOT NULL,
  request_id uuid NOT NULL,
  report_normalization_id uuid,
  cost_version_id uuid,
  expense_version_id uuid,
  tax_setting_version_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, store_id, id),
  FOREIGN KEY (business_id, store_id, request_id)
    REFERENCES mc.calculation_requests(business_id, store_id, id),
  FOREIGN KEY (business_id, store_id, report_normalization_id)
    REFERENCES mc.report_normalizations(business_id, store_id, id),
  FOREIGN KEY (business_id, store_id, cost_version_id)
    REFERENCES mc.cost_versions(business_id, store_id, id),
  FOREIGN KEY (business_id, store_id, expense_version_id)
    REFERENCES mc.expense_versions(business_id, store_id, id),
  FOREIGN KEY (business_id, tax_setting_version_id)
    REFERENCES mc.tax_setting_versions(business_id, id),
  CHECK (num_nonnulls(report_normalization_id,cost_version_id,expense_version_id,tax_setting_version_id)=1),
  UNIQUE NULLS NOT DISTINCT (request_id,report_normalization_id,cost_version_id,expense_version_id,tax_setting_version_id)
);

-- Remove only the legacy uniqueness rule that made a failed calculation
-- impossible to retry. Per-request attempt numbers replace it for P0.3.
DO $$ DECLARE constraint_name text; BEGIN
  SELECT conname INTO constraint_name FROM pg_constraint
  WHERE conrelid='mc.calculation_runs'::regclass AND contype='u'
    AND pg_get_constraintdef(oid) =
      'UNIQUE (store_id, input_fingerprint, method_version_id, period_start, period_end)';
  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE mc.calculation_runs DROP CONSTRAINT %I',constraint_name);
  END IF;
END $$;
ALTER TABLE mc.calculation_runs ADD COLUMN request_id uuid;
ALTER TABLE mc.calculation_runs ADD COLUMN attempt_no integer;
ALTER TABLE mc.calculation_runs ADD CONSTRAINT calculation_run_request_fk
  FOREIGN KEY (business_id, store_id, request_id)
  REFERENCES mc.calculation_requests(business_id, store_id, id);
ALTER TABLE mc.calculation_runs ADD CONSTRAINT calculation_run_attempt_shape
  CHECK ((request_id IS NULL AND attempt_no IS NULL)
      OR (request_id IS NOT NULL AND attempt_no IS NOT NULL AND attempt_no > 0));
CREATE UNIQUE INDEX calculation_run_attempt_unique
  ON mc.calculation_runs(request_id,attempt_no) WHERE request_id IS NOT NULL;
CREATE UNIQUE INDEX one_running_calculation_attempt
  ON mc.calculation_runs(request_id) WHERE request_id IS NOT NULL AND status='running';

ALTER TABLE mc.calculation_inputs ADD COLUMN report_normalization_id uuid;
ALTER TABLE mc.calculation_inputs ADD COLUMN tax_setting_version_id uuid;
ALTER TABLE mc.calculation_inputs ADD CONSTRAINT calculation_input_normalization_fk
  FOREIGN KEY (business_id, store_id, report_normalization_id)
  REFERENCES mc.report_normalizations(business_id, store_id, id);
ALTER TABLE mc.calculation_inputs ADD CONSTRAINT calculation_input_tax_fk
  FOREIGN KEY (business_id, tax_setting_version_id)
  REFERENCES mc.tax_setting_versions(business_id, id);
DO $$ DECLARE constraint_name text; BEGIN
  SELECT conname INTO constraint_name FROM pg_constraint
  WHERE conrelid='mc.calculation_inputs'::regclass AND contype='c'
    AND pg_get_constraintdef(oid) LIKE 'CHECK ((num_nonnulls(report_version_id,%';
  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE mc.calculation_inputs DROP CONSTRAINT %I',constraint_name);
  END IF;
END $$;
ALTER TABLE mc.calculation_inputs ADD CONSTRAINT calculation_input_one_source
  CHECK (num_nonnulls(report_version_id,report_normalization_id,cost_version_id,
    expense_version_id,tax_setting_version_id)=1);
CREATE UNIQUE INDEX calculation_input_normalization_unique
  ON mc.calculation_inputs(run_id,report_normalization_id)
  WHERE report_normalization_id IS NOT NULL;
CREATE UNIQUE INDEX calculation_input_tax_unique
  ON mc.calculation_inputs(run_id,tax_setting_version_id)
  WHERE tax_setting_version_id IS NOT NULL;

ALTER TABLE mc.result_lines ALTER COLUMN product_id DROP NOT NULL;
ALTER TABLE mc.result_lines ADD COLUMN result_scope text NOT NULL DEFAULT 'selected_product'
  CHECK (result_scope IN ('selected_product','store'));
ALTER TABLE mc.result_lines ADD CONSTRAINT result_line_explicit_scope
  CHECK ((result_scope='selected_product' AND product_id IS NOT NULL)
      OR (result_scope='store' AND product_id IS NULL AND variant_id IS NULL));

CREATE TABLE mc.operation_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  store_id uuid NOT NULL,
  from_operation_version_id uuid NOT NULL,
  to_operation_version_id uuid NOT NULL,
  link_type text NOT NULL CHECK (link_type IN ('return_to_original_sale')),
  status text NOT NULL CHECK (status IN ('confirmed','rejected','ambiguous')),
  method_version_id uuid NOT NULL REFERENCES mc.method_versions(id),
  evidence jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, store_id, id),
  UNIQUE (from_operation_version_id,link_type,method_version_id),
  FOREIGN KEY (business_id, store_id, from_operation_version_id)
    REFERENCES mc.operation_versions(business_id, store_id, id),
  FOREIGN KEY (business_id, store_id, to_operation_version_id)
    REFERENCES mc.operation_versions(business_id, store_id, id),
  CHECK (from_operation_version_id <> to_operation_version_id)
);

ALTER TABLE mc.result_evidence ADD COLUMN source_operation_version_id uuid;
ALTER TABLE mc.result_evidence ADD CONSTRAINT result_evidence_source_operation_fk
  FOREIGN KEY (business_id, store_id, source_operation_version_id)
  REFERENCES mc.operation_versions(business_id, store_id, id);

CREATE TABLE mc.tax_computations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  store_id uuid NOT NULL,
  run_id uuid NOT NULL,
  tax_setting_version_id uuid NOT NULL,
  tax_year integer NOT NULL CHECK (tax_year BETWEEN 2000 AND 9999),
  period_start date NOT NULL CHECK (isfinite(period_start)),
  period_end date NOT NULL CHECK (isfinite(period_end)),
  taxable_base numeric(20,4) NOT NULL,
  rate_fraction numeric NOT NULL CHECK (rate_fraction BETWEEN 0 AND 1),
  tax_amount numeric(20,4) NOT NULL CHECK (tax_amount >= 0),
  method_version_id uuid NOT NULL REFERENCES mc.method_versions(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, store_id, id),
  UNIQUE (run_id,tax_year),
  FOREIGN KEY (business_id, store_id, run_id)
    REFERENCES mc.calculation_runs(business_id, store_id, id),
  FOREIGN KEY (business_id, tax_setting_version_id)
    REFERENCES mc.tax_setting_versions(business_id, id),
  CHECK (period_end >= period_start),
  CHECK (extract(year FROM period_start)=tax_year AND extract(year FROM period_end)=tax_year)
);
CREATE TABLE mc.tax_computation_segments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  store_id uuid NOT NULL,
  tax_computation_id uuid NOT NULL,
  tax_setting_version_id uuid NOT NULL,
  segment_start date NOT NULL CHECK (isfinite(segment_start)),
  segment_end date NOT NULL CHECK (isfinite(segment_end)),
  taxable_base numeric(20,4) NOT NULL,
  rate_fraction numeric NOT NULL CHECK (rate_fraction BETWEEN 0 AND 1),
  tax_amount numeric(20,4) NOT NULL CHECK (tax_amount >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, store_id, id),
  UNIQUE (tax_computation_id,segment_start,segment_end,tax_setting_version_id),
  FOREIGN KEY (business_id, store_id, tax_computation_id)
    REFERENCES mc.tax_computations(business_id, store_id, id),
  FOREIGN KEY (business_id, tax_setting_version_id)
    REFERENCES mc.tax_setting_versions(business_id, id),
  CHECK (segment_end >= segment_start)
);
CREATE TABLE mc.tax_basis_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  store_id uuid NOT NULL,
  tax_segment_id uuid NOT NULL,
  financial_component_id uuid NOT NULL,
  taxable_contribution numeric(20,4) NOT NULL,
  recognition_date date NOT NULL CHECK (isfinite(recognition_date)),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, store_id, id),
  UNIQUE (tax_segment_id,financial_component_id),
  FOREIGN KEY (business_id, store_id, tax_segment_id)
    REFERENCES mc.tax_computation_segments(business_id, store_id, id),
  FOREIGN KEY (business_id, store_id, financial_component_id)
    REFERENCES mc.financial_components(business_id, store_id, id)
);
ALTER TABLE mc.result_evidence ADD COLUMN tax_computation_id uuid;
ALTER TABLE mc.result_evidence ADD CONSTRAINT result_evidence_tax_computation_fk
  FOREIGN KEY (business_id, store_id, tax_computation_id)
  REFERENCES mc.tax_computations(business_id, store_id, id);
DO $$ DECLARE constraint_name text; BEGIN
  SELECT conname INTO constraint_name FROM pg_constraint
  WHERE conrelid='mc.result_evidence'::regclass AND contype='c'
    AND pg_get_constraintdef(oid) LIKE 'CHECK ((num_nonnulls(financial_component_id,%';
  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE mc.result_evidence DROP CONSTRAINT %I',constraint_name);
  END IF;
END $$;
ALTER TABLE mc.result_evidence ADD CONSTRAINT result_evidence_one_source
  CHECK (num_nonnulls(financial_component_id,cost_version_id,expense_version_id,
    tax_computation_id)=1);
ALTER TABLE mc.result_evidence ADD CONSTRAINT result_evidence_operation_only_for_cost
  CHECK (source_operation_version_id IS NULL OR cost_version_id IS NOT NULL);

-- Request snapshots remain editable only until the first attempt is created.
CREATE FUNCTION mc.guard_request_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM mc.calculation_runs WHERE request_id=NEW.request_id) THEN
    RAISE EXCEPTION 'calculation request snapshot is frozen' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER request_product_freeze BEFORE INSERT ON mc.calculation_request_products
  FOR EACH ROW EXECUTE FUNCTION mc.guard_request_snapshot();
CREATE TRIGGER request_input_freeze BEFORE INSERT ON mc.calculation_request_inputs
  FOR EACH ROW EXECUTE FUNCTION mc.guard_request_snapshot();

CREATE FUNCTION mc.guard_request_run() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE request_row mc.calculation_requests;
BEGIN
  IF NEW.request_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO STRICT request_row FROM mc.calculation_requests WHERE id=NEW.request_id FOR UPDATE;
  IF (NEW.business_id,NEW.store_id,NEW.selection_id,NEW.method_version_id,
      NEW.period_start,NEW.period_end,NEW.input_fingerprint)
    IS DISTINCT FROM
     (request_row.business_id,request_row.store_id,request_row.selection_id,
      request_row.method_version_id,request_row.period_start,request_row.period_end,
      request_row.input_fingerprint) THEN
    RAISE EXCEPTION 'calculation attempt does not match frozen request' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM mc.calculation_request_products WHERE request_id=NEW.request_id)
     OR NOT EXISTS (SELECT 1 FROM mc.calculation_request_inputs WHERE request_id=NEW.request_id
       AND report_normalization_id IS NOT NULL) THEN
    RAISE EXCEPTION 'calculation request snapshot is incomplete' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER calculation_request_run_guard BEFORE INSERT ON mc.calculation_runs
  FOR EACH ROW EXECUTE FUNCTION mc.guard_request_run();

CREATE FUNCTION mc.guard_p03_run_child() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE request_uuid uuid; line_scope text; line_product uuid; source_product uuid;
  source_quantity numeric; source_normalization uuid;
BEGIN
  IF TG_TABLE_NAME='result_lines' THEN
    SELECT request_id INTO request_uuid FROM mc.calculation_runs WHERE id=NEW.run_id;
    IF request_uuid IS NOT NULL AND NEW.result_scope='selected_product'
       AND NOT EXISTS (SELECT 1 FROM mc.calculation_request_products
         WHERE request_id=request_uuid AND product_id=NEW.product_id) THEN
      RAISE EXCEPTION 'result product is outside frozen request snapshot' USING ERRCODE='23514';
    END IF;
  ELSIF TG_TABLE_NAME='calculation_inputs' THEN
    SELECT request_id INTO request_uuid FROM mc.calculation_runs WHERE id=NEW.run_id;
    IF request_uuid IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM mc.calculation_request_inputs i WHERE i.request_id=request_uuid
        AND (i.report_normalization_id IS NOT DISTINCT FROM NEW.report_normalization_id)
        AND (i.cost_version_id IS NOT DISTINCT FROM NEW.cost_version_id)
        AND (i.expense_version_id IS NOT DISTINCT FROM NEW.expense_version_id)
        AND (i.tax_setting_version_id IS NOT DISTINCT FROM NEW.tax_setting_version_id)
        AND NEW.report_version_id IS NULL
    ) THEN
      RAISE EXCEPTION 'calculation input is outside frozen request snapshot' USING ERRCODE='23514';
    END IF;
  ELSIF TG_TABLE_NAME='result_evidence' AND NEW.cost_version_id IS NOT NULL THEN
    SELECT r.request_id,l.result_scope,l.product_id INTO request_uuid,line_scope,line_product
    FROM mc.result_lines l JOIN mc.calculation_runs r ON r.id=l.run_id
    WHERE l.id=NEW.result_line_id;
    IF request_uuid IS NOT NULL AND NEW.source_operation_version_id IS NULL THEN
      RAISE EXCEPTION 'cost evidence requires source operation' USING ERRCODE='23514';
    END IF;
    IF NEW.source_operation_version_id IS NOT NULL THEN
      SELECT product_id,quantity,report_normalization_id
        INTO source_product,source_quantity,source_normalization FROM mc.operation_versions
      WHERE id=NEW.source_operation_version_id;
      IF line_scope<>'selected_product' OR source_product IS DISTINCT FROM line_product THEN
        RAISE EXCEPTION 'cost source operation is outside result product scope' USING ERRCODE='23514';
      END IF;
      IF NEW.quantity IS DISTINCT FROM source_quantity OR NOT EXISTS (
        SELECT 1 FROM mc.calculation_request_inputs
         WHERE request_id=request_uuid AND report_normalization_id=source_normalization
      ) THEN
        RAISE EXCEPTION 'cost source operation is outside frozen normalization or quantity' USING ERRCODE='23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER p03_input_scope_guard BEFORE INSERT ON mc.calculation_inputs
  FOR EACH ROW EXECUTE FUNCTION mc.guard_p03_run_child();
CREATE TRIGGER p03_result_scope_guard BEFORE INSERT ON mc.result_lines
  FOR EACH ROW EXECUTE FUNCTION mc.guard_p03_run_child();
CREATE TRIGGER p03_evidence_scope_guard BEFORE INSERT ON mc.result_evidence
  FOR EACH ROW EXECUTE FUNCTION mc.guard_p03_run_child();

-- Extend the legacy evidence validator with explicit store and tax scopes while
-- keeping its original checks for old calculation rows.
CREATE OR REPLACE FUNCTION mc.guard_evidence_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE line mc.result_lines; source_product uuid; source_variant uuid; source_category text;
  source_amount numeric; cost_date date; date_from date; date_to date; source_state text;
  request_uuid uuid; source_scope text;
BEGIN
  SELECT * INTO STRICT line FROM mc.result_lines WHERE id=NEW.result_line_id;
  SELECT request_id INTO request_uuid FROM mc.calculation_runs WHERE id=line.run_id;
  IF NEW.financial_component_id IS NOT NULL THEN
    SELECT o.product_id,o.variant_id,f.category_code,f.amount_signed,f.result_scope_classification
      INTO source_product,source_variant,source_category,source_amount,source_scope
    FROM mc.financial_components f JOIN mc.operation_versions o ON o.id=f.operation_version_id
    WHERE f.id=NEW.financial_component_id;
    IF source_category IS DISTINCT FROM line.category_code
       OR (line.result_scope='selected_product' AND source_product IS DISTINCT FROM line.product_id)
       OR (line.variant_id IS NOT NULL AND source_variant IS DISTINCT FROM line.variant_id)
       OR NEW.contribution_amount*source_amount < 0
       OR abs(NEW.contribution_amount)>abs(source_amount) THEN
      RAISE EXCEPTION 'financial evidence has incompatible scope, category, variant or amount' USING ERRCODE='23514';
    END IF;
    IF line.result_scope='store' AND source_product IS NOT NULL THEN
      RAISE EXCEPTION 'product component cannot prove store result' USING ERRCODE='23514';
    END IF;
    IF request_uuid IS NOT NULL AND
       ((line.result_scope='store' AND source_scope<>'store') OR
        (line.result_scope='selected_product' AND source_scope<>'selected_product')) THEN
      RAISE EXCEPTION 'financial evidence lacks explicit result scope classification' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.cost_version_id IS NOT NULL THEN
    SELECT c.product_id,c.variant_id,c.effective_from,v.unit_cost
      INTO source_product,source_variant,cost_date,source_amount
    FROM mc.cost_versions v JOIN mc.variant_costs c ON c.id=v.cost_id
    WHERE v.id=NEW.cost_version_id;
    IF line.result_scope<>'selected_product' OR source_product IS DISTINCT FROM line.product_id
       OR source_variant IS DISTINCT FROM line.variant_id OR line.category_code <> 'cost_of_goods'
       OR cost_date > line.accounting_date OR NEW.quantity IS NULL
       OR NEW.contribution_amount <> round(-source_amount*NEW.quantity,4) THEN
      RAISE EXCEPTION 'cost evidence must match product, variant, effective date and quantity' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.expense_version_id IS NOT NULL THEN
    SELECT e.product_id,v.category,v.amount,v.period_start,v.period_end,v.state
      INTO source_product,source_category,source_amount,date_from,date_to,source_state
    FROM mc.expense_versions v JOIN mc.expenses e ON e.id=v.expense_id
    WHERE v.id=NEW.expense_version_id;
    IF source_category IS DISTINCT FROM line.category_code OR source_state <> 'active'
       OR line.accounting_date NOT BETWEEN date_from AND date_to
       OR NEW.contribution_amount>0 OR abs(NEW.contribution_amount)>source_amount
       OR (line.result_scope='selected_product' AND source_product IS DISTINCT FROM line.product_id)
       OR (line.result_scope='store' AND source_product IS NOT NULL) THEN
      RAISE EXCEPTION 'expense evidence has incompatible scope, period or amount' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.tax_computation_id IS NOT NULL THEN
    SELECT tax_amount INTO source_amount FROM mc.tax_computations WHERE id=NEW.tax_computation_id;
    IF line.result_scope<>'store' OR line.category_code<>'estimated_usn_tax'
       OR NEW.contribution_amount <> -source_amount THEN
      RAISE EXCEPTION 'tax evidence must be a store-level signed tax result' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- A new input model uses a successful normalization instead of the legacy raw
-- report input. Legacy runs keep the old accepted-report checks.
CREATE OR REPLACE FUNCTION mc.guard_run_finish() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'running' OR NEW.status NOT IN ('succeeded','failed')
     OR (to_jsonb(OLD)-ARRAY['status','quality','missing_reasons','finished_at'])
        IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['status','quality','missing_reasons','finished_at']) THEN
    RAISE EXCEPTION 'only finishing a running calculation is allowed' USING ERRCODE='23514';
  END IF;
  IF NEW.status='succeeded' THEN
    IF NEW.request_id IS NULL AND NOT EXISTS (
      SELECT 1 FROM mc.calculation_inputs WHERE run_id=NEW.id AND report_version_id IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'successful calculation needs financial inputs' USING ERRCODE='23514';
    ELSIF NEW.request_id IS NOT NULL AND (NOT EXISTS (
      SELECT 1 FROM mc.calculation_inputs i JOIN mc.report_normalizations n
        ON n.id=i.report_normalization_id
      WHERE i.run_id=NEW.id AND n.status='succeeded'
    ) OR EXISTS (
      SELECT 1 FROM mc.calculation_inputs i JOIN mc.report_normalizations n
        ON n.id=i.report_normalization_id
      WHERE i.run_id=NEW.id AND n.status<>'succeeded'
    )) THEN
      RAISE EXCEPTION 'successful calculation needs normalized financial inputs' USING ERRCODE='23514';
    END IF;
    IF EXISTS (SELECT 1 FROM mc.result_lines l LEFT JOIN mc.result_evidence e ON e.result_line_id=l.id
        WHERE l.run_id=NEW.id GROUP BY l.id,l.amount_signed
        HAVING count(e.id)=0 OR sum(e.contribution_amount) <> l.amount_signed) THEN
      RAISE EXCEPTION 'result does not reconcile with evidence' USING ERRCODE='23514';
    END IF;
    IF EXISTS (SELECT 1 FROM mc.result_evidence e JOIN mc.result_lines l ON l.id=e.result_line_id
        JOIN mc.financial_components f ON f.id=e.financial_component_id WHERE l.run_id=NEW.id
        GROUP BY f.id,f.amount_signed HAVING abs(sum(e.contribution_amount))>abs(f.amount_signed))
      OR EXISTS (SELECT 1 FROM mc.result_evidence e JOIN mc.result_lines l ON l.id=e.result_line_id
        JOIN mc.expense_versions v ON v.id=e.expense_version_id WHERE l.run_id=NEW.id
        GROUP BY v.id,v.amount HAVING abs(sum(e.contribution_amount))>v.amount)
      OR EXISTS (SELECT 1 FROM mc.result_evidence e JOIN mc.result_lines l ON l.id=e.result_line_id
        WHERE l.run_id=NEW.id AND e.cost_version_id IS NOT NULL
        GROUP BY e.source_operation_version_id HAVING count(*)>1) THEN
      RAISE EXCEPTION 'source amount counted more than once' USING ERRCODE='23514';
    END IF;
    IF EXISTS (
      SELECT 1 FROM mc.result_evidence e JOIN mc.result_lines l ON l.id=e.result_line_id
      LEFT JOIN mc.financial_components f ON f.id=e.financial_component_id
      LEFT JOIN mc.operation_versions o ON o.id=f.operation_version_id
      LEFT JOIN mc.report_rows rr ON rr.id=o.report_row_id
      LEFT JOIN mc.report_normalizations rn ON rn.id=o.report_normalization_id
      WHERE l.run_id=NEW.id AND NOT EXISTS (
        SELECT 1 FROM mc.calculation_inputs i WHERE i.run_id=NEW.id AND (
          (e.cost_version_id IS NOT NULL AND i.cost_version_id=e.cost_version_id)
          OR (e.expense_version_id IS NOT NULL AND i.expense_version_id=e.expense_version_id)
          OR (e.tax_computation_id IS NOT NULL AND i.tax_setting_version_id=(
            SELECT tax_setting_version_id FROM mc.tax_computations WHERE id=e.tax_computation_id))
          OR (e.financial_component_id IS NOT NULL AND (
            i.report_version_id=rr.report_version_id OR
            (i.report_normalization_id=o.report_normalization_id AND f.method_version_id=rn.method_version_id)))
        )
      )
    ) THEN
      RAISE EXCEPTION 'evidence source missing from calculation inputs' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION mc.guard_publication() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE request_uuid uuid; request_generation bigint; latest_generation bigint;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF OLD.is_current IS NOT TRUE OR NEW.is_current IS NOT FALSE OR
      (to_jsonb(OLD)-'is_current') IS DISTINCT FROM (to_jsonb(NEW)-'is_current') THEN
      RAISE EXCEPTION 'publication can only be superseded' USING ERRCODE='23514';
    END IF;
  ELSE
    IF NEW.is_current IS NOT TRUE OR NOT EXISTS (
      SELECT 1 FROM mc.calculation_runs WHERE id=NEW.run_id AND status='succeeded'
    ) THEN
      RAISE EXCEPTION 'only successful runs may be current publications' USING ERRCODE='23514';
    END IF;
    SELECT r.request_id,q.generation_no INTO request_uuid,request_generation
    FROM mc.calculation_runs r LEFT JOIN mc.calculation_requests q ON q.id=r.request_id
    WHERE r.id=NEW.run_id;
    IF request_uuid IS NOT NULL THEN
      SELECT max(generation_no) INTO latest_generation FROM mc.calculation_requests
      WHERE store_id=NEW.store_id;
      IF request_generation IS DISTINCT FROM latest_generation THEN
        RAISE EXCEPTION 'stale calculation generation cannot be published' USING ERRCODE='23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION mc.publish_latest_calculation(p_run_id uuid) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE run_row mc.calculation_runs; publication_uuid uuid;
BEGIN
  SELECT * INTO STRICT run_row FROM mc.calculation_runs WHERE id=p_run_id;
  PERFORM 1 FROM mc.stores WHERE id=run_row.store_id FOR UPDATE;
  UPDATE mc.publications SET is_current=false
    WHERE store_id=run_row.store_id AND is_current;
  INSERT INTO mc.publications(business_id,store_id,run_id)
    VALUES(run_row.business_id,run_row.store_id,run_row.id)
    RETURNING id INTO publication_uuid;
  IF run_row.request_id IS NOT NULL THEN
    UPDATE mc.calculation_requests SET status='published',last_error_code=NULL,updated_at=now()
      WHERE id=run_row.request_id;
  END IF;
  RETURN publication_uuid;
END $$;

-- Append-only evidence and snapshot tables. Request headers are durable mutable
-- queue records but their identity/fingerprint/generation can never change.
CREATE TRIGGER request_identity BEFORE UPDATE ON mc.calculation_requests
  FOR EACH ROW EXECUTE FUNCTION mc.protect_columns(
    'id','business_id','store_id','generation_no','selection_id','method_version_id',
    'period_start','period_end','input_fingerprint','requested_at');
CREATE TRIGGER request_no_delete BEFORE DELETE ON mc.calculation_requests
  FOR EACH ROW EXECUTE FUNCTION mc.reject_mutation();
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY[
    'report_normalizations','calculation_request_products','calculation_request_inputs',
    'operation_links','tax_computations','tax_computation_segments','tax_basis_evidence'
  ] LOOP
    EXECUTE format('CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON mc.%I FOR EACH ROW EXECUTE FUNCTION mc.reject_mutation()',t);
  END LOOP;
END $$;

-- New tenant tables were created after the v1 RLS loop, so opt them in here.
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY[
    'report_normalizations','calculation_requests','calculation_request_products',
    'calculation_request_inputs','operation_links','tax_computations',
    'tax_computation_segments','tax_basis_evidence'
  ] LOOP
    EXECUTE format('ALTER TABLE mc.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE mc.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY tenant_isolation ON mc.%I USING (business_id=mc.context_business_id()) WITH CHECK (business_id=mc.context_business_id())',t);
  END LOOP;
END $$;

CREATE INDEX report_normalizations_lookup
  ON mc.report_normalizations(store_id,report_version_id,method_version_id);
CREATE INDEX calculation_requests_latest
  ON mc.calculation_requests(store_id,generation_no DESC);
CREATE INDEX calculation_invalidations_time
  ON mc.calculation_invalidations(invalidated_at,store_id);
CREATE INDEX calculation_request_products_request
  ON mc.calculation_request_products(request_id,product_id);
CREATE INDEX calculation_request_inputs_request
  ON mc.calculation_request_inputs(request_id);
CREATE INDEX calculation_runs_request ON mc.calculation_runs(request_id,attempt_no);
CREATE INDEX operation_links_target
  ON mc.operation_links(to_operation_version_id,link_type);
CREATE INDEX tax_computations_run ON mc.tax_computations(run_id);
CREATE INDEX tax_segments_computation
  ON mc.tax_computation_segments(tax_computation_id,segment_start);
CREATE INDEX tax_basis_segment ON mc.tax_basis_evidence(tax_segment_id);

COMMENT ON TABLE mc.report_normalizations IS
  'Версионный результат нормализации неизменяемой версии отчёта; смена методики не меняет старые операции.';
COMMENT ON TABLE mc.calculation_requests IS
  'Durable поколения желаемого финансового результата. Snapshot-строки замораживаются первым attempt.';
COMMENT ON TABLE mc.calculation_invalidations IS
  'Внутренний transactional outbox пересчёта. Не пользовательские данные и не публичный read API.';
COMMENT ON TABLE mc.tax_computations IS
  'Справочный расчёт налога по доступной базе, не налог бизнеса к уплате.';

REVOKE ALL ON ALL TABLES IN SCHEMA mc FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA mc FROM PUBLIC;
INSERT INTO mc.schema_migrations(version) VALUES(12);
COMMIT;
