const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

function shell({ title, body }) {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · Marketplace Control</title><meta name="description" content="Контроль бизнеса на маркетплейсах"><link rel="stylesheet" href="/styles.css"><link rel="icon" href="/favicon.svg" type="image/svg+xml"></head><body>${body}</body></html>`;
}

function logo() { return `<a class="brand" href="/">MC<span>Marketplace Control</span></a>`; }

export function authPage({ mode = 'login', error = '', values = {} } = {}) {
  const registration = mode === 'register';
  const title = registration ? 'Создать аккаунт' : 'Войти в аккаунт';
  return shell({ title, body: `<main class="auth-layout"><section class="product-panel">${logo()}<div class="product-copy"><p class="eyebrow">Рабочая картина бизнеса</p><h1>Цифры, которым<br>можно доверять.</h1><p>Marketplace Control собирает данные магазина в одном месте и показывает, где бизнес требует внимания.</p></div><div class="signal-card"><span>Сегодня</span><strong>Всё важное — на одном экране</strong><small>Финансы · товары · контроль</small></div></section><section class="form-panel"><div class="form-wrap"><div class="mobile-brand">${logo()}</div><p class="step">${registration ? 'Новый аккаунт' : 'С возвращением'}</p><h2>${title}</h2><p class="lead">${registration ? 'Начните с бесплатного тарифа — банковская карта не нужна.' : 'Продолжите работу с вашими магазинами.'}</p>${error ? `<div class="alert" role="alert">${escapeHtml(error)}</div>` : ''}<form method="post" action="/${registration ? 'register' : 'login'}">${registration ? `<label>Ваше имя<input name="name" autocomplete="name" value="${escapeHtml(values.name)}" minlength="2" maxlength="80" required></label>` : ''}<label>Email<input type="email" name="email" autocomplete="email" value="${escapeHtml(values.email)}" maxlength="254" required></label><label>Пароль<input type="password" name="password" autocomplete="${registration ? 'new-password' : 'current-password'}" minlength="10" maxlength="128" required><span class="hint">${registration ? 'Не менее 10 символов' : ''}</span></label><button type="submit">${registration ? 'Создать аккаунт' : 'Войти'}</button></form><p class="switch">${registration ? 'Уже есть аккаунт? <a href="/login">Войти</a>' : 'Нет аккаунта? <a href="/register">Зарегистрироваться</a>'}</p></div></section></main>` });
}

export function dashboardPage(user) {
  return shell({ title: 'Обзор', body: `<header class="topbar">${logo()}<div class="account"><span>${escapeHtml(user.display_name)}</span><form method="post" action="/logout"><button class="quiet" type="submit">Выйти</button></form></div></header><main class="dashboard"><p class="eyebrow">Обзор</p><h1>Здравствуйте, ${escapeHtml(user.display_name)}!</h1><p class="dashboard-lead">Аккаунт создан. Следующий шаг — подключить магазин Wildberries.</p><section class="welcome-card"><div class="check">✓</div><div><h2>Регистрация завершена</h2><p>Для вашего бизнеса подключён бесплатный тариф: до 3 товаров и 1 магазина.</p></div><button disabled>Подключение магазина — скоро</button></section></main>` });
}
