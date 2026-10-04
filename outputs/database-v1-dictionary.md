# Marketplace Control — словарь БД, итерация 1

Сформирован из применённой миграции. Названия полей, типы, значения по умолчанию и ограничения соответствуют проверенной схеме.

Денежные значения — точные десятичные числа. NULL означает отсутствие значения. Все даты периодов включительны; стоимость действует от effective_from до следующей даты стоимости варианта.

## audit_events

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| id | uuid | нет | gen_random_uuid() |
| business_id | uuid | нет | — |
| store_id | uuid | да | — |
| actor_user_id | uuid | да | — |
| action | text | нет | — |
| entity_type | text | нет | — |
| entity_id | uuid | да | — |
| safe_details | jsonb | нет | '{}'::jsonb |
| created_at | timestamp with time zone | нет | now() |

Ограничения и связи:

- `FOREIGN KEY (actor_user_id) REFERENCES mc.users(id)`
- `FOREIGN KEY (business_id) REFERENCES mc.businesses(id)`
- `FOREIGN KEY (business_id, store_id) REFERENCES mc.stores(business_id, id)`
- `PRIMARY KEY (id)`

## auth_identities

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| id | uuid | нет | gen_random_uuid() |
| user_id | uuid | нет | — |
| provider | text | нет | — |
| subject | text | нет | — |
| created_at | timestamp with time zone | нет | now() |

Ограничения и связи:

- `PRIMARY KEY (id)`
- `UNIQUE (provider, subject)`
- `FOREIGN KEY (user_id) REFERENCES mc.users(id)`

## auth_oauth_states

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| state_hash | text | нет | — |
| provider | text | нет | — |
| expires_at | timestamp with time zone | нет | — |
| created_at | timestamp with time zone | нет | now() |

Ограничения и связи:

- `CHECK ((expires_at > created_at))`
- `PRIMARY KEY (state_hash)`
- `CHECK ((provider = 'yandex'::text))`

## auth_password_credentials

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| user_id | uuid | нет | — |
| password_hash | text | нет | — |
| password_changed_at | timestamp with time zone | нет | now() |
| created_at | timestamp with time zone | нет | now() |

Ограничения и связи:

- `CHECK ((password_hash ~~ 'scrypt$%'::text))`
- `PRIMARY KEY (user_id)`
- `FOREIGN KEY (user_id) REFERENCES mc.users(id) ON DELETE CASCADE`

## auth_rate_limits

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| bucket_key | text | нет | — |
| attempts | integer | нет | — |
| window_started_at | timestamp with time zone | нет | — |
| expires_at | timestamp with time zone | нет | — |

Ограничения и связи:

- `CHECK ((attempts > 0))`
- `CHECK ((expires_at > window_started_at))`
- `PRIMARY KEY (bucket_key)`

## auth_registration_challenges

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| id | uuid | нет | gen_random_uuid() |
| email | text | нет | — |
| display_name | text | нет | — |
| password_hash | text | нет | — |
| code_hash | text | нет | — |
| attempts | integer | нет | 0 |
| expires_at | timestamp with time zone | нет | — |
| created_at | timestamp with time zone | нет | now() |

Ограничения и связи:

- `CHECK (((attempts >= 0) AND (attempts <= 5)))`
- `CHECK ((expires_at > created_at))`
- `UNIQUE (email)`
- `PRIMARY KEY (id)`

## auth_sessions

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| id | uuid | нет | gen_random_uuid() |
| user_id | uuid | нет | — |
| token_hash | text | нет | — |
| expires_at | timestamp with time zone | нет | — |
| last_seen_at | timestamp with time zone | нет | now() |
| created_at | timestamp with time zone | нет | now() |

Ограничения и связи:

- `CHECK ((expires_at > created_at))`
- `PRIMARY KEY (id)`
- `UNIQUE (token_hash)`
- `FOREIGN KEY (user_id) REFERENCES mc.users(id) ON DELETE CASCADE`

## billing_invoices

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| id | uuid | нет | gen_random_uuid() |
| business_id | uuid | нет | — |
| subscription_id | uuid | нет | — |
| provider_invoice_id | text | да | — |
| amount | numeric(20,4) | нет | — |
| currency | text | нет | 'RUB'::text |
| period_start | timestamp with time zone | нет | — |
| period_end | timestamp with time zone | нет | — |
| status | text | нет | 'open'::text |
| created_at | timestamp with time zone | нет | now() |

Ограничения и связи:

- `CHECK ((amount > (0)::numeric))`
- `UNIQUE (business_id, id)`
- `FOREIGN KEY (business_id, subscription_id) REFERENCES mc.subscriptions(business_id, id)`
- `CHECK ((period_end > period_start))`
- `CHECK ((currency = 'RUB'::text))`
- `PRIMARY KEY (id)`
- `CHECK ((status = ANY (ARRAY['open'::text, 'paid'::text, 'void'::text])))`

## billing_payment_events

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| id | uuid | нет | gen_random_uuid() |
| business_id | uuid | нет | — |
| payment_id | uuid | да | — |
| provider | text | нет | — |
| external_event_id | text | нет | — |
| event_type | text | нет | — |
| safe_payload | jsonb | нет | — |
| status | text | нет | 'received'::text |
| processed_at | timestamp with time zone | да | — |
| created_at | timestamp with time zone | нет | now() |

Ограничения и связи:

- `FOREIGN KEY (business_id) REFERENCES mc.businesses(id)`
- `FOREIGN KEY (business_id, payment_id) REFERENCES mc.billing_payments(business_id, id)`
- `PRIMARY KEY (id)`
- `UNIQUE (provider, external_event_id)`
- `CHECK ((status = ANY (ARRAY['received'::text, 'processed'::text, 'failed'::text])))`

## billing_payments

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| id | uuid | нет | gen_random_uuid() |
| business_id | uuid | нет | — |
| invoice_id | uuid | нет | — |
| provider | text | нет | — |
| provider_payment_id | text | да | — |
| idempotency_key | text | нет | — |
| amount | numeric(20,4) | нет | — |
| currency | text | нет | 'RUB'::text |
| status | text | нет | 'pending'::text |
| paid_at | timestamp with time zone | да | — |
| created_at | timestamp with time zone | нет | now() |

Ограничения и связи:

- `CHECK ((amount > (0)::numeric))`
- `UNIQUE (business_id, id)`
- `FOREIGN KEY (business_id, invoice_id) REFERENCES mc.billing_invoices(business_id, id)`
- `CHECK (((status = 'succeeded'::text) = (paid_at IS NOT NULL)))`
- `CHECK ((currency = 'RUB'::text))`
- `UNIQUE (idempotency_key)`
- `PRIMARY KEY (id)`
- `UNIQUE (provider, provider_payment_id)`
- `CHECK ((status = ANY (ARRAY['pending'::text, 'succeeded'::text, 'failed'::text, 'cancelled'::text])))`

## billing_plan_versions

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| id | uuid | нет | gen_random_uuid() |
| plan_id | uuid | нет | — |
| version_no | integer | нет | — |
| product_limit | integer | нет | — |
| store_limit | integer | нет | — |
| price | numeric(20,4) | да | — |
| currency | text | нет | 'RUB'::text |
| billing_period | text | нет | — |
| created_at | timestamp with time zone | нет | now() |

Ограничения и связи:

- `CHECK ((billing_period = ANY (ARRAY['none'::text, 'month'::text, 'year'::text])))`
- `CHECK (((billing_period <> 'none'::text) OR ((price IS NOT NULL) AND (price = (0)::numeric))))`
- `CHECK ((currency = 'RUB'::text))`
- `PRIMARY KEY (id)`
- `FOREIGN KEY (plan_id) REFERENCES mc.billing_plans(id)`
- `UNIQUE (plan_id, version_no)`
- `CHECK ((price >= (0)::numeric))`
- `CHECK ((product_limit > 0))`
- `CHECK ((store_limit > 0))`
- `CHECK ((version_no > 0))`

## billing_plans

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| id | uuid | нет | gen_random_uuid() |
| code | text | нет | — |
| name | text | нет | — |
| created_at | timestamp with time zone | нет | now() |

Ограничения и связи:

- `UNIQUE (code)`
- `PRIMARY KEY (id)`

## businesses

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| id | uuid | нет | gen_random_uuid() |
| name | text | нет | — |
| timezone | text | нет | 'Europe/Moscow'::text |
| currency | text | нет | 'RUB'::text |
| created_at | timestamp with time zone | нет | now() |

Ограничения и связи:

- `CHECK ((currency = 'RUB'::text))`
- `CHECK ((length(TRIM(BOTH FROM name)) > 0))`
- `PRIMARY KEY (id)`

## calculation_inputs

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| id | uuid | нет | gen_random_uuid() |
| business_id | uuid | нет | — |
| store_id | uuid | нет | — |
| run_id | uuid | нет | — |
| report_version_id | uuid | да | — |
| cost_version_id | uuid | да | — |
| expense_version_id | uuid | да | — |
| created_at | timestamp with time zone | нет | now() |
| report_normalization_id | uuid | да | — |
| tax_setting_version_id | uuid | да | — |
| operation_link_id | uuid | да | — |

Ограничения и связи:

- `FOREIGN KEY (business_id, store_id, operation_link_id) REFERENCES mc.operation_links(business_id, store_id, id)`
- `FOREIGN KEY (business_id, store_id, report_normalization_id) REFERENCES mc.report_normalizations(business_id, store_id, id)`
- `CHECK ((num_nonnulls(report_version_id, report_normalization_id, cost_version_id, expense_version_id, tax_setting_version_id, operation_link_id) = 1))`
- `FOREIGN KEY (business_id, tax_setting_version_id) REFERENCES mc.tax_setting_versions(business_id, id)`
- `FOREIGN KEY (business_id, store_id, cost_version_id) REFERENCES mc.cost_versions(business_id, store_id, id)`
- `FOREIGN KEY (business_id, store_id, expense_version_id) REFERENCES mc.expense_versions(business_id, store_id, id)`
- `FOREIGN KEY (business_id, store_id, report_version_id) REFERENCES mc.report_versions(business_id, store_id, id)`
- `FOREIGN KEY (business_id, store_id, run_id) REFERENCES mc.calculation_runs(business_id, store_id, id)`
- `PRIMARY KEY (id)`
- `UNIQUE (run_id, cost_version_id)`
- `UNIQUE (run_id, expense_version_id)`
- `UNIQUE (run_id, report_version_id)`

## calculation_invalidations

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| store_id | uuid | нет | — |
| business_id | uuid | нет | — |
| requested_by | uuid | да | — |
| reason | text | нет | — |
| generation_token | uuid | нет | gen_random_uuid() |
| invalidated_at | timestamp with time zone | нет | clock_timestamp() |

Ограничения и связи:

- `FOREIGN KEY (business_id, store_id) REFERENCES mc.stores(business_id, id)`
- `UNIQUE (business_id, store_id)`
- `PRIMARY KEY (store_id)`
- `FOREIGN KEY (requested_by) REFERENCES mc.users(id)`

## calculation_request_inputs

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| id | uuid | нет | gen_random_uuid() |
| business_id | uuid | нет | — |
| store_id | uuid | нет | — |
| request_id | uuid | нет | — |
| report_normalization_id | uuid | да | — |
| cost_version_id | uuid | да | — |
| expense_version_id | uuid | да | — |
| tax_setting_version_id | uuid | да | — |
| created_at | timestamp with time zone | нет | now() |
| report_version_id | uuid | да | — |
| operation_link_id | uuid | да | — |

Ограничения и связи:

- `FOREIGN KEY (business_id, store_id, operation_link_id) REFERENCES mc.operation_links(business_id, store_id, id)`
- `CHECK ((num_nonnulls(report_version_id, report_normalization_id, cost_version_id, expense_version_id, tax_setting_version_id, operation_link_id) = 1))`
- `FOREIGN KEY (business_id, store_id, report_version_id) REFERENCES mc.report_versions(business_id, store_id, id)`
- `FOREIGN KEY (business_id, store_id, cost_version_id) REFERENCES mc.cost_versions(business_id, store_id, id)`
- `FOREIGN KEY (business_id, store_id, expense_version_id) REFERENCES mc.expense_versions(business_id, store_id, id)`
- `UNIQUE (business_id, store_id, id)`
- `FOREIGN KEY (business_id, store_id, report_normalization_id) REFERENCES mc.report_normalizations(business_id, store_id, id)`
- `FOREIGN KEY (business_id, store_id, request_id) REFERENCES mc.calculation_requests(business_id, store_id, id)`
- `FOREIGN KEY (business_id, tax_setting_version_id) REFERENCES mc.tax_setting_versions(business_id, id)`
- `PRIMARY KEY (id)`

## calculation_request_products

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| id | uuid | нет | gen_random_uuid() |
| business_id | uuid | нет | — |
| store_id | uuid | нет | — |
| request_id | uuid | нет | — |
| product_id | uuid | нет | — |
| created_at | timestamp with time zone | нет | now() |

Ограничения и связи:

- `UNIQUE (business_id, store_id, id)`
- `FOREIGN KEY (business_id, store_id, product_id) REFERENCES mc.product_selection_items(business_id, store_id, product_id)`
- `FOREIGN KEY (business_id, store_id, request_id) REFERENCES mc.calculation_requests(business_id, store_id, id)`
- `PRIMARY KEY (id)`
- `UNIQUE (request_id, product_id)`

## calculation_requests

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| id | uuid | нет | gen_random_uuid() |
| business_id | uuid | нет | — |
| store_id | uuid | нет | — |
| generation_no | bigint | нет | — |
| selection_id | uuid | нет | — |
| method_version_id | uuid | нет | — |
| period_start | date | нет | — |
| period_end | date | нет | — |
| input_fingerprint | text | нет | — |
| status | text | нет | 'pending'::text |
| is_latest | boolean | нет | true |
| last_error_code | text | да | — |
| requested_at | timestamp with time zone | нет | now() |
| updated_at | timestamp with time zone | нет | now() |

Ограничения и связи:

