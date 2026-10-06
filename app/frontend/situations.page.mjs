import { frame, esc } from './pages.mjs';
import { publishedPageView } from './sku.page.mjs';
import { productLossDetail } from './situation-detail.mjs';

const { money, metadata, reasonList, badge, reconciliation, productTitle, productMeta, contextParams, query, categories }=publishedPageView;
const ruleNames={product_loss:'Отрицательный результат SKU до налога',penalty:'Штрафы и пени',return_growth:'Рост возвратов'};
const situationReasons={financial_situation_inputs_unavailable:'Нет доступных сохранённых входов для проверки ситуаций',product_loss_inputs_incomplete:'Правило убытка SKU не проверено: входы результата до налога неполные',return_growth_rule_disabled:'Правило роста возвратов отключено и не включено в число ситуаций'};

function anchor(path,label,context,options,extra={}){
  return `<a href="${esc(`${path}?${query(context,options,extra)}`)}">${esc(label)}</a>`;
}
function reasons(values=[]){
  const known=values.filter(value=>situationReasons[typeof value==='string'?value:value.code]);
  const other=values.filter(value=>!situationReasons[typeof value==='string'?value:value.code]);
  return `${known.length?`<div class="sku-reasons"><strong>Причины</strong><ul>${known.map(value=>`<li>${esc(situationReasons[typeof value==='string'?value:value.code])}</li>`).join('')}</ul></div>`:''}${reasonList(other)}`;
}
function state(data){
  const status=data?.status??'unavailable';
  return `${badge(status==='available'?'complete':status)}${status==='partial'?'<p>Показаны только доказанные срабатывания проверенных правил. Число найденных ситуаций не означает, что все правила удалось проверить.</p>':''}${reasons(data?.missingReasons)}`;
}
function disabled(data){
  const rules=data?.disabledRules??['return_growth'];
  return rules.length?`<section class="sku-store"><h2>Отключённые правила</h2>${rules.map(rule=>`<p>${esc(ruleNames[rule]??'Правило пока недоступно')}: ${rule==='return_growth'?'правило отключено; условия и исходные данные пока не подтверждены.':'проверка отключена.'} Не включено в число найденных ситуаций.</p>`).join('')}</section>`:'';
}
function render(user,stores,data,options,route,body){
  const context=data?.context;
  return frame({...user,stores},route,`<link rel="stylesheet" href="/sku.css"><section class="sku-page">${body}</section>`,stores,{...contextParams(context),storeId:context?.storeId??options.selectedStoreId,periodStart:context?.period?.start??options.period?.start,periodEnd:context?.period?.end??options.period?.end});
}
function itemTitle(item){return ruleNames[item.kind]??'Финансовая ситуация';}
function metric(item){return `<p>${esc(item.kind==='product_loss'?'Сохранённый результат SKU до налога':'Сохранённое знаковое сальдо штрафов и пени')}: ${money(item.metric?.value)}</p>`;}
function groups(item,context,options){
  return (item.groups??[]).map(group=>`<details class="sku-group"><summary>${esc(categories[group.categoryCode]??'Сохранённая категория')} · ${money(group.amountSigned)} · ${esc(group.scope==='store'?'Общие строки магазина':productTitle(group.product))}</summary>${group.scope==='store'?'<p>Общие строки магазина; не распределены между SKU.</p>':productMeta(group.product??{})}<p>Знаковый вклад · исходных строк: ${esc(group.lineCount??'неизвестно')}. Источники группы ещё не проверены на странице доказательств.</p>${reasonList(group.missingReasons)}${anchor('/sku/sources','Сохранённые вклады и источники',context,options,{situationId:item.id,groupKey:group.groupKey,...(group.scope==='store'?{scope:'store'}:{productId:group.productId})})}</details>`).join('')||'<p>Сохранённые группы недоступны. Это не подтверждает нулевую сумму.</p>';
}
function rule(item){
  const inputs=item.rule?.inputs??[];
  const comparison={less_than_zero:'Сохранённый результат до налога меньше нуля.',not_equal_zero:'Сохранённое знаковое сальдо штрафов и пени не равно нулю.'}[item.rule?.comparison];
  return `<section><h2>Почему ситуация найдена</h2><p>${esc(item.rule?.description??'Описание сохранённого правила недоступно.')}</p>${comparison?`<p>${esc(comparison)}</p>`:''}<dl class="sku-source-fields">${inputs.map(input=>`<div><dt>${esc(input.label)}</dt><dd>${input.unit==='RUB'?money(input.value):esc(input.value??'недоступно')}</dd></div>`).join('')}</dl>${!inputs.length?'<p>Сохранённые входы правила недоступны.</p>':''}</section>`;
}

export function situationsListPage(user,stores=[],data=null,options={}){
  options={...options,publicationPath:'/situations'};
  const context=data?.context,items=data?.items??[];
  const rows=items.map(item=>`<article class="sku-item"><h2>${anchor('/situation',itemTitle(item),context,options,{situationId:item.id,...(item.productId?{productId:item.productId}:{})})}</h2>${item.kind==='product_loss'?`<h3>${esc(productTitle(item.product))}</h3>${productMeta(item.product??{})}`:''}${metric(item)}</article>`).join('');
  const evaluated=data?.evaluatedRules??[];
  return render(user,stores,data,options,'/situations',`<h1>Все ситуации</h1>${anchor('/overview','Вернуться к обзору',context,options)}${metadata(context,options)}${state(data)}<p>Найдено ситуаций: ${esc(data?.total??'неизвестно')}.</p>${evaluated.length?`<p>Действующие правила: ${evaluated.map(value=>esc(ruleNames[value]??'Финансовое правило')).join(', ')}.</p>`:''}${rows||(data?.total===0&&data?.status!=='unavailable'?'<p>Среди проверенных правил срабатываний нет.</p>':'<p>Список ситуаций недоступен. Отсутствие строк не подтверждает, что ситуаций нет.</p>')}${disabled(data)}${data?.reconciliation?reconciliation(data.reconciliation):''}`);
}

export function situationDetailPage(user,stores=[],data=null,options={}){
  options={...options,publicationPath:'/situations'};
  const context=data?.context,item=data?.item;
  if(item?.kind==='product_loss')return render(user,stores,data,options,'/situation',productLossDetail(data,options,`${metadata(context,options)}${state(data)}${rule(item)}${data.reconciliation?reconciliation(data.reconciliation):''}`,groups(item,context,options)));
  return render(user,stores,data,options,'/situation',`${anchor('/situations','Вернуться ко всем ситуациям',context,options)} · ${anchor('/overview','Вернуться к обзору',context,options)}<h1>${esc(item?itemTitle(item):'Подробности ситуации')}</h1>${metadata(context,options)}${state(data)}${item?`${item.kind==='product_loss'?`<h2>${esc(productTitle(item.product))}</h2>${productMeta(item.product??{})}`:''}${metric(item)}${rule(item)}${item.productId?anchor('/sku/card','Состав результата SKU',context,options,{productId:item.productId}):''}<h2>${item.kind==='penalty'?'Состав знакового сальдо штрафов и пени':'Состав результата до налога'}</h2>${item.kind==='penalty'?'<p>Сальдо включает начисления и обратные операции со своими знаками, включая SKU и общие строки магазина.</p>':'<p>Показаны сохранённые вклады результата SKU до налога.</p>'}${groups(item,context,options)}${data?.reconciliation?reconciliation(data.reconciliation):''}`:'<p>Подробности ситуации недоступны. Неизвестный результат не заменён нулём.</p>'}`);
}
