BEGIN;

ALTER TABLE mc.sync_streams DROP CONSTRAINT sync_streams_source_type_check;
ALTER TABLE mc.sync_streams ADD CONSTRAINT sync_streams_source_type_check
  CHECK (source_type IN ('catalog','financial_reports','operational_sales_funnel'));

-- Migration DDL already requires table ownership. Temporarily remove FORCE so
-- that the owner can backfill all existing tenants inside this one transaction.
ALTER TABLE mc.stores NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.connections NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.sync_streams NO FORCE ROW LEVEL SECURITY;
INSERT INTO mc.sync_streams(business_id,store_id,source_type,next_run_at,status)
SELECT s.business_id,s.id,'operational_sales_funnel',now(),'active'
  FROM mc.stores s
  JOIN mc.connections c ON c.business_id=s.business_id AND c.store_id=s.id AND c.status='active'
 WHERE s.marketplace_code='wb' AND s.status='active'
ON CONFLICT(store_id,source_type) DO NOTHING;
ALTER TABLE mc.stores FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.connections FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.sync_streams FORCE ROW LEVEL SECURITY;

CREATE TABLE mc.operational_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  store_id uuid NOT NULL,
  source_code text NOT NULL DEFAULT 'wb_sales_funnel_v3' CHECK (source_code='wb_sales_funnel_v3'),
  period_start date NOT NULL CHECK (isfinite(period_start)),
  period_end date NOT NULL CHECK (isfinite(period_end)),
  current_snapshot_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id,store_id,id),
  UNIQUE (store_id,source_code,period_start,period_end),
  FOREIGN KEY (business_id,store_id) REFERENCES mc.stores(business_id,id),
  CHECK (period_end>=period_start AND period_end<=period_start+6)
);

CREATE TABLE mc.operational_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  store_id uuid NOT NULL,
  operational_period_id uuid NOT NULL,
  document_id uuid NOT NULL,
  version_no integer NOT NULL CHECK (version_no>0),
  checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  parser_version text NOT NULL CHECK (length(trim(parser_version))>0),
  source_timezone text NOT NULL DEFAULT 'Europe/Moscow' CHECK (source_timezone='Europe/Moscow'),
  fetched_at timestamptz NOT NULL,
  quality text NOT NULL CHECK (quality IN ('complete','partial','unavailable')),
  missing_reasons jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(missing_reasons)='array'),
  status text NOT NULL DEFAULT 'received' CHECK (status IN ('received','validated','accepted','rejected')),
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id,store_id,id),
  UNIQUE (business_id,store_id,operational_period_id,id),
  UNIQUE (operational_period_id,version_no),
  UNIQUE (operational_period_id,checksum),
  UNIQUE (document_id),
  FOREIGN KEY (business_id,store_id,operational_period_id) REFERENCES mc.operational_periods(business_id,store_id,id),
  FOREIGN KEY (business_id,store_id,document_id) REFERENCES mc.source_documents(business_id,store_id,id),
  CHECK ((status='accepted')=(accepted_at IS NOT NULL)),
  CHECK ((quality='complete' AND missing_reasons='[]'::jsonb)
      OR (quality IN ('partial','unavailable') AND jsonb_array_length(missing_reasons)>0))
);

ALTER TABLE mc.operational_periods ADD CONSTRAINT operational_period_current_snapshot_fk
  FOREIGN KEY (business_id,store_id,id,current_snapshot_id)
  REFERENCES mc.operational_snapshots(business_id,store_id,operational_period_id,id);

CREATE TABLE mc.operational_snapshot_activations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  store_id uuid NOT NULL,
  operational_period_id uuid NOT NULL,
  snapshot_id uuid NOT NULL,
  document_id uuid NOT NULL,
  fetched_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id,store_id,id),
  UNIQUE (document_id),
  FOREIGN KEY (business_id,store_id,operational_period_id,snapshot_id)
    REFERENCES mc.operational_snapshots(business_id,store_id,operational_period_id,id),
  FOREIGN KEY (business_id,store_id,document_id) REFERENCES mc.source_documents(business_id,store_id,id)
);

