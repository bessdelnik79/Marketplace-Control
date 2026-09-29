BEGIN;

DO $guard$
DECLARE definition text; updated text;
BEGIN
  SELECT pg_get_functiondef('mc.guard_run_finish()'::regprocedure) INTO definition;
  updated:=replace(definition,
    'OR (e.financial_component_id IS NOT NULL AND EXISTS(SELECT 1 FROM mc.calculation_inputs i WHERE i.run_id=NEW.id AND(i.report_version_id=rr.report_version_id OR(i.report_normalization_id=o.report_normalization_id AND f.method_version_id=rn.method_version_id))))',
    'OR (e.financial_component_id IS NOT NULL AND EXISTS(SELECT 1 FROM mc.calculation_inputs i WHERE i.run_id=NEW.id AND(i.report_version_id=rr.report_version_id OR(i.report_normalization_id=o.report_normalization_id AND f.method_version_id=rn.method_version_id))))
      OR (e.report_row_id IS NOT NULL AND e.source_operation_version_id IS NOT NULL
        AND l.category_code IN(''return_wb_expense_reversal'',''wb_row_rounding_adjustment'')
        AND EXISTS(SELECT 1 FROM mc.operation_versions source_operation
          JOIN mc.report_rows source_row ON source_row.id=source_operation.report_row_id
          JOIN mc.calculation_inputs normalization_input ON normalization_input.run_id=NEW.id
            AND normalization_input.report_normalization_id=source_operation.report_normalization_id
          JOIN mc.calculation_inputs version_input ON version_input.run_id=NEW.id
            AND version_input.report_version_id=source_row.report_version_id
          WHERE source_operation.id=e.source_operation_version_id AND source_operation.report_row_id=e.report_row_id)
        AND(e.operation_link_id IS NULL OR EXISTS(SELECT 1 FROM mc.calculation_inputs link_input
          WHERE link_input.run_id=NEW.id AND link_input.operation_link_id=e.operation_link_id)))');
  IF updated=definition OR position('wb_row_rounding_adjustment' in updated)=0 THEN
    RAISE EXCEPTION 'guard_run_finish exact WB row input contract not found';
  END IF;
  EXECUTE updated;
END $guard$;

INSERT INTO mc.schema_migrations(version) VALUES(58);

COMMIT;
