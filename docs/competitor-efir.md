# Competitor teardown — EFIR (NNSI App 0.1.102)

Разбор Electron-лаунчера из `NNSI App.zip` (экосистема yungrezac /
tiktok-live-connector 2.4.4). Бэкенд — Railway (license-server,
echo-live-relay, efir-releases + standby), auth/лендинги — Supabase.

## Архитектура

- **Сторонний процесс для TikTok** — `resources/tiktok-service` отдельным
  пакетом с worker-потоками (connection/hub/profile/metrics/likes) —
  как наш сайдкар, только на worker_threads вместо stdout-NDJSON
- **Каталог ~15 приложений** на GitHub Releases (icon_url/cover_url,
  owner/repo, is_published/is_exclusive): Snake 3D, Neon Coil,
  Prism Break, TIKTIMER, Echo Live, Flappy Gifts, IMMWIGET и др.
- **Чанковые докачиваемые загрузки** `regional-download.cjs` —
  SHA256 на чанк, переживает рестарт, два release-ориджина
  (production + standby failover)
- **Launch tickets** `launch-ticket-clock.cjs` — подписанные тикеты
  на запуск, TTL 15 мин, допуск по времени ±30 с, грейс-старт 120 с —
  как наши launch-токены, но с компенсацией рассинхрона часов
- **Self-update** — electron-updater + отдельный mac-вариант

## Аутентификация и монетизация

- **Telegram как основной логин** — oauth.telegram.org widget
  (deep-link `tg://resolve?domain=oauth` / `tg://login?code`),
  email+password — запасной «legacy» вход. У нас TG — только биллинг
- **Встроенное окно оплаты** — Tribute checkout прямо в WebContentsView
  (web.tribute.tg), отдельная session-partition на юзера. У нас — внешний
  браузер
- **Свой шоп** — quote → create-order → verify-order → cancel,
  поверх Tribute
- **Промокоды и рефералка** — `promo:redeem`, `referral:status/claim`,
  pending-referral на старте
- HWID (machine-id) — та же модель, что у нас

## Интеграции

- **3 донат-провайдера**: DonationAlerts, **DonatePay, DonateX** —
  credentials зашифрованы (seal/unseal), dedup seen-ids, автореконнект
- **DA OAuth внутри приложения** — BrowserWindow + перехват редиректа
  (`will-navigate` на `localhost/da-callback`), не ручной ввод токена
- **TikTok quick-connect в шапке** — поповер с аватаром и историей ников

## Облачные сервисы (наша главная дистанция)

- **Echo speech — облачный TTS**: голоса Google Gemini
  (Kore/Charon/Aoede/…) + **клонирование голоса пользователя**
  ('personal-clone', ошибки CLONE_*), бюджеты/рейт-лимиты,
  session-ключи, **client-fed режим** — лаунчер сам кормит релей
  комментариями, релей в TikTok вообще не ходит
- **Overlay relay + room stats** — общие оверлеи через их облако,
  статистика комнаты (totalLikes, до 20k зрителей)
- **Widget raster upload** — скриншоты виджетов уходят на сервер
  (расшаренные оверлеи?)

## UX-киллеры

- **Конструктор лендинга «Мой лендинг»** — мини-сайт стримера:
  slug-URL, фото, до 24 кнопок-ссылок, правила таймера, drag-раскладка,
  живой превью, хостинг на их платформе. У нас такого нет вообще
- **EFIR CARE — саппорт-мессенджер внутри лаунчера**: тикеты со
  статусами, до 30 скриншотов, **голосовые сообщения**, ответы админа,
  лимит 5 обращений/день
- **Feature tour** — spotlight-тур по новым фичам при обновлении
- Трей (закрытие окна → hide), автостарт, автосбновление — тумблеры
- Панель загрузок с прогрессом и счётчиками

## Что перенять — приоритет

| # | Фича | Зачем | Сложность |
|---|------|-------|-----------|
| 1 | Докачиваемые чанки + standby-зеркало | «по миру» — решает и надёжность раздачи | Средняя |
| 2 | DA OAuth внутри окна | UX вместо ручного токена | Низкая |
| 3 | Промокоды + рефералка | рост, бесплатно | Средняя (сервер) |
| 4 | Саппорт-мессенджер | retention на старте | Средняя |
| 5 | TG-логин как auth | СНГ-аудитория живёт в TG | Средняя |
| 6 | Встроенное окно оплаты | конверсия | Низкая |
| 7 | Облачный TTS + клонирование голоса | премиум-фича для Expert-тарифа | Высокая |
| 8 | Конструктор лендинга | большой дифф-фактор, но дорого | Высокая |
| 9 | Feature-tour, трей, quick-connect в шапке | полировка | Низкая |

## Чего у них НЕТ (наша сила)

- Встроенные интерактивные игры-оверлеи (у них игры — отдельные exe)
- Маппер триггеров в UI, симулятор, publisher self-service с ревью
- Minecraft/Roblox адаптеры, cloud relay событий
- Админка внутри лаунчера, тарифы/энтайтлменты/usage-метрика
