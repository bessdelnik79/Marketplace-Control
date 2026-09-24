BEGIN;

INSERT INTO mc.method_versions(code,version_no,description,parameters,implementation_version)
VALUES(
  'wb_finance_import',
  3,
  'Классификация подтверждённых расходов WB без товарных идентификаторов на уровне магазина. Старые нормализации и публикации сохраняются; повторный импорт того же отчёта создаёт новую нормализацию из сохранённых строк.',
  '{"endpoint":"/api/finance/v1/sales-reports/detailed","period":"weekly","accountingDate":"rrDate","storeScope":"exact-field-document-operation-positive-v1"}',
  'wb-finance-v3'
)
ON CONFLICT(code,version_no) DO NOTHING;

INSERT INTO mc.schema_migrations(version) VALUES(15);
COMMIT;
