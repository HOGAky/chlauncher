# ТЗ: админка, публикация/обновление игр, начисление подписки

Рабочая спецификация для реализации. Написана так, чтобы сессия-исполнитель
могла начать кодить, не переоткрывая архитектуру. Порядок работ — §13.

Цели:
1. Добавление/обновление игр — только администраторам (2 человека).
2. Новые игры и апдейты доезжают до всех установленных лаунчеров
   автоматически — «как в нормальных лаунчерах».
3. Подписка продлевается двумя путями: **автоматически при оплате**
   (webhook платёжного провайдера) и **вручную из админки** (grant-days).

---

## 0. Контекст исполнителю

### Что уже есть и куда ложатся изменения

| Файл | Роль | Что менять |
|---|---|---|
| `apps/server/src/db.js` | Схема SQLite + query helpers. Сейчас `CREATE TABLE IF NOT EXISTS` + `seedGames()` | Миграции (§2), новые helpers |
| `apps/server/src/auth.js` | scrypt, JWT (`signToken` 30d), `makeAuthenticate` | claim `role`, `requireAdmin` |
| `apps/server/src/app.js` | Фабрика Fastify, регистрация роутов, `cors origin:true` | +`routes/admin.js` |
| `apps/server/src/routes/games.js` | `GET /api/games`, `GET /api/games/:slug/download` (гейт по подписке) | published-build join, sha256 в ответе |
| `apps/server/src/routes/billing.js` | `/subscription`, **открытые** `mock-pay`/`mock-expire`, webhook=501 | checkout+webhook (§5), моки за флагом |
| `apps/server/src/subscriptions.js` | `activateOrExtend(db,userId)` — жёстко +30 дней, `refreshSubscription`, `hasActiveSubscription`, `forceExpire` | параметр `days` (§5.1) |
| `apps/server/src/config.js` | env-конфиг, дефолтный JWT_SECRET | +`ADMIN_EMAILS`, `MAX_BUILD_SIZE` |
| `apps/server/static/games/` | Зипы игр, сейчас один файл `mock-game-0.1.0.zip` | раскладка `<slug>/<version>.zip` |
| `apps/launcher/src-tauri/src/api.rs` | REST-клиент, `ApiClient`, `AuthUser` | +поле `role`, +admin-методы |
| `apps/launcher/src-tauri/src/downloads.rs` | Скачивание zip → распаковка → `installed.json`; zip-slip уже защищён | sha256-verify, атомарная установка |
| `apps/launcher/src-tauri/src/commands.rs` | IPC-поверхность; `list_games` считает `update_available` через `!=` | semver-compare, poller, admin IPC |
| `apps/launcher/src/App.tsx` + `screens/` | Роутинг вкладок | вкладка «Управление» при `role='admin'` |
| `apps/launcher/src/pages/LibraryPage.tsx` | Бейдж «Обновление» уже отрисован | подписка на `catalog-changed` |
| `tools/` | Node-скрипты (e2e-cdp.mjs и т.п.) | +`publish-game.mjs`, +`grant-admin.mjs` |

### Среда и команды

- Node ≥ 22.5 (`node:sqlite`, `node --test`), Rust `stable-x86_64-pc-windows-gnu`
  (pinned `rust-toolchain.toml`), Windows.
- Тесты сервера: `npm run test:server` (= `node --test` в `apps/server`,
  in-memory DB, `app.inject` — без сокетов). Новые файлы тестов:
  `apps/server/test/admin.test.js`, `billing.test.js`.
- SDK-тесты: `cargo test -p tiktok-game-sdk`. Тесты `chlauncher_lib` на
  этой машине не грузятся (STATUS_ENTRYPOINT_NOT_FOUND, см. README) —
  проверка лаунчера через `tools/e2e-cdp.mjs` и ручной прогон.
- Дев-запуск: `npm run dev:server` → :8787; `npm run tauri:dev`.

### Конвенции проекта

