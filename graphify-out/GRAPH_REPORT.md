# Graph Report - Marketplace Control  (2026-10-04)

## Corpus Check
- 256 files · ~1,067,981 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 13 file(s) not represented in the graph (top: .toml 4, (none) 4, .css 2)

## Summary
- 1730 nodes · 3643 edges · 110 communities (84 shown, 26 thin omitted)
- Extraction: 97% EXTRACTED · 3% INFERRED · 0% AMBIGUOUS · INFERRED: 113 edges (avg confidence: 0.87)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `5ff81dda`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- server.mjs
- createCostsRepository
- build-editable.mjs
- Marketplace Control — словарь БД, итерация 1
- pages.mjs
- ref_node_test
- Концепция продукта — Marketplace Control
- calculation.mjs
- financial-pipeline.repository.mjs
- importMarketplaceControl
- importMarketplaceControl
- reports.repository.mjs
- importMarketplaceControl
- db/package.json
- figma-import/manifest.json
- figma-update/manifest.json
- mcImportV2
- costs.import.mjs
- server
- mcImportV2
- container-entrypoint.sh
- Концепция продукта — Marketplace Control
- What You Must Do When Invoked
- client.mjs
- Уже сделано
- Marketplace Control — формулы финансового расчёта
- Marketplace Control — план P0.3
- financial-overview.mjs
- catalog.repository.mjs
- operational-sync.mjs
- financial-pipeline-worker.mjs
- financial-formulas.md
- Marketplace Control: инструкции агентам
- daily-generation-worker.mjs
- Рабочие части
- db.mjs
- Marketplace Control — первая итерация базы данных
- Marketplace Control — финансовые отчёты Wildberries
- calculation.repository.mjs
- graphify reference: extra exports and benchmark
- Design QA: overview
- jobs.integration.mjs
- ui.js
- База данных
- Налоги и дополнительные расходы P0.2
- Редактируемый макет Marketplace Control
- Marketplace Control
- finance.mjs
- graphify reference: add a URL and watch a folder
- graphify reference: commit hook and native CLAUDE.md integration
- graphify reference: incremental update and cluster-only
- Подключение Wildberries API
- expenses.repository.mjs
- graphify reference: GitHub clone and cross-repo merge
- graphify reference: transcribe video and audio
- Настройки аккаунта — PC, тёмная тема v4
- Настройки аккаунта — PC, светлая тема, черновик v1
- Настройки аккаунта — визуальный черновик v2
- Настройки аккаунта — черновик v3
- Настройки аккаунта — черновик v4
- extraction-spec.md
- SCRIPTER-RECOVERY.md
- onboarding-flow.md
- p02-app.integration.mjs
- ref_node_assert
- README.md
- historical-relink.integration.mjs
- recoverHistoricalCatalog
- withOwnedBusinessContext
- credentials.integration.mjs
- unavailable
- financial-coverage.mjs
- Marketplace Control — план событийной загрузки и пересчёта финансов
- wb-sales-funnel.mjs
- bank-reconciliation.mjs
- schema.test.mjs
- financial-sync.routes.test.mjs
- graphify reference: query, path, explain
- Порядок реализации
- P0.4 — контракт оперативных заказов и выкупов WB
- Рабочие части
- Целевая цепочка
- 11. Сверки и доказательства
- Принятые продуктовые решения
- operational-source-storage.mjs
- source-storage.mjs
- app_db_beginfinancialsync
- app_db_completefinancialsync
- { enqueueJob, claimJobs, heartbeatJob, completeJob, failJob }
- app_db_failfinancialsync
- app_db_getfinancialcalculationinvalidation
- app_db_reservefinancialrequestslot
- app_db_updatefinancialsyncprogress
- Изменения финансового расчёта, каталога и интерфейса за 3–4 октября 2026 года
- createTaxesRoutes
- ref_node_fs
- createFinancialInventoryRepository
- full-report-credit.mjs
- Сверка реальных отчётов WB API для P0.3
- variant-size-relink.integration.mjs
- createJobsRepository
- p04-operational.integration.mjs
- costs.integration.mjs
- ref_node_crypto
- Граница этапа
- financial-scheduler.mjs
- p03-app.integration.mjs

