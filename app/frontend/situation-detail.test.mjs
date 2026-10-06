import test from 'node:test';
import assert from 'node:assert/strict';
import { productLossDetail } from './situation-detail.mjs';

const metric = amount => ({amount, availability:'complete'});
const context = {storeId:'store', publication:{id:'publication',source:'daily'},period:{start:'2026-09-01',end:'2026-09-30'}};
const item = {id:'product_loss:product',productId:'product',product:{name:'Часы',sellerArticle:'ART',wbArticle:'123'},metric:{value:'-121.3800'},
  metrics:{revenue:metric('2243.0000'),wbExpenses:metric('1299.3800'),costOfGoods:metric('1065.0000'),externalExpenses:metric('0.0000'),availableResultBeforeTax:metric('-121.3800')},
  groups:[{categoryCode:'revenue',groupKey:'revenue'},{categoryCode:'cost_of_goods',groupKey:'cost'}]};
const row = {id:'evidence',groupKey:'revenue',categoryCode:'revenue',contributionAmount:'1089.0000',source:{accountingDate:'2026-09-11',quantity:'1.000000'}};
const data = {context,item,reconciliation:{status:'matched'},revenuePreview:{soldQuantity:'3',rows:[row],hasMore:false}};
const render = overrides => productLossDetail({...data,...overrides},{},'<p>Технические сведения</p>','');

test('accepted layout explains exact saved loss before tax and uses native revenue disclosure',()=>{
  const html=render();
  assert.match(html,/Данные для этого расчёта полные/);
  assert.match(html,/После расходов WB осталось .*943,62 ₽/);
  assert.match(html,/Себестоимость — .*1 065,00 ₽/);
  assert.match(html,/Не хватает .*121,38 ₽/);
  assert.match(html,/1–30 сентября 2026/);
  assert.match(html,/<details class="situation-revenue"><summary>/);
  assert.match(html,/Продано с выручкой: 3 шт\./);
  assert.match(html,/Число заказов пока не подтверждено/);
  assert.match(html,/не включает продажи с нулевой выручкой/);
  assert.match(html,/<details class="situation-technical"><summary>Данные расчёта/);
  const link=[...html.matchAll(/href="([^"]+)"/g)].map(match=>new URL(match[1].replaceAll('&amp;','&'),'https://mc.test')).find(url=>url.hash);
  assert.equal(link.hash,'#contribution-evidence');
  for(const [key,value] of Object.entries({storeId:'store',publicationId:'publication',publicationSource:'daily',periodStart:'2026-09-01',periodEnd:'2026-09-30',groupKey:'revenue',productId:'product',situationId:'product_loss:product',limit:'100'}))assert.equal(link.searchParams.get(key),value);
});

test('unverified quantities and source dates are not replaced by counts or zeros',()=>{
  const html=render({revenuePreview:{soldQuantity:null,quantityReason:'situation_revenue_page_incomplete',hasMore:true,rows:[{...row,source:null}]}});
  assert.match(html,/Продано с выручкой: —/);
  assert.match(html,/Дата не подтверждена/);
  assert.match(html,/Количество не подтверждено/);
  assert.match(html,/Общее количество по выручке пока не подтверждено/);
  assert.match(html,/Показаны первые 10 доступных строк/);
  assert.doesNotMatch(html,/Заказано: 0|Продано с выручкой: 1/);
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
