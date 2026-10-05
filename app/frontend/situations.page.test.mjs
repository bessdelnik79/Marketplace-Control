import test from 'node:test';
import assert from 'node:assert/strict';
import { situationsListPage, situationDetailPage } from './situations.page.mjs';

const user={id:'viewer'},stores=[{id:'store-one',name:'Магазин',connected:true}];
const context={storeId:'store-one',publication:{source:'daily',id:'frozen-publication',publishedAt:'2026-10-01'},period:{start:'2026-09-01',end:'2026-09-30'},method:{version:'financial-result-v36'},quality:'partial',resultBasis:'before_tax',coverage:{complete:false},update:{status:'current'}};
const product={name:'Кружка <script>',sellerArticle:'ART&1',wbArticle:'123',isHistorical:true};
const group={scope:'selected_product',productId:'product-one',groupKey:'["selected_product","product-one","penalty"]',categoryCode:'penalty',amountSigned:'-12.3400',lineCount:2,evidenceStatus:'unchecked',product};
const penalty={id:'penalty',kind:'penalty',severity:'danger',productId:null,metric:{value:'-7.3400',absoluteValue:'7.3400'},rule:{description:'Знаковое сальдо штрафов и пени',inputs:[{label:'Сальдо',value:'-7.3400',unit:'RUB'}],comparison:'not_equal_zero'},groups:[group,{...group,scope:'store',productId:null,groupKey:'["store",null,"penalty"]',amountSigned:'5.0000',product:null}]};
const loss={id:'product_loss:product-one',kind:'product_loss',severity:'danger',productId:'product-one',product,metric:{value:'-9007199254740993.1250'},rule:{description:'Отрицательный результат до налога',inputs:[{label:'Результат до налога',value:'-9007199254740993.1250',unit:'RUB'}],comparison:'less_than_zero'},groups:[{...group,categoryCode:'revenue',amountSigned:'100.0000'},{...group,categoryCode:'cost_of_goods',groupKey:'cost',amountSigned:'-110.0000'}]};
const data={context,status:'partial',missingReasons:['return_growth_rule_disabled'],evaluatedRules:['product_loss','penalty'],disabledRules:['return_growth'],total:2,items:[loss,penalty]};
function links(html,path){return [...html.matchAll(/href="([^"]+)"/g)].map(match=>new URL(match[1].replaceAll('&amp;','&'),'https://mc.test')).filter(url=>url.pathname===path);}
function fixed(url){for(const[key,value]of Object.entries({storeId:context.storeId,publicationSource:'daily',publicationId:context.publication.id,periodStart:context.period.start,periodEnd:context.period.end}))assert.equal(url.searchParams.get(key),value);}

test('incomplete rule is not called verified and new publication opens situations explicitly',()=>{
  const pending={...context,update:{status:'current',availablePublicationId:'new-publication'}};
  for(const html of [situationsListPage(user,stores,{...data,context:pending,missingReasons:['product_loss_inputs_incomplete']}),
    situationDetailPage(user,stores,{...data,context:pending,item:penalty})]){
    assert.doesNotMatch(html,/Проверенные правила:/);
    const fresh=links(html,'/situations').find(url=>url.searchParams.get('publicationId')==='new-publication');
    assert.ok(fresh);assert.equal(fresh.searchParams.get('storeId'),context.storeId);
    assert.equal(fresh.searchParams.get('periodStart'),context.period.start);
  }
});

test('list renders every supplied situation in reader order beyond overview limit',()=>{
  const items=[...Array.from({length:4},(_,index)=>({...loss,id:`product_loss:p${index}`,productId:`p${index}`,product:{name:`Товар ${index}`}})),penalty];
  const html=situationsListPage(user,stores,{...data,total:5,items});
  assert.match(html,/Найдено ситуаций: 5/);
  const details=links(html,'/situation');
  assert.equal(details.length,5);
  assert.deepEqual(details.map(url=>url.searchParams.get('situationId')),items.map(item=>item.id));
  details.forEach(fixed);
  assert.match(html,/только доказанные срабатывания проверенных правил/);
  assert.match(html,/Число найденных ситуаций не означает, что все правила удалось проверить/);
});

test('unknown count and unavailable publication never turn into zero situations or money',()=>{
  for(const renderer of [situationsListPage,situationDetailPage]){
    const html=renderer(user,stores,null,{selectedStoreId:'store-one',period:context.period});
    assert.match(html,/Опубликованный финансовый результат пока недоступен/);
    assert.doesNotMatch(html,/0,00 ₽|Найдено ситуаций: 0/);
    const back=links(html,'/overview').find(url=>url.searchParams.has('periodStart'));
    assert.equal(back.searchParams.get('storeId'),'store-one');
    assert.equal(back.searchParams.get('periodEnd'),context.period.end);
    assert.equal(back.searchParams.has('publicationId'),false);
  }
  assert.match(situationsListPage(user,stores,{...data,status:'unavailable',total:null,items:[]}),/Найдено ситуаций: неизвестно/);
});

test('zero count refers only to evaluated rules while incomplete inputs are explained',()=>{
  const html=situationsListPage(user,stores,{...data,total:0,items:[],evaluatedRules:['penalty'],missingReasons:['product_loss_inputs_incomplete','return_growth_rule_disabled']});
  assert.match(html,/Среди проверенных правил срабатываний нет/);
  assert.match(html,/входы результата до налога неполные/);
  assert.match(html,/Действующие правила: Штрафы и пени/);
  assert.doesNotMatch(html,/Источники подтверждены/);
});

test('disabled return growth has explicit status and no detail link or count inflation',()=>{
  const html=situationsListPage(user,stores,data);
  assert.match(html,/Рост возвратов: правило отключено/);
  assert.match(html,/Не включено в число найденных ситуаций/);
  assert.equal(links(html,'/situation').length,2);
  assert.ok(links(html,'/situation').every(url=>!url.searchParams.get('situationId').includes('return_growth')));
});

test('penalty detail keeps signed net and both SKU and store group sources in frozen context',()=>{
  const html=situationDetailPage(user,stores,{...data,item:penalty});
  assert.match(html,/−7,34 ₽/);assert.match(html,/−12,34 ₽/);assert.match(html,/5,00 ₽/);
  assert.match(html,/начисления и обратные операции со своими знаками/);
  assert.match(html,/не равно нулю/);
  const sources=links(html,'/sku/sources');assert.equal(sources.length,2);sources.forEach(fixed);
  assert.equal(sources[0].searchParams.get('productId'),'product-one');
  assert.equal(sources[0].searchParams.get('groupKey'),group.groupKey);
  assert.equal(sources[1].searchParams.get('scope'),'store');
  assert.equal(sources[1].searchParams.has('productId'),false);
  sources.forEach(url=>assert.equal(url.searchParams.get('situationId'),'penalty'));
  links(html,'/situations').forEach(fixed);
  links(html,'/overview').filter(url=>url.searchParams.has('periodStart')).forEach(fixed);
});

test('loss detail shows exact saved money, all before-tax categories and SKU composition link',()=>{
  const html=situationDetailPage(user,stores,{...data,item:loss});
  assert.match(html,/Точная сумма: -9007199254740993.1250 ₽/);
  assert.match(html,/−9 007 199 254 740 993,13 ₽/);
  assert.match(html,/меньше нуля/);assert.match(html,/Состав результата до налога/);
  assert.match(html,/Выручка/);assert.match(html,/Себестоимость/);
  assert.equal(links(html,'/sku/sources').length,2);
  const card=links(html,'/sku/card')[0];fixed(card);assert.equal(card.searchParams.get('productId'),'product-one');
  links(html,'/sku/sources').forEach(url=>{fixed(url);assert.equal(url.searchParams.get('situationId'),loss.id);});
});

test('group evidence is unchecked even when monetary reconciliation or supplied status matches',()=>{
  const html=situationDetailPage(user,stores,{...data,item:{...penalty,groups:penalty.groups.map(value=>({...value,evidenceStatus:'matched'}))},reconciliation:{status:'matched',checks:[]}});
  assert.match(html,/доступные суммы сходятся/);
  assert.match(html,/Источники группы ещё не проверены на странице доказательств/);
  assert.doesNotMatch(html,/Источники подтверждены/);
});

test('catalog titles, rule inputs, group keys and reasons are escaped without UUID title fallback',()=>{
  const malicious={...loss,id:'product_loss:<img>',rule:{description:'<script>alert(1)</script>',comparison:'less_than_zero',inputs:[{label:'<img>',value:'<&>'}]},groups:[{...group,groupKey:'<script>&"',missingReasons:['<img>']}]};
  const html=situationDetailPage(user,stores,{...data,item:malicious});
  assert.doesNotMatch(html,/<script>alert\(1\)<\/script>|<img>|>product-one</);
  assert.match(html,/Кружка &lt;script&gt;/);assert.match(html,/ART&amp;1/);
  assert.match(html,/Исторический \/ удалённый товар/);
  assert.match(html,/&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html,/&lt;&amp;&gt;/);
  assert.equal(links(html,'/sku/sources')[0].searchParams.get('groupKey'),'<script>&"');
  const missing=situationDetailPage(user,stores,{...data,item:{...loss,product:null,groups:[]}});
  assert.match(missing,/Название товара не сохранено/);assert.doesNotMatch(missing,/>product-one</);
});

test('legacy identity survives all detail links and expandable groups use native details',()=>{
  const legacy={...context,publication:{...context.publication,source:'legacy'}};
  const html=situationDetailPage(user,stores,{...data,context:legacy,item:penalty});
  for(const path of ['/situations','/sku/sources'])links(html,path).forEach(url=>assert.equal(url.searchParams.get('publicationSource'),'legacy'));
  assert.equal((html.match(/<details class="sku-group"><summary>/g)??[]).length,2);
  assert.match(html,/href="\/sku.css"/);
  assert.doesNotMatch(html,/onclick=/);
});