- JS: ESM, JSDoc-хидеры у файлов, `{error: CODE}` в ответах, ISO-8601 UTC
  строки времени (лексикографически сортируемы — сравнение строками).
- Rust: команды возвращают `Result<T,String>` с юзер-читаемой строкой;
  серверные коды ошибок проксируются в UI как есть.
- Время подписки: `current_period_end` в ISO; «продление» = max(now, end)+days.

### Известные ограничения, которые спека учитывает

- Нет HTTPS и нет проверки целостности загрузок — sha256 из §4/§6 обязателен.
- `mock-pay`/`mock-expire` публично доступны — в проде гасить флагом (§5.5).
- Каталог сидится в `seedGames()` — удаляется миграцией §2.

---

## 1. Роли и доступ

### 1.1. Модель

- `users.role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin'))`.
- Админ — обычный аккаунт. Отдельных логинов/форм нет.
- Назначение:
  - env `ADMIN_EMAILS=a@x.com,b@y.com` — при register/login выставляется
    `role='admin'`, если email в списке (sync на каждый логин, не разово);
  - `tools/grant-admin.mjs <email>` — точечно без рестарта.
- JWT получает claim `role` (нужен фронту для вкладки), но сервер
  **не доверяет токену**: каждый admin-запрос читает `users.role` из БД.

### 1.2. Защита на сервере

- `requireAdmin` = `authenticate` + `SELECT role FROM users WHERE id=?`
  → 403 `FORBIDDEN`.
- Весь `/api/admin/*` под ним + rate-limit.
- `admin_audit (id, actor_id, action, target, meta JSON, created_at)` —
  пишется на каждую мутацию админки и на каждое начисление дней.

## 2. Схема БД (миграция v2)

Вводим `PRAGMA user_version` + массив линейных миграций в `db.js`
(`migrate(db)` при старте, идемпотентно). Текущее состояние = v1.

```sql
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'
  CHECK (role IN ('user','admin'));

CREATE TABLE game_builds (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id      INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  version      TEXT NOT NULL,
  file_name    TEXT NOT NULL,             -- относительный путь в static/games
  sha256       TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL,
  changelog    TEXT NOT NULL DEFAULT '',
  uploaded_by  INTEGER REFERENCES users(id),
  created_at   TEXT NOT NULL,
  UNIQUE(game_id, version)
);

ALTER TABLE games ADD COLUMN published_build_id INTEGER REFERENCES game_builds(id);
ALTER TABLE games ADD COLUMN status TEXT NOT NULL DEFAULT 'published'
  CHECK (status IN ('draft','published','archived'));
ALTER TABLE games ADD COLUMN updated_at TEXT;
-- games.changelog уже нет: changelog живёт на build'е (история версий)

-- Единый журнал начислений подписки: и оплаты, и ручные гранты
CREATE TABLE payments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  provider     TEXT NOT NULL,             -- 'manual' | 'yookassa' | 'stripe'
  external_id  TEXT,                      -- id платежа у провайдера
  days         INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'succeeded'
                 CHECK (status IN ('pending','succeeded','failed','refunded')),
  actor_id     INTEGER REFERENCES users(id),  -- кто выдал вручную
  created_at   TEXT NOT NULL,
  UNIQUE(provider, external_id)           -- идемпотентность webhook'ов
);

CREATE TABLE admin_audit (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id   INTEGER NOT NULL REFERENCES users(id),
  action     TEXT NOT NULL,
  target     TEXT NOT NULL,
  meta       TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
```

Миграция данных: существующая строка `mock-game` → её zip переносится в
`static/games/mock-game/0.1.0.zip`, создаётся `game_builds`-запись,
`published_build_id` на неё. `seedGames()` удалить.

## 3. Admin API (`apps/server/src/routes/admin.js`)

Все под `requireAdmin`. Конвенции ошибок — `{error: CODE}`.

