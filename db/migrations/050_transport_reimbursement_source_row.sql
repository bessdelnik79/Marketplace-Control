BEGIN;

-- Rebuild already published daily periods that were left partial only because
-- a mutable WB operation label changed. The result method is unchanged: the
-- complete same-row bundle is still a zero-valued reconciliation reference.
ALTER TABLE mc.stores NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.memberships NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.financial_daily_current_publications NO FORCE ROW LEVEL SECURITY;

DO $migration$
DECLARE
  target record;
  actor uuid;
  method_id uuid;
  affected_from date;
  affected_to date;
  prior_business text:=current_setting('app.business_id',true);
  prior_user text:=current_setting('app.user_id',true);
BEGIN
  SELECT id INTO STRICT method_id FROM mc.method_versions
   WHERE code='financial_result' AND version_no=20
     AND implementation_version='financial-result-v20';

  FOR target IN
    SELECT pointer.business_id,pointer.store_id
      FROM mc.financial_daily_current_publications pointer
      JOIN mc.stores store ON store.business_id=pointer.business_id
        AND store.id=pointer.store_id AND store.status='active'
     ORDER BY pointer.business_id,pointer.store_id
  LOOP
    SELECT membership.user_id INTO actor FROM mc.memberships membership
     WHERE membership.business_id=target.business_id
       AND membership.role IN ('owner','editor')
     ORDER BY CASE membership.role WHEN 'owner' THEN 0 ELSE 1 END,
       membership.created_at,membership.user_id LIMIT 1;
    IF actor IS NULL THEN CONTINUE; END IF;

    PERFORM set_config('app.business_id',target.business_id::text,true);
    PERFORM set_config('app.user_id',actor::text,true);

    SELECT min(bundle.period_start),max(bundle.period_end)
      INTO affected_from,affected_to
      FROM (
        SELECT report.period_start,report.period_end,operation.id
          FROM mc.reports report
          JOIN mc.report_versions version ON version.id=report.current_version_id
            AND version.report_id=report.id AND version.status='accepted'
          JOIN mc.report_normalizations normalization ON normalization.report_version_id=version.id
            AND normalization.status='succeeded'
          JOIN mc.operation_versions operation ON operation.report_normalization_id=normalization.id
            AND operation.state='active'
          JOIN mc.report_rows source_row ON source_row.id=operation.report_row_id
          JOIN mc.financial_components component ON component.operation_version_id=operation.id
         WHERE report.business_id=target.business_id AND report.store_id=target.store_id
           AND NOT (
             btrim(coalesce(source_row.raw_data->>'docTypeName',''))=''
             AND btrim(coalesce(source_row.raw_data->>'sellerOperName',''))=
               'Возмещение издержек по перевозке/по складским операциям с товаром'
           )
           AND (
             (component.source_field='rebillLogisticCost'
               AND component.category_code='rebill_logistic_compensation')
             OR (component.source_field='vw' AND component.category_code='wb_reward_without_vat')
             OR (component.source_field='vwNds' AND component.category_code='wb_reward_vat')
           )
           AND CASE
             WHEN source_row.raw_data->>component.source_field ~ '^-?[0-9]+([.][0-9]+)?$'
             THEN (source_row.raw_data->>component.source_field)::numeric<>0
             ELSE false
           END
         GROUP BY report.period_start,report.period_end,operation.id
        HAVING count(*)=3 AND count(DISTINCT component.source_field)=3
           AND sum(component.amount_signed)=0
      ) bundle;

    IF affected_from IS NULL THEN CONTINUE; END IF;
    PERFORM mc.emit_financial_input_event(
      target.store_id,
      'transport-zero-bundle-v20-fix:v1:store:'||target.store_id,
      'shadow_backfill',affected_from,affected_to,
      p_source_result_method_version_id=>method_id
    );
  END LOOP;

  PERFORM set_config('app.business_id',coalesce(prior_business,''),true);
  PERFORM set_config('app.user_id',coalesce(prior_user,''),true);
END
$migration$;

ALTER TABLE mc.financial_daily_current_publications FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.stores FORCE ROW LEVEL SECURITY;

INSERT INTO mc.schema_migrations(version) VALUES(50);
COMMIT;
