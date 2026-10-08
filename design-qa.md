# Settings internal pages v1 — implementation QA, 2026-10-08

final result: passed

## Current scope and references

Eight internal pages follow the approved four-state references in `outputs/design/Новый дизайн/Настройки/`: calculation inputs (costs, expenses, taxes), analysis products, API loads, tariff, password, account deletion. Main settings v3 is included as a regression surface. This is the existing server-rendered app, not a replacement prototype.

Reference desktop rasters are approximately 1672×941; implementation captures use the requested 1920×1080 CSS viewport. Mobile references are high-density, variable-width raster compositions; implementation uses 390×844 CSS pixels. Compare normalized content proportions and hierarchy, not literal raster pixels. Existing sidebar, Interface/Roboto Condensed font and icon paths are deliberately retained. Live data can change row count and page height.

## Evidence

Thirty-six implementation captures: `work/settings-design-qa/{costs,expenses,taxes,products,settings-data,tariff,password,account-delete,settings}-{pc,mobile}-{light,dark}.png`. Files remain ignored and local. Fixtures invoke actual page renderers without a database and reject all POST requests. Fixtures use explicit example values, not live financial records; missing fixture product images exercise the existing placeholder. This does not claim end-to-end persistence validation.

Sources and implementation screenshots were supplied together in paired visual comparisons: all eight desktop and mobile page types, with focused review of expense grids, tax history, cost/import layout, API status/table, security columns and product warnings. Full reference and implementation states were inspected for hierarchy, wrapping, density, palette, asset reuse and action affordances.

All nine routes at 1920×1080 in both themes: scrollWidth 1920 and scrollHeight 1080 in the baseline states. All mobile routes: document width does not exceed the 390px viewport (375px content width with scrollbar), natural vertical scrolling; no horizontal overflow. Browser console error list empty.

## Iterations and resolutions

1. Cost styles initially leaked to expenses/taxes through a legacy shared class. Every cost selector now has the exact `/costs` body scope; a regression test checks selectors.
2. Removed tax-history minimum table width and added visible field labels for stacked mobile rows.
3. Made the password security note quiet on desktop and restored its card on mobile. Removed the legacy maximum-width restriction from security forms so columns do not leave a central gap.
4. Fixed the expense-note alignment, mobile expense order (list → manual form → import), and stacked the product tariff warning rather than squeezing its text beside a button.
5. API status no longer repeats the metadata table as a long paragraph. Polling updates both status and metadata, preserving errors and retry states.
6. Restored tariff cancellation/replacement semantics by comparing against the saved request rather than effective access. Settings remains active on account/tariff subpages.

## Fidelity and interaction rubric

- Layout/density: desktop cards and split columns, responsive single-column mobile, bounded actions, compact baseline at 1920×1080. Long real tables remain scrollable rather than hiding data.
- Typography/copy: project font retained; generated sample seller/WB identifiers are corrected semantically. Existing important warnings, input/versioning rules and honest incompleteness descriptions retained.
- Color: established theme tokens, blue accents for actions/icons, muted secondary information, amber warnings, green confirmed state and red danger. Outline controls remain distinguishable in both themes.
- Assets: existing logo, SVG icon system and actual catalog image fields; no new external fonts or fabricated product photos.
- Controls: keyboard-operable native inputs, focus styles and theme buttons. Password reveal uses explicit text rather than a new eye asset. File import uses an honest native picker rather than promising unsupported drag/drop.
- Safe checks: theme light/dark/system and persistence, mobile menu open/close, store-context back navigation, password reveal ARIA, tariff save enabling, deletion disabled without confirmation. Server validation and CSRF remain authoritative. No live password change/account deletion or financial write performed.

VM: 704/704 application tests passed, 179 schema checks passed earlier in this pass; independent code review has no blockers. Remaining differences are intentional brand/font/native-control and real-data adaptations, not pixel-perfect claims. Historical blocked browser results below are retained as history and superseded for this scope.

## Historical settings v3 QA

# Settings v3 — implementation QA

final result: blocked

## Current visual target

Source: `outputs/design/Makets/settings-account-pc-dark-v3.png` (user-provided 1799×874), PC light (1798×875), mobile light (783×2009), mobile dark (783×2008). All four images inspected. The three variants were produced with built-in image generation before the implementation pass, as requested. Previous v2 assets are retained.

