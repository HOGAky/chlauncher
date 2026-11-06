# Требования: интеграция chlauncher ↔ Roblox («Steal the Stream»)

Документ-заказ для разработки chlauncher. Roblox-игра должна получать
`StreamEvent`'ы стримера (подарки/лайки → `action_command`), но не может
подключиться к лаунчеру напрямую:

- у Roblox **нет WebSocket-клиента** — только исходящий `HttpService`
- Roblox-сервер живёт в облаке Roblox → `ws://127.0.0.1:9876` недостижим
- игру нельзя заспавнить лаунчером как .exe

Значит нужен канал «лаунчер → облачный релей → Roblox поллит».

## Что требуется от chlauncher

### A. HTTP-forward событий (предпочтительно)

Новый консьюмер на `EventHub.broadcast` (рядом с game WS и overlay WS):

- Каждый `StreamEvent` → `POST {forward_url}` с JSON-телом события
- Заголовок авторизации: `X-Stream-Key: {stream_key}`
- Настройки в профиле стримера: `forward_url`, `stream_key`,
  `relay_admin_secret`, `enabled`
- Fire-and-forget с мини-очередью (~500 шт) и таймаутом 5 с — падение
  релея не должно ломать локальный пайплайн
- Фильтр: форвардить только `type:"event"`, heartbeat/system не нужны

Если форвард не успеваем — fallback без изменений лаунчера: отдельный
`roblox-bridge.exe`, подключающийся как игра по протоколу `ws://9876`
(`hello` с токеном → форвардит `event`-фреймы на релей). Но форвард
внутри лаунчера чище.

### B. Релей — standalone-сервис

Отдельный мини-сервис (новый проект, например `D:\roblox\relay`,
Node ≥22) — `apps/server` chlauncher **не трогаем**. Он не видит БД
подписок, поэтому валидность ключей пушит лаунчер (см. D).

In-memory очередь на стримера (TTL события 60 с, cap ~500/стример,
монотонный `since`-курсор); персистентность — только привязки ключей:

| Метод | Путь | Кто дёргает | Что делает |
|---|---|---|---|
| `POST` | `/api/stream/ingest` | лаунчер (X-Stream-Key) | положить событие в очередь |
| `GET` | `/api/stream/events?key=…&since=<cursor>` | Roblox, раз в 2–3 с | вернуть `{cursor, events[]}` |
| `POST` | `/api/stream/claim` | Roblox-сервер румы | `{stream_key, job_id}` привязка; занято → 409 |
| `POST` | `/api/stream/release` | Roblox-сервер | отвязать при шатдауне |
| `POST` | `/api/stream/validate` | Roblox-сервер | ключ + valid_until>now → bind UserId (см. D) |
| `POST` | `/api/admin/register` | лаунчер (X-Admin-Secret) | `{stream_key, valid_until}` upsert валидности |
| `POST` | `/api/admin/revoke` | админ | отозвать ключ |

- `stream_key` генерится в лаунчере (кнопка в UI) и регистрируется на
  релее через admin-эндпоинт; одним ключом авторизуются ingest и poll
- Ошибки: 401 невалидный ключ/секрет, 402 `subscription_expired`
  при `valid_until < now`, 409 на конфликтах claim/bind
- Rate-limit на `/validate`; `stream_key`/`ADMIN_SECRET` не логировать,
  ключи хранить хэшами

### C. Маппинг правил

Стример настраивает `TriggerRule`s так, чтобы `action_command` попадал
в whitelist игры: `spawn_chaser`, `invert_controls`, `drop_floor`,
`yeet`, `freeze`, `slow_field`, `camera_spin`, `wall_ahead`,
`decoy_clones`, `shield`, `speed_boost`, `checkpoint`, `coin_rain`,
`fireworks`, `start_game:<id>`. Полный список — `DESIGN.md` §5.7
в `D:\roblox`. Возможно, стоит шаблон-профайл правил «Steal the Stream»
в лаунчере, чтобы стример не вбивал вручную.

### D. Ключ стримера: доступ в руму + доставка событий

Один `stream_key` решает обе задачи — он же **пропуск стримера в игру**:

- Стример генерит `stream_key` в UI лаунчера (кнопка + «сбросить»);
  при включении форварда и далее при старте + раз в 12 ч, **пока
  подписка активна**, лаунчер пушит:
  `POST {forward_url}/api/admin/register`
  `{stream_key, valid_until = min(subscription_end, now + 24ч)}`
  с `X-Admin-Secret` (поле в настройках)
- Стример вводит ключ в Roblox-игре один раз → сервер игры дёргает
  `POST /api/stream/validate {stream_key, roblox_user_id}`:
  - релей проверяет: ключ известен и `valid_until > now`
  - при успехе ключ **биндится к Roblox UserId** (one-to-one) —
    дальше стример просто жмёт «Start Stream»
- Подписка истекла → лаунчер перестаёт продлевать → `valid_until`
  протухает ≤ 24 ч → `validate`/`ingest` отвечают
  `402 subscription_expired`, «Start Stream» гаснет
- Анти-шеринг: бинд one-to-one; перебинд только после revoke ключа
  и генерации нового в лаунчере — друзьям ключ не передашь
- Таким образом подписка на chlauncher = лицензия на стрим-румы;
  стример **не покупает** платный вход — робуксы платят только зрители

## Что chlauncher НЕ делает

- **Робуксы.** Платный вход в стрим-руму и платный саботаж — Dev
  Products/Game Passes внутри Roblox, деньги идут владельцу experience
  через Roblox, минуя лаунчер
- Игровую логику, модерацию, очередь команд — это Roblox-сторона

## Схема

```text
TikTok/DA → integrations → TriggerMapper → EventHub ─┬─ game WS :9876
                                                     ├─ overlay :9877
                                                     └─ HTTP-forward ─┐
                  + продление ключа: POST /admin/register              ▼
                                            standalone relay
                                            /api/stream/* (очереди)
                                            /api/admin/*  (ключи)
                                                                       ▲
                          Roblox reserved server: GET /events?key&since ┘
                          → EventManager → whitelist action_commands
```
