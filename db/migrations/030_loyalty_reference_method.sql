BEGIN;

INSERT INTO mc.financial_categories(code,name,class,is_promotion)
VALUES('loyalty_discount_reference','Компенсация скидки по программе лояльности (справочно)','informational',false)
ON CONFLICT(code) DO UPDATE SET name=excluded.name,class=excluded.class,is_promotion=excluded.is_promotion;

INSERT INTO mc.method_versions(code,version_no,description,parameters,implementation_version)
VALUES(
  'wb_finance_import',11,
  'Компенсация скидки по программе лояльности сохраняется как справочное поле и не влияет на результат или качество данных.',
  '{"storeScope":"missing-product-identifiers-v1","promotion":"wb-bonus-type-v1","loyaltyCompensation":"reference-only-v1","wbExpenseFields":"row-kopeck-signed-v1","ppvzReward":"absolute-expense-v1","rebillLogisticCost":"reconciliation-v1"}',
  'wb-finance-v11'
),(
  'financial_result',13,
  'Недельный доступный результат исключает справочную компенсацию скидки по программе лояльности.',
  '{"periodResults":true,"returnCost":"confirmed-composite-link-v1","taxPeriodSpecific":true,"zeroSaleTaxBase":"complete-coverage-v1","availableResult":"selected-plus-store-v1","storeScope":"missing-product-identifiers-v1","loyaltyCompensation":"reference-only-v1","rebillLogisticCost":"reconciliation-only-v1"}',
  'financial-result-v13'
),(
  'financial_result',14,
  'Асинхронный расчёт произвольного периода исключает справочную компенсацию скидки по программе лояльности.',
  '{"periodResults":true,"targetPeriod":true,"returnCost":"confirmed-composite-link-v1","taxPeriodSpecific":true,"zeroSaleTaxBase":"complete-coverage-v1","availableResult":"selected-plus-store-v1","storeScope":"missing-product-identifiers-v1","loyaltyCompensation":"reference-only-v1","rebillLogisticCost":"reconciliation-only-v1"}',
  'financial-result-v14'
)
ON CONFLICT(code,version_no) DO NOTHING;