| Метод | Путь | Назначение |
|---|---|---|
| `GET` | `/api/admin/games` | Игры + builds (вкл. draft/archived) |
| `POST` | `/api/admin/games` | `{slug,title,description,executable_name}` → draft |
| `PATCH` | `/api/admin/games/:slug` | title/description/cover_image |
| `POST` | `/api/admin/games/:slug/builds` | `?version=X.Y.Z` + body `application/octet-stream`; sha256, атомарная запись `static/games/<slug>/<version>.zip`, changelog в теле формы |
| `POST` | `/api/admin/games/:slug/publish` | `{version}` → `published_build_id`, status=`published` |
| `POST` | `/api/admin/games/:slug/unpublish` | status → `archived` |
| `POST` | `/api/admin/games/:slug/rollback` | Копия предыдущего build'а как новой версии (§9.3) |
| `GET` | `/api/admin/users?query=` | Пользователи: email, hwid, подписка, платежи |
| `POST` | `/api/admin/users/:id/grant-days` | `{days, comment?}` → ручное продление (§5.2) |
| `POST` | `/api/admin/users/:id/reset-hwid` | Отвязка HWID без 7-дневного кулдауна |
| `GET` | `/api/admin/audit` | Последние 200 записей |

### Правила загрузки build'а

- Лимит тела `MAX_BUILD_SIZE` (дефолт 2 GB).
- До записи: zip открывается, `executable_name` есть в корне, нет `../`
  и абсолютных путей.
- `(slug, version)` занято → 409 `VERSION_EXISTS` (иммутабельность).
- Прерванная загрузка → tmp-файл удаляется.

## 4. Публичное API

`GET /api/games` → только `status='published'`, join на published build:

```json
{ "slug":"…","title":"…","description":"…","version":"1.2.0",
  "sha256":"…","size_bytes":12345,"executable_name":"…",
  "cover_image":"…","changelog":"…" }
```

`GET /api/games/:slug/download` → файл published build'а; гейт по
подписке без изменений.

`POST /api/auth/{register,login}` → `user.role` в ответе + claim в JWT.

## 5. Подписка: ручное и автоматическое продление

### 5.1. Рефактор домена

`activateOrExtend(db, userId)` → `activateOrExtend(db, userId, days=30)`.
Стекинг остаётся: база = `max(now, current_period_end)` если active.

Новый helper `recordPayment(db, {userId, provider, externalId, days,
actorId})` → строка в `payments` + `activateOrExtend` — вызывается и
webhook'ом, и админкой. Идемпотентность: повторный `(provider,
external_id)` → `INSERT OR IGNORE`, продление только при вставке.

### 5.2. Ручное (админка)

`POST /api/admin/users/:id/grant-days {days, comment?}`:

1. `recordPayment(provider='manual', days, actorId=admin.id)`;
2. audit `action='grant_days'`;
3. ответ — свежий `subscriptionView`.

Это рабочий способ продавать до подключения провайдера: оплата по
реквизитам → админ жмёт «+30».

### 5.3. Автоматическое (платёжный webhook)

Контракт, независимый от провайдера:

- `POST /api/billing/checkout` (auth) → `{payment_id, checkout_url}`:
  создаёт `payments(status='pending', external_id)` и отдаёт ссылку на
  оплату. Пока провайдер не подключён — 501 `PROVIDER_NOT_CONFIGURED`.
- `POST /api/billing/webhook` — публичный. Порядок: проверка подписи
  (`STRIPE_WEBHOOK_SECRET` / `YOOKASSA_SECRET_KEY` + IP-фильтр для
  YooKassa) → `payment.succeeded` → `recordPayment` по `external_id`
  (идемпотентно) → 200. `payment.canceled`/refund → `status` платежа,
  подписку не трогаем (спорные кейсы — вручную через админку).
- Провайдер v1 — **YooKassa** (аудитория RU): `YOOKASSA_SHOP_ID`,
  `YOOKASSA_SECRET_KEY`, проверка уведомлений по IP-подсетям ЮKassa +
  HTTP basic `shop_id:secret`. Stripe — тот же контракт, v1.1.
- `checkout` маппит `payment_id → user_id`, поэтому webhook не ищет
  юзера по email — строго по своей строке `payments`.

### 5.4. Поток «оплата → доступ»

```
Пользователь: лаунчер → checkout → открывает checkout_url в браузере
Провайдер:    оплата → webhook → payments.succeeded → +30 дней
Лаунчер:      GET /api/billing/subscription (кнопка «Проверить оплату»
              или полл 10 c после возврата в окно) → статус active
