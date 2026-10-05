import test from 'node:test';
import assert from 'node:assert/strict';
import { skuListPage, skuCardPage, skuSourcesPage } from './sku.page.mjs';

const user={id:'viewer',stores:[]},stores=[{id:'store-one',name:'Магазин',connected:true}];
const context={storeId:'store-one',publication:{source:'daily',id:'frozen-publication',publishedAt:'2026-10-01'},period:{start:'2026-09-01',end:'2026-09-30'},method:{version:'financial-result-v36'},quality:'partial',missingReasons:[{code:'operation_unclassified',scope:'store'}],resultBasis:'before_tax',coverage:{covered:{start:'2026-09-01',end:'2026-09-25'},complete:false},scope:{productIds:['product-one'],includesStoreResult:true},totals:{selectedProductsResultBeforeTax:'123.0000',storeLevelResultBeforeTax:'-8.0000',availableResultBeforeTax:'115.0000',availableResultAfterTax:null},update:{status:'running',availablePublicationId:'new-publication'}};
const group={groupKey:'["selected_product","product-one","revenue"]',scope:'selected_product',productId:'product-one',categoryCode:'revenue',amountSigned:'9007199254740993.1250',lineCount:1,evidenceStatus:'unchecked',missingReasons:[]};
const metric=(amount,groupKeys=[])=>({amount,availability:amount===null?'unavailable':'partial',missingReasons:amount===null?['drilldown_metric_unavailable']:[],groupKeys});
const item={productId:'product-one',name:'Термокружка <script>',sellerArticle:'ART&1',wbArticle:'123',isHistorical:true,quality:'partial',missingReasons:[],metrics:{revenue:metric(group.amountSigned,[group.groupKey]),wbExpenses:metric('-0.0050'),costOfGoods:metric(null),externalExpenses:metric('0.0000'),tax:metric(null),availableResultBeforeTax:metric('123.0000'),availableResultAfterTax:metric(null)},groups:[group]};
const reconciliation={status:'matched',checks:[{code:'selected_products_before_tax',expected:'123.0000',actual:'123.0000',status:'matched'}]};
const options={listState:{search:'кружка &',sort:'revenue_desc',cursor:'list-page',limit:25}};
function links(html,path){return [...html.matchAll(/href="([^"]+)"/g)].map(match=>new URL(match[1].replaceAll('&amp;','&'),'https://mc.test')).filter(url=>url.pathname===path);}
function fixed(url){for(const[key,value]of Object.entries({storeId:context.storeId,publicationSource:'daily',publicationId:context.publication.id,periodStart:context.period.start,periodEnd:context.period.end}))assert.equal(url.searchParams.get(key),value);}

test('unpublished list keeps the selected store and requested period on return to overview',()=>{
  const html=skuListPage(user,stores,null,{selectedStoreId:'store-one',period:{start:'2026-09-01',end:'2026-09-30'}});
  const back=links(html,'/overview').find(url=>url.searchParams.get('periodStart'));
  assert.ok(back);assert.equal(back.searchParams.get('storeId'),'store-one');
  assert.equal(back.searchParams.get('periodEnd'),'2026-09-30');assert.equal(back.searchParams.has('publicationId'),false);
});

test('list preserves immutable links, search state and pagination while filter resets cursor',()=>{
  const html=skuListPage(user,stores,{context,items:[item],storeLines:[],totalItems:1,scopeItemCount:1,nextCursor:'next-list',reconciliation},options);
  const card=links(html,'/sku/card')[0];fixed(card);assert.equal(card.searchParams.get('search'),'кружка &');assert.equal(card.searchParams.get('listCursor'),'list-page');assert.equal(card.searchParams.get('productId'),'product-one');
  const next=links(html,'/sku').find(url=>url.searchParams.get('cursor')==='next-list');fixed(next);assert.equal(next.searchParams.get('sort'),'revenue_desc');
  const form=html.match(/<form class="sku-filter"[\s\S]*?<\/form>/)[0];assert.doesNotMatch(form,/name="cursor"/);assert.match(form,/name="publicationId" value="frozen-publication"/);
  for(const sort of ['result_asc','result_desc','revenue_asc','revenue_desc'])assert.match(form,new RegExp(`value="${sort}"`));
  assert.equal((html.match(/Общие строки и итог магазина/g)||[]).length,1);
  const selectedMenu=html.match(/class="store-popover-item selected" href="([^"]+)"/)[1];
  fixed(new URL(selectedMenu.replaceAll('&amp;','&'),'http://localhost'));
  const switched=skuListPage(user,[...stores,{id:'store-two',name:'Второй'}],{context,items:[item],storeLines:[]},options);
  const other=links(switched,'/sku').find(url=>url.searchParams.get('storeId')==='store-two');
  assert.ok(other);assert.equal(other.searchParams.has('publicationId'),false);
  assert.equal(other.searchParams.get('periodStart'),context.period.start);
});
test('money uses exact decimal rounding for values beyond floating point precision and signed offsets',()=>{
  const html=skuCardPage(user,stores,{context,item,reconciliation},options);
  assert.match(html,/9 007 199 254 740 993,13 ₽/);assert.match(html,/title="Точная сумма: 9007199254740993.1250 ₽"/);assert.match(html,/−0,01 ₽/);assert.match(html,/0,00 ₽/);assert.match(html,/Недостаточно данных для этого показателя/);
  assert.doesNotMatch(html,/Чистая прибыль/);
});
test('card shows SKU and historical metadata, escapes catalogue content and keeps period reasons separate',()=>{
  const html=skuCardPage(user,stores,{context,item,reconciliation},options);
  assert.match(html,/Термокружка &lt;script&gt;/);assert.doesNotMatch(html,/Термокружка <script>/);assert.match(html,/ART&amp;1/);assert.match(html,/Исторический \/ удалённый товар/);assert.match(html,/отдельного SKU/);assert.match(html,/Причины периода/);assert.match(html,/магазин \/ период/);assert.match(html,/Результат обновляется/);assert.match(html,/2026-09-25/);
  const back=links(html,'/sku').find(url=>url.searchParams.get('cursor')==='list-page');fixed(back);
  for(const url of links(html,'/sku/sources')){fixed(url);assert.equal(url.searchParams.get('groupKey'),group.groupKey);}
  assert.doesNotMatch(html,/>product-one</);
});
test('sources distinguish page evidence from full group reconciliation and preserve exact source fields',()=>{
  const source={sourceKind:'financial_component',sourceAmount:'9007199254740993.1250001',reportVersionId:'frozen-version',reportNormalizationId:'frozen-normalization',operationVersionId:'operation-version',accountingDate:'2026-09-02',quantity:'2.0000',raw:{reportId:'1234',rrdId:'5678',sellerOperName:'Продажа <img>',secret:'secret-marker'},sql:'internal-marker'};
  const html=skuSourcesPage(user,stores,{context,group,product:item,items:[{contributionAmount:group.amountSigned,source,evidenceStatus:'matched',missingReasons:[]}],totalItems:2,nextCursor:'next-source',evidenceStatus:'unchecked',sourceValidationScope:'page',reconciliation,moneyReconciliation:reconciliation},options);
  assert.match(html,/Остальные страницы источников не проверены/);assert.match(html,/Сверка всей группы: доступные суммы сходятся/);assert.match(html,/Область проверки источников: выданная страница/);assert.match(html,/9007199254740993.1250001/);assert.match(html,/Замороженная нормализация/);assert.match(html,/5678/);assert.match(html,/Продажа &lt;img&gt;/);assert.doesNotMatch(html,/secret-marker|internal-marker/);
  const next=links(html,'/sku/sources')[0];fixed(next);assert.equal(next.searchParams.get('cursor'),'next-source');assert.equal(next.searchParams.get('listCursor'),'list-page');assert.equal(next.searchParams.get('groupKey'),group.groupKey);
});
test('unavailable evidence retains persisted contribution with human reason',()=>{
  const html=skuSourcesPage(user,stores,{context,group,product:item,items:[{contributionAmount:'-12.3400',source:null,evidenceStatus:'unavailable',missingReasons:['drilldown_frozen_source_missing']}],evidenceStatus:'unavailable',missingReasons:['drilldown_frozen_source_missing'],reconciliation:{status:'mismatch'},sourceValidationScope:'page'},options);
  assert.match(html,/−12,34 ₽/);assert.match(html,/Источник недоступен/);assert.match(html,/Не найдена подтверждённая сохранённая версия источника/);assert.match(html,/обнаружено несоответствие/);
});
test('legacy tax basis pagination preserves mode and renders tax settings, segments and summary separately',()=>{
  const legacy={...context,publication:{...context.publication,source:'legacy'}},taxGroup={...group,categoryCode:'estimated_usn_tax',taxBasisAvailable:true};
  const html=skuSourcesPage(user,stores,{context:legacy,group:taxGroup,product:item,items:[{basisContributionAmount:'200.0000',taxComputationId:'tax-id',segment:{id:'segment',taxSettingVersionId:'setting-version',start:'2026-09-01',end:'2026-09-30',taxableBase:'200.0000',rateFraction:'0.06'},source:null,evidenceStatus:'unavailable'}],taxSummary:[{contributionAmount:'-12.0000',source:{sourceKind:'tax_computation',taxAmount:'12.0000'},evidenceStatus:'matched'}],evidenceStatus:'unchecked',sourceValidationScope:'page',nextCursor:'tax-next'}, {...options,taxBasis:true});
  assert.match(html,/Это база, а не прямой денежный вклад в налог/);assert.match(html,/Сохранённый налог/);assert.match(html,/setting-version/);assert.match(html,/0.06/);
  const next=links(html,'/sku/sources')[0];assert.equal(next.searchParams.get('taxBasis'),'1');assert.equal(next.searchParams.get('publicationSource'),'legacy');
});
test('daily tax exact facts remain visible without treating base as tax amount',()=>{
  const html=skuSourcesPage(user,stores,{context,group,product:item,items:[{basisContributionAmount:'-0.123456789012',taxFact:{taxBaseUnrounded:'-0.123456789012',taxNumeratorUnrounded:'-0.007407407341',taxRateFraction:'0.06',taxSettingVersionId:'daily-setting'},source:null,evidenceStatus:'unavailable'}],evidenceStatus:'unavailable'},options);
  assert.match(html,/-0.123456789012/);assert.match(html,/-0.007407407341/);assert.match(html,/daily-setting/);assert.match(html,/сумма базы не является суммой налога/);
});
test('store contributions links use store scope and are not attributed to product',()=>{
  const storeGroup={...group,scope:'store',productId:null,categoryCode:'storage',groupKey:'store-storage'};
  const html=skuListPage(user,stores,{context,items:[],storeLines:[storeGroup],reconciliation},options);
  const link=links(html,'/sku/sources')[0];fixed(link);assert.equal(link.searchParams.get('scope'),'store');assert.equal(link.searchParams.get('productId'),null);
  const sources=skuSourcesPage(user,stores,{context,group:storeGroup,items:[],evidenceStatus:'unavailable'},options);assert.match(sources,/Общие строки магазина/);assert.equal(links(sources,'/sku/card').length,0);
});
test('missing publication and historical title produce useful unavailability without invented zero',()=>{
  for(const renderer of [skuListPage,skuCardPage,skuSourcesPage]){const html=renderer(user,stores);assert.match(html,/Опубликованный финансовый результат пока недоступен/);assert.doesNotMatch(html,/0,00 ₽/);}
  const html=skuCardPage(user,stores,{context,item:{...item,name:null,sellerArticle:null,wbArticle:null}},options);assert.match(html,/Название товара не сохранено/);assert.doesNotMatch(html,/>product-one</);
});
test('source variants use human metadata and escaped barcodes with no identifier fallback title',()=>{
  const source={sourceKind:'sale_cost',variantId:'variant-uuid',variant:{sizeLabel:'XL <',colorLabel:'Красный &',barcodes:['123','<img>'],isHistorical:true},unitCost:'14.5000',quantity:'2.0000',effectiveFrom:'2026-08-01'};
  const html=skuSourcesPage(user,stores,{context,group,product:item,items:[{contributionAmount:'-29.0000',source,evidenceStatus:'matched'}]},options);
  assert.match(html,/XL &lt;/);assert.match(html,/Красный &amp;/);assert.match(html,/Штрихкоды: 123, &lt;img&gt;/);assert.match(html,/исторический вариант/);assert.doesNotMatch(html,/variant-uuid/);
});
test('supported tax basis link, safe image and human reconciliation labels are rendered',()=>{
  const html=skuCardPage(user,stores,{context,item:{...item,imageUrl:'javascript:alert(1)',groups:[{...group,taxBasisAvailable:true}]},reconciliation},options);
  assert.doesNotMatch(html,/javascript:|selected_products_before_tax/);assert.match(html,/Результат выбранных SKU до налога/);
  assert.equal(links(html,'/sku/sources').find(url=>url.searchParams.has('taxBasis')).searchParams.get('taxBasis'),'1');
  const photo=skuCardPage(user,stores,{context,item:{...item,imageUrl:'https://images.example/photo?a=1&b=2'}},options);assert.match(photo,/src="https:\/\/images.example\/photo\?a=1&amp;b=2"/);
});
