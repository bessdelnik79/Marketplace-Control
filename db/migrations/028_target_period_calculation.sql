BEGIN;

INSERT INTO mc.method_versions(code,version_no,description,parameters,implementation_version)
VALUES(
  'financial_result',10,
  'Асинхронный расчёт одного произвольного периода, непрерывно покрытого принятыми отчётами WB.',
  '{"periodResults":true,"targetPeriod":true,"returnCost":"confirmed-composite-link-v1","taxPeriodSpecific":true,"zeroSaleTaxBase":"complete-coverage-v1","availableResult":"selected-plus-store-v1","storeScope":"missing-product-identifiers-v1","rebillLogisticCost":"reconciliation-only-v1"}',
  'financial-result-v10'
)
ON CONFLICT(code,version_no) DO NOTHING;

DO $migration$
DECLARE definition text; updated text;
BEGIN
  SELECT pg_get_functiondef('mc.guard_period_result()'::regprocedure) INTO definition;
  updated:=replace(definition,
    'method_code IN(''financial-result-v5'',''financial-result-v6'',''financial-result-v7'',''financial-result-v8'',''financial-result-v9'')',
    'method_code IN(''financial-result-v5'',''financial-result-v6'',''financial-result-v7'',''financial-result-v8'',''financial-result-v9'',''financial-result-v10'')');
  IF updated=definition THEN RAISE EXCEPTION 'guard_period_result v5-v9 contract not found'; END IF;
  EXECUTE updated;

  SELECT pg_get_functiondef('mc.guard_selected_tax_artifact()'::regprocedure) INTO definition;
  updated:=replace(definition,
    'implementation IN(''financial-result-v5'',''financial-result-v6'',''financial-result-v7'',''financial-result-v8'',''financial-result-v9'')',
    'implementation IN(''financial-result-v5'',''financial-result-v6'',''financial-result-v7'',''financial-result-v8'',''financial-result-v9'',''financial-result-v10'')');
  updated:=replace(updated,
    'implementation NOT IN(''financial-result-v5'',''financial-result-v6'',''financial-result-v7'',''financial-result-v8'',''financial-result-v9'')',
    'implementation NOT IN(''financial-result-v5'',''financial-result-v6'',''financial-result-v7'',''financial-result-v8'',''financial-result-v9'',''financial-result-v10'')');
  IF updated=definition THEN RAISE EXCEPTION 'guard_selected_tax_artifact v5-v9 contract not found'; END IF;
  EXECUTE updated;

  SELECT pg_get_functiondef('mc.guard_selected_tax_finish()'::regprocedure) INTO definition;
  updated:=replace(definition,
    'implementation_version IN(''financial-result-v6'',''financial-result-v7'',''financial-result-v8'',''financial-result-v9'')',
    'implementation_version IN(''financial-result-v6'',''financial-result-v7'',''financial-result-v8'',''financial-result-v9'',''financial-result-v10'')');
  IF updated=definition THEN RAISE EXCEPTION 'guard_selected_tax_finish v6-v9 contract not found'; END IF;
  EXECUTE updated;
END
$migration$;

