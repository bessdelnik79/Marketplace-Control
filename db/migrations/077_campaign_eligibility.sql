BEGIN;

ALTER TABLE mc.stores ADD COLUMN identity_verified_at timestamptz;

-- Private server configuration and pseudonymous anti-repeat evidence. No tenant
-- references here: erasure removes grants, but must never reset eligibility.
CREATE SCHEMA mc_campaign_private;
REVOKE ALL ON SCHEMA mc_campaign_private FROM PUBLIC;
CREATE TABLE mc_campaign_private.campaigns (
  code text PRIMARY KEY CHECK (length(trim(code))>0),
  eligibility_group text NOT NULL CHECK (length(trim(eligibility_group))>0),
  enabled boolean NOT NULL DEFAULT false,
  available_from timestamptz,
  available_until timestamptz,
  benefit_kind text NOT NULL CHECK (length(trim(benefit_kind))>0),
  benefit_parameters jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(benefit_parameters)='object'),
  benefit_scope text NOT NULL CHECK (benefit_scope IN ('account','event')),
  require_verified_cabinet boolean NOT NULL DEFAULT true,
  duration_seconds integer CHECK (duration_seconds>0),
  CHECK (benefit_scope='event' OR require_verified_cabinet),
  CHECK (available_until IS NULL OR available_from IS NULL OR available_until>available_from)
);
CREATE TABLE mc_campaign_private.claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  eligibility_group text NOT NULL,
  campaign_code text NOT NULL,
  benefit_starts_at timestamptz NOT NULL,
  benefit_ends_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (benefit_ends_at IS NULL OR benefit_ends_at>benefit_starts_at),
  UNIQUE(id,eligibility_group)
);
CREATE TABLE mc_campaign_private.subjects (
  eligibility_group text NOT NULL,
  subject_kind text NOT NULL CHECK (subject_kind IN ('email','cabinet')),
  subject_digest text NOT NULL CHECK (subject_digest ~ '^[0-9a-f]{64}$'),
  claim_id uuid NOT NULL,
  PRIMARY KEY(eligibility_group,subject_kind,subject_digest),
  FOREIGN KEY(claim_id,eligibility_group) REFERENCES mc_campaign_private.claims(id,eligibility_group)
);
REVOKE ALL ON ALL TABLES IN SCHEMA mc_campaign_private FROM PUBLIC;
ALTER TABLE mc_campaign_private.campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE mc_campaign_private.claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE mc_campaign_private.subjects ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION mc_campaign_private.reject_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'campaign_evidence_immutable' USING ERRCODE='23514'; END $$;
REVOKE ALL ON FUNCTION mc_campaign_private.reject_mutation() FROM PUBLIC;
CREATE TRIGGER immutable_claim BEFORE UPDATE OR DELETE ON mc_campaign_private.claims
  FOR EACH ROW EXECUTE FUNCTION mc_campaign_private.reject_mutation();
CREATE TRIGGER immutable_subject BEFORE UPDATE OR DELETE ON mc_campaign_private.subjects
  FOR EACH ROW EXECUTE FUNCTION mc_campaign_private.reject_mutation();
CREATE TRIGGER stable_campaign_group BEFORE UPDATE ON mc_campaign_private.campaigns
  FOR EACH ROW EXECUTE FUNCTION mc.protect_columns('code','eligibility_group');

CREATE TABLE mc.campaign_grants (
  business_id uuid NOT NULL REFERENCES mc.businesses(id) DEFERRABLE INITIALLY IMMEDIATE,
  eligibility_group text NOT NULL,
  claim_id uuid NOT NULL UNIQUE,
  campaign_code text NOT NULL,
  benefit_kind text NOT NULL,
  benefit_parameters jsonb NOT NULL CHECK (jsonb_typeof(benefit_parameters)='object'),
  benefit_scope text NOT NULL CHECK (benefit_scope IN ('account','event')),
  benefit_starts_at timestamptz NOT NULL,
  benefit_ends_at timestamptz,
  PRIMARY KEY(business_id,eligibility_group),
  FOREIGN KEY(claim_id,eligibility_group) REFERENCES mc_campaign_private.claims(id,eligibility_group),
  CHECK (benefit_ends_at IS NULL OR benefit_ends_at>benefit_starts_at)
);
ALTER TABLE mc.campaign_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE mc.campaign_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mc.campaign_grants
  USING (business_id=mc.context_business_id()) WITH CHECK (business_id=mc.context_business_id());
REVOKE ALL ON mc.campaign_grants FROM PUBLIC;
CREATE TRIGGER immutable_grant BEFORE UPDATE OR DELETE ON mc.campaign_grants
  FOR EACH ROW EXECUTE FUNCTION mc.reject_mutation();

INSERT INTO mc.schema_migrations(version) VALUES(77);
COMMIT;
