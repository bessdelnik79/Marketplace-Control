BEGIN;

DO $guard$
DECLARE definition text; updated text;
BEGIN
  SELECT pg_get_functiondef('mc.guard_run_finish()'::regprocedure) INTO definition;
  updated:=replace(definition,
    'HAVING abs(sum(e.contribution_amount))>abs(f.amount_signed))',
    'HAVING abs(sum(e.contribution_amount))>(CASE WHEN (SELECT method.implementation_version FROM mc.calculation_runs run JOIN mc.method_versions method ON method.id=run.method_version_id WHERE run.id=NEW.id) IN(''financial-result-v29'',''financial-result-v30'') THEN abs(round(f.amount_signed,4)) ELSE abs(f.amount_signed) END))');
  IF updated=definition OR position('THEN abs(round(f.amount_signed,4))' in updated)=0 THEN
    RAISE EXCEPTION 'guard_run_finish exact WB evidence contract not found';
  END IF;
  EXECUTE updated;
END $guard$;

INSERT INTO mc.schema_migrations(version) VALUES(57);

COMMIT;