Implementation: existing `/settings` application route, not a separate prototype. Required comparison viewports: source-sized desktop, 1920×1080 with browser-chrome allowance, and 390 CSS px mobile in both themes. Mobile sources are approximately @2x references; normalize density before comparison. Real account/store/plan data replace mock values intentionally.

## Blocking evidence gap

Browser startup was retried for this v3 request and failed before connecting to any page: `node_repl kernel exited unexpectedly`, `windows sandbox failed: helper_unknown_error: setup refresh had errors`. No browser-rendered implementation screenshot, console inspection, overflow measurements, or combined source/implementation comparison is available. Implementation screenshot path: unavailable. Full-view and focused comparisons: blocked, not performed. No visual QA pass is claimed.

Required fidelity surfaces remain visually unverified: typography and wrapping; card/header spacing and desktop height; light/dark token contrast; brand/icon rendering quality; exact copy and real-data state fit. Source intent is recorded in `outputs/ui-site.md`; automated HTML/client-script tests do not substitute for these checks.

## Non-visual verification

Local targeted account/pages/erasure/theme tests: 100/100 passed. Independent read-only review found no blocking code issues and independently passed 26 account/erasure/theme tests. Full application suite on dedicated VM `marketplacecontrol`, isolated source checkout: 689/689 passed, zero skipped (2026-10-08). Forms, real escaped profile/store/plan values, count plurals, catalog states, route context, separate forms, reset/logout and theme hooks are covered. Backend routes, database schema and financial formulas are unchanged. Graphify AST map updated; SQL extraction remains unavailable in that tool because its optional parser is not installed, unrelated to these frontend changes.

Next verification: capture matching desktop/mobile light/dark states; compare each source and capture together; inspect store, profile, data and tariff regions; exercise theme, menu, token disclosure, help dialog and navigation without mutating account data; verify console and horizontal/vertical overflow. Only change the final result after this evidence exists.

## Historical v2 QA

# Personal account v2 — implementation QA

final result: blocked

## Target and implementation

Target: four approved images in `outputs/design/Makets/settings-account-{pc,mobile}-{light,dark}-v2.png`. Desktop target is 1486×1058; mobile targets are 836×1881/1882, treated as a high-density visual reference rather than a fixed CSS viewport. Planned browser checks: 1486×1058 desktop, 390px mobile, both palettes, plus tablet and narrow-width resilience.

Implemented in the existing server-rendered application, not a separate prototype. Database-backed identity, selected store/products and actual tariff intentionally replace sample content. Additional outlined “Загрузка отчётов” control preserves access to report loading and calculation status on `/settings/data`; no financial formulas changed.

## Evidence and findings

- All four source images opened and inspected before implementation.
- Layout: balanced two-column desktop and ordered mobile stack; central divider; no product-preview list or duplicate appearance panel.
- Typography: existing bundled Interface/Roboto Condensed font reused; heading hierarchy and sentence-case calculation buttons preserved in CSS.
- Colors: existing light/dark palette tokens retained; blue for controls, semantic green connection and red destructive action.
- Assets: existing brand and vector icon system reused, no new generated imagery or external dependencies.
- Copy: requested “ЛИЧНЫЙ КАБИНЕТ”, “ТАРИФНЫЙ ПЛАН”, “Себестоимость товара”, “Дополнительные расходы”, “Налоги”; real profile/limits are escaped, not sample credentials.
- Behavior: targeted regression tests cover profile form, safe token form, counts/limits, catalog states, all three theme modes, OS changes, unavailable localStorage, cancel validation and logout. Two additional tests execute the entire UI script on onboarding and verify mobile-menu ARIA/closing. Independent review checked route authorization, ownership and token secrecy; no remaining blocking findings. Final application suite on dedicated VM: 686/686 passed, zero skipped (2026-10-08).
- Fixed during review: optional menu binding/close handler on onboarding, menu ARIA state, cancel clearing customValidity without reverting global theme.

## Blocking verification

