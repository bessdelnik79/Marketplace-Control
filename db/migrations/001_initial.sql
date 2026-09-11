-- Marketplace Control: PostgreSQL, iteration 1.
-- Apply once to an empty database with a migration owner.
BEGIN;
CREATE SCHEMA mc;

CREATE TABLE mc.schema_migrations (
  version integer PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mc.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name text NOT NULL CHECK (length(trim(display_name)) > 0),
  email text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked','deleted')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE mc.auth_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES mc.users(id),
  provider text NOT NULL,
  subject text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, subject)
);
CREATE TABLE mc.businesses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(trim(name)) > 0),
  timezone text NOT NULL DEFAULT 'Europe/Moscow',
  currency text NOT NULL DEFAULT 'RUB' CHECK (currency = 'RUB'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE mc.memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES mc.businesses(id),
  user_id uuid NOT NULL REFERENCES mc.users(id),
  role text NOT NULL DEFAULT 'owner' CHECK (role IN ('owner','editor','viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, user_id)
);

-- Plans are data, not an enum: the number of plans can change.
CREATE TABLE mc.billing_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE mc.billing_plan_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES mc.billing_plans(id),
  version_no integer NOT NULL CHECK (version_no > 0),
  product_limit integer NOT NULL CHECK (product_limit > 0),
  store_limit integer NOT NULL CHECK (store_limit > 0),
  price numeric(20,4) CHECK (price >= 0),
  currency text NOT NULL DEFAULT 'RUB' CHECK (currency = 'RUB'),
  billing_period text NOT NULL CHECK (billing_period IN ('none','month','year')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_id, version_no),
  CHECK (billing_period <> 'none' OR (price IS NOT NULL AND price = 0))
);
CREATE TABLE mc.subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL UNIQUE REFERENCES mc.businesses(id),
  plan_version_id uuid NOT NULL REFERENCES mc.billing_plan_versions(id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','past_due','ended')),
  period_start timestamptz NOT NULL DEFAULT now(),
  period_end timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  provider_subscription_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  CHECK (period_end IS NULL OR period_end > period_start)
);
CREATE TABLE mc.subscription_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  subscription_id uuid NOT NULL,
  previous_plan_version_id uuid REFERENCES mc.billing_plan_versions(id),
  new_plan_version_id uuid NOT NULL REFERENCES mc.billing_plan_versions(id),
  event_type text NOT NULL CHECK (event_type IN ('started','plan_changed','renewed','status_changed')),
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, subscription_id) REFERENCES mc.subscriptions(business_id, id)
);

CREATE TABLE mc.stores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES mc.businesses(id),
  marketplace_code text NOT NULL DEFAULT 'wb',
  external_account_id text NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  UNIQUE (business_id, marketplace_code, external_account_id)
);
CREATE TABLE mc.connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  store_id uuid NOT NULL,
  secret_ref text NOT NULL,
  scopes jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','invalid','revoked')),
  last_checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, store_id, id),
  FOREIGN KEY (business_id, store_id) REFERENCES mc.stores(business_id, id)
);

CREATE TABLE mc.sync_streams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  store_id uuid NOT NULL,
  source_type text NOT NULL CHECK (source_type IN ('catalog','financial_reports')),
  cursor jsonb,
  next_run_at timestamptz,
  last_success_at timestamptz,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','blocked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, store_id, id),
  UNIQUE (store_id, source_type),
  FOREIGN KEY (business_id, store_id) REFERENCES mc.stores(business_id, id)
);
CREATE TABLE mc.sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  store_id uuid NOT NULL,
  stream_id uuid NOT NULL,
  requested_from date,
  requested_to date,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','partial','failed')),
  started_at timestamptz,
  finished_at timestamptz,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, store_id, id),
  FOREIGN KEY (business_id, store_id, stream_id) REFERENCES mc.sync_streams(business_id, store_id, id),
  CHECK (requested_to IS NULL OR requested_from IS NULL OR requested_to >= requested_from)
);
CREATE UNIQUE INDEX one_running_sync ON mc.sync_runs(stream_id) WHERE status = 'running';
CREATE TABLE mc.source_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  store_id uuid NOT NULL,
  sync_run_id uuid,
  origin text NOT NULL CHECK (origin IN ('wb_api','user_file')),
  document_type text NOT NULL,
  external_document_id text,
  checksum text NOT NULL,
  completeness text NOT NULL DEFAULT 'unknown' CHECK (completeness IN ('unknown','partial','complete')),
  received_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, store_id, id),
  FOREIGN KEY (business_id, store_id) REFERENCES mc.stores(business_id, id),
  FOREIGN KEY (business_id, store_id, sync_run_id) REFERENCES mc.sync_runs(business_id, store_id, id)
);
CREATE TABLE mc.source_objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  store_id uuid NOT NULL,
  document_id uuid NOT NULL,
  storage_key text NOT NULL UNIQUE,
  part_number integer NOT NULL CHECK (part_number >= 0),
  byte_size bigint NOT NULL CHECK (byte_size >= 0),
  checksum text NOT NULL,
  content_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, part_number),
  FOREIGN KEY (business_id, store_id, document_id) REFERENCES mc.source_documents(business_id, store_id, id)
);
CREATE TABLE mc.coverage_intervals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  store_id uuid NOT NULL,
  stream_id uuid NOT NULL,
  source_document_id uuid,
  date_from date NOT NULL,
  date_to date NOT NULL,
  status text NOT NULL CHECK (status IN ('unknown','partial','complete','unavailable')),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, store_id, stream_id) REFERENCES mc.sync_streams(business_id, store_id, id),
  FOREIGN KEY (business_id, store_id, source_document_id) REFERENCES mc.source_documents(business_id, store_id, id),
  CHECK (date_to >= date_from)
);

CREATE TABLE mc.products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  store_id uuid NOT NULL,
  wb_article bigint NOT NULL CHECK (wb_article > 0),
  seller_article text NOT NULL,
  title text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, store_id, id),
  UNIQUE (store_id, wb_article),
  FOREIGN KEY (business_id, store_id) REFERENCES mc.stores(business_id, id)
);
CREATE TABLE mc.variants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  store_id uuid NOT NULL,
  product_id uuid NOT NULL,
  external_variant_id text NOT NULL,
  size_label text,
  color_label text,
  attributes jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, store_id, id),
  UNIQUE (business_id, store_id, product_id, id),
  UNIQUE (store_id, product_id, external_variant_id),
  FOREIGN KEY (business_id, store_id, product_id) REFERENCES mc.products(business_id, store_id, id)
);
CREATE TABLE mc.variant_identifiers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  store_id uuid NOT NULL,
  variant_id uuid NOT NULL,
  identifier_type text NOT NULL CHECK (identifier_type IN ('barcode','marketplace_variant_id')),
  identifier_value text NOT NULL,
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, store_id, variant_id) REFERENCES mc.variants(business_id, store_id, id),
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);
CREATE UNIQUE INDEX active_variant_identifier ON mc.variant_identifiers(store_id, identifier_type, identifier_value) WHERE valid_to IS NULL;

