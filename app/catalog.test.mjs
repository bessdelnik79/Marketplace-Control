import test from'node:test';
import assert from'node:assert/strict';
import{loadWbCatalog,normalizeCatalogCards}from'./catalog.mjs';

test('WB catalog loads all cursor pages and keeps variants',async()=>{
  const requests=[];
  const first=Array.from({length:100},(_,i)=>({nmID:i+1,vendorCode:`A-${i+1}`,title:`Товар ${i+1}`,sizes:[{chrtID:i+1000,techSize:'M',wbSize:'44',skus:[`sku-${i}`]}]}));
  const fetchImpl=async(_url,options)=>{const body=JSON.parse(options.body);requests.push(body);return requests.length===1?new Response(JSON.stringify({cards:first,cursor:{total:100,updatedAt:'2026-09-15T00:00:00Z',nmID:100}})):new Response(JSON.stringify({cards:[{nmID:101,vendorCode:'A-101',title:'Последний',sizes:[]}],cursor:{total:1,updatedAt:'2026-09-15T00:01:00Z',nmID:101}}));};
  const result=await loadWbCatalog('token',{fetchImpl});
  assert.equal(result.cards.length,101);assert.equal(result.pageCount,2);
  assert.deepEqual(requests[0].settings.filter,{withPhoto:-1});
  assert.equal(requests[1].settings.cursor.nmID,100);
  assert.equal(result.cards[0].variants[0].barcodes[0],'sku-0');
  assert.equal(result.cards[100].variants[0].externalId,'nm-101');
});

test('catalog normalization extracts color and rejects broken cards',()=>{
  const [card]=normalizeCatalogCards([{nmID:42,vendorCode:'VC',title:'Чашка',characteristics:[{name:'Цвет товара',value:['синий','белый']}],sizes:[{chrtID:7,techSize:'0',skus:[]}]}]);
  assert.equal(card.variants[0].colorLabel,'синий, белый');
  assert.throws(()=>normalizeCatalogCards([{nmID:0}]),/catalog_invalid_response/);
});

test('WB catalog maps authorization and rate limit failures',async()=>{
  await assert.rejects(()=>loadWbCatalog('bad',{fetchImpl:async()=>new Response('{}',{status:401})}),/catalog_unauthorized/);
  await assert.rejects(()=>loadWbCatalog('busy',{fetchImpl:async()=>new Response('{}',{status:429})}),/catalog_rate_limited/);
});
