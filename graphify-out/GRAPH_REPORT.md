# Graph Report - Marketplace Control  (2026-10-03)

## Corpus Check
- 229 files · ~1,048,563 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 13 file(s) not represented in the graph (top: .toml 4, (none) 4, .css 2)

## Summary
- 1627 nodes · 3350 edges · 97 communities (74 shown, 23 thin omitted)
- Extraction: 97% EXTRACTED · 3% INFERRED · 0% AMBIGUOUS · INFERRED: 107 edges (avg confidence: 0.88)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `b2e36481`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- server.mjs
- Импорт себестоимости товаров
- build-editable.mjs
- Marketplace Control — словарь БД, итерация 1
- pages.mjs
- expense-import.mjs
- Концепция продукта — Marketplace Control
- calculation.mjs
- Сверка реальных отчётов WB API для P0.3
- importMarketplaceControl
- importMarketplaceControl
- operational-source-storage.mjs
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
- ref_node_crypto
- Уже сделано
- Marketplace Control — формулы финансового расчёта
- Marketplace Control — план P0.3
- financial-overview.mjs
- catalog-sync.mjs
- operational-sync.mjs
- financial-pipeline-worker.mjs
- Marketplace Control: инструкции агентам
- ref_node_assert
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
- wb-sales-funnel.mjs
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
- ui-site.md
- auth.mjs
- README.md
- credentials.integration.mjs
- financial-inventory-worker.mjs
- financial-detail.mjs
- createJobsRepository
- unavailable
- financial-coverage.mjs
- Marketplace Control — план событийной загрузки и пересчёта финансов
- ui.test.mjs
- wb.mjs
- /graphify
- costs.integration.mjs
- graphify reference: query, path, explain
- Порядок реализации
- P0.4 — контракт оперативных заказов и выкупов WB
- Рабочие части
- Целевая цепочка
- 11. Сверки и доказательства
- Принятые продуктовые решения
- Step 3 - Extract entities and relationships
- Граница этапа
- app_db_beginfinancialsync
- app_db_completefinancialsync
- { enqueueJob, claimJobs, heartbeatJob, completeJob, failJob }
- app_db_failfinancialsync
- app_db_getfinancialcalculationinvalidation
- app_db_reservefinancialrequestslot
- app_db_updatefinancialsyncprogress
- financial-sync.routes.test.mjs

## God Nodes (most connected - your core abstractions)
1. `Marketplace Control — словарь БД, итерация 1` - 95 edges
2. `server` - 63 edges
3. `withOwnedBusinessContext()` - 52 edges
4. `calculateFinancialResult()` - 30 edges
5. `esc()` - 26 edges
6. `Marketplace Control — формулы финансового расчёта` - 19 edges
7. `frame()` - 18 edges
8. `calculateStoreTaxReference()` - 18 edges
9. `icon()` - 17 edges
10. `invalid()` - 17 edges

## Surprising Connections (you probably didn't know these)
- `4. Интерфейс и маршруты` --references--> `overviewPage()`  [INFERRED]
  outputs/p0.4-plan.md → app/frontend/pages.mjs
- `Запись и версии` --references--> `unavailable()`  [INFERRED]
  db/README.md → app/modules/overview/situations.mjs
- `Этап 5. Переключение публикации и UI` --references--> `unavailable()`  [INFERRED]
  outputs/event-driven-financial-recalculation-plan.md → app/modules/overview/situations.mjs
- `Источник и период` --references--> `unavailable()`  [INFERRED]
  outputs/financial-reports.md → app/modules/overview/situations.mjs
- `P0.4 — реальный «Обзор»` --references--> `unavailable()`  [INFERRED]
  outputs/mvp-status.md → app/modules/overview/situations.mjs

## Import Cycles
- None detected.

## Communities (97 total, 23 thin omitted)

### Community 0 - "server.mjs"
Cohesion: 0.04
Nodes (60): app_db_addproductstoselection, app_db_confirmproductselection, app_db_consumechallenge, app_db_consumeoauthstate, app_db_creatependingstore, app_db_deferfinancialcredentialbackfill, app_db_deletesession, app_db_findorcreateyandexuser (+52 more)

### Community 1 - "Импорт себестоимости товаров"
Cohesion: 0.24
Nodes (9): createCostsRepository(), getCostState(), importVariantCosts(), Регрессия модуля себестоимости, Импорт себестоимости товаров, Ограничения и хранение, Рабочий сценарий, Структура модуля (+1 more)

