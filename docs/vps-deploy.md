# Деплой сервера на VPS (production)

Продакшен-хостинг бэкенда: дешёвый VPS (Ubuntu 24.04, 1 vCPU / 1–2 GB RAM
хватает — Fastify + SQLite) за Cloudflare «оранжевым облаком». Домен —
обязательное условие (TLS Full Strict + WAF).

## 1. Базовая установка

```bash
sudo apt update && sudo apt install -y nodejs sqlite3 rsync
# Node 22: через nvm или nodesource
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
sudo apt install -y nodejs

sudo useradd -r -m -d /opt/chlauncher chlauncher
sudo -u chlauncher git clone https://github.com/HOGAky/chlauncher.git /opt/chlauncher
cd /opt/chlauncher && sudo -u chlauncher npm ci
```

## 2. Окружение (`/opt/chlauncher/apps/server/.env`)

```env
NODE_ENV=production
SERVER_HOST=127.0.0.1
SERVER_PORT=8787
TRUST_PROXY=true                # за Cloudflare/nginx
JWT_SECRET=<openssl rand -hex 64>
HWID_HASH_SECRET=<openssl rand -hex 64>
CORS_ORIGINS=                   # launcher ходит без Origin — пусто ок
STATIC_DIR=/opt/chlauncher/apps/server/static
DATABASE_PATH=/opt/chlauncher/apps/server/data/chlauncher.db
# ENABLE_MOCK_BILLING НЕ задавать — prod упадёт со стартом, если =1
```

Без `JWT_SECRET`/`HWID_HASH_SECRET` или с `ENABLE_MOCK_BILLING=1` сервер
откажется стартовать — это защитное поведение, не баг.

## 3. systemd unit + автономность (рекомендуется)

Все unit-файлы лежат в `tools/vps/` — ставятся одной командой вместе с
watchdog (самолечение), cleanup (очистка мусора) и backup-таймером:

```bash
sudo bash /opt/chlauncher/tools/vps/install.sh
journalctl -u chlauncher-server -f   # логи с x-request-id
```

Подробности и таблица авто-лечения частых сбоев: `docs/vps-automation.md`.
Если нужен только голый unit — он же в `tools/vps/chlauncher-server.service`.

## 4. TLS и Cloudflare

- DNS: `api.<домен>` → A-запись VPS, прокси ON (оранжевое облако).
- SSL/TLS режим: **Full (strict)** + Cloudflare Origin Certificate на
  nginx (или Caddy с DNS-челленджем).
- nginx proxy: `api.<домен>` → `http://127.0.0.1:8787`, `client_max_body_size 2G`
  (загрузка билдов игр), `proxy_read_timeout 300s`.
- `TRUST_PROXY=true` в .env — иначе rate-limit и ip_hash видят IP Cloudflare.

## 5. Бэкапы SQLite

БД в WAL-режиме — обычный `cp` может скопировать битую БД. Скрипт
`tools/backup-db.sh` использует `sqlite3 .backup` + gzip + ротацию (14 шт)
и запускается таймером `chlauncher-backup.timer` (ставится install.sh).

Копию сливать наружу (S3/rclone/телеграм админу) — добавить в конец скрипта
при необходимости.

## 6. Обновление сервера

```bash
cd /opt/chlauncher && sudo -u chlauncher git pull
sudo -u chlauncher npm ci
sudo systemctl restart chlauncher-server
curl -s http://127.0.0.1:8787/api/health || true   # smoke
```

## 7. Связь с релизом лаунчера

Release-сборка лаунчера печёт `VITE_API_URL=https://api.<домен>` на этапе
компиляции (GitHub Actions `vars.VITE_API_URL`). Смена домена = новый тег и
новый релиз — клиенты подхватят через автоапдейтер.

## 8. Оплата через Telegram (Tribute)

Поток: пользователь жмёт «Telegram» у плана → бот привязки связывает его
Telegram id с аккаунтом → пользователь оплачивает в Tribute → webhook
`POST /api/billing/tribute/webhook` активирует план (HMAC-подпись по
API-ключу, ретраи идемпотентны).

### Настройка Tribute (кабинет)

Один платный тариф: **Pro — 2400 ₽/мес**, все функции включены.

1. Создайте подписку «Pro» (2400 ₽, месячная) в Tribute Creator Dashboard,
   запомните `subscription_id` (виден в API `GET /api/v1/subscriptions`
   или в payload webhook).
2. Settings → API Keys → сгенерируйте ключ → `TRIBUTE_API_KEY`.
3. Там же укажите Webhook URL: `https://api.<домен>/api/billing/tribute/webhook`.
4. Скопируйте ссылку оплаты продукта → `TRIBUTE_PRODUCT_LINKS`.

### Bind-бот (BotFather + apps/launcher/tg-bot)

```bash
# 1. @BotFather → /newbot → токен
# 2. На VPS: отдельный systemd-сервис рядом с сервером (ставится install.sh)
sudo -u chlauncher mkdir -p /opt/chlauncher/apps/launcher/tg-bot
cat | sudo -u chlauncher tee /opt/chlauncher/apps/launcher/tg-bot/.env <<'EOF'
TG_BOT_TOKEN=<токен BotFather>
TG_BIND_SECRET=<openssl rand -hex 32>
SERVER_URL=http://127.0.0.1:8787
OWNER_TG_IDS=<ваш telegram id — бот отвечает на /whoami>
EOF
```

Unit — `tools/vps/chlauncher-tgbot.service` (ставится install.sh). Бот сам
делает `deleteWebhook` и работает через long-polling — публичный endpoint
ему не нужен. Команды: `/status`, `/pay`, `/whoami`, `/grant <tg_id> <дни>`
(только для OWNER_TG_IDS — начисление подписки по TG id).

### Admin-бот (apps/launcher/tg-admin-bot)

Второй, ПРИВАТНЫЙ бот — панель владельца. Отвечает только на `ADMIN_TG_ID`:

```bash
cat | sudo -u chlauncher tee /opt/chlauncher/apps/launcher/tg-admin-bot/.env <<'EOF'
TG_ADMIN_BOT_TOKEN=<отдельный токен BotFather — НЕ bind-бот>
ADMIN_TG_ID=<ваш telegram id>
TG_BIND_SECRET=<тот же, что у сервера>
SERVER_URL=http://127.0.0.1:8787
EOF
```

Команды: `/subs` (список привязанных TG id + подписки), `/status <tg_id>`,
`/grant <tg_id> <дни>` (начислить вне оплаты), `/revoke <tg_id>` (отключить),
`/role <tg_id> user|publisher|admin` (publisher = разработчик, публикует игры).
Unit — `tools/vps/chlauncher-tgadmin.service`, watchdog его воскрешает.

### Переменные сервера (.env)

```env
TRIBUTE_API_KEY=<из дашборда Tribute>
TRIBUTE_BOT_URL=https://t.me/<имя_бота>?start=
TG_BIND_SECRET=<тот же, что у бота>
TRIBUTE_PRODUCT_LINKS={"pro":"https://t.me/tribute?startapp=abc"}
TRIBUTE_PLAN_MAP={"1644":"pro"}
```

Смоук-тест: привязать свой Telegram → оплатить тестовый тариф →
`journalctl -u chlauncher-server | grep tribute` → статус подписки в
лаунчере «Я оплатил — проверить».
