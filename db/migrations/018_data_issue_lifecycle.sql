BEGIN;

INSERT INTO mc.method_versions(code,version_no,description,parameters,implementation_version)
VALUES('wb_finance_import',4,
  'Регистрация неподтверждённых денежных компонентов и version-aware жизненный цикл проблем нормализации.',
  '{"dataIssueLifecycle":true,"unverifiedMoneyIssues":true}',
  'wb-finance-v4')
ON CONFLICT(code,version_no) DO NOTHING;

ALTER TABLE mc.data_issues
  ADD COLUMN report_normalization_id uuid,
  ADD COLUMN resolved_at timestamptz,
  ADD COLUMN resolved_by_normalization_id uuid;

UPDATE mc.data_issues di
SET report_normalization_id=selected.id
FROM mc.report_rows rr
CROSS JOIN LATERAL (
  SELECT rn.id
  FROM mc.report_normalizations rn
  JOIN mc.method_versions m ON m.id=rn.method_version_id
  WHERE rn.report_version_id=rr.report_version_id AND rn.status='succeeded'
  ORDER BY m.version_no DESC,rn.normalized_at DESC,rn.id DESC
  LIMIT 1
) selected
WHERE rr.id=di.report_row_id AND di.report_normalization_id IS NULL;

WITH ranked AS (
  SELECT id,report_normalization_id,
         row_number() OVER(PARTITION BY report_normalization_id,report_row_id,code ORDER BY created_at DESC,id DESC) AS position
  FROM mc.data_issues
  WHERE report_normalization_id IS NOT NULL AND report_row_id IS NOT NULL AND status='open'
)
UPDATE mc.data_issues di
SET status='resolved',resolved_at=now(),resolved_by_normalization_id=ranked.report_normalization_id
FROM ranked WHERE ranked.id=di.id AND ranked.position>1;

ALTER TABLE mc.data_issues
  ADD CONSTRAINT data_issue_normalization_fk
    FOREIGN KEY (business_id,store_id,report_normalization_id)
    REFERENCES mc.report_normalizations(business_id,store_id,id),
  ADD CONSTRAINT data_issue_resolved_normalization_fk
    FOREIGN KEY (business_id,store_id,resolved_by_normalization_id)
    REFERENCES mc.report_normalizations(business_id,store_id,id),
  ADD CONSTRAINT data_issue_resolution_state
    CHECK (
      (status='open' AND resolved_at IS NULL AND resolved_by_normalization_id IS NULL)
      OR (status='resolved' AND resolved_at IS NOT NULL AND resolved_by_normalization_id IS NOT NULL)
      OR status='accepted_limitation'
    );

CREATE UNIQUE INDEX data_issues_normalization_code_unique
  ON mc.data_issues(report_normalization_id,report_row_id,code)
  WHERE report_normalization_id IS NOT NULL AND report_row_id IS NOT NULL AND status='open';

CREATE INDEX data_issues_current_normalization
  ON mc.data_issues(store_id,report_normalization_id,status);

CREATE FUNCTION mc.guard_data_issue_normalization() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.report_normalization_id IS NOT NULL AND NOT EXISTS(
    SELECT 1
    FROM mc.report_normalizations rn
    JOIN mc.report_rows rr ON rr.report_version_id=rn.report_version_id
    WHERE rn.id=NEW.report_normalization_id AND rr.id=NEW.report_row_id
      AND rn.business_id=NEW.business_id AND rn.store_id=NEW.store_id
  ) THEN
    RAISE EXCEPTION 'data_issue_normalization_mismatch';
  END IF;
  IF NEW.resolved_by_normalization_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM mc.report_normalizations resolver
    JOIN mc.report_versions resolver_version ON resolver_version.id=resolver.report_version_id
    JOIN mc.report_normalizations original ON original.id=NEW.report_normalization_id
    JOIN mc.report_versions original_version ON original_version.id=original.report_version_id AND original_version.report_id=resolver_version.report_id
    WHERE resolver.id=NEW.resolved_by_normalization_id
      AND resolver.business_id=NEW.business_id AND resolver.store_id=NEW.store_id
  ) THEN
    RAISE EXCEPTION 'data_issue_resolution_mismatch';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER data_issue_normalization_guard
  BEFORE INSERT OR UPDATE ON mc.data_issues
  FOR EACH ROW EXECUTE FUNCTION mc.guard_data_issue_normalization();

INSERT INTO mc.schema_migrations(version) VALUES(18);
COMMIT;
