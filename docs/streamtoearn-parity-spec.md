# ТЗ: функции уровня StreamToEarn в chlauncher

Рабочая спецификация для реализации. Написана так, чтобы сессия-исполнитель
могла начать кодить, не переоткрывая архитектуру. Порядок работ — §14,
открытые решения владельца — §15.

**Референс.** [StreamToEarn](https://streamtoearn.io/ru) — десктоп-приложение
для TikTok LIVE: подарки/лайки/подписки → действия в Minecraft, GTA V, RDR2 и
др. (82 игры). Ключевые слои продукта: **пресеты** (подарок → действие),
**алерты + платные прерывания**, **оверлеи** (авто-шпаргалка по пресету),
**чат в голос (TTS)**, **видео/GIF-триггеры**, **Gift Spinner**, **тарифы с
лимитами** (пресеты, события/пресет, «лимит заработка»), **управляемый
Minecraft-сервер** с мини-играми, **моды для сторонних игр**.

**Цель.** Добиться функционального паритета по слоям 1–8 силами собственного
кода chlauncher. Чужой код, ассеты, тексты, названия тарифов и бренд
StreamToEarn **не копируем** — только поведение.

---

## 0. Контекст исполнителю

### Что уже есть (main, ноябрь 2026)

| Слой StreamToEarn | В chlauncher сейчас | Где |
|---|---|---|
| Ловля событий TikTok | ✅ sidecar `tiktok-live-connector` → NDJSON → `RawStreamEvent` | `tools/tiktok-sidecar/index.js`, `integrations.rs` |
| Доп. источник донатов | ✅ DonationAlerts (Centrifugo) | `integrations.rs` |
| Пресеты «подарок → действие» | ✅ `TriggerRule`/`TriggerProfile`/`TriggerPreset`, built-in `steal-the-stream`, сохранение/применение | `types.rs`, `events.rs`, `commands.rs`, `MapperPage.tsx` |
| Каталог подарков с иконками | ✅ ~1.7k подарков офлайн | `apps/launcher/public/gifts.json`, `GiftPicker.tsx` |
| Тест события без эфира | ✅ симулятор (страница) | `SimulatorPage.tsx`, `simulate_event` |
| Оверлей | ⚠️ один встроенный HTML: алерт-баннер + лента + топ | `overlay.rs` (`OVERLAY_HTML`) |
| Шпаргалка по пресету | ⚠️ только статичный PNG-постер | `MapperPage.tsx` (`downloadPoster`) |
| Алерты с очередью/приоритетом/прерываниями | ❌ | — |
| Кулдауны | ❌ (правило = `min_amount` + `multiplier`) | — |
| Видео/GIF/звук на событие | ❌ | — |
| TTS | ❌ | — |
| Gift Spinner | ❌ | — |
| Тарифы/лимиты | ⚠️ один тариф: 30 дней, гейт загрузки/запуска | `apps/server/src/subscriptions.js`, `billing.js` |
| Minecraft | ⚠️ внешний сервер через `tools/mc-bridge` (relay → RCON) | `tools/mc-bridge/`, `forwarder.rs` |
| Roblox | ✅ relay + poll | `docs/roblox-integration.md` |
| Моды GTA V / RDR2 / … | ❌ | — |

### Текущий конвейер событий

```text
sidecar/DA/simulator ─► mpsc RawStreamEvent ─► mapper_loop (lib.rs)
   └► TriggerMapper::map (first match wins) ─► EventHub::dispatch
          ├► game_ws.rs  (локальный WS для игр на tiktok-game-sdk)
          ├► overlay.rs  (Browser Source /overlay + /ws)
          ├► forwarder.rs (HTTP relay → Roblox / mc-bridge)
          └► app.emit("stream-event") → React-лента
```

Важные факты из кода, на которые опирается спека:

- Подарок от sidecar: `amount = diamondCount × repeatCount` (монеты),
  стрик схлопывается в одно событие (`repeatEnd`). **Количество штук
  (`repeatCount`) сейчас теряется** — нужно для «N роз → N зомби» (§1.1).
- Лайк: `amount = likeCount` пачки (TikTok шлёт пачками), т.е. «100 лайков →
  действие» сейчас срабатывает только если одна пачка ≥100. Нужен накопитель (§2.3).
- `mapper_loop` держит `Mutex<SettingsStore>` на каждое событие — новый
  планировщик не должен делать I/O под этим локом.
- Overlay-сервер слушает `127.0.0.1:0` (loopback, OS-порт) — все новые
  оверлей-страницы живут на нём же.
- Тесты `chlauncher_lib` на Windows-GNU не грузятся (см. README «Known
  limitations») — логику нового движка выносить в чистые модули без
  Tauri-зависимостей, тестировать `cargo test` на Linux CI.

### Среда и команды

- Node ≥ 22.5, Rust stable (MSVC для релиза, GNU локально), Windows 10/11 + WebView2.
- `npm run test:server`, `npm run build --workspace @chlauncher/launcher`,
  `cargo clippy --all-targets -- -D warnings` в `apps/launcher/src-tauri`,
  `cargo test --workspace`, `cargo fmt --check` — всё это гоняет CI (`.github/workflows/ci.yml`).
- E2E лаунчера: `tools/e2e-cdp.mjs`.

### Конвенции

- Все новые поля в сериализуемых структурах — `#[serde(default)]`, чтобы
  старые `settings.json` и пресеты грузились без миграции.
- TS-зеркала типов — `apps/launcher/src/types.ts` (snake_case как в serde).
- Ошибки IPC — `Result<T, String>` с читаемым русским текстом; серверные
  коды `{error: CODE}` маппятся в `errorMessages.ts`.
- Логи без токенов, ключей, HWID, ников зрителей в info-уровне не дублировать сверх нужного.
- Один этап §14 = один PR, короткие imperative-коммиты как в `git log`.

---

## 1. Модель данных

### 1.1. `RawStreamEvent` (+ sidecar)

Добавить (все `#[serde(default)]`):

| Поле | Тип | Смысл |
|---|---|---|
| `count` | `i32` | Штук в событии: `repeatCount` подарка, `likeCount` пачки, 1 для прочего |
| `coins` | `i64` | Стоимость события в монетах TikTok (`diamondCount × repeatCount`); 0 для бесплатных |
| `gift_id` | `Option<i64>` | ID подарка (устойчив к переводу имени) |
| `ts_ms` | `u64` | Время прихода в лаунчер |

`amount` оставить как есть (обратная совместимость с играми/relay).
`tools/tiktok-sidecar/index.js`: в `ev()` прокинуть `count`/`coins`/`gift_id`.
DonationAlerts: `count=1`, `coins` = сумма, пересчитанная по курсу из
настроек (`da_coins_per_rub`, по умолчанию 0 → не считается в лимит, §8.4).

### 1.2. `TriggerRule` — расширение

| Поле | Тип / default | Смысл |
|---|---|---|
| `enabled` | `bool` / `true` | Выключить правило, не удаляя |
| `label` | `String` / `""` | Человекочитаемое имя действия для оверлея/постера («Спавн зомби») |
| `description` | `String` / `""` | Подпись для шаблона «только описание» (§5) |
| `image` | `Option<MediaRef>` | Картинка действия для оверлея |
| `match_mode` | `"contains" \| "exact" \| "gift_id"` / `"contains"` | Сейчас неявный `contains`; `exact` нужен, чтобы «Rose» не ловил «Rose Bear» |
| `repeat` | `"once" \| "per_unit"` / `"once"` | `per_unit`: N подарков → N срабатываний |
| `max_repeat` | `u32` / `20` | Потолок `per_unit` за одно событие |
| `every_n` | `u32` / `0` | Накопитель: срабатывать за каждые N единиц (лайки, §2.3); 0 = выкл |
| `cooldown_ms` | `u64` / `0` | Кулдаун правила |
| `user_cooldown_ms` | `u64` / `0` | Кулдаун на одного зрителя |
| `priority` | `i32` / `0` | Приоритет в очереди (§3) |
| `interrupt` | `bool` / `false` | Платное прерывание (§3.3) |
| `interrupt_preset` | `Option<String>` | Пресет, который включается на время прерывания (§3.3) |
| `interrupt_duration_ms` | `u64` / `60000` | Сколько длится «чужой» пресет |
| `alert` | `Option<AlertSpec>` | Алерт/звук/медиа (§3, §4) |
| `tts` | `Option<TtsRuleSpec>` | Озвучить событие (§6) |
| `spinner` | `Option<String>` | Имя пула спиннера вместо `action` (§7) |
| `delay_ms` | `u64` / `0` | Отложенный запуск действия |
| `continue_matching` | `bool` / `false` | Не останавливать перебор после совпадения (несколько эффектов на один подарок) |

`MediaRef = { id: String }` — ссылка на файл из медиатеки (§4.1).

`AlertSpec`:

```jsonc
{
  "text": "{user} призвал зомби ×{count}",   // плейсхолдеры: {user} {gift} {count} {coins} {action} {label}
  "duration_ms": 4000,
  "sound": { "id": "media-uuid", "volume": 0.8 } | null,
  "media": { "id": "media-uuid", "fit": "contain", "volume": 1.0 } | null, // video/gif/png/webp
  "position": "top" | "center" | "bottom",
  "style": "default" | "minimal" | "big"
}
```

### 1.3. `TriggerProfile` / `TriggerPreset`

- Добавить `overlay: OverlayStyle` (`#[serde(default)]`) — шаблон и стиль
  оверлея пресета (§5.2).
- Добавить `global_cooldown_ms: u64` — минимум между любыми двумя действиями профиля.
- `TriggerPreset` получает те же поля + `game_hint: Option<String>`
  (для какой игры пресет, фильтр в UI) + `version: u32` (на будущее для импорта/экспорта).

### 1.4. `Settings`

Новые секции (`#[serde(default)]`):

```rust
pub alerts: AlertSettings,      // master on/off, queue_max, default_duration_ms, volume
pub tts: TtsSettings,           // §6.2
pub spinners: HashMap<String, SpinnerPool>, // §7
pub media: Vec<MediaItem>,      // индекс медиатеки §4.1
pub overlay_token: String,      // §5.4, генерится при первом старте
pub da_coins_per_rub: f32,
```

### 1.5. Импорт/экспорт пресетов

`export_trigger_preset(name) -> String` (JSON, без абсолютных путей; медиа
вкладываются как base64 только если суммарно ≤ 20 МБ, иначе ссылки
теряются с предупреждением) и `import_trigger_preset(json)`. Формат:
`{ "format": "chlauncher-preset", "version": 1, "preset": {...}, "media": [...] }`.
Нужен для «делись с друзьями».

---

## 2. Движок действий (`ActionScheduler`)

Новый модуль `apps/launcher/src-tauri/src/scheduler.rs` — чистая логика без
Tauri, полностью покрыта `cargo test`. Встраивается в `mapper_loop`
между `TriggerMapper` и `EventHub::dispatch`.

```text
RawStreamEvent ─► TriggerMapper::match_all (Vec<&TriggerRule>)
   ─► Accumulators (every_n) ─► Cooldowns ─► EarnLimit (§8.4)
   ─► expand per_unit (≤ max_repeat) ─► ActionJob{rule, raw, n, priority, interrupt}
   ─► PriorityQueue ─► (delay/спиннер/алерт) ─► EventHub::dispatch(StreamEvent)
```

### 2.1. Сопоставление

`TriggerMapper::map` сохраняется (обратная совместимость, тесты), добавляется
`match_all(raw, profile) -> Vec<&TriggerRule>`: идёт по правилам сверху
вниз, пропускает `enabled=false`, останавливается на первом совпадении без
`continue_matching`. `match_mode=exact` — сравнение без регистра целиком,
`gift_id` — по `raw.gift_id`.

### 2.2. Кулдауны

- Состояние: `HashMap<rule_id, Instant>` и `HashMap<(rule_id, user), Instant>`,
  плюс `last_any: Instant` для `global_cooldown_ms`.
- Событие, попавшее в кулдаун, **не ставится в очередь**, но пишется в ленту
  UI со статусом `skipped: cooldown` (стример видит, почему не сработало).
- Кулдауны сбрасываются при смене профиля/пресета.
- `user_cooldown`-карта чистится от записей старше 10 мин (защита памяти).

### 2.3. Накопители (`every_n`)

`HashMap<rule_id, u64>` — сумма `count`. При достижении `every_n` выпускается
`floor(sum / every_n)` срабатываний (с учётом `max_repeat`), остаток
переносится. Пользователь в итоговом событии — последний внёсший.
Сброс — при смене профиля и по кнопке «Сбросить счётчики» в UI.
Текущий прогресс отдаётся в оверлей (`progress`-кадр, §5.3) — «лайки: 63/100».

### 2.4. Очередь

- `BinaryHeap` по `(priority desc, seq asc)`; ёмкость `alerts.queue_max`
  (default 200), при переполнении выбрасывается самая низкоприоритетная
  и считается в `dropped`.
- Исполнитель: одна tokio-задача. Действие для игры отправляется **сразу**,
  если у правила нет `alert`; если есть алерт — действие уходит в игру в
  момент показа алерта (синхронно с картинкой на экране).
- Алерты показываются последовательно: следующий — после `duration_ms`
  текущего (или раньше — при прерывании, §3.3).
- `delay_ms` — job откладывается таймером, в очереди не висит.

### 2.5. Пауза и тест

- IPC `scheduler_pause(bool)` — глобальная пауза («перерыв»): события
  копятся в очереди (или отбрасываются — настройка), действия не идут.
- IPC `test_rule(slug, rule_id)` — прогоняет правило через весь конвейер,
  **минуя кулдауны и лимит заработка**, `source="simulator"`. Кнопка ▶ у
  каждой строки маппера (аналог «тестируй каждое событие одним кликом»).

### 2.6. Телеметрия в UI

`get_scheduler_status` → `{ queued, running_alert, dropped, skipped_cooldown,
skipped_limit, paused, accumulators: [{rule_id, value, every_n}] }`;
UI опрашивает раз в 1 с только на открытой странице маппера.

---

## 3. Алерты и платные прерывания

### 3.1. Поведение

- Алерт = текст + (опц.) звук + (опц.) медиа, показывается на оверлее
  `/overlay/alerts` (§5.1) на `duration_ms`.
- Одновременно на экране максимум один алерт; остальные в очереди §2.4.
- Если `alert = None`, событие попадает только в ленту/игру (как сейчас).

### 3.2. Встроенный алерт по умолчанию

Глобальная настройка `alerts.default_for_gifts_from_coins` (default 0 = выкл):
подарки дороже порога получают дефолтный алерт без ручной настройки правила.

### 3.3. Прерывания (`interrupt = true`)

Семантика (по аналогии с «подарок ставит в очередь алерт, который заменяет
текущий пресет и даёт дарителю порулить»):

1. Текущий алерт обрывается (fade-out 200 мс), job прерывания идёт первым,
   независимо от `priority` обычных job'ов.
2. Если у правила задан `interrupt_preset: Option<String>` — профиль игры
   временно переключается на этот пресет на `interrupt_duration_ms`
   (default 60 000), затем автоматически возвращается. Во время
   «чужого» пресета на оверлее плашка «Рулит {user} — 0:42».
3. Пока активно прерывание, следующие прерывания встают в отдельную
   FIFO-очередь прерываний (не обрывают друг друга); `interrupt_cooldown_ms`
   на профиль (default 30 000) — защита от каскадов.
4. Временное переключение пресета **не сохраняется** в `settings.json`
   (крах лаунчера не должен оставить «чужой» пресет навсегда).

### 3.4. UI

В строке маппера — иконка 🔔 открывает drawer «Алерт»: текст с
плейсхолдерами и превью, выбор звука/медиа из медиатеки, длительность,
позиция, приоритет, чекбокс «Прерывание» + выбор пресета прерывания.
Кнопка «Показать на оверлее» = `test_rule`.

---

## 4. Медиа-триггеры (видео / GIF / звук)

### 4.1. Медиатека

- Файлы копируются в `%APPDATA%/com.chlauncher.app/media/<uuid>.<ext>`;
  индекс — `settings.media: Vec<MediaItem{ id, name, kind, ext, size, duration_ms }>`.
- Разрешённые форматы (проверка по magic bytes, не по расширению):
  `mp4 (H.264/AAC)`, `webm`, `gif`, `png`, `webp`, `jpg`, `mp3`, `ogg`, `wav`.
- Лимиты: файл ≤ 50 МБ, видео ≤ 30 с, медиатека ≤ 2 ГБ.
- IPC: `media_import(path) -> MediaItem` (через диалог `tauri-plugin-dialog` — новая зависимость),
  `media_list`, `media_delete(id)` (отказ, если файл используется
  правилом — вернуть список правил), `media_rename`.
- Раздача: overlay-сервер, `GET /media/:id` — только id из индекса
  (UUID-регэксп), без путей от клиента → нет traversal. Поддержка `Range`
  (видео в Chromium/CEF без Range не перематывается и иногда не играет) —
  добавить зависимость `tower-http` (feature `fs`), `ServeFile` это умеет.

### 4.2. Поведение

- Видео/GIF показываются в зоне алерта поверх/вместо текста (`fit`).
- Звук без медиа — проигрывается в оверлее (`<audio>`); громкость =
  `rule.volume × alerts.volume`.
- Если файл удалён с диска — алерт показывается без медиа, в лог warn.

### 4.3. Важно про звук

TikTok LIVE Studio / OBS захватывают звук Browser Source, только если в
источнике включено «управлять звуком» — в UI интеграции оверлея дать
подсказку. Альтернатива (настройка `alerts.audio_output = "overlay" | "device"`):
проигрывание через лаунчер на устройство вывода (крейт `rodio`) — тогда
захват через «Звук рабочего стола». Default: `overlay`.

---

## 5. Оверлеи

### 5.1. Маршруты overlay-сервера (`overlay.rs`)

Встроенный HTML разнести по файлам `apps/launcher/src-tauri/overlay/*.html`
и вшивать `include_str!` (по-прежнему без внешних зависимостей и CDN).

| Маршрут | Назначение |
|---|---|
| `/overlay` | Существующий «всё в одном» (лента + топ + алерт) — не ломать |
| `/overlay/alerts` | Только алерты/медиа/звук (§3, §4), прозрачный фон |
| `/overlay/preset` | Шпаргалка активного пресета (§5.2) |
| `/overlay/spinner` | Колесо спиннера (§7) |
| `/overlay/tts` | Значок «🔊 озвучка» + субтитр текущей фразы (§6) |
| `/overlay/progress` | Прогресс накопителей и (опц.) цели по монетам |
| `/media/:id` | Файлы медиатеки (§4.1) |
| `/ws` | Общий WS; клиент подписывается на каналы (§5.3) |

Все маршруты принимают `?t=<overlay_token>` (§5.4) и параметры вида
`&scale=1.2&pos=right`.

### 5.2. Оверлей пресета — 3 шаблона

Автоматически строится из правил активного профиля (строки с `enabled`
и непустым `label` или `action`):

1. **cards** — сетка карточек: иконка подарка (из `gifts.json`/`public/gifts`,
   отдать через overlay-сервер `/gifts/*`) × количество → картинка
   действия (`rule.image`) + `label`.
2. **list** — компактный вертикальный список «🌹 1 → Спавн зомби».
3. **text** — «только описание»: `description`/`label` без артов.

`OverlayStyle { template, accent_color, bg_opacity, font_scale, border:
"none"|"thin"|"glow", columns, max_rows, rotate_ms }` — при `max_rows` меньше
числа правил список листается страницами каждые `rotate_ms`.

**Живое обновление.** `save_triggers`, `apply_trigger_preset` и прерывание
(§3.3) шлют в WS кадр `preset` — страница перерисовывается без
перезагрузки («обновляется, пока редактируешь»). Существующий PNG-постер
переиспользует тот же рендер-код (вынести в общий TS-модуль, собираемый Vite
в отдельный бандл для оверлея — либо оставить vanilla JS в обоих местах; решение исполнителя, но без расхождения вёрстки).

### 5.3. Протокол `/ws` (расширение `docs/protocol.md`)

Клиент после connect шлёт `{ "type": "subscribe", "channels": ["events","alerts","preset","spinner","tts","progress"] }`;
без `subscribe` — старое поведение (`snapshot` + `event`), чтобы не сломать `/overlay`.

```jsonc
{ "type": "alert",    "id": "…", "text": "…", "duration_ms": 4000, "sound": {"url": "/media/…", "volume": 0.8}, "media": {...}, "position": "top", "style": "default" }
{ "type": "alert_cancel", "id": "…" }                 // прерывание
{ "type": "preset",   "name": "…", "style": {...}, "rows": [{ "gift": "Rose", "gift_image": "/gifts/rose.webp", "count": 1, "coins": 1, "label": "…", "image": "/media/…" }] }
{ "type": "spinner",  "id": "…", "pool": "…", "segments": [{"label":"…","color":"#…"}], "result_index": 3, "spin_ms": 4500, "user": "…" }
{ "type": "tts",      "id": "…", "text": "…", "state": "start" | "end" }
{ "type": "progress", "items": [{ "rule_id": "…", "label": "…", "value": 63, "target": 100 }] }
{ "type": "takeover", "user": "…", "preset": "…", "until_ms": 1730000000000 } // §3.3
```

### 5.4. Доступ по ссылке

StreamToEarn даёт облачную ссылку. У нас оверлей локальный (`127.0.0.1`),
этого достаточно для TikTok LIVE Studio/OBS на той же машине.

- Добавить `overlay_token` (32 байта hex, генерация при первом старте,
  кнопка «Сменить ссылку») — без токена страницы отдают 403. Защищает от
  чтения оверлея другими локальными процессами/вкладками браузера.
- Порт сейчас `127.0.0.1:0` — меняется при каждом запуске, и стримеру
  приходится заново вставлять URL. Ввести `settings.overlay_port`
  (default `0` = как сейчас; в UI «Фиксированный порт», предлагать 9877,
  при занятом порте — фолбэк на 0 с баннером).
- Облачная ссылка (через relay) — **вне скоупа v1** (§15).

### 5.5. UI

Страница «Оверлеи» (новая вкладка или раздел Интеграций): список маршрутов
с кнопкой «Копировать ссылку», встроенный превью (`<iframe>` с тем же URL),
настройки `OverlayStyle` для активного профиля, кнопка «Тестовый алерт».

---

## 6. Чат в голос (TTS)

### 6.1. Движок

- v1: **Windows OneCore / SAPI** через WinRT
  `Windows.Media.SpeechSynthesis.SpeechSynthesizer` (крейт `windows`) —
  офлайн, бесплатно, голоса ru/en/uk/… уже есть в Windows 10/11; синтез в
  WAV-поток → проигрывание через `rodio` на выбранное устройство **или**
  отдача в оверлей `/tts/:id.wav` (настройка `tts.output = "device" | "overlay"`).
- Абстракция `trait TtsEngine { fn voices() ; fn synth(text, voice, rate, volume) -> Vec<u8> }`,
  чтобы позже добавить облачный движок (§15) без переделки.
- Очередь TTS отдельная от алертов (фразы не должны ждать 4 с алерта),
  но с опцией `tts.duck_alerts` — приглушать звук алертов во время речи.

### 6.2. Настройки `TtsSettings`

| Поле | Default | Смысл |
|---|---|---|
| `enabled` | `false` | Мастер-выключатель |
| `voice` | системный | ID голоса |
| `rate` / `volume` | `1.0` / `0.9` | |
| `read_comments` | `"off"` | `"off" \| "all" \| "prefix" \| "gifters"` |
| `comment_prefix` | `"!say "` | Для `prefix` |
| `gifters_min_coins` | `1` | Для `gifters`: читать комменты тех, кто задонатил ≥ N монет за стрим |
| `read_gifts` | `false` | Читать «{user} подарил {gift} ×{count}» |
| `gift_template` | `"{user} подарил {gift}"` | |
| `read_nickname` | `true` | Префикс «{user} пишет: » |
| `max_chars` | `200` | Обрезка |
| `cooldown_ms` / `user_cooldown_ms` | `3000` / `15000` | |
| `queue_max` | `20` | Переполнение → дроп старых |
| `blocklist` | `[]` | Слова/регэкспы → фраза не читается |
| `strip_links` / `strip_emoji` | `true` / `true` | |
| `mute_hotkey` | `"Ctrl+Shift+M"` | Глобальный хоткей (`tauri-plugin-global-shortcut`) |

Правило маппера с `tts: Some(TtsRuleSpec{ template, voice })` озвучивает
своё срабатывание независимо от `read_*` (например, «Лев → голос босса»).

### 6.3. Безопасность контента

Встроенный базовый фильтр мата/ссылок (список в ресурсах, ru+en), плюс
`blocklist`. Любой мьют (хоткей/кнопка) очищает очередь TTS мгновенно.
Значок на оверлее `/overlay/tts`, пока идёт речь, и красный «MUTED».

---

## 7. Gift Spinner (случайное событие)

- `SpinnerPool { name, segments: [{ label, action, weight: u32, color, alert: Option<AlertSpec> }], spin_ms: 4500 }`.
- Правило с `spinner: Some(pool)` вместо прямого `action`: scheduler выбирает
  сегмент взвешенно (`rand::distributions::WeightedIndex`, RNG
  инжектируемый — в тестах seed), шлёт в оверлей кадр `spinner` с
  `result_index`, через `spin_ms` диспатчит действие сегмента в игру и его алерт.
- Спины идут через общую очередь (§2.4) — два спина не крутятся одновременно.
- UI: редактор пулов (таблица сегментов, проценты считаются из весов), превью колеса.
- Оверлей: canvas-колесо, анимация замедления, остановка точно на
  `result_index` (результат решает лаунчер, не страница).

---

## 8. Тарифы и лимиты (сервер + лаунчер)

Сейчас: один тариф, 299 ₽ / 30 дней (`billing.js`, фикс-цена), подписка
гейтит загрузку игр (`games.js`), запуск (`license.js /verify`) и TikTok-подпись
(`tiktok.js`). Цены и названия тарифов ниже — **заглушки, решает владелец** (§15).

### 8.1. Модель

Миграция БД (следующая версия схемы в `db.js`):

```sql
CREATE TABLE plans (
  code          TEXT PRIMARY KEY,          -- 'free' | 'pro' | 'expert' | …
  title         TEXT NOT NULL,
  price_minor   INTEGER NOT NULL,          -- копейки
  currency      TEXT NOT NULL DEFAULT 'RUB',
  period_days   INTEGER NOT NULL DEFAULT 30,
  entitlements  TEXT NOT NULL,             -- JSON, см. 8.2
  active        INTEGER NOT NULL DEFAULT 1,
  sort          INTEGER NOT NULL DEFAULT 0
);
ALTER TABLE subscriptions ADD COLUMN plan_code TEXT NOT NULL DEFAULT 'pro';
ALTER TABLE payments      ADD COLUMN plan_code TEXT;
CREATE TABLE usage_monthly (
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month     TEXT NOT NULL,                 -- 'YYYY-MM' (UTC)
  coins     INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, month)
);
```

Существующие активные подписки мигрируют в `plan_code='pro'` (ничего не
теряют). Истёкшая подписка ≡ план `free`.

### 8.2. Entitlements (JSON в `plans.entitlements`)

```jsonc
{
  "max_presets": 3,
  "max_rules_per_preset": 12,
  "max_media_triggers": 5,
  "tts": false,
  "spinner": false,
  "custom_overlay_style": false,
  "interrupts": true,
  "earn_limit_coins_month": 5000,   // null = без лимита; 200 монет ≈ $1 по оценке StreamToEarn
  "paid_games": false,              // доступ к платным играм каталога
  "mc_premium_plugins": false
}
```

### 8.3. API

- `GET /api/plans` — публичный список активных планов.
- `GET /api/account/entitlements` → `{ plan, entitlements, usage: { month, coins } }`.
- `POST /api/billing/checkout { plan_code }` — цена из `plans`; `payments.plan_code`.
  Webhook активирует именно оплаченный план. Смена плана при активной
  подписке v1: новый план начинает действовать сразу, остаток дней старого
  **не** пересчитывается (просто +period_days) — упрощение, отметить в UI.
- `POST /api/usage/report { month, coins_delta, nonce }` — лаунчер шлёт
  каждые 60 с и при выходе; идемпотентность по `nonce` (таблица последних
  nonce или `UNIQUE`), rate-limit 2/мин, `coins_delta ≤ 1 000 000`.
- Админка: `POST /api/admin/users/:id/set-plan`, CRUD планов, колонка
  плана и usage в списке пользователей (`AdminPage.tsx`).
- Решение о гейте: `free` может запускать бесплатные игры (`games.is_free`,
  новая колонка) — иначе Free бессмыслен; платные — только при `paid_games`.

### 8.4. «Лимит заработка»

- Лаунчер считает `coins` всех **сработавших** платных событий
  (`raw.coins` из §1.1; тест/симулятор не считаются) в `UsageMeter`,
  кеширует entitlements (обновление раз в 10 мин и при старте).
- При `usage ≥ earn_limit` scheduler перестаёт выпускать **действия** по
  событиям с `coins > 0` (`skipped: limit`), бесплатные события работают,
  на главной баннер «Лимит месяца исчерпан — апгрейд».
- Честная оговорка: учёт клиентский, обходится патчем бинаря. Серверная
  защита возможна только для облачных игр (relay видит события) — для
  relay-пути добавить серверный подсчёт в v2 (§15).

### 8.5. Enforcement лимитов в лаунчере

`save_trigger_preset` / `save_triggers` / `media_import` / включение TTS и
спиннера проверяют entitlements и возвращают понятную ошибку
(`PLAN_LIMIT:max_presets` → «На тарифе Free — до 3 пресетов»). При даунгрейде
ничего не удаляется: лишние пресеты/правила помечаются «неактивны на
вашем тарифе» и не исполняются (первые N по порядку остаются рабочими).

### 8.6. UI

`SubscriptionPage.tsx` → сравнительная таблица планов из `/api/plans`,
текущий план, usage-бар «Заработано в этом месяце: 3 200 / 5 000 монет».

---

## 9. Управляемый Minecraft-сервер

Цель: «Запусти полноценный Minecraft-сервер внутри приложения» — без
ручной настройки RCON и без relay.

### 9.1. Компоненты

- `apps/launcher/src-tauri/src/minecraft/` — `java.rs`, `paper.rs`,
  `server.rs` (процесс), `rcon.rs` (клиент Source RCON на Rust, порт логики
  из `tools/mc-bridge/index.js`), `templates.rs`.
- Сервер живёт в `%APPDATA%/com.chlauncher.app/minecraft/<world-slug>/`.

### 9.2. Установка

1. **Java 21**: искать `java` в `PATH`/`JAVA_HOME`, проверять
   `java -version` ≥ 21; если нет — предложить скачать Temurin JRE 21 x64
   с Adoptium API (`api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jre/hotspot/normal/eclipse`),
   проверить SHA-256 из метаданных Adoptium, распаковать в `minecraft/runtime/`.
2. **Paper**: версия и билд через Fill API PaperMC (`fill.papermc.io/v3/…`;
   исполнитель сверяет актуальный эндпоинт с документацией PaperMC перед
   реализацией), проверка SHA-256 из ответа API. Mojang-jar не
   распространяем — Paperclip сам скачивает его при первом запуске.
3. **EULA**: показать текст-ссылку на Minecraft EULA и чекбокс; `eula=true`
   пишется только после явного согласия стримера.
4. `server.properties`: `enable-rcon=true`, `rcon.port` свободный,
   `rcon.password` — 24 случайных байта (хранить в settings, не в логах),
   `server-ip=` пусто, `online-mode` настраивается (default `true`).

### 9.3. Управление

- IPC: `mc_install`, `mc_start`, `mc_stop` (через RCON `stop`, по таймауту
  30 с — kill), `mc_status`, `mc_console(cmd)`, `mc_logs(since)`.
- UI «Minecraft»: статус, кнопки, живой лог консоли (стрим stdout через
  `app.emit`), поле команды, RAM (`-Xmx`, default 4G), версия MC, мир
  (создать/сбросить/бэкап zip).
- Интеграция с маппером: профиль `slug="minecraft"`, `action` правила =
  шаблон консольной команды (`summon zombie ~ ~ ~` с плейсхолдерами
  `{player} {user} {count} {amount} {gift}`, как в mc-bridge). Несколько
  команд — через `\n`. Scheduler шлёт их в RCON напрямую.
- **Безопасность шаблонов**: `{user}`/`{gift}` экранируются (ник зрителя —
  недоверенный ввод: убрать `\n`, `"`, `§`, ограничить `[A-Za-z0-9_.]` —
  иначе зритель с ником `x\nop @a` получит инъекцию команд).
- `mc-bridge` остаётся для внешних/удалённых серверов.

### 9.4. Мини-игры и плагины

- Каталог плагинов отдаёт наш сервер: `GET /api/mc/plugins` (имя, версия,
  sha256, `premium`), скачивание с гейтом по `mc_premium_plugins`.
- Каждая мини-игра (Bedrock, Sandbox, Survival, Farm, Parkour, KOTH) —
  **отдельный Java-плагин** Paper (отдельный репозиторий/модуль Gradle) +
  встроенный пресет правил под него. В этом ТЗ — только инфраструктура
  установки плагинов и один пилот: **Survival** (без плагина, на ванильных
  командах: `summon`, `effect`, `weather`, `give`, `tp`).
- Сторонние плагины с Modrinth/Hangar — v2 (§15).

---

## 10. Сторонние игры (GTA V, RDR2, Valheim, …)

Самый трудоёмкий слой: на каждую игру — свой мод. В рамках ТЗ —
**протокол адаптеров + один пилот**.

### 10.1. Протокол «внешний адаптер»

- Сейчас игры обязаны запускаться лаунчером с одноразовым токеном (DRM,
  `docs/protocol.md`). Чужую игру лаунчер не спавнит → новый тип клиента:
  в UI «Подключить мод» генерируется `adapter_key` (UUID, хранится в
  settings, отзываемый), мод читает его из своего конфига.
- Хендшейк в `game_ws.rs`: `{ "type": "hello_adapter", "key": "…", "game": "gta5", "protocol": 1 }`
  → `welcome`; дальше тот же поток `event`/`heartbeat`, что и у SDK-игр.
  Адаптеры не попадают под watchdog-kill (процесс не наш).
- Опц. обратный канал: `{ "type": "ack", "event_id": "…", "ok": true }` —
  чтобы лента UI показывала «выполнено в игре». Для этого
  `StreamEvent` получает `event_id` (`#[serde(default)]`).
- `adapter_manifest.json` в каталоге: `{ game, actions: [{ id, label, params }] }`
  — UI маппера показывает выпадающий список действий вместо свободного текста
  (аналог «для GTA V — выбирай из библиотеки функций»).

### 10.2. Пилот (выбрать один, §15)

| Игра | Мод-платформа | Плюсы / риски |
|---|---|---|
| **Valheim** | BepInEx 5 (C#) | Простой моддинг, нет античита в соло |
| **GTA V (Story Mode)** | ScriptHookV + ScriptHookVDotNet (C#) | Самая популярная; **только одиночный режим**, онлайн → бан |
| **7 Days to Die** | телнет-консоль выделенного сервера | Без мода вообще, как RCON у Minecraft |
| **Left 4 Dead 2** | локальный listen-сервер + `rcon`/SourceMod | Быстро, но ограничено командами |

Игры с онлайн-античитом (EAC/BattlEye в онлайне) — не поддерживаем;
в UI предупреждение «только одиночный режим / свой сервер».

### 10.3. Распространение модов

Моды публикуются как обычные «игры» каталога с `kind='adapter'`
(новая колонка `games.kind`, default `'game'`): лаунчер скачивает zip,
показывает инструкцию установки (путь к папке игры выбирает стример), сам
ничего не копирует в чужую игру без подтверждения.

---

## 11. Сводка изменений UI

| Где | Что |
|---|---|
| `MapperPage.tsx` | Колонки: вкл/выкл, label, кулдаун, приоритет, повтор; ▶ тест; 🔔 drawer алерта; 🎡 выбор пула; 🔊 TTS; импорт/экспорт пресета; статус scheduler'а и счётчики |
| Новый `OverlaysPage.tsx` | Ссылки, превью, стиль пресета, фикс-порт, смена токена |
| Новый `MediaPage.tsx` (или раздел Оверлеев) | Медиатека: импорт, превью, удаление, где используется |
| Новый `TtsPage.tsx` (или раздел Интеграций) | §6.2 + тест голоса |
| Новый `SpinnerPage.tsx` | Редактор пулов |
| Новый `MinecraftPage.tsx` | §9.3 |
| `SubscriptionPage.tsx` | Планы, usage |
| `Header.tsx` | Индикаторы: пауза, MUTED, лимит |
| `EventFeed.tsx` | Статусы `skipped: cooldown/limit`, `queued`, `done` |

Весь UI на русском, как существующий.

---

## 12. Нефункциональные требования

- **Задержка**: событие sidecar → действие в игре ≤ 150 мс p95 без алерта
  (сейчас — один mpsc-хоп; не ухудшать).
- **Нагрузка**: 50 событий/с (лайк-шторм) без роста очереди сверх лимита и без
  блокировки UI; лайки агрегируются до планировщика.
- **Персистентность**: накопители и кулдауны — в памяти (сброс при
  рестарте допустим); usage — в памяти + сброс в `usage_pending.json` раз в
  60 с, чтобы крах не терял учёт.
- **Безопасность**: overlay только loopback + токен; `/media/:id` только по UUID
  из индекса; RCON-пароль/adapter_key не логируются; экранирование
  пользовательского ввода в MC-командах (§9.3) и в HTML оверлеев
  (`escapeHtml` уже есть — использовать везде, `innerHTML` с данными
  зрителей запрещён).
- **Новые зависимости** (Rust): `tower-http` (fs), `rand`, `rodio`,
  `windows` (SpeechSynthesis, только `cfg(windows)`),
  `tauri-plugin-dialog`, `tauri-plugin-global-shortcut`. Каждую — в
  стабильной, не свежевышедшей версии.
- **Совместимость**: старые `settings.json`, пресеты и игры на
  `tiktok-game-sdk` protocol 1 работают без изменений.
- **Юридическое**: не использовать бренд, тексты и ассеты StreamToEarn;
  `tools/fetch-gifts.mjs` сейчас скрейпит streamtoearn.io — проверить их
  условия использования или перейти на другой источник списка подарков
  (иконки и так с публичного CDN TikTok).

---

## 13. Тесты и приёмка

**Rust (`cargo test`, чистые модули):**

- `scheduler`: кулдаун правила/зрителя/глобальный; `every_n` с переносом
  остатка; `per_unit` с `max_repeat`; приоритет и FIFO внутри приоритета;
  переполнение очереди; прерывание обрывает текущий алерт и возвращает
  пресет по таймеру; пауза; лимит заработка блокирует только `coins>0`;
  `test_rule` игнорирует кулдауны и лимит.
- `match_all`: `exact`/`contains`/`gift_id`, `continue_matching`, `enabled=false`.
- `spinner`: распределение по весам на seed-RNG (χ²-проверка не нужна —
  детерминированные ожидания на фиксированном seed).
- `rcon`: кодек пакетов; экранирование шаблонов (ник с `\n`, `"`, `§`).
- serde: старый `settings.json` из `main` десериализуется без ошибок (фикстура).

**Сервер (`node --test`, `app.inject`):** планы и entitlements; checkout с
`plan_code`; webhook активирует нужный план; usage-report идемпотентен по
nonce и rate-limited; set-plan в админке + audit; free-план качает только
`is_free` игры.

**E2E (`tools/e2e-cdp.mjs` + ручной прогон):** симулятор «Роза ×5» с
`per_unit` → 5 действий в mock-game и 1 алерт ×5 на `/overlay/alerts`;
правка пресета → `/overlay/preset` перерисовался без reload; спиннер
останавливается на сегменте, который пришёл в игру; TTS читает `!say привет`
и молчит после хоткея; Minecraft: установка → старт → «Роза» → зомби в мире.

**Приёмка владельцем:** реальный эфир TikTok ≥ 30 мин с пресетом на
mock-game и Minecraft, без зависаний очереди.

---

## 14. Порядок работ (чеклист исполнителя)

| # | Этап | Файлы | Готово, когда |
|---|---|---|---|
| 1 | Модель данных §1 + sidecar `count/coins/gift_id` + TS-зеркала | `types.rs`, `types.ts`, `settings.rs`, `tiktok-sidecar/index.js` | старые settings грузятся; CI зелёный |
| 2 | `ActionScheduler`: match_all, кулдауны, накопители, per_unit, очередь, пауза, `test_rule` | `scheduler.rs`, `lib.rs`, `commands.rs` | unit-тесты §13 |
| 3 | Маппер-UI: новые колонки, ▶ тест, статусы в ленте | `MapperPage.tsx`, `EventFeed.tsx`, `api.ts` | ручной прогон через симулятор |
| 4 | Оверлей-сервер: файлы, `subscribe`-протокол, токен, фикс-порт, `/overlay/alerts` | `overlay.rs`, `overlay/*.html`, `docs/protocol.md` | `/overlay` старый работает; алерты идут |
| 5 | Алерты + прерывания | `scheduler.rs`, drawer в маппере | тесты прерываний; e2e |
| 6 | Медиатека + видео/GIF/звук | `media.rs`, `MediaPage.tsx`, `overlay.rs` | mp4/gif/mp3 играют в TikTok LIVE Studio |
| 7 | Оверлей пресета (3 шаблона, live-update), общий рендер с PNG | `overlay/preset.html`, `OverlaysPage.tsx` | правка → перерисовка |
| 8 | TTS | `tts.rs`, `TtsPage.tsx` | голос, фильтры, хоткей |
| 9 | Gift Spinner | `scheduler.rs`, `overlay/spinner.html`, `SpinnerPage.tsx` | e2e спина |
| 10 | Тарифы: БД, API, админка, entitlements в лаунчере, usage | `db.js`, `routes/*`, `AdminPage.tsx`, `SubscriptionPage.tsx`, `usage.rs` | серверные тесты §13 |
| 11 | Minecraft: Java/Paper/EULA/RCON/консоль + пресет Survival | `minecraft/*`, `MinecraftPage.tsx` | Роза → зомби |
| 12 | Каталог MC-плагинов + первый свой плагин | `routes/mc.js`, отдельный репо плагина | установка из лаунчера |
| 13 | Протокол адаптеров + пилотный мод | `game_ws.rs`, `docs/protocol.md`, репо мода | событие из эфира → действие в пилотной игре |

Этапы 1–9 не зависят от сервера и решений по ценам; 10 можно вести
параллельно после ответа на §15.1. Каждый этап — отдельный PR с обновлением
README/`docs/` в той же ветке.

---

## 15. Открытые решения владельца

1. **Тарифы**: список планов, цены в ₽, лимиты из §8.2, будет ли Free с
   бесплатными играми, нужен ли «лимит заработка» вообще (это модель
   StreamToEarn; можно обойтись только лимитами функций).
2. **TTS**: хватит ли системных голосов Windows или нужен облачный
   (Yandex SpeechKit / Azure / ElevenLabs — платно, нужен ключ и серверный прокси).
3. **Облачная ссылка на оверлей** через relay (для стрима с другого ПК) — делать ли в v1.
4. **Пилотная сторонняя игра** (§10.2).
5. **Мини-игры Minecraft**: кто пишет Java-плагины (отдельная работа), какие первыми.
6. **Источник каталога подарков** вместо скрейпа streamtoearn.io (§12).
7. **Серверный учёт лимита** для relay-пути (§8.4) — v1 или v2.