-- A confirmed selection is immutable. No random choice and no replacement.
CREATE TABLE mc.product_selections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  store_id uuid NOT NULL,
  plan_version_id uuid NOT NULL REFERENCES mc.billing_plan_versions(id),
  catalog_document_id uuid NOT NULL,
  confirmed_by uuid NOT NULL REFERENCES mc.users(id),
  product_limit_snapshot integer NOT NULL CHECK (product_limit_snapshot > 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','confirmed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store_id),
  UNIQUE (business_id, store_id, id),
  FOREIGN KEY (business_id, store_id) REFERENCES mc.stores(business_id, id),
  FOREIGN KEY (business_id, store_id, catalog_document_id) REFERENCES mc.source_documents(business_id, store_id, id),
  FOREIGN KEY (business_id, confirmed_by) REFERENCES mc.memberships(business_id, user_id)
);
CREATE TABLE mc.product_selection_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  store_id uuid NOT NULL,
  selection_id uuid NOT NULL,
  product_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, store_id, product_id),
  UNIQUE (selection_id, product_id),
  FOREIGN KEY (business_id, store_id, selection_id) REFERENCES mc.product_selections(business_id, store_id, id),
  FOREIGN KEY (business_id, store_id, product_id) REFERENCES mc.products(business_id, store_id, id)
);

CREATE TABLE mc.import_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  store_id uuid NOT NULL,
  document_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('costs','promotion_expenses')),
  uploaded_by uuid NOT NULL REFERENCES mc.users(id),
  status text NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploaded','validating','ready','applying','completed','failed','cancelled')),
  column_mapping jsonb NOT NULL DEFAULT '{}',
  applied_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, store_id, id),
  UNIQUE (document_id, kind),
  FOREIGN KEY (business_id, store_id, document_id) REFERENCES mc.source_documents(business_id, store_id, id)
);
CREATE TABLE mc.import_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  store_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  row_number integer NOT NULL CHECK (row_number > 0),
  raw_values jsonb NOT NULL,
  status text NOT NULL DEFAULT 'valid' CHECK (status IN ('valid','invalid','duplicate','applied','skipped')),
  errors jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, store_id, id),
  UNIQUE (batch_id, row_number),
  FOREIGN KEY (business_id, store_id, batch_id) REFERENCES mc.import_batches(business_id, store_id, id)
);

-- Effective cost begins at effective_from and ends at the next effective_from.
-- Correcting the amount creates a new immutable version at the same date.
CREATE TABLE mc.variant_costs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  store_id uuid NOT NULL,
  product_id uuid NOT NULL,
  variant_id uuid NOT NULL,
  effective_from date NOT NULL,
  current_version_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, store_id, id),
  UNIQUE (variant_id, effective_from),
  FOREIGN KEY (business_id, store_id, product_id) REFERENCES mc.product_selection_items(business_id, store_id, product_id),
  FOREIGN KEY (business_id, store_id, product_id, variant_id) REFERENCES mc.variants(business_id, store_id, product_id, id)
);
CREATE TABLE mc.cost_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  store_id uuid NOT NULL,
  cost_id uuid NOT NULL,
  version_no integer NOT NULL CHECK (version_no > 0),
  unit_cost numeric(20,4) NOT NULL CHECK (unit_cost >= 0),
  currency text NOT NULL DEFAULT 'RUB' CHECK (currency = 'RUB'),
  origin text NOT NULL CHECK (origin IN ('manual','file')),
  import_row_id uuid,
  changed_by uuid NOT NULL REFERENCES mc.users(id),
  comment text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, store_id, id),
  UNIQUE (business_id, store_id, cost_id, id),
  UNIQUE (cost_id, version_no),
  UNIQUE (import_row_id),
  FOREIGN KEY (business_id, store_id, cost_id) REFERENCES mc.variant_costs(business_id, store_id, id),
  FOREIGN KEY (business_id, store_id, import_row_id) REFERENCES mc.import_rows(business_id, store_id, id),
  CHECK ((origin = 'file') = (import_row_id IS NOT NULL))
);
ALTER TABLE mc.variant_costs ADD FOREIGN KEY (business_id, store_id, id, current_version_id)
  REFERENCES mc.cost_versions(business_id, store_id, cost_id, id);

CREATE TABLE mc.expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  store_id uuid NOT NULL,
  product_id uuid NOT NULL,
  external_entry_key text,
  current_version_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, store_id, id),
  UNIQUE (store_id, external_entry_key),
  FOREIGN KEY (business_id, store_id, product_id) REFERENCES mc.product_selection_items(business_id, store_id, product_id)
);
CREATE TABLE mc.expense_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  store_id uuid NOT NULL,
  expense_id uuid NOT NULL,
  version_no integer NOT NULL CHECK (version_no > 0),
  category text NOT NULL DEFAULT 'external_promotion' CHECK (category IN ('external_promotion','agency_services','other_external')),
  amount numeric(20,4) NOT NULL CHECK (amount > 0),
  currency text NOT NULL DEFAULT 'RUB' CHECK (currency = 'RUB'),
  period_start date NOT NULL,
  period_end date NOT NULL,
  channel_name text,
  description text,
  recognition_method text NOT NULL CHECK (recognition_method IN ('on_date','evenly_over_period')),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','voided')),
  origin text NOT NULL CHECK (origin IN ('manual','file')),
  import_row_id uuid,
  changed_by uuid NOT NULL REFERENCES mc.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, store_id, id),
  UNIQUE (business_id, store_id, expense_id, id),
  UNIQUE (expense_id, version_no),
  UNIQUE (import_row_id),
  FOREIGN KEY (business_id, store_id, expense_id) REFERENCES mc.expenses(business_id, store_id, id),
  FOREIGN KEY (business_id, store_id, import_row_id) REFERENCES mc.import_rows(business_id, store_id, id),
  CHECK (period_end >= period_start),
  CHECK (recognition_method <> 'on_date' OR period_end = period_start),
  CHECK ((origin = 'file') = (import_row_id IS NOT NULL))
);
ALTER TABLE mc.expenses ADD FOREIGN KEY (business_id, store_id, id, current_version_id)
  REFERENCES mc.expense_versions(business_id, store_id, expense_id, id);

CREATE TABLE mc.reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  store_id uuid NOT NULL,
  external_report_id text NOT NULL,
  report_type text NOT NULL DEFAULT 'weekly_realization',
  period_start date NOT NULL,
  period_end date NOT NULL,
  current_version_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, store_id, id),
  UNIQUE (store_id, report_type, external_report_id),
  FOREIGN KEY (business_id, store_id) REFERENCES mc.stores(business_id, id),
  CHECK (period_end >= period_start)
);
CREATE TABLE mc.report_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  store_id uuid NOT NULL,
  report_id uuid NOT NULL,
  document_id uuid NOT NULL,
  version_no integer NOT NULL CHECK (version_no > 0),
  checksum text NOT NULL,
  parser_version text NOT NULL,
  status text NOT NULL DEFAULT 'received' CHECK (status IN ('received','validated','accepted','rejected')),
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, store_id, id),
  UNIQUE (business_id, store_id, report_id, id),
  UNIQUE (report_id, version_no),
  UNIQUE (report_id, checksum),
  FOREIGN KEY (business_id, store_id, report_id) REFERENCES mc.reports(business_id, store_id, id),
  FOREIGN KEY (business_id, store_id, document_id) REFERENCES mc.source_documents(business_id, store_id, id),
  CHECK ((status = 'accepted') = (accepted_at IS NOT NULL))
);
ALTER TABLE mc.reports ADD FOREIGN KEY (business_id, store_id, id, current_version_id)
  REFERENCES mc.report_versions(business_id, store_id, report_id, id);
