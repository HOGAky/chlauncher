# chlauncher — заметки для агентов

Монорепо: Tauri-лаунчер (`apps/launcher`), лицензионный бэкенд (`apps/server`),
Rust SDK (`packages/game-sdk`), тест-игра (`apps/mock-game`), TikTok-сайдкар
(`tools/tiktok-sidecar`).

## Сборка на этой машине (Windows)

- Тулчейн: `stable-x86_64-pc-windows-gnu` (directory override).
- `windres` нужен `tauri-winres` — лежит в `D:\DEVIN PROJECT\w64devkit\w64devkit\bin`
  (в PATH не прописан; добавлять в PATH вручную).
- ВАЖНО: путь проекта содержит пробел (`D:\DEVIN PROJECT\OZVYCHA CHAT`) —
  `windres` ломается на препроцессинге, если `OUT_DIR` тоже с пробелами.
  Поэтому собирать всегда с `CARGO_TARGET_DIR=D:\cargo-target\chlauncher`.

```powershell
$env:PATH = "D:\DEVIN PROJECT\w64devkit\w64devkit\bin;$env:PATH"
$env:CARGO_TARGET_DIR = "D:\cargo-target\chlauncher"
cargo check/test/build --manifest-path apps/launcher/src-tauri/Cargo.toml
```

## Локальный запуск (без хостинга)

```bash
npm run dev:server        # бэкенд :8787 (dev-дефолты, mock-billing включён)
npm run dev:launcher      # = tauri dev (vite :1420 + cargo run)
```

В лаунчере: регистрация/вход → «Подписка» → mock-pay (+30 дней Pro) — иначе
TTS заблокирован энтитлментом (`PLAN_LIMIT|tts`; free-план: `tts: false`).

## Сайдкар

Править `tools/tiktok-sidecar/index.js`, затем пересобрать бандл, который
`build.rs` копирует в ресурсы Tauri:

```bash
cd tools/tiktok-sidecar
node node_modules/esbuild/bin/esbuild index.js --bundle --platform=node \
  --target=node20 --outfile=dist/sidecar.js
```

Протокол stdout-NDJSON: `event_kind` `gift|gift_tick|like|comment|join|follow|
share|subscribe`, поля `vip|fan_level|is_moderator|is_superfan|gift_id|coins|count`.
`gift_tick` — промежуточные юниты серии подарков (coins=0, count=1) для звуковых
правил «каждый подарок»; маппер и трекеры его пропускают (`mapper_loop`).
`unique_id` — стабильный @username (коннектор 2.5: `user.displayId`, НЕ
`uniqueId`); `user` = nickname только для отображения. Whitelist/blacklist и
привязка аккаунта матчатся по обоим (`RawStreamEvent.unique_id`).

## TTS (паритет-спек §6)

- Движки: `edge` (msedge-tts, нейроголоса, сетевые) и `sapi` (PowerShell
  System.Speech, офлайн-фолбэк при ошибке Edge).
- Кастомные голоса `custom:*` (`tts.rs::CUSTOM_VOICES`) — пресеты
  «базовый голос × rate × pitch» поверх Edge; инжектируются в `tts_voices`.
- `TtsSettings.rules: Vec<TtsVoiceRule>` — гейт по уровню фан-клуба +
  bypass для модераторов/суперфанатов; пустой список = без гейта.
- `TtsSettings.gift_sounds: Vec<GiftSoundRule>` — звук из медиатеки
  (`/media/<id>`) или TTS-шаблон на подарок; режимы `each`/`series`.

## EFIR-таймер (efirtimer.rs)

- Движок: `src-tauri/src/efirtimer.rs` — стейт-машина таймера эфира
  (щит/реверс/руинер/буст/дебафф/штрафы/рулетки/бонус-прокрут).
  Рекурсии нет: очереди обрабатывает воркер, разбуженный `poke_queues()`
  (mpsc-сигнал, не await — иначе цикл типов E0391).
- Конфиг: `types.rs::EfirTimerCfg` (serde-имена camelCase, дефолты — обратная
  совместимость settings.json). Хранится в `settings.efirtimer`.
- WS-канал `timer` на `/ws`: кадры `snapshot|tick|alert|spin|bonus_roll|settings`.
  Виджеты: `public/widgets/efirtimer.html` (цифры+карточки),
  `efirroll.html` (лента 7.5с), `efirstats.html` (аптайм). Подписка
  `{"type":"subscribe","channels":["timer"]}`.
- Команды: `efirtimer_start/stop/pause/resume/status/manual`,
  `save_efirtimer_cfg`. UI — `pages/TimerPage.tsx` (Пульт + триггеры +
  рулетки-редактор + оформление + soundMap).
