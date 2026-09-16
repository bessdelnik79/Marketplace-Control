BEGIN;

CREATE TABLE mc.wb_api_request_slots (
  rate_key text PRIMARY KEY CHECK (length(rate_key) = 64),
  next_allowed_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE mc.wb_api_request_slots IS
  'Глобальные слоты исходящих запросов WB. Ключ — SHA-256 продавца и ресурса, без исходного seller ID.';

INSERT INTO mc.schema_migrations(version) VALUES(10);
COMMIT;
