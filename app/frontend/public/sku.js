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
  const key = sort.startsWith('revenue') ? 'revenue' : 'result';
  const left = decimal(a[key]), right = decimal(b[key]);
  if (!left || !right) return left ? -1 : right ? 1 : 0;
  return compareAmounts(a[key], b[key]) * (sort.endsWith('desc') ? -1 : 1);
}
function initialize() {
  const list = document.querySelector('[data-sku-list]');
  if (!list) return;
  const body = list.querySelector('tbody'), rows = [...body.querySelectorAll('[data-sku-row]')];
  const search = list.querySelector('[data-sku-search]'), sort = list.querySelector('[data-sku-sort]'), zero = list.querySelector('[data-sku-zero]');
  const initial = new URL(location.href).searchParams;
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
    list.querySelectorAll('[data-sku-filter]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.skuFilter === filter)));
    const state = { search: search.value, viewSort: sort.value, viewFilter: filter, hideZero: zero.checked ? '1' : '' };
    const updateUrl = url => { for (const [key, value] of Object.entries(state)) { if (value) url.searchParams.set(key, value); else url.searchParams.delete(key); } return url; };
    history.replaceState(null, '', updateUrl(new URL(location.href)));
    for (const row of rows) { const link = row.querySelector('[data-sku-card]'); link.href = updateUrl(new URL(link.href)).href; }
  };
  [search, sort, zero].forEach(input => input.addEventListener('input', apply));
  list.querySelectorAll('[data-sku-filter]').forEach(button => button.addEventListener('click', () => { filter = button.dataset.skuFilter; apply(); }));
  list.querySelector('[data-sku-reset]').addEventListener('click', () => { search.value = ''; sort.value = 'attention'; zero.checked = false; filter = 'all'; apply(); });
  list.addEventListener('click', event => {
    const row = event.target.closest('[data-sku-row]');
    if (!row || event.target.closest('a,button,input,select') || window.getSelection()?.toString()) return;
    const link = row.querySelector('[data-sku-card]');
    if (event.ctrlKey || event.metaKey) window.open(link.href, '_blank', 'noopener'); else location.assign(link.href);
  });
  list.addEventListener('keydown', event => {
    if (event.target.matches('[data-sku-row]') && ['Enter', ' '].includes(event.key)) {
      event.preventDefault(); location.assign(event.target.querySelector('[data-sku-card]').href);
    }
  });
  list.querySelector('[data-sku-export]').addEventListener('click', () => {
    const fields = ['name', 'seller', 'article', 'revenue', 'wb', 'promotion', 'cost', 'margin', 'buyout', 'result'];
    const header = ['Товар', 'Артикул продавца', 'Артикул WB', 'Выручка', 'Расходы WB', 'Продвижение', 'Себестоимость', 'Маржа', 'Выкуп', 'Результат'];
    const records = [...body.querySelectorAll('[data-sku-row]')].filter(row => !row.hidden).map(row => fields.map(field => row.dataset[field] ?? ''));
    const blob = new Blob(['\uFEFF' + [header, ...records].map(record => record.map(csvCell).join(';')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = `sku-${list.dataset.start}-${list.dataset.end}.csv`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  apply();
}
if (typeof document !== 'undefined') initialize();
