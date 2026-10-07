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
  if (!rows.length) return accountingRow('Выручка', amount(item.metrics?.revenue), 'situation-revenue-static');
  const links = preview?.hasMore ? (item.groups ?? []).filter(group => ['revenue','revenue_return'].includes(group.categoryCode))
    .map(group => sourceLink(context, options, item, group.groupKey, group.categoryCode === 'revenue_return' ? 'Все источники возвратов' : 'Все источники выручки')).join(' · ') : '';
  return `<details class="situation-revenue"><summary><span>Выручка</span>${money(item.metrics?.revenue?.amount)}</summary><div class="situation-revenue-body"><div class="situation-sale-head" aria-hidden="true"><span>Дата продажи / возврата</span><span>Количество</span><span>Выручка</span><span></span></div><ul class="situation-sales" aria-label="Сохранённые продажи и возвраты">${rows.map(row => `<li class="situation-sale"><span class="situation-sale-date">${row.source?.accountingDate ? `<time datetime="${esc(row.source.accountingDate)}">${esc(date(row.source.accountingDate))}</time>` : 'Дата не подтверждена'}${row.categoryCode === 'revenue_return' ? '<small class="negative">Возврат</small>' : ''}</span><span class="situation-sale-quantity">${units(row.source?.quantity)}</span><span class="situation-sale-amount ${row.contributionAmount?.startsWith('-') ? 'negative' : ''}">${money(row.contributionAmount)}</span><span class="situation-sale-link">${sourceLink(context, options, item, row.groupKey, 'Подробнее', row.id)}</span></li>`).join('')}</ul>${preview?.hasMore ? '<p class="muted">Показаны первые 10 доступных строк. Остальные — на страницах источников.</p>' : ''}${preview?.quantityReason ? `<p class="muted">${esc(quantityReasons[preview.quantityReason] ?? 'Количество продаж пока не подтверждено.')}</p>` : ''}<div class="situation-sales-total"><strong>Итого по категории</strong><span>${money(item.metrics?.revenue?.amount)}</span></div><p class="situation-source-links">${links}</p></div></details>`;
}
function accountingRow(label, value, className = '') {
  return `<div class="situation-accounting-row ${className}"><span>${esc(label)}</span><span>${money(formatted(value))}</span></div>`;
}
function wbExpenseTable(item, codes, total) {
  const rewardCodes = new Set(['acquiring','wb_reward_vat','wb_reward_without_vat','wb_row_rounding_adjustment']);
  const rows = [], groups = (item.groups ?? []).filter(group => codes.includes(group.categoryCode));
  let reward = null;
  for (const group of groups) {
    let value = null;
    try { value = parseScale4Money(group.amountSigned); } catch {}
    if (rewardCodes.has(group.categoryCode)) {
      if (!reward) { reward = {label:'Вознаграждение WB',value}; rows.push(reward); }
      else reward.value = reward.value === null || value === null ? null : reward.value + value;
    } else rows.push({label:categories[group.categoryCode],value});
  }
  if (!rows.length) return '<p>Отдельных сохранённых строк расходов WB нет.</p>';
  return `<div class="situation-wb-body"><table class="situation-wb-table" aria-label="Состав расходов WB"><thead><tr><th scope="col">Статья</th><th scope="col">Сумма</th></tr></thead><tbody>${rows.map(row => `<tr><th scope="row">${esc(row.label)}</th><td>${money(formatted(row.value))}</td></tr>`).join('')}</tbody><tfoot><tr><th scope="row">Итого расходы WB</th><td>${money(formatted(total))}</td></tr></tfoot></table></div>`;
}

function productCounts(data) {
  const saved = data.operationalCounts;
  const samePeriod = saved?.storeId === data.context?.storeId && saved?.productId === data.item.productId && saved?.period?.start === data.context?.period?.start && saved?.period?.end === data.context?.period?.end;
  const count = key => samePeriod && saved?.[key]?.availability === 'complete' && typeof saved[key].count === 'string' && /^\d+$/.test(saved[key].count)
    ? units(saved[key].count) : '—';
  const orders = count('orders'), preview = data.revenuePreview;
  const sameFinancialPeriod = preview?.storeId === data.context?.storeId && preview?.productId === data.item.productId
    && preview?.period?.start === data.context?.period?.start && preview?.period?.end === data.context?.period?.end;
  const financialCount = key => sameFinancialPeriod && data.reconciliation?.status === 'matched'
    && typeof preview?.[key] === 'string' && /^\d+(?:\.\d+)?$/.test(preview[key]) ? preview[key] : null;
  const buyouts = financialCount('soldQuantity'), returns = financialCount('returnedQuantity');
  const basis = 'Выкупы и возвраты с выручкой только этого SKU из сохранённых финансовых источников, по дате реализации / возврата в отчёте. Выкупы показаны до вычета возвратов. Операции с нулевой выручкой в этот счётчик не входят.';
  return `<div class="situation-counts"><span title="Сохранённая оперативная статистика WB только этого SKU по дате исходного заказа; может обновляться независимо от финансовой публикации.">Заказы: ${orders}</span><span title="${esc(basis)}">Выкупы: ${buyouts === null ? '—' : units(buyouts)}</span>${returns !== null && /^0+(?:\.0+)?$/.test(returns) ? '' : `<span title="${esc(basis)}">Возвраты: ${returns === null ? '—' : units(returns)}</span>`}</div>${buyouts === null || returns === null ? '<small class="muted">Количество выкупов и возвратов не подтверждено.</small>' : ''}${orders === '—' ? '<small class="muted">Количество заказов за весь период пока не подтверждено.</small>' : ''}`;
}

