# chlauncher-tg-bot

Bind-бот для оплаты через Tribute: связывает аккаунт chlauncher с
Telegram user id — единственным стабильным идентификатором, который
присылают webhook'и Tribute.

## Как работает

1. В лаунчере «Подписка → Оплата в Telegram» создаётся одноразовый код
   (`POST /api/tg/link-code`, TTL 30 мин) и открывается диплинк
   `t.me/<bot>?start=<code>`.
2. Пользователь жмёт Start → бот вызывает `POST /api/tg/bind` с общим
   секретом `x-bot-secret` → аккаунт привязывается к `telegram_user_id`.
3. Бот отвечает ссылкой на продукт Tribute для выбранного плана.
4. После оплаты webhook Tribute активирует подписку на сервере.
   Если пользователь оплатил **до** привязки — событие ждёт в журнале
   `billing_events` и применится автоматически при привязке.

## Команды бота

- `/start <код>` — привязка аккаунта по коду из лаунчера
- `/status` — привязанный аккаунт + статус подписки

## Запуск

```bash
cp .env.example .env   # TG_BOT_TOKEN, TG_BIND_SECRET, SERVER_URL
npm start
```

Ноль зависимостей, Node ≥20, long-polling — публичный webhook боту не
нужен, работает на том же VPS, что и сервер. Под systemd — см.
`docs/vps-deploy.md` §8.