- `FOREIGN KEY (business_id, store_id) REFERENCES mc.stores(business_id, id)`
- `UNIQUE (business_id, store_id, id)`
- `FOREIGN KEY (business_id, store_id, selection_id) REFERENCES mc.product_selections(business_id, store_id, id)`
- `CHECK ((period_end >= period_start))`
- `CHECK ((generation_no > 0))`
- `CHECK ((input_fingerprint <> ''::text))`
- `FOREIGN KEY (method_version_id) REFERENCES mc.method_versions(id)`
- `CHECK (isfinite(period_end))`
- `CHECK (isfinite(period_start))`
- `PRIMARY KEY (id)`
- `CHECK ((status = ANY (ARRAY['pending'::text, 'running'::text, 'published'::text, 'failed'::text, 'superseded'::text])))`
- `UNIQUE (store_id, generation_no)`

## calculation_runs

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| id | uuid | нет | gen_random_uuid() |
| business_id | uuid | нет | — |
| store_id | uuid | нет | — |
| selection_id | uuid | нет | — |
| method_version_id | uuid | нет | — |
| period_start | date | нет | — |
| period_end | date | нет | — |
| input_fingerprint | text | нет | — |
| status | text | нет | 'running'::text |
| quality | text | нет | 'unavailable'::text |
| missing_reasons | jsonb | нет | '[]'::jsonb |
| finished_at | timestamp with time zone | да | — |
| created_at | timestamp with time zone | нет | now() |
| request_id | uuid | да | — |
| attempt_no | integer | да | — |

Ограничения и связи:

- `CHECK ((((request_id IS NULL) AND (attempt_no IS NULL)) OR ((request_id IS NOT NULL) AND (attempt_no IS NOT NULL) AND (attempt_no > 0))))`
- `FOREIGN KEY (business_id, store_id, request_id) REFERENCES mc.calculation_requests(business_id, store_id, id)`
- `UNIQUE (business_id, store_id, id)`
- `FOREIGN KEY (business_id, store_id, selection_id) REFERENCES mc.product_selections(business_id, store_id, id)`
- `CHECK ((period_end >= period_start))`
- `CHECK (((status = 'running'::text) = (finished_at IS NULL)))`
- `FOREIGN KEY (method_version_id) REFERENCES mc.method_versions(id)`
- `PRIMARY KEY (id)`
- `CHECK ((quality = ANY (ARRAY['complete'::text, 'partial'::text, 'unavailable'::text])))`
- `CHECK ((status = ANY (ARRAY['running'::text, 'succeeded'::text, 'failed'::text])))`

## connection_secrets

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| id | uuid | нет | gen_random_uuid() |
| business_id | uuid | нет | — |
| connection_id | uuid | нет | — |
| ciphertext | bytea | нет | — |
| nonce | bytea | нет | — |
| auth_tag | bytea | нет | — |
| key_version | text | нет | 'v1'::text |
| created_at | timestamp with time zone | нет | now() |
| updated_at | timestamp with time zone | нет | now() |
| credential_fingerprint | text | да | — |

Ограничения и связи:

- `CHECK ((octet_length(auth_tag) = 16))`
- `FOREIGN KEY (business_id, connection_id) REFERENCES mc.connections(business_id, id) ON DELETE CASCADE`
- `UNIQUE (connection_id)`
- `CHECK (((credential_fingerprint IS NULL) OR (credential_fingerprint ~ '^[0-9a-f]{64}$'::text)))`
- `CHECK ((octet_length(nonce) = 12))`
- `PRIMARY KEY (id)`

## connections

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| id | uuid | нет | gen_random_uuid() |
| business_id | uuid | нет | — |
| store_id | uuid | нет | — |
| secret_ref | text | нет | — |
| scopes | jsonb | нет | '[]'::jsonb |
| status | text | нет | 'pending'::text |
| last_checked_at | timestamp with time zone | да | — |
| created_at | timestamp with time zone | нет | now() |
| credential_generation | bigint | нет | 0 |

Ограничения и связи:

- `FOREIGN KEY (business_id, store_id) REFERENCES mc.stores(business_id, id)`
- `UNIQUE (business_id, store_id, id)`
- `CHECK ((credential_generation >= 0))`
- `PRIMARY KEY (id)`
- `CHECK ((status = ANY (ARRAY['pending'::text, 'active'::text, 'invalid'::text, 'revoked'::text])))`

## cost_versions

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| id | uuid | нет | gen_random_uuid() |
| business_id | uuid | нет | — |
| store_id | uuid | нет | — |
| cost_id | uuid | нет | — |
| version_no | integer | нет | — |
| unit_cost | numeric(20,4) | нет | — |
| currency | text | нет | 'RUB'::text |
| origin | text | нет | — |
| import_row_id | uuid | да | — |
| changed_by | uuid | нет | — |
| comment | text | да | — |
| created_at | timestamp with time zone | нет | now() |

Ограничения и связи:

- `FOREIGN KEY (business_id, store_id, cost_id) REFERENCES mc.variant_costs(business_id, store_id, id)`
- `UNIQUE (business_id, store_id, cost_id, id)`
- `UNIQUE (business_id, store_id, id)`
- `FOREIGN KEY (business_id, store_id, import_row_id) REFERENCES mc.import_rows(business_id, store_id, id)`
- `FOREIGN KEY (changed_by) REFERENCES mc.users(id)`
- `CHECK (((origin = 'file'::text) = (import_row_id IS NOT NULL)))`
- `UNIQUE (cost_id, version_no)`
- `CHECK ((currency = 'RUB'::text))`
- `UNIQUE (import_row_id)`
- `CHECK ((origin = ANY (ARRAY['manual'::text, 'file'::text])))`
- `PRIMARY KEY (id)`
- `CHECK ((unit_cost >= (0)::numeric))`
- `CHECK ((version_no > 0))`

## coverage_intervals

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| id | uuid | нет | gen_random_uuid() |
| business_id | uuid | нет | — |
| store_id | uuid | нет | — |
| stream_id | uuid | нет | — |
| source_document_id | uuid | да | — |
| date_from | date | нет | — |
| date_to | date | нет | — |
| status | text | нет | — |
| reason | text | да | — |
| created_at | timestamp with time zone | нет | now() |

Ограничения и связи:

- `FOREIGN KEY (business_id, store_id, source_document_id) REFERENCES mc.source_documents(business_id, store_id, id)`
- `FOREIGN KEY (business_id, store_id, stream_id) REFERENCES mc.sync_streams(business_id, store_id, id)`
- `CHECK ((date_to >= date_from))`
- `PRIMARY KEY (id)`
- `CHECK ((status = ANY (ARRAY['unknown'::text, 'partial'::text, 'complete'::text, 'unavailable'::text])))`

## data_issues

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| id | uuid | нет | gen_random_uuid() |
| business_id | uuid | нет | — |
| store_id | uuid | нет | — |
| document_id | uuid | нет | — |
| report_row_id | uuid | да | — |
| code | text | нет | — |
| severity | text | нет | — |
| status | text | нет | 'open'::text |
| details | jsonb | нет | '{}'::jsonb |
| created_at | timestamp with time zone | нет | now() |
| report_normalization_id | uuid | да | — |
| resolved_at | timestamp with time zone | да | — |
| resolved_by_normalization_id | uuid | да | — |

Ограничения и связи:

- `FOREIGN KEY (business_id, store_id, report_normalization_id) REFERENCES mc.report_normalizations(business_id, store_id, id)`
- `CHECK ((((status = 'open'::text) AND (resolved_at IS NULL) AND (resolved_by_normalization_id IS NULL)) OR ((status = 'resolved'::text) AND (resolved_at IS NOT NULL) AND (resolved_by_normalization_id IS NOT NULL)) OR (status = 'accepted_limitation'::text)))`
- `FOREIGN KEY (business_id, store_id, resolved_by_normalization_id) REFERENCES mc.report_normalizations(business_id, store_id, id)`
- `FOREIGN KEY (business_id, store_id, document_id) REFERENCES mc.source_documents(business_id, store_id, id)`
- `FOREIGN KEY (business_id, store_id, report_row_id) REFERENCES mc.report_rows(business_id, store_id, id)`
- `PRIMARY KEY (id)`
- `CHECK ((severity = ANY (ARRAY['warning'::text, 'blocking'::text])))`
- `CHECK ((status = ANY (ARRAY['open'::text, 'resolved'::text, 'accepted_limitation'::text])))`

## expense_versions

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| id | uuid | нет | gen_random_uuid() |
| business_id | uuid | нет | — |
| store_id | uuid | нет | — |
| expense_id | uuid | нет | — |
| version_no | integer | нет | — |
| category | text | нет | 'external_promotion'::text |
| amount | numeric(20,4) | нет | — |
| currency | text | нет | 'RUB'::text |
| period_start | date | нет | — |
| period_end | date | нет | — |
| channel_name | text | да | — |
| description | text | да | — |
| recognition_method | text | нет | — |
| state | text | нет | 'active'::text |
| origin | text | нет | — |
| import_row_id | uuid | да | — |
| changed_by | uuid | нет | — |
| created_at | timestamp with time zone | нет | now() |

Ограничения и связи:

- `CHECK ((amount > (0)::numeric))`
- `FOREIGN KEY (business_id, store_id, expense_id) REFERENCES mc.expenses(business_id, store_id, id)`
- `UNIQUE (business_id, store_id, expense_id, id)`
- `UNIQUE (business_id, store_id, id)`
- `FOREIGN KEY (business_id, store_id, import_row_id) REFERENCES mc.import_rows(business_id, store_id, id)`
- `CHECK ((category = ANY (ARRAY['external_promotion'::text, 'agency_services'::text, 'other_external'::text, 'packaging'::text, 'software_services'::text])))`
- `FOREIGN KEY (changed_by) REFERENCES mc.users(id)`
- `CHECK ((period_end >= period_start))`
- `CHECK (((recognition_method <> 'on_date'::text) OR (period_end = period_start)))`
- `CHECK (((origin = 'file'::text) = (import_row_id IS NOT NULL)))`
- `CHECK ((currency = 'RUB'::text))`
- `UNIQUE (expense_id, version_no)`
- `UNIQUE (import_row_id)`
- `CHECK ((origin = ANY (ARRAY['manual'::text, 'file'::text])))`
- `PRIMARY KEY (id)`
- `CHECK ((recognition_method = ANY (ARRAY['on_date'::text, 'evenly_over_period'::text])))`
- `CHECK ((state = ANY (ARRAY['active'::text, 'voided'::text])))`
- `CHECK ((version_no > 0))`

## expenses

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| id | uuid | нет | gen_random_uuid() |
| business_id | uuid | нет | — |
| store_id | uuid | нет | — |
| product_id | uuid | да | — |
| external_entry_key | text | да | — |
| current_version_id | uuid | да | — |
| created_at | timestamp with time zone | нет | now() |

Ограничения и связи:

- `FOREIGN KEY (business_id, store_id, id, current_version_id) REFERENCES mc.expense_versions(business_id, store_id, expense_id, id)`
- `UNIQUE (business_id, store_id, id)`
- `FOREIGN KEY (business_id, store_id, product_id) REFERENCES mc.product_selection_items(business_id, store_id, product_id)`
- `PRIMARY KEY (id)`
- `FOREIGN KEY (business_id, store_id) REFERENCES mc.stores(business_id, id)`
- `UNIQUE (store_id, external_entry_key)`

## financial_categories

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| code | text | нет | — |
| name | text | нет | — |
| class | text | нет | — |
| is_promotion | boolean | нет | false |

Ограничения и связи:

- `CHECK ((class = ANY (ARRAY['income'::text, 'expense'::text, 'settlement'::text, 'informational'::text])))`
- `PRIMARY KEY (code)`

## financial_components

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| id | uuid | нет | gen_random_uuid() |
| business_id | uuid | нет | — |
| store_id | uuid | нет | — |
| operation_version_id | uuid | нет | — |
| component_key | text | нет | — |
| category_code | text | нет | — |
| amount_signed | numeric | нет | — |
| method_version_id | uuid | нет | — |
| source_field | text | да | — |
| created_at | timestamp with time zone | нет | now() |
| result_scope_classification | text | нет | 'unclassified'::text |

Ограничения и связи:

- `UNIQUE (business_id, store_id, id)`
- `FOREIGN KEY (business_id, store_id, operation_version_id) REFERENCES mc.operation_versions(business_id, store_id, id)`
- `FOREIGN KEY (category_code) REFERENCES mc.financial_categories(code)`
- `FOREIGN KEY (method_version_id) REFERENCES mc.method_versions(id)`
- `UNIQUE (operation_version_id, method_version_id, component_key)`
- `PRIMARY KEY (id)`
- `CHECK ((result_scope_classification = ANY (ARRAY['selected_product'::text, 'store'::text, 'product_expected'::text, 'unclassified'::text, 'reconciliation'::text])))`

## financial_credential_backfill_targets

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| connection_id | uuid | нет | — |
| business_id | uuid | нет | — |
| store_id | uuid | нет | — |
| requested_by | uuid | нет | — |
| attempt_count | integer | нет | 0 |
| next_attempt_at | timestamp with time zone | нет | now() |
| created_at | timestamp with time zone | нет | now() |

Ограничения и связи:

- `CHECK ((attempt_count >= 0))`
- `PRIMARY KEY (connection_id)`

## financial_daily_current_publications

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| business_id | uuid | нет | — |
| store_id | uuid | нет | — |
| publication_id | uuid | нет | — |
| updated_at | timestamp with time zone | нет | clock_timestamp() |

Ограничения и связи:

- `FOREIGN KEY (business_id, store_id, publication_id) REFERENCES mc.financial_daily_publications(business_id, store_id, id)`
- `UNIQUE (business_id, store_id, publication_id)`
- `FOREIGN KEY (business_id, store_id) REFERENCES mc.stores(business_id, id)`
- `PRIMARY KEY (business_id, store_id)`

## financial_daily_days

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| id | uuid | нет | gen_random_uuid() |
| business_id | uuid | нет | — |
| store_id | uuid | нет | — |
| generation_id | uuid | нет | — |
| accounting_date | date | нет | — |
| coverage_complete | boolean | нет | — |
| quality | text | нет | — |
| tax_usable | boolean | нет | — |
| store_profit_before_tax | numeric(20,4) | да | — |
| selected_profit_before_tax | numeric(20,4) | да | — |
| available_profit_before_tax | numeric(20,4) | да | — |
| created_at | timestamp with time zone | нет | clock_timestamp() |

