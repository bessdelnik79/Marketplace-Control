BEGIN;

INSERT INTO mc.method_versions(code,version_no,description,parameters,implementation_version)
VALUES
  ('wb_finance_import',7,
   'Проверенные расходы WB округляются до копеек по строкам; ppvzReward всегда является расходом независимо от исходного знака.',
   '{"storeScope":"catalog-identifiers-v2","promotion":"wb-bonus-type-v1","wbExpenseFields":"row-kopeck-signed-v1","ppvzReward":"absolute-expense-v1"}',
   'wb-finance-v7'),
  ('financial_result',7,
   'Доступный результат объединяет результат выбранных товаров и подтверждённые расходы магазина.',
   '{"periodResults":true,"returnCost":"confirmed-composite-link-v1","taxPeriodSpecific":true,"zeroSaleTaxBase":"complete-coverage-v1","availableResult":"selected-plus-store-v1"}',
   'financial-result-v7')
ON CONFLICT(code,version_no) DO NOTHING;

UPDATE mc.financial_categories SET class='expense'
WHERE code IN('pickup_reward','wb_reward_without_vat','wb_reward_vat','rebill_logistic_compensation')
  AND class<>'expense';

-- Extend the exact period-result guards to v7 without weakening legacy methods.
DO $migration$
DECLARE definition text; updated text;
BEGIN
  SELECT pg_get_functiondef('mc.guard_period_result()'::regprocedure) INTO definition;
  updated:=replace(definition,
    'method_code IN(''financial-result-v5'',''financial-result-v6'')',
    'method_code IN(''financial-result-v5'',''financial-result-v6'',''financial-result-v7'')');
  IF updated=definition THEN RAISE EXCEPTION 'guard_period_result v5/v6 contract not found'; END IF;
  EXECUTE updated;

  SELECT pg_get_functiondef('mc.guard_selected_tax_artifact()'::regprocedure) INTO definition;
  updated:=replace(definition,
    'implementation IN(''financial-result-v5'',''financial-result-v6'')',
    'implementation IN(''financial-result-v5'',''financial-result-v6'',''financial-result-v7'')');
  updated:=replace(updated,
    'implementation NOT IN(''financial-result-v5'',''financial-result-v6'')',
    'implementation NOT IN(''financial-result-v5'',''financial-result-v6'',''financial-result-v7'')');
  IF updated=definition THEN RAISE EXCEPTION 'guard_selected_tax_artifact v5/v6 contract not found'; END IF;
  EXECUTE updated;

  SELECT pg_get_functiondef('mc.guard_run_finish()'::regprocedure) INTO definition;
  updated:=replace(definition,
    'implementation_version IN(''financial-result-v5'',''financial-result-v6'')',
    'implementation_version IN(''financial-result-v5'',''financial-result-v6'',''financial-result-v7'')');
  updated:=replace(updated,
    'OR (pr.totals->>''availableResultBeforeTax'')::numeric IS DISTINCT FROM sums.selected_before_tax',
    'OR (pr.totals->>''availableResultBeforeTax'')::numeric IS DISTINCT FROM sums.selected_before_tax+CASE WHEN (SELECT implementation_version FROM mc.method_versions WHERE id=NEW.method_version_id)=''financial-result-v7'' THEN sums.store_before_tax ELSE 0 END');
  updated:=replace(updated,
    'THEN (pr.totals->>''availableResultAfterTax'')::numeric IS DISTINCT FROM sums.selected_before_tax-sums.estimated_tax',
    'THEN (pr.totals->>''availableResultAfterTax'')::numeric IS DISTINCT FROM sums.selected_before_tax+CASE WHEN (SELECT implementation_version FROM mc.method_versions WHERE id=NEW.method_version_id)=''financial-result-v7'' THEN sums.store_before_tax ELSE 0 END-sums.estimated_tax');
  IF updated=definition OR position('financial-result-v7' in updated)=0
    OR position('availableResultBeforeTax'')::numeric IS DISTINCT FROM sums.selected_before_tax+CASE' in updated)=0
    OR position('availableResultAfterTax'')::numeric IS DISTINCT FROM sums.selected_before_tax+CASE' in updated)=0 THEN
    RAISE EXCEPTION 'guard_run_finish v5/v6 totals contract not found';
  END IF;
  EXECUTE updated;
END
$migration$;

-- v6/v7 may persist an explicit zero computation for a selected SKU with no
-- sales in a completely covered period. Every non-zero computation still
-- requires source basis evidence.
CREATE OR REPLACE FUNCTION mc.guard_selected_tax_finish() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status='succeeded' AND EXISTS(SELECT 1 FROM mc.tax_computations c WHERE c.run_id=NEW.id AND (
   c.taxable_base<>(SELECT coalesce(sum(s.taxable_base),0) FROM mc.tax_computation_segments s WHERE s.tax_computation_id=c.id)
   OR c.tax_amount<>(SELECT round(coalesce(sum(s.taxable_base*s.rate_fraction),0),4) FROM mc.tax_computation_segments s WHERE s.tax_computation_id=c.id)
   OR EXISTS(SELECT 1 FROM mc.tax_computation_segments s WHERE s.tax_computation_id=c.id AND s.taxable_base<>(SELECT coalesce(sum(e.taxable_contribution),0) FROM mc.tax_basis_evidence e WHERE e.tax_segment_id=s.id))
   OR NOT EXISTS(SELECT 1 FROM mc.tax_computation_segments s WHERE s.tax_computation_id=c.id)
   OR (NOT EXISTS(SELECT 1 FROM mc.tax_computation_segments s JOIN mc.tax_basis_evidence e ON e.tax_segment_id=s.id WHERE s.tax_computation_id=c.id)
       AND NOT(c.taxable_base=0 AND c.tax_amount=0 AND EXISTS(
         SELECT 1 FROM mc.method_versions m WHERE m.id=c.method_version_id AND m.implementation_version IN('financial-result-v6','financial-result-v7'))))
   OR (c.tax_amount<>0 AND NOT EXISTS(SELECT 1 FROM mc.result_evidence e JOIN mc.result_lines l ON l.id=e.result_line_id WHERE e.tax_computation_id=c.id AND l.run_id=NEW.id))
 )) THEN RAISE EXCEPTION 'tax computation does not reconcile with segments and basis evidence' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;

ALTER TABLE mc.stores NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.memberships NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.product_selections NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.reports NO FORCE ROW LEVEL SECURITY;
INSERT INTO mc.calculation_invalidations(business_id,store_id,requested_by,reason)
SELECT s.business_id,s.id,member.user_id,'financial_expense_method_v7'
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

INSERT INTO mc.schema_migrations(version) VALUES(25);
COMMIT;
