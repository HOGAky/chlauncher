# Интеграция chlauncher ↔ Roblox («Steal the Stream»)

Roblox-игра получает `StreamEvent`'ы стримера (подарки/лайки →
`action_command`), но не может подключиться к лаунчеру напрямую:

- у Roblox **нет WebSocket-клиента** — только исходящий `HttpService`
- Roblox-сервер живёт в облаке Roblox → `ws://127.0.0.1:9876` недостижим
- игру нельзя заспавнить лаунчером как .exe

Канал: «лаунчер → `apps/server` (релей в БД) → Roblox поллит».

## A. HTTP-forward событий

`forwarder.rs` — консьюмер `EventHub.broadcast`:

- Каждый `StreamEvent` → `POST {forward_url}/api/stream/ingest`
- Авторизация — **JWT лаунчера** (`Authorization: Bearer`); сервер сам
  знает подписку и ключ стримера. `X-Stream-Key` шлётся только если
  задан — совместимость со standalone-релеем
- `forward_url` пустой → используется базовый URL `apps/server` —
  отдельный релей в проде не нужен
- Настройки: `forward.{enabled, forward_url, stream_key,
  relay_admin_secret, roblox_place_id, local_bridge, local_bridge_port}`
- Очередь 500 событий, drop-oldest, таймаут 5 с — падение сервера не
  ломает локальный пайплайн; метрики `queued/dropped/delivered/last_error`
- Фильтр: форвардятся только `type:"event"`

## B. Релей внутри apps/server (прод)

`routes/stream.js` + миграция v15 (`stream_keys`, `stream_tickets`,
`stream_events`, `stream_rooms` в SQLite — очереди и курсоры переживают
рестарт и деплой). Отдельный сервис не нужен.

| Метод | Путь | Кто | Что делает |
|---|---|---|---|
| `POST` | `/api/stream/key` | лаунчер (JWT) | выдать/показать stream key; plaintext отдаётся один раз при создании, в БД — SHA-256 |
| `POST` | `/api/stream/key/rotate` | лаунчер (JWT) | ротация: старый ключ и Roblox-привязка умирают |
| `POST` | `/api/stream/ticket` | лаунчер (JWT) | одноразовый launch-тикет (TTL ~5 мин) |
| `POST` | `/api/stream/redeem` | Roblox-сервер | `{ticket, roblox_user_id}` → `{stream_key}` — комнатный credential, бинд UserId |
| `POST` | `/api/stream/ingest` | лаунчер (JWT) или `X-Stream-Key` | событие в очередь (cap 500/ключ, TTL 60 с) |
| `GET` | `/api/stream/events?since=` | Roblox | `X-Stream-Key` (предпочтительно) или `?key=` → `{cursor, events[]}` |
| `POST` | `/api/stream/claim` | Roblox-сервер румы | `{stream_key, job_id}`; занято → 409 |
| `POST` | `/api/stream/release` | Roblox-сервер | отвязать при шатдауне |
| `POST` | `/api/stream/validate` | Roblox-сервер | ручной `!key` — бинд UserId |
| `GET` | `/api/stream/status` | лаунчер (JWT) | статус румы: claim, job_id, последний полл, глубина очереди |

- Подписка истекла → 402 `subscription_expired` на validate/poll/claim
- События в `stream_events` — AUTOINCREMENT id = монотонный курсор;
  номера не сбрасываются при рестарте
- Rate-limit на redeem/validate; plaintext-ключей в БД нет

Standalone-релей (`D:\roblox\relay`) остаётся для совместимости — тот же
протокол, авторизация по `X-Stream-Key`; в проде не нужен.

## C. Маппинг правил

Стример использует шаблон-профайл «steal-the-stream» (команда
`roblox_play`/карточка создаёт профиль `roblox-sts` автоматически) —
`action_command`'ы ложатся в whitelist игры: `spawn_chaser`,
`invert_controls`, `drop_floor`, `yeet`, `freeze`, `slow_field`,
`camera_spin`, `wall_ahead`, `decoy_clones`, `shield`, `speed_boost`,
`checkpoint`, `coin_rain`, `fireworks`, `score_drain`, `execute`,
`score_gift`, `start_game:<id>`.

