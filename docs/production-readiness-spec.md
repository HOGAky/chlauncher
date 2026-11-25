# Техническое задание: доведение chlauncher до production

**Исполнитель:** SWE-2 High  
**Режим:** сначала аудит и план, затем последовательная реализация. Не выполнять destructive-операции и не менять production-данные/секреты без отдельного согласования.  
**Цель:** подготовить существующий продукт к безопасному публичному запуску Windows-лаунчера, централизованного API, оплаты, каталога игр и поддержки стримеров.

---

## 1. Обязательные правила исполнителю

1. В начале прочитать `AGENTS.md`, эту спецификацию и актуальные связанные документы. Считать исходники и тесты источником истины; часть README/operations/deploy-документов устарела и противоречит коду.
2. Снять `git status`, текущую ветку и HEAD. Не перезаписывать незакоммиченные пользовательские изменения. В этой спецификации фиксируется состояние, наблюдавшееся на `main`, commit `e059485` от 2026-11-23; перед работой проверить, что оно всё ещё актуально.
3. До изменения поведения выпустить краткий audit/implementation plan: P0 launch blockers, файлы, миграции, риски, тесты, решение по платежному провайдеру и модели развертывания. Не останавливаться на плане — после аудита переходить к реализации без ожидания, если нет решения, которое может привести к затратам/удалению данных/публичному запуску.
4. Не включать реальные платежи, не публиковать релиз, не выполнять миграцию production-БД, не отправлять уведомления/сообщения, не менять DNS/Cloudflare и не использовать реальные секреты без явного подтверждения владельца.
5. Не считать frontend visibility, Tauri IPC, HWID, локальную проверку лицензии или клиентский usage-counter достаточной защитой от модифицированного клиента. На сервере проверять всё, что влияет на деньги, доступ к артефактам, роли и облачные ресурсы. Явно описывать остаточные ограничения desktop DRM.
6. Не переписывать всю архитектуру «на будущее». Для первой production-версии сохранить Fastify + SQLite на одном узле и Tauri; миграцию на PostgreSQL, Kubernetes, многорегиональность и другие большие изменения предлагать только при измеримой необходимости.
7. Все миграции — аддитивные/безопасные, с бэкапом до применения, проверкой повторного старта и понятным планом восстановления. Не удалять и не пересоздавать production-файлы/БД.
8. Работать этапами, каждый с тестами и кратким итогом. Не объявлять готовым этап с failing tests, неподтверждённым платежным webhook, неподписанным обновлением или непроверенной установкой на чистой Windows VM.
9. Секреты не печатать в терминал/логи/вывод задачи. Использовать только CI secrets и server secret manager / защищённые файлы с минимальными правами.
10. Не копировать код, ассеты, тексты или бренд конкурентов. Перед коммерческим запуском провести отдельную проверку прав на игры, персонажей, музыку, подарочные изображения, шрифты и trademarks.

## 2. Продукт и архитектура сейчас

### 2.1 Репозиторий

- `apps/launcher`: Windows desktop-продукт на Tauri v2, Rust и React/TypeScript.
- `apps/server`: Node.js/Fastify API, SQLite (`node:sqlite`), JWT; учётные записи, планы, подписки, платежи, каталог/загрузка игр, publisher review, TikTok signing proxy, Roblox relay, Telegram binding/login, referrals, support.
- `packages/game-sdk`, `apps/mock-game`: локальный game protocol/SDK и тестовая игра.
- `tools/tiktok-sidecar`: Node.js sidecar с `tiktok-live-connector`, отдельной сборкой bundle и Node runtime.
- `apps/launcher/public/games`, `src-tauri/overlay`, `public/widgets`: локальные HTML/JS-игры и OBS/TikTok LIVE Studio browser-source виджеты.
- `apps/launcher/tg-bot`: Telegram bind/login bot с long polling.
- `tools/mc-bridge`, встроенный Minecraft Paper server и `stream.js`: отдельные remote Minecraft/Roblox сценарии.

### 2.2 Текущий функциональный охват

Сохранить существующую функциональность: TikTok LIVE и DonationAlerts, trigger mapper/presets, игры и каталог обновлений, OBS/LIVE Studio overlays/widgets, TTS (Edge/SAPI/Piper/RVC), media library/soundboard, Gift Spinner, timers/subathon/goals/polls/queue/points/hype, managed Minecraft/Paper/plugins, Roblox stream-ticket/relay, publisher/admin, подписки/планы/промо/referrals, support chat, diagnostics и signed updater.

Не выдавать функции/интеграции за production-ready только потому, что есть UI или код. Для каждой — определить зависимости, права, privacy, тесты, ограничения и fallback.

### 2.3 Проверенное состояние на момент аудита

- `npm run build --workspace @chlauncher/launcher`: проходит; Vite предупреждает о статическом и динамическом импорте opener-плагина в разных модулях.
- `npm run test:server`: **174 passed / 1 failed из 175**. Падает `apps/server/test/gamekit.test.js`, тест “same payload re-fed inside the window does not duplicate”: `2 !== 1`. Тест ожидает дедупликацию одинакового события и варианта с `ts_ms + 1`; `gamekit.js` включает точный `ts_ms` в dedupe key, значит контракт и тест расходятся. Установить правильную семантику с реальным `event_id`, не подавлять тест и не выкидывать легитимные одинаковые подарки/комментарии.
- При запуске Rust-команд Cargo синхронизировал lockfile с текущим manifest `apps/mock-game/Cargo.toml`: там `mock-game` уже `1.0.0`, а root `Cargo.lock` содержит `0.1.0`. Обновить lockfile осознанно и включить `--locked` в CI, чтобы рассинхронизация не проходила незаметно.
- Cargo tests были запущены, затем прерваны пользователем во время первой компиляции. Их результат неизвестен; не использовать исторические отчёты как доказательство текущего зелёного состояния.
- Worktree на старте был чистым, ветка `main`, HEAD `e059485`.
- Исторические `HARDENING_REPORT.md`/`NIGHT_REPORT.md` фиксируют более ранний snapshot и не покрывают последующие изменения; перепроверять каждый claim.

## 3. Решение по hosting (обязательный deployment target)

