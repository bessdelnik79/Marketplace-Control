BEGIN;

INSERT INTO mc.method_versions(code,version_no,description,parameters,implementation_version)
VALUES(
  'financial_result',19,
  'Недельный результат учитывает отрицательный налоговый вклад отдельного SKU в общем положительном налоге периода.',
  '{"periodResults":true,"returnCost":"confirmed-composite-link-v1","taxPeriodSpecific":true,"zeroSaleTaxBase":"complete-coverage-v1","negativeSkuTax":"signed-offset-v1","availableResult":"selected-plus-store-v1","storeScope":"missing-product-identifiers-v1","loyaltyCompensation":"reference-only-v1","rebillLogisticCost":"reconciliation-only-v1","unclassifiedOperation":"component-quality-v1","transportReimbursement":"reference-only-v1"}',
  'financial-result-v19'
),(
  'financial_result',20,
  'Расчёт произвольного периода учитывает отрицательный налоговый вклад отдельного SKU в общем положительном налоге периода.',
  '{"periodResults":true,"targetPeriod":true,"returnCost":"confirmed-composite-link-v1","taxPeriodSpecific":true,"zeroSaleTaxBase":"complete-coverage-v1","negativeSkuTax":"signed-offset-v1","availableResult":"selected-plus-store-v1","storeScope":"missing-product-identifiers-v1","loyaltyCompensation":"reference-only-v1","rebillLogisticCost":"reconciliation-only-v1","unclassifiedOperation":"component-quality-v1","transportReimbursement":"reference-only-v1"}',
  'financial-result-v20'
)
ON CONFLICT(code,version_no) DO NOTHING;

ALTER TABLE mc.tax_computations DROP CONSTRAINT tax_computations_tax_amount_check;

CREATE FUNCTION mc.guard_signed_tax_period_finish() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE implementation text;
BEGIN
  IF NEW.status='succeeded' THEN
    SELECT implementation_version INTO implementation FROM mc.method_versions WHERE id=NEW.method_version_id;
    IF implementation IN('financial-result-v19','financial-result-v20') THEN
      IF EXISTS(
        SELECT 1 FROM mc.tax_computations c WHERE c.run_id=NEW.id
        GROUP BY c.run_id,c.period_start,c.period_end
        HAVING sum(c.taxable_base)<0 OR sum(c.tax_amount)<0
      ) THEN
        RAISE EXCEPTION 'signed tax period total must not be negative' USING ERRCODE='23514';
      END IF;
    ELSIF EXISTS(SELECT 1 FROM mc.tax_computations c WHERE c.run_id=NEW.id AND c.tax_amount<0) THEN
      RAISE EXCEPTION 'negative product tax requires signed tax methodology' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER signed_tax_period_finish_guard BEFORE UPDATE ON mc.calculation_runs
FOR EACH ROW EXECUTE FUNCTION mc.guard_signed_tax_period_finish();

DO $migration$
DECLARE definition text; updated text;
BEGIN
  SELECT pg_get_functiondef('mc.guard_period_result()'::regprocedure) INTO definition;
  updated:=replace(definition,
    '''financial-result-v15'',''financial-result-v16'',''financial-result-v17'',''financial-result-v18'')',
    '''financial-result-v15'',''financial-result-v16'',''financial-result-v17'',''financial-result-v18'',''financial-result-v19'',''financial-result-v20'')');
  IF updated=definition THEN RAISE EXCEPTION 'guard_period_result v17-v18 contract not found'; END IF;
  EXECUTE updated;

  SELECT pg_get_functiondef('mc.guard_selected_tax_artifact()'::regprocedure) INTO definition;
  updated:=replace(definition,
    '''financial-result-v15'',''financial-result-v16'',''financial-result-v17'',''financial-result-v18'')',
    '''financial-result-v15'',''financial-result-v16'',''financial-result-v17'',''financial-result-v18'',''financial-result-v19'',''financial-result-v20'')');
  IF updated=definition THEN RAISE EXCEPTION 'guard_selected_tax_artifact v17-v18 contract not found'; END IF;
  EXECUTE updated;

  SELECT pg_get_functiondef('mc.guard_selected_tax_finish()'::regprocedure) INTO definition;
  updated:=replace(definition,
    '''financial-result-v15'',''financial-result-v16'',''financial-result-v17'',''financial-result-v18'')',
    '''financial-result-v15'',''financial-result-v16'',''financial-result-v17'',''financial-result-v18'',''financial-result-v19'',''financial-result-v20'')');
  IF updated=definition THEN RAISE EXCEPTION 'guard_selected_tax_finish v17-v18 contract not found'; END IF;
  EXECUTE updated;

  SELECT pg_get_functiondef('mc.guard_run_finish()'::regprocedure) INTO definition;
  updated:=replace(definition,
    '''financial-result-v13'',''financial-result-v15'',''financial-result-v17'')',
    '''financial-result-v13'',''financial-result-v15'',''financial-result-v17'',''financial-result-v19'')');
  IF updated=definition THEN RAISE EXCEPTION 'guard_run_finish v17 contract not found'; END IF;
  EXECUTE updated;

  SELECT pg_get_functiondef('mc.guard_target_period_finish()'::regprocedure) INTO definition;
  updated:=replace(definition,
    '''financial-result-v14'',''financial-result-v16'',''financial-result-v18'')',
    '''financial-result-v14'',''financial-result-v16'',''financial-result-v18'',''financial-result-v20'')');
  updated:=replace(updated,
    'WHEN ''financial-result-v16'' THEN ''wb-finance-v11'' WHEN ''financial-result-v18'' THEN ''wb-finance-v11'' END',
    'WHEN ''financial-result-v16'' THEN ''wb-finance-v11'' WHEN ''financial-result-v18'' THEN ''wb-finance-v11'' WHEN ''financial-result-v20'' THEN ''wb-finance-v11'' END');
  IF updated=definition OR position('financial-result-v20' in updated)=0 THEN
    RAISE EXCEPTION 'guard_target_period_finish v18 contract not found';
  END IF;
  EXECUTE updated;
END
$migration$;

ALTER TABLE mc.stores NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.memberships NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.product_selections NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.reports NO FORCE ROW LEVEL SECURITY;
INSERT INTO mc.calculation_invalidations(business_id,store_id,requested_by,reason)
SELECT s.business_id,s.id,member.user_id,'negative_sku_tax_offset_v19'
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

INSERT INTO mc.schema_migrations(version) VALUES(33);
COMMIT;
