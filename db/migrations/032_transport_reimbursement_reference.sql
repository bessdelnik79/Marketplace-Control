BEGIN;

INSERT INTO mc.method_versions(code,version_no,description,parameters,implementation_version)
VALUES(
  'financial_result',17,
  'Недельный результат считает поля vw и vwNds в строке возмещения издержек перевозки справочными вместе с rebillLogisticCost.',
  '{"periodResults":true,"returnCost":"confirmed-composite-link-v1","taxPeriodSpecific":true,"zeroSaleTaxBase":"complete-coverage-v1","availableResult":"selected-plus-store-v1","storeScope":"missing-product-identifiers-v1","loyaltyCompensation":"reference-only-v1","rebillLogisticCost":"reconciliation-only-v1","unclassifiedOperation":"component-quality-v1","transportReimbursement":"reference-only-v1"}',
  'financial-result-v17'
),(
  'financial_result',18,
  'Расчёт произвольного периода считает поля vw и vwNds в строке возмещения издержек перевозки справочными вместе с rebillLogisticCost.',
  '{"periodResults":true,"targetPeriod":true,"returnCost":"confirmed-composite-link-v1","taxPeriodSpecific":true,"zeroSaleTaxBase":"complete-coverage-v1","availableResult":"selected-plus-store-v1","storeScope":"missing-product-identifiers-v1","loyaltyCompensation":"reference-only-v1","rebillLogisticCost":"reconciliation-only-v1","unclassifiedOperation":"component-quality-v1","transportReimbursement":"reference-only-v1"}',
  'financial-result-v18'
)
ON CONFLICT(code,version_no) DO NOTHING;

DO $migration$
DECLARE definition text; updated text;
BEGIN
  SELECT pg_get_functiondef('mc.guard_period_result()'::regprocedure) INTO definition;
  updated:=replace(definition,
    '''financial-result-v15'',''financial-result-v16'')',
    '''financial-result-v15'',''financial-result-v16'',''financial-result-v17'',''financial-result-v18'')');
  IF updated=definition THEN RAISE EXCEPTION 'guard_period_result v15-v16 contract not found'; END IF;
  EXECUTE updated;

  SELECT pg_get_functiondef('mc.guard_selected_tax_artifact()'::regprocedure) INTO definition;
  updated:=replace(definition,
    '''financial-result-v15'',''financial-result-v16'')',
    '''financial-result-v15'',''financial-result-v16'',''financial-result-v17'',''financial-result-v18'')');
  IF updated=definition THEN RAISE EXCEPTION 'guard_selected_tax_artifact v15-v16 contract not found'; END IF;
  EXECUTE updated;

  SELECT pg_get_functiondef('mc.guard_selected_tax_finish()'::regprocedure) INTO definition;
  updated:=replace(definition,
    '''financial-result-v15'',''financial-result-v16'')',
    '''financial-result-v15'',''financial-result-v16'',''financial-result-v17'',''financial-result-v18'')');
  IF updated=definition THEN RAISE EXCEPTION 'guard_selected_tax_finish v15-v16 contract not found'; END IF;
  EXECUTE updated;

  SELECT pg_get_functiondef('mc.guard_run_finish()'::regprocedure) INTO definition;
  updated:=replace(definition,
    '''financial-result-v13'',''financial-result-v15'')',
    '''financial-result-v13'',''financial-result-v15'',''financial-result-v17'')');
  IF updated=definition THEN RAISE EXCEPTION 'guard_run_finish v15 contract not found'; END IF;
  EXECUTE updated;

  SELECT pg_get_functiondef('mc.guard_target_period_finish()'::regprocedure) INTO definition;
  updated:=replace(definition,
    '''financial-result-v14'',''financial-result-v16'')',
    '''financial-result-v14'',''financial-result-v16'',''financial-result-v18'')');
  updated:=replace(updated,
    'WHEN ''financial-result-v16'' THEN ''wb-finance-v11'' END',
    'WHEN ''financial-result-v16'' THEN ''wb-finance-v11'' WHEN ''financial-result-v18'' THEN ''wb-finance-v11'' END');
  IF updated=definition OR position('financial-result-v18' in updated)=0 THEN
    RAISE EXCEPTION 'guard_target_period_finish v16 contract not found';
  END IF;
  EXECUTE updated;
END
$migration$;

ALTER TABLE mc.stores NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.memberships NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.product_selections NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.reports NO FORCE ROW LEVEL SECURITY;
INSERT INTO mc.calculation_invalidations(business_id,store_id,requested_by,reason)
SELECT s.business_id,s.id,member.user_id,'transport_reimbursement_reference_v17'
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

INSERT INTO mc.schema_migrations(version) VALUES(32);
COMMIT;