## God Nodes (most connected - your core abstractions)
1. `Marketplace Control — словарь БД, итерация 1` - 97 edges
2. `server` - 63 edges
3. `withOwnedBusinessContext()` - 54 edges
4. `calculateFinancialResult()` - 31 edges
5. `esc()` - 29 edges
6. `Marketplace Control — формулы финансового расчёта` - 20 edges
7. `icon()` - 18 edges
8. `frame()` - 18 edges
9. `calculateStoreTaxReference()` - 18 edges
10. `invalid()` - 17 edges

## Surprising Connections (you probably didn't know these)
- `Запись и версии` --references--> `unavailable()`  [INFERRED]
  db/README.md → app/modules/overview/situations.mjs
- `Этап 5. Переключение публикации и UI` --references--> `unavailable()`  [INFERRED]
  outputs/event-driven-financial-recalculation-plan.md → app/modules/overview/situations.mjs
- `Источник и период` --references--> `unavailable()`  [INFERRED]
  outputs/financial-reports.md → app/modules/overview/situations.mjs
- `P0.4 — реальный «Обзор»` --references--> `unavailable()`  [INFERRED]
  outputs/mvp-status.md → app/modules/overview/situations.mjs
- `Качество результата` --references--> `unavailable()`  [INFERRED]
  outputs/p0.3-plan.md → app/modules/overview/situations.mjs

## Import Cycles
- None detected.

## Communities (110 total, 26 thin omitted)

### Community 0 - "server.mjs"
Cohesion: 0.03
Nodes (62): app_db_addproductstoselection, app_db_confirmproductselection, app_db_consumechallenge, app_db_consumeoauthstate, app_db_creatependingstore, app_db_deferfinancialcredentialbackfill, app_db_deletesession, app_db_findorcreateyandexuser (+54 more)

### Community 1 - "createCostsRepository"
Cohesion: 0.43
Nodes (6): createCostsRepository(), getCostState(), importVariantCosts(), saveVariantCost(), Регрессия модуля себестоимости, Структура модуля

### Community 2 - "build-editable.mjs"
Cohesion: 0.11
Nodes (27): alertRow(), average, build(), circle(), control(), current, datePicker(), design (+19 more)

### Community 3 - "Marketplace Control — словарь БД, итерация 1"
Cohesion: 0.02
Nodes (97): audit_events, auth_identities, auth_oauth_states, auth_password_credentials, auth_rate_limits, auth_registration_challenges, auth_sessions, billing_invoices (+89 more)

### Community 4 - "pages.mjs"
Cohesion: 0.07
Nodes (76): authPage(), dashboardPage(), escapeHtml(), logo(), shell(), verifyPage(), createCostPage(), user (+68 more)

### Community 5 - "ref_node_test"
Cohesion: 0.09
Nodes (35): loadOperationalRange(), refreshOperationalRange(), fixture, aliases, categoryAliases, cellValue(), cleanEnum(), cleanHeader() (+27 more)

### Community 6 - "Концепция продукта — Marketplace Control"
Cohesion: 0.05
Nodes (40): 10. «Почему?» и проверка утверждений сотрудников, 11. Контрольные точки и пример сценария, 12. Постепенное подключение, MVP и развитие, 13. Границы, риски и открытые решения, 14. Основания концепции и следующий этап, 1. Суть продукта и позиционирование, 2. Принципы и целевые пользователи, 3. Структура интерфейса (+32 more)

### Community 7 - "calculation.mjs"
Cohesion: 0.11
Nodes (49): scaledMoneyMatches(), addLine(), calculateFinancialResult(), calculateReturnWbExpenseReversal(), calculateStoreTaxReference(), canonicalJson(), compareEvidence(), createInputFingerprint() (+41 more)

### Community 8 - "financial-pipeline.repository.mjs"
Cohesion: 0.17
Nodes (16): calendarDate(), financialReportPeriodMatches(), contextArgs(), createFinancialPipelineRepository(), getFetchContext(), normalize(), persistRaw(), recordFailure() (+8 more)

### Community 9 - "importMarketplaceControl"
Cohesion: 0.32
Nodes (11): importMarketplaceControl(), build(), expose(), collect(), collectIcons(), flattenText(), iconKey(), paint() (+3 more)

### Community 10 - "importMarketplaceControl"
Cohesion: 0.35
Nodes (10): importMarketplaceControl(), build(), expose(), collect(), collectIcons(), flattenText(), iconKey(), paint() (+2 more)

