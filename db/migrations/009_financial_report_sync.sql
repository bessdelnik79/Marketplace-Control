BEGIN;

ALTER TABLE mc.sync_runs ADD COLUMN progress jsonb NOT NULL DEFAULT '{}';

INSERT INTO mc.financial_categories(code,name,class,is_promotion) VALUES
 ('acquiring','Эквайринг','expense',false),
 ('deduction','Удержания','expense',false),
 ('additional_payment','Дополнительные выплаты','income',false)
ON CONFLICT(code) DO NOTHING;

INSERT INTO mc.method_versions(code,version_no,description,parameters,implementation_version)
VALUES(
  'wb_finance_import',
  1,
  'Нормализация детализации еженедельных отчётов реализации WB Finance API. Не является формулой полной прибыли.',
  '{"endpoint":"/api/finance/v1/sales-reports/detailed","period":"weekly","accountingDate":"rrDate"}',
  'wb-finance-v1'
)
ON CONFLICT(code,version_no) DO NOTHING;

CREATE INDEX reports_by_store_period ON mc.reports(business_id,store_id,period_start,period_end);
CREATE INDEX report_rows_by_external_key ON mc.report_rows(report_version_id,external_row_key);
CREATE INDEX sync_runs_latest ON mc.sync_runs(stream_id,created_at DESC);

INSERT INTO mc.schema_migrations(version) VALUES(9);
COMMIT;
