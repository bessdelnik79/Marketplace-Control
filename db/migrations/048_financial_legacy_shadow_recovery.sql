BEGIN;

-- A matched shadow comparison proves that the v20 result has the same period
-- totals, quality and reasons as the exact legacy publication for the same
-- products. The v20 generation remains authoritative for daily allocation.
-- Requiring the legacy side itself to be v20 made that proof unusable for
-- historical publications produced before v20 and left permanent holes in the
-- first daily pointer.
CREATE OR REPLACE FUNCTION mc.financial_daily_shadow_day_compatible(
  p_generation_id uuid,p_accounting_date date
)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,mc AS $$
  SELECT EXISTS(
    SELECT 1 FROM mc.financial_daily_generations generation
    JOIN mc.method_versions generation_method ON generation_method.id=generation.result_method_version_id
    JOIN mc.financial_daily_shadow_comparisons comparison ON comparison.generation_id=generation.id
    JOIN mc.calculation_runs legacy_run ON legacy_run.id=comparison.legacy_run_id
    JOIN mc.method_versions legacy_method ON legacy_method.id=legacy_run.method_version_id
    WHERE generation.id=p_generation_id
      AND generation_method.code='financial_result' AND generation_method.version_no=20
      AND generation_method.implementation_version='financial-result-v20'
      AND comparison.status='matched' AND p_accounting_date BETWEEN comparison.period_start AND comparison.period_end
      AND legacy_method.code='financial_result' AND legacy_method.version_no BETWEEN 9 AND 20
      AND legacy_method.implementation_version='financial-result-v'||legacy_method.version_no
      AND legacy_run.request_id IS NOT NULL
      AND NOT EXISTS(
        (SELECT product.product_id FROM mc.financial_daily_generation_products product
          WHERE product.generation_id=generation.id AND product.selected)
        EXCEPT
        (SELECT request_product.product_id FROM mc.calculation_request_products request_product
          WHERE request_product.request_id=legacy_run.request_id)
      ) AND NOT EXISTS(
        (SELECT request_product.product_id FROM mc.calculation_request_products request_product
          WHERE request_product.request_id=legacy_run.request_id)
        EXCEPT
        (SELECT product.product_id FROM mc.financial_daily_generation_products product
          WHERE product.generation_id=generation.id AND product.selected)
      )
  ) OR EXISTS(
    SELECT 1
      FROM mc.financial_daily_generations generation
      JOIN mc.method_versions generation_method ON generation_method.id=generation.result_method_version_id
      JOIN mc.financial_daily_days day
        ON day.generation_id=generation.id AND day.accounting_date=p_accounting_date
      JOIN mc.financial_daily_generation_inputs input
        ON input.generation_id=generation.id AND input.source_kind='empty_week'
      JOIN mc.financial_week_coverage coverage
        ON coverage.id=input.financial_week_coverage_id
       AND coverage.business_id=generation.business_id
       AND coverage.store_id=generation.store_id
     WHERE generation.id=p_generation_id
       AND generation_method.code='financial_result' AND generation_method.version_no=20
       AND generation_method.implementation_version='financial-result-v20'
       AND day.coverage_complete AND day.quality IN ('complete','partial')
       AND mc.financial_empty_week_evidence_valid(coverage.id,input.empty_confirmation_job_id)
       AND p_accounting_date BETWEEN coverage.week_start AND coverage.week_end
       AND NOT EXISTS(
         SELECT 1
           FROM mc.financial_daily_generation_inputs report_input
           JOIN mc.report_versions report_version ON report_version.id=report_input.report_version_id
           JOIN mc.reports report ON report.id=report_version.report_id
          WHERE report_input.generation_id=generation.id
            AND report_input.source_kind='report'
            AND p_accounting_date BETWEEN report.period_start AND report.period_end
       )
  )
$$;

-- Publication history is immutable. Recalculate a safe continuous range when
-- the only missing first-pointer days have now become compatible. The normal
-- event worker will append a new publication and atomically move the pointer;
-- no WB request is made.
ALTER TABLE mc.financial_input_events NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.memberships NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.financial_daily_current_publications NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.financial_daily_publications NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.stores NO FORCE ROW LEVEL SECURITY;

DO $$
DECLARE
  target record;
  prior_business text:=current_setting('app.business_id',true);
  prior_user text:=current_setting('app.user_id',true);
  recovery_from date;
  recovery_to date;
  unsafe_range boolean;
