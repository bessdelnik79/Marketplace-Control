BEGIN;

CREATE TABLE mc.tariff_lifecycle_events (
  event_key text PRIMARY KEY CHECK (length(event_key) BETWEEN 1 AND 200),
  business_id uuid NOT NULL REFERENCES mc.businesses(id),
  event_type text NOT NULL CHECK (event_type IN ('period_confirmed','expired','selection_confirmed')),
  plan_id uuid NOT NULL REFERENCES mc.billing_plans(id),
  profile_id uuid NOT NULL,
  confirmed_at timestamptz NOT NULL,
  period_end timestamptz,
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (business_id,profile_id) REFERENCES mc.tariff_profiles(business_id,id)
);
ALTER TABLE mc.tariff_lifecycle_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE mc.tariff_lifecycle_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mc.tariff_lifecycle_events
  USING (business_id=mc.context_business_id()) WITH CHECK (business_id=mc.context_business_id());
CREATE TRIGGER tariff_event_history BEFORE UPDATE OR DELETE ON mc.tariff_lifecycle_events
  FOR EACH ROW EXECUTE FUNCTION mc.reject_mutation();
REVOKE ALL ON mc.tariff_lifecycle_events FROM PUBLIC;

-- Closed scheduler index, following job_dispatch's trusted-server convention.
-- No tenant payload or membership mutation API is exposed through this index.
CREATE TABLE mc.tariff_expiry_dispatch (
  business_id uuid PRIMARY KEY REFERENCES mc.businesses(id),
  period_end timestamptz NOT NULL
);
CREATE TABLE mc.tariff_expiry_days (moscow_date date PRIMARY KEY,processed_at timestamptz NOT NULL DEFAULT clock_timestamp());
REVOKE ALL ON mc.tariff_expiry_dispatch,mc.tariff_expiry_days FROM PUBLIC;

CREATE FUNCTION mc.effective_tariff_context(p_business uuid DEFAULT mc.context_business_id())
RETURNS TABLE(business_id uuid,plan_version_id uuid,profile_id uuid,profile_revision bigint,
  activation_revision bigint,selection_confirmed boolean,period_end timestamptz,scope_token text)
LANGUAGE sql STABLE SET search_path=pg_catalog,mc AS $$
  WITH moment AS MATERIALIZED (SELECT clock_timestamp() AS at), effective AS (
    SELECT s.business_id,s.period_end,state.revision,
      CASE WHEN plan.code='free' OR (s.status='active' AND (s.period_end IS NULL OR s.period_end>moment.at))
        THEN state.active_profile_id ELSE state.free_profile_id END AS profile_id,
      CASE WHEN plan.code='free' OR (s.status='active' AND (s.period_end IS NULL OR s.period_end>moment.at))
        THEN s.plan_version_id ELSE (SELECT v.id FROM mc.billing_plan_versions v JOIN mc.billing_plans p ON p.id=v.plan_id
          WHERE p.code='free' ORDER BY v.version_no DESC LIMIT 1) END AS plan_version_id,
      CASE WHEN plan.code<>'free' AND (s.status<>'active' OR (s.period_end IS NOT NULL AND s.period_end<=moment.at))
        THEN -state.revision ELSE state.revision END AS activation_revision
    FROM mc.subscriptions s JOIN mc.billing_plan_versions version ON version.id=s.plan_version_id
    JOIN mc.billing_plans plan ON plan.id=version.plan_id JOIN mc.tariff_profile_state state ON state.business_id=s.business_id CROSS JOIN moment
    WHERE s.business_id=p_business AND p_business=mc.context_business_id()
  )
  SELECT e.business_id,e.plan_version_id,p.id,p.revision,e.activation_revision,p.selection_confirmed,
    CASE WHEN plan.code='free' THEN NULL ELSE e.period_end END,
    p.id::text||':'||p.revision::text||':'||e.activation_revision::text
    FROM effective e JOIN mc.tariff_profiles p ON p.business_id=e.business_id AND p.id=e.profile_id
    JOIN mc.billing_plans plan ON plan.id=p.plan_id
$$;
REVOKE ALL ON FUNCTION mc.effective_tariff_context(uuid) FROM PUBLIC;

CREATE VIEW mc.active_profile_stores WITH (security_invoker=true) AS
  SELECT member.business_id,member.profile_id,member.store_id
  FROM mc.tariff_profile_stores member JOIN mc.effective_tariff_context() context
    ON context.business_id=member.business_id AND context.profile_id=member.profile_id
  JOIN mc.stores store ON store.business_id=member.business_id AND store.id=member.store_id
  WHERE store.status<>'archived';
