BEGIN;

-- Internal scheduler metadata only. Tenant markers retain FORCE RLS; the
-- scheduler must discover their context before attempting any tenant read.
CREATE TABLE mc.calculation_dispatch (
  store_id uuid PRIMARY KEY,
  business_id uuid NOT NULL,
  requested_by uuid,
  generation_token uuid NOT NULL,
  invalidated_at timestamptz NOT NULL,
  FOREIGN KEY (business_id,store_id)
    REFERENCES mc.calculation_invalidations(business_id,store_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE
);
CREATE INDEX calculation_dispatch_time
  ON mc.calculation_dispatch(invalidated_at,store_id);
REVOKE ALL ON mc.calculation_dispatch FROM PUBLIC;

CREATE FUNCTION mc.mirror_calculation_dispatch()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mc AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    DELETE FROM mc.calculation_dispatch
      WHERE business_id=OLD.business_id AND store_id=OLD.store_id
        AND generation_token=OLD.generation_token;
    RETURN OLD;
  END IF;
  IF TG_OP='UPDATE' THEN
    IF OLD.store_id IS DISTINCT FROM NEW.store_id THEN
      DELETE FROM mc.calculation_dispatch WHERE store_id=OLD.store_id;
    END IF;
  END IF;
  INSERT INTO mc.calculation_dispatch(store_id,business_id,requested_by,generation_token,invalidated_at)
    VALUES(NEW.store_id,NEW.business_id,NEW.requested_by,NEW.generation_token,NEW.invalidated_at)
  ON CONFLICT(store_id) DO UPDATE SET business_id=excluded.business_id,
    requested_by=excluded.requested_by,generation_token=excluded.generation_token,
    invalidated_at=excluded.invalidated_at;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION mc.mirror_calculation_dispatch() FROM PUBLIC;
CREATE TRIGGER calculation_dispatch_mirror
  AFTER INSERT OR UPDATE OR DELETE ON mc.calculation_invalidations
  FOR EACH ROW EXECUTE FUNCTION mc.mirror_calculation_dispatch();

-- Backfill existing work in this migration transaction, then restore RLS
-- enforcement before any application transaction can observe the change.
ALTER TABLE mc.calculation_invalidations NO FORCE ROW LEVEL SECURITY;
INSERT INTO mc.calculation_dispatch(store_id,business_id,requested_by,generation_token,invalidated_at)
  SELECT store_id,business_id,requested_by,generation_token,invalidated_at
  FROM mc.calculation_invalidations;
ALTER TABLE mc.calculation_invalidations FORCE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION mc.list_calculation_invalidations()
RETURNS TABLE(store_id uuid,requested_by uuid,generation_token uuid)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,mc AS $$
  SELECT i.store_id,i.requested_by,i.generation_token
  FROM mc.calculation_dispatch i
  WHERE i.requested_by IS NOT NULL
  ORDER BY i.invalidated_at,i.store_id
$$;
REVOKE ALL ON FUNCTION mc.list_calculation_invalidations() FROM PUBLIC;

CREATE OR REPLACE FUNCTION mc.ack_calculation_invalidation(p_user_id uuid,p_store_id uuid,p_generation_token uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mc AS $$
DECLARE target_business uuid; acknowledged boolean:=false;
  previous_user text:=current_setting('app.user_id',true);
  previous_business text:=current_setting('app.business_id',true);
BEGIN
  SELECT business_id INTO target_business FROM mc.calculation_dispatch
    WHERE store_id=p_store_id AND generation_token=p_generation_token;
  IF target_business IS NULL OR p_user_id IS NULL THEN RETURN false; END IF;
  PERFORM set_config('app.user_id',p_user_id::text,true);
  PERFORM set_config('app.business_id',target_business::text,true);
  IF EXISTS (SELECT 1 FROM mc.memberships
      WHERE business_id=target_business AND user_id=p_user_id AND role IN ('owner','editor')) THEN
    DELETE FROM mc.calculation_invalidations
      WHERE business_id=target_business AND store_id=p_store_id
        AND generation_token=p_generation_token;
    acknowledged:=FOUND;
  END IF;
  PERFORM set_config('app.user_id',coalesce(previous_user,''),true);
  PERFORM set_config('app.business_id',coalesce(previous_business,''),true);
  RETURN acknowledged;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.user_id',coalesce(previous_user,''),true);
  PERFORM set_config('app.business_id',coalesce(previous_business,''),true);
  RAISE;
END $$;
REVOKE ALL ON FUNCTION mc.ack_calculation_invalidation(uuid,uuid,uuid) FROM PUBLIC;

COMMENT ON TABLE mc.calculation_dispatch IS
  'Private transactional calculation scheduler mirror; tenant data remains in FORCE RLS calculation_invalidations.';

INSERT INTO mc.schema_migrations(version) VALUES(78);
COMMIT;
