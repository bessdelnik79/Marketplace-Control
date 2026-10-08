const catalogErrors = {
  catalog_unauthorized: 'Токен больше не даёт доступ к каталогу. Подключите его заново.',
  catalog_rate_limited: 'Wildberries временно ограничил загрузку. Повторите через несколько минут.',
  catalog_unavailable: 'Каталог Wildberries временно недоступен.',
  catalog_invalid_response: 'Wildberries вернул каталог в неожиданном формате.',
  catalog_too_large: 'Каталог слишком большой для одной загрузки.',
  catalog_interrupted: 'Предыдущая загрузка была прервана перезапуском приложения.',
  catalog_internal_error: 'Не удалось обработать каталог.',
};

function plural(value, forms) {
  const number = Math.abs(Number(value));
  return forms[number % 100 >= 11 && number % 100 <= 14 ? 2 : number % 10 === 1 ? 0 : number % 10 >= 2 && number % 10 <= 4 ? 1 : 2];
}

export function createAccountPage({ frame, esc, icon, storeHref }) {
  return function accountPage(user, stores = [], { notice = '', error = '', billing = null, catalog = null } = {}) {
    const store = stores[0];
    const plan = billing?.current ?? { name: 'Бесплатный', product_limit: 3, store_limit: 1, status: 'active' };
    const limit = catalog?.productLimit ?? plan.product_limit ?? 3;
    const planLimit = plan.product_limit ?? 3;
    const storeLimit = plan.store_limit ?? 1;
    const selectedCount = (catalog?.products ?? []).filter(product => product.selected).length;
    const href = path => esc(storeHref(path, store?.id));
    const feedback = `${notice ? `<div class="settings-feedback success" role="status">${esc(notice)}</div>` : ''}${error ? `<div class="settings-feedback error" role="alert">${esc(error)}</div>` : ''}`;
    const tokenForm = store ? `<form class="account-token-form" method="post" action="/connections/wb"><input type="hidden" name="storeId" value="${esc(store.id)}"><label for="wb-token">${store.connected ? 'Новый API-токен' : 'API-токен'}<input id="wb-token" type="password" name="token" autocomplete="off" placeholder="Вставьте токен Wildberries" minlength="40" maxlength="4096" required></label><button class="account-button account-primary" type="submit">${store.connected ? 'Проверить и заменить' : 'Проверить и подключить'}</button></form>` : '';
    const storePanel = store ? `<div class="account-store"><span class="account-store-icon">${icon('stock')}</span><div class="account-store-copy"><p class="account-store-label">Магазин Wildberries</p><div class="account-store-heading"><strong>${esc(store.name)}</strong><span class="account-connection ${store.connected ? 'positive' : 'muted'}"><i aria-hidden="true"></i>${store.connected ? 'Подключён' : 'Не подключён'}</span></div><p class="muted">История загрузок — в разделе «Загрузки по API»</p>${store.connected ? '' : '<p class="muted">Нужен токен только для чтения: Контент, Аналитика, Статистика и Финансы.</p>'}</div></div><div class="account-token-controls"><details class="account-token-details"${store.connected ? '' : ' open'}><summary class="account-button">${icon('chain')}${store.connected ? '<span class="account-token-show">Заменить токен</span><span class="account-token-cancel">Отмена</span>' : 'Подключить Wildberries'}</summary>${tokenForm}</details><button class="account-button account-token-help" type="button" data-modal="token-help">${icon('book')}Инструкция</button></div>` : `<div class="account-empty"><strong>Магазинов пока нет</strong><p class="muted">Добавьте магазин, чтобы подключить Wildberries.</p><a class="account-button account-primary" href="/onboarding/store">Добавить магазин</a></div>`;

    let products = '<p class="muted">Сначала добавьте магазин.</p>';
    if (store && !store.connected) {
      products = '<p class="muted">Сначала подключите Wildberries. После подключения здесь появится каталог товаров.</p>';
    } else if (store && catalog?.products?.length) {
      products = `<a class="account-button account-products-manage" href="${href('/products')}">${icon('list')}${selectedCount ? 'Управлять товарами' : 'Выбрать товары'}</a>`;
    } else if (store) {
      const running = catalog?.stream?.run_status === 'running';
      const failed = catalog?.stream?.run_status === 'failed';
      const ready = catalog?.stream?.run_status === 'succeeded';
      products = `<div class="account-catalog-state"><strong>${running ? 'Загружаем каталог Wildberries' : failed ? 'Каталог пока не загружен' : ready ? 'В каталоге пока нет товаров' : 'Подготавливаем первую загрузку каталога'}</strong><p class="muted">${failed ? esc(catalogErrors[catalog.stream.error_code] || 'Попробуйте запустить загрузку ещё раз.') : ready ? 'Добавьте товары в Wildberries и обновите каталог.' : 'Страница обновится после получения товаров.'}</p><form method="post" action="/catalog/sync"><input type="hidden" name="storeId" value="${esc(store.id)}"><button class="account-button" type="submit"${running ? ' disabled' : ''}>${running ? 'Загрузка выполняется' : 'Загрузить каталог'}</button></form></div>`;
    }

    const dataLink = (path, label, helper, symbol) => `<a class="account-button account-data-link" href="${href(path)}">${icon(symbol)}<span class="account-data-copy"><span>${label}</span><small>${helper}</small></span>${icon('right')}</a>`;
    const dataLinks = [
      ['/costs', 'Себестоимость', 'Проверить заполнение по товарам', 'calculator'],
      ['/expenses', 'Дополнительные расходы', 'Настроить расходы за период', 'notes'],
      ['/taxes', 'Налоги', 'Проверить режим и ставки', 'percentage'],
    ].map(args => dataLink(...args)).join('');
    const planStatus = plan.status === 'past_due' ? '<p class="account-plan-status">Требует оплаты</p>' : plan.status && plan.status !== 'active' ? '<p class="account-plan-status muted">Завершён</p>' : '';

    return frame({ ...user, stores }, '/settings', `<div class="account-page"><h1>Настройки</h1>${feedback}<div class="account-columns">
      <div class="account-business">
        <section id="store" class="account-section"><h2>${icon('storefront')}Магазин и расчёт</h2>${storePanel}</section>
        <section id="products" class="account-section"><div class="account-section-heading"><h2>${icon('sku')}Товары для анализа</h2><span class="account-product-count">Выбрано <span>${esc(selectedCount)} ${plural(selectedCount, ['товар', 'товара', 'товаров'])}</span> · лимит тарифа — ${esc(limit)}</span></div><p class="muted account-products-note">Выбранные товары участвуют в расчётах и отчётах.</p>${products}</section>
        <section id="data" class="account-section account-data"><h2>${icon('category')}Данные для расчёта</h2><div class="account-data-links">${dataLinks}</div></section>
        <section class="account-section account-api"><h2>${icon('download')}Загрузки по API</h2>${dataLink('/settings/data', 'Статистика загрузок', 'История и статусы загрузок по API', 'fileDownload')}</section>
      </div>
      <div class="account-personal">
        <form id="account-form" class="account-profile-form account-section" method="post" action="/account/profile"><section id="account" class="account-profile"><div class="account-profile-heading"><h2>${icon('lock')}Аккаунт</h2><a class="account-button account-password" href="${href('/password')}">${icon('lock')}Изменить пароль</a></div><label class="account-name-field" for="account-name">Имя<input id="account-name" name="displayName" value="${esc(user.display_name || '')}" required minlength="2" maxlength="80" autocomplete="name"></label><label class="account-email-field" for="account-email">Email<input id="account-email" name="displayEmail" type="email" value="${esc(user.email || '')}" readonly aria-readonly="true" aria-describedby="account-email-note" autocomplete="email"><small id="account-email-note">Email нельзя изменить.</small></label></section><div class="account-save"><button class="account-button account-primary" type="submit">Сохранить</button><button class="account-button" type="button" data-reset-settings>Отменить</button></div></form>
        <section class="account-section account-plan-section"><h2>${icon('crown')}Тариф</h2><div class="account-plan-row"><div><strong class="account-plan-name">${esc(plan.name)}</strong><p class="muted">До ${esc(planLimit)} ${plural(planLimit, ['товара', 'товаров', 'товаров'])} · ${esc(storeLimit)} ${plural(storeLimit, ['магазин', 'магазина', 'магазинов'])}</p>${planStatus}</div><a class="account-button" href="${href('/tariff')}">${icon('crown')}Сменить тариф</a></div></section>
        <footer class="account-session"><button class="account-button account-session-row" type="button" data-logout>${icon('logout')}<span>Выйти из аккаунта</span>${icon('right')}</button><div class="account-delete-group"><a class="account-button account-session-row account-delete" href="/account/delete">${icon('trash')}<span>Удалить аккаунт</span>${icon('right')}</a><p class="muted account-delete-note">Необратимое действие. Все данные будут удалены.</p></div><a class="account-button account-mobile-help" href="${href('/help')}">${icon('help')}Помощь</a></footer>
      </div>
    </div></div>`, stores);
  };
}
