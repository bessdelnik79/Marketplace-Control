// The caller owns the transaction and establishes its authenticated tenant context.
export async function recoverHistoricalCatalog(client,{businessId,storeId,reportVersionId=null}){
  const context=(await client.query(`select mc.context_business_id() as business_id`)).rows[0];
  if(context?.business_id!==businessId)throw new Error('catalog_context_mismatch');
  return (await client.query(`select mc.recover_historical_catalog($1,$2) as result`,[storeId,reportVersionId])).rows[0].result;
}
