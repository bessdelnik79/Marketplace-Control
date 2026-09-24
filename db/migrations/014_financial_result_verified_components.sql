INSERT INTO mc.method_versions(code,version_no,description,parameters,implementation_version)
VALUES(
  'financial_result',
  2,
  'P0.3: только подтверждённые пары поля и операции WB входят в доступный результат; ПВЗ, лояльность, себестоимость возврата и налог остаются неподтверждёнными.',
  '{"classificationVerified":false,"verifiedComponents":"field-operation-name-v1","taxMethodVerified":false,"returnCostLinkVerified":false,"wbReconciliationsVerified":false}',
  'financial-result-v2'
)
ON CONFLICT(code,version_no) DO NOTHING;

INSERT INTO mc.schema_migrations(version) VALUES(14);
