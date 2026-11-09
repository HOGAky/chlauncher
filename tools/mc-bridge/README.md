# mc-bridge — chlauncher → Minecraft

Мост между stream-event релеем chlauncher и **любым** Minecraft-сервером
с включённым RCON (`enable-rcon=true` в `server.properties`). Плагины и
моды на сервере не нужны — мост шлёт консольные команды по протоколу
Source RCON.

## Как это работает

```
TikTok / DonationAlerts → chlauncher EventHub → HTTP-forward
    → relay /api/stream/*  →  mc-bridge (poll 1.5 c)  →  RCON → MC server
```

События донатов/подарков уже превращены триггер-маппером лаунчера в
`action_command` (`spawn_chaser`, `coin_rain`, …) — мост рендерит их в
консольные команды по шаблонам из `commands` в конфиге.

## Запуск

```bash
# 1. Скопируйте конфиг
cp config.example.json mc-bridge.json
#    впишите relay URL, stream key (из лаунчера → Интеграции →
#    «Облачные серверы»), RCON-пароль и ник стримера (default_target)

# 2. Запуск
node index.js --config mc-bridge.json
```

Либо флагами (без файла):

```bash
node index.js --relay https://host:8443 --key STREAM_KEY \
  --rcon-host 127.0.0.1 --rcon-port 25575 --rcon-pass SECRET \
  --player Steve --fallback "say [stream] {user}: {command}"
```

## Шаблоны команд

| Плейсхолдер | Значение |
|---|---|
| `{player}` | ник стримера (`default_target`) |
| `{user}` | ник зрителя, вызвавшего событие |
| `{amount}` | количество/сумма из события |
| `{command}` | сам `action_command` |
| `{raw_name}` | исходный текст (имя подарка и т.п.) |

Неизвестный `action_command` → шаблон `fallback` (если задан) или
пропуск с логом `[skip]`.

## Замечания

- Ключ должен быть зарегистрирован на релее — включите форвард в
  лаунчере: он сам пушит `valid_until` каждые 12 ч, пока подписка активна.
- Poll-интервал 1.5 с — в пике зрители могут накидать очередь; команды
  отправляются серийно, сервер их выполнит по очереди.
- Мост не модерирует команды — шаблоны в конфиге исполняются в консоли
  сервера, держите файл конфига при себе.
