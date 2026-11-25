# tg-admin-bot — приватная админка в Telegram

Отдельный бот (другой токен, не публичный bind-бот) — панель владельца.
Отвечает ТОЛЬКО на `ADMIN_TG_ID`; остальных игнорирует полностью.

## Команды

| Команда | Действие |
|---|---|
| `/subs [стр]` | список привязанных TG id: username, роль, подписка, дней осталось |
| `/status <tg_id>` | карточка подписчика (аккаунт, подписка, ссылка оплаты) |
| `/grant <tg_id> <дни> [план]` | начислить дни подписки по TG id (вне оплаты) |
| `/revoke <tg_id>` | отключить подписку немедленно (expired + автопродление off) |
| `/role <tg_id> <роль>` | `user` / `publisher` (разработчик, публикует игры) / `admin` |
| `/cmd [-t сек] <команда>` | выполнить shell-команду на хосте — ответ: exit-код + хвост stdout/stderr |
| `/whoami` | ваш Telegram ID |

### `/cmd` — shell на хосте

- `/cmd journalctl -u chlauncher-server -n 20 --no-pager` — логи сервера
- `/cmd systemctl restart chlauncher-server` — рестарт юнита
- `/cmd -t 300 git -C /opt/chlauncher pull && npm ci` — длинная команда
  с таймаутом 5 мин (дефолт 60 с, максимум 10 мин)
- Рабочая папка — корень репо (`ADMIN_CMD_CWD` меняет). Для «вечных»
  процессов: `nohup … &` — иначе процесс убьётся по таймауту.
- Дочернему процессу env выдаётся **без** `*TOKEN*/*SECRET*/*PASSWORD*`-переменных —
  `env`/`printenv` не утащит токены в чат. Каждая команда пишется в
  journalctl (`/cmd: …`) — аудит.

Всё ходит на серверный bot-only интерфейс (`x-bot-secret` = `TG_BIND_SECRET`):
`POST /api/tg/grant`, `POST /api/tg/admin/revoke`,
`POST /api/tg/admin/set-role`, `GET /api/tg/admin/subscribers`,
`GET /api/tg/bind-status`.

## Запуск

```bash
cp .env.example .env   # заполнить TG_ADMIN_BOT_TOKEN, ADMIN_TG_ID, TG_BIND_SECRET
node index.js          # или npm start
```

Прод: systemd-юнит `tools/vps/chlauncher-tgadmin.service`
(ставится `tools/vps/install.sh`, watchdog его тоже воскрешает).

## Примечания

- Роль `publisher` даёт доступ к `/api/publisher/*` — создание игр,
  загрузка билдов, отправка на модерацию. Роль `admin` — полная панель.
- `/grant` пишется в платёжный ledger как `provider='tg_admin'` — виден
  в истории платежей аккаунта.
- Начисление возможно только на **привязанный** TG id: пользователь сначала
  привязывает Telegram (через bind-бот или вход по `login_`/`pair_` коду).