1. Production API **не размещать на Cloudflare Workers/Pages**: runtime зависит от Node `node:sqlite`/`DatabaseSync`, локальной файловой системы, постоянного SQLite/WAL, game/plugin artifact uploads и длительных sidecar/proxy requests. Workers не заменяет этот backend без отдельной архитектурной миграции.
2. Целевой v1: Linux VPS/VM, один экземпляр Node API + persistent local SSD для SQLite и временно game artifacts; Nginx/Caddy или Cloudflare Tunnel перед ним; публичный домен и HTTPS.
3. Если используется Cloudflare DNS/proxy: origin не должен принимать публичный прямой трафик в обход proxy. Предпочтительно bind API к `127.0.0.1`, firewall разрешает только proxy/tunnel path, HTTPS Full (strict) при прямом origin, управляемые security/rate-limit правила.
4. Cloudflare Tunnel с домашнего ПК — только beta/demo: URL/uptime и доступность зависят от домашней сети, питания, NAT и процесса туннеля. Не позиционировать его как production SLA.
5. `TRUST_PROXY=true` в текущем Fastify означает доверие forwarded headers в целом. Исполнитель должен ограничить доверенные proxy hops/CIDR либо доказать сетевую изоляцию origin; конфигурация не должна принимать spoofed `X-Forwarded-For` от прямого клиента. Обновить `docs/cloudflare-deploy.md` (он содержит устаревшее утверждение про `ADMIN_EMAILS` и доверие `CF-Connecting-IP`).
6. SQLite v1 — только один активный writer/API node на локальном persistent volume. Не размещать SQLite на NFS/общем сетевом диске и не запускать несколько реплик с общей БД. Если потребуются replicas — отдельный проект миграции на PostgreSQL, job/queue и object storage.
7. Game builds, Minecraft JARs и большие пользовательские артефакты при росте вынести в private object storage/CDN с signed URLs; API остаётся policy/authorization plane. До этого обеспечить persistent disk, квоты, резервное копирование и streaming.
8. Обновить deployment guide: production-пользователь без shell-login, systemd unit с отдельными read/write paths, ограниченными capabilities, restart policy, graceful shutdown, migration/backup перед deploy, health/readiness checks, firewall, TLS, secrets, log rotation, disk alerts, restore procedure и rollback приложения.

## 4. P0 — блокеры публичного запуска

Каждый P0 обязан иметь тест/проверяемый критерий, а не только документацию.

### P0.1. Закрыть критический DOM/XSS путь

- Владелец события TikTok/DonationAlerts может контролировать nickname, comment, gift name, username; проверить каждое использование `innerHTML`, `outerHTML`, template string, динамический `src`/URL и error rendering во всех `public/widgets`, `src-tauri/overlay`, `public/games`.
- Уже найдено: `gift_tower`, `boy_vs_girl`, `flappy_gifts`, `prism_break`, `snake_gifts`, `survive_horde` рендерят leaderboard с viewer names через `innerHTML`; game page показывает caught error через HTML. Найти аналогичные sinks в остальных страницах.
- Использовать `textContent`/DOM APIs для текста; если markup необходим — централизованный context-aware escaping, allowlist URL schemes/hosts, атрибутное экранирование. Не считать одной функцией `escapeHtml` доказательством безопасности всех контекстов.
- Убрать `security.csp: null` для основного Tauri UI и выставить минимальный рабочий CSP для Tauri, локального overlay, media и необходимых внешних источников. Inline-script legacy overlays мигрировать на nonce/hash/отдельные локальные script resources; не добавлять глобальный `unsafe-eval`. Если отдельные CSP нужны разным WebView/локальному axum — явно реализовать/документировать оба.
- Проверка регрессии: payload `</div><img src=x onerror=...>` в nickname/comment/gift/plan/support/game title не должен выполнить JS ни в launcher, ни в OBS overlay, ни в capture game window.
- Не доверять `game.json`, zip metadata, publisher strings, remote title/cover URL и error strings как HTML.

### P0.2. Привести игровые entitlement gates в соответствие с тарифами

- Проверить весь путь плана: `plans.entitlements` → `/api/account/entitlements` → Rust `UsageMeter` → UI → download/license/API endpoints.
- Сейчас backend game download и `/api/license/verify` проверяют `is_free` или факт активной подписки, но не подтверждают `interactive_games` конкретного плана. Клиентский `allowed_games()` не является enforcement boundary.
- На backend проверять plan entitlement для каждого game slug и `mc_premium_plugins`/прочих server-controlled ресурсоёмких endpoints. Возвращать стабильный `403 PLAN_LIMIT` с machine-readable details. Не позволять request body/локальному settings менять entitlement.
- Для локальных client-only фич (TTS/UI/локальная игра) зафиксировать модель угроз и продуктовые обещания. Не маркировать их как защищённые DRM; если функция влияет на оплачиваемый ресурс/внешний сервис, проверять entitlement на соответствующем серверном endpoint.
- Валидировать схему entitlements при создании/изменении планов; неизвестные ключи/неправильные типы не должны случайно давать доступ. Миграции планов, смена тарифа и истечение периода покрыть tests.
- Usage-meter отчёт поступает от модифицируемого клиента и не является доказательством фактических событий. Ограничение можно применять как best-effort продуктовый лимит, но не как финансово-достоверный счётчик/антифрод без серверной верификации.

### P0.3. Сделать владельца fail-closed

- Сейчас пустой `OWNER_TG_IDS` включает legacy-разрешение: любой `admin` может менять роли/планы, выдавать дни и создавать/ротировать промокоды. При текущем `.env` owner IDs не настроены; startup только предупреждает.
- В production startup должен завершаться ошибкой, если owner bootstrap не настроен. Для старой БД сделать безопасную однократную процедуру установки владельца из CLI/операторского процесса с аудитом, а не автоматическую выдачу любому администратору.
- Owner должен иметь резервный recovery flow (два заранее подтверждённых владельца либо документированная консольная recovery-команда с локальным доступом, аудитом и MFA); нельзя заблокировать единственный root-доступ через потерю Telegram.
- Проверять owner identity из серверной БД/конфигурации на каждый критический запрос, не JWT claim. Telegram bind/rebind/unbind не должен позволять перенос owner TG ID без подтверждения предыдущей идентичности/recovery-процедуры.
- Роли `admin`, `publisher`, owner actions и support permissions — отдельная матрица; не повышать админа автоматически по email в production. `ADMIN_EMAILS` остаётся dev-only.

