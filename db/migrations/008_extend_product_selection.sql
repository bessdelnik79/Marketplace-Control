BEGIN;

CREATE OR REPLACE FUNCTION mc.guard_selection_item() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE selection_status text; max_products integer;
BEGIN
  PERFORM 1 FROM mc.businesses WHERE id=NEW.business_id FOR UPDATE;
  SELECT status INTO selection_status FROM mc.product_selections
    WHERE id=NEW.selection_id AND store_id=NEW.store_id AND business_id=NEW.business_id;
  IF selection_status IS NULL OR (selection_status='confirmed' AND coalesce(current_setting('app.selection_extension',true),'')<>'on')
      OR selection_status NOT IN ('draft','confirmed') THEN
    RAISE EXCEPTION 'selection is unavailable or belongs to another store' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM mc.products WHERE id=NEW.product_id
      AND store_id=NEW.store_id AND business_id=NEW.business_id AND status='active') THEN
    RAISE EXCEPTION 'active product from current store required' USING ERRCODE='23514';
  END IF;
  SELECT v.product_limit INTO max_products FROM mc.subscriptions s JOIN mc.billing_plan_versions v ON v.id=s.plan_version_id
    WHERE s.business_id=NEW.business_id AND s.status='active' AND (s.period_end IS NULL OR s.period_end>now());
  IF max_products IS NULL OR (SELECT count(*) FROM mc.product_selection_items WHERE business_id=NEW.business_id) >= max_products THEN
    RAISE EXCEPTION 'product limit exceeded' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION mc.add_products_to_selection(p_store_id uuid, p_products uuid[])
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, mc AS $$
DECLARE b uuid := mc.context_business_id(); u uuid := mc.context_user_id(); selection_uuid uuid; max_products integer;
BEGIN
  IF b IS NULL OR u IS NULL OR NOT EXISTS (SELECT 1 FROM mc.memberships WHERE business_id=b AND user_id=u AND role IN ('owner','editor')) THEN
    RAISE EXCEPTION 'authenticated business editor required' USING ERRCODE='42501';
  END IF;
  PERFORM 1 FROM mc.businesses WHERE id=b FOR UPDATE;
  SELECT id INTO selection_uuid FROM mc.product_selections
    WHERE business_id=b AND store_id=p_store_id AND status='confirmed' FOR UPDATE;
  IF selection_uuid IS NULL THEN
    RAISE EXCEPTION 'confirmed selection not found' USING ERRCODE='23514';
  END IF;
  IF p_products IS NULL OR cardinality(p_products)=0 OR array_position(p_products,NULL) IS NOT NULL
      OR cardinality(p_products)<>(SELECT count(DISTINCT x) FROM unnest(p_products) x) THEN
    RAISE EXCEPTION 'provide a nonempty list of distinct products' USING ERRCODE='23514';
  END IF;
  IF (SELECT count(*) FROM mc.products WHERE business_id=b AND store_id=p_store_id
        AND status='active' AND id=ANY(p_products))<>cardinality(p_products) THEN
    RAISE EXCEPTION 'active product from current store required' USING ERRCODE='23514';
  END IF;
  IF EXISTS (SELECT 1 FROM mc.product_selection_items WHERE business_id=b AND product_id=ANY(p_products)) THEN
    RAISE EXCEPTION 'product already selected' USING ERRCODE='23514';
  END IF;
  SELECT v.product_limit INTO max_products FROM mc.subscriptions s JOIN mc.billing_plan_versions v ON v.id=s.plan_version_id
    WHERE s.business_id=b AND s.status='active' AND (s.period_end IS NULL OR s.period_end>now());
  IF max_products IS NULL OR (SELECT count(*) FROM mc.product_selection_items WHERE business_id=b)+cardinality(p_products)>max_products THEN
    RAISE EXCEPTION 'product limit exceeded' USING ERRCODE='23514';
  END IF;
  PERFORM set_config('app.selection_extension','on',true);
  INSERT INTO mc.product_selection_items(business_id,store_id,selection_id,product_id)
    SELECT b,p_store_id,selection_uuid,x FROM unnest(p_products) x;
  RETURN selection_uuid;
END $$;

INSERT INTO mc.schema_migrations(version) VALUES(8);
COMMIT;
