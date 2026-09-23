# Graph Report - Marketplace Control  (2026-09-23)

## Corpus Check
- 119 files · ~943,762 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 13 file(s) not represented in the graph (top: .toml 4, (none) 4, .css 2)

## Summary
- 966 nodes · 1731 edges · 67 communities (50 shown, 17 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 37 edges (avg confidence: 0.87)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `d7044fbd`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- server.mjs
- financial-sync.mjs
- build-editable.mjs
- Marketplace Control — словарь БД, итерация 1
- pages.mjs
- expense-import.mjs
- Концепция продукта — Marketplace Control
- calculation.mjs
- package.json
- importMarketplaceControl
- importMarketplaceControl
- source-storage.mjs
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
- finance.mjs
- Уже сделано
- Marketplace Control — формулы финансового расчёта
- Marketplace Control — план P0.3
- withOwnedBusinessContext
- catalog-sync.mjs
- expenses.repository.mjs
- wb.mjs
- README.md
- Marketplace Control: инструкции агентам
- auth.mjs
- Рабочие части
- Импорт себестоимости товаров
- Marketplace Control — первая итерация базы данных
- Marketplace Control — финансовые отчёты Wildberries
- sendSettings
- graphify reference: extra exports and benchmark
- Design QA — страница товаров
- calculation-sync.mjs
- ui.js
- База данных
- Налоги и дополнительные расходы P0.2
- Редактируемый макет Marketplace Control
- Marketplace Control
- session
- graphify reference: add a URL and watch a folder
- graphify reference: commit hook and native CLAUDE.md integration
- graphify reference: incremental update and cluster-only
- Подключение Wildberries API
- email.mjs
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

## God Nodes (most connected - your core abstractions)
1. `Marketplace Control — словарь БД, итерация 1` - 66 edges
2. `server` - 60 edges
3. `withOwnedBusinessContext()` - 38 edges
4. `calculateFinancialResult()` - 21 edges
5. `scheduleFinancialSync()` - 19 edges
6. `Marketplace Control — формулы финансового расчёта` - 18 edges
7. `frame()` - 17 edges
8. `esc()` - 16 edges
9. `Концепция продукта — Marketplace Control` - 15 edges
10. `icon()` - 13 edges

## Surprising Connections (you probably didn't know these)
- `Отчёты и данные WB для P0.3` --references--> `period()`  [INFERRED]
  outputs/financial-formulas.md → app/modules/calculation/calculation.mjs
- `Источники расчёта и граница печатных документов` --references--> `period()`  [INFERRED]
  outputs/p0.3-plan.md → app/modules/calculation/calculation.mjs
- `Регрессия модуля себестоимости` --references--> `getCostState()`  [INFERRED]
  db/README.md → app/modules/costs/costs.repository.mjs
- `Структура модуля` --references--> `getCostState()`  [INFERRED]
  outputs/cost-import.md → app/modules/costs/costs.repository.mjs
- `Регрессия модуля себестоимости` --references--> `importVariantCosts()`  [INFERRED]
  db/README.md → app/modules/costs/costs.repository.mjs

## Import Cycles
- None detected.

## Communities (67 total, 17 thin omitted)

### Community 0 - "server.mjs"
Cohesion: 0.05
Nodes (37): app_db_addproductstoselection, app_db_confirmproductselection, app_db_consumechallenge, app_db_consumeoauthstate, app_db_creatependingstore, app_db_deletesession, app_db_findorcreateyandexuser, app_db_findpassworduser (+29 more)

### Community 1 - "financial-sync.mjs"
Cohesion: 0.16
Nodes (18): app_db_beginfinancialsync, app_db_completefinancialsync, app_db_failfinancialsync, app_db_reservefinancialrequestslot, app_db_updatefinancialsyncprogress, calendarDate(), financialParserVersion, financialReportPeriodMatches() (+10 more)

### Community 2 - "build-editable.mjs"
Cohesion: 0.11
Nodes (27): alertRow(), average, build(), circle(), control(), current, datePicker(), design (+19 more)

### Community 3 - "Marketplace Control — словарь БД, итерация 1"
Cohesion: 0.03
Nodes (66): audit_events, auth_identities, auth_oauth_states, auth_password_credentials, auth_rate_limits, auth_registration_challenges, auth_sessions, billing_invoices (+58 more)

### Community 4 - "pages.mjs"
Cohesion: 0.11
Nodes (46): authPage(), dashboardPage(), escapeHtml(), logo(), shell(), verifyPage(), createCostPage(), calculationPanel() (+38 more)

### Community 5 - "expense-import.mjs"
Cohesion: 0.06
Nodes (48): user, decryptSecret(), encryptSecret(), loadEncryptionKey(), aliases, categoryAliases, cellValue(), cleanEnum() (+40 more)

### Community 6 - "Концепция продукта — Marketplace Control"
Cohesion: 0.05
Nodes (40): 10. «Почему?» и проверка утверждений сотрудников, 11. Контрольные точки и пример сценария, 12. Постепенное подключение, MVP и развитие, 13. Границы, риски и открытые решения, 14. Основания концепции и следующий этап, 1. Суть продукта и позиционирование, 2. Принципы и целевые пользователи, 3. Структура интерфейса (+32 more)

### Community 7 - "calculation.mjs"
Cohesion: 0.17
Nodes (32): addLine(), calculateFinancialResult(), canonicalJson(), compareEvidence(), createInputFingerprint(), dateFromNumber(), dateNumber(), EXPENSE_CATEGORIES (+24 more)

### Community 8 - "package.json"
Cohesion: 0.17
Nodes (11): dependencies, exceljs, nodemailer, pg, name, private, scripts, start (+3 more)

### Community 9 - "importMarketplaceControl"
Cohesion: 0.32
Nodes (11): importMarketplaceControl(), build(), expose(), collect(), collectIcons(), flattenText(), iconKey(), paint() (+3 more)

### Community 10 - "importMarketplaceControl"
Cohesion: 0.35
Nodes (10): importMarketplaceControl(), build(), expose(), collect(), collectIcons(), flattenText(), iconKey(), paint() (+2 more)

### Community 11 - "source-storage.mjs"
Cohesion: 0.10
Nodes (27): dataKey(), magic, readFinancialPage(), removeFinancialDocument(), rootPath(), safeId(), storeFinancialPages(), unzip (+19 more)

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
Cohesion: 0.15
Nodes (25): aliases, cellValue(), cleanHeader(), costImportMaxBytes, costImportMaxRows, createCostCsvTemplate(), csvCell(), delimiterFor() (+17 more)

### Community 18 - "server"
Cohesion: 0.13
Nodes (26): withUserContext(), consumeChallenge(), consumeOauthState(), deleteSession(), findOrCreateYandexUser(), findPasswordUser(), findSession(), getPasswordCredential() (+18 more)

### Community 19 - "mcImportV2"
Cohesion: 0.38
Nodes (4): mcImportV2(), color(), fill(), make()

### Community 24 - "Концепция продукта — Marketplace Control"
Cohesion: 0.08
Nodes (25): 10. Пример пользовательского сценария, 11. MVP и что можно отложить, 12. Открытые вопросы и риски, 1. Позиционирование и принципы, 2. Целевые пользователи и сегменты, 3. Задачи продукта, 4. Структура интерфейса, 5. Функциональные модули (+17 more)

### Community 25 - "What You Must Do When Invoked"
Cohesion: 0.08
Nodes (24): For /graphify add and --watch, For /graphify query, For the commit hook and native CLAUDE.md integration, For --update and --cluster-only, /graphify, Honesty Rules, Interpreter guard for subcommands, Part A - Structural extraction for code files (+16 more)

### Community 26 - "finance.mjs"
Cohesion: 0.17
Nodes (20): apiError(), compareDecimalIds(), dateValue(), decimal(), decimalId(), fetchPage(), financialDateRange(), financialReportsEndpoint (+12 more)

### Community 27 - "Уже сделано"
Cohesion: 0.08
Nodes (24): Marketplace Control — статус и план MVP, P0.1 — загрузка финансовых данных WB — реализовано, P0.2 — данные пользователя для расчёта — реализовано, P0.3 — финансовая методика и расчёт — проектирование, P0.4 — реальный «Обзор», P0.5 — минимальная расшифровка, P0.6 — надёжная синхронизация и приёмка пилота, Аккаунт и доступ (+16 more)

### Community 28 - "Marketplace Control — формулы финансового расчёта"
Cohesion: 0.09
Nodes (23): 10. Результат после доступного налога, 11. Сверки и доказательства, 12. Качество результата, 13. Сравнение периодов, 1. Нормализация компонентов WB, 2. Scope результата, 3. Выручка, 4. Расходы и корректировки WB (+15 more)

### Community 29 - "Marketplace Control — план P0.3"
Cohesion: 0.09
Nodes (23): 0. Сверка методики с реальными данными, 1. Миграция и инварианты БД, 2. Чистый расчётный модуль, 3. Транзакционная оркестрация, 4. Запуск и наблюдаемое состояние, 5. Документация и приёмка, Marketplace Control — план P0.3, Выявленные разрывы текущего контракта (+15 more)

### Community 30 - "withOwnedBusinessContext"
Cohesion: 0.18
Nodes (17): getCostState, importVariantCosts, migrate(), pool, withOwnedBusinessContext(), executeFinancialCalculation(), getCurrentFinancialResult(), getFinancialCalculationInvalidation() (+9 more)

### Community 31 - "catalog-sync.mjs"
Cohesion: 0.17
Nodes (17): app_db_begincatalogsync, app_db_completecatalogsync, app_db_failcatalogsync, apiError(), colorFrom(), fetchPage(), imageFrom(), loadWbCatalog() (+9 more)

### Community 32 - "expenses.repository.mjs"
Cohesion: 0.23
Nodes (15): cleanText(), exactDate(), uuidPattern, exactPositiveAmount(), expenseCategories, expenseComparable(), expenseRowError(), importExpenses() (+7 more)

### Community 33 - "wb.mjs"
Cohesion: 0.18
Nodes (14): assertWbFinancialToken(), CATEGORIES, decodeWbToken(), normalizeWbToken(), requiredWbScopes, fullMask, token(), verifyWbToken() (+6 more)

### Community 34 - "README.md"
Cohesion: 0.20
Nodes (3): Структура приложения, Каталог Wildberries и выбор товаров, Доступ к тестовой VM

### Community 35 - "Marketplace Control: инструкции агентам"
Cohesion: 0.15
Nodes (11): graphify, Marketplace Control: инструкции агентам, Безопасность и сохранение, Карта проекта, Оркестрация, Порядок работы и контекст, Проверки, AI-оркестратор Marketplace Control (+3 more)

### Community 36 - "auth.mjs"
Cohesion: 0.33
Nodes (10): createSessionToken(), createVerificationCode(), hashPassword(), hashToken(), normalizeEmail(), requiresEmailVerification(), scrypt, validatePasswordChange() (+2 more)

### Community 37 - "Рабочие части"
Cohesion: 0.18
Nodes (10): 1. Контракт и база данных, 2. Дополнительные расходы, 3. Налоговые настройки, 4. Интерфейс и маршруты, 5. Документация и приёмка, Marketplace Control — план P0.2, Граница P0.3, Принятые решения (+2 more)

### Community 38 - "Импорт себестоимости товаров"
Cohesion: 0.24
Nodes (9): createCostsRepository(), getCostState(), importVariantCosts(), Регрессия модуля себестоимости, Импорт себестоимости товаров, Ограничения и хранение, Рабочий сценарий, Структура модуля (+1 more)

### Community 39 - "Marketplace Control — первая итерация базы данных"
Cohesion: 0.20
Nodes (10): Marketplace Control — первая итерация базы данных, Доступ, тарифы и закрепление товаров, Импорт и пользовательские затраты, Источники и финансовые операции, Платежи и фоновые процессы, Пользовательский сценарий, Проверки и границы готовности, Расчёт и происхождение каждой суммы (+2 more)

### Community 40 - "Marketplace Control — финансовые отчёты Wildberries"
Cohesion: 0.20
Nodes (10): Marketplace Control — финансовые отчёты Wildberries, Версии и идемпотентность, Граница текущего этапа, Источник и период, Нормализация, Получение страниц, Состояния интерфейса, Условия запуска (+2 more)

### Community 41 - "sendSettings"
Cohesion: 0.33
Nodes (9): getCatalogState(), getExpenseState(), getBillingSummary(), getTaxState(), send(), sendExpenses(), sendProducts(), sendSettings() (+1 more)

### Community 42 - "graphify reference: extra exports and benchmark"
Cohesion: 0.22
Nodes (8): graphify reference: extra exports and benchmark, Step 6b - Wiki (only if --wiki flag), Step 7 - Neo4j export (only if --neo4j or --neo4j-push flag), Step 7a - FalkorDB export (only if --falkordb or --falkordb-push flag), Step 7b - SVG export (only if --svg flag), Step 7c - GraphML export (only if --graphml flag), Step 7d - MCP server (only if --mcp flag), Step 8 - Token reduction benchmark (only if total_words > 5000)

### Community 43 - "Design QA — страница товаров"
Cohesion: 0.22
Nodes (8): Comparison history, Design QA — страница товаров, Findings, Focused region comparison evidence, Follow-up polish, Full-view comparison evidence, Implementation checklist, Required fidelity surfaces

### Community 44 - "calculation-sync.mjs"
Cohesion: 0.29
Nodes (7): app_db_acknowledgefinancialcalculationinvalidation, app_db_getfinancialcalculationinvalidation, app_db_runfinancialcalculation, acknowledgeFinancialCalculationInvalidation(), activeJobs, expectedUnavailable, scheduleFinancialCalculation()

### Community 46 - "База данных"
Cohesion: 0.29
Nodes (7): База данных, Границы проверки, Запись и версии, Контракт серверного доступа, Лимиты и пока открытые решения, Применение, Проверки

### Community 47 - "Налоги и дополнительные расходы P0.2"
Cohesion: 0.29
Nodes (6): Граница расчёта, Дополнительные расходы, Назначение, Налоги и дополнительные расходы P0.2, Налоговые настройки, Формат импорта

### Community 48 - "Редактируемый макет Marketplace Control"
Cohesion: 0.33
Nodes (5): Воспроизведение и проверки, Импорт с редактируемым текстом и компонентами, Редактируемый макет Marketplace Control, Состав, Статус прямого переноса

### Community 49 - "Marketplace Control"
Cohesion: 0.40
Nodes (5): Marketplace Control, Подключение Wildberries, Регистрация и вход, Среда MVP, Структура кода

### Community 50 - "session"
Cohesion: 0.50
Nodes (4): saveSession(), cookie(), redirect(), session()

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

## Knowledge Gaps
- **379 isolated node(s):** `user`, `paths`, `nav`, `catalogSyncErrors`, `financialSyncErrors` (+374 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 487 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **17 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `period()` connect `calculation.mjs` to `Marketplace Control — формулы финансового расчёта`, `Marketplace Control — план P0.3`?**
  _High betweenness centrality (0.169) - this node is a cross-community bridge._
- **Why does `createCostsRepository()` connect `Импорт себестоимости товаров` to `withOwnedBusinessContext`?**
  _High betweenness centrality (0.143) - this node is a cross-community bridge._
- **Why does `База данных` connect `База данных` to `README.md`, `Импорт себестоимости товаров`?**
  _High betweenness centrality (0.108) - this node is a cross-community bridge._
- **What connects `user`, `paths`, `nav` to the rest of the system?**
  _379 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `server.mjs` be split into smaller, more focused modules?**
  _Cohesion score 0.05128205128205128 - nodes in this community are weakly interconnected._
- **Should `build-editable.mjs` be split into smaller, more focused modules?**
  _Cohesion score 0.10676532769556026 - nodes in this community are weakly interconnected._
- **Should `Marketplace Control — словарь БД, итерация 1` be split into smaller, more focused modules?**
  _Cohesion score 0.030303030303030304 - nodes in this community are weakly interconnected._