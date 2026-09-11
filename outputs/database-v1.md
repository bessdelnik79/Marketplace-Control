# Marketplace Control — первая итерация базы данных

11 сентября 2026 года. Созданы миграция PostgreSQL, проверки и словарь полей. Рабочий сервер БД, интерфейс, интеграция WB и приём платежей не запускались.

## Что входит

**47 таблиц и 3 представления** охватывают первый MVP: пользователей, магазины, каталог и варианты, тарифы, подтверждённый выбор товаров, импорт себестоимости и продвижения, недельные отчёты, финансовые операции, версии расчётов и служебные задания.

- [Полный словарь таблиц, полей, допустимых значений и связей](database-v1-dictionary.md).
- [SQL-миграция](../db/migrations/001_initial.sql).
- [Применение, доступ и ограничения](../db/README.md).

## Пользовательский сценарий

```mermaid
flowchart LR
    U[Регистрация] --> F[Бесплатный тариф]
    F --> S[Подключение магазина]
    S --> C[Первый полный каталог WB]
    C --> P[Селлер выбирает товары]
    P --> LOCK[Подтверждённый неизменяемый набор]
    LOCK --> V[Себестоимость каждого варианта]
    LOCK --> E[Продвижение по артикулу]
    LOCK --> R[Недельные отчёты]
    V --> CALC[Результат выбранных товаров]
    E --> CALC
    R --> CALC
```

Товар сопоставляется по числовому артикулу WB в магазине, отображается под артикулом продавца. Варианты сохраняют размер/цвет и отдельную стоимость. Магазин подставляется в импорт из контекста; его ID не нужен в файле.

## Доступ, тарифы и закрепление товаров

```mermaid
erDiagram
    users ||--o{ auth_identities : login
    users ||--o{ memberships : participates
    businesses ||--o{ memberships : access
    businesses ||--|| subscriptions : current
    billing_plans ||--|{ billing_plan_versions : conditions
    billing_plan_versions ||--o{ subscriptions : grants
    subscriptions ||--o{ subscription_events : history
    businesses ||--o{ stores : owns
    stores ||--o{ connections : connects
    stores ||--o| product_selections : confirms_once
    billing_plan_versions ||--o{ product_selections : fixes_limit
    product_selections ||--|{ product_selection_items : retains
    products ||--o| product_selection_items : selected
    stores ||--o{ products : catalog
    products ||--o{ variants : sizes_colors
    variants ||--o{ variant_identifiers : identifies
```

| Тариф | Товаров на бизнес | Магазинов | Цена |
|---|---:|---:|---|
| Бесплатный | 3 | 1 | 0 ₽ |
| Минимальный | 10 | 1 | Не задана |
| Плюс | 100 | 2 | Не задана |
| Про | 1 000 | 2 | Не задана |

Количество тарифов и их лимиты — данные, а не фиксированный перечень в программном коде. Разделения функций по тарифам нет. Изменение условий создаёт новую версию.

Один артикул с десятью размерами занимает одно место. Лимит суммарный между магазинами. Выбор пользователя проходит атомарно; при ошибке не остаётся части набора. Повторный вход, импорт или восстановление подключения не сбрасывают его.

Отдельная таблица `product_access` пока не нужна: сохранённые `product_selection_items` вместе с активной подпиской определяют доступ через представления. Это исключает два противоречащих друг другу списка выбранных и разрешённых товаров.

## Импорт и пользовательские затраты

```mermaid
erDiagram
    source_documents ||--o{ import_batches : file
    import_batches ||--o{ import_rows : rows
    product_selection_items ||--o{ variant_costs : allows
    variants ||--o{ variant_costs : effective_dates
    variant_costs ||--o{ cost_versions : history
    import_rows o|--o| cost_versions : imports
    product_selection_items ||--o{ expenses : allows
    expenses ||--o{ expense_versions : history
    import_rows o|--o| expense_versions : imports
    users ||--o{ cost_versions : changes
    users ||--o{ expense_versions : changes
```

Себестоимость действует с заданной даты до следующей даты стоимости этого варианта. Исправление суммы сохраняет старую версию. Отсутствие стоимости не равно нулю.

Продвижение сохраняется одной суммой на артикул за период. Оно не копируется на каждый размер. Признание расхода поддерживает отдельную дату либо равномерное распределение по периоду; метод выбирается явно. Автоматическое распределение между товарами в этой итерации отсутствует.

## Источники и финансовые операции

```mermaid
erDiagram
    stores ||--o{ sync_streams : sources
    sync_streams ||--o{ sync_runs : attempts
    sync_runs o|--o{ source_documents : receives
    source_documents ||--o{ source_objects : files
    sync_streams ||--o{ coverage_intervals : coverage
    source_documents ||--o{ data_issues : problems
    stores ||--o{ reports : owns
    reports ||--o{ report_versions : revisions
    source_documents ||--o{ report_versions : supplies
    report_versions ||--o{ report_rows : rows
    report_rows ||--o{ operation_versions : normalizes
    operations ||--|{ operation_versions : revisions
    operation_versions ||--o{ financial_components : amounts
    financial_categories ||--o{ financial_components : category
    method_versions ||--o{ financial_components : interprets
```