### Community 2 - "build-editable.mjs"
Cohesion: 0.11
Nodes (27): alertRow(), average, build(), circle(), control(), current, datePicker(), design (+19 more)

### Community 3 - "Marketplace Control — словарь БД, итерация 1"
Cohesion: 0.02
Nodes (95): audit_events, auth_identities, auth_oauth_states, auth_password_credentials, auth_rate_limits, auth_registration_challenges, auth_sessions, billing_invoices (+87 more)

### Community 4 - "pages.mjs"
Cohesion: 0.07
Nodes (72): authPage(), dashboardPage(), escapeHtml(), logo(), shell(), verifyPage(), createCostPage(), bankReconciliationPanel() (+64 more)

### Community 5 - "expense-import.mjs"
Cohesion: 0.14
Nodes (29): aliases, categoryAliases, cellValue(), cleanEnum(), cleanHeader(), createExpenseCsvExport(), createExpenseCsvTemplate(), csvCell() (+21 more)

### Community 6 - "Концепция продукта — Marketplace Control"
Cohesion: 0.05
Nodes (40): 10. «Почему?» и проверка утверждений сотрудников, 11. Контрольные точки и пример сценария, 12. Постепенное подключение, MVP и развитие, 13. Границы, риски и открытые решения, 14. Основания концепции и следующий этап, 1. Суть продукта и позиционирование, 2. Принципы и целевые пользователи, 3. Структура интерфейса (+32 more)

### Community 7 - "calculation.mjs"
Cohesion: 0.06
Nodes (80): addLine(), calculateFinancialResult(), calculateReturnWbExpenseReversal(), calculateStoreTaxReference(), canonicalJson(), compareEvidence(), createInputFingerprint(), dateFromNumber() (+72 more)

### Community 8 - "Сверка реальных отчётов WB API для P0.3"
Cohesion: 0.50
Nodes (4): Матрица фактически встреченных операций, Покрытие и контрольные суммы, Сверка реальных отчётов WB API для P0.3, Что остаётся до закрытия критерия P0.3

### Community 9 - "importMarketplaceControl"
Cohesion: 0.32
Nodes (11): importMarketplaceControl(), build(), expose(), collect(), collectIcons(), flattenText(), iconKey(), paint() (+3 more)

### Community 10 - "importMarketplaceControl"
Cohesion: 0.35
Nodes (10): importMarketplaceControl(), build(), expose(), collect(), collectIcons(), flattenText(), iconKey(), paint() (+2 more)

### Community 11 - "operational-source-storage.mjs"
Cohesion: 0.07
Nodes (48): associatedData, dataKey(), failure(), magic, rawBuffer(), readOperationalSnapshot(), removeOperationalSnapshot(), rootPath() (+40 more)

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
Cohesion: 0.09
Nodes (38): withUserContext(), consumeChallenge(), consumeOauthState(), deleteSession(), findOrCreateYandexUser(), findPasswordUser(), findSession(), getPasswordCredential() (+30 more)

### Community 19 - "mcImportV2"
Cohesion: 0.38
Nodes (4): mcImportV2(), color(), fill(), make()

### Community 24 - "Концепция продукта — Marketplace Control"
Cohesion: 0.08
Nodes (25): 10. Пример пользовательского сценария, 11. MVP и что можно отложить, 12. Открытые вопросы и риски, 1. Позиционирование и принципы, 2. Целевые пользователи и сегменты, 3. Задачи продукта, 4. Структура интерфейса, 5. Функциональные модули (+17 more)

### Community 25 - "What You Must Do When Invoked"
Cohesion: 0.18
Nodes (11): Step 0 - GitHub repos and multi-path merge (only if a URL or several paths), Step 1 - Ensure graphify is installed, Step 2.5 - Video and audio (only if video files detected), Step 2 - Detect files, Step 4.5 - Graph health check (read-only integrity gate), Step 4 - Build graph, cluster, analyze, generate outputs, Step 5 - Label communities, Step 6 - Generate Obsidian vault (opt-in) + HTML (+3 more)

### Community 26 - "ref_node_crypto"
Cohesion: 0.19
Nodes (11): encryptSecret(), fingerprintSecret(), loadBase64Key(), loadEncryptionKey(), loadFingerprintKey(), context(), encrypted(), encryptionKey (+3 more)