CREATE TABLE mc.report_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  store_id uuid NOT NULL,
  report_version_id uuid NOT NULL,
  external_row_key text NOT NULL,
  row_number integer NOT NULL CHECK (row_number > 0),
  raw_data jsonb NOT NULL,
  row_checksum text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, store_id, id),
  UNIQUE (report_version_id, external_row_key),
  UNIQUE (report_version_id, row_number),
  FOREIGN KEY (business_id, store_id, report_version_id) REFERENCES mc.report_versions(business_id, store_id, id)
);
CREATE TABLE mc.data_issues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  store_id uuid NOT NULL,
  document_id uuid NOT NULL,
  report_row_id uuid,
  code text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('warning','blocking')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','accepted_limitation')),
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, store_id, document_id) REFERENCES mc.source_documents(business_id, store_id, id),
  FOREIGN KEY (business_id, store_id, report_row_id) REFERENCES mc.report_rows(business_id, store_id, id)
);
CREATE TABLE mc.method_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  version_no integer NOT NULL CHECK (version_no > 0),
  description text NOT NULL,
  parameters jsonb NOT NULL DEFAULT '{}',
  implementation_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (code, version_no)
);
CREATE TABLE mc.operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  store_id uuid NOT NULL,
  source_code text NOT NULL,
  source_operation_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, store_id, id),
  UNIQUE (store_id, source_code, source_operation_key),
  FOREIGN KEY (business_id, store_id) REFERENCES mc.stores(business_id, id)
);
CREATE TABLE mc.operation_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  store_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  report_row_id uuid NOT NULL,
  version_no integer NOT NULL CHECK (version_no > 0),
  srid text,
  operation_type text NOT NULL CHECK (operation_type IN ('sale','return','service_charge','adjustment','settlement','other','unclassified')),
  product_id uuid,
  variant_id uuid,
  accounting_date date NOT NULL,
  source_occurred_at timestamptz,
  quantity numeric(20,6),
  currency text NOT NULL DEFAULT 'RUB' CHECK (currency = 'RUB'),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','withdrawn')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, store_id, id),
  UNIQUE (operation_id, version_no),
  FOREIGN KEY (business_id, store_id, operation_id) REFERENCES mc.operations(business_id, store_id, id),
  FOREIGN KEY (business_id, store_id, report_row_id) REFERENCES mc.report_rows(business_id, store_id, id),
  FOREIGN KEY (business_id, store_id, product_id) REFERENCES mc.products(business_id, store_id, id),
  FOREIGN KEY (business_id, store_id, product_id, variant_id) REFERENCES mc.variants(business_id, store_id, product_id, id),
  CHECK (variant_id IS NULL OR product_id IS NOT NULL)
);
CREATE TABLE mc.financial_categories (
  code text PRIMARY KEY,
  name text NOT NULL,
  class text NOT NULL CHECK (class IN ('income','expense','settlement','informational')),
  is_promotion boolean NOT NULL DEFAULT false
);
CREATE TABLE mc.financial_components (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  store_id uuid NOT NULL,
  operation_version_id uuid NOT NULL,
  component_key text NOT NULL,
  category_code text NOT NULL REFERENCES mc.financial_categories(code),
  amount_signed numeric(20,4) NOT NULL,
  method_version_id uuid NOT NULL REFERENCES mc.method_versions(id),
  source_field text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, store_id, id),
  UNIQUE (operation_version_id, method_version_id, component_key),
  FOREIGN KEY (business_id, store_id, operation_version_id) REFERENCES mc.operation_versions(business_id, store_id, id)
);

CREATE TABLE mc.calculation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  store_id uuid NOT NULL,
  selection_id uuid NOT NULL,
  method_version_id uuid NOT NULL REFERENCES mc.method_versions(id),
  period_start date NOT NULL,
  period_end date NOT NULL,
  input_fingerprint text NOT NULL,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','succeeded','failed')),
  quality text NOT NULL DEFAULT 'unavailable' CHECK (quality IN ('complete','partial','unavailable')),
  missing_reasons jsonb NOT NULL DEFAULT '[]',
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, store_id, id),
  UNIQUE (store_id, input_fingerprint, method_version_id, period_start, period_end),
  FOREIGN KEY (business_id, store_id, selection_id) REFERENCES mc.product_selections(business_id, store_id, id),
  CHECK (period_end >= period_start),
  CHECK ((status = 'running') = (finished_at IS NULL))
);
CREATE TABLE mc.calculation_inputs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  store_id uuid NOT NULL,
  run_id uuid NOT NULL,
  report_version_id uuid,
  cost_version_id uuid,
  expense_version_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, store_id, run_id) REFERENCES mc.calculation_runs(business_id, store_id, id),
  FOREIGN KEY (business_id, store_id, report_version_id) REFERENCES mc.report_versions(business_id, store_id, id),
  FOREIGN KEY (business_id, store_id, cost_version_id) REFERENCES mc.cost_versions(business_id, store_id, id),
  FOREIGN KEY (business_id, store_id, expense_version_id) REFERENCES mc.expense_versions(business_id, store_id, id),
  CHECK (num_nonnulls(report_version_id, cost_version_id, expense_version_id) = 1),
  UNIQUE (run_id, report_version_id),
  UNIQUE (run_id, cost_version_id),
  UNIQUE (run_id, expense_version_id)
);
CREATE TABLE mc.result_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  store_id uuid NOT NULL,
  run_id uuid NOT NULL,
  product_id uuid NOT NULL,
  variant_id uuid,
  accounting_date date NOT NULL,
  category_code text NOT NULL REFERENCES mc.financial_categories(code),
  amount_signed numeric(20,4) NOT NULL,
  currency text NOT NULL DEFAULT 'RUB' CHECK (currency = 'RUB'),
  quality text NOT NULL CHECK (quality IN ('complete','partial','unavailable')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, store_id, id),
  FOREIGN KEY (business_id, store_id, run_id) REFERENCES mc.calculation_runs(business_id, store_id, id),
  FOREIGN KEY (business_id, store_id, product_id) REFERENCES mc.product_selection_items(business_id, store_id, product_id),
  FOREIGN KEY (business_id, store_id, product_id, variant_id) REFERENCES mc.variants(business_id, store_id, product_id, id)
);
CREATE TABLE mc.result_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  store_id uuid NOT NULL,
  result_line_id uuid NOT NULL,
  financial_component_id uuid,
  cost_version_id uuid,
  expense_version_id uuid,
  quantity numeric(20,6),
  contribution_amount numeric(20,4) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, store_id, result_line_id) REFERENCES mc.result_lines(business_id, store_id, id),
  FOREIGN KEY (business_id, store_id, financial_component_id) REFERENCES mc.financial_components(business_id, store_id, id),
  FOREIGN KEY (business_id, store_id, cost_version_id) REFERENCES mc.cost_versions(business_id, store_id, id),
  FOREIGN KEY (business_id, store_id, expense_version_id) REFERENCES mc.expense_versions(business_id, store_id, id),
  CHECK (num_nonnulls(financial_component_id, cost_version_id, expense_version_id) = 1)
);
CREATE TABLE mc.reconciliation_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  store_id uuid NOT NULL,
  run_id uuid,
  report_version_id uuid,
  check_code text NOT NULL,
  expected_amount numeric(20,4),
  actual_amount numeric(20,4),
  status text NOT NULL CHECK (status IN ('passed','failed','not_checkable')),
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, store_id, run_id) REFERENCES mc.calculation_runs(business_id, store_id, id),
  FOREIGN KEY (business_id, store_id, report_version_id) REFERENCES mc.report_versions(business_id, store_id, id),
  CHECK (num_nonnulls(run_id, report_version_id) = 1)
);
-- Iteration 1 publishes a complete recalculation of the loaded store history.
-- Incremental non-overlapping publication parts can be introduced later.
CREATE TABLE mc.publications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  store_id uuid NOT NULL,
  run_id uuid NOT NULL,
  is_current boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id),
  FOREIGN KEY (business_id, store_id, run_id) REFERENCES mc.calculation_runs(business_id, store_id, id)
);
CREATE UNIQUE INDEX one_current_publication ON mc.publications(store_id) WHERE is_current;