DO $migration$
DECLARE definition text; updated text;
BEGIN
  SELECT pg_get_functiondef('mc.guard_period_result()'::regprocedure) INTO definition;
  updated:=replace(definition,
    'method_code IN(''financial-result-v5'',''financial-result-v6'',''financial-result-v7'',''financial-result-v8'',''financial-result-v9'',''financial-result-v10'',''financial-result-v11'',''financial-result-v12'')',
    'method_code IN(''financial-result-v5'',''financial-result-v6'',''financial-result-v7'',''financial-result-v8'',''financial-result-v9'',''financial-result-v10'',''financial-result-v11'',''financial-result-v12'',''financial-result-v13'',''financial-result-v14'')');
  IF updated=definition THEN RAISE EXCEPTION 'guard_period_result v5-v12 contract not found'; END IF;
  EXECUTE updated;

  SELECT pg_get_functiondef('mc.guard_selected_tax_artifact()'::regprocedure) INTO definition;
  updated:=replace(definition,
    'implementation IN(''financial-result-v5'',''financial-result-v6'',''financial-result-v7'',''financial-result-v8'',''financial-result-v9'',''financial-result-v10'',''financial-result-v11'',''financial-result-v12'')',
    'implementation IN(''financial-result-v5'',''financial-result-v6'',''financial-result-v7'',''financial-result-v8'',''financial-result-v9'',''financial-result-v10'',''financial-result-v11'',''financial-result-v12'',''financial-result-v13'',''financial-result-v14'')');
  updated:=replace(updated,
    'implementation NOT IN(''financial-result-v5'',''financial-result-v6'',''financial-result-v7'',''financial-result-v8'',''financial-result-v9'',''financial-result-v10'',''financial-result-v11'',''financial-result-v12'')',
    'implementation NOT IN(''financial-result-v5'',''financial-result-v6'',''financial-result-v7'',''financial-result-v8'',''financial-result-v9'',''financial-result-v10'',''financial-result-v11'',''financial-result-v12'',''financial-result-v13'',''financial-result-v14'')');
  IF updated=definition THEN RAISE EXCEPTION 'guard_selected_tax_artifact v5-v12 contract not found'; END IF;
  EXECUTE updated;

  SELECT pg_get_functiondef('mc.guard_selected_tax_finish()'::regprocedure) INTO definition;
  updated:=replace(definition,
    'implementation_version IN(''financial-result-v6'',''financial-result-v7'',''financial-result-v8'',''financial-result-v9'',''financial-result-v10'',''financial-result-v11'',''financial-result-v12'')',
    'implementation_version IN(''financial-result-v6'',''financial-result-v7'',''financial-result-v8'',''financial-result-v9'',''financial-result-v10'',''financial-result-v11'',''financial-result-v12'',''financial-result-v13'',''financial-result-v14'')');
  IF updated=definition THEN RAISE EXCEPTION 'guard_selected_tax_finish v6-v12 contract not found'; END IF;
  EXECUTE updated;

  SELECT pg_get_functiondef('mc.guard_run_finish()'::regprocedure) INTO definition;
  updated:=replace(definition,
    'implementation_version IN(''financial-result-v5'',''financial-result-v6'',''financial-result-v7'',''financial-result-v8'',''financial-result-v9'',''financial-result-v11'')',
    'implementation_version IN(''financial-result-v5'',''financial-result-v6'',''financial-result-v7'',''financial-result-v8'',''financial-result-v9'',''financial-result-v11'',''financial-result-v13'')');
  updated:=replace(updated,
    '(SELECT implementation_version FROM mc.method_versions WHERE id=NEW.method_version_id) IN(''financial-result-v7'',''financial-result-v8'',''financial-result-v9'',''financial-result-v11'')',
    '(SELECT implementation_version FROM mc.method_versions WHERE id=NEW.method_version_id) IN(''financial-result-v7'',''financial-result-v8'',''financial-result-v9'',''financial-result-v11'',''financial-result-v13'')');
  IF updated=definition OR position('financial-result-v13' in updated)=0 THEN
    RAISE EXCEPTION 'guard_run_finish v11 contract not found';
  END IF;
  EXECUTE updated;

  SELECT pg_get_functiondef('mc.guard_target_period_finish()'::regprocedure) INTO definition;
  updated:=replace(definition,
    'IF implementation NOT IN(''financial-result-v10'',''financial-result-v12'') THEN RETURN NEW; END IF;',
    'IF implementation NOT IN(''financial-result-v10'',''financial-result-v12'',''financial-result-v14'') THEN RETURN NEW; END IF;');
  updated:=replace(updated,
    'parser.implementation_version=CASE implementation WHEN ''financial-result-v10'' THEN ''wb-finance-v9'' WHEN ''financial-result-v12'' THEN ''wb-finance-v10'' END',
    'parser.implementation_version=CASE implementation WHEN ''financial-result-v10'' THEN ''wb-finance-v9'' WHEN ''financial-result-v12'' THEN ''wb-finance-v10'' WHEN ''financial-result-v14'' THEN ''wb-finance-v11'' END');
  IF updated=definition OR position('financial-result-v14' in updated)=0 OR position('wb-finance-v11' in updated)=0 THEN
    RAISE EXCEPTION 'guard_target_period_finish v12 contract not found';
  END IF;
  EXECUTE updated;
END
$migration$;

ALTER TABLE mc.stores NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.memberships NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.product_selections NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.reports NO FORCE ROW LEVEL SECURITY;
INSERT INTO mc.calculation_invalidations(business_id,store_id,requested_by,reason)
SELECT s.business_id,s.id,member.user_id,'loyalty_compensation_reference_v11'
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

INSERT INTO mc.schema_migrations(version) VALUES(30);
COMMIT;