### P0.4. Сделать платежи атомарными, проверяемыми и повторяемыми

- Все переходы payment ledger → subscription/plan должны быть одной SQLite-транзакцией с idempotent conditional update. Сейчас в Yookassa webhook статус `payments` меняется до `activateOrExtend`; сбой между этими действиями оставит успешный платеж без доступа, а retry может стать no-op. `recordPayment` и Tribute flow также должны быть crash-safe.
- Checkout создать как устойчивую операцию: клиентский idempotency key/internal order ID, pending ledger row, provider idempotence key, сохранение response; повтор HTTP-запроса не должен создавать несколько оплачиваемых checkout sessions. Сбой после создания платежа у провайдера должен восстанавливаться.
- Yookassa webhook: проверить provider event schema, payment ID связан с локальной pending записью, amount, currency, capture/paid state, локальные user/plan/period и expected metadata; сравнение сумм выполнять в integer minor units. Не начислять только по `event` без валидации `object`.
- Применение события: одна атомарная транзакция, уникальный provider event/external transaction key, conditional state transition; out-of-order/replayed notifications, concurrent webhook requests, cancellation, refund, chargeback и subscription renewal должны иметь определённую policy.
- Refund обязан отзывать/пересчитывать entitlement согласно согласованной политике, а не только менять ledger на `refunded`; обеспечивать точный audit и customer-support resolution.
- Tribute webhook: подтвердить текущий HMAC contract по официальной документации провайдера, constant-time compare, max request body, event idempotency/deduplication, validation of product/period/price/status, unmatched event replay в транзакции. Не хранить полный raw payload с лишними персональными данными без срока хранения.
- Создать reconciliation job/CLI: найти pending/paid/refunded расхождения и безопасно сверить провайдера. «Я оплатил — проверить» должен запускать bounded polling/reconciliation state, а не обещать новую проверку, если он только перечитывает локальную БД.
- До включения покупки обеспечить действительный merchant/provider account, продуктовые цены/валюту/период, legal receipts/tax/refund/support policy. Секреты пустые в текущем конфиге; checkout не готов к реальным покупателям.
- Stripe сейчас только зарезервирован env-переменной, полноценный route/provider contract не подтверждён. Не показывать Stripe как доступный. Реализовать или удалить мёртвую конфигурацию/документы.
- Добавить тесты для fault injection между provider call, payment insert/update, subscription grant, process restart; параллельные retries, duplicate and out-of-order webhooks, wrong amount/currency, invalid auth, refund and chargeback.

### P0.5. Безопасно хранить клиентские секреты и сессии

- Сейчас `settings.json` включает `auth_token`, DonationAlerts credentials, TikTok session/cookie, stream keys, RCON password и другие секреты в обычном JSON. Перенести секретные значения в Windows Credential Manager/DPAPI (или эквивалентный OS key store), в settings оставить ссылки/идентификаторы. Шифрование обязательно с user scope, а не hardcoded key в exe.
- Миграция существующих `settings.json`: безопасно импортировать secrets в store, проверить запись/чтение, затем заменить исходные значения на references и очистить plaintext без создания непредусмотренных backups. Предусмотреть recovery при ошибке миграции. Не стирать данные до успешной проверки.
- В `pair_codes.tiktok_sessionid` хранится сырой TikTok sessionid; при успешном consume/expiry отозвать и удалить session secret немедленно. Добавить sweep по expired/consumed records. Зафиксировать срок жизни и минимизировать копии.
- Любой auth/session cookie/access token не писать в logs, error strings, clipboard diagnostics, process argv, query strings или telemetry. Проверить redaction с реальными форматами (`Bearer`, URL query, JSON, cookies, base64).
- Logout/revoke должен очищать локальные credentials; сервер logout уже bump-ает `token_version`, проверить все identity flows (email, Telegram, TikTok, pair) и отзыв sessions.
- Ввести подтверждение/предупреждение перед импортом TikTok session cookie, описать последствия/отзыв; предпочитать официальный OAuth/Login Kit. Не обещать безопасное хранение пока DPAPI не реализован.

### P0.6. Устранить утечки local overlay/game token

- Сейчас overlay/widget/game requests используют `?t=<token>` и WebSocket auth query. Query может оказаться в URL history, OBS scene config, referrer, browser/devtools/proxy logs и script subresource URL. Перевести секрет на header/initial WebSocket auth frame/postMessage scoped capability; если compatibility требует query — short-lived, per-widget/page scope, read-only, rotate/revoke, strict no-referrer/no-store and no URL logging.
- Random port + loopback binding сохранять. Добавить Host/Origin validation и защиту от DNS rebinding/CSWSH на `/ws`, `/games/*`, `/media`, `/tts`, `/overlay-close`, Roblox bridge. Проверить что endpoint нельзя использовать с другого сайта/локальной сети.
- Overlay token не должен давать write access ко всем game sessions, settings, TTS, media или local control. Разделить capabilities по read, game report, config, media/TTS.
- Проверить все local service routes на auth, method, body-size, CORS/Origin, path traversal, rate limit и понятный revoke flow. Проверить динамический порт при нескольких окнах/нескольких app restarts.

### P0.7. Fail-safe upload, extraction и artifact integrity

