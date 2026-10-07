import test from 'node:test';
import assert from 'node:assert/strict';
import { productLossDetail } from './situation-detail.mjs';

const metric = amount => ({amount, availability:'complete'});
const context = {storeId:'store', publication:{id:'publication',source:'daily'},period:{start:'2026-09-01',end:'2026-09-30'}};
const item = {id:'product_loss:product',productId:'product',product:{name:'Часы',sellerArticle:'ART',wbArticle:'123'},metric:{value:'-121.3800'},
  metrics:{revenue:metric('2243.0000'),wbExpenses:metric('1299.3800'),costOfGoods:metric('1065.0000'),externalExpenses:metric('0.0000'),tax:metric('134.5800'),availableResultBeforeTax:metric('-121.3800')},
  groups:[{categoryCode:'revenue',groupKey:'revenue'},{categoryCode:'cost_of_goods',groupKey:'cost'}]};
const row = {id:'evidence',groupKey:'revenue',categoryCode:'revenue',contributionAmount:'1089.0000',source:{accountingDate:'2026-09-11',quantity:'1.000000'}};
const counts = {storeId:'store',productId:'product',period:context.period,orders:{count:'7',availability:'complete'},buyouts:{count:'4',availability:'complete'}};
const revenuePreview = {storeId:'store',productId:'product',period:context.period,soldQuantity:'3',returnedQuantity:'0',rows:[row],hasMore:false};
const data = {context,item,reconciliation:{status:'matched'},operationalCounts:counts,revenuePreview};
const render = overrides => productLossDetail({...data,...overrides},{},'<p>Технические сведения</p>','');
const expense = (categoryCode, amountSigned) => ({categoryCode,amountSigned,groupKey:categoryCode});
const wbTable = html => html.match(/<table class="situation-wb-table"[\s\S]*?<\/table>/)?.[0] ?? '';

test('accepted layout explains exact saved loss before tax and uses native revenue disclosure',()=>{
  const html=render();
  assert.match(html,/Данные для этого расчёта полные/);
  assert.match(html,/После расходов WB осталось .*943,62 ₽/);
  assert.match(html,/Суммарная себестоимость — .*1 065,00 ₽/);
  assert.match(html,/Расчётный налог по товару — .*134,58 ₽/);
  assert.doesNotMatch(html,/Не хватает/);
  assert.match(html,/1–30 сентября 2026/);
  assert.match(html,/<details class="situation-revenue"><summary>/);
  assert.match(html,/Заказов по дате заказа: 7 шт\./);
  assert.match(html,/Выкупы: 3 шт\./);
  assert.doesNotMatch(html,/Возвраты:|Выкупы: 4/);
  assert.match(html,/по дате исходного заказа/);
  assert.match(html,/независимо от финансовой публикации/);
  assert.match(html,/По выручке: 3 шт\./);
  assert.doesNotMatch(html,/Продано с выручкой|Число заказов пока не подтверждено/);
  assert.match(html,/<details class="situation-technical"><summary>Данные расчёта/);
  const link=[...html.matchAll(/href="([^"]+)"/g)].map(match=>new URL(match[1].replaceAll('&amp;','&'),'https://mc.test')).find(url=>url.hash);
  assert.equal(link.hash,'#contribution-evidence');
  for(const [key,value] of Object.entries({storeId:'store',publicationId:'publication',publicationSource:'daily',periodStart:'2026-09-01',periodEnd:'2026-09-30',groupKey:'revenue',productId:'product',situationId:'product_loss:product',limit:'100'}))assert.equal(link.searchParams.get(key),value);
});

test('unverified quantities and source dates are not replaced by counts or zeros',()=>{
  const html=render({operationalCounts:null,revenuePreview:{soldQuantity:null,quantityReason:'situation_revenue_page_incomplete',hasMore:true,rows:[{...row,source:null}]}});
  assert.match(html,/Заказов по дате заказа: —/);
  assert.match(html,/Выкупы: —/);
  assert.match(html,/Возвраты: —/);
  assert.match(html,/Дата не подтверждена/);
  assert.match(html,/Количество не подтверждено/);
  assert.match(html,/Общее количество по выручке пока не подтверждено/);
  assert.match(html,/Показаны первые 10 доступных строк/);
  assert.doesNotMatch(html,/Заказов по дате заказа: 0|Выкупы: 0/);
});

test('additional expenses remain part of composition and suppress the simplified cause',()=>{
  const html=render({item:{...item,metric:{value:'-221.3800'},metrics:{...item.metrics,externalExpenses:metric('100.0000')}}});
  assert.match(html,/Дополнительные расходы/);
  assert.match(html,/−100,00 ₽/);
  assert.match(html,/Выручка не покрыла расходы и себестоимость/);
  assert.doesNotMatch(html,/Не хватает/);
});