### Community 27 - "Уже сделано"
Cohesion: 0.08
Nodes (24): Marketplace Control — статус и план MVP, P0.1 — загрузка финансовых данных WB — реализовано, P0.2 — данные пользователя для расчёта — реализовано, P0.3 — финансовая методика и расчёт — реализовано, P0.4 — реальный «Обзор», P0.5 — минимальная расшифровка, P0.6 — надёжная синхронизация и приёмка пилота, Аккаунт и доступ (+16 more)

### Community 28 - "Marketplace Control — формулы финансового расчёта"
Cohesion: 0.12
Nodes (17): 10. Результат после доступного налога, 12. Качество результата, 1. Нормализация компонентов WB, 2. Scope результата, 3. Выручка, 4. Расходы и корректировки WB, 5. Себестоимость продажи, 6. Себестоимость возврата (+9 more)

### Community 29 - "Marketplace Control — план P0.3"
Cohesion: 0.09
Nodes (23): 0. Неблокирующее эмпирическое расширение после P0.3, 1. Миграция и инварианты БД, 2. Чистый расчётный модуль, 3. Транзакционная оркестрация, 4. Запуск и наблюдаемое состояние, 5. Документация и приёмка, Marketplace Control — план P0.3, Выявленные разрывы текущего контракта (+15 more)

### Community 30 - "financial-overview.mjs"
Cohesion: 0.07
Nodes (73): buildFinancialOverview(), buildFinancialPeriodOverview(), buildSituationEvidence(), calendarPeriodMonths(), calendarWeekForDate(), compareFinancialHistory(), compareFinancialPeriods(), comparisonReason() (+65 more)

### Community 31 - "catalog-sync.mjs"
Cohesion: 0.17
Nodes (18): app_db_begincatalogsync, app_db_completecatalogsync, app_db_failcatalogsync, apiError(), colorFrom(), fetchPage(), imageFrom(), loadWbCatalog() (+10 more)

### Community 32 - "operational-sync.mjs"
Cohesion: 0.10
Nodes (33): withBusinessContext(), beginOperationalSync(), calendarDay(), completeOperationalSync(), decimal(), failOperationalSync(), getOperationalOverviewData(), listOperationalSyncCandidates() (+25 more)

### Community 33 - "financial-pipeline-worker.mjs"
Cohesion: 0.21
Nodes (19): createFinancialPipelineWorker(), runOnce(), createFinancialReportFetchWorker(), beforeRequest(), completeFallback(), heartbeat(), runOnce(), createFinancialReportNormalizeWorker() (+11 more)

### Community 35 - "Marketplace Control: инструкции агентам"
Cohesion: 0.15
Nodes (11): graphify, Marketplace Control: инструкции агентам, Безопасность и сохранение, Карта проекта, Оркестрация, Порядок работы и контекст, Проверки, AI-оркестратор Marketplace Control (+3 more)

### Community 36 - "ref_node_assert"
Cohesion: 0.07
Nodes (21): user, fixture, createFinancialCalculationWorker(), runOnce(), startFinancialCalculationWorker(), attemptsRemain(), createFinancialDailyGenerationWorker(), runOnce() (+13 more)

### Community 37 - "Рабочие части"
Cohesion: 0.18
Nodes (10): 1. Контракт и база данных, 2. Дополнительные расходы, 3. Налоговые настройки, 4. Интерфейс и маршруты, 5. Документация и приёмка, Marketplace Control — план P0.2, Граница P0.3, Принятые решения (+2 more)

### Community 38 - "db.mjs"
Cohesion: 0.12
Nodes (18): financialDailyGenerationRepository, financialInventoryRepository, financialPipelineRepository, getCostState, importVariantCosts, jobsRepository, scheduleDue, migrate() (+10 more)

### Community 39 - "Marketplace Control — первая итерация базы данных"
Cohesion: 0.22
Nodes (9): Marketplace Control — первая итерация базы данных, Доступ, тарифы и закрепление товаров, Импорт и пользовательские затраты, Источники и финансовые операции, Платежи и фоновые процессы, Пользовательский сценарий, Проверки и границы готовности, Расчёт и происхождение каждой суммы (+1 more)

### Community 40 - "Marketplace Control — финансовые отчёты Wildberries"
Cohesion: 0.20
Nodes (10): Marketplace Control — финансовые отчёты Wildberries, Версии и идемпотентность, Граница текущего этапа, Источник и период, Нормализация, Получение страниц, Состояния интерфейса, Условия запуска (+2 more)

