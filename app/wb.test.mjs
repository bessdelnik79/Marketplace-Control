import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeWbToken, normalizeWbToken, requiredWbScopes, verifyWbToken } from './wb.mjs';

function token(payload){return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;}
const sellerId='11111111-2222-4333-8444-555555555555';
const fullMask=[1,2,5,13,30].reduce((mask,bit)=>mask|(1n<<BigInt(bit)),0n);

test('WB JWT metadata exposes seller, expiry and least-privilege categories',()=>{
  const raw=token({sid:sellerId,exp:2_000_000_000,s:Number(fullMask),acc:1,t:false});
  const decoded=decodeWbToken(`Bearer ${raw}`);
  assert.equal(normalizeWbToken(`Bearer ${raw}`),raw);
  assert.equal(decoded.sellerId,sellerId);
  assert.equal(decoded.readOnly,true);
  assert.deepEqual(requiredWbScopes.filter(scope=>decoded.scopes.includes(scope)),requiredWbScopes);
});

test('WB token is accepted only after official ping and seller identity check',async()=>{
  const raw=token({sid:sellerId,exp:2_000_000_000,s:Number(fullMask),acc:1,t:false});
  const calls=[];
  const fetchImpl=async(url,options)=>{calls.push({url,authorization:options.headers.Authorization});return url.endsWith('/ping')?new Response(JSON.stringify({Status:'OK'}),{status:200}):new Response(JSON.stringify({sid:sellerId,tradeMark:'Мой WB'}),{status:200});};
  const verified=await verifyWbToken(raw,{fetchImpl,now:1_700_000_000_000});
  assert.equal(verified.sellerName,'Мой WB');
  assert.equal(calls.length,2);
  assert.ok(calls.every(call=>call.authorization===`Bearer ${raw}`));
});

test('WB token validation rejects missing categories, expiry and API denial',async()=>{
  const statisticsOnlyReadMask=(1n<<5n)|(1n<<30n);
  await assert.rejects(()=>verifyWbToken(token({sid:sellerId,exp:2_000_000_000,s:Number(statisticsOnlyReadMask),acc:1,t:false}),{fetchImpl:async()=>new Response('{}')}),error=>error.message==='wb_scopes_missing'&&error.missingScopes.includes('finance'));
  await assert.rejects(()=>verifyWbToken(token({sid:sellerId,exp:1,s:Number(fullMask),acc:1,t:false}),{fetchImpl:async()=>new Response('{}')}),/wb_token_expired/);
  await assert.rejects(()=>verifyWbToken(token({sid:sellerId,exp:2_000_000_000,s:Number(fullMask),acc:1,t:false}),{fetchImpl:async()=>new Response('{}',{status:401})}),error=>error.message==='wb_token_rejected'&&error.status===401&&error.endpoint.endsWith('/ping'));
  await assert.rejects(()=>verifyWbToken(token({sid:sellerId,exp:2_000_000_000,s:Number(fullMask&~(1n<<30n)),acc:1,t:false}),{fetchImpl:async()=>new Response('{}')}),/wb_write_token_forbidden/);
});
