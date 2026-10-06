import { esc } from './pages.mjs';
import { publishedPageView } from './sku.page.mjs';
import { parseScale4Money, formatScale4Money } from '../modules/overview/financial-overview.mjs';

const { money, query, productTitle, categories, reasonList } = publishedPageView;
const months = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
const quantityReasons = {
  situation_revenue_groups_missing:'Нет подтверждённых строк продаж с выручкой.',
  situation_revenue_page_incomplete:'Загружена часть источников. Общее количество по выручке пока не подтверждено.',
  drilldown_reconciliation_mismatch:'Суммы источников не сходятся с сохранённым результатом.',
  drilldown_frozen_source_missing:'Не все сохранённые источники подтверждены.',
  situation_sale_quantity_unverified:'Количество или тип операции не подтверждены.',
  situation_sale_operation_inconsistent:'В источниках одной продажи найдены разные сведения.'
};
function date(value) {
  const match = typeof value === 'string' && value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match && months[Number(match[2])-1] ? `${Number(match[3])} ${months[Number(match[2])-1]} ${match[1]}` : 'Дата не подтверждена';
}
function period(value) {
  const start = value?.start?.match(/^(\d{4})-(\d{2})-(\d{2})$/), end = value?.end?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return start && end && start[1] === end[1] && start[2] === end[2] && months[Number(start[2])-1]
    ? `${Number(start[3])}–${Number(end[3])} ${months[Number(start[2])-1]} ${start[1]}`
    : `${date(value?.start)} — ${date(value?.end)}`;
}
function amount(metric) {
  if (!metric || metric.availability === 'unavailable') return null;
  try { return parseScale4Money(metric.amount); } catch { return null; }
}
const formatted = value => value === null ? null : formatScale4Money(value);
const units = value => typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value)
  ? `${esc(value.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '').replace('.', ','))} шт.` : 'Количество не подтверждено';
function sourceLink(context, options, item, groupKey, label, id) {
  const params = query(context, options, {situationId:item.id, productId:item.productId, groupKey, limit:100, cursor:null});
  return `<a href="${esc(`/sku/sources?${params}${id ? `#contribution-${encodeURIComponent(id)}` : ''}`)}">${esc(label)}</a>`;
}
function sourceGroups(item, codes, context, options) {
  return (item.groups ?? []).filter(group => codes.includes(group.categoryCode)).map(group =>
    `<details class="situation-category"><summary><span>${esc(categories[group.categoryCode] ?? 'Сохранённая категория')}</span>${money(group.amountSigned)}</summary><div class="situation-category-body">${reasonList(group.missingReasons)}<p class="muted">Источники группы ещё не проверены на странице доказательств.</p>${sourceLink(context, options, item, group.groupKey, 'Сохранённые вклады и источники')}</div></details>`).join('');
}
function revenueRows(data, options) {
  const preview = data.revenuePreview, item = data.item, context = data.context;
  const rows = preview?.rows ?? [];
  const links = !rows.length || preview?.hasMore ? (item.groups ?? []).filter(group => ['revenue','revenue_return'].includes(group.categoryCode))
    .map(group => sourceLink(context, options, item, group.groupKey, group.categoryCode === 'revenue_return' ? 'Все источники возвратов' : 'Все источники выручки')).join(' · ') : '';
  return `<div class="situation-revenue-body">${rows.length ? `<div class="situation-sale-head" aria-hidden="true"><span>Дата продажи / возврата</span><span>Количество</span><span>Выручка</span><span></span></div><ul class="situation-sales" aria-label="Сохранённые продажи и возвраты">${rows.map(row => `<li class="situation-sale"><span class="situation-sale-date">${row.source?.accountingDate ? `<time datetime="${esc(row.source.accountingDate)}">${esc(date(row.source.accountingDate))}</time>` : 'Дата не подтверждена'}${row.categoryCode === 'revenue_return' ? '<small class="negative">Возврат</small>' : ''}</span><span class="situation-sale-quantity">${units(row.source?.quantity)}</span><span class="situation-sale-amount ${row.contributionAmount?.startsWith('-') ? 'negative' : ''}">${money(row.contributionAmount)}</span><span class="situation-sale-link">${sourceLink(context, options, item, row.groupKey, 'Подробнее', row.id)}</span></li>`).join('')}</ul>` : '<p>Подтверждённая детализация выручки пока недоступна. Отсутствие строк не означает нулевую выручку.</p>'}${preview?.hasMore ? '<p class="muted">Показаны первые 10 доступных строк. Остальные — на страницах источников.</p>' : ''}${preview?.quantityReason ? `<p class="muted">${esc(quantityReasons[preview.quantityReason] ?? 'Количество продаж пока не подтверждено.')}</p>` : ''}<div class="situation-sales-total"><strong>Итого по категории</strong><span>${money(item.metrics?.revenue?.amount)}</span></div><p class="situation-source-links">${links}</p></div>`;
}
function accountingRow(label, value, className = '') {
  return `<div class="situation-accounting-row ${className}"><span>${esc(label)}</span><span>${money(formatted(value))}</span></div>`;
}