Ограничения и связи:

- `CHECK (isfinite(accounting_date))`
- `FOREIGN KEY (business_id, store_id, generation_id) REFERENCES mc.financial_daily_generations(business_id, store_id, id)`
- `UNIQUE (business_id, store_id, id)`
- `CHECK ((coverage_complete OR (quality <> 'complete'::text)))`
- `UNIQUE (generation_id, accounting_date)`
- `PRIMARY KEY (id)`
- `CHECK ((quality = ANY (ARRAY['complete'::text, 'partial'::text, 'unavailable'::text])))`
- `UNIQUE (business_id, store_id, generation_id, accounting_date)`

## financial_daily_evidence

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| id | uuid | нет | gen_random_uuid() |
| business_id | uuid | нет | — |
| store_id | uuid | нет | — |
| generation_id | uuid | нет | — |
| daily_result_id | uuid | нет | — |
| financial_component_id | uuid | да | — |
| cost_version_id | uuid | да | — |
| expense_version_id | uuid | да | — |
| tax_computation_id | uuid | да | — |
| report_row_id | uuid | да | — |
| source_operation_version_id | uuid | да | — |
| operation_link_id | uuid | да | — |
| quantity | numeric(20,6) | да | — |
| contribution_amount | numeric(20,4) | нет | — |
| created_at | timestamp with time zone | нет | clock_timestamp() |

Ограничения и связи:

- `FOREIGN KEY (business_id, store_id, cost_version_id) REFERENCES mc.cost_versions(business_id, store_id, id)`
- `FOREIGN KEY (business_id, store_id, expense_version_id) REFERENCES mc.expense_versions(business_id, store_id, id)`
- `FOREIGN KEY (business_id, store_id, financial_component_id) REFERENCES mc.financial_components(business_id, store_id, id)`
- `FOREIGN KEY (business_id, store_id, generation_id, daily_result_id) REFERENCES mc.financial_daily_results(business_id, store_id, generation_id, id)`
- `FOREIGN KEY (business_id, store_id, generation_id) REFERENCES mc.financial_daily_generations(business_id, store_id, id)`
- `UNIQUE (business_id, store_id, id)`
- `FOREIGN KEY (business_id, store_id, operation_link_id) REFERENCES mc.operation_links(business_id, store_id, id)`
- `FOREIGN KEY (business_id, store_id, report_row_id) REFERENCES mc.report_rows(business_id, store_id, id)`
- `FOREIGN KEY (business_id, store_id, source_operation_version_id) REFERENCES mc.operation_versions(business_id, store_id, id)`
- `FOREIGN KEY (business_id, store_id, tax_computation_id) REFERENCES mc.tax_computations(business_id, store_id, id)`
- `CHECK ((num_nonnulls(financial_component_id, cost_version_id, expense_version_id, tax_computation_id, report_row_id) = 1))`
- `PRIMARY KEY (id)`
- `CHECK ((((cost_version_id IS NULL) AND (report_row_id IS NULL) AND (source_operation_version_id IS NULL) AND (operation_link_id IS NULL) AND (quantity IS NULL)) OR ((cost_version_id IS NOT NULL) AND (report_row_id IS NULL) AND (source_operation_version_id IS NOT NULL) AND (quantity IS NOT NULL)) OR ((report_row_id IS NOT NULL) AND (cost_version_id IS NULL) AND (source_operation_version_id IS NOT NULL) AND (quantity IS NULL))))`

## financial_daily_generation_inputs

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| id | uuid | нет | gen_random_uuid() |
| business_id | uuid | нет | — |
| store_id | uuid | нет | — |
| generation_id | uuid | нет | — |
| source_kind | text | нет | — |
| report_version_id | uuid | да | — |
| report_normalization_id | uuid | да | — |
| cost_version_id | uuid | да | — |
| expense_version_id | uuid | да | — |
| tax_setting_version_id | uuid | да | — |
| selection_id | uuid | да | — |
| created_at | timestamp with time zone | нет | clock_timestamp() |
| financial_week_coverage_id | uuid | да | — |
| empty_confirmation_job_id | uuid | да | — |

Ограничения и связи:

- `FOREIGN KEY (business_id, store_id, report_normalization_id) REFERENCES mc.report_normalizations(business_id, store_id, id)`
- `FOREIGN KEY (business_id, store_id, report_version_id, report_normalization_id) REFERENCES mc.report_normalizations(business_id, store_id, report_version_id, id)`
- `FOREIGN KEY (business_id, store_id, cost_version_id) REFERENCES mc.cost_versions(business_id, store_id, id)`
- `FOREIGN KEY (business_id, store_id, expense_version_id) REFERENCES mc.expense_versions(business_id, store_id, id)`
- `FOREIGN KEY (business_id, store_id, generation_id) REFERENCES mc.financial_daily_generations(business_id, store_id, id)`
- `FOREIGN KEY (business_id, store_id, report_version_id) REFERENCES mc.report_versions(business_id, store_id, id)`
- `FOREIGN KEY (business_id, store_id, selection_id) REFERENCES mc.product_selections(business_id, store_id, id)`
- `FOREIGN KEY (business_id, tax_setting_version_id) REFERENCES mc.tax_setting_versions(business_id, id)`
- `UNIQUE (business_id, store_id, id)`
- `CHECK ((((source_kind = 'report'::text) AND (report_version_id IS NOT NULL) AND (report_normalization_id IS NOT NULL) AND (num_nonnulls(cost_version_id, expense_version_id, tax_setting_version_id, selection_id, financial_week_coverage_id, empty_confirmation_job_id) = 0)) OR ((source_kind = 'empty_week'::text) AND (financial_week_coverage_id IS NOT NULL) AND (empty_confirmation_job_id IS NOT NULL) AND (num_nonnulls(report_version_id, report_normalization_id, cost_version_id, expense_version_id, tax_setting_version_id, selection_id) = 0)) OR ((source_kind = 'cost'::text) AND (cost_version_id IS NOT NULL) AND (num_nonnulls(report_version_id, report_normalization_id, expense_version_id, tax_setting_version_id, selection_id, financial_week_coverage_id, empty_confirmation_job_id) = 0)) OR ((source_kind = 'expense'::text) AND (expense_version_id IS NOT NULL) AND (num_nonnulls(report_version_id, report_normalization_id, cost_version_id, tax_setting_version_id, selection_id, financial_week_coverage_id, empty_confirmation_job_id) = 0)) OR ((source_kind = 'tax'::text) AND (tax_setting_version_id IS NOT NULL) AND (num_nonnulls(report_version_id, report_normalization_id, cost_version_id, expense_version_id, selection_id, financial_week_coverage_id, empty_confirmation_job_id) = 0)) OR ((source_kind = 'selection'::text) AND (selection_id IS NOT NULL) AND (num_nonnulls(report_version_id, report_normalization_id, cost_version_id, expense_version_id, tax_setting_version_id, financial_week_coverage_id, empty_confirmation_job_id) = 0))))`
- `FOREIGN KEY (business_id, store_id, financial_week_coverage_id) REFERENCES mc.financial_week_coverage(business_id, store_id, id)`
- `FOREIGN KEY (business_id, store_id, empty_confirmation_job_id) REFERENCES mc.jobs(business_id, store_id, id)`
- `PRIMARY KEY (id)`
- `CHECK ((source_kind = ANY (ARRAY['report'::text, 'empty_week'::text, 'cost'::text, 'expense'::text, 'tax'::text, 'selection'::text])))`
- `UNIQUE NULLS NOT DISTINCT (generation_id, source_kind, report_version_id, report_normalization_id, cost_version_id, expense_version_id, tax_setting_version_id, selection_id, financial_week_coverage_id, empty_confirmation_job_id)`

## financial_daily_generation_products

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| id | uuid | нет | gen_random_uuid() |
| business_id | uuid | нет | — |
| store_id | uuid | нет | — |
| generation_id | uuid | нет | — |
| product_id | uuid | нет | — |
| variant_id | uuid | да | — |
| selected | boolean | нет | — |
| created_at | timestamp with time zone | нет | clock_timestamp() |

Ограничения и связи:

- `FOREIGN KEY (business_id, store_id, product_id, variant_id) REFERENCES mc.variants(business_id, store_id, product_id, id)`
- `FOREIGN KEY (business_id, store_id, generation_id) REFERENCES mc.financial_daily_generations(business_id, store_id, id)`
- `FOREIGN KEY (business_id, store_id, product_id) REFERENCES mc.products(business_id, store_id, id)`
- `UNIQUE NULLS NOT DISTINCT (generation_id, product_id, variant_id)`
- `UNIQUE (business_id, store_id, id)`
- `PRIMARY KEY (id)`

## financial_daily_generations

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| id | uuid | нет | gen_random_uuid() |
| business_id | uuid | нет | — |
| store_id | uuid | нет | — |
| generation_no | bigint | нет | — |
| source_event_generation | bigint | нет | — |
| watermark_generation | bigint | нет | — |
| job_id | uuid | нет | — |
| affected_from | date | нет | — |
| affected_to | date | нет | — |
| parser_method_version_id | uuid | нет | — |
| result_method_version_id | uuid | нет | — |
| frozen_input_fingerprint | text | нет | — |
| status | text | нет | 'building'::text |
| quality | text | нет | 'unavailable'::text |
| failure_code | text | да | — |
| created_at | timestamp with time zone | нет | clock_timestamp() |
| finished_at | timestamp with time zone | да | — |

Ограничения и связи:

- `FOREIGN KEY (business_id, store_id, job_id) REFERENCES mc.jobs(business_id, store_id, id)`
- `CHECK (isfinite(affected_from))`
- `CHECK (isfinite(affected_to))`
- `FOREIGN KEY (business_id, store_id) REFERENCES mc.stores(business_id, id)`
- `UNIQUE (business_id, store_id, generation_no)`
- `UNIQUE (business_id, store_id, id)`
- `CHECK ((watermark_generation >= source_event_generation))`
- `CHECK ((affected_to >= affected_from))`
- `CHECK ((((status = 'building'::text) AND (finished_at IS NULL) AND (failure_code IS NULL)) OR ((status = 'succeeded'::text) AND (finished_at IS NOT NULL) AND (failure_code IS NULL)) OR ((status = ANY (ARRAY['failed'::text, 'superseded'::text])) AND (finished_at IS NOT NULL) AND (failure_code IS NOT NULL))))`
- `CHECK (((failure_code IS NULL) OR (failure_code ~ '^[a-z0-9][a-z0-9_.:-]{0,99}$'::text)))`
- `CHECK (((length(frozen_input_fingerprint) >= 1) AND (length(frozen_input_fingerprint) <= 200)))`
- `CHECK ((generation_no > 0))`
- `UNIQUE (job_id)`
- `FOREIGN KEY (parser_method_version_id) REFERENCES mc.method_versions(id)`
- `PRIMARY KEY (id)`
- `CHECK ((quality = ANY (ARRAY['complete'::text, 'partial'::text, 'unavailable'::text])))`
- `FOREIGN KEY (result_method_version_id) REFERENCES mc.method_versions(id)`
- `CHECK ((source_event_generation > 0))`
- `CHECK ((status = ANY (ARRAY['building'::text, 'succeeded'::text, 'failed'::text, 'superseded'::text])))`

## financial_daily_publication_days

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| id | uuid | нет | gen_random_uuid() |
| business_id | uuid | нет | — |
| store_id | uuid | нет | — |
| publication_id | uuid | нет | — |
| accounting_date | date | нет | — |
| generation_id | uuid | нет | — |
| created_at | timestamp with time zone | нет | clock_timestamp() |

Ограничения и связи:

- `FOREIGN KEY (business_id, store_id, generation_id, accounting_date) REFERENCES mc.financial_daily_days(business_id, store_id, generation_id, accounting_date)`
- `FOREIGN KEY (business_id, store_id, publication_id) REFERENCES mc.financial_daily_publications(business_id, store_id, id)`
- `UNIQUE (publication_id, accounting_date)`
- `CHECK (isfinite(accounting_date))`
- `UNIQUE (business_id, store_id, id)`
- `PRIMARY KEY (id)`

## financial_daily_publications

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| id | uuid | нет | gen_random_uuid() |
| business_id | uuid | нет | — |
| store_id | uuid | нет | — |
| publication_no | bigint | нет | — |
| generation_id | uuid | нет | — |
| prior_publication_id | uuid | да | — |
| affected_from | date | нет | — |
| affected_to | date | нет | — |
| source_event_generation | bigint | нет | — |
| watermark_generation | bigint | нет | — |
| created_at | timestamp with time zone | нет | clock_timestamp() |

Ограничения и связи:

- `CHECK (isfinite(affected_from))`
- `CHECK (isfinite(affected_to))`
- `FOREIGN KEY (business_id, store_id) REFERENCES mc.stores(business_id, id)`
- `FOREIGN KEY (business_id, store_id, generation_id) REFERENCES mc.financial_daily_generations(business_id, store_id, id)`
- `UNIQUE (business_id, store_id, id)`
- `FOREIGN KEY (business_id, store_id, prior_publication_id) REFERENCES mc.financial_daily_publications(business_id, store_id, id)`
- `UNIQUE (business_id, store_id, publication_no)`
- `CHECK ((watermark_generation >= source_event_generation))`
- `CHECK ((affected_to >= affected_from))`
- `CHECK ((((publication_no = 1) AND (prior_publication_id IS NULL)) OR ((publication_no > 1) AND (prior_publication_id IS NOT NULL))))`
- `UNIQUE (generation_id)`
- `PRIMARY KEY (id)`
- `CHECK ((publication_no > 0))`
- `CHECK ((source_event_generation > 0))`

