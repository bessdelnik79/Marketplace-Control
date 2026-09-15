BEGIN;

CREATE UNIQUE INDEX one_connection_per_store ON mc.connections(store_id);
CREATE UNIQUE INDEX connections_business_id_id_key ON mc.connections(business_id,id);

CREATE TABLE mc.connection_secrets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  ciphertext bytea NOT NULL,
  nonce bytea NOT NULL CHECK (octet_length(nonce)=12),
  auth_tag bytea NOT NULL CHECK (octet_length(auth_tag)=16),
  key_version text NOT NULL DEFAULT 'v1',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id),
  FOREIGN KEY (business_id,connection_id) REFERENCES mc.connections(business_id,id) ON DELETE CASCADE
);

ALTER TABLE mc.connection_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE mc.connection_secrets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mc.connection_secrets
  USING (business_id=mc.context_business_id())
  WITH CHECK (business_id=mc.context_business_id());
CREATE INDEX connection_secrets_business_id_idx ON mc.connection_secrets(business_id);

INSERT INTO mc.schema_migrations(version) VALUES(6);
COMMIT;