- `MAX_BUILD_SIZE` по умолчанию 2 GiB, Fastify принимает raw Buffer и `build_store.js` держит весь zip в памяти. Перейти на streaming upload во временный файл с лимитом, backpressure, timeout, quota, disk-space check и cleanup; размер по заголовку не считать единственной защитой.
- Текущая ZIP-проверка проверяет central directory и root executable, но launcher extraction не ограничивает суммарный распакованный размер, число entries, compression ratio и размер каждого entry. Защита от zip bomb, malformed ZIP, duplicate/path-collision entries, symlink/special file, absolute/UNC/drive paths и case-insensitive path collision обязательна и на upload, и на client extraction.
- Задать лимиты: upload compressed bytes, entry count, expanded bytes, per-file bytes, compression ratio, path length, archive processing time. Значения конфигурируемы и имеют production-safe hard max.
- Не принимать build только потому, что в ZIP присутствует root exe: валидировать manifest/schema, ожидаемое имя, version, target OS/arch, hash и package metadata; отклонять непредвиденные executables/scripts по политике publisher.
- Server artifact write и DB metadata publish должны иметь rollback/reconciliation: никаких published row без файла/sha, orphan cleanup с безопасным retention. Ни upload, ни rollback не перезаписывают immutable `(slug,version)` artifact.
- SHA-256 уже присутствует, но integrity не эквивалентна доверенной подписи. Production pipeline должен подписывать publisher/first-party binaries (Authenticode) и проверять signature/issuer или явно предупреждать пользователя. Для game artifacts — manifest, hash, trusted publisher, provenance; AV scan/sandbox policy.
- Installer/server artifacts, MC plugin jars и Tauri updater должны иметь независимые integrity/signature tests.

### P0.8. Production boot/runtime guardrails

- `validateProductionConfig()` уже требует сильные JWT/HWID secrets и запрещает mock billing; сохранить это.
- Добавить production fail-fast для `OWNER_TG_IDS`, публичного HTTPS base URL при включённых OAuth/payment flows, безопасного trust-proxy режима, случайно включённых webhook bypass flags, некорректных CORS/URL/port/path, неустойчивого DB/static paths и provider configs.
- `BILLING_WEBHOOK_SKIP_IP_CHECK=1` — только test-only; production startup обязан падать при включённом флаге.
- `SERVER_HOST` production за proxy должен быть `127.0.0.1`/private bind; startup warning/failure если API открыт на public interface вопреки deployment mode.
- Разделить `liveness` и `readiness`: liveness дешёвый, readiness проверяет DB/schema/static storage и обязательную конфигурацию. Не раскрывать secrets/paths/schema в публичном response.
- Graceful shutdown: прекращать принимать новые uploads/requests, завершать in-flight payment/download, закрывать SQLite, sidecar/worker timers; проверять SIGTERM и process crash.

## 5. P1 — account, role, privacy и злоупотребления

### 5.1 Account security

- Нормализовать email: trim, lowercase, canonical uniqueness; учесть миграцию colliding variants. Login/register обязаны использовать одинаковую функцию.
- Установить подтверждение email, пароль-сброс/recovery, парольную политику и upper bound; текущий минимум 6 символов недостаточен для публичного платного сервиса. Не раскрывать наличие email в reset flow.
- Перевести sync `scryptSync` на bounded async hashing/worker; ограничить request body/field lengths и гарантировать отсутствие event-loop DoS.
- JWT: зафиксировать алгоритм, issuer, audience, token type, TTL, clock-skew policy и key rotation/key-id. Сохранить DB-side `token_version` invalidation. Определить последствия смены секретов и массовый logout.
- Rate limits должны быть распределёнными/персистентными там, где это влияет на auth, webhook, promo, payment, pairing, OAuth, publisher uploads и admin. In-memory limiter не считается shared protection. Для одного SQLite node задать отдельный per-IP/per-account/per-token лимит, global limits, `Retry-After`, abuse alert.
- Убрать email enumeration насколько допускает UX, CAPTCHA/proof-of-work не вводить без анализа.
- Owner/admin — обязательный MFA/step-up auth для grant-days, role change, plan/price edits, promo mint, build publish/transfer, key rotation and refunds. Чувствительные операции требуют reason/comment и actor/target audit.

### 5.2 Telegram, TikTok, DonationAlerts identity

- Реализовать защиту login/pair deep links от phishing: бот не должен silently claim `login_*`/`pair_*` без явного подтверждения с описанием устройства/времени; denied/expired/reused state определены. Проверить atomic single-use state.
- Исправить/покрыть mismatch контрактов bot↔API (`product_url`/`payment_url`, masked identity fields), HTML-escape все динамические Telegram HTML values, allowlist payment link hosts.
- Проверить, что `/pair-status` не сжигает код до валидации HWID/eligibility/transactional completion. Ошибка должна быть retryable без невозможности повторного входа.
- Удалять expired/consumed `pair_codes`, `tg_login_codes`, OAuth states и billing-link codes; plaintext session cookies удалять немедленно. Ввести retention и privacy deletion flow.
- TikTok cookie-session flow — high sensitivity, unofficial and potentially incompatible with TikTok policy. Предпочитать official Login Kit; пока cookie flow остаётся, согласие, encryption, TTL, one-account binding, revocation, access logs without secret, incident procedure обязательны.
- DonationAlerts pasted access token — до OAuth flow считать чувствительным credential: хранить в DPAPI, отображать только маску, revoke/replace, не включать в diagnostics. Проверить Centrifugo reconnect, token expiry, refresh, event duplication.
- TikTok connector и EulerStream signing — best-effort third-party dependency. Pin/test connector versions, monitor upstream breakage, have documented fallback and honest status; paid Euler key хранить только на server. Не давать sidecar fallback обходить тарифную политику, если контрактом платный signing является feature; текущая политика «без подписки direct free tier» должна быть явным продуктовым решением и тестом.
- Проверить актуальные TikTok/DonationAlerts/Tribute terms, data processing, brand usage и условия сбора/пересылки публичных сообщений.

### 5.3 Referral/promo/support abuse

- Referral rewards сейчас начисляются при применении кода; определить qualifying event, self-referral, multi-account/HWID reset, one reward per verified account, caps, refunds/chargebacks, abuse review and manual reversal.
- Promo redemption/use counter и subscription ledger должны commit атомарно; обеспечить конкурентные попытки и административную отмену.
- Support tickets: owner scoping уже есть; добавить attachment policy (если появится), abuse rate caps, secure HTML/text rendering, deletion/retention, notification strategy and staff-only notes separation.
- Публичные/live chat/TTS events: cap lengths, Unicode controls/bidi, URL stripping, spam/cooldowns, allow/block list and emergency mute. Do not render untrusted data as markup.

## 6. P1 — game/product quality and honest DRM

### 6.1 Launch licensing