### Community 11 - "reports.repository.mjs"
Cohesion: 0.20
Nodes (14): financialHistoricalWeekRange(), financialParserVersion, persistFinancialNormalization(), reconcileHistoricalCatalogLinks(), reconcileHistoricalCatalogs(), normalizeVariant(), beginFinancialSync(), completeFinancialSync() (+6 more)

### Community 12 - "importMarketplaceControl"
Cohesion: 0.40
Nodes (9): importMarketplaceControl(), build(), expose(), collect(), collectIcons(), flattenText(), iconKey(), paint() (+1 more)

### Community 13 - "db/package.json"
Cohesion: 0.22
Nodes (8): devDependencies, @electric-sql/pglite, name, private, scripts, test, type, @electric-sql/pglite

### Community 14 - "figma-import/manifest.json"
Cohesion: 0.25
Nodes (7): api, documentAccess, editorType, main, name, networkAccess, allowedDomains

### Community 15 - "figma-update/manifest.json"
Cohesion: 0.25
Nodes (7): api, documentAccess, editorType, main, name, networkAccess, allowedDomains

### Community 16 - "mcImportV2"
Cohesion: 0.32
Nodes (5): MC_DESIGN, mcImportV2(), color(), fill(), make()

### Community 17 - "costs.import.mjs"
Cohesion: 0.14
Nodes (26): aliases, cellValue(), cleanHeader(), costImportMaxBytes, costImportMaxRows, createCostCsvTemplate(), csvCell(), delimiterFor() (+18 more)

### Community 18 - "server"
Cohesion: 0.10
Nodes (33): withUserContext(), consumeChallenge(), consumeOauthState(), deleteSession(), findOrCreateYandexUser(), findPasswordUser(), findSession(), getPasswordCredential() (+25 more)

### Community 19 - "mcImportV2"
Cohesion: 0.38
Nodes (4): mcImportV2(), color(), fill(), make()

### Community 24 - "Концепция продукта — Marketplace Control"
Cohesion: 0.08
Nodes (25): 10. Пример пользовательского сценария, 11. MVP и что можно отложить, 12. Открытые вопросы и риски, 1. Позиционирование и принципы, 2. Целевые пользователи и сегменты, 3. Задачи продукта, 4. Структура интерфейса, 5. Функциональные модули (+17 more)

### Community 25 - "What You Must Do When Invoked"
Cohesion: 0.08
Nodes (24): For /graphify add and --watch, For /graphify query, For the commit hook and native CLAUDE.md integration, For --update and --cluster-only, /graphify, Honesty Rules, Interpreter guard for subcommands, Part A - Structural extraction for code files (+16 more)

### Community 26 - "client.mjs"
Cohesion: 0.24
Nodes (8): migrate(), pool, createPendingStore(), deferFinancialCredentialBackfill(), listFinancialCredentialBackfill(), listStores(), saveWbConnection(), backfillFinancialCredentials()

### Community 27 - "Уже сделано"
Cohesion: 0.08
Nodes (24): Marketplace Control — статус и план MVP, P0.1 — загрузка финансовых данных WB — реализовано, P0.2 — данные пользователя для расчёта — реализовано, P0.3 — финансовая методика и расчёт — реализовано, P0.4 — реальный «Обзор», P0.5 — минимальная расшифровка, P0.6 — надёжная синхронизация и приёмка пилота, Аккаунт и доступ (+16 more)

### Community 28 - "Marketplace Control — формулы финансового расчёта"
Cohesion: 0.11
Nodes (18): 10. Результат после доступного налога, 12. Качество результата, 1. Нормализация компонентов WB, 2. Scope результата, 3. Выручка, 4. Расходы и корректировки WB, 5. Себестоимость продажи, 6. Себестоимость возврата (+10 more)

### Community 29 - "Marketplace Control — план P0.3"
Cohesion: 0.08
Nodes (24): 0. Неблокирующее эмпирическое расширение после P0.3, 1. Миграция и инварианты БД, 2. Чистый расчётный модуль, 3. Транзакционная оркестрация, 4. Запуск и наблюдаемое состояние, 5. Документация и приёмка, Marketplace Control — план P0.3, Выявленные разрывы текущего контракта (+16 more)

