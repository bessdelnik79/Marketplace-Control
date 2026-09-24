BEGIN;

INSERT INTO mc.method_versions(code,version_no,description,parameters,implementation_version)
VALUES(
  'financial_result',
  3,
  'Оценка УСН по правилу продавца для выбранных SKU: база — стоимость реализованного товара и услуг по каждой выбранной SKU из retailAmount продаж за вычетом возвратов. Общие расходы без связи с SKU не распределяются.',
  '{"taxReference":"seller-defined-usn-income-selected-retail-amount-v1","taxScope":"selected_products","taxNotPayable":true,"unallocatedStoreExpensesExcluded":true}',
  'financial-result-v3'
)
ON CONFLICT(code,version_no) DO NOTHING;

-- Queue eligible existing stores once; the established invalidation drain
-- handles startup and normal later changes. FORCE RLS is restored immediately.
ALTER TABLE mc.stores NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.memberships NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.product_selections NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.reports NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.calculation_requests NO FORCE ROW LEVEL SECURITY;
INSERT INTO mc.calculation_invalidations(business_id,store_id,requested_by,reason)
SELECT s.business_id,s.id,member.user_id,'p03_user_tax_upgrade'
FROM mc.stores s
JOIN mc.product_selections ps ON ps.business_id=s.business_id AND ps.store_id=s.id AND ps.status='confirmed'
JOIN LATERAL (
  SELECT m.user_id FROM mc.memberships m WHERE m.business_id=s.business_id
  ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END,m.created_at LIMIT 1
) member ON true
LEFT JOIN mc.calculation_requests q ON q.business_id=s.business_id AND q.store_id=s.id AND q.is_latest
LEFT JOIN mc.method_versions method ON method.id=q.method_version_id
WHERE s.status='active'
  AND EXISTS (SELECT 1 FROM mc.reports r WHERE r.business_id=s.business_id AND r.store_id=s.id AND r.current_version_id IS NOT NULL)
  AND (q.id IS NULL OR method.version_no<3 OR q.status='failed')
ON CONFLICT(store_id) DO NOTHING;
ALTER TABLE mc.calculation_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.reports FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.product_selections FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE mc.stores FORCE ROW LEVEL SECURITY;

INSERT INTO mc.schema_migrations(version) VALUES(16);
COMMIT;