function taxExplanation(data) {
  const metric = data.item.metrics?.tax;
  const value = metric?.availability === 'complete' && data.reconciliation?.status === 'matched' ? amount(metric) : null;
  return `<p title="Оценка налога по этому товару из сохранённой финансовой публикации, не окончательный налог всего бизнеса. Отрицательная сумма означает расчётное уменьшение налога.">Расчётный налог по товару — ${money(formatted(value))}.${value === null ? ' <span class="muted">Нет подтверждённого расчёта налога.</span>' : ''}</p>`;
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
    ? `<p>После расходов WB осталось ${money(formatted(afterWb))}.</p><p>Суммарная себестоимость — ${money(metrics.costOfGoods.amount)}.</p>${taxExplanation(data)}`
    : balanced ? '<p>Выручка не покрыла расходы и себестоимость.</p><p>Ниже показан сохранённый состав результата до налога.</p>' + taxExplanation(data)
    : '<p>Показан сохранённый результат до налога.</p><p>Проверьте доступность его состава в данных расчёта.</p>' + taxExplanation(data);
  const image = typeof product?.imageUrl === 'string' && /^https:\/\//i.test(product.imageUrl)
    ? `<img class="situation-product-image" src="${esc(product.imageUrl)}" alt="${esc(productTitle(product))}">` : '';
  const codes = Object.keys(categories).filter(code => !['revenue','revenue_return','cost_of_goods','estimated_usn_tax','daily_tax_range','packaging','software_services','external_promotion','agency_services','other_external'].includes(code));
  const extraCodes = ['packaging','software_services','external_promotion','agency_services','other_external'];
  const table = item.metrics ? `<section class="situation-composition" aria-label="Состав результата до налога"><h2>Из чего сложился убыток</h2><div class="situation-table-head"><span>Статья</span><span>Сумма</span></div>${revenueRows(data, options)}<details class="situation-wb"><summary><span>Расходы WB</span>${money(formatted(wb === null ? null : -wb))}</summary>${wbExpenseTable(item, codes, wb === null ? null : -wb)}</details>${accountingRow('Осталось после WB', afterWb, 'situation-subtotal')}${accountingRow('Себестоимость', cost === null ? null : -cost, 'situation-cost')}${external !== 0n ? `<details class="situation-external"><summary><span>Дополнительные расходы</span>${money(formatted(external === null ? null : -external))}</summary>${sourceGroups(item, extraCodes, context, options)}</details>` : ''}${accountingRow('Результат до налога', result, 'situation-result')}</section>` : '<section><h2>Из чего сложился убыток</h2><p>Состав результата до налога — в данных расчёта ниже.</p></section>';
  return `<div class="situation-detail"><a class="situation-back" href="${esc(`/situations?${query(context, options)}`)}">Все ситуации</a><div class="situation-title-row"><h1>Убыток по товару</h1><p class="situation-quality ${complete ? 'positive' : 'muted'}">${complete ? 'Данные для этого расчёта полные' : 'Полнота состава расчёта не подтверждена'}</p></div><div class="situation-product">${image}<div><h2>${esc(productTitle(product))}</h2><p class="muted">Арт. ${esc(product?.sellerArticle ?? 'не сохранён')} · WB ${esc(product?.wbArticle ?? 'не сохранён')}${product?.isHistorical ? ' · Исторический / удалённый товар' : ''}</p><p>${esc(period(context?.period))}</p>${productCounts(data)}</div></div><section class="situation-loss" aria-label="Убыток до налога"><div><p class="muted">До налога</p><strong class="situation-loss-amount negative">${money(item.metric?.value)}</strong></div><div class="situation-loss-explanation">${explanation}</div></section>${table}<footer class="situation-footer"><details class="situation-technical"><summary>Данные расчёта</summary>${technicalDetails}<p class="muted">Названия, артикулы и фотографии могут отражать текущие данные каталога.</p>${fallbackGroups}</details><a class="outline-button" href="${esc(`/sku/card?${query(context, options, {productId:item.productId})}`)}">Исходные данные</a></footer></div>`;
}