CREATE TABLE mc.billing_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  subscription_id uuid NOT NULL,
  provider_invoice_id text,
  amount numeric(20,4) NOT NULL CHECK (amount > 0),
  currency text NOT NULL DEFAULT 'RUB' CHECK (currency = 'RUB'),
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','paid','void')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, subscription_id) REFERENCES mc.subscriptions(business_id, id),
  CHECK (period_end > period_start)
);
CREATE TABLE mc.billing_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  provider text NOT NULL,
  provider_payment_id text,
  idempotency_key text NOT NULL UNIQUE,
  amount numeric(20,4) NOT NULL CHECK (amount > 0),
  currency text NOT NULL DEFAULT 'RUB' CHECK (currency = 'RUB'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','succeeded','failed','cancelled')),
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  UNIQUE (provider, provider_payment_id),
  FOREIGN KEY (business_id, invoice_id) REFERENCES mc.billing_invoices(business_id, id),
  CHECK ((status = 'succeeded') = (paid_at IS NOT NULL))
);
CREATE TABLE mc.billing_payment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES mc.businesses(id),
  payment_id uuid,
  provider text NOT NULL,
  external_event_id text NOT NULL,
  event_type text NOT NULL,
  safe_payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'received' CHECK (status IN ('received','processed','failed')),
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, external_event_id),
  FOREIGN KEY (business_id, payment_id) REFERENCES mc.billing_payments(business_id, id)
);
CREATE TABLE mc.jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES mc.businesses(id),
  store_id uuid,
  job_type text NOT NULL,
  deduplication_key text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  scheduled_at timestamptz NOT NULL DEFAULT now(),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  lease_until timestamptz,
  worker_id text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, store_id) REFERENCES mc.stores(business_id, id)
);
CREATE UNIQUE INDEX active_job_key ON mc.jobs(business_id, deduplication_key) WHERE status IN ('queued','running');
CREATE INDEX ready_jobs ON mc.jobs(scheduled_at) WHERE status = 'queued';
CREATE TABLE mc.audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES mc.businesses(id),
  store_id uuid,
  actor_user_id uuid REFERENCES mc.users(id),
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid,
  safe_details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, store_id) REFERENCES mc.stores(business_id, id)
);

-- Seed only discussed limits. NULL prices are deliberately unconfigured.
INSERT INTO mc.billing_plans(code, name) VALUES
 ('free','Бесплатный'),('minimum','Минимальный'),('plus','Плюс'),('pro','Про');
INSERT INTO mc.billing_plan_versions(plan_id, version_no, product_limit, store_limit, price, billing_period)
 SELECT id, 1,
   CASE code WHEN 'free' THEN 3 WHEN 'minimum' THEN 10 WHEN 'plus' THEN 100 ELSE 1000 END,
   CASE WHEN code IN ('plus','pro') THEN 2 ELSE 1 END,
   CASE WHEN code = 'free' THEN 0 ELSE NULL END,
   CASE WHEN code = 'free' THEN 'none' ELSE 'month' END
 FROM mc.billing_plans;
INSERT INTO mc.financial_categories(code,name,class,is_promotion) VALUES
 ('revenue','Выручка','income',false),
 ('revenue_return','Возврат выручки','income',false),
 ('commission','Комиссия','expense',false),
 ('logistics','Логистика','expense',false),
 ('storage','Хранение','expense',false),
 ('acceptance','Приёмка','expense',false),
 ('promotion','Продвижение WB','expense',true),
 ('external_promotion','Внешнее продвижение','expense',true),
 ('agency_services','Услуги продвижения','expense',true),
 ('other_external','Прочие внешние расходы','expense',false),
 ('cost_of_goods','Себестоимость','expense',false),
 ('penalty','Штрафы','expense',false),
 ('other_adjustment','Прочие корректировки','expense',false),
 ('payout','Перечисление средств','settlement',false);

-- Functions and integrity triggers follow in the same transaction.
CREATE FUNCTION mc.context_business_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.business_id', true), '')::uuid
$$;
CREATE FUNCTION mc.context_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.user_id', true), '')::uuid
$$;

CREATE FUNCTION mc.reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'immutable record: %.%', TG_TABLE_SCHEMA, TG_TABLE_NAME USING ERRCODE = '23514';
END $$;

-- Prevent moving an identity to another tenant/store/product, including when no
-- child records have been written yet. Only explicitly mutable fields may change.
CREATE FUNCTION mc.protect_columns() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE col text;
BEGIN
  FOREACH col IN ARRAY TG_ARGV LOOP
    IF (to_jsonb(OLD)->col) IS DISTINCT FROM (to_jsonb(NEW)->col) THEN
      RAISE EXCEPTION 'immutable identity column: %.%', TG_TABLE_NAME, col USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;

CREATE FUNCTION mc.assign_free_subscription() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE plan_version uuid;
BEGIN
  SELECT v.id INTO STRICT plan_version
    FROM mc.billing_plan_versions v JOIN mc.billing_plans p ON p.id = v.plan_id
    WHERE p.code = 'free' ORDER BY v.version_no DESC LIMIT 1;
  INSERT INTO mc.subscriptions(business_id, plan_version_id) VALUES (NEW.id, plan_version);
  RETURN NEW;
END $$;
CREATE TRIGGER default_subscription AFTER INSERT ON mc.businesses
  FOR EACH ROW EXECUTE FUNCTION mc.assign_free_subscription();

