BEGIN;

-- Financial components retain their exact source field and signed amount.
-- Only the result classification changes; no WB fetch or raw rewrite is needed.
INSERT INTO mc.method_versions(code,version_no,description,parameters,implementation_version)
SELECT code,version_no+2,'Расходы WB определяются по полям API, независимо от названия операции.',
  parameters||'{"expenseClassification":"source-field-signed-v1"}'::jsonb,
  'financial-result-v'||(version_no+2)
FROM mc.method_versions WHERE code='financial_result' AND version_no IN(29,30);

DO $guards$
DECLARE signature text; definition text; updated text;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'mc.expected_wb_row_rounding_adjustment(uuid,uuid,uuid)',
    'mc.guard_evidence_source()',
    'mc.guard_daily_return_expense_evidence()',
    'mc.guard_signed_tax_period_finish()',
    'mc.guard_period_result()',
    'mc.guard_selected_tax_artifact()',
    'mc.guard_selected_tax_finish()'
  ] LOOP
    definition:=pg_get_functiondef(signature::regprocedure);
    updated:=replace(definition,'''financial-result-v30'')',
      '''financial-result-v30'',''financial-result-v31'',''financial-result-v32'')');
    IF updated=definition THEN RAISE EXCEPTION 'field-based expense guard contract missing: %',signature; END IF;
    EXECUTE updated;
  END LOOP;
  definition:=pg_get_functiondef('mc.guard_run_finish()'::regprocedure);
  updated:=replace(definition,'''financial-result-v29'')','''financial-result-v29'',''financial-result-v31'')');
  updated:=replace(updated,'''financial-result-v30'')','''financial-result-v30'',''financial-result-v31'',''financial-result-v32'')');
  IF updated=definition THEN RAISE EXCEPTION 'weekly result guard contract missing'; END IF; EXECUTE updated;
  definition:=pg_get_functiondef('mc.guard_target_period_finish()'::regprocedure);
  updated:=replace(definition,'''financial-result-v30'')','''financial-result-v30'',''financial-result-v32'')');
  updated:=replace(updated,'WHEN ''financial-result-v30'' THEN ''wb-finance-v13'' END',
    'WHEN ''financial-result-v30'' THEN ''wb-finance-v13'' WHEN ''financial-result-v32'' THEN ''wb-finance-v13'' END');
  IF updated=definition OR strpos(updated,'WHEN ''financial-result-v32'' THEN ''wb-finance-v13''')=0 THEN
    RAISE EXCEPTION 'target result parser contract missing';
  END IF; EXECUTE updated;
  definition:=pg_get_functiondef('mc.financial_daily_shadow_day_compatible(uuid,date)'::regprocedure);
  updated:=replace(definition,'generation_method.version_no=30','generation_method.version_no IN(30,32)');
  updated:=replace(updated,'generation_method.version_no = 30','generation_method.version_no IN(30,32)');
  updated:=replace(updated,'generation_method.implementation_version=''financial-result-v30''',
    'generation_method.implementation_version=''financial-result-v''||generation_method.version_no');
  updated:=replace(updated,'legacy_method.version_no BETWEEN 9 AND 30','legacy_method.version_no BETWEEN 9 AND 32');
  IF updated=definition OR strpos(updated,'IN(30,32)')=0 THEN RAISE EXCEPTION 'daily compatibility contract missing'; END IF;
  EXECUTE updated;
END $guards$;

-- Discover every active tenant, then use its established editor context.
-- Queue the full existing report/publication range, preserving old generations.
ALTER TABLE mc.stores NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.memberships NO FORCE ROW LEVEL SECURITY;
DO $recalculate$
DECLARE target record; actor uuid; method_uuid uuid; date_from date; date_to date;
  prior_business text:=current_setting('app.business_id',true); prior_user text:=current_setting('app.user_id',true);
BEGIN
  SELECT id INTO STRICT method_uuid FROM mc.method_versions WHERE code='financial_result' AND version_no=32;
  FOR target IN SELECT business_id,id FROM mc.stores WHERE status='active' ORDER BY business_id,id LOOP
    actor:=NULL;
    SELECT user_id INTO actor FROM mc.memberships WHERE business_id=target.business_id AND role IN('owner','editor')
      ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END,created_at,user_id LIMIT 1;
    IF actor IS NULL THEN CONTINUE; END IF;
    PERFORM set_config('app.business_id',target.business_id::text,true);
    PERFORM set_config('app.user_id',actor::text,true);
    IF NOT EXISTS(SELECT 1 FROM mc.product_selections WHERE business_id=target.business_id AND store_id=target.id AND status='confirmed') THEN CONTINUE; END IF;
    SELECT min(covered.date_from),max(covered.date_to) INTO date_from,date_to FROM (
      SELECT period_start date_from,period_end date_to FROM mc.reports
        WHERE business_id=target.business_id AND store_id=target.id AND current_version_id IS NOT NULL
      UNION ALL
      SELECT day.accounting_date,day.accounting_date FROM mc.financial_daily_current_publications current
      JOIN mc.financial_daily_publication_days day ON day.publication_id=current.publication_id
        AND day.business_id=current.business_id AND day.store_id=current.store_id
        WHERE current.business_id=target.business_id AND current.store_id=target.id
    ) covered;
    IF date_from IS NULL THEN CONTINUE; END IF;
    INSERT INTO mc.calculation_invalidations(business_id,store_id,requested_by,reason,invalidated_at)
      VALUES(target.business_id,target.id,actor,'field_based_wb_expenses_v32',clock_timestamp())
      ON CONFLICT(store_id) DO UPDATE SET requested_by=excluded.requested_by,reason=excluded.reason,
        generation_token=gen_random_uuid(),invalidated_at=excluded.invalidated_at;
    PERFORM mc.emit_financial_input_event(target.id,'financial-result-upgrade:v32:store:'||target.id,
      'result_method_updated',date_from,date_to,p_source_result_method_version_id=>method_uuid);
  END LOOP;
  PERFORM set_config('app.business_id',coalesce(prior_business,''),true);
  PERFORM set_config('app.user_id',coalesce(prior_user,''),true);
END $recalculate$;
ALTER TABLE mc.memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.stores FORCE ROW LEVEL SECURITY;

INSERT INTO mc.schema_migrations(version) VALUES(63);
COMMIT;
