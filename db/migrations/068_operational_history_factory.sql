BEGIN;

CREATE TABLE mc.operational_history_factories (
 business_id uuid NOT NULL,store_id uuid PRIMARY KEY,
 period_start date NOT NULL CHECK(isfinite(period_start)),
 period_end date NOT NULL CHECK(isfinite(period_end)),
 requested_at timestamptz NOT NULL DEFAULT now(),
 CHECK(period_end=period_start+29),
 FOREIGN KEY(business_id,store_id) REFERENCES mc.stores(business_id,id)
);
ALTER TABLE mc.operational_history_factories ENABLE ROW LEVEL SECURITY;
ALTER TABLE mc.operational_history_factories FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mc.operational_history_factories
 USING(business_id=mc.context_business_id()) WITH CHECK(business_id=mc.context_business_id());

-- Initial completion survives later manual refreshes of the same day.
ALTER TABLE mc.operational_range_requests
 ADD COLUMN initial_status text CHECK(initial_status IN ('pending','complete','failed')),
 ADD COLUMN retryable boolean NOT NULL DEFAULT false;

INSERT INTO mc.schema_migrations(version) VALUES(68);
COMMIT;