## financial_daily_reasons

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| id | uuid | нет | gen_random_uuid() |
| business_id | uuid | нет | — |
| store_id | uuid | нет | — |
| generation_id | uuid | нет | — |
| accounting_date | date | нет | — |
| reason_code | text | нет | — |
| scope | text | нет | — |
| product_id | uuid | да | — |
| variant_id | uuid | да | — |
| severity | text | нет | — |
| details | jsonb | нет | '{}'::jsonb |
| created_at | timestamp with time zone | нет | clock_timestamp() |

Ограничения и связи:

- `CHECK (isfinite(accounting_date))`
- `FOREIGN KEY (business_id, store_id, generation_id) REFERENCES mc.financial_daily_generations(business_id, store_id, id)`
- `UNIQUE (business_id, store_id, id)`
- `FOREIGN KEY (business_id, store_id, product_id) REFERENCES mc.products(business_id, store_id, id)`
- `FOREIGN KEY (business_id, store_id, product_id, variant_id) REFERENCES mc.variants(business_id, store_id, product_id, id)`
- `CHECK ((((scope = ANY (ARRAY['store'::text, 'selected_products'::text])) AND (product_id IS NULL) AND (variant_id IS NULL)) OR ((scope = 'product'::text) AND (product_id IS NOT NULL) AND (variant_id IS NULL)) OR ((scope = 'variant'::text) AND (product_id IS NOT NULL) AND (variant_id IS NOT NULL))))`
- `UNIQUE NULLS NOT DISTINCT (generation_id, accounting_date, reason_code, scope, product_id, variant_id)`
- `PRIMARY KEY (id)`
- `CHECK ((reason_code ~ '^[a-z0-9][a-z0-9_.:-]{0,99}$'::text))`
- `CHECK ((scope = ANY (ARRAY['store'::text, 'selected_products'::text, 'product'::text, 'variant'::text])))`
- `CHECK ((severity = ANY (ARRAY['partial'::text, 'unavailable'::text])))`

## financial_daily_results

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| id | uuid | нет | gen_random_uuid() |
| business_id | uuid | нет | — |
| store_id | uuid | нет | — |
| generation_id | uuid | нет | — |
| accounting_date | date | нет | — |
| category_code | text | нет | — |
| scope | text | нет | — |
| product_id | uuid | да | — |
| variant_id | uuid | да | — |
| amount_signed | numeric(20,4) | нет | — |
| tax_base_unrounded | numeric(30,12) | да | — |
| tax_numerator_unrounded | numeric(30,12) | да | — |
| quality | text | нет | — |
| created_at | timestamp with time zone | нет | clock_timestamp() |

Ограничения и связи:

- `CHECK (isfinite(accounting_date))`
- `UNIQUE (business_id, store_id, generation_id, id)`
- `FOREIGN KEY (business_id, store_id, generation_id) REFERENCES mc.financial_daily_generations(business_id, store_id, id)`
- `UNIQUE (business_id, store_id, id)`
- `FOREIGN KEY (business_id, store_id, product_id) REFERENCES mc.products(business_id, store_id, id)`
- `FOREIGN KEY (business_id, store_id, product_id, variant_id) REFERENCES mc.variants(business_id, store_id, product_id, id)`
- `FOREIGN KEY (category_code) REFERENCES mc.financial_categories(code)`
- `CHECK ((((scope = 'store'::text) AND (product_id IS NULL) AND (variant_id IS NULL)) OR ((scope = 'selected_products'::text) AND (product_id IS NOT NULL))))`
- `CHECK (((variant_id IS NULL) OR (product_id IS NOT NULL)))`
- `UNIQUE NULLS NOT DISTINCT (generation_id, accounting_date, category_code, scope, product_id, variant_id)`
- `PRIMARY KEY (id)`
- `CHECK ((quality = ANY (ARRAY['complete'::text, 'partial'::text, 'unavailable'::text])))`
- `CHECK ((scope = ANY (ARRAY['store'::text, 'selected_products'::text])))`

## financial_daily_shadow_comparisons

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| id | uuid | нет | gen_random_uuid() |
| business_id | uuid | нет | — |
| store_id | uuid | нет | — |
| generation_id | uuid | нет | — |
| publication_id | uuid | нет | — |
| period_result_id | uuid | нет | — |
| legacy_run_id | uuid | нет | — |
| period_start | date | нет | — |
| period_end | date | нет | — |
| status | text | нет | — |
| compared_metrics | jsonb | нет | '{}'::jsonb |
| difference_details | jsonb | нет | '{}'::jsonb |
| created_at | timestamp with time zone | нет | clock_timestamp() |

Ограничения и связи:

- `FOREIGN KEY (business_id, store_id, generation_id) REFERENCES mc.financial_daily_generations(business_id, store_id, id)`
- `FOREIGN KEY (business_id, store_id, legacy_run_id) REFERENCES mc.calculation_runs(business_id, store_id, id)`
- `FOREIGN KEY (business_id, store_id, period_result_id) REFERENCES mc.financial_period_results(business_id, store_id, id)`
- `FOREIGN KEY (business_id, store_id, publication_id) REFERENCES mc.publications(business_id, store_id, id)`
- `UNIQUE (generation_id, publication_id, period_result_id)`
- `UNIQUE (business_id, store_id, id)`
- `CHECK ((period_end >= period_start))`
- `CHECK (isfinite(period_end))`
- `CHECK (isfinite(period_start))`
- `PRIMARY KEY (id)`
- `CHECK ((status = ANY (ARRAY['matched'::text, 'mismatch'::text, 'not_comparable'::text])))`

## financial_daily_tax_evidence

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| id | uuid | нет | gen_random_uuid() |
| business_id | uuid | нет | — |
| store_id | uuid | нет | — |
| generation_id | uuid | нет | — |
| tax_fact_id | uuid | нет | — |
| financial_component_id | uuid | нет | — |
| contribution_amount | numeric(30,12) | нет | — |
| created_at | timestamp with time zone | нет | clock_timestamp() |

Ограничения и связи:

- `FOREIGN KEY (business_id, store_id, financial_component_id) REFERENCES mc.financial_components(business_id, store_id, id)`
- `FOREIGN KEY (business_id, store_id, generation_id, tax_fact_id) REFERENCES mc.financial_daily_tax_facts(business_id, store_id, generation_id, id)`
- `UNIQUE (business_id, store_id, id)`
- `PRIMARY KEY (id)`
- `UNIQUE (tax_fact_id, financial_component_id)`

## financial_daily_tax_facts

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| id | uuid | нет | gen_random_uuid() |
| business_id | uuid | нет | — |
| store_id | uuid | нет | — |
| generation_id | uuid | нет | — |
| accounting_date | date | нет | — |
| product_id | uuid | нет | — |
| tax_setting_version_id | uuid | нет | — |
| tax_base_unrounded | numeric(30,12) | нет | — |
| tax_numerator_unrounded | numeric(30,12) | нет | — |
| tax_rate_fraction | numeric(20,10) | да | — |
| tax_amount_rounded | numeric(20,4) | да | — |
| created_at | timestamp with time zone | нет | clock_timestamp() |

Ограничения и связи:

- `CHECK (isfinite(accounting_date))`
- `FOREIGN KEY (business_id, store_id, generation_id) REFERENCES mc.financial_daily_generations(business_id, store_id, id)`
- `UNIQUE (business_id, store_id, generation_id, id)`
- `UNIQUE (business_id, store_id, id)`
- `FOREIGN KEY (business_id, store_id, product_id) REFERENCES mc.products(business_id, store_id, id)`
- `FOREIGN KEY (business_id, tax_setting_version_id) REFERENCES mc.tax_setting_versions(business_id, id)`
- `UNIQUE (generation_id, accounting_date, product_id, tax_setting_version_id)`
- `PRIMARY KEY (id)`
- `CHECK (((tax_rate_fraction IS NULL) OR ((tax_rate_fraction >= (0)::numeric) AND (tax_rate_fraction <= (1)::numeric))))`

## financial_input_events

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| id | uuid | нет | gen_random_uuid() |
| business_id | uuid | нет | — |
| store_id | uuid | нет | — |
| event_generation | bigint | нет | — |
| event_key | text | нет | — |
| event_type | text | нет | — |
| affected_from | date | нет | — |
| affected_to | date | нет | — |
| source_report_version_id | uuid | да | — |
| source_normalization_id | uuid | да | — |
| allows_wb_api | boolean | нет | false |
| dispatch_job_id | uuid | нет | — |
| created_at | timestamp with time zone | нет | now() |
| actor_user_id | uuid | нет | mc.context_user_id() |
| source_cost_version_id | uuid | да | — |
| source_expense_version_id | uuid | да | — |
| source_tax_setting_version_id | uuid | да | — |
| source_selection_id | uuid | да | — |
| source_parser_method_version_id | uuid | да | — |
| source_result_method_version_id | uuid | да | — |
| source_financial_week_coverage_id | uuid | да | — |
| source_empty_confirmation_job_id | uuid | да | — |

Ограничения и связи:

- `FOREIGN KEY (actor_user_id) REFERENCES mc.users(id)`
- `CHECK ((allows_wb_api = false))`
- `UNIQUE (business_id, event_key)`
- `UNIQUE (business_id, store_id, event_generation)`
- `FOREIGN KEY (business_id, store_id) REFERENCES mc.stores(business_id, id)`
- `UNIQUE (business_id, store_id, id)`
- `FOREIGN KEY (business_id, store_id, source_normalization_id) REFERENCES mc.report_normalizations(business_id, store_id, id)`
- `FOREIGN KEY (business_id, store_id, source_report_version_id) REFERENCES mc.report_versions(business_id, store_id, id)`
- `CHECK ((affected_to >= affected_from))`
- `FOREIGN KEY (business_id, store_id, source_cost_version_id) REFERENCES mc.cost_versions(business_id, store_id, id)`
- `FOREIGN KEY (dispatch_job_id) REFERENCES mc.jobs(id)`
- `FOREIGN KEY (business_id, store_id, source_financial_week_coverage_id) REFERENCES mc.financial_week_coverage(business_id, store_id, id)`
- `FOREIGN KEY (business_id, store_id, source_empty_confirmation_job_id) REFERENCES mc.jobs(business_id, store_id, id)`
- `CHECK ((event_generation > 0))`
- `CHECK (((length(event_key) >= 1) AND (length(event_key) <= 200)))`
- `CHECK ((event_type = ANY (ARRAY['report_accepted'::text, 'report_updated'::text, 'report_empty_confirmed'::text, 'cost_updated'::text, 'expense_updated'::text, 'tax_updated'::text, 'selection_updated'::text, 'parser_method_updated'::text, 'result_method_updated'::text, 'shadow_backfill'::text])))`
- `FOREIGN KEY (business_id, store_id, source_expense_version_id) REFERENCES mc.expense_versions(business_id, store_id, id)`
- `PRIMARY KEY (id)`
- `FOREIGN KEY (business_id, store_id, source_report_version_id, source_normalization_id) REFERENCES mc.report_normalizations(business_id, store_id, report_version_id, id)`
- `FOREIGN KEY (business_id, store_id, source_selection_id) REFERENCES mc.product_selections(business_id, store_id, id)`
- `FOREIGN KEY (source_parser_method_version_id) REFERENCES mc.method_versions(id)`
- `FOREIGN KEY (source_result_method_version_id) REFERENCES mc.method_versions(id)`
- `CHECK ((((event_type = ANY (ARRAY['report_accepted'::text, 'report_updated'::text])) AND (source_report_version_id IS NOT NULL) AND (source_normalization_id IS NOT NULL) AND (num_nonnulls(source_cost_version_id, source_expense_version_id, source_tax_setting_version_id, source_selection_id, source_parser_method_version_id, source_result_method_version_id, source_financial_week_coverage_id, source_empty_confirmation_job_id) = 0)) OR ((event_type = 'report_empty_confirmed'::text) AND (source_financial_week_coverage_id IS NOT NULL) AND (source_empty_confirmation_job_id IS NOT NULL) AND (num_nonnulls(source_report_version_id, source_normalization_id, source_cost_version_id, source_expense_version_id, source_tax_setting_version_id, source_selection_id, source_parser_method_version_id, source_result_method_version_id) = 0)) OR ((event_type = 'cost_updated'::text) AND (source_cost_version_id IS NOT NULL) AND (num_nonnulls(source_report_version_id, source_normalization_id, source_expense_version_id, source_tax_setting_version_id, source_selection_id, source_parser_method_version_id, source_result_method_version_id, source_financial_week_coverage_id, source_empty_confirmation_job_id) = 0)) OR ((event_type = 'expense_updated'::text) AND (source_expense_version_id IS NOT NULL) AND (num_nonnulls(source_report_version_id, source_normalization_id, source_cost_version_id, source_tax_setting_version_id, source_selection_id, source_parser_method_version_id, source_result_method_version_id, source_financial_week_coverage_id, source_empty_confirmation_job_id) = 0)) OR ((event_type = 'tax_updated'::text) AND (source_tax_setting_version_id IS NOT NULL) AND (num_nonnulls(source_report_version_id, source_normalization_id, source_cost_version_id, source_expense_version_id, source_selection_id, source_parser_method_version_id, source_result_method_version_id, source_financial_week_coverage_id, source_empty_confirmation_job_id) = 0)) OR ((event_type = 'selection_updated'::text) AND (source_selection_id IS NOT NULL) AND (num_nonnulls(source_report_version_id, source_normalization_id, source_cost_version_id, source_expense_version_id, source_tax_setting_version_id, source_parser_method_version_id, source_result_method_version_id, source_financial_week_coverage_id, source_empty_confirmation_job_id) = 0)) OR ((event_type = 'parser_method_updated'::text) AND (source_parser_method_version_id IS NOT NULL) AND (num_nonnulls(source_report_version_id, source_normalization_id, source_cost_version_id, source_expense_version_id, source_tax_setting_version_id, source_selection_id, source_result_method_version_id, source_financial_week_coverage_id, source_empty_confirmation_job_id) = 0)) OR ((event_type = ANY (ARRAY['result_method_updated'::text, 'shadow_backfill'::text])) AND (source_result_method_version_id IS NOT NULL) AND (num_nonnulls(source_report_version_id, source_normalization_id, source_cost_version_id, source_expense_version_id, source_tax_setting_version_id, source_selection_id, source_parser_method_version_id, source_financial_week_coverage_id, source_empty_confirmation_job_id) = 0))))`
- `FOREIGN KEY (business_id, source_tax_setting_version_id) REFERENCES mc.tax_setting_versions(business_id, id)`

