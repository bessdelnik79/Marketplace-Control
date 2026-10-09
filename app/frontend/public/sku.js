// Decimal comparisons retain the precision of the published financial amounts.
export function decimal(value) {
  if (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  return { units: BigInt(whole.replace('-', '') + fraction) * (value.startsWith('-') ? -1n : 1n), scale: fraction.length };
}
export function compareAmounts(a, b) {
  const left = decimal(a), right = decimal(b);
  if (!left || !right) return left ? -1 : right ? 1 : 0;
  const scale = Math.max(left.scale, right.scale);
  const difference = left.units * 10n ** BigInt(scale - left.scale) - right.units * 10n ** BigInt(scale - right.scale);
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}
export function isZeroAmount(value) { return decimal(value)?.units === 0n; }
export function marginPercent(result, revenue) {
  const amount = decimal(result), base = decimal(revenue);
  if (!amount || !base || base.units <= 0n) return null;
  const numerator = amount.units * 10n ** BigInt(base.scale) * 1000n;
  const denominator = base.units * 10n ** BigInt(amount.scale);
  const magnitude = numerator < 0n ? -numerator : numerator;
  const rounded = (magnitude + denominator / 2n) / denominator;
  return `${numerator < 0n && rounded ? '−' : ''}${rounded / 10n},${rounded % 10n}%`;
}
export function productStatus(item) {
  const result = item.metrics?.availableResultAfterTax, revenue = item.metrics?.revenue;
  if (item.quality !== 'complete' || result?.availability !== 'complete' || revenue?.availability !== 'complete' || !decimal(result.amount) || !decimal(revenue.amount)) return 'incomplete';
  if (compareAmounts(result.amount, '0') < 0) return 'loss';
  const amount = decimal(result.amount), base = decimal(revenue.amount);
  if (amount.units === 0n) return 'zero';
  if (base.units > 0n && amount.units * 10n ** BigInt(base.scale) * 100n <= base.units * 10n ** BigInt(amount.scale) * 5n) return 'near';
  return 'profit';
}
export function matchesFilter(row, { search = '', filter = 'all', hideZero = false } = {}) {
  return (filter === 'all' || row.status === filter) && (!hideZero || !isZeroAmount(row.result)) && row.search.includes(search.toLocaleLowerCase('ru').trim());
}
export function csvCell(value) {
  const text = String(value ?? '');
  const protect = /^[\s]*[=+\-@\t\r]/.test(text) && !/^-?\d+(?:\.\d+)?$/.test(text);
  return `"${(protect ? "'" : '') + text.replaceAll('"', '""')}"`;
}
export function compareRows(a, b, sort = 'attention') {
  if (sort === 'attention') {
    const ranks = { loss: 0, near: 1, incomplete: 2, profit: 3, zero: 4 };
    return ranks[a.status] - ranks[b.status] || compareAmounts(a.result, b.result);
  }
  const key = sort.replace(/_(asc|desc)$/, '');
  if (key === 'title') return String(a.name ?? '').localeCompare(String(b.name ?? ''), 'ru') * (sort.endsWith('desc') ? -1 : 1);
  const left = decimal(a[key]), right = decimal(b[key]);
  if (!left || !right) return left ? -1 : right ? 1 : 0;
  return compareAmounts(a[key], b[key]) * (sort.endsWith('desc') ? -1 : 1);
}
export const statusLabels = { loss: 'С убытком', near: 'На грани', profit: 'Прибыльный', incomplete: 'Неполные данные', zero: 'Нулевой результат' };
export const promotionReason = 'Нет подтверждённых данных о продвижении конкретной SKU';
export const buyoutReason = 'Полной истории завершённых заказов этой SKU пока нет';
export const buyoutReasons = {
  history_missing: 'Нет индивидуальной истории заказов и подтверждённых исходов.',
  history_incomplete: 'В доступной истории есть пробелы или она не достигает даты отбора заказов.',
  invalid_request: 'Не указан товар или корректная дата периода.',
  invalid_record: 'В истории есть записи без корректных идентификаторов или дат.',
  identity_conflict: 'Один идентификатор заказа связан с разными товарами или датами.',
  outcome_conflict: 'Для одного заказа указаны несовместимые подтверждённые исходы.',
  no_confirmed_orders: 'В пределах года нет подтверждённых завершённых заказов этого товара.'
};
export function buyoutFields(buyout) {
  const counts = buyout?.counts;
  const available = buyout?.status === 'available' && Number.isFinite(buyout.percent) && buyout.percent >= 0 && buyout.percent <= 100 && Number.isInteger(buyout.sampleSize) && buyout.sampleSize > 0 && buyout.sampleSize <= 100 && ['retained', 'returned', 'refused'].every(key => Number.isInteger(counts?.[key]) && counts[key] >= 0) && counts.retained + counts.returned + counts.refused === buyout.sampleSize;
  return {
    buyout: available ? String(buyout.percent) : '',
    buyoutreason: available ? buyoutWarning(buyout) : buyout?.status === 'available' ? buyoutReasons.invalid_record : buyoutReasons[buyout?.reason] ?? buyoutReason,
    samplesize: available ? String(buyout.sampleSize) : '',
    retained: available ? String(counts.retained) : '',
    returned: available ? String(counts.returned) : '',
    refused: available ? String(counts.refused) : ''
  };
}
function buyoutWarning(buyout) {
  const limitations = Array.isArray(buyout?.sourceLimitations) ? buyout.sourceLimitations.filter(value => typeof value === 'string' && value.trim()) : [];
  return [buyout?.historyLimited ? 'Ограниченная история: показатель рассчитан по доступным подтверждённым заказам.' : '', ...limitations].filter(Boolean).join(' ');
}
export function buyoutPercent(value) {
  const amount = typeof value === 'string' && value !== '' ? Number(value) : NaN;
  return Number.isFinite(amount) && amount >= 0 && amount <= 100 ? `${amount.toLocaleString('ru-RU', { maximumFractionDigits: 1, minimumFractionDigits: 1 })}%` : '—';
}
function buyoutExplanation(buyout, fields) {
  const bounds = buyout?.bounds;
  return `<p>Последние 100 завершённых заказов конкретной SKU: выкупы, возвраты и отказы. Если их меньше — все подтверждённые заказы доступной истории в пределах года. Выкуп — доля товаров, оставленных покупателями. Заказы последних 14 дней исключены; продажа с последующим возвратом считается одним заказом. Будущие события не изменяют исторический показатель.</p>${bounds ? `<p>Глубина поиска: ${dateLabel(bounds.start)} — ${dateLabel(bounds.cutoff)}. Исходы известны на ${dateLabel(buyout.historyEnd ?? bounds.end)}. Даты определяются по московскому времени.</p>` : ''}${buyout?.historyStart && buyout?.historyEnd ? `<p>Доступная история: ${dateLabel(buyout.historyStart)} — ${dateLabel(buyout.historyEnd)}.${buyout.observedAt ? ` Проверено: ${escapeHtml(buyout.observedAt)}.` : ''}</p>` : ''}${fields.buyout === '' ? `<p>${escapeHtml(fields.buyoutreason)}</p>` : `<p>${escapeHtml(fields.retained)} из ${escapeHtml(fields.samplesize)} заказов оставлены покупателями. Возвраты после выкупа: ${escapeHtml(fields.returned)}; отказы и отмены: ${escapeHtml(fields.refused)}.</p><p>Даты заказов выборки: ${dateLabel(buyout.sampleStart)} — ${dateLabel(buyout.sampleEnd)}.${buyout.smallSample ? ' Мало данных: менее 30 заказов.' : ''}</p>${fields.buyoutreason ? `<p>${escapeHtml(fields.buyoutreason)}</p>` : ''}`}`;
}
export const csvHeaders = ['Товар', 'Артикул продавца', 'Артикул WB', 'Статус', 'Выручка, ₽', 'Расходы WB, ₽', 'Продвижение, ₽', 'Причина отсутствия продвижения', 'Себестоимость, ₽', 'Внешние расходы, ₽', 'Налог, ₽', 'Результат, ₽', 'Маржа, %', 'Продажи, шт.', 'Возвраты, шт.', 'Выкуп, %', 'Причина отсутствия выкупа', 'Размер выборки заказов', 'Выкуплены и оставлены', 'Возвраты после выкупа', 'Отказы и отмены', 'Финансовые отчёты'];
export function csvRecord(row) {
  return [row.name, row.seller, row.article, statusLabels[row.status] ?? statusLabels.incomplete, row.revenue, row.wb, '', promotionReason, row.cost, row.external, row.tax, row.result, row.margin, row.sales, row.returns, row.buyout ?? '', row.buyoutreason ?? buyoutReason, row.samplesize ?? '', row.retained ?? '', row.returned ?? '', row.refused ?? '', row.reports];
}
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); }
export function formatMoney(value) {
  const amount = decimal(value);
  if (!amount) return '—';
  const absolute = amount.units < 0n ? -amount.units : amount.units;
  const cents = amount.scale <= 2 ? absolute * 10n ** BigInt(2 - amount.scale) : (absolute + 10n ** BigInt(amount.scale - 2) / 2n) / 10n ** BigInt(amount.scale - 2);
  const digits = cents.toString().padStart(3, '0');
  return `${amount.units < 0n && cents ? '−' : ''}${digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')},${digits.slice(-2)} ₽`;
}
function signClass(value) { return decimal(value) ? compareAmounts(value, '0') < 0 ? 'sku-loss' : compareAmounts(value, '0') > 0 ? 'sku-positive' : '' : ''; }
function dateLabel(value) { return /^\d{4}-\d{2}-\d{2}$/.test(value ?? '') ? value.split('-').reverse().join('.') : '—'; }
const categoryLabels = { revenue: 'Выручка', revenue_return: 'Финансовые возвраты', acquiring: 'Эквайринг', logistics: 'Логистика', storage: 'Хранение', acceptance: 'Приёмка', penalty: 'Штрафы и пени', deduction: 'Удержания', commission_adjustment: 'Коррекция комиссии', other_adjustment: 'Другие корректировки', promotion: 'Продвижение WB', pickup_reward: 'Вознаграждение ПВЗ', wb_reward_without_vat: 'Вознаграждение WB без НДС', wb_reward_vat: 'НДС вознаграждения WB', return_wb_expense_reversal: 'Возврат расходов WB', wb_row_rounding_adjustment: 'Коррекция округления WB', cost_of_goods: 'Себестоимость', packaging: 'Упаковка', software_services: 'Программные сервисы', external_promotion: 'Внешнее продвижение', agency_services: 'Услуги агентства', other_external: 'Другие дополнительные расходы', estimated_usn_tax: 'Налог УСН', daily_tax_range: 'Налог за период' };
export function completeWeeks(weeks, period) {
  return (weeks ?? []).filter(week => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(week.start ?? '') || !/^\d{4}-\d{2}-\d{2}$/.test(week.end ?? '')) return false;
    const start = new Date(`${week.start}T00:00:00Z`), end = new Date(`${week.end}T00:00:00Z`);
    return start.getUTCDay() === 1 && end - start === 6 * 86400000 && week.start >= period?.start && week.end <= period?.end;
  });
}
export function cardContent(data) {
  const context = data?.context ?? {}, item = data?.presentation ?? data?.item ?? {};
  const mismatch = data?.reconciliation?.status === 'mismatch' || item.quality === 'unavailable';
  const metric = key => mismatch || item.metrics?.[key]?.availability === 'unavailable' ? null : item.metrics?.[key]?.amount;
  const result = metric('availableResultAfterTax'), revenue = metric('revenue');
  const status = mismatch ? 'incomplete' : item.status ?? productStatus(item);
  const buyout = item.buyout ?? data?.item?.buyout, orderFields = buyoutFields(buyout);
  const count = value => Number.isFinite(value) && value >= 0 ? escapeHtml(value) : '—';
  const reports = ids => (ids ?? []).length ? [...new Set(ids)].map(id => `<span class="sku-report-number">№ ${escapeHtml(id)}</span>`).join('') : '<span class="muted">Номера финансовых отчётов не подтверждены</span>';
  const line = (label, amount, ids = [], final = false) => `<div class="sku-card-financial-line${final ? ' sku-card-final' : ''}"><div><span>${escapeHtml(label)}</span>${ids.length ? `<small>Отчёты: ${reports(ids)}</small>` : ''}</div><strong class="${signClass(amount)}">${escapeHtml(formatMoney(amount))}</strong></div>`;
  const groups = item.groups ?? data?.item?.groups ?? [];
  const sections = [
    ['Выручка', 'revenue', ['revenue', 'revenue_return']],
    ['Расходы WB', 'wbExpenses', Object.keys(categoryLabels).filter(key => !['revenue', 'revenue_return', 'cost_of_goods', 'packaging', 'software_services', 'external_promotion', 'agency_services', 'other_external', 'estimated_usn_tax', 'daily_tax_range'].includes(key))],
    ['Себестоимость', 'costOfGoods', ['cost_of_goods']],
    ['Внешние расходы', 'externalExpenses', ['packaging', 'software_services', 'external_promotion', 'agency_services', 'other_external']],
    ['Налог', 'tax', ['estimated_usn_tax', 'daily_tax_range']]
  ];
  const breakdown = sections.map(([label, key, codes]) => {
    const children = groups.filter(group => codes.includes(group.categoryCode));
    const total = line(label, metric(key));
    return children.length ? `<details class="sku-card-category"><summary>${total}</summary><div class="sku-card-category-lines">${children.map(group => line(categoryLabels[group.categoryCode] ?? group.categoryCode, mismatch || group.quality === 'unavailable' ? null : group.amountSigned, group.reportIds)).join('')}</div></details>` : total;
  }).join('');
  const known = new Set(sections.flatMap(section => section[2]));
  const other = groups.filter(group => !known.has(group.categoryCode)).map(group => line(categoryLabels[group.categoryCode] ?? `Другой вклад (${group.categoryCode})`, mismatch ? null : group.amountSigned, group.reportIds)).join('');
  const weeks = completeWeeks(item.weeklyResults, context.period);
  // Bar geometry is decorative; labels retain exact decimal rounding.
  const values = weeks.map(week => mismatch || week.quality !== 'complete' || !decimal(week.result) ? null : Number(week.result));
  const max = Math.max(1, ...values.filter(Number.isFinite).map(Math.abs));
  const chart = weeks.length ? `<p>Только полные недели понедельник–воскресенье внутри выбранного периода. Неполные края периода исключены. Цвет — знак результата, высота — абсолютная величина.</p><div class="sku-week-chart" role="list">${weeks.map((week, index) => {
    const available = values[index] !== null, amount = available ? week.result : null;
    const height = Number.isFinite(values[index]) && values[index] !== 0 ? Math.max(2, Math.abs(values[index]) / max * 100) : 0;
    return `<div class="sku-week-bar" role="listitem"><small>${dateLabel(week.start)}<br>— ${dateLabel(week.end)}</small><div class="sku-bar-track" aria-hidden="true"><span class="${signClass(amount)}" style="height:${height}%"></span></div><strong class="${signClass(amount)}">${escapeHtml(formatMoney(amount))}</strong>${available ? '' : '<small>Нет полных данных</small>'}</div>`;
  }).join('')}</div>` : '<p>Полные сопоставимые недельные значения для выбранного периода недоступны.</p>';
  return `<div class="sku-dialog-result"><div><p>Результат после налога</p><strong class="${signClass(result)}">${escapeHtml(formatMoney(result))}</strong><p>Без общих строк магазина</p></div><span class="sku-tag sku-${escapeHtml(status)}">${escapeHtml(statusLabels[status] ?? statusLabels.incomplete)}</span></div><div class="sku-card-metric-grid"><div><span>Маржа</span><strong class="${signClass(result)}">${escapeHtml(marginPercent(result, revenue) ?? '—')}</strong><small>Результат к выручке</small></div><div><span>Продажи / возвраты</span><strong>${count(item.salesCount)} / ${count(item.returnsCount)}</strong><small>По операциям финансовых отчётов</small></div><div><span>Выкуп</span><strong>${buyoutPercent(orderFields.buyout)}</strong><small>${orderFields.buyout===''?'Расчёт недоступен · причина под ⓘ':`${escapeHtml(orderFields.samplesize)} завершённых заказов${buyout?.smallSample?' · мало данных':''}`}</small><details class="sku-card-buyout"><summary aria-label="Пояснение к проценту выкупа">ⓘ ${orderFields.buyout===''?'Почему недоступен':'Как рассчитан'}</summary>${buyoutExplanation(buyout,orderFields)}</details></div></div>${status === 'incomplete' ? '<p class="sku-card-notice">Часть исходных данных отсутствует или не подтверждена. Недоступные суммы не заменяются нулём; результат нельзя считать полным.</p>' : ''}<section class="sku-card-section"><h3>Продвижение</h3><p>${promotionReason}. Общие расходы магазина показаны отдельно и не распределяются пропорционально между товарами.</p></section><section class="sku-card-section"><h3>Из чего складывается результат</h3>${breakdown}${other}${line('Результат после налога', result, [], true)}<p>Строки сохранённого расчёта. Внутри категорий показаны знаковые вклады. Общие расходы магазина учитываются отдельно в итогах периода.</p></section><section class="sku-card-section"><h3>Полные недели выбранного периода</h3>${chart}</section><section class="sku-card-section"><h3>Финансовые отчёты</h3><p>Номера отчётов, включённых в расчёт товара за выбранный период.</p><div class="sku-card-reports">${reports(item.reportIds ?? data?.item?.reportIds)}</div></section>`;
}
// Each page owns a small cache; expiry revalidates access and tariff through HTTP.
export function createCardLoader({ fetchCard = globalThis.fetch, now = Date.now } = {}) {
  const cache = new Map();
  return async (url, signal) => {
    const fields = ['storeId', 'publicationSource', 'publicationId', 'periodStart', 'periodEnd', 'productId'].map(key => url.searchParams.get(key));
    if (fields.some(value => !value)) throw new Error('card_context_changed');
    const key = JSON.stringify(fields), time = now();
    const checkAbort = () => { if (signal?.aborted) throw new DOMException('Card request aborted', 'AbortError'); };
    checkAbort();
    for (const [entryKey, entry] of cache) if (entry.expiresAt <= time) cache.delete(entryKey);
    const cached = cache.get(key);
    if (cached) { cache.delete(key); cache.set(key, cached); return cached.data; }
    const response = await fetchCard(url, { cache: 'no-store', headers: { Accept: 'application/json' }, signal });
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error('card_unavailable');
    const data = await response.json();
    checkAbort();
    const actual = [data.context?.storeId, data.context?.publication?.source, data.context?.publication?.id, data.context?.period?.start, data.context?.period?.end, data.item?.productId];
    if (actual.some((value, index) => value !== fields[index])) throw new Error('card_context_changed');
    cache.delete(key); cache.set(key, { data, expiresAt: now() + 60000 });
    while (cache.size > 20) cache.delete(cache.keys().next().value);
    return data;
  };
}
function initialize() {
  const list = document.querySelector('[data-sku-list]');
  if (!list) return;
  const body = list.querySelector('tbody'), rows = [...body.querySelectorAll('[data-sku-row]')];
  const search = list.querySelector('[data-sku-search]'), sort = list.querySelector('[data-sku-sort]'), zero = list.querySelector('[data-sku-zero]');
  const initial = new URL(location.href).searchParams;
  const dialog = list.querySelector('[data-sku-dialog]'), content = dialog.querySelector('[data-sku-dialog-content]');
  const loadCard = createCardLoader();
  let opener, request;
  const showCard = async (row, trigger) => {
    const link = row.querySelector('[data-sku-card]');
    if (typeof dialog.showModal !== 'function') { location.assign(link.href); return; }
    request?.abort();
    const controller = new AbortController(); request = controller; opener = trigger;
    dialog.querySelector('[data-sku-dialog-title]').textContent = row.dataset.name;
    dialog.querySelector('[data-sku-dialog-meta]').textContent = `${row.dataset.seller || 'Артикул не сохранён'} · WB ${row.dataset.article || 'не сохранён'} · ${dateLabel(list.dataset.start)} — ${dateLabel(list.dataset.end)}`;
    content.textContent = 'Загружаем сохранённую карточку…'; content.setAttribute('aria-busy', 'true');
    if (!dialog.open) dialog.showModal();
    dialog.querySelector('[data-sku-dialog-close]').focus();
    try {
      const url = new URL(link.href); url.searchParams.set('format', 'json');
      if (url.searchParams.get('periodStart') !== list.dataset.start || url.searchParams.get('periodEnd') !== list.dataset.end) throw new Error('card_context_changed');
      const data = await loadCard(url, controller.signal);
      if (controller.signal.aborted) return;
      content.innerHTML = cardContent(data);
    } catch (error) {
      if (error.name === 'AbortError' || controller.signal.aborted) return;
      content.textContent = 'Сохранённая карточка недоступна. Закройте её и попробуйте снова; суммы не заменены нулём.';
    } finally { if (request === controller) content.setAttribute('aria-busy', 'false'); }
  };
  dialog.querySelector('[data-sku-dialog-close]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { request?.abort(); opener?.focus(); });
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  });
  search.value = initial.get('search') ?? '';
  const initialSort = initial.get('viewSort');
  if ([...sort.options].some(option => option.value === initialSort)) sort.value = initialSort;
  zero.checked = initial.get('hideZero') === '1';
  let filter = ['loss', 'near', 'profit', 'incomplete'].includes(initial.get('viewFilter')) ? initial.get('viewFilter') : 'all';
  const apply = () => {
    for (const row of rows) row.hidden = !matchesFilter(row.dataset, { search: search.value, filter, hideZero: zero.checked });
    const ordered = [...rows].sort((a, b) => compareRows(a.dataset, b.dataset, sort.value));
    for (const row of ordered) body.append(row);
    const count = rows.filter(row => !row.hidden).length;
    list.querySelector('[data-sku-count]').textContent = `Показано ${count} из ${rows.length} товаров`;
    list.querySelector('[data-sku-empty]').hidden = count !== 0;
    list.querySelector('[data-sku-export]').disabled = count === 0;
    list.querySelector('[data-sku-reset]').hidden = filter === 'all' && search.value === '' && sort.value === 'attention' && !zero.checked;
    list.querySelectorAll('[data-sku-column]').forEach(button => {
      const active = sort.value.startsWith(`${button.dataset.skuColumn}_`);
      button.closest('th').setAttribute('aria-sort', active ? sort.value.endsWith('asc') ? 'ascending' : 'descending' : 'none');
      button.querySelector('span').textContent = active ? sort.value.endsWith('asc') ? '↑' : '↓' : '';
    });
    list.querySelectorAll('[data-sku-filter]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.skuFilter === filter)));
    const state = { search: search.value, viewSort: sort.value, viewFilter: filter, hideZero: zero.checked ? '1' : '' };
    const updateUrl = url => { for (const [key, value] of Object.entries(state)) { if (value) url.searchParams.set(key, value); else url.searchParams.delete(key); } return url; };
    history.replaceState(null, '', updateUrl(new URL(location.href)));
    for (const row of rows) { const link = row.querySelector('[data-sku-card]'); link.href = updateUrl(new URL(link.href)).href; }
  };
  [search, sort, zero].forEach(input => input.addEventListener('input', apply));
  list.querySelectorAll('[data-sku-column]').forEach(button => button.addEventListener('click', () => {
    sort.value = `${button.dataset.skuColumn}_${sort.value === `${button.dataset.skuColumn}_asc` ? 'desc' : 'asc'}`;
    apply();
  }));
  list.querySelectorAll('[data-sku-filter]').forEach(button => button.addEventListener('click', () => { filter = button.dataset.skuFilter; apply(); }));
  list.querySelector('[data-sku-reset]').addEventListener('click', () => { search.value = ''; sort.value = 'attention'; zero.checked = false; filter = 'all'; apply(); });
  list.addEventListener('click', event => {
    const row = event.target.closest('[data-sku-row]');
    if (!row || event.target.closest('button,input,select') || window.getSelection()?.toString()) return;
    const link = row.querySelector('[data-sku-card]');
    if (event.target.closest('a') && !event.target.closest('[data-sku-card]')) return;
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
      if (!event.target.closest('a')) window.open(link.href, '_blank', 'noopener');
      return;
    }
    event.preventDefault(); showCard(row, event.target.closest('[data-sku-card]') ?? row);
  });
  list.addEventListener('keydown', event => {
    if (event.target.matches('[data-sku-row]') && ['Enter', ' '].includes(event.key)) {
      event.preventDefault(); showCard(event.target, event.target);
    }
  });
  list.querySelector('[data-sku-export]').addEventListener('click', () => {
    const records = [...body.querySelectorAll('[data-sku-row]')].filter(row => !row.hidden).map(row => csvRecord(row.dataset));
    const blob = new Blob(['\uFEFF' + [csvHeaders, ...records].map(record => record.map(csvCell).join(';')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = `sku-${list.dataset.start}-${list.dataset.end}.csv`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  apply();
}
if (typeof document !== 'undefined') initialize();
