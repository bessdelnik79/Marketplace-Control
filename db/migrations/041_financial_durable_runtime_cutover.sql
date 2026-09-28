BEGIN;

CREATE FUNCTION mc.request_financial_inventory_refresh(
  p_store_id uuid,
  p_now timestamptz DEFAULT clock_timestamp()
)
RETURNS mc.jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mc AS $$
#variable_conflict use_column
DECLARE
  context_business uuid:=mc.context_business_id();
  context_user uuid:=mc.context_user_id();
  target mc.connections;
  boundary date:=(p_now AT TIME ZONE 'Europe/Moscow')::date;
  window_start date;
  window_end date;
  queued mc.jobs;
BEGIN
  IF context_business IS NULL OR context_user IS NULL OR NOT EXISTS(
    SELECT 1 FROM mc.memberships membership
     WHERE membership.business_id=context_business AND membership.user_id=context_user
       AND membership.role IN ('owner','editor')
  ) THEN RAISE EXCEPTION 'owned business context is required'; END IF;

  SELECT connection.* INTO target
    FROM mc.connections connection
    JOIN mc.stores store ON store.business_id=connection.business_id AND store.id=connection.store_id
   WHERE connection.business_id=context_business AND connection.store_id=p_store_id
     AND connection.status='active' AND connection.scopes ? 'finance'
     AND store.status='active' AND store.marketplace_code='wb'
   FOR UPDATE OF connection;
  IF NOT FOUND OR target.credential_generation<1 THEN
    RAISE EXCEPTION 'active financial credential is required';
  END IF;

  boundary:=boundary-(extract(isodow from boundary)::integer-1);
  window_start:=boundary-35;
  window_end:=boundary-1;

  INSERT INTO mc.financial_week_coverage(
    business_id,store_id,credential_generation,week_start,week_end,check_reasons,freshness_due_at
  )
  SELECT context_business,p_store_id,target.credential_generation,week_start::date,
         (week_start+interval '6 days')::date,ARRAY['manual_refresh'],p_now
    FROM generate_series(window_start,window_end,interval '7 days') week_start
  ON CONFLICT(business_id,store_id,credential_generation,week_start) DO UPDATE
    SET check_reasons=(SELECT array_agg(DISTINCT reason ORDER BY reason)
                         FROM unnest(mc.financial_week_coverage.check_reasons||excluded.check_reasons) reason),
        freshness_due_at=least(mc.financial_week_coverage.freshness_due_at,excluded.freshness_due_at),
        coverage_status=CASE WHEN mc.financial_week_coverage.coverage_status='unavailable'
          THEN 'unavailable' ELSE 'pending' END,
        updated_at=clock_timestamp();

  SELECT * INTO queued FROM mc.enqueue_job(
    p_store_id,'financial_inventory_refresh',
    format('financial-inventory:%s:g%s:manual:%s',p_store_id,target.credential_generation,boundary),
    jsonb_build_object(
      'schemaVersion',1,'credentialGeneration',target.credential_generation,'reason','manual_refresh',
      'scheduleBoundary',boundary,
      'window',jsonb_build_object('dateFrom',window_start,'dateTo',window_end),
      'timezone','Europe/Moscow'
    ),p_now,600,20
  );
  RETURN queued;
END $$;

REVOKE ALL ON FUNCTION mc.request_financial_inventory_refresh(uuid,timestamptz) FROM PUBLIC;

INSERT INTO mc.schema_migrations(version) VALUES(41);
COMMIT;