## financial_period_results

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| id | uuid | нет | gen_random_uuid() |
| business_id | uuid | нет | — |
| store_id | uuid | нет | — |
| run_id | uuid | нет | — |
| period_start | date | нет | — |
| period_end | date | нет | — |
| quality | text | нет | — |
| missing_reasons | jsonb | нет | '[]'::jsonb |
| totals | jsonb | да | — |
| created_at | timestamp with time zone | нет | now() |

Ограничения и связи:

- `UNIQUE (business_id, store_id, id)`
- `FOREIGN KEY (business_id, store_id, run_id) REFERENCES mc.calculation_runs(business_id, store_id, id)`
- `CHECK ((period_end >= period_start))`
- `CHECK ((jsonb_typeof(missing_reasons) = 'array'::text))`
- `CHECK (isfinite(period_end))`
- `CHECK (isfinite(period_start))`
- `PRIMARY KEY (id)`
- `CHECK ((quality = ANY (ARRAY['complete'::text, 'partial'::text, 'unavailable'::text])))`
- `UNIQUE (run_id, period_start, period_end)`
- `CHECK (((totals IS NULL) OR (jsonb_typeof(totals) = 'object'::text)))`

## financial_report_capabilities

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| business_id | uuid | нет | — |
| connection_id | uuid | нет | — |
| credential_generation | bigint | нет | — |
| list_api | text | нет | 'unknown'::text |
| detail_by_id_api | text | нет | 'unknown'::text |
| fallback_mode | text | да | — |
| reason_code | text | да | — |
| observed_at | timestamp with time zone | да | — |

Ограничения и связи:

- `FOREIGN KEY (business_id, connection_id) REFERENCES mc.connections(business_id, id) ON DELETE CASCADE`
- `CHECK ((credential_generation > 0))`
- `CHECK ((detail_by_id_api = ANY (ARRAY['unknown'::text, 'supported'::text, 'unsupported_country'::text])))`
- `CHECK (((fallback_mode IS NULL) OR (fallback_mode = 'period'::text)))`
- `CHECK ((list_api = ANY (ARRAY['unknown'::text, 'supported'::text, 'unsupported_country'::text])))`
- `PRIMARY KEY (business_id, connection_id, credential_generation)`
- `CHECK (((reason_code IS NULL) OR (reason_code ~ '^[a-z0-9][a-z0-9_.:-]{0,99}$'::text)))`

## financial_report_summary_versions

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| id | uuid | нет | gen_random_uuid() |
| business_id | uuid | нет | — |
| store_id | uuid | нет | — |
| report_version_id | uuid | нет | — |
| sync_run_id | uuid | нет | — |
| checksum | text | нет | — |
| raw_data | jsonb | нет | — |
| created_at | timestamp with time zone | нет | now() |

Ограничения и связи:

- `FOREIGN KEY (business_id, store_id, report_version_id) REFERENCES mc.report_versions(business_id, store_id, id)`
- `FOREIGN KEY (business_id, store_id, sync_run_id) REFERENCES mc.sync_runs(business_id, store_id, id)`
- `UNIQUE (report_version_id, checksum)`
- `PRIMARY KEY (id)`

## financial_schedule_targets

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| store_id | uuid | нет | — |
| business_id | uuid | нет | — |
| requested_by | uuid | нет | — |
| credential_generation | bigint | нет | — |
| store_status | text | нет | — |
| connection_status | text | нет | — |
| finance_enabled | boolean | нет | — |
| last_schedule_boundary | date | нет | — |
| updated_at | timestamp with time zone | нет | now() |

Ограничения и связи:

- `FOREIGN KEY (business_id, store_id) REFERENCES mc.stores(business_id, id)`
- `CHECK ((connection_status = ANY (ARRAY['pending'::text, 'active'::text, 'invalid'::text, 'revoked'::text])))`
- `CHECK ((credential_generation > 0))`
- `PRIMARY KEY (store_id)`
- `CHECK ((store_status = ANY (ARRAY['active'::text, 'paused'::text, 'archived'::text])))`

## financial_store_event_state

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| business_id | uuid | нет | — |
| store_id | uuid | нет | — |
| next_generation | bigint | нет | 1 |

Ограничения и связи:

- `FOREIGN KEY (business_id, store_id) REFERENCES mc.stores(business_id, id)`
- `CHECK ((next_generation > 0))`
- `PRIMARY KEY (business_id, store_id)`

## financial_week_coverage

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| id | uuid | нет | gen_random_uuid() |
| business_id | uuid | нет | — |
| store_id | uuid | нет | — |
| credential_generation | bigint | нет | — |
| week_start | date | нет | — |
| week_end | date | нет | — |
| check_reasons | ARRAY | нет | '{}'::text[] |
| coverage_status | text | нет | 'pending'::text |
| inventory_confirmed_at | timestamp with time zone | да | — |
| last_checked_at | timestamp with time zone | да | — |
| freshness_due_at | timestamp with time zone | да | — |
| next_retry_at | timestamp with time zone | да | — |
| last_error_code | text | да | — |
| created_at | timestamp with time zone | нет | now() |
| updated_at | timestamp with time zone | нет | now() |
| empty_confirmed_by_job_id | uuid | да | — |

Ограничения и связи:

- `UNIQUE (business_id, store_id, credential_generation, week_start)`
- `FOREIGN KEY (business_id, store_id) REFERENCES mc.stores(business_id, id)`
- `CHECK (((EXTRACT(isodow FROM week_start) = (1)::numeric) AND (week_end = (week_start + 6))))`
- `CHECK ((cardinality(check_reasons) > 0))`
- `CHECK ((coverage_status = ANY (ARRAY['pending'::text, 'inventory_confirmed'::text, 'fetching'::text, 'complete'::text, 'empty'::text, 'partial'::text, 'retry'::text, 'unavailable'::text])))`
- `CHECK ((credential_generation > 0))`
- `FOREIGN KEY (empty_confirmed_by_job_id) REFERENCES mc.jobs(id) ON DELETE RESTRICT`
- `CHECK (((coverage_status <> 'empty'::text) OR ((inventory_confirmed_at IS NOT NULL) AND (empty_confirmed_by_job_id IS NOT NULL))))`
- `FOREIGN KEY (business_id, store_id, empty_confirmed_by_job_id) REFERENCES mc.jobs(business_id, store_id, id)`
- `CHECK (((last_error_code IS NULL) OR (last_error_code ~ '^[a-z0-9][a-z0-9_.:-]{0,99}$'::text)))`
- `PRIMARY KEY (id)`
- `UNIQUE (business_id, store_id, id)`

## financial_week_inventory

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| id | uuid | нет | gen_random_uuid() |
| business_id | uuid | нет | — |
| store_id | uuid | нет | — |
| coverage_id | uuid | нет | — |
| external_report_id | text | нет | — |
| inventory_checksum | text | нет | — |
| report_type | text | да | — |
| country | text | да | — |
| period_start | date | нет | — |
| period_end | date | нет | — |
| fetch_status | text | нет | 'pending'::text |
| first_seen_at | timestamp with time zone | нет | now() |
| last_seen_at | timestamp with time zone | нет | now() |
| summary_raw_data | jsonb | да | — |
| report_version_id | uuid | да | — |
| accepted_normalization_id | uuid | да | — |
| accepted_inventory_checksum | text | да | — |
| accepted_at | timestamp with time zone | да | — |
| last_error_code | text | да | — |

Ограничения и связи:

- `CHECK (((fetch_status = 'accepted'::text) = ((report_version_id IS NOT NULL) AND (accepted_normalization_id IS NOT NULL) AND (accepted_inventory_checksum = inventory_checksum) AND (accepted_at IS NOT NULL))))`
- `FOREIGN KEY (business_id, store_id) REFERENCES mc.stores(business_id, id)`
- `UNIQUE (business_id, store_id, id)`
- `CHECK ((period_end >= period_start))`
- `UNIQUE (coverage_id, external_report_id)`
- `FOREIGN KEY (coverage_id) REFERENCES mc.financial_week_coverage(id) ON DELETE CASCADE`
- `CHECK (((last_error_code IS NULL) OR (last_error_code ~ '^[a-z0-9][a-z0-9_.:-]{0,99}$'::text)))`
- `CHECK ((external_report_id ~ '^[0-9]+$'::text))`
- `CHECK ((fetch_status = ANY (ARRAY['pending'::text, 'fetching'::text, 'received'::text, 'normalizing'::text, 'accepted'::text, 'retry'::text, 'failed'::text])))`
- `CHECK ((inventory_checksum ~ '^[0-9a-f]{64}$'::text))`
- `FOREIGN KEY (business_id, store_id, accepted_normalization_id) REFERENCES mc.report_normalizations(business_id, store_id, id)`
- `FOREIGN KEY (business_id, store_id, report_version_id, accepted_normalization_id) REFERENCES mc.report_normalizations(business_id, store_id, report_version_id, id)`
- `PRIMARY KEY (id)`
- `FOREIGN KEY (business_id, store_id, report_version_id) REFERENCES mc.report_versions(business_id, store_id, id)`

## import_batches

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| id | uuid | нет | gen_random_uuid() |
| business_id | uuid | нет | — |
| store_id | uuid | нет | — |
| document_id | uuid | нет | — |
| kind | text | нет | — |
| uploaded_by | uuid | нет | — |
| status | text | нет | 'uploaded'::text |
| column_mapping | jsonb | нет | '{}'::jsonb |
| applied_at | timestamp with time zone | да | — |
| created_at | timestamp with time zone | нет | now() |

Ограничения и связи:

- `FOREIGN KEY (business_id, store_id, document_id) REFERENCES mc.source_documents(business_id, store_id, id)`
- `UNIQUE (business_id, store_id, id)`
- `UNIQUE (document_id, kind)`
- `CHECK ((kind = ANY (ARRAY['costs'::text, 'promotion_expenses'::text, 'expenses'::text])))`
- `PRIMARY KEY (id)`
- `CHECK ((status = ANY (ARRAY['uploaded'::text, 'validating'::text, 'ready'::text, 'applying'::text, 'completed'::text, 'failed'::text, 'cancelled'::text])))`
- `FOREIGN KEY (uploaded_by) REFERENCES mc.users(id)`

## import_rows

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| id | uuid | нет | gen_random_uuid() |
| business_id | uuid | нет | — |
| store_id | uuid | нет | — |
| batch_id | uuid | нет | — |
| row_number | integer | нет | — |
| raw_values | jsonb | нет | — |
| status | text | нет | 'valid'::text |
| errors | jsonb | нет | '[]'::jsonb |
| created_at | timestamp with time zone | нет | now() |

Ограничения и связи:

- `UNIQUE (batch_id, row_number)`
- `FOREIGN KEY (business_id, store_id, batch_id) REFERENCES mc.import_batches(business_id, store_id, id)`
- `UNIQUE (business_id, store_id, id)`
- `PRIMARY KEY (id)`
- `CHECK ((row_number > 0))`
- `CHECK ((status = ANY (ARRAY['valid'::text, 'invalid'::text, 'duplicate'::text, 'applied'::text, 'skipped'::text])))`

## job_dispatch

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| job_id | uuid | нет | — |
| business_id | uuid | нет | — |
| job_type | text | нет | — |
| priority | integer | нет | — |
| available_at | timestamp with time zone | нет | — |
| status | text | нет | — |
| attempt_count | integer | нет | — |
| max_attempts | integer | нет | — |
| lease_until | timestamp with time zone | да | — |
| created_at | timestamp with time zone | нет | — |
| recency_date | date | да | — |

Ограничения и связи:

- `CHECK ((attempt_count >= 0))`
- `FOREIGN KEY (business_id) REFERENCES mc.businesses(id)`
- `CHECK ((((status = 'pending'::text) AND (lease_until IS NULL)) OR ((status = 'running'::text) AND (lease_until IS NOT NULL))))`
- `FOREIGN KEY (job_id) REFERENCES mc.jobs(id) ON DELETE CASCADE`
- `CHECK ((max_attempts > 0))`
- `PRIMARY KEY (job_id)`
- `CHECK ((status = ANY (ARRAY['pending'::text, 'running'::text])))`

## jobs

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| id | uuid | нет | gen_random_uuid() |
| business_id | uuid | нет | — |
| store_id | uuid | да | — |
| job_type | text | нет | — |
| deduplication_key | text | нет | — |
| payload | jsonb | нет | '{}'::jsonb |
| status | text | нет | 'pending'::text |
| available_at | timestamp with time zone | нет | now() |
| attempt_count | integer | нет | 0 |
| max_attempts | integer | нет | 5 |
| lease_until | timestamp with time zone | да | — |
| worker_id | text | да | — |
| last_error | text | да | — |
| created_at | timestamp with time zone | нет | now() |
| priority | integer | нет | 0 |
| lease_token | uuid | да | — |
| heartbeat_at | timestamp with time zone | да | — |
| updated_at | timestamp with time zone | нет | now() |
| finished_at | timestamp with time zone | да | — |
| last_error_code | text | да | — |
| outcome | text | да | — |

Ограничения и связи:

- `CHECK ((attempt_count >= 0))`
- `FOREIGN KEY (business_id) REFERENCES mc.businesses(id)`
- `FOREIGN KEY (business_id, store_id) REFERENCES mc.stores(business_id, id)`
- `CHECK ((((status = 'pending'::text) AND (worker_id IS NULL) AND (lease_token IS NULL) AND (lease_until IS NULL) AND (heartbeat_at IS NULL) AND (finished_at IS NULL)) OR ((status = 'running'::text) AND (worker_id IS NOT NULL) AND (lease_token IS NOT NULL) AND (lease_until IS NOT NULL) AND (heartbeat_at IS NOT NULL) AND (finished_at IS NULL)) OR ((status = ANY (ARRAY['succeeded'::text, 'failed'::text])) AND (worker_id IS NULL) AND (lease_token IS NULL) AND (lease_until IS NULL) AND (heartbeat_at IS NULL) AND (finished_at IS NOT NULL))))`
- `CHECK ((max_attempts > 0))`
- `CHECK ((((status = 'succeeded'::text) AND (outcome = ANY (ARRAY['completed'::text, 'superseded'::text]))) OR ((status <> 'succeeded'::text) AND (outcome IS NULL))))`
- `PRIMARY KEY (id)`
- `CHECK (((priority >= '-1000'::integer) AND (priority <= 1000)))`
- `CHECK ((status = ANY (ARRAY['pending'::text, 'running'::text, 'succeeded'::text, 'failed'::text])))`
- `UNIQUE (business_id, store_id, id)`