test('unavailable or unreconciled composition never gets a complete badge or invented explanation',()=>{
  for(const changed of [{item:{...item,metrics:{...item.metrics,wbExpenses:{availability:'unavailable',amount:null}}}},
    {item:{...item,metric:{value:'-1.0000'}}},{reconciliation:{status:'mismatch'}}]){
    const html=render(changed);
    assert.doesNotMatch(html,/Данные для этого расчёта полные/);
    assert.match(html,/Полнота состава расчёта не подтверждена/);
  }
  assert.match(render({item:{...item,metrics:{...item.metrics,wbExpenses:{availability:'unavailable',amount:null}}}}),/Проверьте доступность его состава/);
});

test('returns keep signs and unsafe catalogue, dates and source identifiers are escaped',()=>{
  const html=render({item:{...item,product:{name:'<script>test</script>',imageUrl:'javascript:alert(1)'}},revenuePreview:{rows:[{...row,id:'"<img>',categoryCode:'revenue_return',contributionAmount:'-10.0000',source:{accountingDate:'<img>',quantity:'1.000000'}}]}});
  assert.match(html,/Возврат/);assert.match(html,/−10,00 ₽/);
  assert.match(html,/&lt;script&gt;test&lt;\/script&gt;/);
  assert.match(html,/Дата не подтверждена/);
  assert.doesNotMatch(html,/<script>|<img>|javascript:/);
  assert.match(html,/#contribution-%22%3Cimg%3E/);
});

test('WB expenses combine four reward components in a flat table without changing the saved total',()=>{
  const groups=[expense('acquiring','-36.2800'),expense('logistics','-268.4000'),expense('pickup_reward','-26.7500'),
    expense('wb_reward_vat','-62.3000'),expense('wb_reward_without_vat','-283.1800'),expense('wb_row_rounding_adjustment','0.0000')];
  const before=structuredClone(groups);
  const html=render({item:{...item,groups,metrics:{...item.metrics,wbExpenses:metric('676.9100')}}});
  const table=wbTable(html);
  assert.match(table,/>Вознаграждение WB<\/th><td>.*−381,76 ₽/);
  assert.match(table,/>Логистика<\/th><td>.*−268,40 ₽/);
  assert.match(table,/>Вознаграждение ПВЗ<\/th><td>.*−26,75 ₽/);
  assert.match(table,/Итого расходы WB<\/th><td>.*−676,91 ₽/);
  assert.equal((table.match(/<tr>/g)??[]).length,5);
  assert.doesNotMatch(table,/<details|Эквайринг|без НДС|НДС вознаграждения|Коррекция|Источники|href=/);
  assert.match(html,/<details class="situation-wb"><summary>/);
  assert.deepEqual(groups,before);
});

test('WB reward preserves signed corrections and rounds only the combined exact amount',()=>{
  const table=wbTable(render({item:{...item,groups:[expense('acquiring','-0.0049'),expense('wb_reward_vat','-0.0049'),
    expense('wb_reward_without_vat','-9007199254740993.0000'),expense('wb_row_rounding_adjustment','9007199254740993.0200')]}}));
  assert.match(table,/>Вознаграждение WB<\/th><td>.*0,01 ₽/);
  assert.doesNotMatch(table,/−0,01 ₽|0,02 ₽/);
});

test('missing or invalid WB reward components stay unavailable, not a known subtotal or zero',()=>{
  for(const amount of [null,'invalid']){
    const table=wbTable(render({item:{...item,groups:[expense('acquiring','-10.0000'),expense('wb_reward_vat',amount)]}}));
    assert.match(table,/>Вознаграждение WB<\/th><td><span class="sku-unavailable">Недоступно/);
    assert.doesNotMatch(table,/10,00 ₽|0,00 ₽/);
    assert.match(table,/Итого расходы WB<\/th><td>.*−1 299,38 ₽/);
  }
  const table=wbTable(render({item:{...item,groups:[expense('logistics','-10.0000')]}}));
  assert.match(table,/Логистика/);
  assert.doesNotMatch(table,/Вознаграждение WB/);
});

test('cost of goods is a plain amount row while technical evidence remains separate',()=>{
  const html=productLossDetail(data,{},'<a href="/sku/evidence?groupKey=cost">Сохранённая себестоимость</a>','');
  assert.match(html,/<div class="situation-accounting-row situation-cost"><span>Себестоимость<\/span><span>.*−1 065,00 ₽/);
  assert.doesNotMatch(html,/<details class="situation-cost"/);
  assert.match(html,/<details class="situation-technical">[\s\S]*href="\/sku\/evidence\?groupKey=cost"/);
});

test('only orders use operational counts, require exact coverage and accept confirmed zero',()=>{
  const zero=render({operationalCounts:{...counts,orders:{count:'0',availability:'complete'},buyouts:{count:'0',availability:'complete'}}});
  assert.match(zero,/Заказов по дате заказа: 0 шт\./);assert.match(zero,/Выкупы: 3 шт\./);
  assert.doesNotMatch(zero,/Количество за весь период пока не подтверждено/);
  for(const changed of [null,{...counts,storeId:'foreign'},{...counts,productId:'foreign'},{...counts,period:{start:'2026-08-01',end:'2026-08-31'}},
    {...counts,orders:{count:'7',availability:'partial'},buyouts:{count:'4',availability:'unavailable'}},
    {...counts,orders:{count:'<img>',availability:'complete'},buyouts:{count:'-1',availability:'complete'}}]){
    const html=render({operationalCounts:changed});
    assert.match(html,/Заказов по дате заказа: —/);assert.match(html,/Выкупы: 3 шт\./);
    assert.match(html,/Количество заказов за весь период пока не подтверждено/);
    assert.doesNotMatch(html,/Заказов по дате заказа: 7|<img>/);
  }
});

test('tax comes from the saved SKU metric, never the loss, and unsafe amounts are not payable tax',()=>{
  for(const tax of [{amount:null,availability:'unavailable'},metric('invalid'),{amount:'10.0000',availability:'partial'}]){
    const html=render({item:{...item,metrics:{...item.metrics,tax}}});
    assert.match(html,/Расчётный налог по товару — <span class="sku-unavailable">Недоступно/);
    assert.match(html,/Нет подтверждённого расчёта налога/);
    assert.doesNotMatch(html,/Расчётный налог по товару — <span class="sku-money"[^>]*>−?121,38 ₽/);
  }
  const zero=render({item:{...item,metrics:{...item.metrics,tax:metric('0.0000')}}});
  assert.match(zero,/Расчётный налог по товару — .*0,00 ₽/);
  const signed=render({item:{...item,metrics:{...item.metrics,tax:metric('-10.0000')}}});
  assert.match(signed,/Расчётный налог по товару — .*−10,00 ₽/);
  assert.doesNotMatch(signed,/Требуется заплатить налог/);
  assert.match(signed,/не окончательный налог всего бизнеса/);
  assert.match(render({reconciliation:{status:'mismatch'}}),/Нет подтверждённого расчёта налога/);
});

test('financial counts are pinned to SKU and period; zero returns are hidden but unknown returns are not',()=>{
  const returned=render({revenuePreview:{...revenuePreview,soldQuantity:'7',returnedQuantity:'1'}});
  assert.match(returned,/Выкупы: 7 шт\./);assert.match(returned,/Возвраты: 1 шт\./);
  assert.match(returned,/Выкупы показаны до вычета возвратов/);
  for(const returnedQuantity of ['0','0.000'])assert.doesNotMatch(render({revenuePreview:{...revenuePreview,returnedQuantity}}),/Возвраты:/);
  for(const changed of [{productId:'foreign'},{storeId:'foreign'},{period:{start:'2026-08-01',end:'2026-08-31'}},
    {soldQuantity:null,returnedQuantity:null},{soldQuantity:'<img>',returnedQuantity:'-1'}]) {
    const html=render({revenuePreview:{...revenuePreview,...changed}});
    assert.match(html,/Выкупы: —/);assert.match(html,/Возвраты: —/);
    assert.doesNotMatch(html,/Выкупы: 4|Возвраты: 0|<img>/);
  }
  assert.match(render({reconciliation:{status:'mismatch'}}),/Выкупы: —/);
});

test('tax explanation links to the exact SKU frozen base and rate without changing amount',()=>{
  const html=render({item:{...item,taxGroup:{categoryCode:'estimated_usn_tax',groupKey:'tax-key'}}});
  const link=[...html.matchAll(/href="([^"]+)">База и ставка/g)].map(match=>new URL(match[1].replaceAll('&amp;','&'),'https://mc.test'))[0];
  assert.equal(link.searchParams.get('productId'),'product');assert.equal(link.searchParams.get('groupKey'),'tax-key');
  assert.equal(link.searchParams.get('publicationId'),'publication');assert.equal(link.searchParams.get('periodStart'),'2026-09-01');
  assert.match(html,/Расчётный налог по товару — .*134,58 ₽/);
});
