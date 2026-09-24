CREATE TABLE mc.financial_report_summary_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  store_id uuid NOT NULL,
  report_version_id uuid NOT NULL,
  sync_run_id uuid NOT NULL,
  checksum text NOT NULL,
  raw_data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (report_version_id, checksum),
  FOREIGN KEY (business_id, store_id, report_version_id) REFERENCES mc.report_versions(business_id, store_id, id),
  FOREIGN KEY (business_id, store_id, sync_run_id) REFERENCES mc.sync_runs(business_id, store_id, id)
);
CREATE INDEX financial_report_summary_current ON mc.financial_report_summary_versions(report_version_id, created_at DESC);
CREATE INDEX reconciliation_checks_report_latest ON mc.reconciliation_checks(business_id, store_id, report_version_id, check_code, created_at DESC, id DESC)
  WHERE report_version_id IS NOT NULL;
CREATE TRIGGER financial_report_summary_immutable BEFORE UPDATE OR DELETE ON mc.financial_report_summary_versions
  FOR EACH ROW EXECUTE FUNCTION mc.reject_mutation();
ALTER TABLE mc.financial_report_summary_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE mc.financial_report_summary_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mc.financial_report_summary_versions
  USING (business_id=mc.context_business_id()) WITH CHECK (business_id=mc.context_business_id());
CREATE INDEX ON mc.financial_report_summary_versions(business_id);

INSERT INTO mc.schema_migrations(version) VALUES(13);
