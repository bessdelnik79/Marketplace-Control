BEGIN;
ALTER TABLE mc.operational_daily_metrics
 ADD COLUMN return_count bigint CHECK(return_count>=0),
 ADD COLUMN return_amount numeric(20,4) CHECK(return_amount>=0),
 ADD CONSTRAINT operational_return_amount_requires_count CHECK(return_amount IS NULL OR return_count IS NOT NULL);

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
       (m.id IS NOT NULL) AS available,c.quality,c.missing_reasons,c.fetched_at,c.accepted_at,m.cancel_count,m.cancel_amount,m.return_count,m.return_amount
  FROM candidates c
  LEFT JOIN mc.operational_daily_metrics m
    ON m.business_id=c.business_id AND m.store_id=c.store_id AND m.snapshot_id=c.snapshot_id
   AND m.product_id=c.product_id AND m.metric_date=c.metric_date
 WHERE c.freshness_rank=1;

-- Old funnel cancellations are not purchased-return evidence. Re-fetch the
-- default display and four preceding weeks without changing accepted snapshots.
ALTER TABLE mc.stores NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.connections NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.memberships NO FORCE ROW LEVEL SECURITY;
DO $requeue$
DECLARE target record; actor uuid;
 prior_business text:=current_setting('app.business_id',true); prior_user text:=current_setting('app.user_id',true);
 today date:=(clock_timestamp() at time zone 'Europe/Moscow')::date;
BEGIN
 FOR target IN SELECT s.business_id,s.id FROM mc.stores s
   JOIN mc.connections c ON c.business_id=s.business_id AND c.store_id=s.id AND c.status='active'
   WHERE s.status='active' AND s.marketplace_code='wb' AND c.scopes ? 'analytics' AND c.scopes ? 'statistics'
   ORDER BY s.business_id,s.id
 LOOP
   SELECT user_id INTO actor FROM mc.memberships WHERE business_id=target.business_id AND role IN ('owner','editor')
    ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END,created_at,user_id LIMIT 1;
   IF actor IS NULL THEN CONTINUE; END IF;
   PERFORM set_config('app.business_id',target.business_id::text,true);
   PERFORM set_config('app.user_id',actor::text,true);
   IF NOT EXISTS(SELECT 1 FROM mc.product_selections WHERE business_id=target.business_id AND store_id=target.id AND status='confirmed') THEN CONTINUE; END IF;
   INSERT INTO mc.operational_range_requests(business_id,store_id,metric_date,status)
    SELECT target.business_id,target.id,day::date,'pending' FROM generate_series(today-34,today,interval '1 day') day
    ON CONFLICT(store_id,metric_date) DO UPDATE SET status='pending',retryable=false,requested_at=clock_timestamp();
   INSERT INTO mc.sync_streams(business_id,store_id,source_type,status,next_run_at)
    VALUES(target.business_id,target.id,'operational_sales_funnel','active',clock_timestamp())
    ON CONFLICT(store_id,source_type) DO UPDATE SET next_run_at=clock_timestamp()
      WHERE mc.sync_streams.status='active';
 END LOOP;
 PERFORM set_config('app.business_id',coalesce(prior_business,''),true);
 PERFORM set_config('app.user_id',coalesce(prior_user,''),true);
END $requeue$;
ALTER TABLE mc.stores FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.connections FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.memberships FORCE ROW LEVEL SECURITY;
INSERT INTO mc.schema_migrations(version) VALUES(69);
COMMIT;