CREATE TABLE mc.operational_snapshot_products (
  business_id uuid NOT NULL,
  store_id uuid NOT NULL,
  snapshot_id uuid NOT NULL,
  product_id uuid NOT NULL,
  request_position integer NOT NULL CHECK (request_position>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (snapshot_id,product_id),
  UNIQUE (snapshot_id,request_position),
  UNIQUE (business_id,store_id,snapshot_id,product_id),
  FOREIGN KEY (business_id,store_id,snapshot_id) REFERENCES mc.operational_snapshots(business_id,store_id,id),
  FOREIGN KEY (business_id,store_id,product_id) REFERENCES mc.product_selection_items(business_id,store_id,product_id)
);

CREATE TABLE mc.operational_daily_metrics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  store_id uuid NOT NULL,
  snapshot_id uuid NOT NULL,
  product_id uuid NOT NULL,
  metric_date date NOT NULL CHECK (isfinite(metric_date)),
  currency text NOT NULL CHECK (currency='RUB'),
  order_count bigint NOT NULL CHECK (order_count>=0),
  order_amount numeric(20,4) NOT NULL CHECK (order_amount>=0),
  buyout_count bigint NOT NULL CHECK (buyout_count>=0),
  buyout_amount numeric(20,4) NOT NULL CHECK (buyout_amount>=0),
  row_checksum text NOT NULL CHECK (row_checksum ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id,store_id,id),
  UNIQUE (snapshot_id,product_id,metric_date),
  FOREIGN KEY (business_id,store_id,snapshot_id,product_id)
    REFERENCES mc.operational_snapshot_products(business_id,store_id,snapshot_id,product_id)
);

CREATE INDEX source_documents_operational_latest ON mc.source_documents(business_id,store_id,received_at DESC)
  WHERE origin='wb_api' AND document_type='operational_sales_funnel';
CREATE INDEX operational_periods_current ON mc.operational_periods(business_id,store_id,period_end DESC)
  WHERE current_snapshot_id IS NOT NULL;
CREATE INDEX operational_snapshots_period_created ON mc.operational_snapshots(operational_period_id,created_at DESC);
CREATE INDEX operational_activations_freshness ON mc.operational_snapshot_activations(business_id,store_id,fetched_at DESC);
CREATE INDEX operational_daily_by_snapshot_date ON mc.operational_daily_metrics(snapshot_id,metric_date,product_id);
CREATE INDEX operational_daily_product_history ON mc.operational_daily_metrics(business_id,store_id,product_id,metric_date,snapshot_id);
CREATE INDEX operational_periods_business ON mc.operational_periods(business_id);
CREATE INDEX operational_snapshots_business ON mc.operational_snapshots(business_id);
CREATE INDEX operational_snapshot_activations_business ON mc.operational_snapshot_activations(business_id);
CREATE INDEX operational_snapshot_products_business ON mc.operational_snapshot_products(business_id);
CREATE INDEX operational_daily_metrics_business ON mc.operational_daily_metrics(business_id);

CREATE VIEW mc.current_operational_daily_metrics WITH (security_invoker=true) AS
WITH candidates AS (
  SELECT sp.business_id,sp.store_id,sp.product_id,day_value::date AS metric_date,
         s.id AS snapshot_id,s.quality,s.missing_reasons,a.fetched_at,s.accepted_at,
         row_number() OVER(
           PARTITION BY sp.business_id,sp.store_id,sp.product_id,day_value::date
           ORDER BY a.fetched_at DESC,a.created_at DESC,a.id DESC
         ) AS freshness_rank
    FROM mc.operational_snapshot_activations a
    JOIN mc.operational_snapshots s ON s.business_id=a.business_id AND s.store_id=a.store_id AND s.id=a.snapshot_id
    JOIN mc.operational_periods p ON p.business_id=s.business_id AND p.store_id=s.store_id AND p.id=s.operational_period_id
    JOIN mc.operational_snapshot_products sp ON sp.business_id=s.business_id AND sp.store_id=s.store_id AND sp.snapshot_id=s.id
    CROSS JOIN LATERAL generate_series(p.period_start,p.period_end,interval '1 day') day_value
   WHERE s.status='accepted'
)
SELECT c.business_id,c.store_id,c.product_id,c.metric_date,c.snapshot_id,
       m.currency,m.order_count,m.order_amount,m.buyout_count,m.buyout_amount,
       (m.id IS NOT NULL) AS available,c.quality,c.missing_reasons,c.fetched_at,c.accepted_at
  FROM candidates c
  LEFT JOIN mc.operational_daily_metrics m
    ON m.business_id=c.business_id AND m.store_id=c.store_id AND m.snapshot_id=c.snapshot_id
   AND m.product_id=c.product_id AND m.metric_date=c.metric_date
 WHERE c.freshness_rank=1;