CREATE FUNCTION mc.record_subscription_event() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO mc.subscription_events(business_id, subscription_id, new_plan_version_id, event_type)
      VALUES (NEW.business_id, NEW.id, NEW.plan_version_id, 'started');
  ELSIF ROW(NEW.plan_version_id,NEW.status,NEW.period_start,NEW.period_end,NEW.cancel_at_period_end)
    IS DISTINCT FROM ROW(OLD.plan_version_id,OLD.status,OLD.period_start,OLD.period_end,OLD.cancel_at_period_end) THEN
    INSERT INTO mc.subscription_events(business_id, subscription_id, previous_plan_version_id, new_plan_version_id, event_type, details)
      VALUES (NEW.business_id, NEW.id, OLD.plan_version_id, NEW.plan_version_id,
        CASE WHEN NEW.plan_version_id <> OLD.plan_version_id THEN 'plan_changed'
             WHEN NEW.status <> OLD.status THEN 'status_changed' ELSE 'renewed' END,
        jsonb_build_object('old_status',OLD.status,'new_status',NEW.status,
          'old_period_end',OLD.period_end,'new_period_end',NEW.period_end,
          'cancel_at_period_end',NEW.cancel_at_period_end));
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER subscription_audit AFTER INSERT OR UPDATE ON mc.subscriptions
  FOR EACH ROW EXECUTE FUNCTION mc.record_subscription_event();

CREATE FUNCTION mc.check_subscription_limits() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE limits mc.billing_plan_versions;
BEGIN
  PERFORM 1 FROM mc.businesses WHERE id = NEW.business_id FOR UPDATE;
  SELECT * INTO STRICT limits FROM mc.billing_plan_versions WHERE id = NEW.plan_version_id;
  IF (SELECT count(*) FROM mc.product_selection_items WHERE business_id = NEW.business_id) > limits.product_limit
    OR (SELECT count(*) FROM mc.stores WHERE business_id = NEW.business_id AND status <> 'archived') > limits.store_limit THEN
    RAISE EXCEPTION 'downgrade below retained products/stores requires a future explicit policy' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER subscription_limits BEFORE UPDATE OF plan_version_id ON mc.subscriptions
  FOR EACH ROW EXECUTE FUNCTION mc.check_subscription_limits();

CREATE FUNCTION mc.check_store_limit() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE max_stores integer;
BEGIN
  PERFORM 1 FROM mc.businesses WHERE id = NEW.business_id FOR UPDATE;
  IF TG_OP = 'UPDATE' AND OLD.status = NEW.status THEN RETURN NEW; END IF;
  IF NEW.status <> 'archived' THEN
    SELECT v.store_limit INTO max_stores FROM mc.subscriptions s
      JOIN mc.billing_plan_versions v ON v.id = s.plan_version_id
      WHERE s.business_id = NEW.business_id AND s.status = 'active'
        AND (s.period_end IS NULL OR s.period_end > now());
    IF max_stores IS NULL THEN RAISE EXCEPTION 'active subscription required' USING ERRCODE = '23514'; END IF;
    IF (SELECT count(*) FROM mc.stores WHERE business_id = NEW.business_id AND status <> 'archived' AND id <> NEW.id) >= max_stores THEN
      RAISE EXCEPTION 'store limit exceeded' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER store_limit BEFORE INSERT OR UPDATE OF status ON mc.stores
  FOR EACH ROW EXECUTE FUNCTION mc.check_store_limit();

CREATE FUNCTION mc.guard_selection() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE current_plan uuid; max_products integer;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status <> 'draft' OR NEW.status <> 'confirmed'
       OR (to_jsonb(OLD) - 'status') IS DISTINCT FROM (to_jsonb(NEW) - 'status') THEN
      RAISE EXCEPTION 'confirmed selection cannot be changed' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  PERFORM 1 FROM mc.businesses WHERE id = NEW.business_id FOR UPDATE;
  SELECT s.plan_version_id,v.product_limit INTO current_plan,max_products
    FROM mc.subscriptions s JOIN mc.billing_plan_versions v ON v.id=s.plan_version_id
    WHERE s.business_id=NEW.business_id AND s.status='active' AND (s.period_end IS NULL OR s.period_end>now());
  IF current_plan IS NULL OR NEW.plan_version_id <> current_plan OR NEW.product_limit_snapshot <> max_products OR NEW.status <> 'draft' THEN
    RAISE EXCEPTION 'selection must use current active plan and start as draft' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM mc.stores WHERE id=NEW.store_id AND business_id=NEW.business_id AND status='active') THEN
    RAISE EXCEPTION 'active store required' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM mc.source_documents WHERE id=NEW.catalog_document_id
      AND business_id=NEW.business_id AND store_id=NEW.store_id AND document_type='catalog'
      AND origin='wb_api' AND completeness='complete') THEN
    RAISE EXCEPTION 'complete WB catalog required before selection' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER selection_guard BEFORE INSERT OR UPDATE ON mc.product_selections
  FOR EACH ROW EXECUTE FUNCTION mc.guard_selection();
CREATE TRIGGER selection_no_delete BEFORE DELETE ON mc.product_selections
  FOR EACH ROW EXECUTE FUNCTION mc.reject_mutation();

CREATE FUNCTION mc.guard_selection_item() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE max_products integer;
BEGIN
  PERFORM 1 FROM mc.businesses WHERE id=NEW.business_id FOR UPDATE;
  IF NOT EXISTS (SELECT 1 FROM mc.product_selections WHERE id=NEW.selection_id
      AND store_id=NEW.store_id AND business_id=NEW.business_id AND status='draft') THEN
    RAISE EXCEPTION 'selection already confirmed or belongs to another store' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM mc.products WHERE id=NEW.product_id
      AND store_id=NEW.store_id AND business_id=NEW.business_id AND status='active') THEN
    RAISE EXCEPTION 'active product from current store required' USING ERRCODE='23514';
  END IF;
  SELECT v.product_limit INTO max_products FROM mc.subscriptions s JOIN mc.billing_plan_versions v ON v.id=s.plan_version_id
    WHERE s.business_id=NEW.business_id AND s.status='active' AND (s.period_end IS NULL OR s.period_end>now());
  IF max_products IS NULL OR (SELECT count(*) FROM mc.product_selection_items WHERE business_id=NEW.business_id) >= max_products THEN
    RAISE EXCEPTION 'product limit exceeded' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER selection_item_guard BEFORE INSERT ON mc.product_selection_items
  FOR EACH ROW EXECUTE FUNCTION mc.guard_selection_item();

CREATE FUNCTION mc.selection_must_be_confirmed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM mc.product_selections s WHERE s.id=NEW.id AND s.status='confirmed'
      AND EXISTS (SELECT 1 FROM mc.product_selection_items i WHERE i.selection_id=s.id)) THEN
    RAISE EXCEPTION 'selection must be nonempty and confirmed in the same transaction' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER selection_commit_check AFTER INSERT OR UPDATE ON mc.product_selections
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION mc.selection_must_be_confirmed();

