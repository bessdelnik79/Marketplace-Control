import assert from 'node:assert/strict';
import test from 'node:test';
import { createAccountPage } from './account.page.mjs';

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const accountPage = createAccountPage({
  frame: (user, route, content, stores) => { assert.equal(route, '/settings'); assert.deepEqual(user.stores, stores); return content; },
  esc,
  icon: name => `<span class="ui-icon" data-icon="${name}" aria-hidden="true"></span>`,
  storeHref: (path, storeId) => storeId ? `${path}?storeId=${encodeURIComponent(storeId)}` : path,
});
const user = { display_name: 'Анна', email: 'anna@example.test' };
const store = { id: 'store-1', name: 'Мой WB', connected: true };
const catalog = { productLimit: 10, products: [{ selected: true }, { selected: true }, { selected: false }] };

test('account renders real escaped profile, store, plan and feedback values', () => {
  const html = accountPage({ display_name: '<Имя "владельца">', email: 'a"<&@example.test' }, [{ ...store, name: '<Магазин>', id: 'store"<&' }], {
    catalog,
    billing: { current: { name: '<Платный>', product_limit: 20, store_limit: 2, status: 'past_due' } },
    notice: '<Сохранено>', error: '<Ошибка>',
  });
  assert.match(html, /value="&lt;Имя &quot;владельца&quot;&gt;"/);
  assert.match(html, /value="a&quot;&lt;&amp;@example.test" readonly aria-readonly="true"/);
  assert.match(html, /&lt;Магазин&gt;/);
  assert.match(html, /name="storeId" value="store&quot;&lt;&amp;"/);
  assert.match(html, /&lt;Платный&gt;/);
  assert.match(html, /До 20 товаров · 2 магазина/);
  assert.match(html, /Требует оплаты/);
  assert.match(html, /role="status">&lt;Сохранено&gt;/);
  assert.match(html, /role="alert">&lt;Ошибка&gt;/);
  assert.doesNotMatch(html, /<Магазин>|<Ошибка>|<Сохранено>|seller@example\.com|Андрей/);
});

