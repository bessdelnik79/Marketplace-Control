BEGIN;

-- NULL product_id denotes a store-wide expense. The existing selected-product
-- foreign key continues to validate every non-NULL product_id.
ALTER TABLE mc.expenses ALTER COLUMN product_id DROP NOT NULL;
ALTER TABLE mc.expenses ADD CONSTRAINT expenses_store_fk
  FOREIGN KEY (business_id, store_id) REFERENCES mc.stores(business_id, id);

ALTER TABLE mc.expense_versions DROP CONSTRAINT expense_versions_category_check;
ALTER TABLE mc.expense_versions ADD CONSTRAINT expense_versions_category_check
  CHECK (category IN ('external_promotion','agency_services','other_external','packaging','software_services'));
INSERT INTO mc.financial_categories(code,name,class,is_promotion) VALUES
  ('packaging','Упаковка','expense',false),
  ('software_services','Программы и сервисы','expense',false);

-- Keep the former import kind valid for existing immutable import identities.
ALTER TABLE mc.import_batches DROP CONSTRAINT import_batches_kind_check;
ALTER TABLE mc.import_batches ADD CONSTRAINT import_batches_kind_check
  CHECK (kind IN ('costs','promotion_expenses','expenses'));

-- A business has one tax-setting identity per effective date. A correction
-- appends a version; a later effective date starts another identity.
CREATE TABLE mc.tax_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES mc.businesses(id),
  effective_from date NOT NULL CHECK (isfinite(effective_from)),
  current_version_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  UNIQUE (business_id, effective_from)
);
CREATE TABLE mc.tax_setting_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  tax_setting_id uuid NOT NULL,
  version_no integer NOT NULL CHECK (version_no > 0),
  regime_code text NOT NULL CHECK (regime_code IN ('usn_income','usn_income_expenses','osno')),
  usn_rate_fraction numeric,
  vat_mode text NOT NULL CHECK (vat_mode IN ('unmodeled','exempt','general','special')),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','voided')),
  currency text NOT NULL DEFAULT 'RUB' CHECK (currency = 'RUB'),
  changed_by uuid NOT NULL REFERENCES mc.users(id),
  comment text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  UNIQUE (business_id, tax_setting_id, id),
  UNIQUE (tax_setting_id, version_no),
  FOREIGN KEY (business_id, tax_setting_id) REFERENCES mc.tax_settings(business_id, id),
  CHECK ((regime_code IN ('usn_income','usn_income_expenses')
      AND usn_rate_fraction IS NOT NULL AND usn_rate_fraction BETWEEN 0 AND 1)
    OR (regime_code = 'osno' AND usn_rate_fraction IS NULL))
);
ALTER TABLE mc.tax_settings ADD CONSTRAINT tax_settings_current_version_fk
  FOREIGN KEY (business_id, id, current_version_id)
  REFERENCES mc.tax_setting_versions(business_id, tax_setting_id, id);

CREATE TRIGGER tax_setting_identity BEFORE UPDATE ON mc.tax_settings
  FOR EACH ROW EXECUTE FUNCTION mc.protect_columns('id','business_id','effective_from','created_at');
CREATE TRIGGER no_delete BEFORE DELETE ON mc.tax_settings
  FOR EACH ROW EXECUTE FUNCTION mc.reject_mutation();
CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON mc.tax_setting_versions
  FOR EACH ROW EXECUTE FUNCTION mc.reject_mutation();

-- Tax settings belong to a business, so their audit has no store_id.
CREATE FUNCTION mc.audit_tax_setting_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO mc.audit_events(business_id,actor_user_id,action,entity_type,entity_id,safe_details)
      VALUES(NEW.business_id,mc.context_user_id(),'created',TG_TABLE_NAME,NEW.id,
        jsonb_build_object('after',to_jsonb(NEW)));
  ELSIF to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
    INSERT INTO mc.audit_events(business_id,actor_user_id,action,entity_type,entity_id,safe_details)
      VALUES(NEW.business_id,mc.context_user_id(),'updated',TG_TABLE_NAME,NEW.id,
        jsonb_build_object('before',to_jsonb(OLD),'after',to_jsonb(NEW)));
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tax_setting_change_audit AFTER INSERT OR UPDATE ON mc.tax_settings
  FOR EACH ROW EXECUTE FUNCTION mc.audit_tax_setting_change();
CREATE TRIGGER tax_setting_version_audit AFTER INSERT ON mc.tax_setting_versions
  FOR EACH ROW EXECUTE FUNCTION mc.audit_tax_setting_change();

ALTER TABLE mc.tax_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE mc.tax_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mc.tax_settings
  USING (business_id=mc.context_business_id()) WITH CHECK (business_id=mc.context_business_id());
ALTER TABLE mc.tax_setting_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE mc.tax_setting_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mc.tax_setting_versions
  USING (business_id=mc.context_business_id()) WITH CHECK (business_id=mc.context_business_id());
CREATE INDEX tax_setting_version_business ON mc.tax_setting_versions(business_id);

COMMENT ON TABLE mc.tax_settings IS
  'Версионные налоговые настройки бизнеса с датой начала действия; отсутствие настройки не означает нулевой налог.';
COMMENT ON COLUMN mc.tax_setting_versions.usn_rate_fraction IS
  'Точная доля ставки УСН: 0.06 означает 6%. Для ОСНО отсутствует. Значения по умолчанию нет.';
COMMENT ON COLUMN mc.tax_setting_versions.vat_mode IS
  'Независимый от режима статус НДС. Настройка не означает поддержку расчёта НДС.';

INSERT INTO mc.schema_migrations(version) VALUES(11);
COMMIT;
