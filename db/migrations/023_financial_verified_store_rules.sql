BEGIN;

INSERT INTO mc.method_versions(code,version_no,description,parameters,implementation_version)
VALUES
  ('wb_finance_import',5,
   'Проверенные магазинные хранение и продвижение WB, нулевые идентификаторы и независимая классификация источников ПВЗ.',
   '{"storeScope":"zero-sentinel-v1","promotion":"wb-bonus-type-v1","pvzSourceClassification":"exact-store-row-v1"}',
   'wb-finance-v5'),
  ('financial_result',6,
   'Нулевая налоговая база SKU без продаж при полном покрытии отчётами.',
   '{"periodResults":true,"returnCost":"confirmed-composite-link-v1","taxPeriodSpecific":true,"zeroSaleTaxBase":"complete-coverage-v1"}',
   'financial-result-v6')
ON CONFLICT(code,version_no) DO NOTHING;

UPDATE mc.financial_categories SET class='income'
WHERE code='pickup_reward' AND class='informational';
UPDATE mc.financial_categories SET class='expense'
WHERE code IN('wb_reward_without_vat','wb_reward_vat') AND class='informational';

-- Extend the exact v5 period guards to v6 without weakening legacy methods.
DO $migration$
DECLARE definition text; updated text;
BEGIN
  SELECT pg_get_functiondef('mc.guard_period_result()'::regprocedure) INTO definition;
  updated:=replace(definition,
    'method_code=''financial-result-v5''',
    'method_code IN(''financial-result-v5'',''financial-result-v6'')');
  updated:=replace(updated,'v5 result line requires a period result','v5/v6 result line requires a period result');
  IF updated=definition THEN RAISE EXCEPTION 'guard_period_result v5 contract not found'; END IF;
  EXECUTE updated;

  SELECT pg_get_functiondef('mc.guard_selected_tax_artifact()'::regprocedure) INTO definition;
  updated:=replace(definition,
    'implementation=''financial-result-v5''',
    'implementation IN(''financial-result-v5'',''financial-result-v6'')');
  updated:=replace(updated,
    'implementation<>''financial-result-v5''',
    'implementation NOT IN(''financial-result-v5'',''financial-result-v6'')');
  IF updated=definition THEN RAISE EXCEPTION 'guard_selected_tax_artifact v5 contract not found'; END IF;
  EXECUTE updated;

  SELECT pg_get_functiondef('mc.guard_run_finish()'::regprocedure) INTO definition;
  updated:=replace(definition,
    'implementation_version=''financial-result-v5''',
    'implementation_version IN(''financial-result-v5'',''financial-result-v6'')');
  updated:=replace(updated,'v5 calculation requires persisted period results','v5/v6 calculation requires persisted period results');
  IF updated=definition THEN RAISE EXCEPTION 'guard_run_finish v5 contract not found'; END IF;
  EXECUTE updated;
END
$migration$;

-- financial-result-v6 may persist an explicit zero computation for a selected
-- SKU with no sales in a completely covered period. Legacy and every non-zero
-- computation still require source basis evidence.
CREATE OR REPLACE FUNCTION mc.guard_selected_tax_finish() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status='succeeded' AND EXISTS(SELECT 1 FROM mc.tax_computations c WHERE c.run_id=NEW.id AND (
   c.taxable_base<>(SELECT coalesce(sum(s.taxable_base),0) FROM mc.tax_computation_segments s WHERE s.tax_computation_id=c.id)
   OR c.tax_amount<>(SELECT round(coalesce(sum(s.taxable_base*s.rate_fraction),0),4) FROM mc.tax_computation_segments s WHERE s.tax_computation_id=c.id)
   OR EXISTS(SELECT 1 FROM mc.tax_computation_segments s WHERE s.tax_computation_id=c.id AND s.taxable_base<>(SELECT coalesce(sum(e.taxable_contribution),0) FROM mc.tax_basis_evidence e WHERE e.tax_segment_id=s.id))
   OR NOT EXISTS(SELECT 1 FROM mc.tax_computation_segments s WHERE s.tax_computation_id=c.id)
   OR (NOT EXISTS(SELECT 1 FROM mc.tax_computation_segments s JOIN mc.tax_basis_evidence e ON e.tax_segment_id=s.id WHERE s.tax_computation_id=c.id)
       AND NOT(c.taxable_base=0 AND c.tax_amount=0 AND EXISTS(
         SELECT 1 FROM mc.method_versions m WHERE m.id=c.method_version_id AND m.implementation_version='financial-result-v6')))
   OR (c.tax_amount<>0 AND NOT EXISTS(SELECT 1 FROM mc.result_evidence e JOIN mc.result_lines l ON l.id=e.result_line_id WHERE e.tax_computation_id=c.id AND l.run_id=NEW.id))
 )) THEN RAISE EXCEPTION 'tax computation does not reconcile with segments and basis evidence' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;

ALTER TABLE mc.stores NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.memberships NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.product_selections NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.reports NO FORCE ROW LEVEL SECURITY;
INSERT INTO mc.calculation_invalidations(business_id,store_id,requested_by,reason)
SELECT s.business_id,s.id,member.user_id,'financial_verified_store_rules_v6'
FROM mc.stores s
JOIN mc.product_selections ps ON ps.business_id=s.business_id AND ps.store_id=s.id AND ps.status='confirmed'
JOIN LATERAL(
  SELECT m.user_id FROM mc.memberships m WHERE m.business_id=s.business_id
  ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END,m.created_at LIMIT 1
) member ON true
WHERE s.status='active' AND EXISTS(
  SELECT 1 FROM mc.reports r WHERE r.business_id=s.business_id AND r.store_id=s.id AND r.current_version_id IS NOT NULL
)
ON CONFLICT(store_id) DO UPDATE SET requested_by=excluded.requested_by,reason=excluded.reason,
  generation_token=gen_random_uuid(),invalidated_at=clock_timestamp();
ALTER TABLE mc.reports FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.product_selections FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.stores FORCE ROW LEVEL SECURITY;

INSERT INTO mc.schema_migrations(version) VALUES(23);
COMMIT;