export function productLossDetail(data, options, technicalDetails, fallbackGroups) {
  const {item, context} = data, product = item.product;
  const metrics = item.metrics ?? {}, revenue = amount(metrics.revenue), wb = amount(metrics.wbExpenses), cost = amount(metrics.costOfGoods), external = amount(metrics.externalExpenses);
  const afterWb = revenue === null || wb === null ? null : revenue - wb;
  let result = null;
  try { result = parseScale4Money(item.metric?.value); } catch {}
  const balanced = afterWb !== null && cost !== null && external !== null && result !== null && afterWb - cost - external === result;
  const complete = balanced && metrics.availableResultBeforeTax?.availability === 'complete' && data.reconciliation?.status === 'matched';
  const simple = balanced && external === 0n && afterWb >= 0n && cost > afterWb;
  const explanation = simple
    ? `<p>После расходов WB осталось ${money(formatted(afterWb))}.</p><p>Себестоимость — ${money(metrics.costOfGoods.amount)}.</p><p>Не хватает ${money(formatted(-result))}.</p>`
    : balanced ? '<p>Выручка не покрыла расходы и себестоимость.</p><p>Ниже показан сохранённый состав результата до налога.</p>'
    : '<p>Показан сохранённый результат до налога.</p><p>Проверьте доступность его состава в данных расчёта.</p>';
  const image = typeof product?.imageUrl === 'string' && /^https:\/\//i.test(product.imageUrl)
    ? `<img class="situation-product-image" src="${esc(product.imageUrl)}" alt="${esc(productTitle(product))}">` : '';
  const codes = Object.keys(categories).filter(code => !['revenue','revenue_return','cost_of_goods','estimated_usn_tax','daily_tax_range','packaging','software_services','external_promotion','agency_services','other_external'].includes(code));
  const extraCodes = ['packaging','software_services','external_promotion','agency_services','other_external'];
  const quantity = data.revenuePreview?.soldQuantity;
  const costSources = (item.groups ?? []).filter(group => group.categoryCode === 'cost_of_goods').map(group => sourceLink(context, options, item, group.groupKey, 'Сохранённые вклады и источники')).join(' · ');
  const table = item.metrics ? `<section class="situation-composition" aria-label="Состав результата до налога"><h2>Из чего сложился убыток</h2><div class="situation-table-head"><span>Статья</span><span>Сумма</span></div><details class="situation-revenue"><summary><span>Выручка${quantity != null ? `<small>По выручке: ${units(quantity)}</small>` : ''}</span>${money(metrics.revenue?.amount)}</summary>${revenueRows(data, options)}</details><details class="situation-wb"><summary><span>Расходы WB</span>${money(formatted(wb === null ? null : -wb))}</summary>${sourceGroups(item, codes, context, options) || '<p>Отдельных сохранённых строк расходов WB нет.</p>'}</details>${accountingRow('Осталось после WB', afterWb, 'situation-subtotal')}<details class="situation-cost"><summary><span>Себестоимость</span>${money(formatted(cost === null ? null : -cost))}</summary><div class="situation-category-body">${costSources || '<p>Источники себестоимости недоступны.</p>'}</div></details>${external !== 0n ? `<details class="situation-external"><summary><span>Дополнительные расходы</span>${money(formatted(external === null ? null : -external))}</summary>${sourceGroups(item, extraCodes, context, options)}</details>` : ''}${accountingRow('Результат до налога', result, 'situation-result')}</section>` : '<section><h2>Из чего сложился убыток</h2><p>Состав результата до налога — в данных расчёта ниже.</p></section>';
  return `<div class="situation-detail"><a class="situation-back" href="${esc(`/situations?${query(context, options)}`)}">Все ситуации</a><div class="situation-title-row"><h1>Убыток по товару</h1><p class="situation-quality ${complete ? 'positive' : 'muted'}">${complete ? 'Данные для этого расчёта полные' : 'Полнота состава расчёта не подтверждена'}</p></div><div class="situation-product">${image}<div><h2>${esc(productTitle(product))}</h2><p class="muted">Арт. ${esc(product?.sellerArticle ?? 'не сохранён')} · WB ${esc(product?.wbArticle ?? 'не сохранён')}${product?.isHistorical ? ' · Исторический / удалённый товар' : ''}</p><p>${esc(period(context?.period))}</p><div class="situation-counts"><span>Заказано: <span title="Число оперативных заказов не подтверждено этой финансовой публикацией">—</span></span><span title="По подтверждённым строкам выручки; не включает продажи с нулевой выручкой">Продано с выручкой: ${quantity != null ? units(quantity) : '—'}</span></div><small class="muted">Число заказов пока не подтверждено.</small></div></div><section class="situation-loss" aria-label="Убыток до налога"><div><p class="muted">До налога</p><strong class="situation-loss-amount negative">${money(item.metric?.value)}</strong></div><div class="situation-loss-explanation">${explanation}</div></section>${table}<footer class="situation-footer"><details class="situation-technical"><summary>Данные расчёта</summary>${technicalDetails}<p class="muted">Названия, артикулы и фотографии могут отражать текущие данные каталога.</p>${fallbackGroups}</details><a class="outline-button" href="${esc(`/sku/card?${query(context, options, {productId:item.productId})}`)}">Исходные данные</a></footer></div>`;
}
