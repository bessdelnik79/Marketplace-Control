# Marketplace Control — первая итерация базы данных

Актуально на 21 сентября 2026 года. Исходная модель развивается последовательными миграциями; актуальное приложение, PostgreSQL и интеграция WB работают на выделенной VM без Docker.

Миграции `001`–`012` покрывают исходную схему, аутентификацию, подключения и синхронизации WB, выбор товаров, финансовые отчёты, себестоимость, дополнительные расходы, налоговые настройки и воспроизводимый расчёт P0.3. Локальная PGlite-проверка дополняет, но не заменяет итоговый прогон на VM.

## Что входит

**65 таблиц и 3 представления** охватывают первый MVP: пользователей, подтверждение регистрации, лимиты и сессии, магазины, каталог и варианты, тарифы, подтверждённый выбор товаров, импорт себестоимости и расходов, налоговые настройки, недельные отчёты, версионные нормализации, финансовые операции, durable invalidations, поколения и попытки расчётов, налоговые доказательства и служебные задания.

- [Полный словарь таблиц, полей, допустимых значений и связей](database-v1-dictionary.md).
- [Исходная SQL-миграция](../db/migrations/001_initial.sql), [налоги/дополнительные расходы](../db/migrations/011_user_financial_inputs.sql) и [воспроизводимый расчёт P0.3](../db/migrations/012_financial_calculation.sql).
- [Применение, доступ и ограничения](../db/README.md).

## Пользовательский сценарий

```mermaid
flowchart LR
    U[Регистрация] --> F[Бесплатный тариф]
    F --> S[Подключение магазина]
    S --> C[Первый полный каталог WB]
    C --> P[Селлер выбирает товары]
    P --> LOCK[Подтверждённый набор: разрешён только добор]
    LOCK --> V[Себестоимость каждого варианта]
    LOCK --> E[Дополнительные расходы товара или магазина]
    F --> T[Версионные налоговые настройки бизнеса]
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

Общий дополнительный расход хранится без `product_id`; связанный расход обязан ссылаться на выбранный товар того же магазина. Налоговые настройки действуют на уровне бизнеса и версионируются по дате начала. Режим и НДС являются независимыми параметрами: отсутствие настройки или неподдерживаемая методика не означает нулевой налог.

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
    report_versions ||--o{ report_normalizations : interprets
    report_normalizations ||--o{ operation_versions : normalizes
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
    product_selections ||--o{ calculation_requests : scope
    calculation_requests ||--o{ calculation_runs : attempts
    method_versions ||--o{ calculation_runs : method
    calculation_runs ||--o{ calculation_inputs : versions
    report_normalizations o|--o{ calculation_inputs : source
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

Каждое поколение закрепляет fingerprint, snapshot выбранных товаров и точные версии нормализаций, себестоимости, расходов и налоговых настроек. Каждая строка результата связана с подтверждающими суммами. Завершить расчёт нельзя, если расшифровка не сходится, расход задвоен, использована стоимость другого варианта или источник отсутствует среди входов расчёта.

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

Пройдено **98 проверок** на PostgreSQL 17.5 внутри PGlite: применение всех миграций; тарифы и лимиты; выбранный набор; связи бизнеса/магазина/варианта; версии стоимости, расходов и налоговых настроек; durable invalidation; версионная нормализация; frozen snapshot расчёта; доказательство количества для себестоимости; дубли отчётов; расшифровка; аудит; FORCE RLS и изоляция арендаторов; закрытие представлений при окончании подписки.

Итог каждой поставки применяется и проверяется на выделенной VM. Локальная проверка не заменяет конкурентные и сквозные сценарии на целевом PostgreSQL. Словарь полей формируется из реально применённой тестовой схемы.

Открытые решения сохранены явно:

- цены платных тарифов и платёжный провайдер;
- правила добора товаров после повышения тарифа и снижения лимита;
- действия после окончания подписки;
- проверка идентификаторов вариантов и исправлений отчётов WB;
- бухгалтерское подтверждение матрицы удержаний WB и налоговой базы;
- доказуемая связь возврата с исходной продажей и полнота внешних затрат.

После подтверждения набора разрешён контролируемый добор товаров в пределах актуального тарифа. Прежние позиции нельзя удалить или заменить, а понижение тарифа ниже сохранённого набора заблокировано. Данные не удаляются.
