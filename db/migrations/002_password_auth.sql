BEGIN;

CREATE TABLE mc.auth_password_credentials (
  user_id uuid PRIMARY KEY REFERENCES mc.users(id) ON DELETE CASCADE,
  password_hash text NOT NULL,
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (password_hash LIKE 'scrypt$%')
);

CREATE TABLE mc.auth_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES mc.users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);

CREATE INDEX auth_sessions_user_id_idx ON mc.auth_sessions(user_id);
CREATE INDEX auth_sessions_expires_at_idx ON mc.auth_sessions(expires_at);

REVOKE ALL ON mc.auth_password_credentials FROM PUBLIC;
REVOKE ALL ON mc.auth_sessions FROM PUBLIC;

INSERT INTO mc.schema_migrations(version) VALUES(2);
COMMIT;