- Звуки: `cfg.soundMap[trigger] -> media id | EfirSoundSpec{media,
  trimStartMs,trimEndMs,volume}` -> `/media/<id>` в виджете; без маппинга —
  синтезированный сигнал. Громкость = `cfg.volume` × `spec.volume`.
- Кошельки: `cfg.donationMode="balance"` — монеты подарков копятся на
  балансе зрителя (`settings.efir_wallets`), чат-команды `!cmd [N]`
  (из `cfg.walletCommands[row_id]{command,price,sound}`) списывают цену и
  запускают триггер через `wallet_isolate()` (клон cfg с одним триггером).
  `!balance` — показать баланс. Row-id: `freeze|unfreeze|reverse|ruin|save|
  boost|debuff|settime|reset`, `roulette:<id>`, `penalty:<id>`, `custom:<id>`.
- Карты («ход судьбы»): `roulette.mode="cards"` — донатеру показывается
  колода (2–6 слотов), выбор цифрой в чате (`choiceTimeoutSeconds`),
  фреймы `card_choice{phase:start|reveal|cancel|commit}`; выбор за
  донатера с Пульта — `efirtimer_card_pick`. Один слот = одна карта.
- Импорт EFIR-экспорта: `efirtimer_import(json)` → `import_efir_export()`
  маппит settings-объект платного TIMER в `EfirTimerCfg` (команды, цены
  из cost подарков, карточные рулетки, target слотов, стили, uptime).
  Кнопка «Импорт EFIR-конфига» на TimerPage. Тест:
  `EFIR_IMPORT=<путь к json> cargo test import_real_export -- --nocapture`.
- Авторизованный WS (sessionid) требует env `WHITELIST_AUTHENTICATED_SESSION_ID_HOST` = хост активного `SignConfig.basePath` — сайдкар выставляет её сам (index.js); при любой ошибке session-auth сайдкар сбрасывает сессию и работает анонимно (не уходит в вечный retry).

- Авторизованный WS (sessionid) требует env WHITELIST_AUTHENTICATED_SESSION_ID_HOST = хост активного SignConfig.basePath — сайдкар выставляет её сам (index.js); при любой ошибке session-auth сайдкар сбрасывает сессию и работает анонимно (не уходит в вечный retry).

## Roblox «Steal the Stream»

- Исходники игры: `D:\roblox\game` (Rojo). Спека:
  `docs/roblox-integration.md`. Standalone relay `D:\roblox\relay`
  (не в git) — только совместимость/отладка.
- Продовый релей — `apps/server/src/routes/stream.js` + таблицы
  `stream_*` (миграция v15). Форвард идёт по JWT лаунчера, admin-секрет
  не нужен. Stream key сервер отдаёт plaintext один раз (БД — SHA-256).
- Запуск: «Играть» → `POST /api/stream/ticket` → тикет в `launchData`
  deep-link'а → игра `POST /redeem` → комнатный credential (сессионный,
  не персистится) → claim/poll. Запасной путь — `!key` в чате.
- Ключ в игре передаётся заголовком `X-Stream-Key` (не query) — иначе
  попадает в логи прокси. Первый полл после claim только синхронизирует
  курсор — историю очереди не реплеим.
- Встроенный мост `src-tauri/src/roblox_bridge.rs` — тот же API на
  `localhost:8790` для Studio. Dev-режим = `roblox_bridge::dev_mode()`
  (debug-сборка или role=admin), флаг `dev_mode` в bootstrap.
  Карточка — `components/RobloxCard.tsx` в Библиотеке (для всех; dev-
  часть — по флагу); профиль `roblox-sts` ← пресет `steal-the-stream`.
- Owner-only операции сервера (grant-days/set-plan/set-role/promo) —
  только для `OWNER_TG_IDS` (Telegram ID через `tg_bindings`); пустой
  список = legacy-режим любого admin + warning при старте.
- Следующий этап (не начат): Telegram-идентичность — ТЗ в
  `docs/tg-auth-spec.md` (подтверждение входа, баги B1-B11).
- Долгие `cargo test` запускать в фоне/подсессии — первая сборка тестов
  идёт минуты, пользователь не хочет ждать блокирующий вызов.

- ВАЖНО: tauri.conf.json копирует `tools/tiktok-sidecar/dist` в `<target>/debug|release/tiktok-sidecar/` при tauri build/dev — после пересборки бандла esbuild'ом обновлять и эту копию (или собирать через tauri), иначе лаунчер запускает СТАРЫЙ sidecar.js.
