BEGIN;

CREATE TABLE mc.sku_order_sync_state (
 business_id uuid NOT NULL, store_id uuid PRIMARY KEY,
 orders_cursor text, sales_cursor text, scope_signature text,
 next_run_at timestamptz NOT NULL DEFAULT now(), observed_at timestamptz,
 last_error_code text, updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(business_id,store_id) REFERENCES mc.stores(business_id,id) DEFERRABLE INITIALLY IMMEDIATE
);
CREATE TABLE mc.sku_order_batches (
 id uuid PRIMARY KEY, business_id uuid NOT NULL, store_id uuid NOT NULL,
 observed_at timestamptz NOT NULL, credential_generation bigint NOT NULL CHECK(credential_generation>=0),
 source_from date NOT NULL, UNIQUE(business_id,store_id,id),
 FOREIGN KEY(business_id,store_id) REFERENCES mc.stores(business_id,id) DEFERRABLE INITIALLY IMMEDIATE
);
CREATE TABLE mc.sku_order_source_objects (
 business_id uuid NOT NULL, store_id uuid NOT NULL, batch_id uuid NOT NULL, part_no integer NOT NULL CHECK(part_no>=0),
 endpoint text NOT NULL CHECK(endpoint IN ('orders','sales')), storage_key text NOT NULL,
 checksum text NOT NULL CHECK(checksum~'^[0-9a-f]{64}$'), byte_size bigint NOT NULL CHECK(byte_size>0),
 PRIMARY KEY(business_id,store_id,batch_id,part_no),
 FOREIGN KEY(business_id,store_id,batch_id) REFERENCES mc.sku_order_batches(business_id,store_id,id) DEFERRABLE INITIALLY IMMEDIATE
);
CREATE TABLE mc.sku_order_identities (
 business_id uuid NOT NULL, store_id uuid NOT NULL, srid text NOT NULL CHECK(length(srid) BETWEEN 1 AND 512),
 product_id uuid NOT NULL, ordered_at timestamptz NOT NULL, batch_id uuid NOT NULL,
 PRIMARY KEY(business_id,store_id,srid),
 FOREIGN KEY(business_id,store_id,product_id) REFERENCES mc.products(business_id,store_id,id) DEFERRABLE INITIALLY IMMEDIATE,
 FOREIGN KEY(business_id,store_id,batch_id) REFERENCES mc.sku_order_batches(business_id,store_id,id) DEFERRABLE INITIALLY IMMEDIATE
);
CREATE INDEX sku_order_recent ON mc.sku_order_identities(business_id,store_id,product_id,ordered_at DESC,srid);
CREATE TABLE mc.sku_order_events (
 business_id uuid NOT NULL, store_id uuid NOT NULL, source_key text NOT NULL CHECK(length(source_key) BETWEEN 1 AND 1024),
 changed_at timestamptz NOT NULL, srid text NOT NULL CHECK(length(srid) BETWEEN 1 AND 512), product_id uuid NOT NULL,
 outcome text NOT NULL CHECK(outcome IN ('retained','returned','refused')), outcome_at timestamptz NOT NULL, batch_id uuid NOT NULL,
 PRIMARY KEY(business_id,store_id,source_key,changed_at),
 FOREIGN KEY(business_id,store_id,product_id) REFERENCES mc.products(business_id,store_id,id) DEFERRABLE INITIALLY IMMEDIATE,
 FOREIGN KEY(business_id,store_id,batch_id) REFERENCES mc.sku_order_batches(business_id,store_id,id) DEFERRABLE INITIALLY IMMEDIATE
);
CREATE INDEX sku_order_event_lookup ON mc.sku_order_events(business_id,store_id,srid,outcome_at);
CREATE TABLE mc.sku_order_coverage (
 business_id uuid NOT NULL, store_id uuid NOT NULL, product_id uuid NOT NULL,
 coverage_start date NOT NULL, coverage_end date NOT NULL CHECK(coverage_end>=coverage_start),
 batch_id uuid NOT NULL, PRIMARY KEY(business_id,store_id,product_id),
 FOREIGN KEY(business_id,store_id,product_id) REFERENCES mc.products(business_id,store_id,id) DEFERRABLE INITIALLY IMMEDIATE,
 FOREIGN KEY(business_id,store_id,batch_id) REFERENCES mc.sku_order_batches(business_id,store_id,id) DEFERRABLE INITIALLY IMMEDIATE
);

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['sku_order_sync_state','sku_order_batches','sku_order_source_objects','sku_order_identities','sku_order_events','sku_order_coverage'] LOOP
  EXECUTE format('ALTER TABLE mc.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE mc.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_read ON mc.%I FOR SELECT USING(business_id=mc.context_business_id())',t);
  EXECUTE format('CREATE POLICY tenant_write ON mc.%I FOR ALL USING(business_id=mc.context_business_id() AND (mc.account_erasure_permitted(business_id) OR EXISTS(SELECT 1 FROM mc.memberships WHERE business_id=mc.context_business_id() AND user_id=mc.context_user_id() AND role IN (''owner'',''editor'')))) WITH CHECK(business_id=mc.context_business_id() AND EXISTS(SELECT 1 FROM mc.memberships WHERE business_id=mc.context_business_id() AND user_id=mc.context_user_id() AND role IN (''owner'',''editor'')))',t);
  EXECUTE format('CREATE INDEX ON mc.%I(business_id)',t);
  EXECUTE format('REVOKE ALL ON mc.%I FROM PUBLIC',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['sku_order_batches','sku_order_source_objects','sku_order_identities','sku_order_events'] LOOP
  EXECUTE format('CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON mc.%I FOR EACH ROW EXECUTE FUNCTION mc.reject_mutation()',t);
 END LOOP;
END $$;

-- The existing internal target queue supplies authenticated store owners, but its
-- funnel schedule/bootstrap never gates this independent journal.
CREATE FUNCTION mc.list_sku_order_sync_candidates(p_limit integer DEFAULT 2)
RETURNS TABLE(user_id uuid,business_id uuid,store_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mc AS $$
DECLARE target record; accepted integer:=0; old_business text:=current_setting('app.business_id',true); old_user text:=current_setting('app.user_id',true);
BEGIN
 FOR target IN SELECT t.requested_by,t.business_id,t.store_id FROM mc.operational_sync_targets t ORDER BY t.store_id LOOP
  PERFORM set_config('app.business_id',target.business_id::text,true); PERFORM set_config('app.user_id',target.requested_by::text,true);
  IF EXISTS(SELECT 1 FROM mc.memberships m WHERE m.business_id=target.business_id AND m.user_id=target.requested_by AND m.role IN ('owner','editor'))
   AND EXISTS(SELECT 1 FROM mc.stores s JOIN mc.connections c ON c.business_id=s.business_id AND c.store_id=s.id
    WHERE s.business_id=target.business_id AND s.id=target.store_id AND s.marketplace_code='wb' AND s.status='active' AND c.status='active' AND c.scopes ? 'statistics')
   AND EXISTS(SELECT 1 FROM mc.active_profile_products ap WHERE ap.business_id=target.business_id AND ap.store_id=target.store_id)
   AND NOT EXISTS(SELECT 1 FROM mc.sku_order_sync_state ss WHERE ss.business_id=target.business_id AND ss.store_id=target.store_id AND ss.next_run_at>clock_timestamp()) THEN
   user_id:=target.requested_by; business_id:=target.business_id; store_id:=target.store_id; RETURN NEXT;
   accepted:=accepted+1; EXIT WHEN accepted>=greatest(1,least(coalesce(p_limit,2),10));
  END IF;
 END LOOP;
 PERFORM set_config('app.business_id',coalesce(old_business,''),true); PERFORM set_config('app.user_id',coalesce(old_user,''),true);
END $$;
REVOKE ALL ON FUNCTION mc.list_sku_order_sync_candidates(integer) FROM PUBLIC;
INSERT INTO mc.schema_migrations(version) VALUES(81);
COMMIT;
