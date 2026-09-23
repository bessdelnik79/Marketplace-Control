import { overviewPage } from './pages.mjs';
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

function shell({ title, body }) {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · Marketplace Control</title><meta name="description" content="Контроль бизнеса на маркетплейсах"><link rel="stylesheet" href="/styles.css"><link rel="icon" href="/favicon.svg" type="image/svg+xml"></head><body>${body}</body></html>`;
}

function logo() { return `<a class="brand" href="/">MC<span>Marketplace Control</span></a>`; }

export function authPage({ mode = 'login', error = '', values = {}, yandexEnabled = false, captchaKey = '' } = {}) {
  const registration = mode === 'register';
  const title = registration ? 'Создать аккаунт' : 'Войти в аккаунт';
  return shell({ title, body: `<main class="auth-layout"><section class="product-panel">${logo()}<div class="product-copy"><p class="eyebrow">Рабочая картина бизнеса</p><h1>Цифры, которым<br>можно доверять.</h1><p>Marketplace Control собирает данные магазина в одном месте и показывает, где бизнес требует внимания.</p></div><div class="signal-card"><span>Сегодня</span><strong>Всё важное — на одном экране</strong><small>Финансы · товары · контроль</small></div></section><section class="form-panel"><div class="form-wrap"><div class="mobile-brand">${logo()}</div><p class="step">${registration ? 'Новый аккаунт' : 'С возвращением'}</p><h2>${title}</h2><p class="lead">${registration ? 'Начните с бесплатного тарифа — банковская карта не нужна.' : 'Продолжите работу с вашими магазинами.'}</p>${error ? `<div class="alert" role="alert">${escapeHtml(error)}</div>` : ''}${yandexEnabled ? '<a class="oauth" href="/auth/yandex">Продолжить с Яндекс ID</a><div class="divider">или</div>' : ''}<form method="post" action="/${registration ? 'register' : 'login'}">${registration ? `<label>Ваше имя<input name="name" autocomplete="name" value="${escapeHtml(values.name)}" minlength="2" maxlength="80" required></label>` : ''}<label>Email<input type="email" name="email" autocomplete="email" value="${escapeHtml(values.email)}" maxlength="254" required></label><label>Пароль<input type="password" name="password" autocomplete="${registration ? 'new-password' : 'current-password'}" minlength="10" maxlength="128" required><span class="hint">${registration ? 'Не менее 10 символов' : ''}</span></label>${captchaKey ? `<script src="https://smartcaptcha.cloud.yandex.ru/captcha.js" defer></script><div class="smart-captcha" data-sitekey="${escapeHtml(captchaKey)}"></div>` : ''}<button type="submit">${registration ? 'Получить код' : 'Войти'}</button></form><p class="switch">${registration ? 'Уже есть аккаунт? <a href="/login">Войти</a>' : 'Нет аккаунта? <a href="/register">Зарегистрироваться</a>'}</p></div></section></main>` });
}

export function verifyPage({ email, error = '', devCode = '' }) {
  return shell({ title: 'Подтвердите email', body: `<main class="verify"><section><p class="step">Последний шаг</p><h1>Проверьте почту</h1><p class="lead">Мы отправили код на <strong>${escapeHtml(email)}</strong>. Он действует 10 минут.</p>${error ? `<div class="alert" role="alert">${escapeHtml(error)}</div>` : ''}${devCode ? `<div class="dev-code">Локальный код: <strong>${escapeHtml(devCode)}</strong></div>` : ''}<form method="post" action="/verify-email"><input type="hidden" name="email" value="${escapeHtml(email)}"><label>Код подтверждения<input class="code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required autofocus></label><button type="submit">Подтвердить email</button></form><p class="switch"><a href="/register">Изменить данные</a></p></section></main>` });
}

export function dashboardPage(user) {
  return overviewPage(user);
}
