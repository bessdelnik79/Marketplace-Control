BEGIN;

CREATE TABLE mc.operational_sync_targets (
  store_id uuid PRIMARY KEY,
  business_id uuid NOT NULL,
  requested_by uuid NOT NULL,
  next_run_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id,store_id) REFERENCES mc.stores(business_id,id),
  FOREIGN KEY (business_id,requested_by) REFERENCES mc.memberships(business_id,user_id)
);

CREATE INDEX operational_sync_targets_due ON mc.operational_sync_targets(next_run_at,store_id) WHERE status='active';
REVOKE ALL ON mc.operational_sync_targets FROM PUBLIC;

-- This is an internal scheduler queue, not a tenant read model. Backfill it in
-- the migration transaction, then restore FORCE RLS on all tenant tables.
ALTER TABLE mc.stores NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.connections NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.sync_streams NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.product_selections NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.memberships NO FORCE ROW LEVEL SECURITY;
INSERT INTO mc.operational_sync_targets(store_id,business_id,requested_by,next_run_at,status)
SELECT ss.store_id,ss.business_id,member.user_id,coalesce(ss.next_run_at,now()),ss.status
  FROM mc.sync_streams ss
  JOIN mc.stores s ON s.business_id=ss.business_id AND s.id=ss.store_id
  JOIN mc.connections c ON c.business_id=ss.business_id AND c.store_id=ss.store_id AND c.status='active'
  JOIN mc.product_selections ps ON ps.business_id=ss.business_id AND ps.store_id=ss.store_id AND ps.status='confirmed'
  JOIN LATERAL (
    SELECT m.user_id FROM mc.memberships m
     WHERE m.business_id=ss.business_id AND m.role IN ('owner','editor')
     ORDER BY CASE m.role WHEN 'owner' THEN 0 ELSE 1 END,m.created_at,m.user_id LIMIT 1
  ) member ON true
 WHERE ss.source_type='operational_sales_funnel' AND ss.status='active'
   AND s.marketplace_code='wb' AND s.status='active'
ON CONFLICT(store_id) DO NOTHING;
ALTER TABLE mc.stores FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.connections FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.sync_streams FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.product_selections FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.memberships FORCE ROW LEVEL SECURITY;