Density follow-up (2026-10-08): desktop account styles at widths ≥1100 CSS px now remove the former 750px column minimum, reduce section spacing, use 40–42px controls and 22px section headings, and leave space for browser chrome on a standard 1920×1080 display. Mobile styling remains unchanged. No zoom/transform, fixed-height clipping or overflow hiding is used. Browser startup was retried and remains blocked; absence of scrolling is a layout target, not yet an empirically verified measurement.

Browser automation failed before connecting to the tab, including after a kernel reset: `windows sandbox failed: helper_unknown_error: setup refresh had errors`. Therefore no implementation screenshots, combined source/implementation comparison, real-browser console or interactive checks were captured. CSS fidelity, mobile wrapping, full onboarding initialization and keyboard flows remain visually unverified. Do not treat this report as a passed visual audit.

Next verification: restore browser tool; capture desktop/mobile in both themes; compare normalized full views and focused header/form/data regions side by side; exercise menu, theme persistence, token disclosure, instruction dialog and navigation without modifying account data; inspect console and overflow. Record findings and only change final result to passed after evidence is available.

---

# Previous design QA history

# Design QA: overview

## Источник

- Светлая тема: `outputs/design/Makets/overview-pc-light.png` (1672 × 941).
- Тёмная тема: `outputs/design/Makets/overview-pc-dark.png` (1672 × 941).
- Реализация: `/overview`, серверный HTML и общие стили `app/frontend/public/ui.css`.

## Проверенная конфигурация

- Desktop: viewport 1672 × 941, DPR 1, светлая и тёмная темы.
- Mobile: viewport 390 × 941; горизонтального переполнения нет (`scrollWidth === clientWidth`).
- Данные: реалистичный локальный fixture того же read-model, который получает `/overview`; финансовый результат частичный, оперативный блок полный, две ситуации доступны.

## Сверка и итерации

1. Первая сверка выявила слишком высокий верхний ряд, повтор причины недоступности правила возвратов и декоративные значения в незавершённых блоках.
2. Финансовый и ситуационный блоки уплотнены, повтор причины удалён, декоративные значения заменены явными пометками «В разработке».
3. Повторные снимки светлой и тёмной тем подтвердили утверждённую структуру: три верхние колонки, общий разделитель и два нижних блока. Цвета, отступы, вертикальные разделители, типографика и состояния соответствуют референсам с учётом реальных динамических данных.

## Поведение

- Переключение «Заказы» / «Выкупы» меняет видимую панель и `aria-selected` без демонстрационных значений.
- Выбор магазина формирует ссылку с `storeId` и сохраняет выбранные `periodStart`/`periodEnd`.
- Недоступные финансовые и оперативные данные показываются как `—` и объяснение, а не как нули.
- Консоль браузера: ошибок и предупреждений нет.

## Результат

passed — открытых расхождений P0, P1 или P2 нет.

---

# Design QA: календарь периода

## Источник и состояние

- Визуальные источники: `C:/Users/BAMSEN~1/AppData/Local/Temp/codex-clipboard-6d988c44-fdd5-4b46-937e-e17dd46fed1f.png` (287 × 80) и `C:/Users/BAMSEN~1/AppData/Local/Temp/codex-clipboard-06df6a3d-2f3d-415a-aef6-0e5b4a1e93e7.png` (302 × 290).
- Поведенческий источник: календарь периода в открытом кабинете WB Seller Analytics, диапазон 19.09.2026–25.09.2026.
- Реализация: локальный `/overview` в Codex IAB, viewport 1265 × 709 CSS px, DPR 1. Снимок реализации отображён в задаче; API браузера не предоставил локальный путь сохранения.
- Состояние: светлая/тёмная тема поддерживаются общими токенами; проверен открытый календарь с выбранным диапазоном.

## Сравнение

- Поле повторяет компактный формат WB: `ДД.ММ.ГГГГ - ДД.ММ.ГГГГ`, иконка календаря справа.
- Открытая панель повторяет структуру WB: месяц с навигацией, сетка ПН–ВС, непрерывная подсветка диапазона, быстрые интервалы, начало/конец, сброс и применение.
- Типографика использует существующий шрифт продукта; интервалы, границы, радиусы и цвета взяты из текущих токенов Marketplace Control, чтобы календарь не выглядел чужим компонентом.
- Изображений и растровых ассетов в источнике нет; используется существующая иконка календаря продукта.

