BEGIN;

ALTER TABLE mc.financial_daily_generations ADD COLUMN tariff_scope_token text;
ALTER TABLE mc.calculation_requests ADD COLUMN tariff_scope_token text;

CREATE FUNCTION mc.financial_tariff_scope_matches(p_store uuid,p_products uuid[],p_token text DEFAULT NULL)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,mc AS $$
  SELECT coalesce((SELECT c.selection_confirmed
    AND EXISTS(SELECT 1 FROM mc.active_profile_stores WHERE business_id=c.business_id AND store_id=p_store)
    AND (p_token IS NULL OR p_token=c.scope_token)
    AND ARRAY(SELECT DISTINCT x FROM unnest(p_products) x ORDER BY x)=
      ARRAY(SELECT product_id FROM mc.active_profile_products WHERE business_id=c.business_id AND store_id=p_store ORDER BY product_id)
    FROM mc.effective_tariff_context() c),false)
$$;
REVOKE ALL ON FUNCTION mc.financial_tariff_scope_matches(uuid,uuid[],text) FROM PUBLIC;

CREATE FUNCTION mc.freeze_financial_tariff_scope() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,mc AS $$
DECLARE token text; expected text:=nullif(current_setting('app.financial_tariff_scope',true),'');
BEGIN
  SELECT scope_token INTO token FROM mc.effective_tariff_context(NEW.business_id);
  IF expected IS NOT NULL AND expected IS DISTINCT FROM token THEN
    RAISE EXCEPTION 'financial_tariff_scope_stale' USING ERRCODE='23514';
  END IF;
  NEW.tariff_scope_token:=token;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION mc.freeze_financial_tariff_scope() FROM PUBLIC;
CREATE TRIGGER financial_daily_tariff_scope BEFORE INSERT ON mc.financial_daily_generations
  FOR EACH ROW EXECUTE FUNCTION mc.freeze_financial_tariff_scope();
CREATE TRIGGER calculation_request_tariff_scope BEFORE INSERT ON mc.calculation_requests
  FOR EACH ROW EXECUTE FUNCTION mc.freeze_financial_tariff_scope();
CREATE TRIGGER financial_daily_tariff_scope_identity BEFORE UPDATE ON mc.financial_daily_generations
  FOR EACH ROW EXECUTE FUNCTION mc.protect_columns('tariff_scope_token');
CREATE TRIGGER calculation_request_tariff_scope_identity BEFORE UPDATE ON mc.calculation_requests
  FOR EACH ROW EXECUTE FUNCTION mc.protect_columns('tariff_scope_token');

