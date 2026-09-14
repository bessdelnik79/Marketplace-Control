BEGIN;

-- Trusted authentication backend may look up only the requested password identity.
-- This does not grant access to users or any business data.
CREATE POLICY password_identity_lookup ON mc.auth_identities FOR SELECT
  USING (provider = 'password' AND subject = nullif(current_setting('app.auth_email', true), ''));

INSERT INTO mc.schema_migrations(version) VALUES(4);
COMMIT;
