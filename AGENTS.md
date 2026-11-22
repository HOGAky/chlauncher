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

## Автоконнект эфира

- `settings.tiktok_autoconnect` (Option, None=on) → при старте (lib.rs
  setup, задержка 3с) восстанавливается комната `tiktok_username`.
- `commands::sidecar_bootstrap()` — общий билдер stdin-конфига сайдкара
  (sign_url+JWT+session); используют `tiktok_connect`, старт-автоконнект и
  пост-захват реконнект. Поле ника принимает и URL эфира
  (`parse_tiktok_handle`: `tiktok.com/@user/live` → `user`).
- `open_tiktok_login` после захвата sessionid: ник из ответа сервера
  (`tiktok.username`, оба пути `ready`/`bound`) подставляется в
  `tiktok_username` если пусто → эмит `tiktok-username-changed`; коннект
  сам перезапускается (status Connecting/Error → retry той же комнаты,
  verified-ник → коннект если не Live/Connected).
- UI: тумблер автоподключения + CTA «Войти в TikTok и переподключить»
  на WAF/DEVICE_BLOCKED-сообщениях (IntegrationsPage); `expectConnect`
  — коннект из UI, если комната была Disconnected.
- Перепроверка при старте: после автоконнекта статус перечитывается
  каждые 10с до ~60с, до 3 попыток (Error/Disconnected → реконнект,
  зависший Connecting → респавн = новый ролл ноды + fetchIsLive).
- `IntegrationManager.tiktok_epoch` (AtomicU64) инкрементится на КАЖДЫЙ
  connect/disconnect; стартовый супервизор снимает эпоху после своего
  коннекта и выходит при её смене (или смене tiktok_username) — иначе
  ручной отключ/другая комната перебивались бы ретраями до ~3 минут.
- DonationAlerts: `run_da` эмитит `integration-status` live через
  AppHandle (без эмита бейдж висел «Подключение…»); HTTP-нога 20с,
  центрифуго-вотчдог 150с тишины → ошибка.
- EOF сайдкара мапится по exit-коду: ≠0 → Error("сайдкар завершился"),
  0 → Disconnected (сайдкар спроектирован «вечным», любой выход —
  аномалия). Ingest: шумные kind (like/join/share/follow/gift_tick) —
  `try_send` с дропом при переполнении 256-канала, важные — `send` с
  10с таймаутом: backpressure не должен душить ping-вотчдог.
- Сайдкар: `stdout.on('error')` → exit (EPIPE = лаунчер умер — иначе
  зомби-процесс с мёртвым WS); uncaught/unhandled → строка `error` +
  exit 1.
- Перепроверка онлайна в сайдкаре: `fetchIsLive()` раз в 60с при живом
  сокете (ловит эфир, завершённый без streamEnd); ping несёт `connected`
  (isConnected сокета) — лаунчер понижает Live→Connecting при мёртвом
  сокете. Таймеры сайдкара НЕ unref — stdin EOF после bootstrap-строки,
  иначе процесс умирал между ретраями wait-for-live.

## Игровые пакеты (game_packs.rs)

- Игра = папка `games/<slug>/`, лаунчер сканирует её сам (без правок
  кода): `public/games/` (встроенные, бандлятся в `resources/games`) +
  `<app-data>/games/` (drop-in пользователя, создаётся в `lib.rs::setup`).
  User-пакеты переопределяют bundled по id. СТАТИЧЕСКОГО реестра больше
  нет — `builtin_games::registry` = только папки (сортировка по title).
- ДВА типа пакетов (`game.json.type`):
  - `"pack"` (default) — полная локальная игра: `overlay.html` +
    `game.json` + свободные ассеты (`sprites/`, `sfx/`, `skin.json`…).
    Без `game.json` регистрируется по одному `*.html` (id = имя папки).
  - `"remote"` — папка-ССЫЛКА на опубликованный сервер: `game.json` без
    страницы, `launch:{"kind":"roblox","place_id":null}` диспетчерит
    запуск (roblox → существующий ticket + `roblox://` deep-link, мост
    `roblox_bridge.rs` для Studio dev). Пример — bundled
    `public/games/roblox_sts/`.
- Поля `game.json` (всё опционально): `id`, `type`, `title`, `desc`,
  `page`, `icon`, `window{w,h}` (default 420×640), `round_sec`, `volume`,
  `tts` (правило `/tts/say`), `launch{}`, `rules` (дефолтная таблица
  `BuiltinGameCfg.rules`), `hidden` (прототип вне каталога),
  `afk` (самоиграющая игра → вкладка «АФК-стримы» в Библиотеке).
- Пайплайн: `game_packs::scan/find` → `builtin_games::registry/exists/
  allowed_games/default_cfg` → `/overlay/game/{id}` (disk-страница;
  remote 404 естественно) → ассеты `/games-assets/<dir>/...` (user →
  bundled) → окно `open_overlay_window` (вайтлист = registry, размер из
  `window{}`). `game_start` для remote → `REMOTE_GAME`.
- Allow-list: user-пакеты и remote-записи обходят `interactive_games`
  (user — локальное дополнение, remote гейтится серверным ticket);
  bundled pack-игры гейтятся как раньше.