CREATE FUNCTION mc.guard_operational_snapshot_children() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE snapshot_status text;
BEGIN
  SELECT status INTO snapshot_status FROM mc.operational_snapshots WHERE id=NEW.snapshot_id FOR UPDATE;
  IF snapshot_status IS DISTINCT FROM 'received' THEN
    RAISE EXCEPTION 'operational snapshot is sealed' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION mc.guard_operational_snapshot_activation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM mc.operational_snapshots s WHERE s.id=NEW.snapshot_id AND s.status='accepted') THEN
    RAISE EXCEPTION 'operational activation requires accepted snapshot' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION mc.guard_operational_snapshot_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status<>'received' OR NEW.accepted_at IS NOT NULL THEN
    RAISE EXCEPTION 'operational snapshot must start received' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION mc.validate_operational_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  scope_count integer;
  metric_count integer;
  expected_count integer;
  period_from date;
  period_to date;
BEGIN
  IF OLD.status='received' AND NEW.status='validated' THEN
    IF NEW.accepted_at IS NOT NULL THEN RAISE EXCEPTION 'validated snapshot cannot be accepted' USING ERRCODE='23514'; END IF;
    SELECT p.period_start,p.period_end INTO period_from,period_to
      FROM mc.operational_periods p WHERE p.id=NEW.operational_period_id;
    IF NOT EXISTS(
      SELECT 1 FROM mc.source_documents d
      JOIN mc.sync_runs r ON r.business_id=d.business_id AND r.store_id=d.store_id AND r.id=d.sync_run_id
      JOIN mc.sync_streams s ON s.business_id=r.business_id AND s.store_id=r.store_id AND s.id=r.stream_id
      WHERE d.id=NEW.document_id AND d.business_id=NEW.business_id AND d.store_id=NEW.store_id
        AND d.origin='wb_api' AND d.document_type='operational_sales_funnel' AND d.completeness='complete'
        AND r.status='running' AND s.source_type='operational_sales_funnel'
    ) THEN RAISE EXCEPTION 'invalid operational source document' USING ERRCODE='23514'; END IF;
    IF NOT EXISTS(SELECT 1 FROM mc.source_objects o WHERE o.document_id=NEW.document_id)
      OR EXISTS(SELECT 1 FROM mc.source_objects o WHERE o.document_id=NEW.document_id AND (
        o.byte_size<33 OR o.content_type<>'application/json+gzip+aes-256-gcm'
        OR lower(o.storage_key)<>lower(NEW.business_id::text||'/'||NEW.store_id::text||'/operational-snapshots/'||NEW.id::text||'/part-'||lpad(o.part_number::text,4,'0')||'.json.gz.enc')
      ))
      OR (SELECT min(o.part_number)<>0 OR max(o.part_number)<>count(*)-1 FROM mc.source_objects o WHERE o.document_id=NEW.document_id)
      THEN RAISE EXCEPTION 'invalid protected operational source object' USING ERRCODE='23514'; END IF;
    SELECT count(*)::int INTO scope_count FROM mc.operational_snapshot_products WHERE snapshot_id=NEW.id;
    SELECT count(*)::int INTO metric_count FROM mc.operational_daily_metrics WHERE snapshot_id=NEW.id;
    IF scope_count=0 THEN RAISE EXCEPTION 'operational scope is empty' USING ERRCODE='23514'; END IF;
    IF EXISTS(SELECT 1 FROM mc.operational_daily_metrics WHERE snapshot_id=NEW.id AND metric_date NOT BETWEEN period_from AND period_to)
      THEN RAISE EXCEPTION 'operational metric outside period' USING ERRCODE='23514'; END IF;
    expected_count:=scope_count*(period_to-period_from+1);
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.missing_reasons) reason
      WHERE jsonb_typeof(reason)<>'string' OR reason #>> '{}' NOT IN ('selected_product_missing','metric_date_missing','source_empty'))
      THEN RAISE EXCEPTION 'invalid operational missing reason' USING ERRCODE='23514'; END IF;
    IF NEW.quality='complete' AND metric_count<>expected_count
      THEN RAISE EXCEPTION 'complete operational snapshot has coverage gaps' USING ERRCODE='23514'; END IF;
    IF NEW.quality='partial' AND (metric_count<=0 OR metric_count>=expected_count)
      THEN RAISE EXCEPTION 'partial operational snapshot has invalid coverage' USING ERRCODE='23514'; END IF;
    IF NEW.quality='unavailable' AND (metric_count<>0 OR NOT NEW.missing_reasons ? 'source_empty')
      THEN RAISE EXCEPTION 'unavailable operational snapshot has invalid coverage' USING ERRCODE='23514'; END IF;
  ELSIF OLD.status='validated' AND NEW.status='accepted' THEN
    IF NEW.accepted_at IS NULL THEN RAISE EXCEPTION 'accepted snapshot needs timestamp' USING ERRCODE='23514'; END IF;
  ELSIF OLD.status='received' AND NEW.status='rejected' THEN
    IF NEW.accepted_at IS NOT NULL THEN RAISE EXCEPTION 'rejected snapshot cannot be accepted' USING ERRCODE='23514'; END IF;
  ELSE
    RAISE EXCEPTION 'invalid operational snapshot transition' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION mc.guard_operational_current_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.current_snapshot_id IS NULL THEN
    RAISE EXCEPTION 'operational current snapshot cannot be cleared' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM mc.operational_snapshots s
    WHERE s.id=NEW.current_snapshot_id AND s.operational_period_id=NEW.id AND s.status='accepted') THEN
    RAISE EXCEPTION 'operational current snapshot must be accepted' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER operational_period_identity BEFORE UPDATE ON mc.operational_periods FOR EACH ROW
  EXECUTE FUNCTION mc.protect_columns('id','business_id','store_id','source_code','period_start','period_end','created_at');
