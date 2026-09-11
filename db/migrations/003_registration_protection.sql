BEGIN;
ALTER TABLE mc.users ADD COLUMN email_verified_at timestamptz;
UPDATE mc.users SET email_verified_at=created_at WHERE status='active';
CREATE TABLE mc.auth_registration_challenges (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text NOT NULL UNIQUE, display_name text NOT NULL,
 password_hash text NOT NULL, code_hash text NOT NULL, attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), CHECK(expires_at>created_at));
CREATE TABLE mc.auth_rate_limits (
 bucket_key text PRIMARY KEY, attempts integer NOT NULL CHECK(attempts>0), window_started_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL, CHECK(expires_at>window_started_at));
CREATE TABLE mc.auth_oauth_states (
 state_hash text PRIMARY KEY, provider text NOT NULL CHECK(provider='yandex'), expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), CHECK(expires_at>created_at));
CREATE INDEX auth_challenges_expiry_idx ON mc.auth_registration_challenges(expires_at);
CREATE INDEX auth_limits_expiry_idx ON mc.auth_rate_limits(expires_at);
REVOKE ALL ON mc.auth_registration_challenges,mc.auth_rate_limits,mc.auth_oauth_states FROM PUBLIC;
INSERT INTO mc.schema_migrations(version) VALUES(3);
COMMIT;