DROP FUNCTION mc.list_operational_sync_candidates(integer);
CREATE FUNCTION mc.list_operational_sync_candidates(p_limit integer DEFAULT 50)
RETURNS TABLE(user_id uuid,business_id uuid,store_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,mc AS $$
  SELECT t.requested_by,t.business_id,t.store_id
    FROM mc.operational_sync_targets t
   WHERE t.status='active' AND t.next_run_at<=clock_timestamp()
   ORDER BY t.next_run_at,t.store_id
   LIMIT greatest(1,least(coalesce(p_limit,50),100))
$$;

REVOKE ALL ON FUNCTION mc.list_operational_sync_candidates(integer) FROM PUBLIC;

CREATE FUNCTION mc.mirror_operational_sync_target()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mc AS $$
DECLARE actor uuid;
BEGIN
  IF NEW.source_type<>'operational_sales_funnel' THEN RETURN NEW; END IF;
  actor:=mc.context_user_id();
  IF actor IS NULL OR NOT EXISTS(
    SELECT 1 FROM mc.memberships m
     WHERE m.business_id=NEW.business_id AND m.user_id=actor AND m.role IN ('owner','editor')
  ) THEN
    SELECT requested_by INTO actor FROM mc.operational_sync_targets WHERE store_id=NEW.store_id;
  END IF;
  IF actor IS NULL THEN RETURN NEW; END IF;
  IF NEW.status='active' AND EXISTS(
    SELECT 1 FROM mc.stores s
    JOIN mc.connections c ON c.business_id=s.business_id AND c.store_id=s.id AND c.status='active'
    WHERE s.business_id=NEW.business_id AND s.id=NEW.store_id
      AND s.marketplace_code='wb' AND s.status='active'
  ) AND EXISTS(
    SELECT 1 FROM mc.product_selections ps
     WHERE ps.business_id=NEW.business_id AND ps.store_id=NEW.store_id AND ps.status='confirmed'
  ) THEN
    INSERT INTO mc.operational_sync_targets(store_id,business_id,requested_by,next_run_at,status,updated_at)
    VALUES(NEW.store_id,NEW.business_id,actor,
      CASE WHEN TG_OP='UPDATE' AND NEW.next_run_at IS NULL THEN clock_timestamp()+interval '30 minutes'
           ELSE coalesce(NEW.next_run_at,clock_timestamp()) END,
      'active',clock_timestamp())
    ON CONFLICT(store_id) DO UPDATE SET
      requested_by=excluded.requested_by,next_run_at=excluded.next_run_at,status='active',updated_at=clock_timestamp();
  ELSE
    UPDATE mc.operational_sync_targets SET status='blocked',updated_at=clock_timestamp() WHERE store_id=NEW.store_id;
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION mc.mirror_operational_sync_target() FROM PUBLIC;

CREATE TRIGGER operational_stream_scheduler_target
AFTER INSERT OR UPDATE OF status,next_run_at ON mc.sync_streams
FOR EACH ROW EXECUTE FUNCTION mc.mirror_operational_sync_target();

CREATE FUNCTION mc.refresh_operational_sync_target_eligibility()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mc AS $$
DECLARE
  target_business_id uuid:=NEW.business_id;
  target_store_id uuid:=coalesce((to_jsonb(NEW)->>'store_id')::uuid,(to_jsonb(NEW)->>'id')::uuid);
  actor uuid:=mc.context_user_id();
  stream_next_run_at timestamptz;
BEGIN
  SELECT ss.next_run_at INTO stream_next_run_at
    FROM mc.sync_streams ss
    JOIN mc.stores s ON s.business_id=ss.business_id AND s.id=ss.store_id AND s.status='active'
    JOIN mc.connections c ON c.business_id=ss.business_id AND c.store_id=ss.store_id AND c.status='active'
   WHERE ss.business_id=target_business_id AND ss.store_id=target_store_id
     AND ss.source_type='operational_sales_funnel' AND ss.status='active'
     AND EXISTS(
       SELECT 1 FROM mc.product_selections ps
        WHERE ps.business_id=ss.business_id AND ps.store_id=ss.store_id AND ps.status='confirmed'
     );
  IF FOUND THEN
    IF actor IS NULL OR NOT EXISTS(
      SELECT 1 FROM mc.memberships m
       WHERE m.business_id=target_business_id AND m.user_id=actor AND m.role IN ('owner','editor')
    ) THEN
      SELECT requested_by INTO actor FROM mc.operational_sync_targets WHERE store_id=target_store_id;
    END IF;
    IF actor IS NOT NULL THEN
      INSERT INTO mc.operational_sync_targets(store_id,business_id,requested_by,next_run_at,status,updated_at)
      VALUES(target_store_id,target_business_id,actor,coalesce(stream_next_run_at,clock_timestamp()),'active',clock_timestamp())
      ON CONFLICT(store_id) DO UPDATE SET
        requested_by=excluded.requested_by,next_run_at=excluded.next_run_at,status='active',updated_at=clock_timestamp();
    END IF;
  ELSE
    UPDATE mc.operational_sync_targets SET status='blocked',updated_at=clock_timestamp()
     WHERE store_id=target_store_id AND business_id=target_business_id;
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION mc.refresh_operational_sync_target_eligibility() FROM PUBLIC;

CREATE TRIGGER store_operational_sync_target_eligibility
AFTER UPDATE OF status ON mc.stores
FOR EACH ROW EXECUTE FUNCTION mc.refresh_operational_sync_target_eligibility();

CREATE TRIGGER connection_operational_sync_target_eligibility
AFTER INSERT OR UPDATE OF status ON mc.connections
FOR EACH ROW EXECUTE FUNCTION mc.refresh_operational_sync_target_eligibility();

CREATE OR REPLACE FUNCTION mc.mark_operational_sync_due_for_selection()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,mc AS $$
BEGIN
  UPDATE mc.sync_streams SET next_run_at=clock_timestamp()
   WHERE business_id=NEW.business_id AND store_id=NEW.store_id
     AND source_type='operational_sales_funnel' AND status='active';
  RETURN NEW;
END $$;

INSERT INTO mc.schema_migrations(version) VALUES(22);

COMMIT;
