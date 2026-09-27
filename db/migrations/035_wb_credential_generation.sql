BEGIN;

ALTER TABLE mc.connections
  ADD COLUMN credential_generation bigint NOT NULL DEFAULT 0,
  ADD CONSTRAINT connections_credential_generation_check CHECK (credential_generation>=0);

ALTER TABLE mc.connection_secrets
  ADD COLUMN credential_fingerprint text,
  ADD CONSTRAINT connection_secrets_credential_fingerprint_check CHECK (
    credential_fingerprint IS NULL OR credential_fingerprint ~ '^[0-9a-f]{64}$'
  );

INSERT INTO mc.schema_migrations(version) VALUES(35);
COMMIT;