- Current launcher makes `/api/license/verify`, then creates local one-time UUID; a modified/fake client can emulate the local protocol. Document explicitly that this is casual DRM, not tamper-proof.
- For commercial first-party SDK games, introduce server-issued short-lived signed launch ticket bound to `user_id`, game slug/build hash, entitlement/plan, device hash, issued/expiry, nonce and protocol. Keep signing key server-only; publish-key rotation/version format documented. SDK verifies signature and rejects expired/replayed/wrong-build tickets; tests cover server outage and clock skew.
- Avoid claiming tickets prevent binary patching: local executable owner can alter verifier. High-value game logic must be server-authoritative or accept bypass risk. Define offline grace-period behavior.
- Local one-time WS token must be unpredictable, single use, short TTL, constant-time compare if relevant, per-session/port scoped, and never argv/log/query if avoidable. Handshake timeout, heartbeat and process lifecycle must stay tested.

### 6.2 Game catalog/publishing

- Keep draft → upload → review/publish lifecycle; immutable builds; `sha256`, size, changelog, executable/OS/arch manifest; rollback publishes a new higher semver. Publisher can access own games only; admin/owner policy separated.
- Validate metadata schema and reasonable string/URL lengths, cover art external URLs, version semver (including prerelease ordering), build content, exact target platform and antivirus/signature. No user-facing “Steam auto-update” guarantee unless poll, hash, staging swap and recovery are validated end-to-end.
- Current migration v2 tolerates missing files and writes an empty sha/zero size while publishing legacy game rows. Replace with preflight + recoverable migration: report missing artifacts and do not silently create unusable published build. Back up DB/artifacts, dry-run, verify hashes, then commit.
- Test interrupted upload, interrupted DB update, process restart, update while game running, insufficient disk, hash mismatch, ZIP traversal/bomb, locked files, rollback failure and preservation of previous install. Concurrent downloads/install attempts for same slug must serialize.
- Publisher pipeline: status, cancellation/rejection feedback, moderation, owner transfer, audit, per-publisher quotas, review malware scan and provenance.
- Drop-in game packs can execute arbitrary local HTML/JS and user-pack can override built-in IDs. Define trust boundary: explicitly mark local untrusted mods, prevent silent overrides, sandbox/origin isolate where possible, do not give packs app IPC/auth tokens/admin state. Signed trusted catalogue versus manually imported content.

### 6.3 Gamekit correctness and event delivery

- Fix the observed failing replay-deduplication contract. Prefer upstream stable event ID (`event_id`/provider ID) when present. For providers with no stable ID, define time/fingerprint window that suppresses actual reconnect redeliveries without losing two legitimate identical gifts. Update test cases to exactly encode product semantics; preserve high-frequency repeats/count/streaks.
- Deduplication must apply across reconnect/retry and be memory-bounded; test event ID collisions, absent timestamps, clock skew, same-millisecond distinct events, gift streak ticks, DA retries and process restart assumptions.
- Validate normalized event schema/types/ranges; preserve separate `amount`, `count`, `coins`, gift id and like cumulative-vs-batch semantics. Do not trust TikTok nicknames or connector payload.
- Bound every queue/map/cache, per-user state cardinality, game results, feed, widget lists, scoreboard names and timers. Add cleanup for `userMin`, `ruleCd`, cooldown maps and persistent results.
- Per-game page exceptions, invalid `game.json`, missing assets and bad rules must fail with localized actionable diagnostics rather than blanking the app or HTML-injecting exception text.

### 6.4 TTS, media, widgets and game overlays

- State clearly whether Edge neural TTS sends chat text/usernames to Microsoft service; obtain consent and document processor/retention. Offline SAPI/Piper modes, mute, rate/length limits and data minimization.
- Piper/RVC model downloads need source allowlist, verified hashes/signatures, size caps, license metadata, decompression/path safety and untrusted model warning. RVC server endpoints and Python dependencies need isolation, localhost bind and update model.
- Media import already has format/size caps; validate duration for every supported video container, parser fuzzing, safe MIME/range delivery, cleanup/index reconciliation and resource quotas.
- Dynamic media/image URLs must be local allowlisted paths or verified HTTPS, not arbitrary `javascript:`, `file:`, `data:` execution surfaces.
- Widgets must work in OBS and TikTok LIVE Studio with transparent/chroma, DPI/resolution, browser-source audio and token refresh. Provide per-widget credentials and reset-all action.
- Timers/goals/polls/queues/subathon/points/hype/spinner/EFIR-import: schema validate all user-loaded JSON; legacy settings backward compatibility; avoid NaN, huge arrays, zero/negative durations, unbounded text; test restart/pause/resume/clock-change.

### 6.5 Managed Minecraft and external servers

- Keep explicit EULA consent and log it with version/time. Display Paper/Mojang/Java/plugin licenses and third-party notices.
- Downloads use HTTPS allowlist, response limits, streaming, hash validation, zip bomb defenses and atomic installation. Current JRE/Paper methods buffer full archives in memory; fix.
- Confirm RCON is bound to loopback only and firewall inaccessible externally; password remains OS-protected. `server.properties` should not expose RCON remotely. Bound user console templates/placeholders/commands and sanitize injection/newlines/commands.
- World reset is destructive: require typed confirmation/backup, stop check, safe path and recoverability; backup is off-volume and restore-tested, not merely a local zip. Protect RAM/disk/CPU and set child process/resource limits.
- Plugin JARs are executable code. Publisher allowlist/review/signature/scan, compatibility (Minecraft/Paper/Java), artifact provenance, uninstall and rollback. Server plugin uploads must be immutable and not be overwritten on repeated version.
- Roblox relay: enforce credential scope, rate/body caps, anti-replay launch tickets, `job_id`/Roblox UID validation, stale claims, queue retention, per-user data quotas and no keys in query strings/logs. Server-side `stream_key`/room-key rotation, revocation and compromised account response.

## 7. Server data, reliability and operations

### 7.1 Persistence and migrations