### Community 30 - "financial-overview.mjs"
Cohesion: 0.06
Nodes (81): buildFinancialOverview(), buildFinancialPeriodOverview(), buildSituationEvidence(), calendarPeriodMonths(), calendarWeekForDate(), compareFinancialHistory(), compareFinancialPeriods(), comparisonReason() (+73 more)

### Community 31 - "catalog.repository.mjs"
Cohesion: 0.17
Nodes (18): app_db_begincatalogsync, app_db_completecatalogsync, app_db_failcatalogsync, apiError(), colorFrom(), fetchPage(), imageFrom(), loadWbCatalog() (+10 more)

### Community 32 - "operational-sync.mjs"
Cohesion: 0.09
Nodes (41): withBusinessContext(), base, now, run, beginOperationalSync(), calendarDay(), completeOperationalSync(), decimal() (+33 more)

### Community 33 - "financial-pipeline-worker.mjs"
Cohesion: 0.06
Nodes (54): decryptSecret(), loadWbFinancialSummaries(), financialRequestDelaySeconds(), apiError(), canonicalPositiveInt64(), exactDate(), financialDetailEndpoint, loadWbFinancialReportDetail() (+46 more)

### Community 35 - "Marketplace Control: инструкции агентам"
Cohesion: 0.15
Nodes (11): graphify, Marketplace Control: инструкции агентам, Безопасность и сохранение, Карта проекта, Оркестрация, Порядок работы и контекст, Проверки, AI-оркестратор Marketplace Control (+3 more)

### Community 36 - "daily-generation-worker.mjs"
Cohesion: 0.36
Nodes (7): attemptsRemain(), createFinancialDailyGenerationWorker(), runOnce(), financialDailyErrorCode(), startFinancialDailyGenerationWorker(), terminalErrors, job

### Community 37 - "Рабочие части"
Cohesion: 0.18
Nodes (10): 1. Контракт и база данных, 2. Дополнительные расходы, 3. Налоговые настройки, 4. Интерфейс и маршруты, 5. Документация и приёмка, Marketplace Control — план P0.2, Граница P0.3, Принятые решения (+2 more)

### Community 38 - "db.mjs"
Cohesion: 0.22
Nodes (8): financialDailyGenerationRepository, financialInventoryRepository, financialPipelineRepository, getCostState, importVariantCosts, jobsRepository, saveVariantCost, scheduleDue

### Community 39 - "Marketplace Control — первая итерация базы данных"
Cohesion: 0.22
Nodes (9): Marketplace Control — первая итерация базы данных, Доступ, тарифы и закрепление товаров, Импорт и пользовательские затраты, Источники и финансовые операции, Платежи и фоновые процессы, Пользовательский сценарий, Проверки и границы готовности, Расчёт и происхождение каждой суммы (+1 more)

### Community 40 - "Marketplace Control — финансовые отчёты Wildberries"
Cohesion: 0.20
Nodes (10): Marketplace Control — финансовые отчёты Wildberries, Версии и идемпотентность, Граница текущего этапа, Источник и период, Нормализация, Получение страниц, Состояния интерфейса, Условия запуска (+2 more)

### Community 41 - "calculation.repository.mjs"
Cohesion: 0.05
Nodes (88): app_db_acknowledgefinancialcalculationinvalidation, app_db_getfinancialcompatibilitybootstrapstate, app_db_listfinancialcalculationinvalidations, app_db_runfinancialcalculation, app_db_wakefinancialdailyaftercompatibility, isVerifiedWbResultComponent(), acknowledgeFinancialCalculationInvalidation(), aggregateDailyPublicationPeriod() (+80 more)

### Community 42 - "graphify reference: extra exports and benchmark"
Cohesion: 0.22
Nodes (8): graphify reference: extra exports and benchmark, Step 6b - Wiki (only if --wiki flag), Step 7 - Neo4j export (only if --neo4j or --neo4j-push flag), Step 7a - FalkorDB export (only if --falkordb or --falkordb-push flag), Step 7b - SVG export (only if --svg flag), Step 7c - GraphML export (only if --graphml flag), Step 7d - MCP server (only if --mcp flag), Step 8 - Token reduction benchmark (only if total_words > 5000)

### Community 43 - "Design QA: overview"
Cohesion: 0.12
Nodes (16): Design QA: overview, Design QA: детализация финансового результата, Design QA: календарь периода, Исправление переполнения и сохранения периода, История проверки, Источник, Источник и состояние, Источник и состояние (+8 more)

