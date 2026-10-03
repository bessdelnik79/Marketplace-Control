BEGIN;

-- WB service rows can retain a barcode with nmId=0. They do not identify a
-- competing product; only a different positive article makes it ambiguous.
DO $migration$
DECLARE definition text;
BEGIN
  definition:=pg_get_functiondef('mc.recover_historical_catalog(uuid,uuid)'::regprocedure);
  IF strpos(definition,$old$AND rr.raw_data->>'nmId'<>candidate.article::text$old$)=0 THEN
    RAISE EXCEPTION 'historical barcode guard definition mismatch';
  END IF;
  EXECUTE replace(definition,
    $old$AND rr.raw_data->>'nmId'<>candidate.article::text$old$,
    $new$AND CASE WHEN rr.raw_data->>'nmId' ~ '^[0-9]{1,18}$'
      THEN (rr.raw_data->>'nmId')::bigint>0 AND (rr.raw_data->>'nmId')::bigint<>candidate.article
      ELSE false END$new$);
END $migration$;

INSERT INTO mc.schema_migrations(version) VALUES(61);
COMMIT;