BEGIN
  FOR target IN
    SELECT first_publication.business_id,first_publication.store_id,
           first_publication.generation_id,current_publication.publication_id,
           method.id method_version_id,
           (SELECT membership.user_id FROM mc.memberships membership
             WHERE membership.business_id=first_publication.business_id AND membership.role IN ('owner','editor')
             ORDER BY CASE membership.role WHEN 'owner' THEN 0 ELSE 1 END,
                      membership.created_at,membership.user_id LIMIT 1) actor_user_id
      FROM mc.financial_daily_publications first_publication
      JOIN mc.financial_daily_current_publications current_publication
        ON current_publication.business_id=first_publication.business_id
       AND current_publication.store_id=first_publication.store_id
      JOIN mc.stores store
        ON store.business_id=first_publication.business_id
       AND store.id=first_publication.store_id AND store.status='active'
      CROSS JOIN mc.method_versions method
     WHERE first_publication.publication_no=1
       AND method.code='financial_result' AND method.version_no=20
  LOOP
    IF target.actor_user_id IS NULL THEN CONTINUE; END IF;
    PERFORM set_config('app.business_id',target.business_id::text,true);
    PERFORM set_config('app.user_id',target.actor_user_id::text,true);

    SELECT min(source_day.accounting_date),max(source_day.accounting_date)
      INTO recovery_from,recovery_to
      FROM mc.financial_daily_days source_day
     WHERE source_day.generation_id=target.generation_id
       AND mc.financial_daily_shadow_day_compatible(
         target.generation_id,source_day.accounting_date
       )
       AND NOT EXISTS(
         SELECT 1 FROM mc.financial_daily_publication_days mapped
          WHERE mapped.publication_id=target.publication_id
            AND mapped.accounting_date=source_day.accounting_date
       );
    IF recovery_from IS NULL THEN CONTINUE; END IF;

    SELECT EXISTS(
      SELECT 1 FROM generate_series(recovery_from,recovery_to,interval '1 day') missing(day)
       WHERE NOT EXISTS(
         SELECT 1 FROM mc.financial_daily_publication_days mapped
          WHERE mapped.publication_id=target.publication_id
            AND mapped.accounting_date=missing.day::date
       ) AND NOT EXISTS(
         SELECT 1 FROM mc.financial_daily_days source_day
          WHERE source_day.generation_id=target.generation_id
            AND source_day.accounting_date=missing.day::date
            AND mc.financial_daily_shadow_day_compatible(
              target.generation_id,source_day.accounting_date
            )
       )
    ) INTO unsafe_range;
    IF unsafe_range THEN CONTINUE; END IF;

    PERFORM mc.emit_financial_input_event(
      target.store_id,
      'daily-publication-legacy-shadow-recovery:v1:store:'||target.store_id,
      'shadow_backfill',recovery_from,recovery_to,
      p_source_result_method_version_id=>target.method_version_id
    );
  END LOOP;

  -- A store whose original cutover had no compatible v20-only legacy day has
  -- no pointer to repair. Replay its saved cutover range so the first pointer
  -- can now be built from exact matched legacy v9-v20 comparisons.
  FOR target IN
    SELECT event.business_id,event.store_id,min(event.affected_from) affected_from,
           max(event.affected_to) affected_to,method.id method_version_id,
           (SELECT membership.user_id FROM mc.memberships membership
             WHERE membership.business_id=event.business_id AND membership.role IN ('owner','editor')
             ORDER BY CASE membership.role WHEN 'owner' THEN 0 ELSE 1 END,
                      membership.created_at,membership.user_id LIMIT 1) actor_user_id
      FROM mc.financial_input_events event
      JOIN mc.stores store
        ON store.business_id=event.business_id AND store.id=event.store_id
       AND store.status='active'
      CROSS JOIN mc.method_versions method
     WHERE event.event_type='shadow_backfill'
       AND event.event_key LIKE 'daily-publication-cutover:v1:store:%'
       AND method.code='financial_result' AND method.version_no=20
       AND NOT EXISTS(
         SELECT 1 FROM mc.financial_daily_current_publications current_publication
          WHERE current_publication.business_id=event.business_id
            AND current_publication.store_id=event.store_id
       )
     GROUP BY event.business_id,event.store_id,method.id
  LOOP
    IF target.actor_user_id IS NULL THEN CONTINUE; END IF;
    PERFORM set_config('app.business_id',target.business_id::text,true);
    PERFORM set_config('app.user_id',target.actor_user_id::text,true);
    PERFORM mc.emit_financial_input_event(
      target.store_id,
      'daily-publication-legacy-shadow-recovery:v1:store:'||target.store_id,
      'shadow_backfill',target.affected_from,target.affected_to,
      p_source_result_method_version_id=>target.method_version_id
    );
  END LOOP;
  PERFORM set_config('app.business_id',coalesce(prior_business,''),true);
  PERFORM set_config('app.user_id',coalesce(prior_user,''),true);
END $$;

ALTER TABLE mc.financial_input_events FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.financial_daily_current_publications FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.financial_daily_publications FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.stores FORCE ROW LEVEL SECURITY;

INSERT INTO mc.schema_migrations(version) VALUES(48);
COMMIT;