- Current SQLite is synchronous; keep one process initially. Ensure WAL checkpointing, busy timeout, FK enforcement, indexes for all growing/lookup tables, integrity check and disk-full behavior.
- Review every migration v1–v16 and current `PRAGMA user_version`: run from empty DB and fixture copies of every supported version; preserve IDs/foreign keys/subscription/payment ledger; verify rollback on failure. Migration tests must not depend on current developer database.
- Before schema/data migration: create consistent `.backup`, verify file/hash, retain off-host copy, dry-run migration and post-migration invariant checks. Restore procedure is exercised on a staging copy.
- `DATABASE_PATH` relative-path semantics currently depend on process cwd; normalize configured relative paths to a documented root or require absolute production paths.
- Migrations must fail loudly when an invariant/artifact is missing; no silently-successful published rows with empty hashes.
- Add DB health / backup freshness alerts, integrity checks, free-space alerts and explicit recovery commands. Backup encryption and offsite copy are required; daily 14 local copies alone are insufficient. Define RPO/RTO and run quarterly restore drill.

### 7.2 Retention and privacy

- Inventory PII/secrets: email, masked/raw Telegram/TikTok IDs, TikTok sessionid, comments/usernames, stream events, usage, support tickets/messages, IP/HWID HMACs, payment provider payloads, media/results.
- Define purpose, collection, processor, retention, deletion/anonymization, account export and account deletion. Keep billing records only as legally required; minimize the rest.
- Add retention/sweep jobs for expired login attempts, pair/login/billing link codes, OAuth states, unlinked webhook events, stream queues, device events, usage nonces, audit/support logs and abandoned temporary uploads. Do not delete financial audit required for accounting.
- Existing `billing_events`, `device_events`, `admin_audit`, `support_messages`, payments and game result stores can grow without clear retention. Add indexed cleanup/archive policies and test they do not remove active/unmatched items.
- `GET /api/health` is currently a timestamp liveness response only. Add readiness and operator-only diagnostics with no PII/secrets.

### 7.3 Logs, metrics, support

- Structured server logs with request id, route template, status, latency, actor ID only where necessary, and redaction. Never log body, auth headers, raw URL query token, cookie/sessionid, password, HWID, DA/Telegram/payment secrets or full provider payload.
- Launcher has rotated logs/diagnostics; audit redaction against every new credential pattern and prevent clipboard reports from exposing private viewer data.
- Add basic metrics: request/error/latency by route, DB busy/disk/WAL, payment state transitions, webhook duplicate/failure, upload sizes, queue depth/drop rate, game downloads, sidecar states/reconnects, updater errors, support response time. Do not send viewer text or identifiers to telemetry.
- Operator alerting: API unavailable/readiness failure, disk near full, backup overdue, repeated payment failures, invalid webhook spikes, release/update signature failures. Provide incident runbooks and emergency disable switches.
- `x-request-id` is currently echoed to clients; validate it is server-generated (already generated with `crypto.randomUUID`) and never accepts untrusted replacement.

## 8. Desktop app, installer and update channel

### 8.1 Release build and environment

- Current release `api.rs` pins `env!("VITE_API_URL")` and blocks `set_server_url`; retain. Build must fail if URL is missing/non-HTTPS in production; test release binary has expected exact API URL and no test URL.
- `package.json` currently claims Node `>=20`, while `node:sqlite` needs Node >=22.5; align root/server engines, `.nvmrc`/tool-version, CI and deployment to supported Node 22 LTS patch. Sidecar Node runtime must be version-pinned and verified.
- Agent environment note `AGENTS.md` references a different `D:\DEVIN PROJECT\...` path and w64devkit location; reconcile docs against this checkout `D:\chlauncher`, CI and actual local toolchain. Do not bake stale local path into project.
- Release job currently checks downloaded `node.exe` size only. Verify official Node checksum/signature before bundling; pin GitHub Actions by commit SHA (or document controlled update process), least-privilege permissions, immutable npm/Cargo lockfiles, dependency/SCA/license scan and SBOM.
- Tauri release is Windows-only now. State supported OS/architectures and minimum Windows/WebView2 clearly; don't advertise macOS/Linux until CI installers, signing, updater and clean VM tests exist.
- Code-sign installer and app with Authenticode certificate/Trusted Signing before general distribution; verify publisher chain/timestamp. Updater minisign key separate, protected, rotated with documented recovery. Never store private signing key in repo.

### 8.2 Updater correctness

- Verify actual Tauri 2 NSIS updater artifact format and `.sig` produced by current CI, `latest.json` schema/platform key, URL, semantic version and signature. Workflow assumes a signature adjacent to `*-setup.exe`; prove this by reading CI artifact output, not comments.
- Add a release CI test that downloads the generated manifest/artifact and verifies signature with the shipped public key. Install previous release in clean Windows Sandbox/VM, publish signed update, verify update/restart/rollback/failure behavior. Tampered/unsigned artifact must be rejected.
- Ensure latest endpoint never points to draft/pre-release or wrong architecture; support minimum version/forced security update, staged rollout/kill switch and rollback.
- Protect updater private key, release workflow, tag permissions and repo settings. Require reviewed signed tags/release approval; actions do not publish arbitrary PR builds.
- Current frontend silently ignores updater errors. Record sanitized reason in diagnostics and offer manual check/retry without bricking app.

### 8.3 Tauri security and local process

- Review every `invoke_handler` command and capability. Ensure no sensitive command is reachable from untrusted remote origins/overlay game windows; capability scope only main app. Add explicit permissions and an allowlist for opener schemes/hosts.
- `capabilities/default.json` has core/window/event, deep-link, opener and updater defaults; verify dialog/global-shortcut permissions and only grant required APIs.
- Process spawning uses absolute/canonical executable paths, no shell interpolation, controlled cwd/env, restricted inherited environment, stdin token delivery, bounded stdout/stderr buffers, timeout/kill tree and no orphan process. Test Windows child process trees.
- Ensure user game executable signature/hash is rechecked immediately before start; avoid TOCTOU between verification and spawn where feasible.
- HWID is a privacy-sensitive pseudonymous identifier; explain why collected, store HMAC only server-side, retain/reset safely, and do not treat HWID as strong hardware attestation.
- Keep local Game WS/overlay/Roblox bridge bound to loopback and random ports; guard against local other-user processes, malicious webpages, CSRF/DNS rebinding, origin spoofing and token guessing.
- Settings migration/recovery (`settings.json.bak`) must not make plaintext-secret copies indefinitely. Version settings schema and test old/new upgrade, corrupt file, BOM, disk full and concurrent saves.