## memberships

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| id | uuid | нет | gen_random_uuid() |
| business_id | uuid | нет | — |
| user_id | uuid | нет | — |
| role | text | нет | 'owner'::text |
| created_at | timestamp with time zone | нет | now() |

Ограничения и связи:

- `FOREIGN KEY (business_id) REFERENCES mc.businesses(id)`
- `UNIQUE (business_id, user_id)`
- `PRIMARY KEY (id)`
- `CHECK ((role = ANY (ARRAY['owner'::text, 'editor'::text, 'viewer'::text])))`
- `FOREIGN KEY (user_id) REFERENCES mc.users(id)`

## method_versions

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| id | uuid | нет | gen_random_uuid() |
| code | text | нет | — |
| version_no | integer | нет | — |
| description | text | нет | — |
| parameters | jsonb | нет | '{}'::jsonb |
| implementation_version | text | нет | — |
| created_at | timestamp with time zone | нет | now() |

Ограничения и связи:

- `UNIQUE (code, version_no)`
- `PRIMARY KEY (id)`
- `CHECK ((version_no > 0))`

## operation_links

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| id | uuid | нет | gen_random_uuid() |
| business_id | uuid | нет | — |
| store_id | uuid | нет | — |
| from_operation_version_id | uuid | нет | — |
| to_operation_version_id | uuid | нет | — |
| link_type | text | нет | — |
| status | text | нет | — |
| method_version_id | uuid | нет | — |
| evidence | jsonb | нет | '{}'::jsonb |
| created_at | timestamp with time zone | нет | now() |

Ограничения и связи:

- `FOREIGN KEY (business_id, store_id, from_operation_version_id) REFERENCES mc.operation_versions(business_id, store_id, id)`
- `UNIQUE (business_id, store_id, id)`
- `FOREIGN KEY (business_id, store_id, to_operation_version_id) REFERENCES mc.operation_versions(business_id, store_id, id)`
- `CHECK ((from_operation_version_id <> to_operation_version_id))`
- `UNIQUE (from_operation_version_id, link_type, method_version_id)`
- `CHECK ((link_type = 'return_to_original_sale'::text))`
- `FOREIGN KEY (method_version_id) REFERENCES mc.method_versions(id)`
- `PRIMARY KEY (id)`
- `CHECK ((status = ANY (ARRAY['confirmed'::text, 'rejected'::text, 'ambiguous'::text])))`

## operation_versions

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| id | uuid | нет | gen_random_uuid() |
| business_id | uuid | нет | — |
| store_id | uuid | нет | — |
| operation_id | uuid | нет | — |
| report_row_id | uuid | нет | — |
| version_no | integer | нет | — |
| srid | text | да | — |
| operation_type | text | нет | — |
| product_id | uuid | да | — |
| variant_id | uuid | да | — |
| accounting_date | date | нет | — |
| source_occurred_at | timestamp with time zone | да | — |
| quantity | numeric(20,6) | да | — |
| currency | text | нет | 'RUB'::text |
| state | text | нет | 'active'::text |
| created_at | timestamp with time zone | нет | now() |
| report_normalization_id | uuid | да | — |

Ограничения и связи:

- `FOREIGN KEY (business_id, store_id, report_normalization_id) REFERENCES mc.report_normalizations(business_id, store_id, id)`
- `UNIQUE (business_id, store_id, id)`
- `FOREIGN KEY (business_id, store_id, operation_id) REFERENCES mc.operations(business_id, store_id, id)`
- `FOREIGN KEY (business_id, store_id, product_id) REFERENCES mc.products(business_id, store_id, id)`
- `FOREIGN KEY (business_id, store_id, product_id, variant_id) REFERENCES mc.variants(business_id, store_id, product_id, id)`
- `FOREIGN KEY (business_id, store_id, report_row_id) REFERENCES mc.report_rows(business_id, store_id, id)`
- `CHECK (((variant_id IS NULL) OR (product_id IS NOT NULL)))`
- `CHECK ((currency = 'RUB'::text))`
- `UNIQUE (operation_id, version_no)`
- `CHECK ((operation_type = ANY (ARRAY['sale'::text, 'return'::text, 'service_charge'::text, 'adjustment'::text, 'settlement'::text, 'other'::text, 'unclassified'::text])))`
- `PRIMARY KEY (id)`
- `CHECK ((state = ANY (ARRAY['active'::text, 'withdrawn'::text])))`
- `CHECK ((version_no > 0))`

## operational_daily_metrics

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| id | uuid | нет | gen_random_uuid() |
| business_id | uuid | нет | — |
| store_id | uuid | нет | — |
| snapshot_id | uuid | нет | — |
| product_id | uuid | нет | — |
| metric_date | date | нет | — |
| currency | text | нет | — |
| order_count | bigint | нет | — |
| order_amount | numeric(20,4) | нет | — |
| buyout_count | bigint | нет | — |
| buyout_amount | numeric(20,4) | нет | — |
| row_checksum | text | нет | — |
| created_at | timestamp with time zone | нет | now() |
| cancel_count | bigint | да | — |
| cancel_amount | numeric(20,4) | да | — |

Ограничения и связи:

- `CHECK (((cancel_count IS NULL) = (cancel_amount IS NULL)))`
- `UNIQUE (business_id, store_id, id)`
- `FOREIGN KEY (business_id, store_id, snapshot_id, product_id) REFERENCES mc.operational_snapshot_products(business_id, store_id, snapshot_id, product_id)`
- `CHECK ((buyout_amount >= (0)::numeric))`
- `CHECK ((buyout_count >= 0))`
- `CHECK ((cancel_amount >= (0)::numeric))`
- `CHECK ((cancel_count >= 0))`
- `CHECK ((currency = 'RUB'::text))`
- `CHECK (isfinite(metric_date))`
- `CHECK ((order_amount >= (0)::numeric))`
- `CHECK ((order_count >= 0))`
- `PRIMARY KEY (id)`
- `CHECK ((row_checksum ~ '^[0-9a-f]{64}$'::text))`
- `UNIQUE (snapshot_id, product_id, metric_date)`

## operational_periods

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| id | uuid | нет | gen_random_uuid() |
| business_id | uuid | нет | — |
| store_id | uuid | нет | — |
| source_code | text | нет | 'wb_sales_funnel_v3'::text |
| period_start | date | нет | — |
| period_end | date | нет | — |
| current_snapshot_id | uuid | да | — |
| created_at | timestamp with time zone | нет | now() |

Ограничения и связи:

- `FOREIGN KEY (business_id, store_id, id, current_snapshot_id) REFERENCES mc.operational_snapshots(business_id, store_id, operational_period_id, id)`
- `FOREIGN KEY (business_id, store_id) REFERENCES mc.stores(business_id, id)`
- `UNIQUE (business_id, store_id, id)`
- `CHECK (((period_end >= period_start) AND (period_end <= (period_start + 6))))`
- `CHECK (isfinite(period_end))`
- `CHECK (isfinite(period_start))`
- `PRIMARY KEY (id)`
- `CHECK ((source_code = 'wb_sales_funnel_v3'::text))`
- `UNIQUE (store_id, source_code, period_start, period_end)`

## operational_range_requests

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| business_id | uuid | нет | — |
| store_id | uuid | нет | — |
| metric_date | date | нет | — |
| status | text | нет | 'pending'::text |
| requested_at | timestamp with time zone | нет | now() |

Ограничения и связи:

- `FOREIGN KEY (business_id, store_id) REFERENCES mc.stores(business_id, id)`
- `CHECK (isfinite(metric_date))`
- `PRIMARY KEY (store_id, metric_date)`
- `CHECK ((status = ANY (ARRAY['pending'::text, 'complete'::text, 'failed'::text])))`

## operational_snapshot_activations

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| id | uuid | нет | gen_random_uuid() |
| business_id | uuid | нет | — |
| store_id | uuid | нет | — |
| operational_period_id | uuid | нет | — |
| snapshot_id | uuid | нет | — |
| document_id | uuid | нет | — |
| fetched_at | timestamp with time zone | нет | — |
| created_at | timestamp with time zone | нет | now() |

Ограничения и связи:

- `FOREIGN KEY (business_id, store_id, document_id) REFERENCES mc.source_documents(business_id, store_id, id)`
- `FOREIGN KEY (business_id, store_id, operational_period_id, snapshot_id) REFERENCES mc.operational_snapshots(business_id, store_id, operational_period_id, id)`
- `UNIQUE (business_id, store_id, id)`
- `UNIQUE (document_id)`
- `PRIMARY KEY (id)`

## operational_snapshot_products

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| business_id | uuid | нет | — |
| store_id | uuid | нет | — |
| snapshot_id | uuid | нет | — |
| product_id | uuid | нет | — |
| request_position | integer | нет | — |
| created_at | timestamp with time zone | нет | now() |

Ограничения и связи:

- `FOREIGN KEY (business_id, store_id, product_id) REFERENCES mc.product_selection_items(business_id, store_id, product_id)`
- `FOREIGN KEY (business_id, store_id, snapshot_id) REFERENCES mc.operational_snapshots(business_id, store_id, id)`
- `UNIQUE (business_id, store_id, snapshot_id, product_id)`
- `PRIMARY KEY (snapshot_id, product_id)`
- `CHECK ((request_position > 0))`
- `UNIQUE (snapshot_id, request_position)`

## operational_snapshots

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| id | uuid | нет | gen_random_uuid() |
| business_id | uuid | нет | — |
| store_id | uuid | нет | — |
| operational_period_id | uuid | нет | — |
| document_id | uuid | нет | — |
| version_no | integer | нет | — |
| checksum | text | нет | — |
| parser_version | text | нет | — |
| source_timezone | text | нет | 'Europe/Moscow'::text |
| fetched_at | timestamp with time zone | нет | — |
| quality | text | нет | — |
| missing_reasons | jsonb | нет | '[]'::jsonb |
| status | text | нет | 'received'::text |
| accepted_at | timestamp with time zone | да | — |
| created_at | timestamp with time zone | нет | now() |

Ограничения и связи:

- `FOREIGN KEY (business_id, store_id, document_id) REFERENCES mc.source_documents(business_id, store_id, id)`
- `UNIQUE (business_id, store_id, id)`
- `FOREIGN KEY (business_id, store_id, operational_period_id) REFERENCES mc.operational_periods(business_id, store_id, id)`
- `UNIQUE (business_id, store_id, operational_period_id, id)`
- `CHECK (((status = 'accepted'::text) = (accepted_at IS NOT NULL)))`
- `CHECK ((((quality = 'complete'::text) AND (missing_reasons = '[]'::jsonb)) OR ((quality = ANY (ARRAY['partial'::text, 'unavailable'::text])) AND (jsonb_array_length(missing_reasons) > 0))))`
- `CHECK ((checksum ~ '^[0-9a-f]{64}$'::text))`
- `UNIQUE (document_id)`
- `CHECK ((jsonb_typeof(missing_reasons) = 'array'::text))`
- `UNIQUE (operational_period_id, checksum)`
- `UNIQUE (operational_period_id, version_no)`
- `CHECK ((length(TRIM(BOTH FROM parser_version)) > 0))`
- `PRIMARY KEY (id)`
- `CHECK ((quality = ANY (ARRAY['complete'::text, 'partial'::text, 'unavailable'::text])))`
- `CHECK ((source_timezone = 'Europe/Moscow'::text))`
- `CHECK ((status = ANY (ARRAY['received'::text, 'validated'::text, 'accepted'::text, 'rejected'::text])))`
- `CHECK ((version_no > 0))`

## operational_sync_targets

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| store_id | uuid | нет | — |
| business_id | uuid | нет | — |
| requested_by | uuid | нет | — |
| next_run_at | timestamp with time zone | нет | now() |
| status | text | нет | 'active'::text |
| updated_at | timestamp with time zone | нет | now() |

Ограничения и связи:

- `FOREIGN KEY (business_id, requested_by) REFERENCES mc.memberships(business_id, user_id)`
- `FOREIGN KEY (business_id, store_id) REFERENCES mc.stores(business_id, id)`
- `PRIMARY KEY (store_id)`
- `CHECK ((status = ANY (ARRAY['active'::text, 'blocked'::text])))`

## operations

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| id | uuid | нет | gen_random_uuid() |
| business_id | uuid | нет | — |
| store_id | uuid | нет | — |
| source_code | text | нет | — |
| source_operation_key | text | нет | — |
| created_at | timestamp with time zone | нет | now() |

Ограничения и связи:

- `FOREIGN KEY (business_id, store_id) REFERENCES mc.stores(business_id, id)`
- `UNIQUE (business_id, store_id, id)`
- `PRIMARY KEY (id)`
- `UNIQUE (store_id, source_code, source_operation_key)`

## product_selection_items

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| id | uuid | нет | gen_random_uuid() |
| business_id | uuid | нет | — |
| store_id | uuid | нет | — |
| selection_id | uuid | нет | — |
| product_id | uuid | нет | — |
| created_at | timestamp with time zone | нет | now() |

Ограничения и связи:

- `FOREIGN KEY (business_id, store_id, product_id) REFERENCES mc.products(business_id, store_id, id)`
- `UNIQUE (business_id, store_id, product_id)`
- `FOREIGN KEY (business_id, store_id, selection_id) REFERENCES mc.product_selections(business_id, store_id, id)`
- `PRIMARY KEY (id)`
- `UNIQUE (selection_id, product_id)`