CREATE TRIGGER operational_period_pointer BEFORE UPDATE OF current_snapshot_id ON mc.operational_periods FOR EACH ROW
  WHEN (OLD.current_snapshot_id IS DISTINCT FROM NEW.current_snapshot_id)
  EXECUTE FUNCTION mc.guard_operational_current_snapshot();
CREATE TRIGGER operational_period_no_delete BEFORE DELETE ON mc.operational_periods FOR EACH ROW EXECUTE FUNCTION mc.reject_mutation();
CREATE TRIGGER operational_snapshot_identity BEFORE UPDATE ON mc.operational_snapshots FOR EACH ROW
  EXECUTE FUNCTION mc.protect_columns('id','business_id','store_id','operational_period_id','document_id','version_no','checksum','parser_version','source_timezone','fetched_at','quality','missing_reasons','created_at');
CREATE TRIGGER operational_snapshot_insert BEFORE INSERT ON mc.operational_snapshots FOR EACH ROW EXECUTE FUNCTION mc.guard_operational_snapshot_insert();
CREATE TRIGGER operational_snapshot_transition BEFORE UPDATE ON mc.operational_snapshots FOR EACH ROW EXECUTE FUNCTION mc.validate_operational_snapshot();
CREATE TRIGGER operational_snapshot_no_delete BEFORE DELETE ON mc.operational_snapshots FOR EACH ROW EXECUTE FUNCTION mc.reject_mutation();
CREATE TRIGGER operational_activation_insert BEFORE INSERT ON mc.operational_snapshot_activations FOR EACH ROW EXECUTE FUNCTION mc.guard_operational_snapshot_activation();
CREATE TRIGGER operational_activation_immutable BEFORE UPDATE OR DELETE ON mc.operational_snapshot_activations FOR EACH ROW EXECUTE FUNCTION mc.reject_mutation();
CREATE TRIGGER operational_scope_insert BEFORE INSERT ON mc.operational_snapshot_products FOR EACH ROW EXECUTE FUNCTION mc.guard_operational_snapshot_children();
CREATE TRIGGER operational_scope_immutable BEFORE UPDATE OR DELETE ON mc.operational_snapshot_products FOR EACH ROW EXECUTE FUNCTION mc.reject_mutation();
CREATE TRIGGER operational_metric_insert BEFORE INSERT ON mc.operational_daily_metrics FOR EACH ROW EXECUTE FUNCTION mc.guard_operational_snapshot_children();
CREATE TRIGGER operational_metric_immutable BEFORE UPDATE OR DELETE ON mc.operational_daily_metrics FOR EACH ROW EXECUTE FUNCTION mc.reject_mutation();

ALTER TABLE mc.operational_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE mc.operational_periods FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mc.operational_periods USING (business_id=mc.context_business_id()) WITH CHECK (business_id=mc.context_business_id());
ALTER TABLE mc.operational_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE mc.operational_snapshots FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mc.operational_snapshots USING (business_id=mc.context_business_id()) WITH CHECK (business_id=mc.context_business_id());
ALTER TABLE mc.operational_snapshot_activations ENABLE ROW LEVEL SECURITY;
ALTER TABLE mc.operational_snapshot_activations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mc.operational_snapshot_activations USING (business_id=mc.context_business_id()) WITH CHECK (business_id=mc.context_business_id());
ALTER TABLE mc.operational_snapshot_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE mc.operational_snapshot_products FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mc.operational_snapshot_products USING (business_id=mc.context_business_id()) WITH CHECK (business_id=mc.context_business_id());
ALTER TABLE mc.operational_daily_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE mc.operational_daily_metrics FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mc.operational_daily_metrics USING (business_id=mc.context_business_id()) WITH CHECK (business_id=mc.context_business_id());

INSERT INTO mc.schema_migrations(version) VALUES(20);
COMMIT;
