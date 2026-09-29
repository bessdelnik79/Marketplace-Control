BEGIN;

-- Migration 055 installs v30 before replacing the method-event trigger. A store
-- whose current reports were already normalized with v13 could therefore miss
-- the one full-range cutover event. Recover only fully ready stores; stores that
-- are still being refetched are handled by the final v13 normalization worker.
ALTER TABLE mc.stores NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.memberships NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.method_versions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.reports NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.report_versions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.report_normalizations NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.product_selections NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.financial_daily_current_publications NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.financial_daily_publications NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.financial_daily_generations NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.financial_daily_publication_days NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.financial_input_events NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.calculation_invalidations NO FORCE ROW LEVEL SECURITY;

DO $recovery$
DECLARE target record; actor uuid;
  prior_business text:=current_setting('app.business_id',true);
  prior_user text:=current_setting('app.user_id',true);
BEGIN
  FOR target IN
    WITH ready_store AS (
      SELECT store.business_id,store.id store_id,
             least(min(day.accounting_date),min(report.period_start)) affected_from,
             greatest(max(day.accounting_date),max(report.period_end)) affected_to,
             parser.id parser_method_id,result.id result_method_id
        FROM mc.stores store
        JOIN mc.financial_daily_current_publications current_publication
          ON current_publication.business_id=store.business_id AND current_publication.store_id=store.id
        JOIN mc.financial_daily_publications publication ON publication.id=current_publication.publication_id
        JOIN mc.financial_daily_generations generation ON generation.id=publication.generation_id
        JOIN mc.method_versions current_method ON current_method.id=generation.result_method_version_id
        LEFT JOIN mc.financial_daily_publication_days day ON day.publication_id=publication.id
        JOIN mc.reports report ON report.business_id=store.business_id AND report.store_id=store.id
        JOIN mc.report_versions version ON version.id=report.current_version_id AND version.status='accepted'
        JOIN mc.method_versions parser ON parser.code='wb_finance_import' AND parser.implementation_version='wb-finance-v13'
        JOIN mc.method_versions result ON result.code='financial_result' AND result.implementation_version='financial-result-v30'
       WHERE store.status='active' AND current_method.version_no<30
         AND EXISTS(SELECT 1 FROM mc.product_selections selection
           WHERE selection.business_id=store.business_id AND selection.store_id=store.id AND selection.status='confirmed')
         AND NOT EXISTS(
           SELECT 1 FROM mc.reports pending_report
           JOIN mc.report_versions pending_version ON pending_version.id=pending_report.current_version_id
           WHERE pending_report.business_id=store.business_id AND pending_report.store_id=store.id
             AND pending_version.status='accepted' AND NOT EXISTS(
               SELECT 1 FROM mc.report_normalizations normalization
               JOIN mc.method_versions normalization_method ON normalization_method.id=normalization.method_version_id
               WHERE normalization.report_version_id=pending_version.id AND normalization.status='succeeded'
                 AND normalization_method.implementation_version='wb-finance-v13'
             )
         )
       GROUP BY store.business_id,store.id,parser.id,result.id
    )
    SELECT ready_store.*,
           CASE
             WHEN parser_event.id IS NULL THEN 'financial-parser-upgrade:v13:store:'||ready_store.store_id
             WHEN parser_event.affected_from>ready_store.affected_from OR parser_event.affected_to<ready_store.affected_to
               THEN 'financial-parser-upgrade:v13:cutover-repair:v1:store:'||ready_store.store_id
             ELSE NULL
           END parser_event_key,
           CASE
             WHEN result_event.id IS NULL THEN 'financial-result-upgrade:v30:store:'||ready_store.store_id
             ELSE 'financial-result-upgrade:v30:cutover-repair:v1:store:'||ready_store.store_id
           END result_event_key
      FROM ready_store
      LEFT JOIN mc.financial_input_events parser_event
        ON parser_event.business_id=ready_store.business_id AND parser_event.store_id=ready_store.store_id
       AND parser_event.event_key='financial-parser-upgrade:v13:store:'||ready_store.store_id
      LEFT JOIN mc.financial_input_events result_event
        ON result_event.business_id=ready_store.business_id AND result_event.store_id=ready_store.store_id
       AND result_event.event_key='financial-result-upgrade:v30:store:'||ready_store.store_id
     WHERE ready_store.affected_from IS NOT NULL AND ready_store.affected_to IS NOT NULL
       AND (result_event.id IS NULL OR result_event.affected_from>ready_store.affected_from
         OR result_event.affected_to<ready_store.affected_to)
  LOOP
    actor:=NULL;
    SELECT membership.user_id INTO actor FROM mc.memberships membership
     WHERE membership.business_id=target.business_id AND membership.role IN('owner','editor')
     ORDER BY CASE membership.role WHEN 'owner' THEN 0 ELSE 1 END,membership.created_at,membership.user_id LIMIT 1;
    IF actor IS NULL THEN CONTINUE; END IF;
    PERFORM set_config('app.business_id',target.business_id::text,true);
    PERFORM set_config('app.user_id',actor::text,true);
    INSERT INTO mc.calculation_invalidations(business_id,store_id,requested_by,reason,invalidated_at)
      VALUES(target.business_id,target.store_id,actor,'exact_wb_row_result_v30',clock_timestamp())
      ON CONFLICT(store_id) DO UPDATE SET requested_by=excluded.requested_by,reason=excluded.reason,
        generation_token=gen_random_uuid(),invalidated_at=excluded.invalidated_at;
    IF target.parser_event_key IS NOT NULL THEN
      PERFORM mc.emit_financial_input_event(target.store_id,target.parser_event_key,'parser_method_updated',
        target.affected_from,target.affected_to,p_source_parser_method_version_id=>target.parser_method_id);
    END IF;
    PERFORM mc.emit_financial_input_event(target.store_id,
      target.result_event_key,'result_method_updated',
      target.affected_from,target.affected_to,p_source_result_method_version_id=>target.result_method_id);
  END LOOP;
  PERFORM set_config('app.business_id',coalesce(prior_business,''),true);
  PERFORM set_config('app.user_id',coalesce(prior_user,''),true);
END $recovery$;

ALTER TABLE mc.calculation_invalidations FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.financial_input_events FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.financial_daily_publication_days FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.financial_daily_generations FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.financial_daily_publications FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.financial_daily_current_publications FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.product_selections FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.report_normalizations FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.report_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.reports FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.method_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.stores FORCE ROW LEVEL SECURITY;

INSERT INTO mc.schema_migrations(version) VALUES(56);
COMMIT;