### Community 44 - "jobs.integration.mjs"
Cohesion: 0.08
Nodes (29): asWorker(), bootstrapPool, claimAsWorker(), cleanupIntegrationRoles(), closePoolAndCleanup(), completeAsWorker(), existingOptions, failAsWorker() (+21 more)

### Community 45 - "ui.js"
Cohesion: 0.11
Nodes (14): startFinancialResultPolling(), startFinancialSyncPolling(), initializeLiveMetrics(), initializeRangePickers(), renderRangeCalendar(), updateRangeCopy(), remove(), startOperationalPanelUpdates() (+6 more)

### Community 46 - "База данных"
Cohesion: 0.25
Nodes (8): База данных, Границы проверки, Запись и версии, Контракт серверного доступа, Лимиты и пока открытые решения, Применение, Проверки, Регрессия финансового сравнения P0.4

### Community 47 - "Налоги и дополнительные расходы P0.2"
Cohesion: 0.29
Nodes (6): Граница расчёта, Дополнительные расходы, Назначение, Налоги и дополнительные расходы P0.2, Налоговые настройки, Формат импорта

### Community 48 - "Редактируемый макет Marketplace Control"
Cohesion: 0.33
Nodes (5): Воспроизведение и проверки, Импорт с редактируемым текстом и компонентами, Редактируемый макет Marketplace Control, Состав, Статус прямого переноса

### Community 49 - "Marketplace Control"
Cohesion: 0.40
Nodes (5): Marketplace Control, Подключение Wildberries, Регистрация и вход, Среда MVP, Структура кода

### Community 50 - "finance.mjs"
Cohesion: 0.12
Nodes (34): apiError(), compareDecimalIds(), dateValue(), decimal(), decimalId(), fetchPage(), financialComponentScope(), financialDateRange() (+26 more)

### Community 51 - "graphify reference: add a URL and watch a folder"
Cohesion: 0.50
Nodes (3): For /graphify add, For --watch, graphify reference: add a URL and watch a folder

### Community 52 - "graphify reference: commit hook and native CLAUDE.md integration"
Cohesion: 0.50
Nodes (3): For git commit hook, For native CLAUDE.md integration, graphify reference: commit hook and native CLAUDE.md integration

### Community 53 - "graphify reference: incremental update and cluster-only"
Cohesion: 0.50
Nodes (3): For --cluster-only, For --update (incremental re-extraction), graphify reference: incremental update and cluster-only

### Community 54 - "Подключение Wildberries API"
Cohesion: 0.50
Nodes (4): Диагностика, Подключение Wildberries API, Требования к токену, Хранение

### Community 55 - "expenses.repository.mjs"
Cohesion: 0.19
Nodes (17): cleanText(), exactDate(), uuidPattern, exactPositiveAmount(), expenseCategories, expenseComparable(), expenseRowError(), importExpenses() (+9 more)

### Community 67 - "ref_node_assert"
Cohesion: 0.31
Nodes (11): createSessionToken(), createVerificationCode(), hashPassword(), hashToken(), normalizeEmail(), requiresEmailVerification(), scrypt, validatePasswordChange() (+3 more)

### Community 68 - "README.md"
Cohesion: 0.21
Nodes (6): Структура приложения, Импорт себестоимости товаров, Ограничения и хранение, Рабочий сценарий, Форматы и столбцы, Доступ к тестовой VM

### Community 69 - "historical-relink.integration.mjs"
Cohesion: 0.67
Nodes (3): context(), fixture(), sale

### Community 70 - "recoverHistoricalCatalog"
Cohesion: 0.52
Nodes (4): recoverHistoricalCatalog(), context(), fixture(), recover()

### Community 71 - "withOwnedBusinessContext"
Cohesion: 0.18
Nodes (19): withOwnedBusinessContext(), getCurrentFinancialResult(), getFinancialCalculationInvalidation(), getFinancialCalculationState(), getCatalogState(), getExpenseState(), getOperationalSyncState(), failFinancialSync() (+11 more)

### Community 72 - "credentials.integration.mjs"
Cohesion: 0.22
Nodes (6): at, databaseName, encryptionKey, fingerprintKey, ids, inventoryRepository

