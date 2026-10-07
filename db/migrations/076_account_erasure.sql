BEGIN;

-- No personal data and no tenant FK: cleanup must survive the account deletion.
CREATE TABLE mc.account_erasure_cleanup (
  erased_business_id uuid PRIMARY KEY,
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now()
);
CREATE SCHEMA mc_erasure_private;
REVOKE ALL ON SCHEMA mc_erasure_private FROM PUBLIC;
CREATE TABLE mc_erasure_private.permits (
  transaction_id xid8 NOT NULL,
  business_id uuid NOT NULL,
  PRIMARY KEY(transaction_id,business_id)
);
REVOKE ALL ON mc_erasure_private.permits FROM PUBLIC;

CREATE FUNCTION mc.account_erasure_permitted(p_business_id uuid) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,mc_erasure_private AS $$
  SELECT EXISTS(SELECT 1 FROM permits WHERE transaction_id=pg_current_xact_id() AND business_id=p_business_id)
$$;
REVOKE ALL ON FUNCTION mc.account_erasure_permitted(uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION mc.reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' AND mc.account_erasure_permitted(
    CASE WHEN TG_TABLE_SCHEMA='mc' AND TG_TABLE_NAME='businesses' THEN (to_jsonb(OLD)->>'id')::uuid
    ELSE (to_jsonb(OLD)->>'business_id')::uuid END) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'immutable record: %.%', TG_TABLE_SCHEMA, TG_TABLE_NAME USING ERRCODE='23514';
END $$;

-- Keep the existing generation transition contract; add only the authorized DELETE.
DO $$ DECLARE definition text; BEGIN
  SELECT pg_get_functiondef('mc.guard_financial_daily_generation()'::regprocedure) INTO definition;
  definition:=replace(definition,
    'IF TG_OP=''DELETE'' THEN RAISE EXCEPTION',
    'IF TG_OP=''DELETE'' AND mc.account_erasure_permitted(OLD.business_id) THEN RETURN OLD; END IF; IF TG_OP=''DELETE'' THEN RAISE EXCEPTION');
  EXECUTE definition;
END $$;

-- All tenant rows are removed in one transaction, including circular histories.
DO $$ DECLARE item record; definition text; BEGIN
  FOR item IN SELECT c.oid,c.conrelid::regclass AS relation,c.conname,c.confdeltype
    FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace
    WHERE n.nspname='mc' AND c.contype='f' AND c.confdeltype IN ('a','r')
      AND EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.conrelid AND a.attname='business_id' AND NOT a.attisdropped)
  LOOP
    IF item.confdeltype='r' THEN
      SELECT pg_get_constraintdef(item.oid) INTO definition;
      definition:=replace(definition,'ON DELETE RESTRICT','ON DELETE NO ACTION');
      EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I',item.relation,item.conname);
      EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s',item.relation,item.conname,definition);
    END IF;
    EXECUTE format('ALTER TABLE %s ALTER CONSTRAINT %I DEFERRABLE INITIALLY IMMEDIATE',item.relation,item.conname);
  END LOOP;
END $$;

