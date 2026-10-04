BEGIN;

INSERT INTO mc.method_versions(code,version_no,description,parameters,implementation_version)
SELECT code,version_no+2,'Сверка платёжной комиссии и сохранение подтверждённых сумм при денежном расхождении.',
  parameters||'{"paymentCommissionControl":"forpay-before-payment-commission-v1","unreconciledRows":"retain-confirmed-components-v1"}'::jsonb,
  'financial-result-v'||(version_no+2)
FROM mc.method_versions WHERE code='financial_result' AND version_no IN(33,34);

DO $versions$
DECLARE signature text; definition text; updated text;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'mc.expected_wb_row_rounding_adjustment(uuid,uuid,uuid)','mc.guard_evidence_source()',
    'mc.guard_daily_return_expense_evidence()','mc.guard_signed_tax_period_finish()',
    'mc.guard_period_result()','mc.guard_selected_tax_artifact()','mc.guard_selected_tax_finish()',
    'mc.guard_run_finish()','mc.guard_target_period_finish()'
  ] LOOP
    definition:=pg_get_functiondef(signature::regprocedure);
    IF signature='mc.guard_target_period_finish()' THEN
      updated:=replace(definition,'''financial-result-v34'')','''financial-result-v34'',''financial-result-v36'')');
    ELSE
      updated:=replace(definition,'''financial-result-v34'')','''financial-result-v34'',''financial-result-v35'',''financial-result-v36'')');
    END IF;
    updated:=replace(updated,'''financial-result-v33'')','''financial-result-v33'',''financial-result-v35'')');
    updated:=replace(updated,'WHEN ''financial-result-v34'' THEN ''wb-finance-v13'' END',
      'WHEN ''financial-result-v34'' THEN ''wb-finance-v13'' WHEN ''financial-result-v36'' THEN ''wb-finance-v13'' END');
    IF updated=definition THEN RAISE EXCEPTION 'half-kopeck method contract missing: %',signature; END IF;
    EXECUTE updated;
  END LOOP;
  definition:=pg_get_functiondef('mc.financial_daily_shadow_day_compatible(uuid,date)'::regprocedure);
  updated:=replace(definition,'IN(30,32,34)','IN(30,32,34,36)');
  updated:=replace(updated,'legacy_method.version_no BETWEEN 9 AND 34','legacy_method.version_no BETWEEN 9 AND 36');
  IF updated=definition THEN RAISE EXCEPTION 'half-kopeck compatibility contract missing'; END IF;
  EXECUTE updated;
END $versions$;

-- Payment-organisation commission is an expense, but forPay precedes its
-- separate withholding. Only this evidenced payment subtype changes control.
DO $payment_control$
DECLARE definition text; updated text;
BEGIN
  definition:=pg_get_functiondef('mc.expected_wb_row_rounding_adjustment(uuid,uuid,uuid)'::regprocedure);
  updated:=replace(definition,'target:=round(exact_sum,2);',$replacement$
  IF result_implementation IN('financial-result-v35','financial-result-v36')
    AND operation_row.operation_type='sale'
    AND btrim(raw_row->>'paymentProcessing')='Комиссия за организацию платежа с НДС' THEN
    IF nullif(btrim(raw_row->>'acquiringFee'),'') IS NULL
      OR (raw_row->>'acquiringFee') !~ '^[0-9]+([.][0-9]+)?$'
      THEN RETURN NULL; END IF;
    IF (raw_row->>'acquiringFee')::numeric=0 THEN
      IF EXISTS(SELECT 1 FROM mc.financial_components WHERE operation_version_id=operation_row.id
        AND source_field='acquiringFee') THEN RETURN NULL; END IF;
    ELSIF NOT EXISTS(SELECT 1 FROM mc.financial_components
        WHERE operation_version_id=operation_row.id AND source_field='acquiringFee'
          AND category_code='acquiring' AND amount_signed=-(raw_row->>'acquiringFee')::numeric)
      OR (SELECT count(*) FROM mc.financial_components WHERE operation_version_id=operation_row.id
        AND source_field='acquiringFee')<>1 THEN RETURN NULL; END IF;
    payout:=payout-(raw_row->>'acquiringFee')::numeric;
  END IF;
  target:=round(exact_sum,2);$replacement$);
  IF updated=definition THEN RAISE EXCEPTION 'payment commission control contract missing'; END IF;
  EXECUTE updated;
END $payment_control$;

-- Discover every active tenant, then use its established editor context.
-- Queue the full existing report/publication range, preserving old generations.
ALTER TABLE mc.stores NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.memberships NO FORCE ROW LEVEL SECURITY;
DO $recalculate$
DECLARE target record; actor uuid; method_uuid uuid; date_from date; date_to date;
  prior_business text:=current_setting('app.business_id',true); prior_user text:=current_setting('app.user_id',true);
BEGIN
  SELECT id INTO STRICT method_uuid FROM mc.method_versions WHERE code='financial_result' AND version_no=36;
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
      VALUES(target.business_id,target.id,actor,'financial_payment_commission_control',clock_timestamp())
      ON CONFLICT(store_id) DO UPDATE SET requested_by=excluded.requested_by,reason=excluded.reason,
        generation_token=gen_random_uuid(),invalidated_at=excluded.invalidated_at;
    PERFORM mc.emit_financial_input_event(target.id,'financial-payment-commission:v1:store:'||target.id,
      'result_method_updated',date_from,date_to,p_source_result_method_version_id=>method_uuid);
  END LOOP;
  PERFORM set_config('app.business_id',coalesce(prior_business,''),true);
  PERFORM set_config('app.user_id',coalesce(prior_user,''),true);
END $recalculate$;
ALTER TABLE mc.memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.stores FORCE ROW LEVEL SECURITY;

INSERT INTO mc.schema_migrations(version) VALUES(66);
COMMIT;