## product_selections

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| id | uuid | нет | gen_random_uuid() |
| business_id | uuid | нет | — |
| store_id | uuid | нет | — |
| plan_version_id | uuid | нет | — |
| catalog_document_id | uuid | нет | — |
| confirmed_by | uuid | нет | — |
| product_limit_snapshot | integer | нет | — |
| status | text | нет | 'draft'::text |
| created_at | timestamp with time zone | нет | now() |

Ограничения и связи:

- `FOREIGN KEY (business_id, confirmed_by) REFERENCES mc.memberships(business_id, user_id)`
- `FOREIGN KEY (business_id, store_id, catalog_document_id) REFERENCES mc.source_documents(business_id, store_id, id)`
- `FOREIGN KEY (business_id, store_id) REFERENCES mc.stores(business_id, id)`
- `UNIQUE (business_id, store_id, id)`
- `FOREIGN KEY (confirmed_by) REFERENCES mc.users(id)`
- `PRIMARY KEY (id)`
- `FOREIGN KEY (plan_version_id) REFERENCES mc.billing_plan_versions(id)`
- `CHECK ((product_limit_snapshot > 0))`
- `CHECK ((status = ANY (ARRAY['draft'::text, 'confirmed'::text])))`
- `UNIQUE (store_id)`
- `TRIGGER DEFERRABLE INITIALLY DEFERRED`

## products

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| id | uuid | нет | gen_random_uuid() |
| business_id | uuid | нет | — |
| store_id | uuid | нет | — |
| wb_article | bigint | нет | — |
| seller_article | text | нет | — |
| title | text | да | — |
| status | text | нет | 'active'::text |
| created_at | timestamp with time zone | нет | now() |
| image_url | text | да | — |
| historical_deleted | boolean | нет | false |
| historical_source_row_id | uuid | да | — |

Ограничения и связи:

- `FOREIGN KEY (business_id, store_id, historical_source_row_id) REFERENCES mc.report_rows(business_id, store_id, id)`
- `CHECK (((NOT historical_deleted) OR (historical_source_row_id IS NOT NULL)))`
- `FOREIGN KEY (business_id, store_id) REFERENCES mc.stores(business_id, id)`
- `UNIQUE (business_id, store_id, id)`
- `PRIMARY KEY (id)`
- `CHECK ((status = ANY (ARRAY['active'::text, 'archived'::text])))`
- `UNIQUE (store_id, wb_article)`
- `CHECK ((wb_article > 0))`

## publications

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| id | uuid | нет | gen_random_uuid() |
| business_id | uuid | нет | — |
| store_id | uuid | нет | — |
| run_id | uuid | нет | — |
| is_current | boolean | нет | true |
| created_at | timestamp with time zone | нет | now() |

Ограничения и связи:

- `FOREIGN KEY (business_id, store_id, run_id) REFERENCES mc.calculation_runs(business_id, store_id, id)`
- `PRIMARY KEY (id)`
- `UNIQUE (run_id)`
- `UNIQUE (business_id, store_id, id)`

## reconciliation_checks

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| id | uuid | нет | gen_random_uuid() |
| business_id | uuid | нет | — |
| store_id | uuid | нет | — |
| run_id | uuid | да | — |
| report_version_id | uuid | да | — |
| check_code | text | нет | — |
| expected_amount | numeric(20,4) | да | — |
| actual_amount | numeric(20,4) | да | — |
| status | text | нет | — |
| details | jsonb | нет | '{}'::jsonb |
| created_at | timestamp with time zone | нет | now() |

Ограничения и связи:

- `FOREIGN KEY (business_id, store_id, report_version_id) REFERENCES mc.report_versions(business_id, store_id, id)`
- `FOREIGN KEY (business_id, store_id, run_id) REFERENCES mc.calculation_runs(business_id, store_id, id)`
- `CHECK ((num_nonnulls(run_id, report_version_id) = 1))`
- `PRIMARY KEY (id)`
- `CHECK ((status = ANY (ARRAY['passed'::text, 'failed'::text, 'not_checkable'::text])))`

## report_normalizations

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| id | uuid | нет | gen_random_uuid() |
| business_id | uuid | нет | — |
| store_id | uuid | нет | — |
| report_version_id | uuid | нет | — |
| method_version_id | uuid | нет | — |
| normalization_key | text | нет | — |
| status | text | нет | — |
| normalized_at | timestamp with time zone | нет | now() |
| created_at | timestamp with time zone | нет | now() |
| catalog_revision | bigint | нет | 0 |

Ограничения и связи:

- `UNIQUE (business_id, store_id, id)`
- `FOREIGN KEY (business_id, store_id, report_version_id) REFERENCES mc.report_versions(business_id, store_id, id)`
- `CHECK ((catalog_revision >= 0))`
- `FOREIGN KEY (method_version_id) REFERENCES mc.method_versions(id)`
- `PRIMARY KEY (id)`
- `UNIQUE (report_version_id, method_version_id, catalog_revision)`
- `CHECK ((status = ANY (ARRAY['succeeded'::text, 'failed'::text])))`
- `UNIQUE (store_id, normalization_key)`
- `UNIQUE (business_id, store_id, report_version_id, id)`

## report_rows

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| id | uuid | нет | gen_random_uuid() |
| business_id | uuid | нет | — |
| store_id | uuid | нет | — |
| report_version_id | uuid | нет | — |
| external_row_key | text | нет | — |
| row_number | integer | нет | — |
| raw_data | jsonb | нет | — |
| row_checksum | text | нет | — |
| created_at | timestamp with time zone | нет | now() |

Ограничения и связи:

- `UNIQUE (business_id, store_id, id)`
- `FOREIGN KEY (business_id, store_id, report_version_id) REFERENCES mc.report_versions(business_id, store_id, id)`
- `PRIMARY KEY (id)`
- `UNIQUE (report_version_id, external_row_key)`
- `UNIQUE (report_version_id, row_number)`
- `CHECK ((row_number > 0))`

## report_versions

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| id | uuid | нет | gen_random_uuid() |
| business_id | uuid | нет | — |
| store_id | uuid | нет | — |
| report_id | uuid | нет | — |
| document_id | uuid | нет | — |
| version_no | integer | нет | — |
| checksum | text | нет | — |
| parser_version | text | нет | — |
| status | text | нет | 'received'::text |
| accepted_at | timestamp with time zone | да | — |
| created_at | timestamp with time zone | нет | now() |
| supersedes_version_id | uuid | да | — |

Ограничения и связи:

- `FOREIGN KEY (business_id, store_id, report_id, supersedes_version_id) REFERENCES mc.report_versions(business_id, store_id, report_id, id)`
- `FOREIGN KEY (business_id, store_id, document_id) REFERENCES mc.source_documents(business_id, store_id, id)`
- `UNIQUE (business_id, store_id, id)`
- `FOREIGN KEY (business_id, store_id, report_id) REFERENCES mc.reports(business_id, store_id, id)`
- `UNIQUE (business_id, store_id, report_id, id)`
- `CHECK (((status = 'accepted'::text) = (accepted_at IS NOT NULL)))`
- `PRIMARY KEY (id)`
- `UNIQUE (report_id, checksum, parser_version)`
- `UNIQUE (report_id, version_no)`
- `CHECK ((status = ANY (ARRAY['received'::text, 'validated'::text, 'accepted'::text, 'rejected'::text])))`
- `CHECK ((version_no > 0))`

## reports

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| id | uuid | нет | gen_random_uuid() |
| business_id | uuid | нет | — |
| store_id | uuid | нет | — |
| external_report_id | text | нет | — |
| report_type | text | нет | 'weekly_realization'::text |
| period_start | date | нет | — |
| period_end | date | нет | — |
| current_version_id | uuid | да | — |
| created_at | timestamp with time zone | нет | now() |

Ограничения и связи:

- `FOREIGN KEY (business_id, store_id) REFERENCES mc.stores(business_id, id)`
- `FOREIGN KEY (business_id, store_id, id, current_version_id) REFERENCES mc.report_versions(business_id, store_id, report_id, id)`
- `UNIQUE (business_id, store_id, id)`
- `CHECK ((period_end >= period_start))`
- `PRIMARY KEY (id)`
- `UNIQUE (store_id, report_type, external_report_id)`

## result_evidence

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| id | uuid | нет | gen_random_uuid() |
| business_id | uuid | нет | — |
| store_id | uuid | нет | — |
| result_line_id | uuid | нет | — |
| financial_component_id | uuid | да | — |
| cost_version_id | uuid | да | — |
| expense_version_id | uuid | да | — |
| quantity | numeric(20,6) | да | — |
| contribution_amount | numeric(20,4) | нет | — |
| created_at | timestamp with time zone | нет | now() |
| source_operation_version_id | uuid | да | — |
| tax_computation_id | uuid | да | — |
| operation_link_id | uuid | да | — |
| report_row_id | uuid | да | — |

Ограничения и связи:

- `FOREIGN KEY (business_id, store_id, cost_version_id) REFERENCES mc.cost_versions(business_id, store_id, id)`
- `FOREIGN KEY (business_id, store_id, expense_version_id) REFERENCES mc.expense_versions(business_id, store_id, id)`
- `FOREIGN KEY (business_id, store_id, financial_component_id) REFERENCES mc.financial_components(business_id, store_id, id)`
- `FOREIGN KEY (business_id, store_id, result_line_id) REFERENCES mc.result_lines(business_id, store_id, id)`
- `CHECK ((num_nonnulls(financial_component_id, cost_version_id, expense_version_id, tax_computation_id, report_row_id) = 1))`
- `FOREIGN KEY (business_id, store_id, operation_link_id) REFERENCES mc.operation_links(business_id, store_id, id)`
- `CHECK ((((operation_link_id IS NULL) AND (report_row_id IS NULL) AND ((source_operation_version_id IS NULL) OR (cost_version_id IS NOT NULL))) OR ((cost_version_id IS NOT NULL) AND (source_operation_version_id IS NOT NULL) AND (quantity IS NOT NULL) AND (report_row_id IS NULL)) OR ((report_row_id IS NOT NULL) AND (source_operation_version_id IS NOT NULL) AND (cost_version_id IS NULL) AND (quantity IS NULL))))`
- `PRIMARY KEY (id)`
- `FOREIGN KEY (business_id, store_id, report_row_id) REFERENCES mc.report_rows(business_id, store_id, id)`
- `FOREIGN KEY (business_id, store_id, source_operation_version_id) REFERENCES mc.operation_versions(business_id, store_id, id)`
- `FOREIGN KEY (business_id, store_id, tax_computation_id) REFERENCES mc.tax_computations(business_id, store_id, id)`

## result_lines

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| id | uuid | нет | gen_random_uuid() |
| business_id | uuid | нет | — |
| store_id | uuid | нет | — |
| run_id | uuid | нет | — |
| product_id | uuid | да | — |
| variant_id | uuid | да | — |
| accounting_date | date | нет | — |
| category_code | text | нет | — |
| amount_signed | numeric(20,4) | нет | — |
| currency | text | нет | 'RUB'::text |
| quality | text | нет | — |
| created_at | timestamp with time zone | нет | now() |
| result_scope | text | нет | 'selected_product'::text |
| financial_period_result_id | uuid | да | — |

Ограничения и связи:

- `CHECK ((((result_scope = 'selected_product'::text) AND (product_id IS NOT NULL)) OR ((result_scope = 'store'::text) AND (product_id IS NULL) AND (variant_id IS NULL))))`
- `FOREIGN KEY (business_id, store_id, financial_period_result_id) REFERENCES mc.financial_period_results(business_id, store_id, id)`
- `UNIQUE (business_id, store_id, id)`
- `FOREIGN KEY (business_id, store_id, product_id) REFERENCES mc.product_selection_items(business_id, store_id, product_id)`
- `FOREIGN KEY (business_id, store_id, product_id, variant_id) REFERENCES mc.variants(business_id, store_id, product_id, id)`
- `FOREIGN KEY (business_id, store_id, run_id) REFERENCES mc.calculation_runs(business_id, store_id, id)`
- `FOREIGN KEY (category_code) REFERENCES mc.financial_categories(code)`
- `CHECK ((currency = 'RUB'::text))`
- `PRIMARY KEY (id)`
- `CHECK ((quality = ANY (ARRAY['complete'::text, 'partial'::text, 'unavailable'::text])))`
- `CHECK ((result_scope = ANY (ARRAY['selected_product'::text, 'store'::text])))`

## schema_migrations

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| version | integer | нет | — |
| applied_at | timestamp with time zone | нет | now() |

Ограничения и связи:

- `PRIMARY KEY (version)`

## source_documents

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| id | uuid | нет | gen_random_uuid() |
| business_id | uuid | нет | — |
| store_id | uuid | нет | — |
| sync_run_id | uuid | да | — |
| origin | text | нет | — |
| document_type | text | нет | — |
| external_document_id | text | да | — |
| checksum | text | нет | — |
| completeness | text | нет | 'unknown'::text |
| received_at | timestamp with time zone | нет | now() |
| created_at | timestamp with time zone | нет | now() |

Ограничения и связи:

- `FOREIGN KEY (business_id, store_id) REFERENCES mc.stores(business_id, id)`
- `UNIQUE (business_id, store_id, id)`
- `FOREIGN KEY (business_id, store_id, sync_run_id) REFERENCES mc.sync_runs(business_id, store_id, id)`
- `CHECK ((completeness = ANY (ARRAY['unknown'::text, 'partial'::text, 'complete'::text])))`
- `CHECK ((origin = ANY (ARRAY['wb_api'::text, 'user_file'::text])))`
- `PRIMARY KEY (id)`

## source_objects

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| id | uuid | нет | gen_random_uuid() |
| business_id | uuid | нет | — |
| store_id | uuid | нет | — |
| document_id | uuid | нет | — |
| storage_key | text | нет | — |
| part_number | integer | нет | — |
| byte_size | bigint | нет | — |
| checksum | text | нет | — |
| content_type | text | нет | — |
| created_at | timestamp with time zone | нет | now() |

Ограничения и связи:

