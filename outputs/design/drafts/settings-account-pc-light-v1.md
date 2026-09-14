# Настройки аккаунта — PC, светлая тема, черновик v1

Дата: 14 сентября 2026. Статус: предложен, не согласован.

Изображение: `settings-account-pc-light-v1.png`. Основа: принятый `../Makets/overview-pc-light.png`. Создан встроенной генерацией изображений, без Figma. Это статический макет, не реализованная страница.

Подключение WB, выбор товаров и добавление данных объединены на одной странице. Верхние ссылки — якоря разделов, не отдельные страницы. Показано состояние подключённого магазина и подтверждённого набора из трёх товаров бесплатного тарифа. До подтверждения этот же раздел должен показывать поиск, выбор товаров в пределах лимита и подтверждение с предупреждением о неизменяемости набора. До подключения раздел магазина показывает ввод токена, проверку, загрузку и ошибки.

Себестоимость, дополнительные расходы и налоги открывают соответствующие формы внутри страницы. Отсутствующие данные не считаются нулём. Налоговые правила требуют отдельного согласования перед реализацией. Сохранение справа относится к аккаунту и оформлению, не к замене токена или подтверждению товаров.

Примерные имя, email, артикулы и время загрузки — иллюстративные данные. API-токен замаскирован, секретов нет. Макет визуально проверен: основные разделы, кириллица, сохранение стиля и отсутствие обрезанного содержимого. Приложение и БД не изменялись, тесты приложения и VM не запускались.

После принятия перенести итог в `../Makets/`, затем подготовить мобильную компоновку и тёмные темы.

## Запрос генерации

Use case: ui-mockup. Create ONE production-quality raster mockup of the Marketplace Control desktop page "Настройки аккаунта", light theme. User specifically wants a single page mockup, not three separate screens or design alternatives. Target 1672x941, standard 16:9. Input reference: approved Overview, use actual reference for EXACT brand/logo, slim Cyrillic sans-serif typography, navy blue text, royal blue interactions, pale blue dividers, white background, sidebar dimensions and spacing. Current date anchor 14 September 2026.
Preserve original sidebar logo and analytical navigation (Обзор, АНАЛИТИКА, SKU, Продвижение, Регионы, Остатки, ДАННЫЕ И НАСТРОЙКИ, Настройки, Помощь); now Settings is selected pale blue; remove duplicate standalone "Добавить данные" because all input is integrated into this page. Business dropdown Дом и уют at top. No browser frame. No shadows, no rainbow cards, no oversized type, plenty of empty space.
Main title Настройки аккаунта, 28px moderate weight, subtitle "Магазин, товары и данные для расчёта — в одном месте". Under title a compact anchor strip "Магазин WB   Товары   Данные для расчёта   Аккаунт", NOT separate pages. Main body left wide functional column ~800px and right narrower quiet column ~360px with thin vertical divider, large gutter. All content fits without crowding. Main left three open sections separated ONLY by thin lines and generous spacing.
Section 1 "Магазин Wildberries": short store row "Дом и уют" with small green dot "Подключён"; masked token field label "API-токен" with only bullet dots and eye icon, quiet outline "Заменить токен". Under row muted "Последняя загрузка: 14 сентября, 10:20", subtle text link "Как получить токен". Never real token.
Section2 "Товары для анализа": small right aligned "Бесплатный · 3 из 3 товаров". Show confirmed selection as clean three-row list, not editable checkboxes: "Термокружка 350 мл" "Контейнер для хранения" "Органайзер для кухни", each with a small WB article label and faint lock at right. Explanation in small muted type "Набор подтверждён. Замена и добавление товаров пока недоступны." Important don't show edit/add SKU buttons or contradict fixed selection. Link "Условия тарифа" discreet.
Section3 "Данные для расчёта": 3 concise rows:
"Себестоимость" muted "Указана для 2 из 3 товаров" right outlined button "Заполнить"
"Дополнительные расходы" muted "Упаковка, услуги и внешнее продвижение" right text action "Добавить"
"Налоги" muted "Не настроены · пока не учтены в прибыли" right text action "Настроить"
Short quiet muted footnote "Данные можно внести вручную или загрузить файлом." No bogus profit calculation or business metric charts in settings. No huge warnings, progress dashboards.
Right column "Аккаунт": fields "Имя" filled "Александр"; "Email" filled "seller@example.com" illustrative; link "Изменить пароль". Then air, small horizontal divider, section "Оформление" compact segmented control "Светлая | Тёмная | Системная" light active. Then ample whitespace, bottom-right primary blue button "Сохранить изменения" and quiet "Отменить". This save only edits account and appearance; other actions have their own scoped forms. No billing prices invented, team management, notifications, AI insights. Buttons restrained height34-38px not giant. Match reference design vocabulary carefully. Russian text sharp and accurate. Overall calm single cohesive settings page, not four cards jammed in.
