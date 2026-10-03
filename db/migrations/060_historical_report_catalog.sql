BEGIN;

ALTER TABLE mc.products ADD COLUMN historical_deleted boolean NOT NULL DEFAULT false;
ALTER TABLE mc.products ADD COLUMN historical_source_row_id uuid;
ALTER TABLE mc.products ADD CONSTRAINT historical_product_evidence_fk
  FOREIGN KEY (business_id,store_id,historical_source_row_id) REFERENCES mc.report_rows(business_id,store_id,id);
ALTER TABLE mc.products ADD CONSTRAINT historical_product_evidence_required
  CHECK (NOT historical_deleted OR historical_source_row_id IS NOT NULL);
ALTER TABLE mc.variants ADD COLUMN historical_report_only boolean NOT NULL DEFAULT false;
-- Preserve the immutable original variant identity and every cost reference
-- when a report-only barcode is later found in a live WB size.
ALTER TABLE mc.variants ADD COLUMN wb_external_variant_id text;
CREATE UNIQUE INDEX variants_wb_external_variant ON mc.variants(store_id,product_id,wb_external_variant_id) WHERE wb_external_variant_id IS NOT NULL;
ALTER TABLE mc.stores ADD COLUMN catalog_revision bigint NOT NULL DEFAULT 0 CHECK (catalog_revision>=0);
ALTER TABLE mc.report_normalizations ADD COLUMN catalog_revision bigint NOT NULL DEFAULT 0 CHECK (catalog_revision>=0);
ALTER TABLE mc.report_normalizations DROP CONSTRAINT report_normalizations_report_version_id_method_version_id_key;
ALTER TABLE mc.report_normalizations ADD UNIQUE(report_version_id,method_version_id,catalog_revision);
-- A fresh import by a newer parser is new provenance even when the payload
-- checksum happens to match. Old rounded raw rows are never relabeled.
ALTER TABLE mc.report_versions DROP CONSTRAINT report_versions_report_id_checksum_key;
ALTER TABLE mc.report_versions ADD UNIQUE(report_id,checksum,parser_version);

