BEGIN;

ALTER TABLE mc.products ADD COLUMN image_url text;

INSERT INTO mc.schema_migrations(version) VALUES(7);
COMMIT;