CREATE VIEW mc.active_profile_products WITH (security_invoker=true) AS
  SELECT member.business_id,member.profile_id,member.store_id,member.product_id,historical.selection_id
  FROM mc.tariff_profile_products member JOIN mc.active_profile_stores store
    ON (store.business_id,store.profile_id,store.store_id)=(member.business_id,member.profile_id,member.store_id)
  JOIN mc.product_selection_items historical
    ON (historical.business_id,historical.store_id,historical.product_id)=(member.business_id,member.store_id,member.product_id);
CREATE OR REPLACE VIEW mc.store_entitlements WITH (security_invoker=true) AS
  SELECT st.business_id,st.id AS store_id,context.plan_version_id
  FROM mc.stores st JOIN mc.active_profile_stores member ON (member.business_id,member.store_id)=(st.business_id,st.id)
  JOIN mc.effective_tariff_context() context ON context.business_id=st.business_id WHERE st.status='active';
CREATE OR REPLACE VIEW mc.selected_products WITH (security_invoker=true) AS
  SELECT p.id,p.business_id,p.store_id,p.wb_article,p.seller_article,p.title,p.status,p.created_at,i.selection_id
    FROM mc.products p JOIN mc.active_profile_products i
    ON (i.business_id,i.store_id,i.product_id)=(p.business_id,p.store_id,p.id)
    JOIN mc.store_entitlements e ON (e.business_id,e.store_id)=(p.business_id,p.store_id);
REVOKE ALL ON mc.active_profile_stores,mc.active_profile_products FROM PUBLIC;

CREATE FUNCTION mc.assert_active_profile_store(p_store uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,mc AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM mc.active_profile_stores WHERE business_id=mc.context_business_id() AND store_id=p_store) THEN
    RAISE EXCEPTION 'store is outside the effective tariff profile' USING ERRCODE='42501';
  END IF;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION mc.assert_active_profile_store(uuid) FROM PUBLIC;

