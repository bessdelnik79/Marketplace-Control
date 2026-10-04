BEGIN;
ALTER TABLE mc.operational_daily_metrics ADD COLUMN cancel_count bigint CHECK(cancel_count>=0), ADD COLUMN cancel_amount numeric(20,4) CHECK(cancel_amount>=0);
ALTER TABLE mc.operational_daily_metrics ADD CONSTRAINT operational_cancel_pair CHECK((cancel_count IS NULL)=(cancel_amount IS NULL));
CREATE TABLE mc.operational_range_requests (
 business_id uuid NOT NULL,store_id uuid NOT NULL,metric_date date NOT NULL CHECK(isfinite(metric_date)),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','complete','failed')),requested_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(store_id,metric_date), FOREIGN KEY(business_id,store_id) REFERENCES mc.stores(business_id,id)
);
ALTER TABLE mc.operational_range_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE mc.operational_range_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mc.operational_range_requests USING(business_id=mc.context_business_id()) WITH CHECK(business_id=mc.context_business_id());
CREATE INDEX operational_range_requests_pending ON mc.operational_range_requests(business_id,store_id,metric_date DESC) WHERE status='pending';
CREATE OR REPLACE VIEW mc.current_operational_daily_metrics WITH (security_invoker=true) AS
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
       (m.id IS NOT NULL) AS available,c.quality,c.missing_reasons,c.fetched_at,c.accepted_at,m.cancel_count,m.cancel_amount
  FROM candidates c
  LEFT JOIN mc.operational_daily_metrics m
    ON m.business_id=c.business_id AND m.store_id=c.store_id AND m.snapshot_id=c.snapshot_id
   AND m.product_id=c.product_id AND m.metric_date=c.metric_date
 WHERE c.freshness_rank=1;


INSERT INTO mc.schema_migrations(version) VALUES(67);
COMMIT;
