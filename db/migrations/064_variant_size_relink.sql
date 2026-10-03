BEGIN;

-- Rebuild existing normalization evidence only when the report's explicit
-- article and size identify exactly one active variant of that same product.
-- A barcode owned by a different article is never reassigned.
ALTER TABLE mc.stores NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.memberships NO FORCE ROW LEVEL SECURITY;
DO $relink$
DECLARE target record; actor uuid;
  prior_business text:=current_setting('app.business_id',true); prior_user text:=current_setting('app.user_id',true);
BEGIN
  FOR target IN SELECT business_id,id FROM mc.stores WHERE status='active' ORDER BY business_id,id LOOP
    actor:=NULL;
    SELECT user_id INTO actor FROM mc.memberships WHERE business_id=target.business_id AND role IN('owner','editor')
      ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END,created_at,user_id LIMIT 1;
    IF actor IS NULL THEN CONTINUE; END IF;
    PERFORM set_config('app.business_id',target.business_id::text,true);
    PERFORM set_config('app.user_id',actor::text,true);
    IF EXISTS(
      SELECT 1 FROM mc.reports report
      JOIN mc.report_versions version ON version.id=report.current_version_id AND version.status='accepted' AND version.parser_version='wb-finance-v13'
      JOIN LATERAL (
        SELECT normalization.id FROM mc.report_normalizations normalization
        JOIN mc.method_versions method ON method.id=normalization.method_version_id
        WHERE normalization.report_version_id=version.id AND normalization.status='succeeded'
          AND method.implementation_version='wb-finance-v13'
        ORDER BY normalization.catalog_revision DESC,normalization.normalized_at DESC LIMIT 1
      ) latest ON true
      JOIN mc.operation_versions operation ON operation.report_normalization_id=latest.id
      JOIN mc.report_rows row ON row.id=operation.report_row_id
      JOIN mc.products product ON product.id=operation.product_id AND product.business_id=target.business_id AND product.store_id=target.id
      WHERE report.business_id=target.business_id AND report.store_id=target.id
        AND operation.operation_type IN('sale','return') AND operation.variant_id IS NULL
        AND row.raw_data->>'nmId'=product.wb_article::text
        AND nullif(btrim(row.raw_data->>'techSize'),'') IS NOT NULL
        AND (SELECT count(*) FROM mc.variants variant WHERE variant.business_id=target.business_id AND variant.store_id=target.id
          AND variant.product_id=product.id AND variant.status='active'
          AND btrim(variant.size_label)=btrim(row.raw_data->>'techSize'))=1
    ) THEN
      -- The existing reconciliation barrier creates immutable normalizations,
      -- resolves the previous issue, and emits local-only report-update events.
      UPDATE mc.stores SET catalog_revision=catalog_revision+1 WHERE business_id=target.business_id AND id=target.id;
    END IF;
  END LOOP;
  PERFORM set_config('app.business_id',coalesce(prior_business,''),true);
  PERFORM set_config('app.user_id',coalesce(prior_user,''),true);
END $relink$;
ALTER TABLE mc.memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.stores FORCE ROW LEVEL SECURITY;

INSERT INTO mc.schema_migrations(version) VALUES(64);
COMMIT;
