# Автономность VPS — watchdog, очистка, бэкапы

Цель: сервер живёт без ручного вмешательства. Три слоя автоматики,
устанавливаемые одним скриптом `tools/vps/install.sh`.

## Слои

### 1. systemd `Restart=always` (мгновенное самолечение)

`chlauncher-server` и `chlauncher-tgbot` перезапускаются при падении.
После серии падений (5 за 30 сек / 10 за 60 сек) systemd помечает юнит
`failed` — дальше работает watchdog.

### 2. Watchdog (`chlauncher-watchdog.timer`, каждую минуту)

- `GET /api/ready` (БД + static-директории). Три подряд фейла →
  `systemctl restart chlauncher-server` + TG-алерт владельцу.
- Юнит в состоянии `failed` → `reset-failed` + `restart`.
- Включённый, но остановленный юнит → старт (намеренно замаскированные
  не трогает). Следит за `chlauncher-server`, `chlauncher-tgbot` и
  `chlauncher-tgadmin`.
- Диск ≥ 85 % → запуск cleanup (не чаще раза в 20 ч) + алерт.

### 3. Cleanup (`chlauncher-cleanup.timer`, ежедневно)

- SQLite: `PRAGMA wal_checkpoint(TRUNCATE)` + `PRAGMA optimize` —
  онлайн, без остановки сервера. WAL-файл не разрастается.
- Удаление `*.part`/`*.tmp` загрузок старше суток (на случай оборванных
  аплоадов билдов).
- `journalctl --vacuum-time=14d`, `apt-get clean`, core dumps > 3 дней.

Плюс серверная часть уже чистит БД сама: часовой sweeper удаляет
просроченные/использованные `pair_codes` (с зашифрованной TikTok-кукой),
`tg_login_codes`, `billing_link_codes` и `usage_nonces` старше суток.

### 4. Backup (`chlauncher-backup.timer`, ежедневно 03:15)

`tools/backup-db.sh` — `sqlite3 .backup` + gzip + ротация 14 копий в
`/opt/chlauncher/backups`. Оффсайт-копия — на владельце (см. ниже).

## Установка

```bash
# на VPS, внутри /opt/chlauncher
sudo bash tools/vps/install.sh
```

Что делает скрипт: копирует unit-файлы в `/etc/systemd/system`, включает
все сервисы и таймеры, создаёт state-директорию watchdog. Повторный
запуск безопасен.

## TG-алерты владельцу

```bash
sudo cp /opt/chlauncher/tools/vps/watchdog.env.example \
        /opt/chlauncher/tools/vps/watchdog.env
# вписать:
#   TG_ALERT_TOKEN=<тот же TG_BOT_TOKEN>
#   TG_ALERT_CHAT_ID=<ваш telegram id — бот отвечает на /whoami>
```

Watchdog пришлёт сообщение при рестарте сервиса и при автоочистке диска.

## Частые сбои и кто их чинит

| Симптом | Причина | Автолечение |
|---|---|---|
| API молчит, лаунчер не входит | процесс упал | Restart=always → watchdog при `failed` |
| API жив, но /api/ready 503 | БД недоступна / static-диск | 3 фейла подряд → рестарт + алерт |
| «No space left» в логах | WAL/логи/аплоады съели диск | watchdog ≥85 % → cleanup + алерт |
| Бот не отвечает | процесс умер | chlauncher-tgbot/-tgadmin Restart=always + watchdog |
| БД растёт без остановки | коды/nonce копятся | встроенный hourly sweeper |
| БД битая после сбоя питания | WAL откат | ежедневный backup → restore (ops.md) |

## Проверка после установки

```bash
systemctl list-timers 'chlauncher-*'     # таймеры запланированы?
systemctl status chlauncher-server       # active (running)
curl -s http://127.0.0.1:8787/api/ready  # {"ok":true,...}
sudo -u root tools/vps/chlauncher-watchdog.sh   # ручной прогон
sudo tools/vps/chlauncher-cleanup.sh            # ручной прогон
```

## Что остаётся на владельце

- **Оффсайт-бэкап**: `rsync`/`rclone` `/opt/chlauncher/backups/` на другой
  хост или в S3-совместимое хранилище — иначе бэкапы умирают вместе с VPS.
- **Мониторинг снаружи**: uptime-пинг `/api/health` с внешнего сервиса
  (uptimerobot и т.п.) — watchdog видит только локальный сбой.
- **TG_ALERT_CHAT_ID** — без него алерты не отправляются.
