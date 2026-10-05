import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { pool } from '../../app/infrastructure/database/client.mjs';
import { createPublishedDrilldownRepository } from '../../app/modules/calculation/drilldown.repository.mjs';
import { parseScale4Money } from '../../app/modules/overview/financial-overview.mjs';
import { createSessionToken, hashToken } from '../../app/modules/auth/auth.mjs';
import { saveSession, deleteSession, findSession } from '../../app/modules/auth/auth.repository.mjs';
import { listStores } from '../../app/modules/stores/stores.repository.mjs';
import { createDrilldownRoutes } from '../../app/modules/calculation/drilldown.routes.mjs';
import { createOverviewRoutes } from '../../app/modules/overview/overview.routes.mjs';
import { skuListPage, skuCardPage, skuSourcesPage } from '../../app/frontend/sku.page.mjs';
import { situationsListPage, situationDetailPage } from '../../app/frontend/situations.page.mjs';
import { overviewPage } from '../../app/frontend/pages.mjs';

// Explicit opt-in: reads saved financial data; the only writes are a temporary
// authentication session and its cleanup. Never prints business data or secrets.
const keys=['storeId','publicationSource','publicationId','periodStart','periodEnd'];
const httpFetch=globalThis.fetch;
const reader=createPublishedDrilldownRepository({pool});
const money=parseScale4Money;
function decimal12(value){
  const match=String(value).match(/^(-?)(\d+)(?:\.(\d{1,12}))?$/);assert.ok(match);
  return BigInt(match[2]+(match[3]??'').padEnd(12,'0'))*(match[1]? -1n:1n);
}
const sum=groups=>groups.reduce((total,group)=>total+money(group.amountSigned),0n);
let stage='configuration',sessionHash,wbAttempts=0,localServer;
const pageLimit=Number(process.env.P05_LIVE_PAGE_LIMIT??25);
const summary={profiles:[],pageLimit,httpRequests:0,blockedHttpRequests:0,wbFetchAttempts:0};
function contextEqual(context,input){
  assert.equal(context.storeId,input.storeId);
  assert.equal(context.publication.id,input.publicationId);
  assert.equal(context.publication.source,input.publicationSource);
  assert.deepEqual(context.period,{start:input.periodStart,end:input.periodEnd});
}
function pinned(url,input){for(const key of keys)assert.equal(url.searchParams.get(key),input[key]);}
function links(html,base,path){
  return [...html.matchAll(/href="([^"]+)"/g)].map(match=>new URL(match[1].replaceAll('&amp;','&'),base))
    .filter(url=>url.origin===base.origin&&url.pathname===path);
}
async function counters(userId,businessId){
  const client=await pool.connect();
  try{
    await client.query('begin read only');
    await client.query("select set_config('app.user_id',$1,true),set_config('app.business_id',$2,true)",[userId,businessId]);
    const counts=(await client.query(`select
      (select count(*)::int from mc.jobs where business_id=$1) jobs,
      (select count(*)::int from mc.report_versions where business_id=$1) report_versions`,[businessId])).rows[0];
    await client.query('commit');return counts;
  }catch(error){await client.query('rollback');throw error;}finally{client.release();}
}
async function sources(userId,input,group,stats,taxBasis=false){
  let cursor=null,items=[],seen=new Set(),expectedCount,basisExpected;
  const args={...input,groupKey:group.groupKey,taxBasis,...(group.scope==='store'?{scope:'store'}:{productId:group.productId})};
  do{
    const page=await reader.readPublishedContributions(userId,{...args,cursor,limit:pageLimit});
    contextEqual(page.context,input);assert.deepEqual(page.group,group);
    assert.equal(page.sourceValidationScope,'page');
    assert.equal(page.reconciliation.status,'matched');
    for(const check of page.reconciliation.checks){assert.equal(check.status,'matched');assert.equal(decimal12(check.actualAmount),decimal12(check.expectedAmount));}
    const basisCheck=page.reconciliation.checks.find(check=>check.basis==='taxable_base');
    if(basisCheck)basisExpected=basisCheck.expectedAmount;
    if(page.taxSummary)assert.equal(page.taxSummary.reduce((total,item)=>total+money(item.contributionAmount),0n),money(group.amountSigned));
    expectedCount??=page.totalItems;assert.equal(page.totalItems,expectedCount);
    for(const item of page.items){
      assert.ok(!seen.has(item.id));seen.add(item.id);items.push(item);
      if(item.evidenceStatus==='matched'){assert.ok(item.source);assert.deepEqual(item.missingReasons,[]);stats.verifiedSources++;}
      else{assert.equal(item.evidenceStatus,'unavailable');assert.equal(item.source,null);assert.ok(item.missingReasons.length);stats.unavailableSources++;}
      for(const reason of item.missingReasons??[])stats.reasons.add(reason);
    }
    for(const reason of page.missingReasons??[])stats.reasons.add(reason);
    if(page.evidenceStatus==='matched')assert.ok(page.items.every(item=>item.evidenceStatus==='matched'));
    cursor=page.nextCursor;stats.sourcePages++;
  }while(cursor);
  assert.equal(items.length,expectedCount);
  if(!taxBasis&&items.every(item=>item.contributionAmount!=null))assert.equal(items.reduce((total,item)=>total+money(item.contributionAmount),0n),money(group.amountSigned));
  if(basisExpected!=null)assert.equal(items.reduce((total,item)=>total+decimal12(item.basisContributionAmount),0n),decimal12(basisExpected));
  if(taxBasis)assert.ok(items.every(item=>item.basisContributionAmount!=null));
  stats.groups++;
  return items;
}
async function profileRead(userId,profile){
  const input=profile.input,stats={source:input.publicationSource,sku:0,groups:0,sourcePages:0,verifiedSources:0,unavailableSources:0,reasons:new Set()};
  let cursor=null,snapshot,items=[],seen=new Set();
  do{
    const page=await reader.readPublishedSkuList(userId,{...input,cursor,limit:pageLimit});
    contextEqual(page.context,input);
    snapshot??=page;
    assert.deepEqual(page.context,snapshot.context);assert.deepEqual(page.storeLines,snapshot.storeLines);
    for(const item of page.items){assert.ok(!seen.has(item.productId));seen.add(item.productId);items.push(item);}
    cursor=page.nextCursor;
  }while(cursor);
  assert.equal(items.length,snapshot.totalItems);assert.equal(items.length,snapshot.scopeItemCount);
  assert.notEqual(snapshot.reconciliation.status,'mismatch');
  if(profile.quality)assert.equal(snapshot.context.quality,profile.quality);
  if(profile.basis)assert.equal(snapshot.context.resultBasis,profile.basis);
  stats.quality=snapshot.context.quality;stats.basis=snapshot.context.resultBasis;stats.reconciliation=snapshot.reconciliation.status;
  stats.newPublicationAvailable=Boolean(snapshot.context.update.availablePublicationId);
  if(profile.expectNewPublication){assert.ok(stats.newPublicationAvailable);assert.notEqual(snapshot.context.update.availablePublicationId,input.publicationId);}
  stats.generationCount=new Set((snapshot.context.publication.dayRefs??[]).map(day=>day.generationId)).size;
  for(const reason of snapshot.context.missingReasons)stats.reasons.add(typeof reason==='string'?reason:reason.code);
  for(const check of snapshot.reconciliation.checks)assert.notEqual(check.status,'mismatch');
  for(const item of items){
    const card=await reader.readPublishedSkuCard(userId,{...input,productId:item.productId});
    contextEqual(card.context,input);assert.deepEqual(card.item,item);
    assert.deepEqual(card.storeLines,snapshot.storeLines);
    const before=item.metrics.availableResultBeforeTax.amount;
    if(before!==null)assert.equal(sum(item.groups.filter(group=>group.categoryCode!=='estimated_usn_tax')),money(before));
    else assert.equal(item.metrics.availableResultBeforeTax.availability,'unavailable');
    for(const group of item.groups){
      await sources(userId,input,group,stats);
      if(group.taxBasisAvailable)await sources(userId,input,group,stats,true);
    }
  }
  for(const group of snapshot.storeLines)await sources(userId,input,group,stats);
  if(snapshot.context.quality!=='unavailable'){
    const selected=sum(items.flatMap(item=>item.groups).filter(group=>group.categoryCode!=='estimated_usn_tax'));
    const store=sum(snapshot.storeLines.filter(group=>group.categoryCode!=='estimated_usn_tax'));
    assert.equal(selected,money(snapshot.context.totals.selectedProductsResultBeforeTax));
    assert.equal(store,money(snapshot.context.totals.storeLevelResultBeforeTax));
    assert.equal(selected+(snapshot.context.scope.includesStoreResult?store:0n),money(snapshot.context.totals.availableResultBeforeTax));
  }else assert.equal(snapshot.context.totals,null);
  const filtered=await reader.readPublishedSkuList(userId,{...input,search:'p05-no-match-'+randomUUID(),limit:100});
  assert.equal(filtered.items.length,0);assert.deepEqual(filtered.storeLines,snapshot.storeLines);assert.deepEqual(filtered.context,snapshot.context);
  const situations=await reader.readPublishedSituations(userId,input);
  contextEqual(situations.context,input);assert.ok(!situations.items.some(item=>item.kind==='return_growth'));
  if(situations.total!==null)assert.equal(situations.total,situations.items.length);
  for(const item of situations.items){
    const detail=await reader.readPublishedSituation(userId,{...input,situationId:item.id});
    assert.deepEqual(detail.item,item);contextEqual(detail.context,input);assert.equal(sum(item.groups),money(item.metric.value));
  }
  await assert.rejects(reader.readPublishedSituation(userId,{...input,situationId:'return_growth'}),{message:'drilldown_not_found'});
  stats.sku=items.length;stats.situations=situations.items.length;stats.situationStatus=situations.status;
  for(const reason of situations.missingReasons)stats.reasons.add(reason);
  return {snapshot,items,situations,stats};
}
async function profileHttp(base,input,read,result){
  const page=async url=>{pinned(url,input);return read(url);};
  const overview=await page(new URL(`/overview?${new URLSearchParams(input)}`,base));
  const skuUrl=links(overview,base,'/sku').find(url=>url.searchParams.get('publicationId')===input.publicationId);
  assert.ok(skuUrl);const skuHtml=await page(skuUrl);
  const expectedBasis=result.snapshot.context.resultBasis==='after_tax'?'после налога':result.snapshot.context.resultBasis==='before_tax'?'до налога':'недоступно';
  assert.ok(skuHtml.includes(`Основание результата: ${expectedBasis}`));
  const available=result.snapshot.context.update.availablePublicationId;
  if(available){
    const fresh=links(skuHtml,base,'/sku').find(url=>url.searchParams.get('publicationId')===available);
    assert.ok(fresh);pinned(fresh,{...input,publicationId:available});
  }
  const chosen=result.items.find(item=>item.groups.length);
  if(chosen){
    const cardUrl=links(skuHtml,base,'/sku/card').find(url=>url.searchParams.get('productId')===chosen.productId);
    assert.ok(cardUrl);const cardHtml=await page(cardUrl);
    const sourceUrl=links(cardHtml,base,'/sku/sources').find(url=>!url.searchParams.has('taxBasis'));
    assert.ok(sourceUrl);const sourceHtml=await page(sourceUrl);
    assert.ok(sourceHtml.includes('Область проверки источников: выданная страница'));
    assert.ok(sourceHtml.includes('Сверка всей группы'));
    const back=links(sourceHtml,base,'/sku/card').find(url=>url.searchParams.get('productId')===chosen.productId);
    assert.ok(back);const backHtml=await page(back);
    const overviewBack=links(backHtml,base,'/overview').find(url=>url.searchParams.get('publicationId')===input.publicationId);
    assert.ok(overviewBack);await page(overviewBack);
  }
  const listUrl=links(overview,base,'/situations').find(url=>url.searchParams.get('publicationId')===input.publicationId);
  assert.ok(listUrl);const listHtml=await page(listUrl);
  assert.deepEqual(links(listHtml,base,'/situation').map(url=>url.searchParams.get('situationId')),result.situations.items.map(item=>item.id));
  for(const chosenSituation of result.situations.items.filter(item=>item.groups.length)){
    const detailUrl=links(listHtml,base,'/situation').find(url=>url.searchParams.get('situationId')===chosenSituation.id);
    const detailHtml=await page(detailUrl),sourceUrl=links(detailHtml,base,'/sku/sources')[0];
    assert.ok(sourceUrl);assert.equal(sourceUrl.searchParams.get('situationId'),chosenSituation.id);
    const sourceHtml=await page(sourceUrl),back=links(sourceHtml,base,'/situation').find(url=>url.searchParams.get('situationId')===chosenSituation.id);
    assert.ok(back);await page(back);
  }
}
async function blockedServer(){
  const send=(res,status,body,headers={})=>{res.writeHead(status,{'content-type':'text/html; charset=utf-8',...headers});res.end(body);};
  const redirect=(res,location)=>{res.writeHead(303,{location,'cache-control':'no-store'});res.end();};
  const never=async()=>{throw new Error('p05_live_current_state_forbidden');};
  const drilldown=createDrilldownRoutes({listStores,getFinancialOverview:never,...reader,
    skuListPage,skuCardPage,skuSourcesPage,situationsListPage,situationDetailPage,send,redirect});
  const overview=createOverviewRoutes({listStores,getOverviewState:never,...reader,
    getOperationalOverview:async()=>null,overviewPage,send,redirect});
  localServer=http.createServer(async(req,res)=>{
    try{
      const cookie=String(req.headers.cookie??'').match(/(?:^|;\s*)mc_session=([^;]+)/)?.[1];
      const current=cookie?await findSession(hashToken(cookie)):null;
      const url=new URL(req.url,'http://127.0.0.1');
      if(await drilldown(req,res,url,current)||await overview(req,res,url,current))return;
      send(res,404,'Not found');
    }catch{send(res,500,'Acceptance handler failed');}
  });
  await new Promise((resolve,reject)=>{localServer.once('error',reject);localServer.listen(0,'127.0.0.1',resolve);});
  return new URL(`http://127.0.0.1:${localServer.address().port}`);
}
try{
  assert.ok(process.env.P05_LIVE_CONTEXT_PATH&&process.env.DATABASE_URL);
  assert.ok(Number.isInteger(pageLimit)&&pageLimit>=1&&pageLimit<=100);
  const base=new URL(process.env.P05_LIVE_BASE_URL??'http://127.0.0.1:3000');
  assert.ok(base.protocol==='http:'&&['127.0.0.1','localhost'].includes(base.hostname)&&!base.username&&!base.password);
  const {userId,businessId,profiles}=JSON.parse(await readFile(process.env.P05_LIVE_CONTEXT_PATH,'utf8'));
  assert.ok(userId&&businessId&&Array.isArray(profiles)&&profiles.length);
  const role=(await pool.query('select rolsuper,rolbypassrls from pg_roles where rolname=current_user')).rows[0];
  assert.equal(role.rolsuper,false);assert.equal(role.rolbypassrls,false);
  const before=await counters(userId,businessId),session=createSessionToken();
  sessionHash=session.tokenHash;
  await saveSession({userId,tokenHash:sessionHash,expiresAt:new Date(Date.now()+3600000)});
  const makeRead=(allowedBase,counter)=>async url=>{
    assert.equal(url.origin,allowedBase.origin);
    const response=await httpFetch(url,{headers:{cookie:`mc_session=${session.token}`},redirect:'manual'});
    summary[counter]++;assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');return response.text();
  };
  globalThis.fetch=async()=>{wbAttempts++;throw new Error('p05_live_external_fetch_forbidden');};
  const localBase=await blockedServer();
  for(let index=0;index<profiles.length;index++){
    stage=`profile_${index+1}_read`;const result=await profileRead(userId,profiles[index]);
    stage=`profile_${index+1}_http`;await profileHttp(base,profiles[index].input,makeRead(base,'httpRequests'),result);
    stage=`profile_${index+1}_blocked_http`;await profileHttp(localBase,profiles[index].input,makeRead(localBase,'blockedHttpRequests'),result);
    result.stats.reasons=[...result.stats.reasons].sort();summary.profiles.push(result.stats);
  }
  stage='read_only_counters';const after=await counters(userId,businessId);
  summary.databaseDeltas={jobs:after.jobs-before.jobs,reportVersions:after.report_versions-before.report_versions};
  assert.deepEqual(after,before);assert.equal(wbAttempts,0);
  summary.wbFetchAttempts=wbAttempts;
  console.log(JSON.stringify({status:'verified_saved_data',...summary}));
}catch(error){
  const line=Number(error.stack?.match(/p05-live\.acceptance\.mjs:(\d+):/)?.[1])||null;
  console.error(JSON.stringify({status:'failed',stage,line,wbFetchAttempts:wbAttempts}));process.exitCode=1;
}finally{
  if(localServer?.listening){localServer.closeAllConnections();await new Promise(resolve=>localServer.close(resolve));}
  globalThis.fetch=httpFetch;
  try{if(sessionHash)await deleteSession(sessionHash);}
  catch{console.error(JSON.stringify({status:'session_cleanup_failed'}));process.exitCode=1;}
  await pool.end();
}