## 9. Release engineering and CI

1. CI required on PR and `main`: `npm ci`, launcher `tsc+vite build`, all server tests, launcher unit tests, all Rust workspace + Tauri lib/integration tests, `fmt`, clippy `-D warnings`, sidecar deterministic bundle, gift catalog check, schema migrations, packaging smoke, security/static analysis.
2. Release workflow must fail on any test failure (including current `gamekit` test), missing secrets/vars, wrong URL, stale sidecar bundle, absent updater signature, non-static runtime dependency, invalid manifest or absent installer.
3. Add Windows clean-room install/update E2E on supported OS versions. Confirm WebView2 bootstrapper works offline/online per supported claim, user-scope install/uninstall, file association/deep links, no admin privileges, no Node/Rust requirement, AV false-positive/signing.
4. Add dependency lock verification, npm/Cargo vulnerability scanning (with reviewed exceptions), license notices, secret scanning, CodeQL or equivalent, artifact SBOM and provenance attestation.
5. Pin the Node version. Current CI uses Node 22 but package engines are too permissive. Pin sidecar runtime independently.
6. Release artifact contains installer, updater artifacts/manifest, checksums, SBOM, changelog, supported-version info and security contact. No `.env`, DB, source secrets, test admin credentials, personal Euler/TikTok/DA tokens or developer data.
7. Staging release must use staging API/provider accounts, staging DB/artifacts and test callbacks. Never point public prerelease installer to a developer's home PC / transient localtunnel URL.
8. Add dependency/license review for TikTok connector, Edge TTS, Paper/plugins, gift images, fonts, sound effects, game assets and bundled Node runtime.

## 10. User experience and launch policy

- Before public paid release, decide canonical login (email, Telegram, TikTok) and migration/merge policy; `docs/tg-auth-spec.md` is explicitly draft and enumerates unresolved phishing, account merge, unbind, session retention and webhook reconciliation issues.
- Add terms of service, privacy policy, refund/cancellation support, data export/deletion, consent for TikTok/DA event processing and TTS cloud processing, cookie-session risk warning, EULA/licenses/third-party notices and support/security contact.
- Display honest integration status/fallback; distinguish TikTok room lookup, webcast socket connected, LIVE state and event delivery. Connector is unofficial/best-effort; do not promise guaranteed API availability.
- Provide clear setup wizard, onboarding/demo mode, health checks, recovery steps, upgrade notes, game-specific setup and log export. Simulate event path must match live event path without affecting production counters/billing.
- Explain that viewer events are untrusted public content and streamed content can be offensive. Emergency stop/mute, per-event filtering, allowlist/blocklist and max actions per minute must be obvious.
- Do not promise “all games”, “zero setup”, “updates like Steam” or DRM guarantees beyond measured/implemented behavior.

## 11. Implementation phases and exit gates

### Phase 0 — current-state baseline (no production mutation)

- Capture route/API inventory, frontend pages, Tauri IPC command list, migration list, environment key names (never values), build/release artifacts and user-visible product claims.
- Reproduce failing server test; determine whether implementation or expectation is wrong. Run frontend build, all Rust tests/clippy/fmt, sidecar bundle tests, clean install/updater tests. Record commands and exact results.
- Resolve owner decisions: first provider (Tribute vs YooKassa), price/currency/period/refund policy, login identity/migration, supported OS, free-tier entitlements, game catalog launch list, data retention and owner recovery.
- Exit: signed-off threat model/decision log, clean reproducible baseline report, no destructive changes.

### Phase 1 — security and data integrity (P0)

- Fix DOM sinks/CSP; secure local overlay endpoints/token lifecycle; encrypt secrets; fail-closed owner; production config; upload/extraction safety; server-side entitlement checks.
- Make payment/billing state machines transactional and idempotent; test webhook validation, failure recovery and refund policy using provider sandbox only.
- Fix failing gamekit dedupe contract and add stable event identity.
- Exit: security test matrix passes, no critical/high findings open, no plaintext secrets in settings/DB/logs/diagnostics, all server gates authoritative.

### Phase 2 — production operations

- Select VPS/private storage topology; implement deploy scripts/systemd/proxy/TLS/firewall/secrets/health/readiness/logs/metrics/backup/restore. Normalize paths and Node version.
- Implement data retention, account deletion/export policy and database migration preflight/recovery.
- Exit: staging deploy survives reboot, process crash, SIGTERM, disk pressure simulation, invalid config, restore and rollback; public origin cannot be accessed around proxy.

### Phase 3 — payments, support, identity

- Configure chosen provider in staging, test full checkout→callback/webhook→entitlement→renewal/cancel/refund→support scenario; Telegram bot flow and security checks.
- Add email verification/recovery or explicit alternative account recovery; MFA for owner/admin. Close `tg-auth-spec.md` unresolved security issues or remove unsupported paths from public UI.
- Exit: provider sandbox evidence, reconciled ledger, duplicate/retry/out-of-order tests, tested account recovery and no silent login/pair claims.

### Phase 4 — artifact, installer and updater

- Implement streamed uploads, validation/signature/provenance, atomic install and catalog entitlement. Complete installer Authenticode and updater signature pipeline.
- Windows clean VM install→register→connect TikTok/DA→test game→download/update/rollback→upgrade app→uninstall/reinstall without losing data.
- Exit: CI-built release—not a local dev artifact—passes smoke tests and signed update verification on clean supported Windows.

### Phase 5 — beta/production rollout

- Internal owner and co-admin pilot, then opt-in external beta with explicit feedback/support process. Use separate staging/prod and feature flags.
- Gradual release cohort, monitor crash/connectivity/payment/update metrics, rollback switch, incident runbooks and status page.
- Exit: owner signoff, all launch criteria below, no temporary tunnel/home-host URLs, payment/privacy/legal/provider prerequisites closed.

## 12. Required test plan

### Backend/API

