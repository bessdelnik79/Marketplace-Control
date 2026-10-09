BEGIN;

CREATE INDEX financial_daily_evidence_result_order
  ON mc.financial_daily_evidence USING btree(daily_result_id,id);

CREATE INDEX operation_versions_normalization_date
  ON mc.operation_versions USING btree(report_normalization_id,accounting_date);

INSERT INTO mc.schema_migrations(version) VALUES(82);
COMMIT;