Исходные файлы находятся в объектном хранилище, в БД — постоянные ключи объектов и контрольные суммы. Фактическое хранилище ещё не подключено.

Недельный отчёт хранится версиями. Повтор содержимого и строк не создаёт второй расход. `srid` не уникален: он предназначен для связи операций, а не удаления дублей.

Полный отчёт может включать другие товары и общие расходы магазина. Они сохраняются как исходные данные для сверки, но не выдаются как аналитика неподключённых товаров и не приписываются выбранным без связи. Итог называется **«Результат выбранных товаров»**, не результатом всего магазина.

## Расчёт и происхождение каждой суммы

```mermaid
erDiagram
    product_selections ||--o{ calculation_runs : scope
    method_versions ||--o{ calculation_runs : method
    calculation_runs ||--o{ calculation_inputs : versions
    report_versions o|--o{ calculation_inputs : source
    cost_versions o|--o{ calculation_inputs : source
    expense_versions o|--o{ calculation_inputs : source
    calculation_runs ||--o{ result_lines : calculates
    result_lines ||--o{ result_evidence : explains
    financial_components o|--o{ result_evidence : contribution
    cost_versions o|--o{ result_evidence : contribution
    expense_versions o|--o{ result_evidence : contribution
    calculation_runs ||--o{ reconciliation_checks : validates
    calculation_runs ||--o| publications : publishes
```

Каждая строка результата связана с подтверждающими суммами. Завершить расчёт нельзя, если расшифровка не сходится, расход задвоен, использована стоимость другого варианта или источник отсутствует среди входов расчёта.

В одном расчёте нельзя смешать две версии одного отчёта. Выплаты от площадки не становятся строками прибыли. Итог строится по учётным датам операций, включая недели на границе месяцев.

Первый вариант публикации — полный пересчёт загруженной истории магазина. Новая публикация переключается в транзакции. Успешный расчёт неизменяем; корректировки создают новый. Частичные пересчёты и отдельные таблицы агрегатов добавляются при необходимости.

## Платежи и фоновые процессы

```mermaid
erDiagram
    subscriptions ||--o{ billing_invoices : invoices
    billing_invoices ||--o{ billing_payments : attempts
    billing_payments o|--o{ billing_payment_events : provider_events
    businesses ||--o{ jobs : schedules
    stores o|--o{ jobs : executes
    businesses ||--o{ audit_events : records
```

Уникальные ключи защищают от повторных платежных событий и одновременного создания одинаковых заданий. Сами платежи и воркер не реализованы. Секреты не хранятся в открытом виде и не включаются в аудит.

## Расширение проекта

| Будущий модуль | Точки подключения к текущей БД |
|---|---|
| Заказы, выкупы, возвраты | `stores`, `products`, `variants`, `operations`, `source_documents` |
| Рекламные кампании и статистика | `products`, `expenses`, `financial_components`, `source_documents` |
| Остатки, склады и поставки | `variants`, `source_documents`; оценка через `cost_versions` |
| Капитал | Оценка запасов и `calculation_runs` |
| Региональная аналитика | Подтверждённые связи заказов/операций; отдельные региональные измерения |
| Налоги | Настройки уровня `businesses`, версии методики и входы из магазинов |
| Ситуации и контрольные точки | `products`, `calculation_runs`, будущие оперативные данные |
| Возвраты платежей и развитие подписок | `billing_payments`, `subscription_events` |

Эти модули пока не создают пустые таблицы. Расширение идёт новыми миграциями, с типизированными связями и версионными входами. Не требуется заменять финансовый реестр универсальной JSON-таблицей или разделять MVP на микросервисы.

## Проверки и границы готовности

Пройдено **55 проверок** на PostgreSQL 17.5 внутри PGlite: применение схемы; тарифы и лимиты; сохранение выбранного набора; связи бизнеса/магазина/варианта; история стоимости; дубли отчётов и расходов; расшифровка; изоляция RLS под ролью, не являющейся владельцем; закрытие представлений при окончании подписки.

На постоянном сервере миграция пока не применена. Нагрузочные и конкурентные проверки нескольких соединений не выполнялись. Словарь полей сформирован из реально применённой тестовой схемы.

Открытые решения сохранены явно:

- цены платных тарифов и платёжный провайдер;
- правила добора товаров после повышения тарифа и снижения лимита;
- действия после окончания подписки;
- проверка идентификаторов вариантов и исправлений отчётов WB;
- финансовая методика, себестоимость возвратов и полнота затрат.

В этой итерации повторный выбор и добор после подтверждения заблокированы. Понижение ниже сохранённого набора также заблокировано. Данные не удаляются. Эти ограничения не подменяют согласование дальнейших продуктовых правил.
