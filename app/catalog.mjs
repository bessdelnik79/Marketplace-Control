const catalogEndpoint='https://content-api.wildberries.ru/content/v2/get/cards/list';
const pageLimit=100;

function apiError(message,response){const error=new Error(message);error.status=response?.status;error.endpoint=catalogEndpoint;return error;}

async function fetchPage(token,cursor,fetchImpl){
  let response;
  try{response=await fetchImpl(catalogEndpoint,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({settings:{sort:{ascending:true},filter:{withPhoto:-1},cursor:{limit:pageLimit,...cursor}}}),signal:AbortSignal.timeout(20000)});}
  catch{throw apiError('catalog_unavailable');}
  if(response.status===401||response.status===403)throw apiError('catalog_unauthorized',response);
  if(response.status===429)throw apiError('catalog_rate_limited',response);
  if(!response.ok)throw apiError('catalog_unavailable',response);
  let payload;
  try{payload=await response.json();}catch{throw apiError('catalog_invalid_response',response);}
  if(!Array.isArray(payload?.cards)||!payload.cursor||!Number.isFinite(Number(payload.cursor.total)))throw apiError('catalog_invalid_response',response);
  return payload;
}

function colorFrom(card){
  const value=card.characteristics?.find(item=>String(item?.name??'').toLocaleLowerCase('ru-RU').includes('цвет'))?.value;
  return Array.isArray(value)?value.map(String).join(', '):value==null?null:String(value);
}

function imageFrom(card){
  const photo=Array.isArray(card?.photos)?card.photos[0]:null;
  const candidate=photo?.c246x328||photo?.tm||photo?.big||photo?.c516x688||photo?.square;
  if(!candidate)return null;
  try{
    const url=new URL(String(candidate));
    if(url.protocol!=='https:'||!(url.hostname==='wbbasket.ru'||url.hostname.endsWith('.wbbasket.ru')))return null;
    return url.href;
  }catch{return null;}
}

export function normalizeCatalogCards(cards){
  return cards.map(card=>{
    const nmId=Number(card?.nmID);
    if(!Number.isSafeInteger(nmId)||nmId<=0)throw new Error('catalog_invalid_response');
    const color=colorFrom(card),sizes=Array.isArray(card.sizes)&&card.sizes.length?card.sizes:[{chrtID:`nm-${nmId}`,techSize:null,wbSize:null,skus:[]}];
    return {nmId,vendorCode:String(card.vendorCode||nmId),title:String(card.title||card.subjectName||`Товар ${nmId}`),imageUrl:imageFrom(card),variants:sizes.map(size=>({externalId:String(size.chrtID||`nm-${nmId}`),sizeLabel:size.techSize||size.wbSize||null,colorLabel:color,barcodes:Array.isArray(size.skus)?size.skus.map(String):[],attributes:{wbSize:size.wbSize||null}}))};
  });
}

export async function loadWbCatalog(token,{fetchImpl=fetch,maxPages=500}={}){
  const cards=[];let cursor={},previous='',lastCursor=null;
  for(let page=0;page<maxPages;page++){
    const payload=await fetchPage(token,cursor,fetchImpl);
    cards.push(...payload.cards);
    lastCursor=payload.cursor;
    if(Number(payload.cursor.total)<pageLimit)return {cards:normalizeCatalogCards(cards),cursor:lastCursor,pageCount:page+1};
    const next={updatedAt:payload.cursor.updatedAt,nmID:Number(payload.cursor.nmID)};
    const signature=JSON.stringify(next);
    if(!next.updatedAt||!Number.isSafeInteger(next.nmID)||signature===previous)throw new Error('catalog_invalid_response');
    previous=signature;cursor=next;
  }
  throw new Error('catalog_too_large');
}