## Поведение и история проверки

1. Первый браузерный проход выявил, что панель закрывалась после первого клика: перерисованный day-button переставал считаться потомком picker в document click handler.
2. Закрытие переведено на проверку `event.composedPath()`. Повторный проход подтвердил: клик 14.09 задаёт начало, клик 18.09 — конец, кнопка «Применить» активируется.
3. Переход на предыдущий месяц показал август 2026, обратная навигация доступна.
4. «Применить» сформировал серверный URL `periodStart=2026-09-14&periodEnd=2026-09-18` вместе с `storeId`.
5. Горизонтальная компоновка не ломает основной экран; на мобильном breakpoint панель переходит в одну колонку. Консольных ошибок при проверке нет.
6. Повторная проверка доступности подтвердила перенос фокуса на начало выбранного диапазона, `aria-pressed` для всех выделенных дней, доступные подписи начала/конца и возврат фокуса на кнопку по `Escape`.

## Итог

final result: passed

## Исправление переполнения и сохранения периода

- По снимку `codex-clipboard-7ab3ebb8-a742-415f-a77a-71656117dad0.png` правая колонка календаря выходила за границу панели. Панель увеличена до 580 px, колонка управления получила гарантированные 220 px.
- Браузерная проверка при viewport 1280 px: панель 580 px, блок действий 220 px, внутреннее переполнение блока действий — 0 px; обе кнопки находятся внутри рамки.
- Период хранится отдельно для аккаунта и магазина, а последний выбранный магазин — отдельно для аккаунта. Проверен переход со вторым магазином `Обзор → Настройки → Обзор`: URL восстановлен с теми же `storeId`, `periodStart` и `periodEnd`.
- Для viewport до 900 px панель становится фиксированной одноколоночной и ограничивается границами экрана; desktop-компоновка 580 px остаётся только там, где она помещается целиком.

final result: passed

---

# Design QA: детализация финансового результата

## Источник и состояние

- Визуальный источник: `C:/Users/BAMSEN~1/AppData/Local/Temp/codex-clipboard-2f5f3a56-e9a5-4afa-b133-185e9f003b8b.png` (270 × 187 px), тёмная тема, финансовая карточка с фактическими суммами.
- Реализация: локальный `/overview` в Codex IAB, вкладка 9; браузерный снимок показан в этой задаче, API браузера не предоставил локальный путь сохранения.
- Desktop evidence: viewport и снимок 1265 × 709 CSS px, DPR 1, тёмная тема, период 17–23.08.2026.
- Mobile evidence: viewport и снимок 390 × 844 CSS px, DPR 1. DOM-проверка: ширина карточки 335 px, каждая строка имеет `scrollWidth = 335`, горизонтального переполнения нет.
- Нормализация: сравнивался финансовый фрагмент реализации с исходным crop; browser chrome и соседние модули в оценку карточки не включались.

## Сверка

- Типографика: сохранены семейство, размеры, веса и иерархия существующей карточки; четыре подписи и суммы читаются без обрезки.
- Отступы и ритм: существующий вертикальный шаг строк сохранён; колонка подписей расширена до 140 px на desktop и 118 px на mobile, поэтому «Себестоимость» не переносится и не сталкивается с суммой.
- Цвета и токены: используются прежние `--text`, `--muted`, `--accent`, `--border` и фон тёмной темы без новых несогласованных цветов.
- Изображения и ассеты: в изменяемом фрагменте изображений нет; существующие иконки и оформление страницы не менялись.
- Текст и содержание: карточка показывает «Выручка», «Расходы WB», «Себестоимость», «Налог»; компенсация лояльности не отображается в выручке и уменьшает расходы WB. Итог после налога не изменён.
- Focused region: отдельно проверены четыре строки финансового `dl` и их фактические размеры; дополнительный crop не нужен, потому что все подписи и суммы полностью читаются на полном desktop-снимке и подтверждены DOM-замерами на mobile.
- Консоль браузера: ошибок и предупреждений нет.

## История проверки