CREATE FUNCTION mc.guard_target_period_finish() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE implementation text;
BEGIN
  IF NEW.status<>'succeeded' THEN RETURN NEW; END IF;
  SELECT implementation_version INTO STRICT implementation FROM mc.method_versions WHERE id=NEW.method_version_id;
  IF implementation<>'financial-result-v10' THEN RETURN NEW; END IF;

  IF (SELECT count(*) FROM mc.financial_period_results p WHERE p.run_id=NEW.id)<>1
    OR NOT EXISTS(
      SELECT 1 FROM mc.financial_period_results p
       WHERE p.run_id=NEW.id AND p.period_start=NEW.period_start AND p.period_end=NEW.period_end
    ) THEN
    RAISE EXCEPTION 'target calculation requires one exact period result' USING ERRCODE='23514';
  END IF;

  IF EXISTS(
    SELECT 1 FROM generate_series(NEW.period_start,NEW.period_end,interval '1 day') day
     WHERE NOT EXISTS(
       SELECT 1 FROM mc.calculation_inputs i
       JOIN mc.report_versions rv ON rv.id=i.report_version_id AND rv.status='accepted'
       JOIN mc.reports r ON r.id=rv.report_id
       JOIN mc.calculation_inputs ni ON ni.run_id=i.run_id AND ni.report_normalization_id IS NOT NULL
       JOIN mc.report_normalizations rn ON rn.id=ni.report_normalization_id AND rn.report_version_id=rv.id AND rn.status='succeeded'
       JOIN mc.method_versions parser ON parser.id=rn.method_version_id AND parser.implementation_version='wb-finance-v9'
       WHERE i.run_id=NEW.id AND day::date BETWEEN r.period_start AND r.period_end
     )
  ) OR EXISTS(
    SELECT 1 FROM mc.calculation_inputs i
    JOIN mc.report_versions rv ON rv.id=i.report_version_id AND rv.status='accepted'
    WHERE i.run_id=NEW.id AND NOT EXISTS(
        SELECT 1 FROM mc.calculation_inputs ni
        JOIN mc.report_normalizations rn ON rn.id=ni.report_normalization_id
        JOIN mc.method_versions parser ON parser.id=rn.method_version_id
        WHERE ni.run_id=NEW.id AND rn.report_version_id=rv.id AND rn.status='succeeded'
          AND parser.implementation_version='wb-finance-v9'
      )
  ) THEN
    RAISE EXCEPTION 'target calculation period is not covered by frozen reports' USING ERRCODE='23514';
  END IF;

  IF EXISTS(
    SELECT 1
      FROM mc.financial_period_results p
      LEFT JOIN LATERAL(
        SELECT count(l.id)::int AS line_count,
          coalesce(sum(l.amount_signed) FILTER(WHERE l.result_scope='selected_product' AND l.category_code<>'estimated_usn_tax'),0) AS selected_before_tax,
          coalesce(sum(l.amount_signed) FILTER(WHERE l.result_scope='store' AND l.category_code<>'estimated_usn_tax'),0) AS store_before_tax,
          coalesce(-sum(l.amount_signed) FILTER(WHERE l.category_code='estimated_usn_tax'),0) AS estimated_tax,
          bool_and(l.quality=p.quality) AS line_quality_matches
        FROM mc.result_lines l WHERE l.financial_period_result_id=p.id
      ) sums ON true
     WHERE p.run_id=NEW.id AND(
       (p.quality='unavailable' AND(sums.line_count<>0 OR p.totals IS NOT NULL))
       OR (p.quality<>'unavailable' AND(
         p.totals IS NULL
         OR NOT(p.totals ?& ARRAY['selectedProductsResultBeforeTax','storeLevelResultBeforeTax','availableResultBeforeTax','estimatedUsnTax','availableResultAfterTax','netProfit'])
         OR p.totals-ARRAY['selectedProductsResultBeforeTax','storeLevelResultBeforeTax','availableResultBeforeTax','estimatedUsnTax','availableResultAfterTax','netProfit']<>'{}'::jsonb
         OR (p.totals->>'selectedProductsResultBeforeTax')::numeric IS DISTINCT FROM sums.selected_before_tax
         OR (p.totals->>'storeLevelResultBeforeTax')::numeric IS DISTINCT FROM sums.store_before_tax
         OR (p.totals->>'availableResultBeforeTax')::numeric IS DISTINCT FROM sums.selected_before_tax+sums.store_before_tax
         OR (p.totals->>'estimatedUsnTax')::numeric IS DISTINCT FROM sums.estimated_tax
         OR CASE WHEN EXISTS(SELECT 1 FROM mc.tax_computations c WHERE c.run_id=NEW.id AND c.period_start=p.period_start AND c.period_end=p.period_end)
              THEN (p.totals->>'availableResultAfterTax')::numeric IS DISTINCT FROM sums.selected_before_tax+sums.store_before_tax-sums.estimated_tax
              ELSE p.totals->>'availableResultAfterTax' IS NOT NULL END
         OR p.totals->>'netProfit' IS NOT NULL OR sums.line_count=0 OR sums.line_quality_matches IS NOT TRUE
       ))
       OR NEW.quality IS DISTINCT FROM p.quality OR NEW.missing_reasons IS DISTINCT FROM p.missing_reasons
     )
  ) THEN
    RAISE EXCEPTION 'target period result totals or quality do not reconcile' USING ERRCODE='23514';
  END IF;

  IF EXISTS(
    SELECT 1 FROM mc.result_evidence e
    JOIN mc.result_lines l ON l.id=e.result_line_id
    JOIN mc.financial_components f ON f.id=e.financial_component_id
    JOIN mc.operation_versions o ON o.id=f.operation_version_id
    WHERE l.run_id=NEW.id AND (o.accounting_date<>l.accounting_date OR o.accounting_date NOT BETWEEN NEW.period_start AND NEW.period_end)
  ) OR EXISTS(
    SELECT 1 FROM mc.result_evidence e
    JOIN mc.result_lines l ON l.id=e.result_line_id
    JOIN mc.operation_versions o ON o.id=e.source_operation_version_id
    WHERE l.run_id=NEW.id AND e.cost_version_id IS NOT NULL
      AND (o.accounting_date<>l.accounting_date OR o.accounting_date NOT BETWEEN NEW.period_start AND NEW.period_end)
  ) THEN
    RAISE EXCEPTION 'target result evidence is outside its exact accounting date' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER target_period_finish_guard BEFORE UPDATE ON mc.calculation_runs
  FOR EACH ROW EXECUTE FUNCTION mc.guard_target_period_finish();

INSERT INTO mc.schema_migrations(version) VALUES(28);
COMMIT;
