import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
export const palettes = {
  Light: { bg: '#FFFFFF', surface: '#F6F8FC', text: '#122044', muted: '#68758C', border: '#E2E8F1', accent: '#0866FF', comparison: '#AECDFE', selected: '#EDF4FF', danger: '#C9353E', warning: '#A66A0A', warningBg: '#FFF6E8', success: '#13865B', onAccent: '#FFFFFF' },
  Dark: { bg: '#101722', surface: '#182231', text: '#EAF0FA', muted: '#A7B4C8', border: '#303E52', accent: '#79A9FF', comparison: '#6782A9', selected: '#263245', danger: '#FF8790', warning: '#F2BB65', warningBg: '#30281D', success: '#69D4A4', onAccent: '#101722' },
};
export const current = [7, 9, 6, 5, 8, 7];
export const average = [5, 7, 5, 4, 7, 6];
const rect = (name, x, y, w, h, fill, radius = 0, stroke) => ({ kind: 'rect', name, x, y, w, h, fill, radius, stroke });
const circle = (name, x, y, d, fill, stroke) => ({ kind: 'circle', name, x, y, w: d, h: d, fill, stroke });
const text = (name, x, y, value, size = 16, fill = 'text', weight = 400, w = 400, align = 'LEFT') => ({ kind: 'text', name, x, y, w, h: size * 1.45, text: value, size, fill, weight, align });
const group = (name, x, y, w, h, children, props = {}) => ({ kind: 'frame', name, x, y, w, h, children, ...props });
const line = (name, x, y, w, h = 1) => rect(name, x, y, w, h, 'border');
const iconPaths = {
  calendar: 'M 4 4 L 20 4 L 20 21 L 4 21 Z M 4 9 L 20 9 M 8 1 L 8 6 M 16 1 L 16 6',
  chevron: 'M 6 9 L 12 15 L 18 9',
  right: 'M 8 5 L 15 12 L 8 19',
  home: 'M 2 11 L 12 2 L 22 11 M 5 9 L 5 22 L 19 22 L 19 9 M 10 22 L 10 15 L 14 15 L 14 22',
  settings: 'M 9 2 L 15 2 L 16 6 L 20 7 L 23 12 L 20 17 L 16 18 L 15 22 L 9 22 L 8 18 L 4 17 L 1 12 L 4 7 L 8 6 Z M 12 8 C 9.7909 8 8 9.7909 8 12 C 8 14.2091 9.7909 16 12 16 C 14.2091 16 16 14.2091 16 12 C 16 9.7909 14.2091 8 12 8 Z',
  sku: 'M 6 3 L 18 3 L 21 7 L 21 22 L 3 22 L 3 7 Z M 8 3 L 8 8 L 16 8 L 16 3',
  promo: 'M 3 10 L 19 4 L 19 20 L 3 14 Z M 6 15 L 8 22 L 12 22 L 10 16',
  region: 'M 12 23 C 8 18 3 13 3 9 C 3 4.0294 7.0294 0 12 0 C 16.9706 0 21 4.0294 21 9 C 21 13 16 18 12 23 Z M 12 5 C 9.7909 5 8 6.7909 8 9 C 8 11.2091 9.7909 13 12 13 C 14.2091 13 16 11.2091 16 9 C 16 6.7909 14.2091 5 12 5 Z',
  stock: 'M 3 8 L 21 8 L 21 22 L 3 22 Z M 7 8 L 7 3 L 17 3 L 17 8 M 3 13 L 21 13',
  data: 'M 3 5 C 3 0 21 0 21 5 L 21 19 C 21 24 3 24 3 19 Z M 3 5 C 3 10 21 10 21 5 M 3 12 C 3 17 21 17 21 12',
  info: 'M 12 2 C 6.4772 2 2 6.4772 2 12 C 2 17.5228 6.4772 22 12 22 C 17.5228 22 22 17.5228 22 12 C 22 6.4772 17.5228 2 12 2 Z M 12 10 L 12 17 M 12 6 L 12 7',
  plus: 'M 12 3 L 12 21 M 3 12 L 21 12',
};
const icon = (name, x, y, type, color = 'accent') => ({ kind: 'path', name, x, y, w: 24, h: 24, path: iconPaths[type], stroke: color, strokeWidth: 1.7 });
function datePicker(name, x, y, w, dates) {
  return group(name, x, y, w, 44, [icon('Calendar', 14, 10, 'calendar', 'text'), text('Dates', 50, 10, dates, 16, 'text', 500, w - 100), icon('Open', w - 38, 10, 'chevron')], { stroke: 'border', radius: 8, component: 'Date picker', layout: 'HORIZONTAL', gap: 12, paddingX: 14, paddingY: 10 });
}
function nav(name, x, y, w, title, type, active = false) {
  return group(name, x, y, w, 52, [icon('Icon', 16, 14, type, active ? 'accent' : 'muted'), text('Label', 52, 15, title, 16, active ? 'accent' : 'text', active ? 600 : 400, w - 68)], { fill: active ? 'selected' : undefined, radius: 8, component: active ? 'Nav active' : 'Nav item', layout: 'HORIZONTAL', gap: 12, paddingX: 16, paddingY: 14 });
}
function alertRow(name, x, y, w, title, amount, detail, level = 'danger', compact = false) {
  const h = compact ? 46 : 114;
  const kids = compact ? [rect('Urgency', 0, 0, 4, h, level, 2), text('Title', 18, 13, title, 14, 'text', 400, w - 150), text('Fact', w - 130, 13, amount, 14, level, 500, 102, 'RIGHT'), icon('Details', w - 26, 11, 'right')] : [circle('Urgency', 0, 6, 30, level), text('Mark', 0, 8, '!', 18, 'onAccent', 600, 30, 'CENTER'), text('Title', 50, 4, title, 18, 'text', 600, w - 80), text('Fact', 50, 36, amount, 18, level, 500, w - 80), text('Context', 50, 67, detail, 14, 'muted', 400, w - 80), icon('Details', w - 24, 42, 'right'), line('Divider', 0, h - 1, w)];
  return group(name, x, y, w, h, kids, { component: (compact ? 'Situation compact ' : 'Situation ') + level });
}
function control(name, x, y, w, date, title, detail, compact = false) {
  return group(name, x, y, w, compact ? 44 : 112, compact ? [text('Date', 12, 13, date, 12, 'accent', 600, 65), text('Title', 84, 13, title, 12, 'text', 400, w - 110), icon('Details', w - 24, 10, 'right')] : [circle('Point', 0, 10, 14, 'selected', 'accent'), text('Date', 42, 6, date, 20, 'text', 600, 120), text('Title', 182, 5, title, 18, 'text', 500, w - 182), text('Context', 182, 54, detail, 14, 'muted', 400, w - 182)], { component: compact ? 'Control compact' : 'Control point' });
}
function nowBlock(x, y) {
  const kids = [text('Heading', 0, 0, 'СЕЙЧАС · 8–13 сентября', 16, 'text', 600, 460), datePicker('Dates', 0, 44, 340, '8–13 сентября 2026'), text('Orders tab', 10, 105, 'Заказы', 16, 'accent', 500, 90), text('Buyouts tab', 142, 105, 'Выкупы', 16, 'muted', 400, 100), rect('Active underline', 0, 139, 112, 2, 'accent'), line('Inactive underline', 132, 139, 112), text('Metric label', 0, 164, 'ЗАКАЗЫ ЗА ПЕРИОД', 14, 'muted', 500, 400), text('Metric', 0, 194, '42 шт. · 76 800 ₽', 32, 'text', 600, 365), icon('Metric info', 394, 205, 'info', 'muted'), text('Change', 0, 248, '↑ 23,5% к среднему за прошлые периоды', 16, 'success', 400, 460), circle('Current legend', 0, 312, 12, 'accent'), text('Current label', 24, 306, 'Текущие', 14, 'muted', 400, 96), circle('Average legend', 130, 312, 12, 'comparison'), text('Average label', 154, 306, 'Среднее за 4 периода', 14, 'muted', 400, 260), text('Unit', 0, 345, 'Заказы, шт.', 12, 'muted', 400, 100)];
  for (const label of kids.filter(n => ['Current label', 'Average label', 'Unit'].includes(n.name))) {
    label.y -= 20;
    label.size += 2;
    label.h = label.size * 1.45;
    if (label.name === 'Unit') label.w = 120;
  }
  for (const marker of kids.filter(n => ['Current legend', 'Average legend'].includes(n.name))) marker.y -= 20;
  const baseline = 435;
  for (const tick of [0, 6, 12]) { kids.push(line('Grid ' + tick, 20, baseline - tick * 6, 428)); kids.push(text('Tick ' + tick, -18, baseline - tick * 6 - 8, String(tick), 11, 'muted', 400, 28)); }
  for (let i = 0; i < 6; i++) {
    const px = 22 + i * 72;
    kids.push(group('Day ' + (8 + i), px, 0, 58, 478, [rect('Current bar', 0, baseline - current[i] * 6, 22, current[i] * 6, 'accent', 3), rect('Average bar', 26, baseline - average[i] * 6, 22, average[i] * 6, 'comparison', 3), text('Current value', 0, baseline - current[i] * 6 - 23, String(current[i]), 12, 'text', 500, 22, 'CENTER'), text('Average value', 26, baseline - average[i] * 6 - 23, String(average[i]), 12, 'muted', 400, 22, 'CENTER'), text('Day label', -5, baseline + 9, (8 + i) + ' сен\n' + ['вт', 'ср', 'чт', 'пт', 'сб', 'вс'][i], 11, 'muted', 400, 60, 'CENTER')]));
  }
  return group('Сейчас / заказы', x, y, 460, 480, kids);
}
function desktop(theme) {
  const kids = [line('Sidebar separator', 278, 0, 1, 1080), rect('Brand icon', 24, 28, 52, 52, 'accent', 12), text('Brand monogram', 24, 35, 'M', 28, 'onAccent', 600, 52, 'CENTER'), text('Brand', 94, 26, 'Marketplace\nControl', 22, 'text', 600, 174), nav('Обзор', 16, 132, 244, 'Обзор', 'home', true), text('Analytics group', 32, 218, 'АНАЛИТИКА', 12, 'muted', 500, 200)];
  [['SKU', 'sku'], ['Продвижение', 'promo'], ['Регионы', 'region'], ['Остатки', 'stock']].forEach(([label, type], i) => kids.push(nav(label, 16, 252 + i * 60, 244, label, type)));
  kids.push(line('Menu group divider', 32, 506, 212), text('Settings group', 32, 540, 'ДАННЫЕ И НАСТРОЙКИ', 12, 'muted', 500, 225), nav('Добавить данные', 16, 576, 244, 'Добавить данные', 'data'), nav('Настройки', 16, 636, 244, 'Настройки', 'settings'), icon('Help icon', 32, 1004, 'info', 'muted'), text('Help', 76, 1004, 'Помощь', 16, 'muted', 400, 145), datePicker('Business selector', 312, 28, 406, 'Дом и уют'), icon('Settings shortcut', 1840, 42, 'settings', 'text'));
  kids.push(group('Прибыль', 312, 126, 490, 460, [text('Heading', 0, 0, 'ПРИБЫЛЬ ПО ДОСТУПНЫМ ДАННЫМ', 16, 'muted', 600, 490), datePicker('Financial dates', 0, 44, 360, '1–7 сентября 2026'), text('Delay', 0, 100, 'Финансовые данные · итог с задержкой до 14 дней', 12, 'muted', 400, 490), text('Profit amount', 0, 156, '214 300 ₽', 56, 'text', 600, 490), text('Change', 0, 244, '↓ 5,1% к прошлой неделе', 18, 'danger', 400, 490), text('Revenue and expenses', 0, 312, 'Выручка  1 248 600 ₽  ·  Расходы  1 034 300 ₽', 16, 'text', 400, 490), group('Incomplete data', 0, 366, 490, 84, [circle('Warning', 16, 25, 30, 'warning'), text('Mark', 16, 26, '!', 20, 'onAccent', 600, 30, 'CENTER'), text('Missing costs', 64, 18, 'Не указана себестоимость 12 товаров —\nприбыль неполная ·', 14, 'text', 400, 410), text('Fill data', 205, 40, 'Заполнить', 14, 'accent', 500, 200)], { fill: 'warningBg', radius: 8 })]));
  const profit = kids.find(n => n.name === 'Прибыль');
  profit.children = profit.children.filter(n => n.name !== 'Delay');
  kids.push(line('Profit now divider', 842, 126, 1, 472), nowBlock(882, 126), line('Now attention divider', 1374, 126, 1, 472));
  kids.push(group('Требует внимания', 1414, 126, 458, 472, [text('Heading', 0, 0, 'ТРЕБУЕТ ВНИМАНИЯ · 4', 16, 'text', 600, 458), line('Header divider', 0, 42, 458), alertRow('Убыток', 0, 64, 458, 'Убыток до продвижения', '−18 400 ₽', 'За неделю 1–7 сентября'), alertRow('Штрафы', 0, 192, 458, 'Штрафы и пени', '12 480 ₽', 'Новые начисления'), alertRow('Возвраты', 0, 320, 458, 'Рост возвратов', '8,6% против 4,1%', 'К прошлому периоду', 'warning'), text('All situations', 0, 446, 'Все ситуации (4)  →', 16, 'accent', 500, 450)]));
  kids.push(line('Main horizontal divider', 312, 628, 1560), text('Investigations heading', 312, 660, 'СТОИТ ПРОВЕРИТЬ', 22, 'text', 600, 864), line('Bottom divider', 1212, 660, 1, 380), text('Control heading', 1260, 660, 'КОНТРОЛЬНЫЕ ТОЧКИ', 22, 'text', 600, 600));
  const rows = [
    ['Рост возвратов', '8,6% против 4,1% в прошлом периоде', 'Основной вклад: SKU «Термокружка 350 мл»', 'Разобраться', [4.1, 8.6], ['4,1%', '8,6%'], ['Прошлый', 'Текущий']],
    ['Остаток вне диапазона', '«Органайзер белый» · 18 шт. при минимуме 40', 'Проверить фактический остаток и поступления', 'Проверить остатки', [18, 40], ['18', '40'], ['Остаток', 'Минимум']],
    ['Снижение заказов', '−22% к предыдущему шестидневному периоду', 'Другая база сравнения: 1–6 сентября, 54 заказа', 'Посмотреть причины', [54, 42], ['54', '42'], ['1–6 сен', '8–13 сен']],
  ];
  rows.forEach(([title, fact, context, action, values, labels, captions], i) => {
    const max = Math.max(...values), barScale = 58 / max;
    kids.push(group('Проверка ' + (i + 1), 312, 720 + i * 110, 864, 102, [circle('Priority', 4, 9, 10, i === 2 ? 'muted' : 'warning'), text('Title', 38, 0, title, 18, 'text', 600, 390), text('Fact', 38, 34, fact, 14, 'muted', 400, 420), text('Context', 38, 60, context, 13, 'muted', 400, 430), group('Mini comparison', 468, 0, 190, 96, [line('Baseline', 0, 66, 184), rect('Previous', 24, 66 - values[0] * barScale, 40, values[0] * barScale, 'comparison', 3), rect('Current', 120, 66 - values[1] * barScale, 40, values[1] * barScale, i === 1 ? 'warning' : 'accent', 3), text('Previous value', 9, 66 - values[0] * barScale - 22, labels[0], 12, 'text', 500, 70, 'CENTER'), text('Current value', 105, 66 - values[1] * barScale - 22, labels[1], 12, 'text', 500, 70, 'CENTER'), text('Previous label', 0, 74, captions[0], 11, 'muted', 400, 88, 'CENTER'), text('Current label', 96, 74, captions[1], 11, 'muted', 400, 88, 'CENTER')]), text('Action', 672, 35, action + '  →', 14, 'accent', 500, 192, 'RIGHT'), line('Divider', 0, 101, 864)]));
  });
  kids.push(line('Timeline', 1267, 740, 1, 207), control('Тест рекламы', 1260, 718, 600, '14 сент.', 'Проверить результат\nтеста рекламы', 'Цель: результат товара ≥ 0 ₽\nЧерез 1 день'), control('Поставка', 1260, 850, 600, '18 сент.', 'Уточнить результат\nпоставки', 'Ожидается подтверждение приёмки\nЧерез 5 дней'), text('All controls', 1260, 1004, 'Все контрольные точки  →', 14, 'accent', 500, 272), group('Add control', 1580, 986, 292, 54, [icon('Plus', 16, 15, 'plus'), text('Label', 54, 17, 'Добавить контрольную точку', 14, 'accent', 500, 224)], { stroke: 'border', radius: 8, component: 'Add control' }));
  return { ...group('Desktop · ' + theme + ' · 1920×1080', theme === 'Light' ? 200 : 2300, 100, 1920, 1080, kids, { fill: 'bg' }), theme };
}
function mobile(theme) {
  const kids = [text('Status time', 20, 12, '9:41', 12, 'text', 600, 60), text('Status icons', 294, 12, '●  ▰', 12, 'text', 500, 72, 'RIGHT'), rect('Brand', 20, 52, 28, 28, 'accent', 7), text('Monogram', 20, 53, 'M', 16, 'onAccent', 600, 28, 'CENTER'), group('Business', 68, 46, 208, 40, [icon('Home', 12, 8, 'home', 'text'), text('Label', 48, 10, 'Дом и уют', 14, 'text', 600, 125), icon('Open', 176, 8, 'chevron')], { stroke: 'border', radius: 8 }), icon('Settings', 344, 52, 'settings', 'text')];
  ['Неделя', 'Месяц', 'Квартал', 'Год'].forEach((label, i) => kids.push(group('Period ' + label, 20 + i * 90, 98, 84, 38, [text('Label', 0, 9, label, 12, i ? 'text' : 'onAccent', 500, 84, 'CENTER')], { fill: i ? 'bg' : 'accent', stroke: i ? 'border' : undefined, radius: 8, component: i ? 'Period inactive' : 'Period active' })));
  kids.push(text('Dates', 20, 151, 'Неделя: 1–7 сентября 2026', 14, 'text', 600, 350, 'CENTER'), text('Delay', 20, 175, 'Итог с задержкой до 14 дней', 12, 'muted', 400, 350, 'CENTER'), group('Incomplete data', 20, 207, 350, 58, [icon('Info', 12, 17, 'info', 'warning'), text('Missing', 48, 12, 'Не указана себестоимость 12 товаров —\nприбыль неполная', 12, 'text', 400, 290), text('Fill', 237, 31, 'Заполнить', 12, 'accent', 600, 100)], { fill: 'warningBg', radius: 10 }));
  kids.push(group('Прибыль', 20, 277, 350, 212, [text('Heading', 16, 15, 'ПРИБЫЛЬ ПО ДОСТУПНЫМ ДАННЫМ', 12, 'muted', 500, 320), text('Amount', 16, 41, '214 300 ₽', 34, 'text', 600, 318), text('Change', 16, 94, '↓ 5,1% к 25–31 августа', 14, 'danger', 500, 318), line('Divider 1', 16, 127, 318), text('Revenue label', 16, 139, 'Выручка', 12, 'muted', 400, 110), text('Revenue', 139, 139, '1 248 600 ₽', 12, 'text', 600, 195, 'RIGHT'), line('Divider 2', 16, 161, 318), text('Expenses label', 16, 169, 'Расходы', 12, 'muted', 400, 110), text('Expenses', 139, 169, '1 034 300 ₽', 12, 'text', 600, 195, 'RIGHT'), text('Tax label', 16, 190, 'Налог', 12, 'muted', 400, 110), text('Tax setup', 139, 190, 'Настроить', 12, 'accent', 600, 195, 'RIGHT')], { fill: 'bg', stroke: 'border', radius: 12 }));
  kids.push(group('Сейчас заказы', 20, 505, 350, 88, [text('Title', 16, 12, 'СЕЙЧАС · ЗАКАЗЫ', 12, 'text', 600, 318), rect('Current', 16, 41, 190, 8, 'accent', 4), rect('Average', 16, 61, 152, 8, 'comparison', 4), text('Current value', 224, 34, '42 заказа', 13, 'accent', 600, 110, 'RIGHT'), text('Average value', 224, 55, 'обычно ~34', 12, 'muted', 400, 110, 'RIGHT')], { fill: 'bg', stroke: 'border', radius: 12 }));
  kids.push(text('Situations title', 20, 615, 'ВАЖНО ПРОВЕРИТЬ · 4', 13, 'text', 600, 350), text('Urgent label', 20, 643, 'Срочно', 12, 'danger', 600, 350), group('Urgent list', 20, 670, 350, 94, [alertRow('Убыток', 0, 0, 350, 'Убыток до продвижения', '−18 400 ₽', '', 'danger', true), line('Divider', 18, 46, 312), alertRow('Штрафы', 0, 48, 350, 'Штрафы и пени', '12 480 ₽', '', 'danger', true)], { fill: 'bg', stroke: 'border', radius: 10 }));
  kids.push(text('Check label', 20, 785, 'Стоит проверить', 12, 'warning', 600, 350), group('Recommended list', 20, 812, 350, 94, [alertRow('Возвраты', 0, 0, 350, 'Рост возвратов', '8,6%', '', 'warning', true), line('Divider', 18, 46, 312), alertRow('Остаток', 0, 48, 350, 'Остаток вне диапазона', '18 шт.', '', 'warning', true)], { fill: 'bg', stroke: 'border', radius: 10 }));
  kids.push(text('Controls heading', 20, 930, 'КОНТРОЛЬНЫЕ ТОЧКИ · 2', 13, 'text', 600, 350), group('Controls', 20, 960, 350, 90, [control('Тест рекламы', 0, 0, 350, '14 сент.', 'Проверить результат теста рекламы', '', true), line('Divider', 12, 45, 326), control('Поставка', 0, 46, 350, '18 сент.', 'Уточнить результат поставки', '', true)], { fill: 'bg', stroke: 'border', radius: 10 }));
  kids.push(rect('Bottom nav bg', 0, 1072, 390, 78, 'bg'), line('Bottom nav divider', 0, 1072, 390));
  [['Обзор', 'home'], ['SKU', 'sku'], ['Продвиж.', 'promo'], ['Регионы', 'region'], ['Остатки', 'stock']].forEach(([label, type], i) => {
    kids.push(group('Bottom nav ' + label, i * 78, 1084, 78, 56, [icon('Icon', 27, 0, type, i ? 'muted' : 'accent'), text('Label', 0, 30, label, 10, i ? 'muted' : 'accent', i ? 400 : 600, 78, 'CENTER')], { component: i ? 'Mobile nav' : 'Mobile nav active' }));
    if ([1, 2, 4].includes(i)) kids.push(circle('Section signal ' + label, i * 78 + 48, 1081, 6, i === 1 ? 'danger' : 'warning'));
  });
  return { ...group('Mobile · ' + theme + ' · 390×1150', theme === 'Light' ? 200 : 730, 1350, 390, 1150, kids, { fill: 'surface' }), theme };
}
function states() {
  return group('Состояния и раскрытия', 200, 200, 1440, 1080, [text('Title', 40, 32, 'Состояния и раскрытия', 28, 'text', 600, 1320), text('Subtitle', 40, 82, 'Дополнительная информация появляется по запросу. Без прогнозов и общих уведомлений.', 16, 'muted', 400, 1320), group('Profit calendar open', 40, 144, 390, 374, [text('Title', 20, 20, 'Сентябрь 2026', 18, 'text', 600, 350), text('Weekdays', 20, 65, 'Пн    Вт    Ср    Чт    Пт    Сб    Вс', 14, 'muted', 400, 350), ...Array.from({ length: 30 }, (_, i) => group('Date ' + (i + 1), 20 + ((i + 1) % 7) * 50, 100 + Math.floor((i + 1) / 7) * 43, 44, 36, [text('Day', 0, 7, String(i + 1), 14, i < 7 ? 'accent' : 'text', 500, 44, 'CENTER')], { fill: i < 7 ? 'selected' : undefined, radius: 6 })), text('Selected range', 20, 300, '1 сентября — 7 сентября 2026', 14, 'muted', 400, 350), text('Apply', 20, 338, 'Применить', 14, 'accent', 600, 350, 'RIGHT')], { fill: 'bg', stroke: 'border', radius: 12 }), group('Metric tooltip', 490, 144, 414, 154, [text('Title', 20, 20, 'База сравнения', 16, 'text', 600, 374), text('Explanation', 20, 55, 'В среднем: 34 заказа · 62 100 ₽\nза сопоставимые 6 дней. Для каждого дня\nсреднее по 4 предыдущим периодам.', 14, 'muted', 400, 374)], { fill: 'bg', stroke: 'border', radius: 12 }), group('No urgent situations', 960, 144, 430, 154, [text('Title', 20, 20, 'Срочных ситуаций нет', 18, 'text', 600, 390), text('Context', 20, 60, 'По доступным данным.\nРекомендованные проверки остаются ниже.', 14, 'muted', 400, 390)], { fill: 'surface', radius: 12 }), group('Buyouts state', 490, 350, 414, 168, [text('Tabs', 20, 20, 'Заказы       Выкупы', 16, 'accent', 500, 374), text('Metric', 20, 67, '31 шт. · 58 400 ₽', 28, 'text', 600, 374), text('Context', 20, 114, 'Сравнение с историей выкупов, не заказов.', 14, 'muted', 400, 374)], { fill: 'surface', radius: 12 }), text('Many situations heading', 40, 582, 'Много ситуаций: короткий список + переход ко всем', 20, 'text', 600, 1320), alertRow('More urgent 1', 40, 642, 660, 'Убыток до продвижения', '−18 400 ₽', 'За неделю 1–7 сентября'), alertRow('More urgent 2', 40, 770, 660, 'Штрафы и пени', '12 480 ₽', 'Новые начисления'), text('All urgent', 40, 915, 'Все срочные ситуации (8)  →', 16, 'accent', 500, 660), text('State rules', 780, 650, 'Не растягивать карточки при отсутствии алармов.\nПри большом числе проблем показывать приоритетные,\nсохранять счётчик и переход ко всем.\n\nКалендарь прибыли и календарь «Сейчас» независимы.\n«Заказы / Выкупы» переключает один показатель.\nСтрелок перехода между периодами нет.\n\nВ мобильной версии справка открывается нажатием.\nДиаграммы — только исторические факты.', 16, 'muted', 400, 590)], { fill: 'bg' });
}
function styleSheet() {
  const kids = [text('Title', 48, 36, 'Marketplace Control · Стили', 32, 'text', 600, 1300), text('Rules', 48, 94, 'Сдержанная типографика, воздух, один цвет действий. Иллюстративные данные — только для дизайна.', 16, 'muted', 400, 1300)];
  for (const [theme, palette] of Object.entries(palettes)) {
    const top = theme === 'Light' ? 158 : 322;
    kids.push(text(theme, 48, top, theme, 20, 'text', 600, 1300));
    Object.keys(palette).slice(0, 12).forEach((role, i) => kids.push(group(theme + '/' + role, 48 + i * 110, top + 44, 96, 100, [rect('Swatch', 0, 0, 96, 48, role, 8), text('Role', 0, 60, role, 11, 'muted', 400, 96)], { theme })));
  }
  kids.push(text('Typography', 48, 520, 'Inter · Regular / Medium / Semi Bold', 24, 'text', 600, 1300), text('Sizes', 48, 574, '12 — подписи · 14–16 — основной текст · 18–22 — заголовки\n28–34 — оперативные показатели · 34 / 56 — прибыль на mobile / desktop', 18, 'muted', 400, 1300), text('Spacing', 48, 688, 'Отступы: 4 · 8 · 12 · 16 · 24 · 32 · 48 · 64 px\nРадиусы: 8–12 px. Разделители: 1 px.', 18, 'muted', 400, 1300), text('Notes', 48, 806, 'Три верхних блока: прибыль, сейчас, требует внимания.\nНижняя половина desktop: что проверить и контрольные точки.\nНеполнота финансовых данных всегда обозначена рядом с прибылью.', 18, 'text', 400, 1300));
  return group('Стили и правила', 200, 100, 1440, 1000, kids, { fill: 'bg' });
}
export const design = { palettes, screens: [desktop('Light'), desktop('Dark'), mobile('Light'), mobile('Dark')], styleSheet: styleSheet(), states: states() };
const escapeXml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
function svgNode(node, inheritedTheme) {
  const theme = node.theme || inheritedTheme;
  const palette = palettes[theme];
  const id = escapeXml(node.name);
  const fill = node.fill ? palette[node.fill] : 'none';
  const stroke = node.stroke ? ` stroke="${palette[node.stroke]}" stroke-width="${node.strokeWidth || 1}"` : '';
  if (node.kind === 'rect') return `<rect data-name="${id}" x="${node.x}" y="${node.y}" width="${node.w}" height="${node.h}" rx="${node.radius || 0}" fill="${fill}"${stroke}/>`;
  if (node.kind === 'circle') return `<ellipse data-name="${id}" cx="${node.x + node.w / 2}" cy="${node.y + node.h / 2}" rx="${node.w / 2}" ry="${node.h / 2}" fill="${fill}"${stroke}/>`;
  if (node.kind === 'path') return `<path data-name="${id}" transform="translate(${node.x} ${node.y})" d="${node.path}" fill="${fill}"${stroke} stroke-linecap="round" stroke-linejoin="round"/>`;
  if (node.kind === 'text') {
    const anchor = node.align === 'RIGHT' ? 'end' : node.align === 'CENTER' ? 'middle' : 'start';
    const tx = node.x + (node.align === 'RIGHT' ? node.w : node.align === 'CENTER' ? node.w / 2 : 0);
    return `<text data-name="${id}" xml:space="preserve" font-family="Inter,Segoe UI,Arial,sans-serif" font-size="${node.size}" font-weight="${node.weight}" fill="${fill}" text-anchor="${anchor}">${node.text.split('\n').map((s, i) => `<tspan x="${tx}" y="${node.y + node.size + i * node.size * 1.45}">${escapeXml(s)}</tspan>`).join('')}</text>`;
  }
  return `<g data-name="${id}" transform="translate(${node.x || 0} ${node.y || 0})">${node.fill || node.stroke ? `<rect width="${node.w}" height="${node.h}" rx="${node.radius || 0}" fill="${fill}"${stroke}/>` : ''}${(node.children || []).map(child => svgNode(child, theme)).join('')}</g>`;
}
export function renderSvg(spec) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${spec.w}" height="${spec.h}" viewBox="0 0 ${spec.w} ${spec.h}"><title>${escapeXml(spec.name)}</title>${svgNode({ ...spec, x: 0, y: 0 }, spec.theme || 'Light')}</svg>`;
}
export function build(output = directory) {
  mkdirSync(join(output, 'figma-import'), { recursive: true });
  for (const screen of design.screens) writeFileSync(join(output, (screen.name.startsWith('Desktop') ? 'desktop' : 'mobile') + '-' + screen.theme.toLowerCase() + '.svg'), renderSvg(screen));
  writeFileSync(join(output, 'states.svg'), renderSvg(design.states));
  writeFileSync(join(output, 'styles.svg'), renderSvg(design.styleSheet));
  writeFileSync(join(output, 'design-spec.json'), JSON.stringify(design, null, 2) + '\n');
  const runtime = readFileSync(join(directory, 'figma-import/runtime.js'), 'utf8');
  writeFileSync(join(output, 'figma-import/code.js'), 'const MC_DESIGN = ' + JSON.stringify(design) + ';\n' + runtime);
  const scripterRuntime = runtime
    .replace('await figma.loadAllPagesAsync();', "if (typeof figma.loadAllPagesAsync === 'function') await figma.loadAllPagesAsync();")
    .replace("if (existing.some(Boolean)) throw new Error('Макет MC уже импортирован. Используйте другой файл, чтобы не создавать дубликаты.');", "if (existing.slice(0, 2).some(p => p && p.children.length)) throw new Error('На страницах экранов или компонентов уже есть слои. Импорт остановлен без удаления данных.');")
    .replace('const p = figma.root.children.find', 'const p = existing[i] || figma.root.children.find')
    .replaceAll('await figma.setCurrentPageAsync(', 'await setPage(')
    .replace("figma.closePlugin('Готово: 4 редактируемых экрана, компоненты и стили.');", "print('Готово: 4 редактируемых экрана, компоненты и стили.');")
    .replace("importMarketplaceControl().catch(error => figma.closePlugin('Импорт остановлен: ' + error.message));", 'await importMarketplaceControl();');
  writeFileSync(join(output, 'scripter-import.js'), 'const MC_DESIGN = ' + JSON.stringify(design) + ';\n' + "async function setPage(page) { if (typeof figma.setCurrentPageAsync === 'function') await figma.setCurrentPageAsync(page); else figma.currentPage = page; }\n" + scripterRuntime);
  writeFileSync(join(output, 'scripter-recovery.js'), '// @ts-nocheck\n// Scripter uses legacy API typings. This disables editor diagnostics, not runtime checks.\nconst MC_DESIGN = ' + JSON.stringify(design) + ';\n' + readFileSync(join(directory, 'scripter-runtime.js'), 'utf8'));
  console.log('Built four screens, states, styles and a native Figma importer.');
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) build();
