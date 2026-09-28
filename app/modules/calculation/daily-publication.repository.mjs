function required(value,code){if(value===null||value===undefined||value==='')throw new TypeError(code);return value;}

export async function publishFinancialDailyGeneration(client,{jobId,leaseToken,workerId,generationId,eventGeneration}={}){
  if(!client?.query)throw new TypeError('database client is required');
  const input=[
    required(jobId,'jobId is required'),required(leaseToken,'leaseToken is required'),
    required(workerId,'workerId is required'),required(generationId,'generationId is required'),
    required(eventGeneration,'eventGeneration is required')
  ];
  const publication=(await client.query(
    'select * from mc.publish_financial_daily_generation($1,$2,$3,$4,$5)',input
  )).rows[0]??null;
  if(!publication)throw new Error('financial_daily_publication_missing');
  return publication;
}

export function createFinancialDailyPublicationRepository(){
  return{publish:publishFinancialDailyGeneration};
}