## D. Ключ стримера и запуск без ручного ввода

`stream_key` — пропуск стримера: ingest-авторизация и вход в
стрим-руму. В проде руки стримера его не касаются:

1. «Играть» на карточке → лаунчер просит `POST /api/stream/ticket`
   (JWT, активная подписка) → одноразовый тикет на ~5 минут.
2. Тикет уезжает в deep-link:
   `roblox://experiences/start?placeId=…&launchData={"t":"<ticket>"}`
   (percent-encoded). Сам stream_key в URL не светится — тикет
   одноразовый и короткоживущий.
3. Сервер игры читает `Player:GetJoinData().LaunchData`
   (`StreamKeyService.TryRedeemLaunchData`) → `POST /api/stream/redeem`
   → комнатный credential + бинд к Roblox UserId. Кнопка «Start Stream»
   активна сразу — никакого `!key`.
4. Комнатный credential сессионный (не персистится в профиль игрока —
   сервер ротирует его при каждом запуске). Ручной ключ из
   `DataService.streamKey` остаётся запасным путём (`!key <key>`).

Анти-шеринг: бинд one-to-one (409 `bound_to_other_user`), сброс —
ротация ключа в лаунчере. Подписка на chlauncher = лицензия на
стрим-румы; робуксы стример не платит.

## E. Встроенный мост (режим разработчика)

Для разработки до релиза relay можно не поднимать: лаунчер сам отдаёт
тот же API на `localhost:8790` (`roblox_bridge.rs`).

- Режим разработчика = dev-сборка **или** роль `admin`. Только в нём
  видна dev-часть карточки и работают `roblox_bridge_*`/`roblox_dev_play`.
- Эндпоинты совпадают с серверным релеем, включая
  `POST /api/stream/redeem` (в dev любой тикет → dev stream key) —
  LaunchData-путь в Studio отрабатывает тем же кодом, что и прод.
- События — прямо из `EventHub`, без ingest-хопа. Очередь 500/60 с.
- Studio: `MOCK_RELAY = false` в `Config.lua`, `RELAY_URL` уже
  `http://localhost:8790` → Play; ручной fallback `!key <ключ>` +
  `!claim` работает.
- Опубликованный плейс крутится в облаке Roblox и localhost не видит —
  для него продовый путь B/D.

## F. Платный вход зрителей (игровая сторона)

- Зритель в лобби видит живые румы (`STS_StreamRooms` MemoryStore) и
  выбирает стримера; `RequestJoin(player, hostUserId)`.
- **Pre-check до покупки**: `CanJoinRoom` проверяет, что рума жива и
  `viewers < MAX_VIEWERS` (рума сама публикует счётчик в реестр) —
  робуксы не списываются за мёртвую/полную руму.
- Dev Product `ENTRY_PRODUCT_ID` — разовый вход; Game Pass
  `BACKSTAGE_PASS_ID` — постоянный доступ.
- Оплата → `entryCredit` в профиле игрока → телепорт. Телепорт упал →
  кредит сохраняется (`TeleportInitFailed` возвращает его), повторный
  вход бесплатный; успешный вход снимает кредит.
- Лишние зрители сверх `MAX_VIEWERS` возвращаются в лобби сервером румы.
- Робуксы идут владельцу experience через Roblox — лаунчер в этих
  деньгах не участвует.

## Схема

```text
TikTok/DA → integrations → TriggerMapper → EventHub ─┬─ game WS :9876
                                                     ├─ overlay :9877
                                                     └─ HTTP-forward (JWT)
                                                                    ▼
        apps/server /api/stream/*  ── stream_events (SQLite, TTL 60s)
        ticket → launchData ──► Roblox redeem → room credential      ▲
        Roblox reserved server: GET /events (X-Stream-Key) ──────────┘
        → EventManager → whitelist action_commands
```
