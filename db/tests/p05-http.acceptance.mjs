import assert from 'node:assert/strict';
import http from 'node:http';
import { createDrilldownRoutes } from '../../app/modules/calculation/drilldown.routes.mjs';
import { createOverviewRoutes } from '../../app/modules/overview/overview.routes.mjs';
import { skuListPage, skuCardPage, skuSourcesPage } from '../../app/frontend/sku.page.mjs';
import { situationsListPage, situationDetailPage } from '../../app/frontend/situations.page.mjs';
import { overviewPage } from '../../app/frontend/pages.mjs';
import { createSessionToken, hashToken } from '../../app/modules/auth/auth.mjs';
import { saveSession, findSession, deleteSession } from '../../app/modules/auth/auth.repository.mjs';

function links(html,base,path){
  return [...html.matchAll(/href="([^"]+)"/g)].map(match=>new URL(match[1].replaceAll('&amp;','&'),base)).filter(url=>url.pathname===path);
}
export async function verifyPublishedDrilldownHttp({reader,viewer,storeId,inputs,availablePublicationId}){
  const {token,tokenHash}=createSessionToken();
  await saveSession({userId:viewer,tokenHash,expiresAt:new Date(Date.now()+120000)});
  const send=(res,status,body,headers={})=>{res.writeHead(status,{'content-type':'text/html; charset=utf-8',...headers});res.end(body);};
  const redirect=(res,location)=>{res.writeHead(303,{location,'cache-control':'no-store'});res.end();};
  const listStores=async()=>[{id:storeId,name:'Магазин проверки',connected:true}];
  const never=async()=>{throw new Error('p05_http_must_not_read_current_or_call_external_services');};
  const drilldown=createDrilldownRoutes({listStores,getFinancialOverview:never,...reader,skuListPage,skuCardPage,skuSourcesPage,situationsListPage,situationDetailPage,send,redirect});
  const overview=createOverviewRoutes({listStores,getOverviewState:never,readPublishedSkuList:reader.readPublishedSkuList,
    readPublishedSituations:reader.readPublishedSituations,
    getOperationalOverview:async()=>null,overviewPage,send,redirect});
  const server=http.createServer(async(req,res)=>{
    try{
      const cookie=String(req.headers.cookie??'').match(/(?:^|;\s*)mc_session=([^;]+)/)?.[1];
      const current=cookie?await findSession(hashToken(cookie)):null;
      const url=new URL(req.url,'http://localhost');
      if(await drilldown(req,res,url,current)||await overview(req,res,url,current))return;
      send(res,404,'Not found');
    }catch(error){send(res,500,error.message);}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  const headers={cookie:`mc_session=${token}`};
  async function read(url){const response=await fetch(url,{headers,redirect:'manual'});assert.equal(response.status,200,await response.clone().text());assert.equal(response.headers.get('cache-control'),'no-store');return response.text();}
  try{
    assert.equal((await fetch(`${base}/sku`,{redirect:'manual'})).status,303);
    for(const input of inputs){
      const snapshot=await reader.readPublishedSkuList(viewer,input);
      const overviewUrl=`${base}/overview?${new URLSearchParams(input)}`;
      const overviewHtml=await read(overviewUrl);
      const situations=await reader.readPublishedSituations(viewer,input);
      assert.deepEqual(links(overviewHtml,base,'/situation').map(url=>url.searchParams.get('situationId')),situations.items.slice(0,3).map(item=>item.id),'overview keeps its first-three limit');
      const situationsUrl=links(overviewHtml,base,'/situations').find(url=>url.searchParams.get('publicationId')===input.publicationId);
      assert.ok(situationsUrl,'overview opens the complete situation list');
      const situationsHtml=await read(situationsUrl);
      const detailUrls=links(situationsHtml,base,'/situation');
      assert.deepEqual(detailUrls.map(url=>url.searchParams.get('situationId')),situations.items.map(item=>item.id));
      for(const situation of situations.items){
        const detailUrl=detailUrls.find(url=>url.searchParams.get('situationId')===situation.id);
        const detailHtml=await read(detailUrl);
        const sourceUrls=links(detailHtml,base,'/sku/sources');
        assert.deepEqual(new Set(sourceUrls.map(url=>url.searchParams.get('groupKey'))),new Set(situation.groups.map(group=>group.groupKey)), 'detail exposes saved before-tax categories and no foreign groups');
        if(situation.kind==='product_loss'){
          assert.ok(detailHtml.includes('Из чего сложился убыток'));
          assert.ok(detailHtml.includes('Заказы:'));
          assert.ok(detailHtml.includes('Выкупы:'));
          assert.ok(detailHtml.includes('по дате исходного заказа'));
          assert.ok(detailHtml.includes('Расчётный налог по товару'));
          assert.ok(!detailHtml.includes('Требуется заплатить налог'));
          assert.ok(!detailHtml.includes('База и ставка'));
          assert.ok(!detailHtml.includes('По выручке:'));
        }
        for(const sourceUrl of sourceUrls){
          assert.equal(sourceUrl.searchParams.get('situationId'),situation.id);
          const sourceHtml=await read(sourceUrl);
          if(sourceUrl.hash)assert.ok(sourceHtml.includes(`id="${decodeURIComponent(sourceUrl.hash.slice(1))}"`),'revenue row detail targets its frozen contribution');
          const back=links(sourceHtml,base,'/situation').find(url=>url.searchParams.get('situationId')===situation.id);
          assert.ok(back,'source page returns to its actual situation');
          for(const url of [situationsUrl,detailUrl,sourceUrl,back])for(const key of ['storeId','publicationId','publicationSource','periodStart','periodEnd'])assert.equal(url.searchParams.get(key),input[key]);
          const foreignGroup=new URL(sourceUrl);foreignGroup.searchParams.set('groupKey','foreign');
          assert.equal((await fetch(foreignGroup,{headers})).status,404);
        }
      }
      assert.equal((await fetch(`${base}/situation?${new URLSearchParams({...input,situationId:'return_growth'})}`,{headers})).status,404);
      const listUrl=links(overviewHtml,base,'/sku').find(url=>url.searchParams.get('publicationId')===input.publicationId);
      assert.ok(listUrl,'overview links to the same immutable publication');
      const listHtml=await read(listUrl);
      assert.ok(listHtml.includes('Общие строки магазина'));
      if(input.publicationId!==availablePublicationId&&input.publicationSource==='daily')assert.ok(listHtml.includes('Открыть новую публикацию'));
      const selectedItem=snapshot.items.find(item=>item.groups.some(group=>group.categoryCode==='cost_of_goods'));
      assert.ok(selectedItem,'persisted fixture includes SKU cost');
      const cardUrl=links(listHtml,base,'/sku/card').find(url=>url.searchParams.get('productId')===selectedItem.productId);assert.ok(cardUrl);
      const cardHtml=await read(cardUrl);
      const sourceUrl=links(cardHtml,base,'/sku/sources').find(url=>url.searchParams.get('groupKey')?.includes('cost_of_goods'));
      assert.ok(sourceUrl,'cost category opens sources');
      const sourceHtml=await read(sourceUrl);
      assert.ok(sourceHtml.includes('Проверенные поля источника'));
      assert.ok(sourceHtml.includes('Всего вкладов:'));
      const group=selectedItem.groups.find(group=>group.categoryCode==='cost_of_goods');
      assert.ok(sourceHtml.includes(group.amountSigned),'group amount remains exact in source page');
      const backUrl=links(sourceHtml,base,'/sku/card')[0];assert.ok(backUrl);
      const backHtml=await read(backUrl);
      const overviewBack=links(backHtml,base,'/overview').find(url=>url.searchParams.get('publicationId')===input.publicationId);
      assert.ok(overviewBack);const returnedOverview=await read(overviewBack);assert.ok(!returnedOverview.includes('Сохранённая публикация'));assert.ok(links(returnedOverview,base,'/sku').some(url=>url.searchParams.get('publicationId')===input.publicationId));
      for(const url of [listUrl,cardUrl,sourceUrl,backUrl,overviewBack]){
        for(const key of ['storeId','publicationId','publicationSource','periodStart','periodEnd'])assert.equal(url.searchParams.get(key),input[key],`${key} remains pinned`);
      }
      for(const [path,change]of [['/sku',{publicationId:'ffffffff-ffff-4fff-8fff-ffffffffffff'}],
        ['/sku/card',{productId:'ffffffff-ffff-4fff-8fff-ffffffffffff'}],['/sku/sources',{productId:cardUrl.searchParams.get('productId'),groupKey:'foreign'}]]){
        const response=await fetch(`${base}${path}?${new URLSearchParams({...input,...change})}`,{headers});assert.equal(response.status,404);
      }
      if(input.publicationSource==='legacy'){
        const basisUrl=links(cardHtml,base,'/sku/sources').find(url=>url.searchParams.get('taxBasis')==='1');assert.ok(basisUrl);
        assert.ok((await read(basisUrl)).includes('Это база, а не прямой денежный вклад в налог'));
      }
    }
  }finally{
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await deleteSession(tokenHash);
  }
}