CREATE FUNCTION mc.account_source_write_allowed(p_business_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mc AS $$
DECLARE previous_business text:=current_setting('app.business_id',true); result boolean;
BEGIN
  PERFORM set_config('app.business_id',p_business_id::text,true);
  SELECT EXISTS(SELECT 1 FROM mc.businesses WHERE id=p_business_id)
    AND NOT EXISTS(SELECT 1 FROM mc.account_erasure_cleanup WHERE erased_business_id=p_business_id) INTO result;
  PERFORM set_config('app.business_id',coalesce(previous_business,''),true);
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION mc.account_source_write_allowed(uuid) FROM PUBLIC;

CREATE FUNCTION mc.erase_account(p_user_id uuid,p_session_hash text,p_expected_password_hash text)
RETURNS uuid[] LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mc,mc_erasure_private AS $$
DECLARE account mc.users%ROWTYPE; credential text; business uuid; businesses uuid[]; item record;
BEGIN
  IF p_user_id IS DISTINCT FROM mc.context_user_id() THEN RAISE EXCEPTION 'account_erasure_forbidden'; END IF;
  SELECT * INTO account FROM mc.users WHERE id=p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'account_erasure_forbidden'; END IF;
  SELECT password_hash INTO credential FROM mc.auth_password_credentials WHERE user_id=p_user_id FOR UPDATE;
  PERFORM 1 FROM mc.auth_sessions WHERE user_id=p_user_id AND token_hash=p_session_hash AND expires_at>now()
    AND (credential IS NOT NULL OR created_at>=now()-interval '10 minutes') FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'account_erasure_reauthentication_required';
  END IF;
  IF credential IS DISTINCT FROM p_expected_password_hash THEN RAISE EXCEPTION 'account_erasure_reauthentication_required'; END IF;
  SELECT coalesce(array_agg(business_id ORDER BY business_id),'{}'::uuid[]) INTO businesses FROM mc.memberships WHERE user_id=p_user_id;
  FOREACH business IN ARRAY businesses LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('account-erasure:'||business::text,0));
    PERFORM set_config('app.business_id',business::text,true);
    PERFORM 1 FROM mc.businesses WHERE id=business FOR UPDATE;
    -- Lock all memberships to prevent concurrent owner/member changes.
    PERFORM 1 FROM mc.memberships WHERE business_id=business FOR UPDATE;
    IF NOT EXISTS(SELECT 1 FROM mc.memberships WHERE business_id=business AND user_id=p_user_id AND role='owner')
       OR EXISTS(SELECT 1 FROM mc.memberships WHERE business_id=business AND user_id<>p_user_id) THEN
      RAISE EXCEPTION 'account_erasure_shared_business';
    END IF;
    INSERT INTO mc_erasure_private.permits VALUES(pg_current_xact_id(),business);
    INSERT INTO mc.account_erasure_cleanup(erased_business_id) VALUES(business) ON CONFLICT DO NOTHING;
  END LOOP;
  SET CONSTRAINTS ALL DEFERRED;
  FOREACH business IN ARRAY businesses LOOP
    PERFORM set_config('app.business_id',business::text,true);
    FOR item IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='business_id' AND NOT a.attisdropped
      WHERE n.nspname='mc' AND c.relkind='r' ORDER BY c.relname
    LOOP
      EXECUTE format('DELETE FROM mc.%I WHERE business_id=$1',item.relname) USING business;
    END LOOP;
    DELETE FROM mc.businesses WHERE id=business;
  END LOOP;
  DELETE FROM mc.auth_registration_challenges WHERE lower(email)=lower(account.email);
  DELETE FROM mc.auth_rate_limits WHERE bucket_key IN ('account-erasure:'||p_user_id::text,'wb-connect:'||p_user_id::text)
    OR left(bucket_key,length('password:'||p_user_id::text||':'))='password:'||p_user_id::text||':'
    OR bucket_key='verify:'||account.email
    OR (left(bucket_key,6)='login:' AND right(bucket_key,length(account.email)+1)=':'||account.email);
  DELETE FROM mc.auth_identities WHERE user_id=p_user_id;
  DELETE FROM mc.auth_sessions WHERE user_id=p_user_id;
  DELETE FROM mc.auth_password_credentials WHERE user_id=p_user_id;
  DELETE FROM mc.users WHERE id=p_user_id;
  -- Any foreign-tenant reference fails the entire transaction, never cascades.
  SET CONSTRAINTS ALL IMMEDIATE;
  DELETE FROM mc_erasure_private.permits WHERE transaction_id=pg_current_xact_id();
  RETURN businesses;
END $$;
REVOKE ALL ON FUNCTION mc.erase_account(uuid,text,text) FROM PUBLIC;
REVOKE ALL ON mc.account_erasure_cleanup FROM PUBLIC;
INSERT INTO mc.schema_migrations(version) VALUES(76);
COMMIT;
