BEGIN;

CREATE FUNCTION mc.inherit_tariff_profile_selection(p_business uuid,p_source uuid,p_target uuid,p_version uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,mc AS $$
DECLARE limits mc.billing_plan_versions; confirmed boolean;
BEGIN
 IF p_business IS DISTINCT FROM mc.context_business_id() OR p_source=p_target THEN
  RAISE EXCEPTION 'distinct tariff profiles in business context required' USING ERRCODE='42501';
 END IF;
 SELECT * INTO STRICT limits FROM mc.billing_plan_versions WHERE id=p_version;
 SELECT selection_confirmed INTO STRICT confirmed FROM mc.tariff_profiles WHERE business_id=p_business AND id=p_source;
 IF NOT EXISTS(SELECT 1 FROM mc.tariff_profiles WHERE business_id=p_business AND id=p_target
  AND plan_id=limits.plan_id AND NOT selection_confirmed)
  OR EXISTS(SELECT 1 FROM mc.tariff_profile_products WHERE business_id=p_business AND profile_id=p_target) THEN
  RAISE EXCEPTION 'new unconfirmed tariff profile required' USING ERRCODE='23514';
 END IF;
 IF (SELECT count(*) FROM mc.tariff_profile_stores member JOIN mc.stores store
  ON (store.business_id,store.id)=(member.business_id,member.store_id)
  WHERE member.business_id=p_business AND member.profile_id=p_source AND store.status<>'archived')>limits.store_limit
  OR (SELECT count(*) FROM mc.tariff_profile_products member JOIN mc.stores store
  ON (store.business_id,store.id)=(member.business_id,member.store_id)
  WHERE member.business_id=p_business AND member.profile_id=p_source AND store.status<>'archived')>limits.product_limit THEN
  RAISE EXCEPTION 'current selection exceeds target tariff limits' USING ERRCODE='23514';
 END IF;
 INSERT INTO mc.tariff_profile_stores(business_id,profile_id,store_id)
  SELECT p_business,p_target,member.store_id FROM mc.tariff_profile_stores member JOIN mc.stores store
  ON (store.business_id,store.id)=(member.business_id,member.store_id)
  WHERE member.business_id=p_business AND member.profile_id=p_source AND store.status<>'archived'
  ON CONFLICT DO NOTHING;
 INSERT INTO mc.tariff_profile_products(business_id,profile_id,store_id,product_id)
  SELECT p_business,p_target,member.store_id,member.product_id FROM mc.tariff_profile_products member JOIN mc.stores store
  ON (store.business_id,store.id)=(member.business_id,member.store_id)
  WHERE member.business_id=p_business AND member.profile_id=p_source AND store.status<>'archived';
 UPDATE mc.tariff_profiles SET selection_confirmed=confirmed,revision=revision+1
  WHERE business_id=p_business AND id=p_target;
 RETURN confirmed;
END $$;
REVOKE ALL ON FUNCTION mc.inherit_tariff_profile_selection(uuid,uuid,uuid,uuid) FROM PUBLIC;

-- Preserve the existing trusted period confirmation, locking, idempotency,
-- renewal and live-paid transition policy; change only new-profile initialization.
DO $$
DECLARE definition text; updated text; old_block text;
BEGIN
 definition:=replace(pg_get_functiondef('mc.apply_tariff_period(uuid,text,text,timestamptz)'::regprocedure),E'\r\n',E'\n');
 updated:=replace(definition,'  current_code text; profile_uuid uuid;',
  '  selection_inherited boolean:=false; selection_source uuid; current_code text; profile_uuid uuid;');
 old_block:=$block$    INSERT INTO mc.tariff_profile_stores(business_id,profile_id,store_id)
      SELECT p_business,profile_uuid,member.store_id FROM mc.tariff_profile_stores member
      JOIN mc.stores store ON (store.business_id,store.id)=(member.business_id,member.store_id)
      WHERE member.business_id=p_business AND member.profile_id=free_uuid AND store.status<>'archived';$block$;
 IF strpos(updated,old_block)=0 THEN RAISE EXCEPTION 'tariff new-profile initializer contract missing'; END IF;
 updated:=replace(updated,old_block,
  '    selection_source:=previous_context.profile_id;'||E'\n'||
  '    selection_inherited:=mc.inherit_tariff_profile_selection(p_business,selection_source,profile_uuid,target_version.id);');
 old_block:=$block$jsonb_build_object('source','administrative','periodStart',desired_start)$block$;
 IF strpos(updated,old_block)=0 OR strpos(updated,'selection_inherited boolean')=0 THEN
  RAISE EXCEPTION 'tariff period metadata contract missing';
 END IF;
 updated:=replace(updated,old_block,
  $block$jsonb_build_object('source','administrative','periodStart',desired_start,
        'selectionInherited',selection_inherited,'selectionSourceProfileId',selection_source)$block$);
 EXECUTE updated;
END $$;

-- Repair only untouched first paid activations created by the old initializer.
-- A prior immutable free confirmation establishes the authoritative source;
-- edited, renewed, expired or already populated paid profiles are never inferred.
ALTER TABLE mc.businesses NO FORCE ROW LEVEL SECURITY;
DO $$
DECLARE b uuid; candidate record; actor uuid; inherited boolean;
 old_business text:=current_setting('app.business_id',true); old_user text:=current_setting('app.user_id',true);
BEGIN
 FOR b IN SELECT id FROM mc.businesses ORDER BY id LOOP
  PERFORM set_config('app.business_id',b::text,true);
  PERFORM set_config('app.user_id','',true);
  PERFORM 1 FROM mc.businesses WHERE id=b FOR UPDATE;
  SELECT state.active_profile_id,state.free_profile_id,s.plan_version_id,p.plan_id
   INTO candidate FROM mc.tariff_profile_state state JOIN mc.subscriptions s ON s.business_id=state.business_id
   JOIN mc.tariff_profiles p ON p.business_id=state.business_id AND p.id=state.active_profile_id
   JOIN mc.tariff_profiles f ON f.business_id=state.business_id AND f.id=state.free_profile_id
   JOIN mc.billing_plan_versions v ON v.id=s.plan_version_id
   JOIN mc.billing_plans plan ON plan.id=v.plan_id
   WHERE state.business_id=b AND plan.code<>'free' AND s.status='active'
    AND s.period_end>clock_timestamp() AND p.plan_id=v.plan_id AND p.revision=1
    AND NOT p.selection_confirmed AND f.selection_confirmed
    AND NOT EXISTS(SELECT 1 FROM mc.tariff_profile_products WHERE business_id=b AND profile_id=p.id)
    AND NOT EXISTS(SELECT 1 FROM mc.tariff_lifecycle_events WHERE business_id=b AND profile_id=p.id AND event_type='selection_confirmed')
    AND (SELECT count(*) FROM mc.tariff_lifecycle_events WHERE business_id=b AND profile_id=p.id AND event_type='period_confirmed')=1
    AND EXISTS(SELECT 1 FROM mc.tariff_lifecycle_events paid_event
     JOIN mc.tariff_lifecycle_events free_event ON free_event.business_id=paid_event.business_id
      AND free_event.profile_id=f.id AND free_event.event_type='selection_confirmed'
      AND free_event.created_at<=paid_event.created_at
     WHERE paid_event.business_id=b AND paid_event.profile_id=p.id AND paid_event.event_type='period_confirmed'
      AND paid_event.details->>'source'='administrative')
    AND NOT EXISTS(SELECT 1 FROM mc.tariff_profile_stores member WHERE member.business_id=b AND member.profile_id=p.id
     AND NOT EXISTS(SELECT 1 FROM mc.tariff_profile_stores original WHERE original.business_id=b
      AND original.profile_id=f.id AND original.store_id=member.store_id))
    AND NOT EXISTS(SELECT 1 FROM mc.tariff_profile_stores original JOIN mc.stores store
     ON (store.business_id,store.id)=(original.business_id,original.store_id)
     WHERE original.business_id=b AND original.profile_id=f.id AND store.status<>'archived'
      AND NOT EXISTS(SELECT 1 FROM mc.tariff_profile_stores member WHERE member.business_id=b
       AND member.profile_id=p.id AND member.store_id=original.store_id));
  IF NOT FOUND THEN CONTINUE; END IF;
  SELECT user_id INTO actor FROM mc.memberships WHERE business_id=b AND role IN ('owner','editor')
   ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END,created_at,user_id LIMIT 1;
  IF actor IS NULL THEN CONTINUE; END IF;
  PERFORM set_config('app.user_id',actor::text,true);
  inherited:=mc.inherit_tariff_profile_selection(b,candidate.free_profile_id,candidate.active_profile_id,candidate.plan_version_id);
  UPDATE mc.tariff_profile_state SET revision=revision+1 WHERE business_id=b;
  INSERT INTO mc.tariff_lifecycle_events(event_key,business_id,event_type,plan_id,profile_id,confirmed_at,details)
   VALUES('upgrade-selection-recovery:'||candidate.active_profile_id,b,'selection_confirmed',candidate.plan_id,
    candidate.active_profile_id,clock_timestamp(),jsonb_build_object('source','upgrade_selection_recovery',
     'selectionInherited',inherited,'selectionSourceProfileId',candidate.free_profile_id));
  PERFORM mc.emit_tariff_scope_events(b);
 END LOOP;
 PERFORM set_config('app.business_id',coalesce(old_business,''),true);
 PERFORM set_config('app.user_id',coalesce(old_user,''),true);
END $$;
ALTER TABLE mc.businesses FORCE ROW LEVEL SECURITY;

INSERT INTO mc.schema_migrations(version) VALUES(80);
COMMIT;