-- Invoke from the trusted backend after authenticating the session. No browser
-- database connection: app.* session settings are NOT authentication credentials.
CREATE FUNCTION mc.confirm_product_selection(p_store_id uuid, p_catalog_document_id uuid, p_products uuid[])
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, mc AS $$
DECLARE b uuid := mc.context_business_id(); u uuid := mc.context_user_id(); selection_uuid uuid; pv uuid; lim integer;
BEGIN
  IF b IS NULL OR u IS NULL OR NOT EXISTS (SELECT 1 FROM mc.memberships WHERE business_id=b AND user_id=u AND role IN ('owner','editor')) THEN
    RAISE EXCEPTION 'authenticated business editor required' USING ERRCODE='42501';
  END IF;
  PERFORM 1 FROM mc.businesses WHERE id=b FOR UPDATE;
  IF NOT EXISTS (SELECT 1 FROM mc.stores WHERE id=p_store_id AND business_id=b AND status='active') THEN
    RAISE EXCEPTION 'store not available' USING ERRCODE='42501';
  END IF;
  IF p_products IS NULL OR cardinality(p_products)=0 OR array_position(p_products,NULL) IS NOT NULL
      OR cardinality(p_products) <> (SELECT count(DISTINCT x) FROM unnest(p_products) x) THEN
    RAISE EXCEPTION 'provide a nonempty list of distinct products' USING ERRCODE='23514';
  END IF;
  IF EXISTS (SELECT 1 FROM mc.product_selections WHERE store_id=p_store_id) THEN
    RAISE EXCEPTION 'products already selected; replacement is not allowed' USING ERRCODE='23514';
  END IF;
  SELECT s.plan_version_id,v.product_limit INTO pv,lim FROM mc.subscriptions s
    JOIN mc.billing_plan_versions v ON v.id=s.plan_version_id WHERE s.business_id=b;
  INSERT INTO mc.product_selections(business_id,store_id,plan_version_id,catalog_document_id,confirmed_by,product_limit_snapshot)
    VALUES(b,p_store_id,pv,p_catalog_document_id,u,lim) RETURNING id INTO selection_uuid;
  INSERT INTO mc.product_selection_items(business_id,store_id,selection_id,product_id)
    SELECT b,p_store_id,selection_uuid,x FROM unnest(p_products) x;
  UPDATE mc.product_selections SET status='confirmed' WHERE id=selection_uuid;
  RETURN selection_uuid;
END $$;

CREATE FUNCTION mc.guard_report_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('accepted','rejected') OR
    (to_jsonb(OLD)-ARRAY['status','accepted_at']) IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['status','accepted_at']) THEN
    RAISE EXCEPTION 'report version is immutable except validation transition' USING ERRCODE='23514';
  END IF;
  IF NOT ((OLD.status='received' AND NEW.status IN ('validated','rejected'))
     OR (OLD.status='validated' AND NEW.status IN ('accepted','rejected'))) THEN
    RAISE EXCEPTION 'invalid report validation transition' USING ERRCODE='23514';
  END IF;
  IF NEW.status='accepted' AND NOT EXISTS (SELECT 1 FROM mc.source_documents WHERE id=NEW.document_id AND completeness='complete') THEN
    RAISE EXCEPTION 'incomplete document cannot become accepted report' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER report_version_guard BEFORE UPDATE ON mc.report_versions FOR EACH ROW EXECUTE FUNCTION mc.guard_report_version();
CREATE TRIGGER report_version_no_delete BEFORE DELETE ON mc.report_versions FOR EACH ROW EXECUTE FUNCTION mc.reject_mutation();

CREATE FUNCTION mc.guard_new_report_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'received' THEN RAISE EXCEPTION 'report starts as received' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER report_version_insert_guard BEFORE INSERT ON mc.report_versions FOR EACH ROW EXECUTE FUNCTION mc.guard_new_report_version();

CREATE FUNCTION mc.guard_report_row() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st text;
BEGIN
  SELECT status INTO st FROM mc.report_versions WHERE id=NEW.report_version_id FOR UPDATE;
  IF st IS DISTINCT FROM 'received' THEN RAISE EXCEPTION 'rows can only be appended before validation' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER report_row_guard BEFORE INSERT ON mc.report_rows FOR EACH ROW EXECUTE FUNCTION mc.guard_report_row();

CREATE FUNCTION mc.guard_report_pointer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.current_version_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM mc.report_versions
      WHERE id=NEW.current_version_id AND report_id=NEW.id AND status='accepted') THEN
    RAISE EXCEPTION 'current report version must be accepted' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER report_pointer_guard BEFORE UPDATE OF current_version_id ON mc.reports FOR EACH ROW EXECUTE FUNCTION mc.guard_report_pointer();

-- Freeze calculation children when a run finishes. Parent row locks serialize
-- appending evidence versus finishing the same run.
CREATE FUNCTION mc.guard_run_child() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE run_uuid uuid; st text;
BEGIN
  IF TG_TABLE_NAME='result_evidence' THEN
    SELECT run_id INTO run_uuid FROM mc.result_lines WHERE id=NEW.result_line_id;
  ELSE run_uuid := (to_jsonb(NEW)->>'run_id')::uuid;
  END IF;
  SELECT status INTO st FROM mc.calculation_runs WHERE id=run_uuid FOR UPDATE;
  IF st IS DISTINCT FROM 'running' THEN RAISE EXCEPTION 'calculation is sealed' USING ERRCODE='23514'; END IF;
  IF TG_TABLE_NAME='calculation_inputs' THEN
   IF NEW.report_version_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM mc.report_versions WHERE id=NEW.report_version_id AND status='accepted') THEN
      RAISE EXCEPTION 'calculation requires accepted report version' USING ERRCODE='23514';
    END IF;
    IF EXISTS (SELECT 1 FROM mc.calculation_inputs i JOIN mc.report_versions a ON a.id=i.report_version_id
        JOIN mc.report_versions b ON b.report_id=a.report_id WHERE i.run_id=run_uuid AND b.id=NEW.report_version_id) THEN
      RAISE EXCEPTION 'two versions of one report in a calculation' USING ERRCODE='23514';
    END IF;
   END IF;
  END IF;
  IF TG_TABLE_NAME='result_lines' THEN
    IF NOT EXISTS (SELECT 1 FROM mc.financial_categories WHERE code=NEW.category_code AND class IN ('income','expense')) THEN
      RAISE EXCEPTION 'settlement or informational amounts cannot be profit lines' USING ERRCODE='23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM mc.calculation_runs r WHERE r.id=run_uuid AND NEW.accounting_date BETWEEN r.period_start AND r.period_end) THEN
      RAISE EXCEPTION 'result date outside calculation period' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER input_run_guard BEFORE INSERT ON mc.calculation_inputs FOR EACH ROW EXECUTE FUNCTION mc.guard_run_child();
CREATE TRIGGER result_run_guard BEFORE INSERT ON mc.result_lines FOR EACH ROW EXECUTE FUNCTION mc.guard_run_child();
CREATE TRIGGER evidence_run_guard BEFORE INSERT ON mc.result_evidence FOR EACH ROW EXECUTE FUNCTION mc.guard_run_child();

