BEGIN;

-- A current publication may map days from several immutable generations.
-- Every mapped generation must freeze the same selection as the live store.
CREATE FUNCTION mc.financial_publication_selection_changed(p_store uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=pg_catalog,mc AS $$
DECLARE business_uuid uuid:=mc.context_business_id(); live_products uuid[];
BEGIN
  live_products:=ARRAY(
    SELECT DISTINCT item.product_id FROM mc.product_selection_items item
    JOIN mc.product_selections selection ON selection.id=item.selection_id
      AND selection.business_id=item.business_id AND selection.store_id=item.store_id
    WHERE item.business_id=business_uuid AND item.store_id=p_store AND selection.status='confirmed'
    ORDER BY item.product_id
  );
  RETURN EXISTS(
    SELECT 1 FROM (
      SELECT DISTINCT day.generation_id
      FROM mc.financial_daily_current_publications current
      JOIN mc.financial_daily_publication_days day ON day.publication_id=current.publication_id
        AND day.business_id=current.business_id AND day.store_id=current.store_id
      WHERE current.business_id=business_uuid AND current.store_id=p_store
    ) mapped
    WHERE ARRAY(
      SELECT DISTINCT product.product_id FROM mc.financial_daily_generation_products product
      WHERE product.business_id=business_uuid AND product.store_id=p_store
        AND product.generation_id=mapped.generation_id AND product.selected
      ORDER BY product.product_id
    ) IS DISTINCT FROM live_products
  );
END $$;
REVOKE ALL ON FUNCTION mc.financial_publication_selection_changed(uuid) FROM PUBLIC;

-- Widen the local dispatch range, preserving the event's original evidence.
DO $migration$
DECLARE definition text;
BEGIN
  definition:=pg_get_functiondef('mc.emit_financial_input_event(uuid,text,text,date,date,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid)'::regprocedure);
  IF strpos(definition,'  -- A pending successor absorbs every newer cause.')=0
    OR strpos(definition,'least(p_affected_from,(payload')=0
    OR strpos(definition,'greatest(p_affected_to,(payload')=0 THEN
    RAISE EXCEPTION 'financial input dispatch definition mismatch';
  END IF;
  definition:=replace(definition,'  -- A pending successor absorbs every newer cause.',
    $new$  IF mc.financial_publication_selection_changed(p_store_id) THEN
    SELECT least(queue_from,min(day.accounting_date)),greatest(queue_to,max(day.accounting_date)) INTO queue_from,queue_to
      FROM mc.financial_daily_current_publications current
      JOIN mc.financial_daily_publication_days day ON day.publication_id=current.publication_id
        AND day.business_id=current.business_id AND day.store_id=current.store_id
     WHERE current.business_id=context_business AND current.store_id=p_store_id;
  END IF;

  -- A pending successor absorbs every newer cause.$new$);
  definition:=replace(definition,'least(p_affected_from,(payload','least(queue_from,(payload');
  definition:=replace(definition,'greatest(p_affected_to,(payload','greatest(queue_to,(payload');
  EXECUTE definition;
END $migration$;

CREATE OR REPLACE FUNCTION mc.emit_financial_selection_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mc AS $$
DECLARE date_from date; date_to date; target record;
BEGIN
  FOR target IN SELECT DISTINCT business_id,store_id,selection_id FROM inserted_items LOOP
    SELECT min(covered.date_from),max(covered.date_to) INTO date_from,date_to FROM (
      SELECT period_start date_from,period_end date_to FROM mc.reports
       WHERE business_id=target.business_id AND store_id=target.store_id AND current_version_id IS NOT NULL
      UNION ALL
      SELECT day.accounting_date,day.accounting_date FROM mc.financial_daily_current_publications current
      JOIN mc.financial_daily_publication_days day ON day.publication_id=current.publication_id
        AND day.business_id=current.business_id AND day.store_id=current.store_id
       WHERE current.business_id=target.business_id AND current.store_id=target.store_id
      UNION ALL
      SELECT week_start,week_end FROM mc.financial_week_coverage coverage
       WHERE business_id=target.business_id AND store_id=target.store_id
         AND mc.financial_empty_week_evidence_valid(coverage.id,coverage.empty_confirmed_by_job_id)
    ) covered;
    IF date_from IS NOT NULL THEN
      PERFORM mc.emit_financial_input_event(target.store_id,
        format('selection-statement:%s:%s',target.selection_id,txid_current()),
        'selection_updated',date_from,date_to,p_source_selection_id=>target.selection_id);
    END IF;
  END LOOP;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION mc.emit_financial_selection_event() FROM PUBLIC;

-- Repair every eligible store through its established actor and tenant context.
-- No source fetching or publication compatibility guard is changed.
DO $repair$
DECLARE target record; selection_uuid uuid; date_from date; date_to date; actor uuid;
  prior_business text:=current_setting('app.business_id',true); prior_user text:=current_setting('app.user_id',true);
BEGIN
  FOR target IN SELECT business_id,store_id,requested_by FROM mc.operational_sync_targets WHERE status='active' ORDER BY business_id,store_id LOOP
    PERFORM set_config('app.business_id',target.business_id::text,true);
    SELECT user_id INTO actor FROM mc.memberships WHERE business_id=target.business_id AND role IN('owner','editor')
      ORDER BY (user_id=target.requested_by) DESC,CASE role WHEN 'owner' THEN 0 ELSE 1 END,created_at,user_id LIMIT 1;
    IF actor IS NULL THEN CONTINUE; END IF;
    PERFORM set_config('app.user_id',actor::text,true);
    IF NOT EXISTS(SELECT 1 FROM mc.stores WHERE business_id=target.business_id AND id=target.store_id AND status='active') THEN CONTINUE; END IF;
    SELECT id INTO selection_uuid FROM mc.product_selections WHERE business_id=target.business_id AND store_id=target.store_id AND status='confirmed';
    IF selection_uuid IS NULL OR NOT mc.financial_publication_selection_changed(target.store_id) THEN CONTINUE; END IF;
    SELECT min(covered.date_from),max(covered.date_to) INTO date_from,date_to FROM (
      SELECT day.accounting_date date_from,day.accounting_date date_to FROM mc.financial_daily_current_publications current
      JOIN mc.financial_daily_publication_days day ON day.publication_id=current.publication_id
       WHERE current.business_id=target.business_id AND current.store_id=target.store_id
      UNION ALL
      SELECT period_start,period_end FROM mc.reports WHERE business_id=target.business_id AND store_id=target.store_id AND current_version_id IS NOT NULL
    ) covered;
    IF date_from IS NOT NULL THEN
      PERFORM mc.emit_financial_input_event(target.store_id,'financial-scope-repair:062:store:'||target.store_id,
        'selection_updated',date_from,date_to,p_source_selection_id=>selection_uuid);
    END IF;
  END LOOP;
  PERFORM set_config('app.business_id',coalesce(prior_business,''),true);
  PERFORM set_config('app.user_id',coalesce(prior_user,''),true);
END $repair$;

INSERT INTO mc.schema_migrations(version) VALUES(62);
COMMIT;