-- Invoker security preserves tenant RLS. The business lock is also used by
-- ordinary selection extension, so the final tariff slot cannot be raced.
CREATE FUNCTION mc.recover_historical_catalog(p_store uuid,p_version uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,mc AS $$
DECLARE
  b uuid:=mc.context_business_id(); u uuid:=mc.context_user_id();
  selection_uuid uuid; max_products integer; remaining integer; revision bigint;
  candidate record; variant_row record; product_uuid uuid; variant_uuid uuid;
  added uuid[]:='{}'; changed boolean:=false; skipped integer:=0; affected integer;
BEGIN
  IF b IS NULL OR u IS NULL OR NOT EXISTS(SELECT 1 FROM mc.memberships WHERE business_id=b AND user_id=u AND role IN('owner','editor')) THEN
    RAISE EXCEPTION 'authenticated business editor required' USING ERRCODE='42501';
  END IF;
  PERFORM 1 FROM mc.businesses WHERE id=b FOR UPDATE;
  SELECT catalog_revision INTO revision FROM mc.stores WHERE business_id=b AND id=p_store AND status='active' FOR UPDATE;
  IF revision IS NULL THEN RAISE EXCEPTION 'active store required' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS(SELECT 1 FROM mc.source_documents d JOIN mc.sync_runs r ON r.id=d.sync_run_id AND r.business_id=d.business_id AND r.store_id=d.store_id
    WHERE d.business_id=b AND d.store_id=p_store AND d.origin='wb_api' AND d.document_type='catalog' AND d.completeness='complete' AND r.status='succeeded') THEN
    RETURN jsonb_build_object('catalogRevision',revision,'addedProductIds',added,'changed',false,'reason','catalog_not_ready','skippedProductCount',0);
  END IF;
  SELECT id INTO selection_uuid FROM mc.product_selections WHERE business_id=b AND store_id=p_store AND status='confirmed' FOR UPDATE;
  SELECT v.product_limit INTO max_products FROM mc.subscriptions s JOIN mc.billing_plan_versions v ON v.id=s.plan_version_id
    WHERE s.business_id=b AND s.status='active' AND (s.period_end IS NULL OR s.period_end>now());
  IF selection_uuid IS NULL OR max_products IS NULL THEN
    RETURN jsonb_build_object('catalogRevision',revision,'addedProductIds',added,'changed',false,'reason',CASE WHEN selection_uuid IS NULL THEN 'selection_not_confirmed' ELSE 'subscription_inactive' END,'skippedProductCount',0);
  END IF;
  IF p_version IS NOT NULL AND NOT EXISTS(SELECT 1 FROM mc.report_versions WHERE business_id=b AND store_id=p_store AND id=p_version AND status IN('validated','accepted')) THEN
    RAISE EXCEPTION 'saved validated report required' USING ERRCODE='23514';
  END IF;
  remaining:=greatest(0,max_products-(SELECT count(*) FROM mc.product_selection_items WHERE business_id=b));
  FOR candidate IN
    WITH evidence AS (
      SELECT rr.*,rr.raw_data->>'nmId' AS nm FROM mc.report_rows rr
      JOIN mc.report_versions rv ON rv.id=rr.report_version_id AND rv.business_id=rr.business_id AND rv.store_id=rr.store_id
      JOIN mc.reports r ON r.id=rv.report_id AND r.business_id=rv.business_id AND r.store_id=rv.store_id
      WHERE rr.business_id=b AND rr.store_id=p_store
        AND ((rv.status='accepted' AND r.current_version_id=rv.id) OR (rv.id=p_version AND rv.status IN('validated','accepted')))
    ) SELECT DISTINCT ON(nm::bigint) nm::bigint AS article,id,raw_data FROM evidence
      WHERE CASE WHEN nm ~ '^[0-9]{1,18}$' THEN nm::bigint>0 ELSE false END
      ORDER BY nm::bigint,created_at,id
  LOOP
    SELECT id INTO product_uuid FROM mc.products WHERE business_id=b AND store_id=p_store AND wb_article=candidate.article AND (status='archived' OR historical_deleted);
    -- Live WB cards and intentionally unselected live products are untouched.
    IF product_uuid IS NULL AND EXISTS(SELECT 1 FROM mc.products WHERE business_id=b AND store_id=p_store AND wb_article=candidate.article) THEN CONTINUE; END IF;
    IF product_uuid IS NULL OR NOT EXISTS(SELECT 1 FROM mc.product_selection_items WHERE business_id=b AND store_id=p_store AND product_id=product_uuid) THEN
      IF remaining=0 THEN skipped:=skipped+1; CONTINUE; END IF;
      IF product_uuid IS NULL THEN
        INSERT INTO mc.products(business_id,store_id,wb_article,seller_article,title,image_url,historical_deleted,historical_source_row_id)
          VALUES(b,p_store,candidate.article,coalesce(nullif(btrim(candidate.raw_data->>'saName'),''),nullif(btrim(candidate.raw_data->>'supplierArticle'),''),candidate.article::text),
            NULL,NULL,true,candidate.id) RETURNING id INTO product_uuid;
      END IF;
      UPDATE mc.products SET status='active',historical_deleted=true,historical_source_row_id=coalesce(historical_source_row_id,candidate.id),image_url=NULL WHERE id=product_uuid;
      PERFORM mc.add_products_to_selection(p_store,ARRAY[product_uuid]);
      remaining:=remaining-1; added:=array_append(added,product_uuid); changed:=true;
    ELSE
      UPDATE mc.products SET status='active',historical_deleted=true,historical_source_row_id=coalesce(historical_source_row_id,candidate.id),image_url=NULL
        WHERE id=product_uuid AND (status<>'active' OR NOT historical_deleted OR image_url IS NOT NULL);
      GET DIAGNOSTICS affected=ROW_COUNT; changed:=changed OR affected>0;
    END IF;
    FOR variant_row IN
      SELECT DISTINCT coalesce(nullif(btrim(rr.raw_data->>'sku'),''),btrim(rr.raw_data->>'barcode')) AS barcode FROM mc.report_rows rr
      JOIN mc.report_versions rv ON rv.id=rr.report_version_id AND rv.business_id=rr.business_id AND rv.store_id=rr.store_id
      JOIN mc.reports r ON r.id=rv.report_id
      WHERE rr.business_id=b AND rr.store_id=p_store AND rr.raw_data->>'nmId'=candidate.article::text
        AND ((rv.status='accepted' AND r.current_version_id=rv.id) OR (rv.id=p_version AND rv.status IN('validated','accepted')))
        AND nullif(coalesce(nullif(btrim(rr.raw_data->>'sku'),''),btrim(rr.raw_data->>'barcode')),'') IS NOT NULL AND coalesce(nullif(btrim(rr.raw_data->>'sku'),''),btrim(rr.raw_data->>'barcode'))<>'0'
      ORDER BY barcode
    LOOP
      -- A barcode claimed by a different article in saved current evidence is
      -- ambiguous even if it has not yet been materialized as an identifier.
      IF EXISTS(SELECT 1 FROM mc.report_rows rr JOIN mc.report_versions rv ON rv.id=rr.report_version_id JOIN mc.reports r ON r.id=rv.report_id
        WHERE rr.business_id=b AND rr.store_id=p_store AND coalesce(nullif(btrim(rr.raw_data->>'sku'),''),btrim(rr.raw_data->>'barcode'))=variant_row.barcode
          AND rr.raw_data->>'nmId'<>candidate.article::text
          AND ((rv.status='accepted' AND r.current_version_id=rv.id) OR (rv.id=p_version AND rv.status IN('validated','accepted')))) THEN CONTINUE; END IF;
      SELECT v.id INTO variant_uuid FROM mc.variant_identifiers i JOIN mc.variants v ON v.id=i.variant_id
        WHERE i.business_id=b AND i.store_id=p_store AND i.identifier_type='barcode' AND i.identifier_value=variant_row.barcode AND i.valid_to IS NULL AND v.product_id=product_uuid;
      IF variant_uuid IS NULL THEN
        IF EXISTS(SELECT 1 FROM mc.variant_identifiers WHERE business_id=b AND store_id=p_store AND identifier_type='barcode' AND identifier_value=variant_row.barcode AND valid_to IS NULL) THEN CONTINUE; END IF;
        INSERT INTO mc.variants(business_id,store_id,product_id,external_variant_id,historical_report_only)
          VALUES(b,p_store,product_uuid,'historical:'||variant_row.barcode,true)
          ON CONFLICT(store_id,product_id,external_variant_id) DO UPDATE SET status='active'
          RETURNING id INTO variant_uuid;
        INSERT INTO mc.variant_identifiers(business_id,store_id,variant_id,identifier_type,identifier_value)
          VALUES(b,p_store,variant_uuid,'barcode',variant_row.barcode);
        changed:=true;
      ELSE
        UPDATE mc.variants SET status='active' WHERE id=variant_uuid AND status<>'active';
        GET DIAGNOSTICS affected=ROW_COUNT; changed:=changed OR affected>0;
      END IF;
    END LOOP;
  END LOOP;
  IF changed THEN UPDATE mc.stores SET catalog_revision=catalog_revision+1 WHERE business_id=b AND id=p_store RETURNING catalog_revision INTO revision; END IF;
  RETURN jsonb_build_object('catalogRevision',revision,'addedProductIds',added,'changed',changed,'reason',CASE WHEN skipped>0 THEN 'product_limit_reached' ELSE NULL END,'skippedProductCount',skipped);
END $$;

INSERT INTO mc.schema_migrations(version) VALUES(60);
COMMIT;
