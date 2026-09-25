BEGIN;

CREATE FUNCTION mc.list_operational_sync_candidates(p_limit integer DEFAULT 50)
RETURNS TABLE(user_id uuid,store_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,mc AS $$
  SELECT member.user_id,ss.store_id
    FROM mc.sync_streams ss
    JOIN mc.stores s
      ON s.business_id=ss.business_id AND s.id=ss.store_id
    JOIN mc.connections c
      ON c.business_id=ss.business_id AND c.store_id=ss.store_id AND c.status='active'
    JOIN LATERAL (
      SELECT m.user_id
        FROM mc.memberships m
       WHERE m.business_id=ss.business_id AND m.role IN ('owner','editor')
       ORDER BY CASE m.role WHEN 'owner' THEN 0 ELSE 1 END,m.created_at,m.user_id
       LIMIT 1
    ) member ON true
   WHERE ss.source_type='operational_sales_funnel'
     AND ss.status='active'
     AND s.marketplace_code='wb'
     AND s.status='active'
     AND (ss.next_run_at IS NULL OR ss.next_run_at<=clock_timestamp())
     AND EXISTS (
       SELECT 1 FROM mc.product_selections ps
        WHERE ps.business_id=ss.business_id AND ps.store_id=ss.store_id AND ps.status='confirmed'
     )
     AND NOT EXISTS (
       SELECT 1 FROM mc.sync_runs r
        WHERE r.stream_id=ss.id AND r.status='running'
          AND r.started_at>clock_timestamp()-interval '30 minutes'
     )
   ORDER BY ss.next_run_at NULLS FIRST,ss.created_at,ss.id
   LIMIT greatest(1,least(coalesce(p_limit,50),100))
$$;

REVOKE ALL ON FUNCTION mc.list_operational_sync_candidates(integer) FROM PUBLIC;

CREATE FUNCTION mc.mark_operational_sync_due_for_selection()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,mc AS $$
BEGIN
  UPDATE mc.sync_streams
     SET next_run_at=clock_timestamp()
   WHERE business_id=NEW.business_id AND store_id=NEW.store_id
     AND source_type='operational_sales_funnel' AND status='active';
  RETURN NEW;
END $$;

CREATE TRIGGER product_selection_operational_sync_due
AFTER INSERT ON mc.product_selection_items
FOR EACH ROW EXECUTE FUNCTION mc.mark_operational_sync_due_for_selection();

INSERT INTO mc.schema_migrations(version) VALUES(21);

COMMIT;
