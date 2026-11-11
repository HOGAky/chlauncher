# adapter-example — reference external game adapter

Минимальный адаптер для сторонних игр (§10 ТЗ): показывает протокол,
который должен реализовать мод для GTA V / Valheim / 7DTD и т.п.

## Протокол

Тот же `ws://127.0.0.1:<port>` что и у встроенных игр (`port` виден в
Интеграции → Внешние моды), но рукопожатие другое — мод не является
процессом лаунчера и не может получить одноразовый launch-токен:

```jsonc
// → мод шлёт первым фреймом (в течение 5 с)
{ "type": "hello_adapter", "key": "<adapter_key>", "game": "gta5", "protocol": 1 }
// ← лаунчер
{ "type": "welcome", "protocol": 1 }
// либо
{ "type": "error", "reason": "invalid adapter key" }
```

Дальше идёт стандартный поток:

```jsonc
{ "type": "event",     "event": { "event_id": "uuid", "action_command": "spawn_enemy", "user": "…", "amount": 3, "raw_name": "Rose", "source": "tiktok", "event_kind": "gift", "avatar_url": "" } }
{ "type": "heartbeat", "ts": 1730000000 }
{ "type": "set_chroma_key", "enabled": true }
{ "type": "shutdown" }
```

Опциональный обратный канал — мод подтверждает выполнение:

```jsonc
{ "type": "ack", "event_id": "uuid-из-event", "ok": true }
```

Лента событий в лаунчере пометит диспатч как «выполнено в игре».

## Ключ

`adapter_key` — постоянный секрет в настройках лаунчера (UI: Интеграции →
Внешние моды → копировать). «Новый ключ» отзывает старый: подключённые
моды получают `shutdown` и должны переподключиться с новым ключом.
Не публикуйте ключ в коде мода — вынесите в конфиг пользователя.

## Манифест действий

`adapter_manifest` в записи каталога (kind='adapter') задаёт словарь
действий, который маппер показывает выпадающим списком:

```json
{
  "game": "gta5",
  "actions": [
    { "id": "spawn_vehicle", "label": "Выдать транспорт", "params": {} },
    { "id": "explode_player", "label": "Взорвать игрока", "params": {} },
    { "id": "give_weapon", "label": "Выдать оружие", "params": {} }
  ]
}
```

`action_command` события = `id` из манифеста — мод маппит их на свои
внутренние функции.

## Запуск примера

```bash
node tools/adapter-example/index.js --port <port> --key <adapter_key> --game demo-adapter
```