```

В `SubscriptionPage` — кнопка «Оплатить 30 дней» (checkout + открытие
ссылки через `tauri-plugin-shell`/shell.open) и «Я оплатил — проверить».

### 5.5. Моки

`mock-pay`/`mock-expire` остаются для e2e, но регистрируются только при
`ENABLE_MOCK_BILLING=1` или `NODE_ENV!=='production'`. e2e-сценарий
(`tools/e2e-cdp.mjs`, тесты) ставит флаг явно.

## 6. Лаунчер: ядро (Rust)

### 6.1. Верификация и атомарная установка (`downloads.rs`)

- Скачанный zip: инкрементальный SHA-256 → сверка с каталожным.
  Мисмач → удалить, `HASH_MISMATCH`. Без этого в прод не выкатывать.
- Установка: распаковка в `games/<slug>/.staging-<ver>/` → успех →
  `<slug>` → `.old`, staging → `<slug>`, `.old` удалить. Любое падение
  оставляет прошлую рабочую версию.
- `installed.json` += `sha256`.

### 6.2. Версии

`update_available = semver(cat) > semver(inst)` — заменить `!=` в
`commands.rs`. Парсер: `semver` уже есть в дереве зависимостей
(tauri) — переиспользовать; иначе триплет `u32` руками.

### 6.3. Авто-проверка обновлений

- Фоновая tokio-таска: `GET /api/games` каждые 10 мин + на фокус окна;
  дифф → `catalog-changed` на фронт → LibraryPage обновляет бейдж.
- `auto_update_games` в Settings (default off): игра не запущена →
  фоновое скачивание+установка, событие `game-updated`.
- Обновление запущенной игры — отложить до `game-exited` (очередь) или
  «Обновить» сначала делает `kill_game` с подтверждением в UI.

## 7. Админ-UI внутри лаунчера

`bootstrap` отдаёт `user.role`; при `admin` — вкладка **«Управление»**
(отдельный веб-сайт не делаем: 2 админа, переиспользуем auth и UI-кит).

- **Игры:** таблица slug/title/published/builds/status; «Новая игра»;
  на карточке — список builds (version, size, дата, автор), `Publish`,
  `Rollback`, `Unpublish`, поле changelog. «Загрузить build»: выбор zip +
  версия → прогресс (событие `build-upload-progress`), после — sha256.
- **Пользователи:** поиск по email; строка — email, маскed-hwid, статус,
  «до»; действия `+N дней` (с полем comment), `Отвязать HWID`. Под
  пользователем — история `payments` (ручные и авто начисления).
- Новые IPC в `commands.rs`: `admin_list_games`, `admin_create_game`,
  `admin_update_game`, `admin_upload_build(slug, version, path)`
  (reqwest-стрим файла), `admin_publish`, `admin_unpublish`,
  `admin_rollback`, `admin_list_users`, `admin_grant_days`,
  `admin_reset_hwid`, `admin_audit`. Все с обычным JWT; 403 решает сервер.

## 8. CLI-фолбэк

`tools/publish-game.mjs` — публикация из терминала/CI без лаунчера:

```bash
node tools/publish-game.mjs --server https://api.example.com \
  --email a@x.com --password … --slug my-game --version 1.2.0 \
  --zip ./dist/my-game.zip --changelog "…" --publish
