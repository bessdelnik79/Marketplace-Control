BEGIN;

-- WB может оставлять субкопеечный остаток между
-- rebillLogisticCost + vw + vwNds.
--
-- Расчёт теперь считает такой комплект нулевым, если точная сумма,
-- округлённая один раз до копеек, равна 0.00.
--
-- Эта миграция находит уже загруженные строки, которые не проходили
-- старую строгую проверку sum(...) = 0, но проходят новую денежную
-- проверку round(sum(...), 2) = 0, и ставит затронутый диапазон
-- на повторный legacy + daily расчёт.

ALTER TABLE mc.stores NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.memberships NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.calculation_invalidations NO FORCE ROW LEVEL SECURITY;

DO $backfill$
DECLARE
  target record;
  actor uuid;
  result_method uuid;
  affected_from date;
  affected_to date;

  prior_business text := current_setting('app.business_id', true);
  prior_user text := current_setting('app.user_id', true);
BEGIN
  SELECT id
    INTO STRICT result_method
    FROM mc.method_versions
   WHERE code = 'financial_result'
     AND implementation_version = 'financial-result-v30';

  FOR target IN
    SELECT business_id, id AS store_id
      FROM mc.stores
     WHERE status = 'active'
     ORDER BY business_id, id
  LOOP
    actor := NULL;
    affected_from := NULL;
    affected_to := NULL;

    SELECT membership.user_id
      INTO actor
      FROM mc.memberships membership
     WHERE membership.business_id = target.business_id
       AND membership.role IN ('owner', 'editor')
     ORDER BY
       CASE membership.role WHEN 'owner' THEN 0 ELSE 1 END,
       membership.created_at,
       membership.user_id
     LIMIT 1;

    IF actor IS NULL THEN
      CONTINUE;
    END IF;

    PERFORM set_config(
      'app.business_id',
      target.business_id::text,
      true
    );

    PERFORM set_config(
      'app.user_id',
      actor::text,
      true
    );

    -- Без выбранных товаров финансовый расчёт для магазина не запускается.
    IF NOT EXISTS (
      SELECT 1
        FROM mc.product_selections selection
       WHERE selection.business_id = target.business_id
         AND selection.store_id = target.store_id
         AND selection.status = 'confirmed'
    ) THEN
      CONTINUE;
    END IF;

    SELECT
      min(bundle.accounting_date),
      max(bundle.accounting_date)
      INTO affected_from, affected_to
      FROM (
        SELECT
          operation.id,
          operation.accounting_date
        FROM mc.reports report

        JOIN mc.report_versions version
          ON version.id = report.current_version_id
         AND version.report_id = report.id
         AND version.status = 'accepted'

        JOIN mc.report_normalizations normalization
          ON normalization.report_version_id = version.id
         AND normalization.status = 'succeeded'

        JOIN mc.method_versions parser_method
          ON parser_method.id = normalization.method_version_id
         AND parser_method.code = 'wb_finance_import'
         AND parser_method.implementation_version = 'wb-finance-v13'

        JOIN mc.operation_versions operation
          ON operation.report_normalization_id = normalization.id
         AND operation.state = 'active'

        JOIN mc.report_rows source_row
          ON source_row.id = operation.report_row_id

        JOIN mc.financial_components component
          ON component.operation_version_id = operation.id

        WHERE report.business_id = target.business_id
          AND report.store_id = target.store_id

          AND (
            (
              component.source_field = 'rebillLogisticCost'
              AND component.category_code = 'rebill_logistic_compensation'
            )
            OR
            (
              component.source_field = 'vw'
              AND component.category_code = 'wb_reward_without_vat'
            )
            OR
            (
              component.source_field = 'vwNds'
              AND component.category_code = 'wb_reward_vat'
            )
          )

          AND CASE
            WHEN source_row.raw_data->>component.source_field
                 ~ '^-?[0-9]+([.][0-9]+)?$'
            THEN
              (source_row.raw_data->>component.source_field)::numeric <> 0
            ELSE false
          END

        GROUP BY
          operation.id,
          operation.accounting_date

        HAVING count(*) = 3
           AND count(DISTINCT component.source_field) = 3

           -- Старое условие такие строки не принимало.
           AND sum(component.amount_signed) <> 0

           -- Новое правило: точную сумму округляем один раз до копеек.
           AND round(sum(component.amount_signed), 2) = 0
      ) bundle;

    IF affected_from IS NULL OR affected_to IS NULL THEN
      CONTINUE;
    END IF;

    -- Пересчитываем compatibility/legacy результат.
    -- Это важно для shadow-сверки новой daily publication.
    INSERT INTO mc.calculation_invalidations(
      business_id,
      store_id,
      requested_by,
      reason,
      invalidated_at
    )
    VALUES(
      target.business_id,
      target.store_id,
      actor,
      'transport_reimbursement_kopeck_rounding_v30',
      clock_timestamp()
    )
    ON CONFLICT(store_id) DO UPDATE
       SET requested_by = excluded.requested_by,
           reason = excluded.reason,
           generation_token = gen_random_uuid(),
           invalidated_at = excluded.invalidated_at;

    -- Запускаем новый daily generation только по затронутому диапазону.
    PERFORM mc.emit_financial_input_event(
      target.store_id,
      'transport-kopeck-rounding:v1:store:' || target.store_id,
      'shadow_backfill',
      affected_from,
      affected_to,
      p_source_result_method_version_id => result_method
    );
  END LOOP;

  PERFORM set_config(
    'app.business_id',
    coalesce(prior_business, ''),
    true
  );

  PERFORM set_config(
    'app.user_id',
    coalesce(prior_user, ''),
    true
  );
END
$backfill$;

ALTER TABLE mc.calculation_invalidations FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.stores FORCE ROW LEVEL SECURITY;

INSERT INTO mc.schema_migrations(version) VALUES(58);

COMMIT;