- `FOREIGN KEY (business_id, store_id, document_id) REFERENCES mc.source_documents(business_id, store_id, id)`
- `CHECK ((byte_size >= 0))`
- `UNIQUE (document_id, part_number)`
- `CHECK ((part_number >= 0))`
- `PRIMARY KEY (id)`
- `UNIQUE (storage_key)`

## stores

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| id | uuid | нет | gen_random_uuid() |
| business_id | uuid | нет | — |
| marketplace_code | text | нет | 'wb'::text |
| external_account_id | text | да | — |
| name | text | нет | — |
| status | text | нет | 'paused'::text |
| created_at | timestamp with time zone | нет | now() |
| catalog_revision | bigint | нет | 0 |

Ограничения и связи:

- `CHECK (((status <> 'active'::text) OR (external_account_id IS NOT NULL)))`
- `FOREIGN KEY (business_id) REFERENCES mc.businesses(id)`
- `UNIQUE (business_id, id)`
- `UNIQUE (business_id, marketplace_code, external_account_id)`
- `CHECK ((catalog_revision >= 0))`
- `PRIMARY KEY (id)`
- `CHECK ((status = ANY (ARRAY['active'::text, 'paused'::text, 'archived'::text])))`

## subscription_events

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| id | uuid | нет | gen_random_uuid() |
| business_id | uuid | нет | — |
| subscription_id | uuid | нет | — |
| previous_plan_version_id | uuid | да | — |
| new_plan_version_id | uuid | нет | — |
| event_type | text | нет | — |
| details | jsonb | нет | '{}'::jsonb |
| created_at | timestamp with time zone | нет | now() |

Ограничения и связи:

- `FOREIGN KEY (business_id, subscription_id) REFERENCES mc.subscriptions(business_id, id)`
- `CHECK ((event_type = ANY (ARRAY['started'::text, 'plan_changed'::text, 'renewed'::text, 'status_changed'::text])))`
- `FOREIGN KEY (new_plan_version_id) REFERENCES mc.billing_plan_versions(id)`
- `PRIMARY KEY (id)`
- `FOREIGN KEY (previous_plan_version_id) REFERENCES mc.billing_plan_versions(id)`

## subscriptions

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| id | uuid | нет | gen_random_uuid() |
| business_id | uuid | нет | — |
| plan_version_id | uuid | нет | — |
| status | text | нет | 'active'::text |
| period_start | timestamp with time zone | нет | now() |
| period_end | timestamp with time zone | да | — |
| cancel_at_period_end | boolean | нет | false |
| provider_subscription_id | text | да | — |
| created_at | timestamp with time zone | нет | now() |

Ограничения и связи:

- `FOREIGN KEY (business_id) REFERENCES mc.businesses(id)`
- `UNIQUE (business_id, id)`
- `UNIQUE (business_id)`
- `CHECK (((period_end IS NULL) OR (period_end > period_start)))`
- `PRIMARY KEY (id)`
- `FOREIGN KEY (plan_version_id) REFERENCES mc.billing_plan_versions(id)`
- `CHECK ((status = ANY (ARRAY['active'::text, 'past_due'::text, 'ended'::text])))`

## sync_runs

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| id | uuid | нет | gen_random_uuid() |
| business_id | uuid | нет | — |
| store_id | uuid | нет | — |
| stream_id | uuid | нет | — |
| requested_from | date | да | — |
| requested_to | date | да | — |
| status | text | нет | 'queued'::text |
| started_at | timestamp with time zone | да | — |
| finished_at | timestamp with time zone | да | — |
| error_code | text | да | — |
| created_at | timestamp with time zone | нет | now() |
| progress | jsonb | нет | '{}'::jsonb |

Ограничения и связи:

- `UNIQUE (business_id, store_id, id)`
- `FOREIGN KEY (business_id, store_id, stream_id) REFERENCES mc.sync_streams(business_id, store_id, id)`
- `CHECK (((requested_to IS NULL) OR (requested_from IS NULL) OR (requested_to >= requested_from)))`
- `PRIMARY KEY (id)`
- `CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'succeeded'::text, 'partial'::text, 'failed'::text])))`

## sync_streams

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| id | uuid | нет | gen_random_uuid() |
| business_id | uuid | нет | — |
| store_id | uuid | нет | — |
| source_type | text | нет | — |
| cursor | jsonb | да | — |
| next_run_at | timestamp with time zone | да | — |
| last_success_at | timestamp with time zone | да | — |
| status | text | нет | 'active'::text |
| created_at | timestamp with time zone | нет | now() |

Ограничения и связи:

- `FOREIGN KEY (business_id, store_id) REFERENCES mc.stores(business_id, id)`
- `UNIQUE (business_id, store_id, id)`
- `PRIMARY KEY (id)`
- `CHECK ((source_type = ANY (ARRAY['catalog'::text, 'financial_reports'::text, 'operational_sales_funnel'::text])))`
- `CHECK ((status = ANY (ARRAY['active'::text, 'paused'::text, 'blocked'::text])))`
- `UNIQUE (store_id, source_type)`

## tax_basis_evidence

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| id | uuid | нет | gen_random_uuid() |
| business_id | uuid | нет | — |
| store_id | uuid | нет | — |
| tax_segment_id | uuid | нет | — |
| financial_component_id | uuid | нет | — |
| taxable_contribution | numeric(20,4) | нет | — |
| recognition_date | date | нет | — |
| created_at | timestamp with time zone | нет | now() |

Ограничения и связи:

- `FOREIGN KEY (business_id, store_id, financial_component_id) REFERENCES mc.financial_components(business_id, store_id, id)`
- `UNIQUE (business_id, store_id, id)`
- `FOREIGN KEY (business_id, store_id, tax_segment_id) REFERENCES mc.tax_computation_segments(business_id, store_id, id)`
- `PRIMARY KEY (id)`
- `CHECK (isfinite(recognition_date))`
- `UNIQUE (tax_segment_id, financial_component_id)`

## tax_computation_segments

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| id | uuid | нет | gen_random_uuid() |
| business_id | uuid | нет | — |
| store_id | uuid | нет | — |
| tax_computation_id | uuid | нет | — |
| tax_setting_version_id | uuid | нет | — |
| segment_start | date | нет | — |
| segment_end | date | нет | — |
| taxable_base | numeric(20,4) | нет | — |
| rate_fraction | numeric | нет | — |
| created_at | timestamp with time zone | нет | now() |

Ограничения и связи:

- `UNIQUE (business_id, store_id, id)`
- `FOREIGN KEY (business_id, store_id, tax_computation_id) REFERENCES mc.tax_computations(business_id, store_id, id)`
- `FOREIGN KEY (business_id, tax_setting_version_id) REFERENCES mc.tax_setting_versions(business_id, id)`
- `CHECK ((segment_end >= segment_start))`
- `PRIMARY KEY (id)`
- `CHECK (((rate_fraction >= (0)::numeric) AND (rate_fraction <= (1)::numeric)))`
- `CHECK (isfinite(segment_end))`
- `CHECK (isfinite(segment_start))`
- `UNIQUE (tax_computation_id, segment_start, segment_end)`

## tax_computations

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| id | uuid | нет | gen_random_uuid() |
| business_id | uuid | нет | — |
| store_id | uuid | нет | — |
| run_id | uuid | нет | — |
| product_id | uuid | нет | — |
| period_start | date | нет | — |
| period_end | date | нет | — |
| taxable_base | numeric(20,4) | нет | — |
| tax_amount | numeric(20,4) | нет | — |
| method_version_id | uuid | нет | — |
| created_at | timestamp with time zone | нет | now() |

Ограничения и связи:

- `UNIQUE (run_id, period_start, period_end, product_id)`
- `UNIQUE (business_id, store_id, id)`
- `FOREIGN KEY (business_id, store_id, product_id) REFERENCES mc.product_selection_items(business_id, store_id, product_id)`
- `FOREIGN KEY (business_id, store_id, run_id) REFERENCES mc.calculation_runs(business_id, store_id, id)`
- `CHECK ((period_end >= period_start))`
- `FOREIGN KEY (method_version_id) REFERENCES mc.method_versions(id)`
- `CHECK (isfinite(period_end))`
- `CHECK (isfinite(period_start))`
- `PRIMARY KEY (id)`

## tax_setting_versions

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| id | uuid | нет | gen_random_uuid() |
| business_id | uuid | нет | — |
| tax_setting_id | uuid | нет | — |
| version_no | integer | нет | — |
| regime_code | text | нет | — |
| usn_rate_fraction | numeric | да | — |
| vat_mode | text | нет | — |
| state | text | нет | 'active'::text |
| currency | text | нет | 'RUB'::text |
| changed_by | uuid | нет | — |
| comment | text | да | — |
| created_at | timestamp with time zone | нет | now() |

Ограничения и связи:

- `UNIQUE (business_id, id)`
- `FOREIGN KEY (business_id, tax_setting_id) REFERENCES mc.tax_settings(business_id, id)`
- `UNIQUE (business_id, tax_setting_id, id)`
- `FOREIGN KEY (changed_by) REFERENCES mc.users(id)`
- `CHECK ((((regime_code = ANY (ARRAY['usn_income'::text, 'usn_income_expenses'::text])) AND (usn_rate_fraction IS NOT NULL) AND ((usn_rate_fraction >= (0)::numeric) AND (usn_rate_fraction <= (1)::numeric))) OR ((regime_code = 'osno'::text) AND (usn_rate_fraction IS NULL))))`
- `CHECK ((currency = 'RUB'::text))`
- `PRIMARY KEY (id)`
- `CHECK ((regime_code = ANY (ARRAY['usn_income'::text, 'usn_income_expenses'::text, 'osno'::text])))`
- `CHECK ((state = ANY (ARRAY['active'::text, 'voided'::text])))`
- `UNIQUE (tax_setting_id, version_no)`
- `CHECK ((vat_mode = ANY (ARRAY['unmodeled'::text, 'exempt'::text, 'general'::text, 'special'::text])))`
- `CHECK ((version_no > 0))`

## tax_settings

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| id | uuid | нет | gen_random_uuid() |
| business_id | uuid | нет | — |
| effective_from | date | нет | — |
| current_version_id | uuid | да | — |
| created_at | timestamp with time zone | нет | now() |

Ограничения и связи:

- `UNIQUE (business_id, effective_from)`
- `FOREIGN KEY (business_id) REFERENCES mc.businesses(id)`
- `UNIQUE (business_id, id)`
- `FOREIGN KEY (business_id, id, current_version_id) REFERENCES mc.tax_setting_versions(business_id, tax_setting_id, id)`
- `CHECK (isfinite(effective_from))`
- `PRIMARY KEY (id)`

## users

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| id | uuid | нет | gen_random_uuid() |
| display_name | text | нет | — |
| email | text | да | — |
| status | text | нет | 'active'::text |
| created_at | timestamp with time zone | нет | now() |
| email_verified_at | timestamp with time zone | да | — |

Ограничения и связи:

- `CHECK ((length(TRIM(BOTH FROM display_name)) > 0))`
- `PRIMARY KEY (id)`
- `CHECK ((status = ANY (ARRAY['active'::text, 'blocked'::text, 'deleted'::text])))`

## variant_costs

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| id | uuid | нет | gen_random_uuid() |
| business_id | uuid | нет | — |
| store_id | uuid | нет | — |
| product_id | uuid | нет | — |
| variant_id | uuid | нет | — |
| effective_from | date | нет | — |
| current_version_id | uuid | да | — |
| created_at | timestamp with time zone | нет | now() |

Ограничения и связи:

- `FOREIGN KEY (business_id, store_id, id, current_version_id) REFERENCES mc.cost_versions(business_id, store_id, cost_id, id)`
- `UNIQUE (business_id, store_id, id)`
- `FOREIGN KEY (business_id, store_id, product_id) REFERENCES mc.product_selection_items(business_id, store_id, product_id)`
- `FOREIGN KEY (business_id, store_id, product_id, variant_id) REFERENCES mc.variants(business_id, store_id, product_id, id)`
- `PRIMARY KEY (id)`
- `UNIQUE (variant_id, effective_from)`

## variant_identifiers

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| id | uuid | нет | gen_random_uuid() |
| business_id | uuid | нет | — |
| store_id | uuid | нет | — |
| variant_id | uuid | нет | — |
| identifier_type | text | нет | — |
| identifier_value | text | нет | — |
| valid_from | timestamp with time zone | нет | now() |
| valid_to | timestamp with time zone | да | — |
| created_at | timestamp with time zone | нет | now() |

Ограничения и связи:

- `FOREIGN KEY (business_id, store_id, variant_id) REFERENCES mc.variants(business_id, store_id, id)`
- `CHECK (((valid_to IS NULL) OR (valid_to > valid_from)))`
- `CHECK ((identifier_type = ANY (ARRAY['barcode'::text, 'marketplace_variant_id'::text])))`
- `PRIMARY KEY (id)`

## variants

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| id | uuid | нет | gen_random_uuid() |
| business_id | uuid | нет | — |
| store_id | uuid | нет | — |
| product_id | uuid | нет | — |
| external_variant_id | text | нет | — |
| size_label | text | да | — |
| color_label | text | да | — |
| attributes | jsonb | нет | '{}'::jsonb |
| status | text | нет | 'active'::text |
| created_at | timestamp with time zone | нет | now() |
| historical_report_only | boolean | нет | false |
| wb_external_variant_id | text | да | — |

Ограничения и связи:

- `UNIQUE (business_id, store_id, id)`
- `FOREIGN KEY (business_id, store_id, product_id) REFERENCES mc.products(business_id, store_id, id)`
- `UNIQUE (business_id, store_id, product_id, id)`
- `PRIMARY KEY (id)`
- `CHECK ((status = ANY (ARRAY['active'::text, 'archived'::text])))`
- `UNIQUE (store_id, product_id, external_variant_id)`

## wb_api_request_slots

| Поле | Тип | NULL | По умолчанию |
|---|---|---|---|
| rate_key | text | нет | — |
| next_allowed_at | timestamp with time zone | нет | — |
| updated_at | timestamp with time zone | нет | now() |

Ограничения и связи:

- `PRIMARY KEY (rate_key)`
- `CHECK ((length(rate_key) = 64))`