-- Queue local recalculation over every saved report/publication date. Old stores
-- also receive invalidation so a prior paid aggregate cannot remain current.
CREATE FUNCTION mc.emit_tariff_scope_events(p_business uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mc AS $$
DECLARE target record; date_from date; date_to date; actor uuid; token text;
  old_user text:=current_setting('app.user_id',true);
BEGIN
  IF p_business IS DISTINCT FROM mc.context_business_id() THEN RAISE EXCEPTION 'business context required' USING ERRCODE='42501'; END IF;
  SELECT user_id INTO actor FROM mc.memberships WHERE business_id=p_business AND role IN ('owner','editor')
    ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END,created_at,user_id LIMIT 1;
  IF actor IS NULL THEN RETURN; END IF;
  PERFORM set_config('app.user_id',actor::text,true);
  SELECT scope_token INTO token FROM mc.effective_tariff_context();
  FOR target IN SELECT s.id AS store_id,selection.id AS selection_id FROM mc.stores s
    JOIN mc.product_selections selection ON selection.business_id=s.business_id AND selection.store_id=s.id
    WHERE s.business_id=p_business AND s.status='active' AND selection.status='confirmed' LOOP
    SELECT min(covered.date_from),max(covered.date_to) INTO date_from,date_to FROM (
      SELECT period_start date_from,period_end date_to FROM mc.reports
        WHERE business_id=p_business AND store_id=target.store_id AND current_version_id IS NOT NULL
      UNION ALL
      SELECT day.accounting_date,day.accounting_date FROM mc.financial_daily_current_publications current
      JOIN mc.financial_daily_publication_days day ON day.publication_id=current.publication_id
        AND day.business_id=current.business_id AND day.store_id=current.store_id
        WHERE current.business_id=p_business AND current.store_id=target.store_id
      UNION ALL
      SELECT week_start,week_end FROM mc.financial_week_coverage coverage
        WHERE business_id=p_business AND store_id=target.store_id
          AND mc.financial_empty_week_evidence_valid(coverage.id,coverage.empty_confirmed_by_job_id)
    ) covered;
    IF date_from IS NOT NULL THEN
      PERFORM mc.emit_financial_input_event(target.store_id,'tariff-scope:'||token||':'||target.store_id,
        'selection_updated',date_from,date_to,p_source_selection_id=>target.selection_id);
    END IF;
  END LOOP;
  PERFORM set_config('app.user_id',coalesce(old_user,''),true);
END $$;
REVOKE ALL ON FUNCTION mc.emit_tariff_scope_events(uuid) FROM PUBLIC;

-- Profile limits replace historical-registry limits, including at downgrade.
CREATE OR REPLACE FUNCTION mc.check_subscription_limits() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE limits mc.billing_plan_versions; profile_uuid uuid; active_uuid uuid;
BEGIN
  PERFORM 1 FROM mc.businesses WHERE id=NEW.business_id FOR UPDATE;
  SELECT * INTO STRICT limits FROM mc.billing_plan_versions WHERE id=NEW.plan_version_id;
  SELECT id INTO profile_uuid FROM mc.tariff_profiles WHERE business_id=NEW.business_id AND plan_id=limits.plan_id;
  SELECT active_profile_id INTO active_uuid FROM mc.tariff_profile_state WHERE business_id=NEW.business_id;
  IF profile_uuid IS NULL OR profile_uuid IS DISTINCT FROM active_uuid OR
    (SELECT count(*) FROM mc.tariff_profile_products member JOIN mc.stores store ON (store.business_id,store.id)=(member.business_id,member.store_id)
      WHERE member.business_id=NEW.business_id AND member.profile_id=profile_uuid AND store.status<>'archived')>limits.product_limit OR
    (SELECT count(*) FROM mc.tariff_profile_stores member JOIN mc.stores store ON (store.business_id,store.id)=(member.business_id,member.store_id)
      WHERE member.business_id=NEW.business_id AND member.profile_id=profile_uuid AND store.status<>'archived')>limits.store_limit THEN
    RAISE EXCEPTION 'saved profile exceeds target tariff limits' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION mc.check_store_limit() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE context record; max_stores integer;
BEGIN
  PERFORM 1 FROM mc.businesses WHERE id=NEW.business_id FOR UPDATE;
  IF TG_OP='UPDATE' AND OLD.status=NEW.status THEN RETURN NEW; END IF;
  IF NEW.status<>'archived' THEN
    SELECT * INTO STRICT context FROM mc.effective_tariff_context(NEW.business_id);
    SELECT store_limit INTO STRICT max_stores FROM mc.billing_plan_versions WHERE id=context.plan_version_id;
    IF context.selection_confirmed AND EXISTS(SELECT 1 FROM mc.billing_plan_versions v JOIN mc.billing_plans p ON p.id=v.plan_id
      WHERE v.id=context.plan_version_id AND p.code='free') AND NOT EXISTS(SELECT 1 FROM mc.tariff_profile_stores
        WHERE business_id=NEW.business_id AND profile_id=context.profile_id AND store_id=NEW.id) THEN
      RAISE EXCEPTION 'initial free store profile is frozen' USING ERRCODE='23514';
    END IF;
    IF (SELECT count(*) FROM mc.active_profile_stores WHERE business_id=NEW.business_id AND store_id<>NEW.id)>=max_stores THEN
      RAISE EXCEPTION 'store limit exceeded' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION mc.attach_tariff_store() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,mc AS $$
DECLARE context record; inserted integer;
BEGIN
  IF TG_OP='UPDATE' AND OLD.status=NEW.status THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' THEN
    UPDATE mc.tariff_profiles p SET revision=revision+1 WHERE p.business_id=NEW.business_id AND EXISTS(
      SELECT 1 FROM mc.tariff_profile_stores member WHERE member.business_id=p.business_id AND member.profile_id=p.id AND member.store_id=NEW.id);
    UPDATE mc.tariff_profile_state SET revision=revision+1 WHERE business_id=NEW.business_id;
  END IF;
  IF NEW.status='archived' THEN
    PERFORM mc.emit_tariff_scope_events(NEW.business_id);
    RETURN NEW;
  END IF;
  SELECT * INTO STRICT context FROM mc.effective_tariff_context(NEW.business_id);
  INSERT INTO mc.tariff_profile_stores(business_id,profile_id,store_id)
    VALUES(NEW.business_id,context.profile_id,NEW.id) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS inserted=ROW_COUNT;
  IF inserted>0 THEN
    UPDATE mc.tariff_profiles SET revision=revision+1 WHERE business_id=NEW.business_id AND id=context.profile_id;
    UPDATE mc.tariff_profile_state SET revision=revision+1 WHERE business_id=NEW.business_id;
  END IF;
  PERFORM mc.emit_tariff_scope_events(NEW.business_id);
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION mc.attach_tariff_store() FROM PUBLIC;
CREATE TRIGGER tariff_store_membership AFTER INSERT OR UPDATE OF status ON mc.stores
  FOR EACH ROW EXECUTE FUNCTION mc.attach_tariff_store();

CREATE OR REPLACE FUNCTION mc.guard_selection() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE context record; max_products integer;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF OLD.status<>'draft' OR NEW.status<>'confirmed' OR (to_jsonb(OLD)-'status') IS DISTINCT FROM (to_jsonb(NEW)-'status') THEN
      RAISE EXCEPTION 'confirmed historical selection cannot be changed' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  PERFORM 1 FROM mc.businesses WHERE id=NEW.business_id FOR UPDATE;
  SELECT * INTO STRICT context FROM mc.effective_tariff_context(NEW.business_id);
  SELECT product_limit INTO STRICT max_products FROM mc.billing_plan_versions WHERE id=context.plan_version_id;
  IF NEW.plan_version_id<>context.plan_version_id OR NEW.product_limit_snapshot<>max_products OR NEW.status<>'draft' THEN
    RAISE EXCEPTION 'historical selection must start with effective tariff' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM mc.stores WHERE business_id=NEW.business_id AND id=NEW.store_id AND status='active') OR
    NOT EXISTS(SELECT 1 FROM mc.source_documents WHERE business_id=NEW.business_id AND store_id=NEW.store_id AND id=NEW.catalog_document_id
      AND document_type='catalog' AND origin='wb_api' AND completeness='complete') THEN
    RAISE EXCEPTION 'active store and complete WB catalog required' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION mc.guard_selection_item() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(current_setting('app.tariff_selection_mutation',true),'')<>'on' OR
    NEW.business_id IS DISTINCT FROM mc.context_business_id() OR
    NOT EXISTS(SELECT 1 FROM mc.memberships WHERE business_id=NEW.business_id AND user_id=mc.context_user_id() AND role IN ('owner','editor')) OR
    NOT EXISTS(SELECT 1 FROM mc.product_selections WHERE business_id=NEW.business_id AND store_id=NEW.store_id AND id=NEW.selection_id AND status IN ('draft','confirmed')) OR
    NOT EXISTS(SELECT 1 FROM mc.products WHERE business_id=NEW.business_id AND store_id=NEW.store_id AND id=NEW.product_id AND status='active') THEN
    RAISE EXCEPTION 'profile selection API and active historical product required' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION mc.choose_tariff_profile_products(p_store uuid,p_catalog uuid,p_products uuid[],p_mode text DEFAULT 'replace')
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mc AS $$
DECLARE b uuid:=mc.context_business_id(); u uuid:=mc.context_user_id(); context record; limits mc.billing_plan_versions;
  plan_code text; selection_uuid uuid; desired uuid[]; previous uuid[]; store_count integer;
  old_mutation text:=current_setting('app.tariff_selection_mutation',true);
