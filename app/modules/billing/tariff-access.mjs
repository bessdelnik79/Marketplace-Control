export async function readTariffContext(client,businessId){
  return (await client.query('select * from mc.effective_tariff_context($1)',[businessId])).rows[0];
}

export async function tariffPublicationAllowed(client,storeId,productIds,token=null){
  return (await client.query('select mc.financial_tariff_scope_matches($1,$2::uuid[],$3) allowed',[storeId,productIds,token])).rows[0]?.allowed===true;
}