CREATE FUNCTION mc.financial_daily_publication_tariff_allowed(p_publication uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,mc AS $$
  SELECT EXISTS(SELECT 1 FROM mc.financial_daily_publications p WHERE p.id=p_publication AND p.business_id=mc.context_business_id())
    AND NOT EXISTS(
      SELECT 1 FROM mc.financial_daily_generations g WHERE g.business_id=mc.context_business_id()
        AND (g.id IN(SELECT generation_id FROM mc.financial_daily_publication_days WHERE publication_id=p_publication)
          OR g.id IN(SELECT generation_id FROM mc.financial_daily_publications WHERE id=p_publication))
        AND NOT mc.financial_tariff_scope_matches(g.store_id,
          ARRAY(SELECT product_id FROM mc.financial_daily_generation_products WHERE generation_id=g.id AND selected ORDER BY product_id),g.tariff_scope_token))
$$;
REVOKE ALL ON FUNCTION mc.financial_daily_publication_tariff_allowed(uuid) FROM PUBLIC;

-- Keep the established lease, watermark, method and carried-day gates. Tariff
-- scope must be checked before the idempotent existing-publication return.
DO $guard$
DECLARE definition text; anchor text; signature text;
BEGIN
  definition:=replace(pg_get_functiondef('mc.publish_financial_daily_generation(uuid,uuid,text,uuid,bigint)'::regprocedure),E'\r\n',E'\n');
  anchor:=E'  SELECT * INTO existing FROM mc.financial_daily_publications publication';
  IF strpos(definition,anchor)=0 THEN RAISE EXCEPTION 'daily publication tariff insertion point missing'; END IF;
  definition:=replace(definition,anchor,$new$
  IF NOT mc.financial_tariff_scope_matches(generation.store_id,
    ARRAY(SELECT product_id FROM mc.financial_daily_generation_products WHERE generation_id=generation.id AND selected ORDER BY product_id),generation.tariff_scope_token) THEN
    RAISE EXCEPTION 'financial_tariff_scope_stale' USING ERRCODE='23514';
  END IF;
  SELECT * INTO existing FROM mc.financial_daily_publications publication$new$);
  EXECUTE definition;

  definition:=replace(pg_get_functiondef('mc.start_financial_daily_generation(uuid,uuid,text,bigint,text,uuid,uuid)'::regprocedure),E'\r\n',E'\n');
  anchor:='  IF FOUND THEN RETURN generation; END IF;';
  IF strpos(definition,anchor)=0 THEN RAISE EXCEPTION 'daily generation tariff insertion point missing'; END IF;
  definition:=replace(definition,anchor,$new$
  IF FOUND THEN
    IF generation.tariff_scope_token IS DISTINCT FROM (SELECT scope_token FROM mc.effective_tariff_context()) THEN
      RAISE EXCEPTION 'financial_tariff_scope_stale' USING ERRCODE='23514';
    END IF;
    RETURN generation;
  END IF;$new$);
  EXECUTE definition;

  FOREACH signature IN ARRAY ARRAY[
    'mc.start_financial_daily_generation(uuid,uuid,text,bigint,text,uuid,uuid)',
    'mc.finalize_financial_daily_generation(uuid,uuid,text,uuid,bigint,text,text,text)',
    'mc.publish_financial_daily_generation(uuid,uuid,text,uuid,bigint)'
  ] LOOP
    definition:=replace(pg_get_functiondef(signature::regprocedure),E'\r\n',E'\n');
    anchor:='  SELECT * INTO context FROM mc.establish_financial_daily_context(p_job_id,p_lease_token,p_worker_id);';
    IF strpos(definition,anchor)=0 THEN RAISE EXCEPTION 'daily business lock insertion point missing: %',signature; END IF;
    EXECUTE replace(definition,anchor,anchor||E'\n  PERFORM 1 FROM mc.businesses WHERE id=context.business_id FOR UPDATE;');
  END LOOP;
END $guard$;

CREATE FUNCTION mc.guard_legacy_tariff_publication() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,mc AS $$
DECLARE request_uuid uuid; token text;
BEGIN
  IF TG_OP='UPDATE' OR NOT NEW.is_current THEN RETURN NEW; END IF;
  PERFORM 1 FROM mc.businesses WHERE id=NEW.business_id FOR UPDATE;
  SELECT r.request_id,q.tariff_scope_token INTO request_uuid,token
    FROM mc.calculation_runs r LEFT JOIN mc.calculation_requests q ON q.id=r.request_id WHERE r.id=NEW.run_id;
  IF request_uuid IS NOT NULL AND NOT mc.financial_tariff_scope_matches(NEW.store_id,
    ARRAY(SELECT product_id FROM mc.calculation_request_products WHERE request_id=request_uuid ORDER BY product_id),token) THEN
    RAISE EXCEPTION 'financial_tariff_scope_stale' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION mc.guard_legacy_tariff_publication() FROM PUBLIC;
CREATE TRIGGER legacy_tariff_publication BEFORE INSERT ON mc.publications
  FOR EACH ROW EXECUTE FUNCTION mc.guard_legacy_tariff_publication();

CREATE OR REPLACE FUNCTION mc.financial_publication_selection_changed(p_store uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,mc AS $$
  SELECT EXISTS(SELECT 1 FROM mc.financial_daily_current_publications p
    WHERE p.business_id=mc.context_business_id() AND p.store_id=p_store
      AND NOT mc.financial_daily_publication_tariff_allowed(p.publication_id))
$$;
REVOKE ALL ON FUNCTION mc.financial_publication_selection_changed(uuid) FROM PUBLIC;

-- Match profile transitions: business before store/request locks.
DO $legacy$
DECLARE definition text; anchor text:='  PERFORM 1 FROM mc.stores WHERE id=run_row.store_id FOR UPDATE;';
BEGIN
  definition:=replace(pg_get_functiondef('mc.publish_latest_calculation(uuid)'::regprocedure),E'\r\n',E'\n');
  IF strpos(definition,anchor)=0 THEN RAISE EXCEPTION 'legacy publication lock insertion point missing'; END IF;
  EXECUTE replace(definition,anchor,
    E'  PERFORM 1 FROM mc.businesses WHERE id=run_row.business_id FOR UPDATE;\n'||anchor);
END $legacy$;

-- Filter before LIMIT so inactive targets cannot starve eligible stores.
CREATE OR REPLACE FUNCTION mc.list_operational_sync_candidates(p_limit integer DEFAULT 50)
RETURNS TABLE(user_id uuid,business_id uuid,store_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mc AS $$
DECLARE target record; accepted integer:=0;
  old_business text:=current_setting('app.business_id',true);
  old_user text:=current_setting('app.user_id',true);
BEGIN
  FOR target IN SELECT t.requested_by,t.business_id,t.store_id
    FROM mc.operational_sync_targets t
    WHERE t.status='active' AND t.next_run_at<=clock_timestamp()
    ORDER BY t.next_run_at,t.store_id
  LOOP
    PERFORM set_config('app.business_id',target.business_id::text,true);
    PERFORM set_config('app.user_id',target.requested_by::text,true);
    IF EXISTS(SELECT 1 FROM mc.active_profile_products a
      WHERE a.business_id=target.business_id AND a.store_id=target.store_id) THEN
      user_id:=target.requested_by; business_id:=target.business_id; store_id:=target.store_id;
      RETURN NEXT;
      accepted:=accepted+1;
      EXIT WHEN accepted>=greatest(1,least(coalesce(p_limit,50),100));
    END IF;
  END LOOP;
  PERFORM set_config('app.business_id',coalesce(old_business,''),true);
  PERFORM set_config('app.user_id',coalesce(old_user,''),true);
END $$;
REVOKE ALL ON FUNCTION mc.list_operational_sync_candidates(integer) FROM PUBLIC;

-- Deny an incompatible publication as a whole; never filter its total.
CREATE OR REPLACE VIEW mc.current_daily_results WITH (security_invoker=true) AS
  SELECT l.business_id,l.store_id,p.id AS publication_id,l.product_id,l.accounting_date,
    l.category_code,l.currency,sum(l.amount_signed) AS amount_signed
  FROM mc.publications p JOIN mc.result_lines l ON l.run_id=p.run_id
    JOIN mc.store_entitlements e ON (e.business_id,e.store_id)=(p.business_id,p.store_id)
    JOIN mc.calculation_runs r ON r.id=p.run_id
    JOIN mc.calculation_requests q ON q.id=r.request_id
  WHERE p.is_current AND mc.financial_tariff_scope_matches(p.store_id,
    ARRAY(SELECT product_id FROM mc.calculation_request_products WHERE request_id=q.id ORDER BY product_id),q.tariff_scope_token)
  GROUP BY l.business_id,l.store_id,p.id,l.product_id,l.accounting_date,l.category_code,l.currency;

INSERT INTO mc.schema_migrations(version) VALUES(75);
COMMIT;