BEGIN
  IF b IS NULL OR u IS NULL OR NOT EXISTS(SELECT 1 FROM mc.memberships WHERE business_id=b AND user_id=u AND role IN ('owner','editor')) THEN
    RAISE EXCEPTION 'authenticated business editor required' USING ERRCODE='42501';
  END IF;
  PERFORM 1 FROM mc.businesses WHERE id=b FOR UPDATE;
  SELECT * INTO STRICT context FROM mc.effective_tariff_context();
  SELECT * INTO STRICT limits FROM mc.billing_plan_versions WHERE id=context.plan_version_id;
  SELECT code INTO STRICT plan_code FROM mc.billing_plans WHERE id=limits.plan_id;
  IF p_mode NOT IN ('replace','add') OR p_products IS NULL OR cardinality(p_products)=0 OR array_position(p_products,NULL) IS NOT NULL OR
    cardinality(p_products)<>(SELECT count(DISTINCT x) FROM unnest(p_products) x) THEN
    RAISE EXCEPTION 'nonempty distinct products and replace/add mode required' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM mc.stores WHERE business_id=b AND id=p_store AND status='active') THEN
    RAISE EXCEPTION 'active store from current business required' USING ERRCODE='42501';
  END IF;
  SELECT ARRAY(SELECT product_id FROM mc.tariff_profile_products WHERE business_id=b AND profile_id=context.profile_id AND store_id=p_store ORDER BY product_id) INTO previous;
  desired:=ARRAY(SELECT DISTINCT x FROM unnest(CASE WHEN p_mode='add' THEN previous||p_products ELSE p_products END) x ORDER BY x);
  SELECT id INTO selection_uuid FROM mc.product_selections WHERE business_id=b AND store_id=p_store;
  IF context.selection_confirmed AND plan_code='free' THEN
    IF previous=desired THEN RETURN selection_uuid; END IF;
    RAISE EXCEPTION 'initial free selection is frozen' USING ERRCODE='23514';
  END IF;
  IF (SELECT count(*) FROM mc.products WHERE business_id=b AND store_id=p_store AND id=ANY(desired) AND status='active')<>cardinality(desired) THEN
    RAISE EXCEPTION 'active products from selected store required' USING ERRCODE='23514';
  END IF;
  IF (SELECT count(*) FROM mc.active_profile_products WHERE business_id=b AND store_id<>p_store)+cardinality(desired)>limits.product_limit THEN
    RAISE EXCEPTION 'product limit exceeded' USING ERRCODE='23514';
  END IF;
  SELECT count(*) INTO store_count FROM mc.active_profile_stores WHERE business_id=b AND store_id<>p_store;
  IF store_count>=limits.store_limit THEN RAISE EXCEPTION 'store limit exceeded' USING ERRCODE='23514'; END IF;
  IF p_catalog IS NOT NULL AND NOT EXISTS(SELECT 1 FROM mc.source_documents WHERE business_id=b AND store_id=p_store AND id=p_catalog
    AND document_type='catalog' AND origin='wb_api' AND completeness='complete') THEN
    RAISE EXCEPTION 'complete WB catalog required' USING ERRCODE='23514';
  END IF;
  IF selection_uuid IS NULL THEN
    IF p_catalog IS NULL THEN RAISE EXCEPTION 'catalog required for first historical selection' USING ERRCODE='23514'; END IF;
    INSERT INTO mc.product_selections(business_id,store_id,plan_version_id,catalog_document_id,confirmed_by,product_limit_snapshot)
      VALUES(b,p_store,context.plan_version_id,p_catalog,u,limits.product_limit) RETURNING id INTO selection_uuid;
  END IF;
  PERFORM set_config('app.tariff_selection_mutation','on',true);
  INSERT INTO mc.product_selection_items(business_id,store_id,selection_id,product_id)
    SELECT b,p_store,selection_uuid,x FROM unnest(desired) x
    WHERE NOT EXISTS(SELECT 1 FROM mc.product_selection_items WHERE business_id=b AND store_id=p_store AND product_id=x);
  UPDATE mc.product_selections SET status='confirmed' WHERE business_id=b AND id=selection_uuid AND status='draft';
  PERFORM set_config('app.tariff_selection_mutation',coalesce(old_mutation,''),true);
  IF previous=desired AND context.selection_confirmed THEN RETURN selection_uuid; END IF;
  INSERT INTO mc.tariff_profile_stores(business_id,profile_id,store_id) VALUES(b,context.profile_id,p_store) ON CONFLICT DO NOTHING;
  DELETE FROM mc.tariff_profile_products WHERE business_id=b AND profile_id=context.profile_id AND store_id=p_store;
  INSERT INTO mc.tariff_profile_products(business_id,profile_id,store_id,product_id) SELECT b,context.profile_id,p_store,x FROM unnest(desired) x;
  UPDATE mc.tariff_profiles SET revision=revision+1,selection_confirmed=true WHERE business_id=b AND id=context.profile_id;
  UPDATE mc.tariff_profile_state SET revision=revision+1 WHERE business_id=b;
  INSERT INTO mc.tariff_lifecycle_events(event_key,business_id,event_type,plan_id,profile_id,confirmed_at,details)
    VALUES('selection:'||gen_random_uuid(),b,'selection_confirmed',limits.plan_id,context.profile_id,clock_timestamp(),
      jsonb_build_object('storeId',p_store,'productIds',desired,'mode',p_mode,'actorUserId',u));
  PERFORM mc.emit_tariff_scope_events(b);
  RETURN selection_uuid;
