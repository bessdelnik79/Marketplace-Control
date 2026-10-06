BEGIN;

-- Inert foundation only. Legacy selections, subscription limits, readers and
-- financial publication remain authoritative until the complete runtime cutover.
CREATE TABLE mc.tariff_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES mc.businesses(id),
  plan_id uuid NOT NULL REFERENCES mc.billing_plans(id),
  selection_confirmed boolean NOT NULL DEFAULT false,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, plan_id),
  UNIQUE (business_id, id)
);
CREATE TABLE mc.tariff_profile_stores (
  business_id uuid NOT NULL,
  profile_id uuid NOT NULL,
  store_id uuid NOT NULL,
  PRIMARY KEY (business_id, profile_id, store_id),
  FOREIGN KEY (business_id, profile_id) REFERENCES mc.tariff_profiles(business_id, id),
  FOREIGN KEY (business_id, store_id) REFERENCES mc.stores(business_id, id)
);
CREATE TABLE mc.tariff_profile_products (
  business_id uuid NOT NULL,
  profile_id uuid NOT NULL,
  store_id uuid NOT NULL,
  product_id uuid NOT NULL,
  PRIMARY KEY (business_id, profile_id, store_id, product_id),
  FOREIGN KEY (business_id, profile_id, store_id)
    REFERENCES mc.tariff_profile_stores(business_id, profile_id, store_id),
  -- Keep the historical registry as the source of product identity and evidence.
  FOREIGN KEY (business_id, store_id, product_id)
    REFERENCES mc.product_selection_items(business_id, store_id, product_id)
);
CREATE TABLE mc.tariff_profile_state (
  business_id uuid PRIMARY KEY REFERENCES mc.businesses(id),
  free_profile_id uuid NOT NULL,
  active_profile_id uuid NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  FOREIGN KEY (business_id, free_profile_id) REFERENCES mc.tariff_profiles(business_id, id),
  FOREIGN KEY (business_id, active_profile_id) REFERENCES mc.tariff_profiles(business_id, id)
);
CREATE TRIGGER tariff_profile_identity BEFORE UPDATE ON mc.tariff_profiles
  FOR EACH ROW EXECUTE FUNCTION mc.protect_columns('id','business_id','plan_id');
CREATE TRIGGER tariff_profile_state_identity BEFORE UPDATE ON mc.tariff_profile_state
  FOR EACH ROW EXECUTE FUNCTION mc.protect_columns('business_id');

CREATE FUNCTION mc.guard_tariff_free_profile() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,mc AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM mc.tariff_profiles f JOIN mc.billing_plans p ON p.id=f.plan_id
    WHERE f.business_id=NEW.business_id AND f.id=NEW.free_profile_id AND p.code='free') THEN
    RAISE EXCEPTION 'free profile from current business required' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION mc.guard_tariff_free_profile() FROM PUBLIC;
CREATE TRIGGER tariff_free_profile_guard BEFORE INSERT OR UPDATE ON mc.tariff_profile_state
  FOR EACH ROW EXECUTE FUNCTION mc.guard_tariff_free_profile();

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['tariff_profiles','tariff_profile_stores','tariff_profile_products','tariff_profile_state'] LOOP
    EXECUTE format('ALTER TABLE mc.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE mc.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY tenant_isolation ON mc.%I USING (business_id=mc.context_business_id()) WITH CHECK (business_id=mc.context_business_id())',t);
    EXECUTE format('REVOKE ALL ON mc.%I FROM PUBLIC',t);
  END LOOP;
END $$;

-- The migration owner discovers tenants, then uses their explicit context;
-- FORCE RLS remains enabled on all profile tables during backfill.
ALTER TABLE mc.businesses NO FORCE ROW LEVEL SECURITY;
DO $backfill$
DECLARE b uuid; free_plan uuid; current_plan uuid; free_profile uuid; active_profile uuid;
  prior_business text:=current_setting('app.business_id',true);
BEGIN
  SELECT id INTO STRICT free_plan FROM mc.billing_plans WHERE code='free';
  FOR b IN SELECT id FROM mc.businesses ORDER BY id LOOP
    PERFORM set_config('app.business_id',b::text,true);
    INSERT INTO mc.tariff_profiles(business_id,plan_id) VALUES(b,free_plan) RETURNING id INTO free_profile;
    SELECT v.plan_id INTO STRICT current_plan FROM mc.subscriptions s
      JOIN mc.billing_plan_versions v ON v.id=s.plan_version_id WHERE s.business_id=b;
    active_profile:=free_profile;
    IF current_plan<>free_plan THEN
      INSERT INTO mc.tariff_profiles(business_id,plan_id,selection_confirmed)
        VALUES(b,current_plan,EXISTS(SELECT 1 FROM mc.product_selections WHERE business_id=b AND status='confirmed'))
        RETURNING id INTO active_profile;
      INSERT INTO mc.tariff_profile_stores(business_id,profile_id,store_id)
        SELECT b,active_profile,id FROM mc.stores WHERE business_id=b AND status<>'archived';
      INSERT INTO mc.tariff_profile_products(business_id,profile_id,store_id,product_id)
        SELECT b,active_profile,i.store_id,i.product_id FROM mc.product_selection_items i
        JOIN mc.product_selections s ON (s.business_id,s.store_id,s.id)=(i.business_id,i.store_id,i.selection_id)
        JOIN mc.stores st ON (st.business_id,st.id)=(i.business_id,i.store_id)
        WHERE i.business_id=b AND s.status='confirmed' AND st.status<>'archived';
    END IF;
    -- The original free subset is not provable from the current extensible
    -- registry. Never guess it, even when today's subscription is free.
    INSERT INTO mc.tariff_profile_state(business_id,free_profile_id,active_profile_id)
      VALUES(b,free_profile,active_profile);
  END LOOP;
  PERFORM set_config('app.business_id',coalesce(prior_business,''),true);
END $backfill$;
ALTER TABLE mc.businesses FORCE ROW LEVEL SECURITY;

-- Trigger name sorts after default_subscription. Invoker permissions/context
-- follow registration's existing migration-owner convention, with no public API.
CREATE FUNCTION mc.initialize_tariff_profile() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,mc AS $$
DECLARE free_plan uuid; profile_uuid uuid;
BEGIN
  SELECT p.id INTO STRICT free_plan FROM mc.subscriptions s
    JOIN mc.billing_plan_versions v ON v.id=s.plan_version_id
    JOIN mc.billing_plans p ON p.id=v.plan_id
    WHERE s.business_id=NEW.id AND p.code='free';
  INSERT INTO mc.tariff_profiles(business_id,plan_id) VALUES(NEW.id,free_plan) RETURNING id INTO profile_uuid;
  INSERT INTO mc.tariff_profile_state(business_id,free_profile_id,active_profile_id)
    VALUES(NEW.id,profile_uuid,profile_uuid);
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION mc.initialize_tariff_profile() FROM PUBLIC;
CREATE TRIGGER initialize_tariff_profile AFTER INSERT ON mc.businesses
  FOR EACH ROW EXECUTE FUNCTION mc.initialize_tariff_profile();

-- No grants or membership mutation functions: trusted server/schema owner
-- owns writes, as in the existing schema. Tenant settings are not credentials.
-- This is a point-in-time snapshot, not a dual-write observer. The final runtime
-- migration MUST reconcile legacy selections changed after this migration.
INSERT INTO mc.schema_migrations(version) VALUES(73);
COMMIT;
