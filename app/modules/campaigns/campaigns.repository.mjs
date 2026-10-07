import { withOwnedBusinessContext } from '../../infrastructure/database/client.mjs';
import { campaignIdentityKey, campaignEmailSubject, campaignCabinetSubject } from './identity.mjs';

function grantResult(row, alreadyParticipated = false) {
  return {
    claimId: row.claim_id, campaignCode: row.campaign_code, eligibilityGroup: row.eligibility_group,
    benefitKind: row.benefit_kind, benefitParameters: row.benefit_parameters, benefitScope: row.benefit_scope,
    benefitStartsAt: row.benefit_starts_at, benefitEndsAt: row.benefit_ends_at, alreadyParticipated
  };
}

// All callers hold the business row lock before reading cabinets/grants. Global
// subject locks have the same order for claim and subsequent cabinet binding.
async function reserveSubjects(client, reservations) {
  const unique = [...new Map(reservations.map(item => [JSON.stringify([item.group,item.kind,item.digest]),item])).values()]
    .sort((a,b) => {
      const left=JSON.stringify([a.group,a.kind,a.digest]),right=JSON.stringify([b.group,b.kind,b.digest]);
      return left<right?-1:left>right?1:0;
    });
  for (const item of unique) {
    await client.query(`select pg_advisory_xact_lock(hashtextextended($1,0))`, [JSON.stringify(['campaign-subject',item.group,item.kind,item.digest])]);
  }
  for (const item of unique) {
    const previous = (await client.query(
      `select claim_id from mc_campaign_private.subjects where eligibility_group=$1 and subject_kind=$2 and subject_digest=$3`,
      [item.group,item.kind,item.digest]
    )).rows[0];
    if (previous && previous.claim_id !== item.claimId) throw new Error('campaign_already_consumed');
  }
  for (const item of unique) {
    const inserted = await client.query(
      `insert into mc_campaign_private.subjects(eligibility_group,subject_kind,subject_digest,claim_id)
       values($1,$2,$3,$4) on conflict do nothing returning claim_id`, [item.group,item.kind,item.digest,item.claimId]
    );
    if (!inserted.rows.length) {
      const existing = (await client.query(
        `select claim_id from mc_campaign_private.subjects where eligibility_group=$1 and subject_kind=$2 and subject_digest=$3`,
        [item.group,item.kind,item.digest]
      )).rows[0];
      if (existing?.claim_id !== item.claimId) throw new Error('campaign_already_consumed');
    }
  }
}

export async function participateCampaign(userId, campaignCode, { applyBenefit } = {}) {
  if (typeof applyBenefit !== 'function') throw new Error('campaign_benefit_callback_required');
  return withOwnedBusinessContext(userId, async (client, businessId, role) => {
    if (role !== 'owner') throw new Error('forbidden');
    const user = (await client.query(`select email,status from mc.users where id=$1 for update`, [userId])).rows[0];
    if (!user || user.status !== 'active') throw new Error('campaign_account_unavailable');
    const business = await client.query(`select id from mc.businesses where id=$1 for update`, [businessId]);
    if (!business.rows.length) throw new Error('business_not_found');
    const campaign = (await client.query(`select * from mc_campaign_private.campaigns where code=$1 for share`, [campaignCode])).rows[0];
    if (!campaign) throw new Error('campaign_unavailable');
    const previous = (await client.query(`select * from mc.campaign_grants where business_id=$1 and eligibility_group=$2`, [businessId,campaign.eligibility_group])).rows[0];
    if (previous) return grantResult(previous, true);
    const available = (await client.query(
      `select $1::boolean and ($2::timestamptz is null or $2<=now()) and ($3::timestamptz is null or $3>now()) as allowed`,
      [campaign.enabled,campaign.available_from,campaign.available_until]
    )).rows[0].allowed;
    if (!available) throw new Error('campaign_unavailable');
    const key = campaignIdentityKey();
    // Include every connected cabinet, including those outside the current paid
    // product selection. Browser input cannot narrow this eligibility scope.
    const stores = (await client.query(
      `select s.marketplace_code,s.external_account_id,s.identity_verified_at from mc.stores s
       where s.business_id=$1 and (s.status='active' or exists(select 1 from mc.connections c where c.store_id=s.id)
         or exists(select 1 from mc.active_profile_stores p where p.store_id=s.id))`, [businessId]
    )).rows;
    if (campaign.require_verified_cabinet && !stores.length) throw new Error('campaign_verified_cabinet_required');
    if (stores.some(store => !store.identity_verified_at)) throw new Error('campaign_cabinet_unverified');
    const identities = [campaignEmailSubject(user.email,key), ...stores.map(store => campaignCabinetSubject(store.marketplace_code,store.external_account_id,key))];
    const claim = (await client.query(
      `insert into mc_campaign_private.claims(eligibility_group,campaign_code,benefit_starts_at,benefit_ends_at)
       values($1,$2,now(),case when $3::integer is null then null else now()+make_interval(secs=>$3) end) returning *`,
      [campaign.eligibility_group,campaign.code,campaign.duration_seconds]
    )).rows[0];
    await reserveSubjects(client, identities.map(identity => ({...identity,group:campaign.eligibility_group,claimId:claim.id})));
    const row = (await client.query(
      `insert into mc.campaign_grants(business_id,eligibility_group,claim_id,campaign_code,benefit_kind,benefit_parameters,benefit_scope,benefit_starts_at,benefit_ends_at)
       select $1,$2,$3,$4,$5,$6::jsonb,$7,benefit_starts_at,benefit_ends_at from mc_campaign_private.claims where id=$3 returning *`,
      [businessId,campaign.eligibility_group,claim.id,campaign.code,campaign.benefit_kind,JSON.stringify(campaign.benefit_parameters),campaign.benefit_scope]
    )).rows[0];
    const grant = grantResult(row);
    await applyBenefit(client,grant);
    return grant;
  });
}

// Server-only: verified is the marketplace verification result, never browser
// input. The caller's connection transaction already holds the business lock.
export async function bindActiveCampaignCabinet(client, businessId, { marketplaceCode, sellerId, verified }) {
  const grants = (await client.query(
    `select claim_id,eligibility_group from mc.campaign_grants where business_id=$1 and benefit_scope='account'
     and benefit_starts_at<=now() and (benefit_ends_at is null or benefit_ends_at>now())`, [businessId]
  )).rows;
  if (!grants.length) return;
  if (verified !== true) throw new Error('campaign_cabinet_unverified');
  const identity = campaignCabinetSubject(marketplaceCode,sellerId,campaignIdentityKey());
  await reserveSubjects(client, grants.map(grant => ({...identity,group:grant.eligibility_group,claimId:grant.claim_id})));
}