### Community 41 - "calculation.repository.mjs"
Cohesion: 0.06
Nodes (80): app_db_acknowledgefinancialcalculationinvalidation, app_db_getfinancialcompatibilitybootstrapstate, app_db_listfinancialcalculationinvalidations, app_db_runfinancialcalculation, app_db_wakefinancialdailyaftercompatibility, withOwnedBusinessContext(), cleanText(), exactDate() (+72 more)

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
Cohesion: 0.20
Nodes (6): remove(), renderRangeCalendar(), update(), toast(), updateRangeCopy(), ref

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
Cohesion: 0.05
Nodes (82): cents(), checkedFields, expenseFields, financialReportListEndpoint, money(), normalizeFinancialSummaries(), notCheckable(), reconcileBankPayment() (+74 more)

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

### Community 55 - "wb-sales-funnel.mjs"
Cohesion: 0.29
Nodes (14): calendarDate(), dateFromDay(), dayNumber(), exactDecimal(), failure(), loadWbSalesFunnelHistory(), normalizeSalesFunnelHistory(), parseSalesFunnelHistoryJson() (+6 more)

### Community 67 - "auth.mjs"
Cohesion: 0.33
Nodes (10): createSessionToken(), createVerificationCode(), hashPassword(), hashToken(), normalizeEmail(), requiresEmailVerification(), scrypt, validatePasswordChange() (+2 more)

### Community 68 - "README.md"
Cohesion: 0.25
Nodes (3): Структура приложения, Каталог Wildberries и выбор товаров, Доступ к тестовой VM

### Community 69 - "credentials.integration.mjs"
Cohesion: 0.13
Nodes (7): createFinancialInventoryRepository(), at, databaseName, encryptionKey, fingerprintKey, ids, inventoryRepository

### Community 70 - "financial-inventory-worker.mjs"
Cohesion: 0.25
Nodes (13): decryptSecret(), loadWbFinancialSummaries(), financialRequestDelaySeconds(), createFinancialInventoryWorker(), runOnce(), exactDate(), inventoryErrorCode(), inventoryRows() (+5 more)

### Community 71 - "financial-detail.mjs"
Cohesion: 0.25
Nodes (10): apiError(), canonicalPositiveInt64(), exactDate(), financialDetailEndpoint, loadWbFinancialReportDetail(), requestBody(), retryAfterMs(), period (+2 more)

### Community 72 - "createJobsRepository"
Cohesion: 0.36
Nodes (11): createJobsRepository(), claimJobs(), completeJob(), enqueueJob(), failJob(), heartbeatJob(), integer(), optionalTimestamp() (+3 more)

### Community 73 - "unavailable"
Cohesion: 0.18
Nodes (13): unavailable(), 13. Сравнение периодов, 14. Первые ситуации P0.4, Обозначения, Marketplace Control — план P0.4, Внешние контракты для проверки перед реализацией, Критерии готовности, Порядок поставки (+5 more)

### Community 74 - "financial-coverage.mjs"
Cohesion: 0.49
Nodes (9): addDays(), annualFinancialWeeks(), dateOnly(), mondayOnOrBefore(), moscowDate(), pad(), parseDate(), fixture (+1 more)

### Community 75 - "Marketplace Control — план событийной загрузки и пересчёта финансов"
Cohesion: 0.18
Nodes (11): Marketplace Control — план событийной загрузки и пересчёта финансов, Атомарная публикация и интерфейс, Год после подключения ключа, Дневной финансовый слой, Зафиксированные продуктовые правила, Когда разрешён WB API, Критерии приёмки, Первый конкретный шаг (+3 more)

### Community 76 - "ui.test.mjs"
Cohesion: 0.29
Nodes (4): startFinancialResultPolling(), startFinancialSyncPolling(), harness(), syncHarness()

### Community 77 - "wb.mjs"
Cohesion: 0.36
Nodes (7): CATEGORIES, decodeWbToken(), normalizeWbToken(), requiredWbScopes, fullMask, verifyWbToken(), wbRequest()

### Community 78 - "/graphify"
Cohesion: 0.22
Nodes (8): For /graphify add and --watch, For /graphify query, For the commit hook and native CLAUDE.md integration, For --update and --cluster-only, /graphify, Honesty Rules, Usage, What graphify is for

### Community 79 - "costs.integration.mjs"
Cohesion: 0.28
Nodes (6): context(), databaseName, fixture(), foreign, ids, versions()

