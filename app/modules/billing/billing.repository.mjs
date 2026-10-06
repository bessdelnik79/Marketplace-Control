import {withOwnedBusinessContext} from '../../infrastructure/database/client.mjs';

export async function requestTariff(userId,code){
  if(!['minimum','plus','pro'].includes(code))throw new Error('tariff_choice_invalid');
  return withOwnedBusinessContext(userId,async(client,businessId,role)=>{
    if(!['owner','editor'].includes(role))throw new Error('tariff_write_forbidden');
    const plan=(await client.query('select id from mc.billing_plans where code=$1',[code])).rows[0];
    if(!plan)throw new Error('tariff_choice_invalid');
    await client.query(`insert into mc.audit_events(business_id,actor_user_id,action,entity_type,entity_id,safe_details)
      values($1,$2,'tariff_requested','billing_plans',$3,jsonb_build_object('planCode',$4::text))`,[businessId,userId,plan.id,code]);
    return {code,activated:false};
  });
}