### Community 73 - "unavailable"
Cohesion: 0.15
Nodes (15): unavailable(), 13. Сравнение периодов, 14. Первые ситуации P0.4, Обозначения, Marketplace Control — план P0.4, Блок «Сейчас» — реализация 4 октября 2026, Внешние контракты для проверки перед реализацией, Критерии готовности (+7 more)

### Community 74 - "financial-coverage.mjs"
Cohesion: 0.49
Nodes (9): addDays(), annualFinancialWeeks(), dateOnly(), mondayOnOrBefore(), moscowDate(), pad(), parseDate(), fixture (+1 more)

### Community 75 - "Marketplace Control — план событийной загрузки и пересчёта финансов"
Cohesion: 0.18
Nodes (11): Marketplace Control — план событийной загрузки и пересчёта финансов, Атомарная публикация и интерфейс, Год после подключения ключа, Дневной финансовый слой, Зафиксированные продуктовые правила, Когда разрешён WB API, Критерии приёмки, Первый конкретный шаг (+3 more)

### Community 76 - "wb-sales-funnel.mjs"
Cohesion: 0.18
Nodes (21): loadWbFunnelProductsDay(), loadWbFunnelProductsHistory(), moscowDay(), normalizeFunnelProducts(), parseFunnelProductsJson(), wbFunnelProductsEndpoint, calendarDate(), dateFromDay() (+13 more)

### Community 77 - "bank-reconciliation.mjs"
Cohesion: 0.18
Nodes (15): cents(), checkedFields, expenseFields, financialReportListEndpoint, money(), normalizeFinancialSummaries(), notCheckable(), reconcileBankPayment() (+7 more)

### Community 78 - "schema.test.mjs"
Cohesion: 0.15
Nodes (14): context(), db, insert(), one(), pass(), q(), rejects(), root (+6 more)

### Community 79 - "financial-sync.routes.test.mjs"
Cohesion: 0.47
Nodes (4): createFinancialSyncRoutes(), current, setup(), stores

### Community 80 - "graphify reference: query, path, explain"
Cohesion: 0.33
Nodes (5): For /graphify explain, For /graphify path, graphify reference: query, path, explain, Step 0 — Constrained query expansion (REQUIRED before traversal), Step 1 — Traversal

### Community 81 - "Порядок реализации"
Cohesion: 0.29
Nodes (7): Порядок реализации, Этап 1. Контракты и очередь, Этап 2. Credential generation и расписание, Этап 3. Конвейер отчёта, Этап 4. Локальные события и дневная generation, Этап 5. Переключение публикации и UI, Этап 6. Приёмка и развёртывание

### Community 82 - "P0.4 — контракт оперативных заказов и выкупов WB"
Cohesion: 0.20
Nodes (9): P0.4 — контракт оперативных заказов и выкупов WB, Исправление остановки на исторической дате, Исправление полноты 4 октября 2026, Календарь и сравнение, Основной источник, Первичная фабрика и статус загрузки, Реализованное хранение и загрузка, Резервный источник (+1 more)

### Community 83 - "Рабочие части"
Cohesion: 0.33
Nodes (6): 0. Закрыть входной контракт, 1. Read-модель финансового обзора, 2. Оперативные заказы и выкупы, 3. Сервис обзора и ситуации, 5. Документация и приёмка, Рабочие части

### Community 84 - "Целевая цепочка"
Cohesion: 0.33
Nodes (6): 1. Устойчивая PostgreSQL-очередь, 2. Планировщик покрытия, 3. Версия учётных данных, 4. Разделение загрузки и нормализации, 5. События и затронутые даты, Целевая цепочка

### Community 85 - "11. Сверки и доказательства"
Cohesion: 0.33
Nodes (6): 11. Сверки и доказательства, Fingerprint входов, Контрольная арифметика печатной формы «Расчёты с Продавцом», Сверка строки результата, Сверки полного отчёта WB, Справочный зачёт из стоимости реализованного товара и услуг

### Community 86 - "Принятые продуктовые решения"
Cohesion: 0.33
Nodes (6): Магазин и период, Оперативный блок «Сейчас», Принятые продуктовые решения, Ситуации, Сравнение финансовых периодов, Финансовые показатели