### Community 80 - "graphify reference: query, path, explain"
Cohesion: 0.25
Nodes (7): query(), For /graphify explain, For /graphify path, graphify reference: query, path, explain, Step 0 — Constrained query expansion (REQUIRED before traversal), Step 1 — Traversal, Interpreter guard for subcommands

### Community 81 - "Порядок реализации"
Cohesion: 0.29
Nodes (7): Порядок реализации, Этап 1. Контракты и очередь, Этап 2. Credential generation и расписание, Этап 3. Конвейер отчёта, Этап 4. Локальные события и дневная generation, Этап 5. Переключение публикации и UI, Этап 6. Приёмка и развёртывание

### Community 82 - "P0.4 — контракт оперативных заказов и выкупов WB"
Cohesion: 0.29
Nodes (6): P0.4 — контракт оперативных заказов и выкупов WB, Основной источник, Реализованное хранение, Резервный источник, Результат pilot probe, Решение для реализации

### Community 83 - "Рабочие части"
Cohesion: 0.29
Nodes (7): 0. Закрыть входной контракт, 1. Read-модель финансового обзора, 2. Оперативные заказы и выкупы, 3. Сервис обзора и ситуации, 4. Интерфейс и маршруты, 5. Документация и приёмка, Рабочие части

### Community 84 - "Целевая цепочка"
Cohesion: 0.33
Nodes (6): 1. Устойчивая PostgreSQL-очередь, 2. Планировщик покрытия, 3. Версия учётных данных, 4. Разделение загрузки и нормализации, 5. События и затронутые даты, Целевая цепочка

### Community 85 - "11. Сверки и доказательства"
Cohesion: 0.33
Nodes (6): 11. Сверки и доказательства, Fingerprint входов, Контрольная арифметика печатной формы «Расчёты с Продавцом», Сверка строки результата, Сверки полного отчёта WB, Справочный зачёт из стоимости реализованного товара и услуг

### Community 86 - "Принятые продуктовые решения"
Cohesion: 0.33
Nodes (6): Магазин и период, Оперативный блок «Сейчас», Принятые продуктовые решения, Ситуации, Сравнение финансовых периодов, Финансовые показатели

### Community 87 - "Step 3 - Extract entities and relationships"
Cohesion: 0.50
Nodes (4): Part A - Structural extraction for code files, Part B - Semantic extraction (parallel subagents), Part C - Merge AST + semantic into final extraction, Step 3 - Extract entities and relationships

### Community 88 - "Граница этапа"
Cohesion: 0.67
Nodes (3): Входит в P0.4, Граница этапа, Не входит в P0.4

### Community 96 - "financial-sync.routes.test.mjs"
Cohesion: 0.47
Nodes (4): createFinancialSyncRoutes(), current, setup(), stores

## Knowledge Gaps
- **532 isolated node(s):** `scheduleDue`, `user`, `paths`, `nav`, `overviewReasonLabels` (+527 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 684 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **23 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `unavailable()` connect `unavailable` to `Marketplace Control — финансовые отчёты Wildberries`, `Marketplace Control — план событийной загрузки и пересчёта финансов`, `База данных`, `Порядок реализации`, `Рабочие части`, `Принятые продуктовые решения`, `Уже сделано`, `Marketplace Control — план P0.3`, `financial-overview.mjs`?**
  _High betweenness centrality (0.111) - this node is a cross-community bridge._
- **Why does `База данных` connect `База данных` to `Импорт себестоимости товаров`, `README.md`?**
  _High betweenness centrality (0.103) - this node is a cross-community bridge._
- **Why does `Marketplace Control — словарь БД, итерация 1` connect `Marketplace Control — словарь БД, итерация 1` to `README.md`?**
  _High betweenness centrality (0.103) - this node is a cross-community bridge._
- **What connects `scheduleDue`, `user`, `paths` to the rest of the system?**
  _532 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `server.mjs` be split into smaller, more focused modules?**
  _Cohesion score 0.03533026113671275 - nodes in this community are weakly interconnected._
- **Should `build-editable.mjs` be split into smaller, more focused modules?**
  _Cohesion score 0.10676532769556026 - nodes in this community are weakly interconnected._
- **Should `Marketplace Control — словарь БД, итерация 1` be split into smaller, more focused modules?**
  _Cohesion score 0.021052631578947368 - nodes in this community are weakly interconnected._