END $$;
REVOKE ALL ON FUNCTION mc.choose_tariff_profile_products(uuid,uuid,uuid[],text) FROM PUBLIC;
CREATE OR REPLACE FUNCTION mc.confirm_product_selection(p_store_id uuid,p_catalog_document_id uuid,p_products uuid[])
RETURNS uuid LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,mc AS $$
  SELECT mc.choose_tariff_profile_products(p_store_id,p_catalog_document_id,p_products,'replace')
$$;

-- Historical enrichment can extend a confirmed paid profile only. Free
-- evidence enrichment never invents additional members of its frozen subset.
DO $historical$
DECLARE definition text; updated text;
BEGIN
  definition:=replace(pg_get_functiondef('mc.recover_historical_catalog(uuid,uuid)'::regprocedure),E'\r\n',E'\n');
  updated:=replace(definition,
    '  SELECT v.product_limit INTO max_products FROM mc.subscriptions s JOIN mc.billing_plan_versions v ON v.id=s.plan_version_id'||E'\n'||
    '    WHERE s.business_id=b AND s.status=''active'' AND (s.period_end IS NULL OR s.period_end>now());',
    '  SELECT v.product_limit INTO max_products FROM mc.effective_tariff_context() context JOIN mc.billing_plan_versions v ON v.id=context.plan_version_id'||E'\n'||
    '    WHERE context.selection_confirmed AND EXISTS(SELECT 1 FROM mc.active_profile_stores WHERE business_id=b AND store_id=p_store);');
  updated:=replace(updated,'remaining:=greatest(0,max_products-(SELECT count(*) FROM mc.product_selection_items WHERE business_id=b));',
    'remaining:=greatest(0,max_products-(SELECT count(*) FROM mc.active_profile_products WHERE business_id=b));'||E'\n'||
    '  IF EXISTS(SELECT 1 FROM mc.effective_tariff_context() context JOIN mc.billing_plan_versions v ON v.id=context.plan_version_id'||E'\n'||
    '    JOIN mc.billing_plans p ON p.id=v.plan_id WHERE p.code=''free'') THEN remaining:=0; END IF;');
  updated:=replace(updated,'SELECT 1 FROM mc.product_selection_items WHERE business_id=b AND store_id=p_store AND product_id=product_uuid',
    'SELECT 1 FROM mc.active_profile_products WHERE business_id=b AND store_id=p_store AND product_id=product_uuid');
  IF updated=definition OR strpos(updated,'FROM mc.subscriptions s JOIN mc.billing_plan_versions v')>0 THEN
    RAISE EXCEPTION 'historical catalog tariff contract mismatch';
  END IF;
  EXECUTE updated;
