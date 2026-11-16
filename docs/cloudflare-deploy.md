# Деплой за Cloudflare

> **Факт из прогона (Beltelecom):** `api.trycloudflare.com` и `*.argotunnel.com:443`
> режутся по SNI — quick-tunnel без аккаунта недоступен. **Именованный туннель
> работает** (управление через `api.cloudflare.com` ✓, транспорт `argotunnel:7844` ✓),
> но требует свой домен в аккаунте. Без домена рабочая связка —
> **localtunnel** (`npx localtunnel --port 8787` → `https://*.loca.lt`,
> без аккаунта; браузерам показывает IP-пароль страницу, API-клиенты проходят)
> или **ngrok** (нужен аккаунт, зато статичный `*.ngrok-free.app`).

## Варианты

**A. Cloudflare Tunnel (`cloudflared`) — сейчас, бесплатно, без VPS.**
Сервер остаётся на твоей машине; `cloudflared` держит исходящее соединение
к Cloudflare → получаешь `https://api.<домен>` без проброса портов и
белого IP. TLS терминируется на edge Cloudflare. Подходит и для теста с
соадмином, и для раннего прода с небольшой нагрузкой.

**B. VPS + «оранжевое облако» — настоящий прод.**
Домен на Cloudflare → A-запись на VPS → бесплатный TLS на edge. Сервер
живёт на VPS (systemd/PM2), origin прячется за CF — плюс WAF и rate-limit
правила бесплатно. Когда появятся платежи — переезжать сюда.

Общее для обоих: нужен домен, добавленный в Cloudflare (free-план
достаточно). Без домена `cloudflared tunnel --url http://localhost:8787`
выдаёт случайный `*.trycloudflare.com` — живёт до перезапуска, годится
только для разового прогона.

## A. Настройка туннеля (пошагово)

```powershell
winget install Cloudflare.cloudflared     # или с github releases
cloudflared tunnel login                  # откроет браузер → выбор домена
cloudflared tunnel create chlauncher      # → tunnel-id + credentials.json
```

`~/.cloudflared/config.yml`:

```yaml
tunnel: <tunnel-id>
credentials-file: C:\Users\<you>\.cloudflared\<tunnel-id>.json
ingress:
  - hostname: api.<твой-домен>
    service: http://localhost:8787
  - service: http_status:404
```

```powershell
cloudflared tunnel route dns chlauncher api.<твой-домен>
cloudflared tunnel run chlauncher         # или cloudflared service install
```

## Что уже подготовлено в проекте

- `trustProxy: true` в `apps/server/src/app.js` — за CF `request.ip`
  берётся из `X-Forwarded-For`/`CF-Connecting-IP`: rate-limit и проверка
  подсетей ЮKassa в webhook видят реальный IP, а не edge-адрес CF.
- `ADMIN_EMAILS=hoga88ky@gmail.com` в `apps/server/.env` — логин с этой
  почты получает `role=admin` автоматически (и ресинк каждый логин).
  Почту второго админа — добавить в этот же список через запятую или
  `node tools/grant-admin.mjs <email>`.
- `VITE_API_URL` теперь читается **на этапе сборки** (`option_env!`) —
  продовый URL зашивается в бинарник.

## Сервер за туннелем

`SERVER_HOST=127.0.0.1` (верни с `0.0.0.0` — туннель сам выходит наружу,
прямой доступ к origin не нужен и небезопасен). `NODE_ENV=production`,
`JWT_SECRET` — уже стоят в `.env`.

Webhook ЮKassa: `https://api.<домен>/api/billing/webhook` — верификация по
подсетям ЮKassa работает через `trustProxy` (Basic-auth вариант не
использовать: ЮKassa не шлёт Authorization в нотификациях).

## Сборка лаунчера под прод-URL

```powershell
$env:VITE_API_URL="https://api.<твой-домен>"
npm run tauri:build --workspace @chlauncher/launcher
```

URL зашивается в бинарник — стримеру не нужно вводить сервер на экране
входа (поле остаётся доступным для переопределения; скрыть в релизе —
отдельная задача харденинга).

## Чек-лист выдачи

1. `npm run dev:server` (или `node src/index.js`) на :8787
2. `cloudflared tunnel run chlauncher` → `https://api.<домен>/api/health` жив
3. Собранный `-setup.exe` + URL → соадмину
4. Он регистрируется → `node tools/grant-admin.mjs его@почта` (или email в
   `ADMIN_EMAILS` заранее) → перелогин → вкладка «Управление»