```

login → upload build → publish. Используется в релиз-пайплайне игр
(`cargo build --release` → zip → publish).

## 9. Потоки

1. **Новая игра:** draft → build `1.0.0` → Publish → у лаунчеров
   карточка «Скачать» в течение ≤10 мин или при старте.
2. **Обновление:** build `1.0.1` → Publish → бейдж «Обновление» →
   «Обновить»/авто-режим → sha256-верификация → атомарная подмена.
   Сбой → старая версия цела.
3. **Откат:** прямой downgrade юзерам не доедет (semver вниз не
   триггерится), поэтому `rollback` на сервере = копия предыдущего
   build'а с `version = published.patch+1` → publish.
4. **Оплата:** §5.4. **Ручная выдача:** админ → `+N дней` → audit +
   `payments(provider='manual')` → у юзера статус active при следующем
   запросе подписки.

## 10. Ограничения v1 / out of scope

- Дельта-патчи — нет, zip целиком (игры маленькие).
- Автообновление самого лаунчера — отдельное ТЗ (`tauri-plugin-updater`).
- CDN/S3 — раздача через Fastify до роста нагрузки.
- Возвраты/рефанды — вручную через админку (provider='manual',
  отрицательных дней нет — только фиксация `status='refunded'`).
- Оба админа равноправны.

## 11. Тесты и приёмка

Сервер — новые `test/admin.test.js`, `test/billing.test.js` (inject,
in-memory):

- не-админ → 403 на `/api/admin/*`; `ADMIN_EMAILS` даёт роль на логине;
- upload→publish→catalog видит версию+sha256; download отдаёт published
  build; дубль версии → 409; unpublish скрывает; download по подписке;
- `grant-days`: +30 к expired и +30 к active (стекинг); audit записан;
  строка `payments(provider='manual')` создана;
- webhook: валидная подпись → succeeded → +30; повторный webhook с тем
  же `external_id` → не двоит дни; невалидная подпись → 401;
- `ENABLE_MOCK_BILLING` unset → `/mock-pay` 404.

Лаунчер: подмена zip → `HASH_MISMATCH` и старая версия цела; обрыв
скачивания → прежняя установка рабочая; `catalog-changed` будит бейдж.

E2E (`tools/e2e-cdp.mjs`): админ публикует `0.2.0` → лаунчер видит
Update → качает → запускает; `grant-days` вместо mock-pay в сценарии.

## 12. Зависимости от прод-чеклиста

До публичного выката: HTTPS, rate-limit `/api/admin/*` + `/api/auth/*`,
fail-fast на дефолтный `JWT_SECRET`, `ENABLE_MOCK_BILLING` unset.
Без HTTPS и sha256-верификации публикация exe — прямой вектор RCE.

## 13. Порядок работ (чеклист исполнителя)

| # | Этап | Файлы | Готово, когда |
|---|---|---|---|
| 1 | Миграции + role + requireAdmin + ADMIN_EMAILS + grant-admin.mjs | `db.js`, `auth.js`, `config.js`, `tools/` | тест: логин даёт role=admin |
| 2 | Admin games API + builds storage + audit | `routes/admin.js`, `games.js`, `app.js` | `admin.test.js` зелёный |
| 3 | Подписки: `days`-параметр, `payments`, `recordPayment`, grant-days | `subscriptions.js`, `db.js`, `admin.js` | `billing.test.js` (ручная часть) |
| 4 | Billing webhook-контракт + моки за флагом | `billing.js`, `config.js` | webhook-тесты; mock 404 без флага |
| 5 | Launcher core: sha256, атомарная установка, semver, poller | `downloads.rs`, `commands.rs`, `api.rs` | e2e update, hash-mismatch |
| 6 | Админ-UI: вкладка, upload-прогресс, users+grant | `App.tsx`, новые `pages/Admin*.tsx`, `api.ts` | ручной прогон publish→update |
| 7 | CLI `publish-game.mjs` | `tools/` | публикация из терминала |
| 8 | v1.1: auto_update toggle, changelog-UI, Stripe | — | — |

Каждый этап коммитится отдельно; стиль сообщений — как в `git log`
(короткий imperative, префикс области по желанию).