END $historical$;
CREATE OR REPLACE FUNCTION mc.add_products_to_selection(p_store_id uuid,p_products uuid[])
RETURNS uuid LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,mc AS $$
  SELECT mc.choose_tariff_profile_products(p_store_id,NULL,p_products,'add')
$$;

-- Historic inserts are part of one profile transaction: emit once after its
-- final revision, not once for the accumulated historical product registry.
DO $$ DECLARE definition text; BEGIN
  definition:=replace(pg_get_functiondef('mc.emit_financial_selection_event()'::regprocedure),E'\r\n',E'\n');
  definition:=replace(definition,E'BEGIN\n',E'BEGIN\n  IF coalesce(current_setting(''app.tariff_selection_mutation'',true),'''')=''on'' THEN RETURN NULL; END IF;\n');
  EXECUTE definition;
END $$;

CREATE FUNCTION mc.tariff_calendar_month(p_start timestamptz) RETURNS timestamptz
LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog,mc AS $$
  SELECT ((p_start AT TIME ZONE 'Europe/Moscow')+interval '1 month') AT TIME ZONE 'Europe/Moscow'
$$;
REVOKE ALL ON FUNCTION mc.tariff_calendar_month(timestamptz) FROM PUBLIC;

CREATE FUNCTION mc.record_tariff_expiry_dispatch() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,mc AS $$
BEGIN
  IF NEW.status='active' AND NEW.period_end IS NOT NULL AND EXISTS(SELECT 1 FROM mc.billing_plan_versions v
    JOIN mc.billing_plans p ON p.id=v.plan_id WHERE v.id=NEW.plan_version_id AND p.code<>'free') THEN
    INSERT INTO mc.tariff_expiry_dispatch(business_id,period_end) VALUES(NEW.business_id,NEW.period_end)
      ON CONFLICT(business_id) DO UPDATE SET period_end=excluded.period_end;
  ELSE DELETE FROM mc.tariff_expiry_dispatch WHERE business_id=NEW.business_id;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION mc.record_tariff_expiry_dispatch() FROM PUBLIC;
CREATE TRIGGER tariff_expiry_dispatch AFTER INSERT OR UPDATE ON mc.subscriptions
  FOR EACH ROW EXECUTE FUNCTION mc.record_tariff_expiry_dispatch();

CREATE FUNCTION mc.apply_tariff_period(p_business uuid,p_plan_code text,p_event_key text,p_confirmed_at timestamptz)
RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mc AS $$
DECLARE existing mc.tariff_lifecycle_events; subscription mc.subscriptions; target_version mc.billing_plan_versions;
  current_code text; profile_uuid uuid; desired_start timestamptz; expires timestamptz; free_uuid uuid; previous_context record;
  old_business text:=current_setting('app.business_id',true); old_user text:=current_setting('app.user_id',true);
BEGIN
  IF p_business IS NULL OR p_confirmed_at IS NULL OR NOT isfinite(p_confirmed_at) OR p_confirmed_at>clock_timestamp() OR
    nullif(btrim(p_event_key),'') IS NULL OR length(p_event_key)>200 OR p_plan_code='free' THEN
    RAISE EXCEPTION 'confirmed administrative paid period required' USING ERRCODE='23514';
  END IF;
  PERFORM set_config('app.business_id',p_business::text,true);
  PERFORM 1 FROM mc.businesses WHERE id=p_business FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'business not found' USING ERRCODE='23514'; END IF;
  SELECT v.* INTO STRICT target_version FROM mc.billing_plan_versions v JOIN mc.billing_plans p ON p.id=v.plan_id
    WHERE p.code=p_plan_code AND p.code<>'free' ORDER BY v.version_no DESC LIMIT 1;
  SELECT * INTO existing FROM mc.tariff_lifecycle_events WHERE event_key=p_event_key;
  IF FOUND THEN
    IF existing.business_id<>p_business OR existing.event_type<>'period_confirmed' OR existing.plan_id<>target_version.plan_id OR existing.confirmed_at<>p_confirmed_at THEN
      RAISE EXCEPTION 'confirmation key conflicts with original event' USING ERRCODE='23514';
    END IF;
    PERFORM set_config('app.business_id',coalesce(old_business,''),true);
    RETURN existing.period_end;
  END IF;
  SELECT * INTO STRICT subscription FROM mc.subscriptions WHERE business_id=p_business FOR UPDATE;
  SELECT * INTO STRICT previous_context FROM mc.effective_tariff_context();
  SELECT p.code INTO STRICT current_code FROM mc.billing_plan_versions v JOIN mc.billing_plans p ON p.id=v.plan_id WHERE v.id=subscription.plan_version_id;
  IF current_code<>'free' AND current_code<>p_plan_code AND subscription.status='active' AND
    (subscription.period_end IS NULL OR subscription.period_end>clock_timestamp()) THEN
    RAISE EXCEPTION 'switching between live paid tariffs requires a separate policy' USING ERRCODE='23514';
  END IF;
  desired_start:=CASE WHEN current_code=p_plan_code AND subscription.status='active' AND subscription.period_end>p_confirmed_at
    THEN subscription.period_end ELSE p_confirmed_at END;
  expires:=mc.tariff_calendar_month(desired_start);
  SELECT free_profile_id INTO STRICT free_uuid FROM mc.tariff_profile_state WHERE business_id=p_business FOR UPDATE;
  SELECT id INTO profile_uuid FROM mc.tariff_profiles WHERE business_id=p_business AND plan_id=target_version.plan_id;
  IF profile_uuid IS NULL THEN
    INSERT INTO mc.tariff_profiles(business_id,plan_id) VALUES(p_business,target_version.plan_id) RETURNING id INTO profile_uuid;
    INSERT INTO mc.tariff_profile_stores(business_id,profile_id,store_id)
      SELECT p_business,profile_uuid,member.store_id FROM mc.tariff_profile_stores member
      JOIN mc.stores store ON (store.business_id,store.id)=(member.business_id,member.store_id)
      WHERE member.business_id=p_business AND member.profile_id=free_uuid AND store.status<>'archived';
  END IF;
  IF previous_context.profile_id<>profile_uuid OR previous_context.activation_revision<0 THEN
    UPDATE mc.tariff_profile_state SET active_profile_id=profile_uuid,revision=revision+1 WHERE business_id=p_business;
  END IF;
  UPDATE mc.subscriptions SET plan_version_id=target_version.id,status='active',period_start=desired_start,period_end=expires,cancel_at_period_end=false
    WHERE business_id=p_business;
  INSERT INTO mc.tariff_lifecycle_events(event_key,business_id,event_type,plan_id,profile_id,confirmed_at,period_end,details)
    VALUES(p_event_key,p_business,'period_confirmed',target_version.plan_id,profile_uuid,p_confirmed_at,expires,
      jsonb_build_object('source','administrative','periodStart',desired_start));
  IF previous_context.profile_id<>profile_uuid OR previous_context.activation_revision<0 THEN
    PERFORM mc.emit_tariff_scope_events(p_business);
  END IF;
  PERFORM set_config('app.business_id',coalesce(old_business,''),true);
  PERFORM set_config('app.user_id',coalesce(old_user,''),true);
  RETURN expires;
END $$;
REVOKE ALL ON FUNCTION mc.apply_tariff_period(uuid,text,text,timestamptz) FROM PUBLIC;

CREATE FUNCTION mc.expire_tariff_subscription(p_business uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mc AS $$
DECLARE subscription mc.subscriptions; plan_code text; state mc.tariff_profile_state; free_version uuid; free_plan uuid;
  old_business text:=current_setting('app.business_id',true); old_user text:=current_setting('app.user_id',true);
BEGIN
  PERFORM set_config('app.business_id',p_business::text,true);
  PERFORM 1 FROM mc.businesses WHERE id=p_business FOR UPDATE;
  SELECT * INTO subscription FROM mc.subscriptions WHERE business_id=p_business FOR UPDATE;
  SELECT p.code INTO plan_code FROM mc.billing_plan_versions v JOIN mc.billing_plans p ON p.id=v.plan_id WHERE v.id=subscription.plan_version_id;
  IF plan_code IS NULL OR plan_code='free' OR subscription.period_end IS NULL OR subscription.period_end>clock_timestamp() THEN
    PERFORM set_config('app.business_id',coalesce(old_business,''),true);
    RETURN false;
  END IF;
  SELECT * INTO STRICT state FROM mc.tariff_profile_state WHERE business_id=p_business FOR UPDATE;
  SELECT v.id,p.id INTO STRICT free_version,free_plan FROM mc.billing_plan_versions v JOIN mc.billing_plans p ON p.id=v.plan_id
    WHERE p.code='free' ORDER BY v.version_no DESC LIMIT 1;
  UPDATE mc.tariff_profile_state SET active_profile_id=free_profile_id,revision=revision+1 WHERE business_id=p_business;
  UPDATE mc.subscriptions SET plan_version_id=free_version,status='active',period_start=clock_timestamp(),period_end=NULL,cancel_at_period_end=false
    WHERE business_id=p_business;
  INSERT INTO mc.tariff_lifecycle_events(event_key,business_id,event_type,plan_id,profile_id,confirmed_at,details)
    VALUES('expired:'||subscription.id||':'||state.revision,p_business,'expired',free_plan,state.free_profile_id,clock_timestamp(),
      jsonb_build_object('previousPeriodEnd',subscription.period_end));
  PERFORM mc.emit_tariff_scope_events(p_business);
  PERFORM set_config('app.business_id',coalesce(old_business,''),true);
  PERFORM set_config('app.user_id',coalesce(old_user,''),true);
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION mc.expire_tariff_subscription(uuid) FROM PUBLIC;

CREATE FUNCTION mc.expire_due_tariff_subscriptions() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mc AS $$
DECLARE business_uuid uuid; processed integer:=0; inserted integer;
  old_business text:=current_setting('app.business_id',true); old_user text:=current_setting('app.user_id',true);
BEGIN
  INSERT INTO mc.tariff_expiry_days(moscow_date) VALUES((clock_timestamp() AT TIME ZONE 'Europe/Moscow')::date) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS inserted=ROW_COUNT;
  IF inserted=0 THEN RETURN 0; END IF;
  FOR business_uuid IN SELECT business_id FROM mc.tariff_expiry_dispatch WHERE period_end<=clock_timestamp() ORDER BY business_id LOOP
    IF mc.expire_tariff_subscription(business_uuid) THEN processed:=processed+1; END IF;
  END LOOP;
  PERFORM set_config('app.business_id',coalesce(old_business,''),true);
  PERFORM set_config('app.user_id',coalesce(old_user,''),true);
  RETURN processed;
END $$;
REVOKE ALL ON FUNCTION mc.expire_due_tariff_subscriptions() FROM PUBLIC;

-- Reconcile the foundation snapshot just before switching consumers. Free
-- stores are preserved, but their unknown initial products remain unconfirmed.
ALTER TABLE mc.businesses NO FORCE ROW LEVEL SECURITY;
DO $cutover$
DECLARE b uuid; current_plan uuid; free_plan uuid; profile_uuid uuid; free_uuid uuid; target_version uuid;
  old_business text:=current_setting('app.business_id',true);
BEGIN
  SELECT id INTO STRICT free_plan FROM mc.billing_plans WHERE code='free';
  FOR b IN SELECT id FROM mc.businesses ORDER BY id LOOP
    PERFORM set_config('app.business_id',b::text,true);
    SELECT v.plan_id,s.plan_version_id INTO STRICT current_plan,target_version FROM mc.subscriptions s
      JOIN mc.billing_plan_versions v ON v.id=s.plan_version_id WHERE s.business_id=b;
    SELECT free_profile_id INTO STRICT free_uuid FROM mc.tariff_profile_state WHERE business_id=b;
    INSERT INTO mc.tariff_profiles(business_id,plan_id) VALUES(b,current_plan) ON CONFLICT(business_id,plan_id) DO NOTHING;
    SELECT id INTO STRICT profile_uuid FROM mc.tariff_profiles WHERE business_id=b AND plan_id=current_plan;
    DELETE FROM mc.tariff_profile_products WHERE business_id=b AND profile_id=profile_uuid;
    DELETE FROM mc.tariff_profile_stores WHERE business_id=b AND profile_id=profile_uuid;
    INSERT INTO mc.tariff_profile_stores(business_id,profile_id,store_id)
      SELECT b,profile_uuid,id FROM mc.stores WHERE business_id=b AND status<>'archived';
    IF current_plan<>free_plan THEN
      INSERT INTO mc.tariff_profile_products(business_id,profile_id,store_id,product_id)
        SELECT b,profile_uuid,i.store_id,i.product_id FROM mc.product_selection_items i
        JOIN mc.product_selections selection ON (selection.business_id,selection.store_id,selection.id)=(i.business_id,i.store_id,i.selection_id)
        JOIN mc.stores store ON (store.business_id,store.id)=(i.business_id,i.store_id)
        WHERE i.business_id=b AND selection.status='confirmed' AND store.status<>'archived';
      UPDATE mc.tariff_profiles SET selection_confirmed=EXISTS(SELECT 1 FROM mc.tariff_profile_products WHERE business_id=b AND profile_id=profile_uuid)
        WHERE business_id=b AND id=profile_uuid;
    END IF;
    UPDATE mc.tariff_profiles SET revision=revision+1 WHERE business_id=b AND id=profile_uuid;
    UPDATE mc.tariff_profile_state SET active_profile_id=profile_uuid,revision=revision+1 WHERE business_id=b;
    INSERT INTO mc.tariff_expiry_dispatch(business_id,period_end)
      SELECT business_id,period_end FROM mc.subscriptions WHERE business_id=b AND current_plan<>free_plan AND status='active' AND period_end IS NOT NULL;
  END LOOP;
  PERFORM set_config('app.business_id',coalesce(old_business,''),true);
END $cutover$;
ALTER TABLE mc.businesses FORCE ROW LEVEL SECURITY;

INSERT INTO mc.schema_migrations(version) VALUES(74);
COMMIT;