- `npm run test:server` fully green and deterministic. Add tests for every security/payment/role item above, production startup fail-fast, owner missing, trust proxy spoof, forwarded headers, request-size limits, readiness, rate limits, migrations from every schema version.
- Auth: normalized email, password boundary/DoS, enumerate resistance, invalid/expired/revoked JWT, role demotion, MFA/step-up, HWID missing/mismatch/reset/recovery, concurrent register/login.
- Entitlements: every plan × game/plugin × license/download/TikTok-sign endpoint matrix, expired/pending/refunded/canceled subscription and server outage.
- Billing: provider sandbox contract tests + fault injection + concurrent webhook/checkouts + duplicate/out-of-order + mismatched amount/currency + refund/chargeback + reconciliation.
- Upload: malformed/truncated/zip bomb/zip slip/absolute path/symlink/duplicate/case collision/missing exe/oversize/slow upload/disk full, atomic rollback.
- API abuse: huge JSON/event, malformed UTF-8, SQL values, path/query attacks, XSS payloads, rate-limit bypass through IPv6/proxy, leaked key in query.

### Launcher/Rust/sidecar

- `cargo fmt --check`, workspace tests, `cargo test --manifest-path apps/launcher/src-tauri/Cargo.toml --lib`, `cargo clippy --all-targets -- -D warnings`, cargo check/build for release.
- App startup with missing/corrupt/migrated settings; secret-store import/clear; install/update/hash/archive limits; kill/update races; local services random port, origin rejection and process shutdown.
- Sidecar contract fixtures from recorded/synthetic events: every event kind, repeats/streaks, gift_tick, IDs, missing fields, high burst, reconnect duplicates, malformed lines, stdin EOF, EPIPE, timeout, free and paid signing proxy, invalid subscription, expired TikTok cookie.
- Test TikTok/DA integration only with explicitly authorized accounts/test rooms, never use a real user session in CI.

### Frontend and live product

- `npm run build --workspace @chlauncher/launcher`; unit tests for `errorMessages`, auth/pair/billing flows, entitlement UI cache and offline behavior.
- Playwright/WebView2 or equivalent tests for all primary pages, accessibility keyboard/focus, Russian UI, low resolution/DPI, long email/window narrowness, overlay capture transparency/chroma and media/audio.
- Malicious viewer strings and URLs in every dynamic HTML sink; visual regression on main onboarding/mapper/subscription/library/admin.
- Demo event flow must work without TikTok/DA; live flow must not count a simulated/test event as a real billing/usage event.

### Operational/release

- Run staging deploy and restore drill from encrypted offsite backup; test migration rollback and disk quota.
- Verify release file hash/signatures, manifest version/URL/platform schema, Authenticode, updater signature and full in-place upgrade. Tampered installer/update must fail verification.
- Smoke-check API from outside network over HTTPS, TLS grade, proxy bypass/firewall, webhook provider sandbox, WAF/rate-limit, logs redaction and monitoring alerts.

## 13. Documentation deliverables

Update rather than append conflicting instructions:

- Root `README.md`: truthful feature status, prerequisites/Node >=22.5+, supported OS, dev commands, current tests, production gates, release limitations.
- `apps/server/README.md`, `apps/launcher/README.md`: actual current contracts and architecture; remove obsolete `:9876/:9877` assumptions where ports are dynamic and remove obsolete mock-only billing claims.
- `docs/architecture.md`, `docs/operations.md`, `docs/testing.md`, `docs/vps-deploy.md`, `docs/cloudflare-deploy.md`, `docs/protocol.md`, `docs/admin-and-updates-spec.md`, `docs/tg-auth-spec.md`: reconcile with current code and mark implemented/deferred/unsafe.
- `.env.example`: correct required/optional envs and production validation; never include working defaults for secrets; explain distinct owner bootstrap, provider secrets, trusted proxy CIDRs, public base URL, artifact storage, backup and staging.
- Add `SECURITY.md` with disclosure contact, supported versions and credential rotation/incident procedures; add privacy/terms/third-party notices as product deliverables with owner/legal review.
- Include an operator runbook: deploy, backup/restore, migration, rotate JWT/HWID/provider/bot/updater secrets, revoke compromised sessions/stream key, disable checkout/catalog, rollback app/server, support incident.

## 14. Production launch acceptance checklist (all must pass)

1. Server suite is fully green, Rust + frontend + sidecar bundle checks pass in CI, and the current gamekit failure is resolved with a documented event dedupe contract.
2. Security review has no open critical/high issue: no viewer-controlled XSS, CSP active, secrets OS-protected, no raw TikTok cookies in DB, overlay/local APIs scoped, owner/admin/MFA enforced, uploads/extraction bounded, trusted proxy correctly scoped.
3. Server enforces plan entitlements on every protected download/license/plugin/proxy route; tests prove a modified client cannot obtain another plan’s server-controlled artifact.
4. Payment sandbox test demonstrates atomic idempotent grant and correct cancel/refund/chargeback/reconciliation behavior; real checkout is disabled until provider/legal/account configuration is approved.
5. Owner IDs/recovery configured and validated; empty owner configuration fails closed in production. No email-based auto-admin.
6. Production API is on stable VPS/managed VM with persistent storage, real domain/HTTPS, firewall/origin protection, secrets outside repo, health/readiness, monitoring and tested offsite restore. Not home IP, quick tunnel, localtunnel, or ephemeral URL.
7. Current docs/config all agree; no developer secret/account/URL/test DB in installer, logs, repository, public release notes or screenshots.
8. Release is CI-built, Authenticode-signed, updater-signed, versioned, checksummed, SBOM/provenance attached, and installed/updated on clean supported Windows versions.
9. Privacy, terms, refund/support, third-party licenses and TikTok/DA/Tribute policies reviewed; PII/session data collection and retention disclosed and deletion flow works.
10. Staged rollout has an owner/co-admin on-call plan, error budget/monitoring, rollback and security incident playbook.

## 15. Final report expected from SWE-2 High

Return:

- Current-state audit with confirmed code/test references; separate proven issues from assumptions and external owner decisions.
- Implementation summary by phase, changed files/migrations, compatibility and rollback notes.
- Exact commands run and pass/fail output; never report an unrun test as passing.
- Staging deployment and clean-VM install/update evidence (artifact version/hash, not secret values).
- Remaining risks with severity, owner action, and explicit “not production-ready” statement if any acceptance item remains open.
- List of secrets/providers/domains/configuration the owner must supply through secure channels; do not request secret values in chat.