- Общий рантайм для страниц пакетов: `/gamekit.js` (WS-клиент + engine
  rules), `/games/cfg/{id}`, `/games/state.json`, `POST /games/report`,
  `POST /tts/say` — всё token-guarded через `?t=` из URL страницы.
- Каталог во фронте: `api.builtinGames()` → карточки на «Игры LIVE»
  (только pack, сессии+правила) и в «Библиотеке» (pack → capture-кнопки,
  `remote+launch.kind==="roblox"` → `RobloxCard`, прочий remote →
  generic-карточка «Серверная»).
- Голосовые модели тоже drop-in: Piper `<app-data>/piper/voices/*.onnx`
  (+`*.onnx.json`), RVC `tools/rvc-server/models/<name>/*.pth` — обе
  сканируются по папкам без регистрации в коде.

## Игра «Патрик, на капусту!» (patrick_cabbage)

- Пакет: `public/games/patrick/` — `game.json` (id=`patrick_cabbage`,
  окно 405×720, rules-таблица), `overlay.html` (9:16, 1080×1920
  letterbox, роут `/overlay/game/patrick_cabbage` → динамический),
  `skin.json`, `sprites/`, `sfx/`.
- Действия
  страницы: `nudge|small|mid|pet|rotten|vacuum|mega`. `match.contains`
  (подстрока в тексте, массив или строка) добавлен в
  `gamekit.js::Engine._match` — триггер «патрик» в чате.
- Ассеты → роут `/games-assets/{*path}` (корни: `<app-data>/games` →
  `public/games`; `bundled_dir`: env `CHLAUNCHER_GAMES_DIR` →
  `resources/games` → dev `public/games`), бандлятся через resources в
  tauri.conf.json. Отсутствующие png/mp3 НЕ ломают страницу —
  процедурные fallback (canvas + WebAudio).
- `POST /tts/say` (token-guarded) → `tts.speak_rule(rule, text)` —
  озвучка ника донатера; `rule` из поля `game` в теле или `tts` в
  `game.json` (default `"patrick"`), флаг `ttsDonorNames` в skin.json.
- Дебаг в окне игры: `Tab`/`D` — панель, `Space` лайк, `1..6` действия,
  `R` сброс. `gift_tick` пропускается, аватары из `ev.avatar_url`.
- DEV-панель (та же `Tab`/`D`, справа): установка аватарки персонажа —
  картинка даунскейлится до ≤512px и пишется в `<data>/games/patrick/
  sprites/custom.png` через `POST /games/asset` (token-guarded, body
  `{dir,path,data_b64}`, `null`=удалить, sniff magic-bytes, ≤4MiB,
  атомарная запись). `SPR.custom` перекрывает позные спрайты и
  процедурного кролика; «Сбросить» возвращает их.
- Голосовые слоты донатов (skin.json `sfx`): `patrick` — дешёвый донат
  (small), `kapustochka` — дорогой (mid/pet). Файлы кладутся в
  `<app-data>/games/patrick/sfx/` или bundled `sfx/`; отсутствие файла →
  синтез-фолбэк (как у остальных клипов).

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
- Мёртвый клайм больше не вечен: `redeem` и `validate` сбрасывают
  `claimed_job_id` (новый запуск = мёртвый сервер), а `claim` отдаёт
  комнату чужому job после 60с без poll-хартбита (`stream_rooms.
  last_seen_at`, `STALE_CLAIM_MS`). Регрессионный тест в
  `test/stream.test.js` («crashed server claim…»).
- Place ID: резолв `custom(settings.forward.roblox_place_id)` →
  `ticket/status.place_id` (env `ROBLOX_PLACE_ID` на бэкенде — источник
  правды после паблиша) → `CHLAUNCHER_ROBLOX_PLACE_ID` (env лаунчера,
  dev-фолбэк). Пустое поле в UI = официальный сервер; кастомный id —
  только для теста своей копии. `roblox_dev_play` фолбэк НЕ делает
  (пусто = тест в Studio).
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

## Анимации подарков (animbox)

- Правила `settings.anims: Vec<AnimRule>` (types.rs): `gift_name`/`gift_id`,
  `media_id` (медиатека, пусто = встроенная «рука из крана с розой»),
  `mode each|series`, `min_coins`, `duration_ms`, `volume`, `scale`,
  `position`, `cooldown_ms`. Команды: `get_anim_rules` / `save_anim_rules`.
- `GET /anim/cfg?t=` → `{rules, media:[{id,kind,ext}]}` (только id из правил).
- Виджет `public/widgets/animbox.html`: WS `raw` (bridge.js эмитит
  `io().on('raw')` — полный RawStreamEvent), очередь 1-за-раз, `?demo=1`
  крутит все правила, `?demo=<idx>` — одно; `each` слушает `gift`+`gift_tick`.
- UI: WidgetsPage → карточка «Анимации» (автосейв 800мс) + виджет animbox.

## settings.json — устойчивость

- `SettingsStore::load` терпит UTF-8 BOM (Notepad/PS-правки), `save()`
  делает снапшот `settings.json.bak` перед перезаписью.
- НЕ редактировать settings.json через PowerShell `Set-Content -Encoding UTF8`
  (PS5.1 пишет BOM). Править через python `encoding='utf-8'` или [IO.File]::WriteAllText.