CREATE FUNCTION mc.guard_evidence_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE line mc.result_lines; source_product uuid; source_variant uuid; source_category text;
  source_amount numeric; cost_date date; date_from date; date_to date; source_state text;
BEGIN
  SELECT * INTO STRICT line FROM mc.result_lines WHERE id=NEW.result_line_id;
  IF NEW.financial_component_id IS NOT NULL THEN
    SELECT o.product_id,o.variant_id,f.category_code,f.amount_signed INTO source_product,source_variant,source_category,source_amount
      FROM mc.financial_components f JOIN mc.operation_versions o ON o.id=f.operation_version_id WHERE f.id=NEW.financial_component_id;
    IF source_category IS DISTINCT FROM line.category_code
       OR (line.variant_id IS NOT NULL AND source_variant IS DISTINCT FROM line.variant_id)
       OR NEW.contribution_amount*source_amount < 0 OR abs(NEW.contribution_amount)>abs(source_amount) THEN
      RAISE EXCEPTION 'financial evidence has incompatible category, variant or amount' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.cost_version_id IS NOT NULL THEN
    SELECT c.product_id,c.variant_id,c.effective_from,v.unit_cost INTO source_product,source_variant,cost_date,source_amount
      FROM mc.cost_versions v JOIN mc.variant_costs c ON c.id=v.cost_id WHERE v.id=NEW.cost_version_id;
    IF source_variant IS DISTINCT FROM line.variant_id OR line.category_code <> 'cost_of_goods'
       OR cost_date > line.accounting_date OR NEW.quantity IS NULL
       OR NEW.contribution_amount <> round(-source_amount*NEW.quantity,4) THEN
      RAISE EXCEPTION 'cost evidence must match variant, effective date and quantity' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.expense_version_id IS NOT NULL THEN
    SELECT e.product_id,v.category,v.amount,v.period_start,v.period_end,v.state
      INTO source_product,source_category,source_amount,date_from,date_to,source_state
      FROM mc.expense_versions v JOIN mc.expenses e ON e.id=v.expense_id WHERE v.id=NEW.expense_version_id;
    IF line.variant_id IS NOT NULL OR source_category IS DISTINCT FROM line.category_code OR source_state <> 'active'
       OR line.accounting_date NOT BETWEEN date_from AND date_to
       OR NEW.contribution_amount>0 OR abs(NEW.contribution_amount)>source_amount THEN
      RAISE EXCEPTION 'expense evidence must remain at article level within its period and amount' USING ERRCODE='23514';
    END IF;
  END IF;
  IF source_product IS DISTINCT FROM line.product_id THEN
    RAISE EXCEPTION 'evidence belongs to another product or has no confirmed product link' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER evidence_source_guard BEFORE INSERT ON mc.result_evidence FOR EACH ROW EXECUTE FUNCTION mc.guard_evidence_source();

CREATE FUNCTION mc.guard_run_finish() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'running' OR NEW.status NOT IN ('succeeded','failed')
     OR (to_jsonb(OLD)-ARRAY['status','quality','missing_reasons','finished_at'])
        IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['status','quality','missing_reasons','finished_at']) THEN
    RAISE EXCEPTION 'only finishing a running calculation is allowed' USING ERRCODE='23514';
  END IF;
  IF NEW.status='succeeded' THEN
    IF NOT EXISTS (SELECT 1 FROM mc.calculation_inputs WHERE run_id=NEW.id AND report_version_id IS NOT NULL) THEN
      RAISE EXCEPTION 'successful calculation needs financial inputs' USING ERRCODE='23514';
    END IF;
    IF EXISTS (SELECT 1 FROM mc.result_lines l LEFT JOIN mc.result_evidence e ON e.result_line_id=l.id
        WHERE l.run_id=NEW.id GROUP BY l.id,l.amount_signed
        HAVING count(e.id)=0 OR sum(e.contribution_amount) <> l.amount_signed) THEN
      RAISE EXCEPTION 'result does not reconcile with evidence' USING ERRCODE='23514';
    END IF;
    IF EXISTS (SELECT 1 FROM mc.result_evidence e JOIN mc.result_lines l ON l.id=e.result_line_id
        JOIN mc.financial_components f ON f.id=e.financial_component_id WHERE l.run_id=NEW.id
        GROUP BY f.id,f.amount_signed HAVING abs(sum(e.contribution_amount))>abs(f.amount_signed))
      OR EXISTS (SELECT 1 FROM mc.result_evidence e JOIN mc.result_lines l ON l.id=e.result_line_id
        JOIN mc.expense_versions v ON v.id=e.expense_version_id WHERE l.run_id=NEW.id
        GROUP BY v.id,v.amount HAVING abs(sum(e.contribution_amount))>v.amount) THEN
      RAISE EXCEPTION 'source amount counted more than once' USING ERRCODE='23514';
    END IF;
    IF EXISTS (SELECT 1 FROM mc.result_evidence e JOIN mc.result_lines l ON l.id=e.result_line_id
        LEFT JOIN mc.financial_components f ON f.id=e.financial_component_id
        LEFT JOIN mc.operation_versions o ON o.id=f.operation_version_id
        LEFT JOIN mc.report_rows rr ON rr.id=o.report_row_id
        WHERE l.run_id=NEW.id AND NOT EXISTS (SELECT 1 FROM mc.calculation_inputs i WHERE i.run_id=NEW.id
          AND ((e.cost_version_id IS NOT NULL AND i.cost_version_id=e.cost_version_id)
            OR (e.expense_version_id IS NOT NULL AND i.expense_version_id=e.expense_version_id)
            OR (e.financial_component_id IS NOT NULL AND i.report_version_id=rr.report_version_id)))) THEN
      RAISE EXCEPTION 'evidence source missing from calculation inputs' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER run_finish_guard BEFORE UPDATE ON mc.calculation_runs FOR EACH ROW EXECUTE FUNCTION mc.guard_run_finish();
CREATE TRIGGER run_no_delete BEFORE DELETE ON mc.calculation_runs FOR EACH ROW EXECUTE FUNCTION mc.reject_mutation();

CREATE FUNCTION mc.guard_publication() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF OLD.is_current IS NOT TRUE OR NEW.is_current IS NOT FALSE OR
      (to_jsonb(OLD)-'is_current') IS DISTINCT FROM (to_jsonb(NEW)-'is_current') THEN
      RAISE EXCEPTION 'publication can only be superseded' USING ERRCODE='23514';
    END IF;
  ELSIF NOT EXISTS (SELECT 1 FROM mc.calculation_runs WHERE id=NEW.run_id AND status='succeeded') THEN
    RAISE EXCEPTION 'only successful runs may be published' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER publication_guard BEFORE INSERT OR UPDATE ON mc.publications FOR EACH ROW EXECUTE FUNCTION mc.guard_publication();
CREATE TRIGGER publication_no_delete BEFORE DELETE ON mc.publications FOR EACH ROW EXECUTE FUNCTION mc.reject_mutation();

