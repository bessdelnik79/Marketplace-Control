const CATEGORIES = new Map([
  [1,'content'],[2,'analytics'],[3,'prices'],[4,'marketplace'],[5,'statistics'],[6,'promotion'],
  [7,'feedbacks'],[9,'buyer_chat'],[10,'supplies'],[11,'returns'],[12,'documents'],[13,'finance'],[16,'users']
]);
export const requiredWbScopes = ['content','analytics','statistics','finance'];

export function normalizeWbToken(value) {
  return String(value ?? '').trim().replace(/^Bearer\s+/i,'');
}

export function decodeWbToken(value) {
  const token=normalizeWbToken(value), parts=token.split('.');
  if(parts.length!==3)throw new Error('wb_token_invalid');
  try{
    const payload=JSON.parse(Buffer.from(parts[1],'base64url').toString('utf8'));
    if(!payload.sid||!Number.isFinite(Number(payload.exp))||!Number.isFinite(Number(payload.s)))throw new Error('invalid');
    const mask=BigInt(payload.s),scopes=[];
    for(const [bit,name] of CATEGORIES)if((mask&(1n<<BigInt(bit)))!==0n)scopes.push(name);
    return {token,payload,sellerId:String(payload.sid),expiresAt:new Date(Number(payload.exp)*1000),scopes,readOnly:(mask&(1n<<30n))!==0n,isTest:payload.t===true,accountType:Number(payload.acc)};
  }catch(error){if(error.message==='wb_token_invalid')throw error;throw new Error('wb_token_invalid');}
}

async function wbRequest(url, token, fetchImpl) {
  let response;
  try{response=await fetchImpl(url,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(10000)});}
  catch{const error=new Error('wb_unavailable');error.endpoint=url;throw error;}
  const failure=message=>{const error=new Error(message);error.endpoint=url;error.status=response.status;return error;};
  if(response.status===401||response.status===403)throw failure('wb_token_rejected');
  if(response.status===429)throw failure('wb_rate_limited');
  if(!response.ok)throw failure('wb_unavailable');
  return response;
}

export async function verifyWbToken(value,{fetchImpl=fetch,now=Date.now()}={}) {
  const decoded=decodeWbToken(value);
  if(decoded.expiresAt.getTime()<=now)throw new Error('wb_token_expired');
  if(decoded.isTest)throw new Error('wb_test_token_unsupported');
  if(![1,3].includes(decoded.accountType))throw new Error('wb_token_type_unsupported');
  if(!decoded.readOnly)throw new Error('wb_write_token_forbidden');
  const missing=requiredWbScopes.filter(scope=>!decoded.scopes.includes(scope));
  if(missing.length){const error=new Error('wb_scopes_missing');error.missingScopes=missing;throw error;}
  await wbRequest('https://common-api.wildberries.ru/ping',decoded.token,fetchImpl);
  let response;
  try{response=await wbRequest('https://common-api.wildberries.ru/api/v1/seller-info',decoded.token,fetchImpl);}
  catch(error){if(error.message==='wb_rate_limited')return {...decoded,sellerName:'Магазин Wildberries',sellerInfoAvailable:false};throw error;}
  let seller;
  try{seller=await response.json();}catch{throw new Error('wb_unavailable');}
  if(!seller?.sid||String(seller.sid)!==decoded.sellerId)throw new Error('wb_seller_mismatch');
  return {...decoded,sellerName:String(seller.tradeMark||seller.name||'Магазин Wildberries'),sellerInfoAvailable:true};
}