test('account uses selection count and current catalog limit without product previews', () => {
  const html = accountPage(user, [store], { catalog });
  assert.match(html, /account-product-count">Выбрано <span>2 товара<\/span> · лимит тарифа — 10/);
  assert.match(html, /href="\/products\?storeId=store-1"><span[^>]*data-icon="list"[^>]*><\/span>Управлять товарами/);
  assert.doesNotMatch(html, /catalog-products|catalog-product|<img|thumbnail|\/products\/select/);
  assert.match(accountPage(user, [store], { catalog: { products: [{ selected: false }] }, billing: { current: { name: 'Старт', product_limit: 7, store_limit: 1 } } }), /Выбрано <span>0 товаров<\/span> · лимит тарифа — 7/);
  assert.match(accountPage(user, [store], { catalog: { products: [{ selected: false }] } }), /Выбрано <span>0 товаров<\/span> · лимит тарифа — 3/);
  assert.match(accountPage(user, [store], { catalog: { productLimit: 0, products: [{ selected: false }] } }), /Выбрано <span>0 товаров<\/span> · лимит тарифа — 0/);
});

test('profile retains POST contract, editable name, readonly email and existing action hooks', () => {
  const html = accountPage(user, [store], { catalog });
  assert.match(html, /id="account-form"[^>]*method="post" action="\/account\/profile"/);
  assert.match(html, /name="displayName" value="Анна" required minlength="2" maxlength="80" autocomplete="name"/);
  assert.match(html, /name="displayEmail" type="email" value="anna@example.test" readonly/);
  assert.match(html, /aria-describedby="account-email-note"/);
  assert.match(html, /Email нельзя изменить\./);
  assert.match(html, /account-primary" type="submit">Сохранить<\/button>/);
  assert.match(html, /type="button" data-reset-settings>Отменить/);
  assert.match(html, /type="button" data-logout><span[^>]*data-icon="logout"[^>]*><\/span><span>Выйти из аккаунта/);
  assert.match(html, /href="\/account\/delete"><span[^>]*data-icon="trash"[^>]*><\/span><span>Удалить аккаунт/);
  assert.match(html, /href="\/password\?storeId=store-1"><span[^>]*data-icon="lock"[^>]*><\/span>Изменить пароль/);
  assert.match(html, /Необратимое действие\. Все данные будут удалены\./);
  assert.doesNotMatch(html, /appearance|ОФОРМЛЕНИЕ|data-theme-choice|displayName[^>]*placeholder/);
});

test('connected token form is collapsed, scoped to the store and has actionable help', () => {
  const html = accountPage(user, [store]);
  assert.match(html, /<details class="account-token-details"><summary class="account-button"><span[^>]*data-icon="chain"[^>]*><\/span>Заменить токен/);
  assert.match(html, /method="post" action="\/connections\/wb"/);
  assert.match(html, /name="storeId" value="store-1"/);
  assert.match(html, /type="password" name="token" autocomplete="off"[^>]*minlength="40" maxlength="4096" required/);
  assert.match(html, /type="button" data-modal="token-help"><span[^>]*data-icon="book"[^>]*><\/span>Инструкция/);
  assert.doesNotMatch(html, /name="token"[^>]*value=/);
});

test('unconnected store opens connection form and explains unavailable catalog', () => {
  const html = accountPage(user, [{ ...store, connected: false }]);
  assert.match(html, /<details class="account-token-details" open>/);
  assert.match(html, /Проверить и подключить/);
  assert.match(html, /Сначала подключите Wildberries/);
  assert.doesNotMatch(html, /action="\/catalog\/sync"|Управлять товарами/);
});

test('missing store leads to onboarding without inventing connected store or credentials', () => {
  const html = accountPage({ display_name: '', email: '' });
  assert.match(html, /Магазинов пока нет/);
  assert.match(html, /href="\/onboarding\/store">Добавить магазин/);
  assert.match(html, /name="displayName" value=""/);
  assert.match(html, /name="displayEmail" type="email" value="" readonly/);
  assert.doesNotMatch(html, /\/connections\/wb|\/catalog\/sync|Подключён|seller@example/);
});

test('catalog pending, running and empty states preserve manual sync and store identity', () => {
  const pending = accountPage(user, [store]);
  assert.match(pending, /Подготавливаем первую загрузку каталога/);
  assert.match(pending, /method="post" action="\/catalog\/sync"/);
  assert.match(pending, /name="storeId" value="store-1"/);
  const running = accountPage(user, [store], { catalog: { products: [], stream: { run_status: 'running' } } });
  assert.match(running, /Загружаем каталог Wildberries/);
  assert.match(running, /type="submit" disabled>Загрузка выполняется/);
  const empty = accountPage(user, [store], { catalog: { products: [], stream: { run_status: 'succeeded' } } });
  assert.match(empty, /В каталоге пока нет товаров/);
  assert.match(empty, /Добавьте товары в Wildberries и обновите каталог/);
  assert.match(empty, />Загрузить каталог<\/button>/);
});

test('catalog failure offers retry and does not expose unknown source errors', () => {
  const html = accountPage(user, [store], { catalog: { stream: { run_status: 'failed', error_code: 'catalog_unauthorized' } } });
  assert.match(html, /Токен больше не даёт доступ к каталогу/);
  assert.match(html, />Загрузить каталог<\/button>/);
  const unknown = accountPage(user, [store], { catalog: { stream: { run_status: 'failed', error_code: '<internal-secret>' } } });
  assert.match(unknown, /Попробуйте запустить загрузку ещё раз/);
  assert.doesNotMatch(unknown, /internal-secret/);
});

test('data navigation preserves all destinations without financial panels or bare text links', () => {
  const html = accountPage(user, [store], { financial: { selection_ready: true }, bankReconciliation: {}, calculation: {}, taxReference: {} });
  for (const path of ['/costs', '/expenses', '/taxes', '/settings/data', '/tariff', '/help']) {
    assert.ok(html.includes(`href="${path}?storeId=store-1"`), path);
  }
  assert.match(html, /Статистика загрузок/);
  for (const match of html.matchAll(/<a\b([^>]*)>/g)) assert.match(match[1], /class="account-button/);
  for (const id of ['store', 'products', 'data', 'account']) assert.ok(html.includes(`id="${id}"`));
  assert.doesNotMatch(html, /financial-sync|bank-reconciliation|calculation-panel|tax-reference|financial-reports\/sync|Незаполненные данные/);
});

test('tariff fallback and Russian limits stay dynamic', () => {
  const fallback = accountPage(user);
  assert.match(fallback, /Бесплатный/);
  assert.match(fallback, /До 3 товаров · 1 магазин/);
  const many = accountPage(user, [], { billing: { current: { name: 'Большой', product_limit: 21, store_limit: 11, status: 'expired' } } });
  assert.match(many, /До 21 товара · 11 магазинов/);
  assert.match(many, /Завершён/);
});

test('settings cards use the selected titles, helper rows and separate API navigation', () => {
  const html = accountPage(user, [store], { catalog });
  assert.match(html, /<h1>Настройки<\/h1>/);
  for (const [symbol, title] of [['storefront', 'Магазин и расчёт'], ['sku', 'Товары для анализа'], ['category', 'Данные для расчёта'], ['download', 'Загрузки по API'], ['lock', 'Аккаунт'], ['crown', 'Тариф']]) {
    assert.ok(html.includes(`data-icon="${symbol}" aria-hidden="true"></span>${title}</h2>`), title);
  }
  assert.match(html, /account-store-label">Магазин Wildberries/);
  assert.match(html, /История загрузок — в разделе «Загрузки по API»/);
  assert.match(html, /Выбранные товары участвуют в расчётах и отчётах\./);
  const dataCard = html.match(/<section id="data"[^>]*>([\s\S]*?)<\/section>/)[1];
  for (const [label, helper, symbol] of [['Себестоимость', 'Проверить заполнение по товарам', 'calculator'], ['Дополнительные расходы', 'Настроить расходы за период', 'notes'], ['Налоги', 'Проверить режим и ставки', 'percentage']]) {
    assert.ok(dataCard.includes(`<span>${label}</span><small>${helper}</small>`));
    assert.ok(dataCard.includes(`data-icon="${symbol}"`));
  }
  assert.doesNotMatch(dataCard, /\/settings\/data|Статистика загрузок/);
  const apiCard = html.match(/<section class="account-section account-api">([\s\S]*?)<\/section>/)[1];
  assert.match(apiCard, /href="\/settings\/data\?storeId=store-1"/);
  assert.match(apiCard, /data-icon="fileDownload"/);
  assert.match(apiCard, /Статистика загрузок<\/span><small>История и статусы загрузок по API/);
  assert.ok(html.indexOf('id="data"') < html.indexOf('account-api'));
  assert.ok(html.indexOf('account-api') < html.indexOf('id="account"'));
  assert.doesNotMatch(html, /ЛИЧНЫЙ КАБИНЕТ|ТАРИФНЫЙ ПЛАН|Сохранить изменения/);
});

test('selection counts use Russian product plurals and preserve the choose action', () => {
  for (const [count, word] of [[0, 'товаров'], [1, 'товар'], [2, 'товара'], [5, 'товаров'], [11, 'товаров'], [14, 'товаров'], [21, 'товар'], [22, 'товара']]) {
    const html = accountPage(user, [store], { catalog: { productLimit: 30, products: Array.from({ length: count }, () => ({ selected: true })).concat({ selected: false }) } });
    assert.ok(html.includes(`Выбрано <span>${count} ${word}</span> · лимит тарифа — 30`));
    assert.ok(html.includes(count ? 'Управлять товарами' : 'Выбрать товары'));
  }
});

test('profile and WB or catalog forms remain separate HTML forms', () => {
  for (const options of [{ catalog }, {}, { catalog: { stream: { run_status: 'running' }, products: [] } }]) {
    const html = accountPage(user, [store], options);
    let depth = 0;
    for (const match of html.matchAll(/<form\b[^>]*>|<\/form>/g)) {
      depth += match[0].startsWith('</') ? -1 : 1;
      assert.ok(depth >= 0 && depth <= 1, 'forms must not nest');
    }
    assert.equal(depth, 0);
    const profileForm = html.match(/<form id="account-form"[^>]*>([\s\S]*?)<\/form>/)[1];
    assert.match(profileForm, /name="displayName"/);
    assert.match(profileForm, /type="submit">Сохранить/);
    assert.doesNotMatch(profileForm, /name="token"|\/catalog\/sync|data-logout/);
  }
});