1. До изменения карточка объединяла себестоимость с расходами и относила компенсацию лояльности к выручке.
2. После изменения раскладка разделена на четыре строки, а положительная компенсация уменьшает «Расходы WB».
3. Повторная desktop- и mobile-проверка не выявила P0, P1 или P2 расхождений; переполнения и наложения текста нет.

final result: passed

---

# Design QA: страница ситуации, 6 октября 2026

## Источник и evidence

- Четыре принятых источника: `outputs/design/Makets/situation-detail-{pc,mobile}-{light,dark}.png`. Desktop raster: 1487×1058 / 1492×1054; mobile raster: 740×2125.
- Реализация: существующий renderer `/situation`, `app/frontend/situation-detail.mjs`, scoped `sku.css`; общая навигация и тема приложения сохранены.
- Browser: Codex IAB; PC 1488×1058 CSS px, mobile 390×844 CSS px. Скриншоты DPR 1. Mobile source нормализован до 390 px по ширине; desktop source/implementation — до 744 px для парной сверки.
- Рабочие снимки: `work/design-audit/situation-2026-10-06/09-final-preview-pc-dark.png`, `10-final-preview-pc-light.png`, `11-final-preview-mobile-light.png`, `12-final-preview-mobile-dark.png`. Сопоставления target/implementation в одном входном изображении: `comparison-{pc,mobile}-{light,dark}.png`. Каталог игнорируется Git, не является публичной выгрузкой.
- Layout fixture использует существующий renderer с опубликованными значениями согласованного примера; фото взято из URL каталога, подтверждённого DOM рабочей страницы. Fixture не заменяет приложение и не используется в production. Поведение данных/HTTP отдельно проверено PostgreSQL acceptance на VM.
- Состояние: выручка раскрыта, остальные группы и техническое disclosure закрыты. На мобильном full-page снимке фиксированная нижняя навигация находится на нижней границе viewport, а не всей страницы; это артефакт полноразмерного снимка прокручиваемой страницы.

## Сверка и итерации

1. Первая реализация была слишком высокой: большие отступы hero и строк продаж. Сокращены vertical rhythm, summary и строки desktop; мобильная детализация стала двухколоночной (дата/сумма, количество/ссылка).
2. Удалены повторные ссылки полного preview; все группы остаются доступны в технических данных. При продолжении источников ссылка остаётся рядом с пояснением неполноты.
3. Повторная парная сверка всех четырёх состояний: герой, состав результата, native disclosures и переходы соответствуют принятой иерархии. На mobile горизонтального переполнения нет (`documentElement.scrollWidth === clientWidth`).
4. Отличия от растра намеренные: сохраняется общая навигация/шрифт/иконки приложения; «Продано с выручкой» точнее макетного «Продано», даты названы без сокращений, счётчик заказов остаётся `—`. Нет ложного количества, выдуманных источников или декоративных данных. Дополнительные расходы появляются при наличии реальных метрик.

## Рубрика

- Типографика: существующее семейство Interface/системный fallback, иерархия заголовок → красная сумма → причина → состав. Длинные суммы и названия допускают перенос без обрезки.
- Цвета/токены: `--text`, `--muted`, `--accent`, `--danger`, `--surface`, `--border`; мягкий розовый/plum hero в соответствующей теме. Новых палитр нет.
- Layout/density: desktop двухколоночный hero и табличные продажи; mobile одноколоночный hero и компактные строки. Нижняя кнопка на mobile на всю ширину; технические сведения не конкурируют с причиной убытка.
- Ассеты: существующий бренд, проектная система иконок, фактическое фото каталога; нативные markers вместо нарисованных замен.
- Copy/data: сохранённые деньги с точным decimal форматированием, явные отсутствующие заказы, quantity по доказанным источникам; условия правила и неполнота доступны в disclosure.
- Focused region: отдельно проверены мобильные summary/суммы и строки продаж — не пересекаются и не выходят за контейнер.
- Интеракции: native раскрытие выручки/расходов/себестоимости/технических данных; ссылки источников сохраняют frozen context и anchor. PostgreSQL/HTTP acceptance проверяет все группы и целевой anchor, чужие группы не доступны.

final result: passed — открытых блокирующих визуальных расхождений нет. Live deployment проверяется после push; fixture не выдаётся за браузерную проверку production.
