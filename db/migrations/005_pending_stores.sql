BEGIN;

-- A user may name a store before the Wildberries connection is configured.
ALTER TABLE mc.stores ALTER COLUMN external_account_id DROP NOT NULL;
ALTER TABLE mc.stores ALTER COLUMN status SET DEFAULT 'paused';
ALTER TABLE mc.stores ADD CONSTRAINT active_store_requires_external_account
  CHECK (status <> 'active' OR external_account_id IS NOT NULL);

-- Membership discovery is scoped to the authenticated user. Business context
-- is set immediately after this lookup for every following tenant query.
CREATE POLICY own_memberships ON mc.memberships FOR SELECT
  USING (user_id = mc.context_user_id());

DROP TRIGGER store_identity ON mc.stores;
CREATE TRIGGER store_identity BEFORE UPDATE ON mc.stores FOR EACH ROW
  EXECUTE FUNCTION mc.protect_columns('id','business_id','marketplace_code');

CREATE FUNCTION mc.protect_assigned_store_account() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.external_account_id IS NOT NULL
     AND NEW.external_account_id IS DISTINCT FROM OLD.external_account_id THEN
    RAISE EXCEPTION 'external_account_id cannot be changed after assignment' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER store_external_account_identity BEFORE UPDATE OF external_account_id ON mc.stores
  FOR EACH ROW EXECUTE FUNCTION mc.protect_assigned_store_account();

INSERT INTO mc.schema_migrations(version) VALUES(5);
COMMIT;