### Community 87 - "operational-source-storage.mjs"
Cohesion: 0.23
Nodes (18): associatedData, dataKey(), failure(), magic, rawBuffer(), readOperationalSnapshot(), removeOperationalSnapshot(), rootPath() (+10 more)

### Community 88 - "source-storage.mjs"
Cohesion: 0.29
Nodes (11): ids, dataKey(), magic, readFinancialPage(), removeFinancialDocument(), rootPath(), safeId(), storeFinancialPages() (+3 more)

### Community 96 - "Изменения финансового расчёта, каталога и интерфейса за 3–4 октября 2026 года"
Cohesion: 0.33
Nodes (6): Изменения финансового расчёта, каталога и интерфейса за 3–4 октября 2026 года, Индивидуальная себестоимость, Исторические товары и товарные связи, Классификация расходов, округление и сверка, Проверка результата на VM, Финансовая карточка и сравнение периодов

### Community 98 - "ref_node_fs"
Cohesion: 0.17
Nodes (8): context(), corrections, fixture(), display, ids, masterKey, storage, ref_node_fs

### Community 100 - "full-report-credit.mjs"
Cohesion: 0.43
Nodes (5): buildSellerOffsetReference(), formatted(), sellerOffsetLines, units(), getFinancialSellerOffsetReference()

### Community 101 - "Сверка реальных отчётов WB API для P0.3"
Cohesion: 0.50
Nodes (4): Матрица фактически встреченных операций, Покрытие и контрольные суммы, Сверка реальных отчётов WB API для P0.3, Что остаётся до закрытия критерия P0.3

### Community 102 - "variant-size-relink.integration.mjs"
Cohesion: 0.53
Nodes (4): assertCurrentVariant(), context(), fixture(), sync()

### Community 103 - "createJobsRepository"
Cohesion: 0.36
Nodes (11): createJobsRepository(), claimJobs(), completeJob(), enqueueJob(), failJob(), heartbeatJob(), integer(), optionalTimestamp() (+3 more)

### Community 104 - "p04-operational.integration.mjs"
Cohesion: 0.25
Nodes (4): ids, masterKey, storage, week

### Community 105 - "costs.integration.mjs"
Cohesion: 0.28
Nodes (6): context(), databaseName, fixture(), foreign, ids, versions()

### Community 106 - "ref_node_crypto"
Cohesion: 0.50
Nodes (6): encryptSecret(), fingerprintSecret(), loadBase64Key(), loadEncryptionKey(), loadFingerprintKey(), ref_node_crypto

### Community 107 - "Граница этапа"
Cohesion: 0.67
Nodes (3): Входит в P0.4, Граница этапа, Не входит в P0.4

### Community 108 - "financial-scheduler.mjs"
Cohesion: 0.70
Nodes (3): createFinancialScheduler(), scheduleDue(), startFinancialScheduler()

## Knowledge Gaps
- **559 isolated node(s):** `scheduleDue`, `user`, `paths`, `nav`, `overviewReasonLabels` (+554 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 721 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **26 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `База данных` connect `База данных` to `createCostsRepository`, `README.md`?**
  _High betweenness centrality (0.115) - this node is a cross-community bridge._
- **Why does `Marketplace Control — словарь БД, итерация 1` connect `Marketplace Control — словарь БД, итерация 1` to `README.md`?**
  _High betweenness centrality (0.108) - this node is a cross-community bridge._
- **Why does `unavailable()` connect `unavailable` to `Marketplace Control — финансовые отчёты Wildberries`, `Marketplace Control — план событийной загрузки и пересчёта финансов`, `База данных`, `Порядок реализации`, `Рабочие части`, `Принятые продуктовые решения`, `Уже сделано`, `Marketplace Control — план P0.3`, `financial-overview.mjs`?**
  _High betweenness centrality (0.108) - this node is a cross-community bridge._
- **What connects `scheduleDue`, `user`, `paths` to the rest of the system?**
  _559 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `server.mjs` be split into smaller, more focused modules?**
  _Cohesion score 0.03413461538461538 - nodes in this community are weakly interconnected._
- **Should `build-editable.mjs` be split into smaller, more focused modules?**
  _Cohesion score 0.10676532769556026 - nodes in this community are weakly interconnected._
- **Should `Marketplace Control — словарь БД, итерация 1` be split into smaller, more focused modules?**
  _Cohesion score 0.020618556701030927 - nodes in this community are weakly interconnected._