-- Append-only history and stable parent identities.
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['billing_plan_versions','subscription_events','source_objects','product_selection_items',
    'cost_versions','expense_versions','report_rows','operations','operation_versions','financial_components',
    'method_versions','calculation_inputs','result_lines','result_evidence','audit_events'] LOOP
    EXECUTE format('CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON mc.%I FOR EACH ROW EXECUTE FUNCTION mc.reject_mutation()',t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['businesses','stores','products','variants','variant_costs','expenses','reports','subscriptions'] LOOP
    EXECUTE format('CREATE TRIGGER no_delete BEFORE DELETE ON mc.%I FOR EACH ROW EXECUTE FUNCTION mc.reject_mutation()',t);
  END LOOP;
END $$;
CREATE TRIGGER store_identity BEFORE UPDATE ON mc.stores FOR EACH ROW EXECUTE FUNCTION mc.protect_columns('id','business_id','marketplace_code','external_account_id');
CREATE TRIGGER product_identity BEFORE UPDATE ON mc.products FOR EACH ROW EXECUTE FUNCTION mc.protect_columns('id','business_id','store_id','wb_article');
CREATE TRIGGER variant_identity BEFORE UPDATE ON mc.variants FOR EACH ROW EXECUTE FUNCTION mc.protect_columns('id','business_id','store_id','product_id','external_variant_id');
CREATE TRIGGER cost_identity BEFORE UPDATE ON mc.variant_costs FOR EACH ROW EXECUTE FUNCTION mc.protect_columns('id','business_id','store_id','product_id','variant_id','effective_from');
CREATE TRIGGER expense_identity BEFORE UPDATE ON mc.expenses FOR EACH ROW EXECUTE FUNCTION mc.protect_columns('id','business_id','store_id','product_id','external_entry_key');
CREATE TRIGGER report_identity BEFORE UPDATE ON mc.reports FOR EACH ROW EXECUTE FUNCTION mc.protect_columns('id','business_id','store_id','external_report_id','report_type','period_start','period_end');
CREATE TRIGGER subscription_identity BEFORE UPDATE ON mc.subscriptions FOR EACH ROW EXECUTE FUNCTION mc.protect_columns('id','business_id');
CREATE TRIGGER import_identity BEFORE UPDATE ON mc.import_batches FOR EACH ROW EXECUTE FUNCTION mc.protect_columns('id','business_id','store_id','document_id','kind','uploaded_by');
CREATE TRIGGER source_identity BEFORE UPDATE ON mc.source_documents FOR EACH ROW EXECUTE FUNCTION mc.protect_columns('id','business_id','store_id','sync_run_id','origin','document_type','external_document_id','checksum','received_at');

CREATE FUNCTION mc.audit_user_data_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
    INSERT INTO mc.audit_events(business_id,store_id,actor_user_id,action,entity_type,entity_id,safe_details)
      VALUES(NEW.business_id,NEW.store_id,mc.context_user_id(),'updated',TG_TABLE_NAME,NEW.id,
        jsonb_build_object('before',to_jsonb(OLD),'after',to_jsonb(NEW)));
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER product_change_audit AFTER UPDATE ON mc.products FOR EACH ROW EXECUTE FUNCTION mc.audit_user_data_change();
CREATE TRIGGER variant_change_audit AFTER UPDATE ON mc.variants FOR EACH ROW EXECUTE FUNCTION mc.audit_user_data_change();
CREATE TRIGGER cost_change_audit AFTER UPDATE ON mc.variant_costs FOR EACH ROW EXECUTE FUNCTION mc.audit_user_data_change();
CREATE TRIGGER expense_change_audit AFTER UPDATE ON mc.expenses FOR EACH ROW EXECUTE FUNCTION mc.audit_user_data_change();

-- Tenant policies need a trusted backend that authenticates users, checks
-- membership, and uses SET LOCAL in a transaction. No grants to PUBLIC.
DO $$ DECLARE t text; BEGIN
  FOR t IN SELECT table_name FROM information_schema.columns
      WHERE table_schema='mc' AND column_name='business_id' LOOP
    EXECUTE format('ALTER TABLE mc.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE mc.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY tenant_isolation ON mc.%I USING (business_id=mc.context_business_id()) WITH CHECK (business_id=mc.context_business_id())',t);
    EXECUTE format('CREATE INDEX ON mc.%I (business_id)',t);
  END LOOP;
END $$;
ALTER TABLE mc.businesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE mc.businesses FORCE ROW LEVEL SECURITY;
CREATE POLICY own_business ON mc.businesses USING (id=mc.context_business_id()) WITH CHECK (id=mc.context_business_id());
ALTER TABLE mc.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE mc.users FORCE ROW LEVEL SECURITY;
CREATE POLICY own_user ON mc.users USING (id=mc.context_user_id()) WITH CHECK (id=mc.context_user_id());
ALTER TABLE mc.auth_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE mc.auth_identities FORCE ROW LEVEL SECURITY;
CREATE POLICY own_identity ON mc.auth_identities USING (user_id=mc.context_user_id()) WITH CHECK (user_id=mc.context_user_id());

CREATE INDEX operations_by_date ON mc.operation_versions(business_id,store_id,accounting_date);
CREATE INDEX operations_by_srid ON mc.operation_versions(store_id,srid) WHERE srid IS NOT NULL;
CREATE INDEX result_period ON mc.result_lines(business_id,store_id,run_id,accounting_date,product_id);
CREATE INDEX result_evidence_line ON mc.result_evidence(result_line_id);
CREATE INDEX cost_lookup ON mc.variant_costs(store_id,variant_id,effective_from DESC);
CREATE INDEX expense_lookup ON mc.expense_versions(store_id,period_start,period_end);

-- Selected-product read models. Never expose raw report tables to end users.
CREATE VIEW mc.store_entitlements WITH (security_invoker=true) AS
  SELECT st.business_id,st.id AS store_id,s.plan_version_id
    FROM mc.stores st JOIN mc.subscriptions s ON s.business_id=st.business_id
    WHERE st.status='active' AND s.status='active' AND (s.period_end IS NULL OR s.period_end>now());
CREATE VIEW mc.selected_products WITH (security_invoker=true) AS
  SELECT p.*, i.selection_id FROM mc.products p JOIN mc.product_selection_items i
    ON (i.business_id,i.store_id,i.product_id)=(p.business_id,p.store_id,p.id)
    JOIN mc.store_entitlements e ON (e.business_id,e.store_id)=(p.business_id,p.store_id);
CREATE VIEW mc.current_daily_results WITH (security_invoker=true) AS
  SELECT l.business_id,l.store_id,p.id AS publication_id,l.product_id,l.accounting_date,
    l.category_code,l.currency,sum(l.amount_signed) AS amount_signed
  FROM mc.publications p JOIN mc.result_lines l ON l.run_id=p.run_id
    JOIN mc.store_entitlements e ON (e.business_id,e.store_id)=(p.business_id,p.store_id)
  WHERE p.is_current GROUP BY l.business_id,l.store_id,p.id,l.product_id,l.accounting_date,l.category_code,l.currency;

REVOKE ALL ON SCHEMA mc FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA mc FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA mc FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA mc REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
INSERT INTO mc.schema_migrations(version) VALUES(1);
COMMIT;
