import test from 'node:test';
import assert from 'node:assert/strict';
import { skuListPage, skuCardPage, skuSourcesPage } from './sku.page.mjs';
import { compareAmounts, compareRows, isZeroAmount, marginPercent, productStatus, matchesFilter, csvCell, csvHeaders, csvRecord, cardContent, completeWeeks, formatMoney, buyoutFields, buyoutPercent, createCardLoader } from './public/sku.js';

const user={id:'viewer',stores:[]},stores=[{id:'store-one',name:'Магазин',connected:true}];
const context={storeId:'store-one',publication:{source:'daily',id:'frozen-publication',publishedAt:'2026-10-01'},period:{start:'2026-09-01',end:'2026-09-30'},method:{version:'financial-result-v36'},quality:'partial',missingReasons:[{code:'operation_unclassified',scope:'store'}],resultBasis:'before_tax',coverage:{covered:{start:'2026-09-01',end:'2026-09-25'},complete:false},scope:{productIds:['product-one'],includesStoreResult:true},totals:{selectedProductsResultBeforeTax:'123.0000',storeLevelResultBeforeTax:'-8.0000',availableResultBeforeTax:'115.0000',availableResultAfterTax:null},update:{status:'running',availablePublicationId:'new-publication'}};
const group={groupKey:'["selected_product","product-one","revenue"]',scope:'selected_product',productId:'product-one',categoryCode:'revenue',amountSigned:'9007199254740993.1250',lineCount:1,evidenceStatus:'unchecked',missingReasons:[]};
const metric=(amount,groupKeys=[])=>({amount,availability:amount===null?'unavailable':'partial',missingReasons:amount===null?['drilldown_metric_unavailable']:[],groupKeys});
const item={productId:'product-one',name:'Термокружка <script>',sellerArticle:'ART&1',wbArticle:'123',isHistorical:true,quality:'partial',missingReasons:[],metrics:{revenue:metric(group.amountSigned,[group.groupKey]),wbExpenses:metric('-0.0050'),costOfGoods:metric(null),externalExpenses:metric('0.0000'),tax:metric(null),availableResultBeforeTax:metric('123.0000'),availableResultAfterTax:metric(null)},groups:[group]};
const reconciliation={status:'matched',checks:[{code:'selected_products_before_tax',expected:'123.0000',actual:'123.0000',status:'matched'}]};
const options={listState:{search:'кружка &',sort:'revenue_desc',cursor:'list-page',limit:25}};
function links(html,path){return [...html.matchAll(/href="([^"]+)"/g)].map(match=>new URL(match[1].replaceAll('&amp;','&'),'https://mc.test')).filter(url=>url.pathname===path);}
function fixed(url){for(const[key,value]of Object.entries({storeId:context.storeId,publicationSource:'daily',publicationId:context.publication.id,periodStart:context.period.start,periodEnd:context.period.end}))assert.equal(url.searchParams.get(key),value);}

function cardUrl(overrides={}) {
  return new URL(`/sku/card?${new URLSearchParams({storeId:context.storeId,publicationSource:context.publication.source,publicationId:context.publication.id,periodStart:context.period.start,periodEnd:context.period.end,productId:item.productId,...overrides})}`,'https://mc.test');
}
function cardResponse(url) {
  const params=url.searchParams;
  return {context:{storeId:params.get('storeId'),publication:{source:params.get('publicationSource'),id:params.get('publicationId')},period:{start:params.get('periodStart'),end:params.get('periodEnd')}},item:{productId:params.get('productId')}};
}
function jsonResponse(data) { return {ok:true,headers:new Headers({'content-type':'application/json'}),json:async()=>data}; }

test('card cache reuses exact frozen context across list filters and expires after 60 seconds without sliding expiry',async()=>{
  let time=0,calls=0;
  const load=createCardLoader({now:()=>time,fetchCard:async(url,options)=>{calls++;assert.equal(options.cache,'no-store');return jsonResponse(cardResponse(url));}});
  const first=await load(cardUrl());
  time=59999;assert.equal(await load(cardUrl({sort:'revenue_desc',search:'changed',listCursor:'next'})),first);assert.equal(calls,1);
  time=60000;assert.notEqual(await load(cardUrl()),first);assert.equal(calls,2);
  for(const [field,value] of Object.entries({storeId:'other-store',publicationSource:'legacy',publicationId:'other-publication',periodStart:'2026-09-02',periodEnd:'2026-09-29',productId:'other-product'}))await load(cardUrl({[field]:value}));
  assert.equal(calls,8);
  const anotherPage=createCardLoader({fetchCard:async url=>{calls++;return jsonResponse(cardResponse(url));}});
  await anotherPage(cardUrl());assert.equal(calls,9);
});

test('card cache retains at most 20 recent successful cards',async()=>{
  let calls=0;
  const load=createCardLoader({now:()=>0,fetchCard:async url=>{calls++;return jsonResponse(cardResponse(url));}});
  for(let index=0;index<20;index++)await load(cardUrl({productId:`product-${index}`}));
  await load(cardUrl({productId:'product-0'}));
  await load(cardUrl({productId:'product-20'}));assert.equal(calls,21);
  await load(cardUrl({productId:'product-0'}));assert.equal(calls,21);
  await load(cardUrl({productId:'product-1'}));assert.equal(calls,22);
});

test('card cache never stores failed, mismatched or aborted responses',async()=>{
  const url=cardUrl();
  const failures=[
    async()=>{throw new Error('offline');},
    async()=>({...jsonResponse(cardResponse(url)),ok:false}),
    async()=>({...jsonResponse(cardResponse(url)),headers:new Headers({'content-type':'text/html'})}),
    async()=>({...jsonResponse(null),json:async()=>{throw new SyntaxError('invalid json');}}),
    ...['storeId','publicationSource','publicationId','periodStart','periodEnd','productId'].map(field=>async()=>jsonResponse(cardResponse(cardUrl({[field]:'other'}))))
  ];
  for(const failure of failures){
    let calls=0;
    const load=createCardLoader({fetchCard:async request=>{calls++;return calls===1?failure():jsonResponse(cardResponse(request));}});
    await assert.rejects(load(url));await load(url);await load(url);assert.equal(calls,2);
  }
  let complete,calls=0;
  const load=createCardLoader({fetchCard:async request=>{calls++;return calls===1?{...jsonResponse(null),json:()=>new Promise(resolve=>{complete=resolve;})}:jsonResponse(cardResponse(request));}});
  const controller=new AbortController(),pending=load(url,controller.signal);
  await Promise.resolve();controller.abort();complete(cardResponse(url));
  await assert.rejects(pending,{name:'AbortError'});
  await load(url);assert.equal(calls,2);
  await assert.rejects(load(url,controller.signal),{name:'AbortError'});assert.equal(calls,2);
  await assert.rejects(load(cardUrl({publicationId:''})),/card_context_changed/);assert.equal(calls,2);
});

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

test('approved complete-scope SKU list has calendar, cards and full-row immutable links',()=>{
  const completeMetric=amount=>({amount,availability:'complete'});
  const complete={...item,quality:'complete',name:'Товар <img onerror="bad">',status:'loss',marginPercent:'-5.0',metrics:{revenue:completeMetric('100.0000'),wbExpenses:completeMetric('25.0000'),costOfGoods:completeMetric('80.0000'),availableResultAfterTax:completeMetric('-5.0000')}};
  const html=skuListPage(user,stores,{context:{...context,quality:'complete'},items:[],presentation:{items:[complete],summary:{skuResult:'-5.0000',revenue:'100.0000',totalCount:1,lossCount:1,nearCount:0,profitCount:0,incompleteCount:0}},storeLines:[]},{...options,listState:{...options.listState,viewFilter:'loss',hideZero:true},today:'2026-10-09'});
  assert.match(html,/Назад к обзору/);assert.match(html,/Товар &lt;img onerror=&quot;bad&quot;&gt;/);assert.doesNotMatch(html,/Товар <img/);
  assert.match(html,/data-sku-row tabindex="0"/);assert.match(html,/data-sku-zero/);assert.match(html,/data-sku-export/);assert.match(html,/Продвижение/);assert.match(html,/−5,0%/);
  const calendar=html.match(/<form class="overview-period-filter"[\s\S]*?<\/form>/)[0];
  assert.match(calendar,/action="\/sku"/);assert.match(calendar,/name="periodStart" value="2026-09-01"/);assert.doesNotMatch(calendar,/publicationId|publicationSource/);
  const card=links(html,'/sku/card')[0];fixed(card);assert.equal(card.searchParams.get('viewFilter'),'loss');assert.equal(card.searchParams.get('hideZero'),'1');
  const back=links(html,'/overview').find(link=>!link.searchParams.has('publicationId')&&link.searchParams.has('periodStart'));assert.ok(back);
  assert.match(html,/Выкуп/);assert.match(html,/Если история отсутствует или неполна/);assert.match(html,/100 завершённых/);assert.match(html,/14 дней/);
});

test('SKU exact presentation arithmetic and filters distinguish unavailable, zero and tiny loss',()=>{
  assert.equal(isZeroAmount(null),false);assert.equal(isZeroAmount(''),false);assert.equal(isZeroAmount('-0.0000'),true);assert.equal(isZeroAmount('0.00001'),false);
  assert.equal(compareAmounts('9007199254740993.0001','9007199254740993.0000'),1);
  assert.equal(marginPercent('-5.0000','100.0000'),'−5,0%');assert.equal(marginPercent('1','0'),null);assert.equal(marginPercent(null,'100'),null);
  const complete=amount=>({amount,availability:'complete'});
  const sample={quality:'complete',metrics:{availableResultAfterTax:complete('0.0000'),revenue:complete('100.0000')}};
  assert.equal(productStatus(sample),'zero');assert.equal(productStatus({...sample,quality:'partial'}),'incomplete');
  assert.equal(productStatus({...sample,metrics:{...sample.metrics,availableResultAfterTax:complete('-0.00001')}}),'loss');
  assert.equal(matchesFilter({search:'товар abc',status:'loss',result:'-0.00001'},{search:'ABC',filter:'loss',hideZero:true}),true);
  assert.equal(matchesFilter({search:'товар',status:'incomplete',result:''},{hideZero:true}),true);
  assert.equal(matchesFilter({search:'товар',status:'near',result:'0.0000'},{hideZero:true}),false);
  assert.equal(csvCell('=HYPERLINK("bad")'),'"\'=HYPERLINK(""bad"")"');assert.equal(csvCell('0.0000'),'"0.0000"');
  assert.equal(csvCell('-1.2500'),'"-1.2500"');assert.equal(csvCell('-cmd'),'"\'-cmd"');
  assert.equal(compareRows({result:''},{result:'10'},'result_desc'),1);assert.equal(compareRows({revenue:null},{revenue:'10'},'revenue_asc'),1);
});

test('reconciliation mismatch suppresses reliable-looking row amounts and margin',()=>{
  const complete=amount=>({amount,availability:'complete'});
  const row={...item,quality:'complete',status:'profit',marginPercent:'10.0',metrics:{revenue:complete('100.0000'),availableResultAfterTax:complete('10.0000')}};
  const html=skuListPage(user,stores,{context:{...context,quality:'complete'},reconciliation:{status:'mismatch'},presentation:{quality:'unavailable',items:[row],summary:{skuResult:null,revenue:null,incompleteCount:1}}},options);
  assert.match(html,/data-status="incomplete"/);assert.match(html,/data-result=""/);assert.doesNotMatch(html,/10,0%|100,00 ₽|10,00 ₽|● Полные финансовые данные/);
});

test('complete SKU screen exposes native modal, every sortable heading and raw CSV fields',()=>{
  const complete=amount=>({amount,availability:'complete'});
  const row={...item,status:'loss',marginPercent:'-5.0',salesCount:14,returnsCount:2,reportIds:['report<&'],metrics:{revenue:complete('100.0000'),availableResultAfterTax:complete('-5.0000'),externalExpenses:complete('12.3456'),tax:complete('6.0000')}};
  const html=skuListPage(user,stores,{context,presentation:{items:[row],summary:{skuResult:'-5.0000'}},storeLines:[]},options);
  assert.match(html,/<dialog class="sku-product-dialog" data-sku-dialog aria-labelledby="sku-dialog-title"/);
  assert.match(html,/data-sku-dialog-close aria-label="Закрыть карточку"/);
  for(const key of ['title','revenue','wb','cost','margin','buyout','result'])assert.match(html,new RegExp(`data-sku-column="${key}"`));
  for(const key of ['title','margin','wb','cost','buyout'])for(const direction of ['asc','desc'])assert.match(html,new RegExp(`value="${key}_${direction}"`));
  assert.match(html,/data-margin="-5.0"/);assert.match(html,/data-external="12.3456"/);assert.match(html,/data-tax="6.0000"/);
  assert.match(html,/data-sales="14"/);assert.match(html,/data-returns="2"/);assert.match(html,/data-reports="report&lt;&amp;"/);
  assert.match(html,/Продажи: 14 · Возвраты: 2/);
  assert.doesNotMatch(html.match(/<tbody>[\s\S]*?<\/tbody>/)[0],/\/sku\/sources/);
});

test('all numeric heading sorts preserve exact precision and keep unavailable values last',()=>{
  for(const key of ['result','revenue','wb','cost','margin','buyout']){
    assert.equal(compareRows({[key]:'9007199254740993.0001'},{[key]:'9007199254740993.0000'},`${key}_asc`),1);
    assert.equal(compareRows({[key]:'-2.25'},{[key]:'-2.50'},`${key}_desc`),-1);
    for(const direction of ['asc','desc'])assert.equal(compareRows({[key]:''},{[key]:'0'},`${key}_${direction}`),1);
  }
  assert.ok(compareRows({name:'Арбуз'},{name:'Яблоко'},'title_asc')<0);
  assert.ok(compareRows({name:'Арбуз'},{name:'Яблоко'},'title_desc')>0);
});

test('complete CSV contract preserves known data and leaves unconfirmed order/promotion facts blank',()=>{
  const record=csvRecord({name:'=danger',seller:'article',article:'123',status:'loss',revenue:'12.123456',wb:'1.25',cost:'20',external:'-1',tax:'2',result:'-10',margin:'-5.0',sales:'14',returns:'2',reports:'001, 002'});
  assert.equal(csvHeaders.length,22);assert.equal(record.length,22);
  assert.equal(record[3],'С убытком');assert.equal(record[4],'12.123456');assert.equal(record[6],'');assert.match(record[7],/Нет подтверждённых/);
  assert.deepEqual(record.slice(8,15),['20','-1','2','-10','-5.0','14','2']);
  assert.equal(record[15],'');assert.match(record[16],/Полной истории/);assert.deepEqual(record.slice(17,21),['','','','']);assert.equal(record[21],'001, 002');
  assert.equal(csvCell(record[0]),'"\'=danger"');assert.equal(csvCell(record[9]),'"-1"');
});

test('modal is compact, escaped and shows signed categories, external expenses, tax, reports and complete weeks',()=>{
  const complete=amount=>({amount,availability:'complete'});
  const presentation={...item,status:'loss',quality:'complete',salesCount:14,returnsCount:2,reportIds:['001','<img onerror="bad">'],metrics:{revenue:complete('100'),wbExpenses:complete('25'),costOfGoods:complete('80'),externalExpenses:complete('0'),tax:complete('1'),availableResultAfterTax:complete('-6')},groups:[{categoryCode:'logistics',amountSigned:'-25',reportIds:['001']},{categoryCode:'daily_tax_range',amountSigned:'-1',reportIds:[]}],weeklyResults:[{start:'2026-09-07',end:'2026-09-13',result:'-6',quality:'complete'},{start:'2026-09-14',end:'2026-09-20',result:null,quality:'partial'},{start:'2026-09-28',end:'2026-10-04',result:'9',quality:'complete'}]};
  const html=cardContent({context,item,presentation});
  assert.match(html,/Логистика/);assert.match(html,/−25,00 ₽/);assert.match(html,/Налог за период/);assert.match(html,/Внешние расходы/);assert.match(html,/14 \/ 2/);assert.match(html,/−6,0%/);
  assert.match(html,/№ 001/);assert.match(html,/&lt;img onerror=&quot;bad&quot;&gt;/);assert.doesNotMatch(html,/<img|\/sku\/sources|Методика|публикаци|04\.10\.2026/);
  assert.match(html,/07\.09\.2026/);assert.match(html,/Нет полных данных/);assert.match(html,/Последние 100/);assert.match(html,/14 дней/);
  assert.equal(formatMoney('9007199254740993.125'),'9 007 199 254 740 993,13 ₽');assert.equal(formatMoney('-0.005'),'−0,01 ₽');assert.equal(formatMoney(null),'—');
});

test('weekly chart excludes partial calendar edges for arbitrary ranges and retains unknown full weeks',()=>{
  const weeks=[{start:'2026-08-31',end:'2026-09-06'},{start:'2026-09-07',end:'2026-09-13',result:null},{start:'2026-09-14',end:'2026-09-20'},{start:'2026-09-15',end:'2026-09-21'},{start:'2026-09-21',end:'2026-09-26'}];
  assert.deepEqual(completeWeeks(weeks,{start:'2026-09-04',end:'2026-09-18'}),[weeks[1]]);
  assert.deepEqual(completeWeeks(weeks,{start:'2026-09-08',end:'2026-09-12'}),[]);
});

test('modal fail-closed suppresses all amounts and weekly bars on reconciliation mismatch',()=>{
  const complete=amount=>({amount,availability:'complete'});
  const html=cardContent({context,reconciliation:{status:'mismatch'},presentation:{...item,quality:'complete',status:'profit',metrics:{revenue:complete('777.12'),availableResultAfterTax:complete('77.12')},groups:[{categoryCode:'logistics',amountSigned:'-77.12',reportIds:[]}],weeklyResults:[{start:'2026-09-07',end:'2026-09-13',quality:'complete',result:'777.12'}]}});
  assert.match(html,/Неполные данные/);assert.doesNotMatch(html,/777,12 ₽|77,12 ₽|10,0%/);assert.match(html,/height:0%/);
});

test('period footer uses presentation report metadata and persisted store totals independent of product filters',()=>{
  const shared={categoryCode:'storage',amountSigned:'-8.0000'};
  const data={context:{...context,totals:{...context.totals,availableResultAfterTax:'90.0000'}},storeLines:[shared],presentation:{items:[],storeLines:[{...shared,reportIds:['001','<report>']}],summary:{skuResult:'98.0000'}}};
  const html=skuListPage(user,stores,data,{...options,listState:{viewFilter:'loss',search:'missing'}});
  const footer=html.match(/<section class="sku-period-footer"[\s\S]*?<details class="sku-technical">/)[0];
  assert.match(footer,/№ 001, № &lt;report&gt;/);assert.match(footer,/−8,00 ₽/);assert.match(footer,/90,00 ₽/);assert.match(footer,/98,00 ₽/);assert.match(footer,/Входят в итог магазина/);assert.doesNotMatch(footer,/\/sku\/sources/);
  const excluded=skuListPage(user,stores,{...data,context:{...data.context,scope:{...context.scope,includesStoreResult:false}}},options);
  assert.match(excluded,/Общие строки магазина \(не включены\)/);assert.match(excluded,/Не включены в итог по методике/);
});

test('confirmed buyout is shown in row and card with sample details and dates under information only',()=>{
  const buyout={status:'available',percent:66.66666666666666,sampleSize:3,counts:{retained:2,returned:1,refused:0},bounds:{start:'2025-09-30',cutoff:'2026-09-16',end:'2026-09-30'},sampleStart:'2026-08-01',sampleEnd:'2026-08-15',smallSample:true};
  const fields=buyoutFields(buyout);
  assert.equal(buyoutPercent(fields.buyout),'66,7%');assert.equal(fields.buyoutreason,'');
  const row={...item,buyout};
  const html=skuListPage(user,stores,{context,presentation:{items:[row],summary:{}},storeLines:[]},options);
  assert.match(html,/data-buyout="66\.66666666666666"/);assert.match(html,/data-samplesize="3"/);assert.match(html,/data-retained="2"/);assert.match(html,/data-returned="1"/);assert.match(html,/data-refused="0"/);assert.match(html,/66,7%/);
  const modal=cardContent({context,item:row,presentation:row});
  assert.match(modal,/<strong>66,7%<\/strong>/);assert.match(modal,/3 завершённых заказов · мало данных/);assert.match(modal,/ⓘ Как рассчитан/);
  const info=modal.match(/<details class="sku-card-buyout">[\s\S]*?<\/details>/)[0];
  assert.match(info,/30\.09\.2025 — 16\.09\.2026/);assert.match(info,/2 из 3 заказов/);assert.match(info,/Возвраты после выкупа: 1; отказы и отмены: 0/);assert.match(info,/01\.08\.2026 — 15\.08\.2026/);
  assert.doesNotMatch(modal.replace(info,''),/30\.09\.2025|16\.09\.2026|01\.08\.2026|15\.08\.2026/);
  const record=csvRecord({...fields});assert.deepEqual(record.slice(15,21),['66.66666666666666','','3','2','1','0']);
});

test('unavailable and inconsistent buyout retain explicit reason without zero or fictitious sample',()=>{
  const unknown={status:'unavailable',reason:'history_missing',percent:null,sampleSize:0,bounds:{start:'2025-09-30',cutoff:'2026-09-16',end:'2026-09-30'}};
  const fields=buyoutFields(unknown);
  assert.equal(fields.buyout,'');assert.equal(fields.samplesize,'');assert.equal(fields.retained,'');assert.match(fields.buyoutreason,/Нет индивидуальной истории/);assert.equal(buyoutPercent(fields.buyout),'—');
  const modal=cardContent({context,item:{...item,buyout:unknown}});
  assert.match(modal,/Расчёт недоступен/);assert.match(modal,/ⓘ Почему недоступен/);assert.match(modal,/Нет индивидуальной истории/);assert.doesNotMatch(modal,/<strong>0,0%|(?<!\d)0 завершённых заказов/);
  assert.deepEqual(csvRecord(fields).slice(17,21),['','','','']);
  const invalid=buyoutFields({status:'available',percent:75,sampleSize:4,counts:{retained:3,returned:1,refused:1}});
  assert.equal(invalid.buyout,'');assert.match(invalid.buyoutreason,/без корректных/);assert.equal(buyoutPercent('NaN'),'—');
});

test('available limited history retains percentage and discloses coverage and source in card and CSV',()=>{
  const buyout={status:'available',percent:100,sampleSize:1,counts:{retained:1,returned:0,refused:0},bounds:{start:'2025-09-30',cutoff:'2026-09-16',end:'2026-09-30'},sampleStart:'2026-08-01',sampleEnd:'2026-08-01',smallSample:true,historyStart:'2026-07-01',historyEnd:'2026-09-20',observedAt:'2026-09-21T12:00:00Z',historyLimited:true,quality:'partial',sourceLimitations:['Статистика WB может не включать заказы без подтверждённой оплаты.']};
  const fields=buyoutFields(buyout),modal=cardContent({context,item:{...item,buyout}});
  assert.equal(fields.buyout,'100');
  assert.match(fields.buyoutreason,/Ограниченная история/);
  assert.match(fields.buyoutreason,/без подтверждённой оплаты/);
  assert.match(modal,/<strong>100,0%<\/strong>/);
  assert.match(modal,/Доступная история: 01\.07\.2026 — 20\.09\.2026/);
  assert.match(modal,/Исходы известны на 20\.09\.2026/);
  assert.match(modal,/Проверено: 2026-09-21T12:00:00Z/);
  assert.match(modal,/Ограниченная история/);
  assert.doesNotMatch(modal,/Расчёт недоступен|все доступные за год|<strong>0,0%/);
  assert.equal(csvRecord(fields).length,22);
  assert.equal(csvRecord(fields)[16],fields.buyoutreason);
});
