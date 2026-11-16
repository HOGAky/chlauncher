# NIGHT REPORT — 2025-11-09

Автономная сессия. Коммиты в `main`:

| Коммит | Содержание |
|---|---|
| `9db7464` | MSVC/static CRT, бандлинг сайдкара, updater, lock прод-URL, release CI, VPS-доки, backup-скрипт |
| `3e06371` | Ревью-фиксы release.yml: `VITE_API_URL` в ci.yml, dumpbin для обоих exe + whitelist WebView2Loader, `setup-msbuild` для PATH |
| `<этот>` | Прокси подписи TikTok через бэкенд, персистентный rate-limit, security headers, фикс loader-проблемы тестов |

---

## 1. Подписание TikTok/EulerStream перенесено за бэкенд

**Проблема:** платный ключ EulerStream нельзя шиповать в клиенте — он
извлекается из памяти/файлов за минуты.

**Решение — сквозная цепочка:**

```
launcher (JWT) ──stdin──> sidecar ──HTTP──> /api/tiktok-sign/* ──> api.eulerstream.com
                                              ^ инъекция x-api-key на сервере
```

- `apps/server/src/routes/tiktok.js` — прозрачный прокси: auth (JWT) +
  активная подписка + whitelist путей `tiktok/*` и `webcast/*` +
  сквозная передача status/headers/body (SDK читает `x-set-tt-cookie`,
  `x-room-id`, protobuf-тела). Клиентские `authorization`/`x-api-key`
  вырезаются, серверный `EULERSTREAM_API_KEY` подставляется сам.
  Без ключа → `503 SIGN_NOT_CONFIGURED` (не краш).
  Per-user sliding window: 120 req/min (`TIKTOK_SIGN_MAX_PER_MIN`).
- `GET /api/tiktok-sign/ping` → `{enabled: bool}` — сайдкар спрашивает
  перед выбором пути. `enabled:false` → fallback на бесплатный тир.
- `tools/tiktok-sidecar/index.js` — читает одну JSON-строку из stdin
  `{sign_url, token}`; пингует прокси; `SUBSCRIPTION_REQUIRED` →
  структурная ошибка + exit 3; enabled → `SignConfig.basePath` +
  `Authorization: Bearer <jwt>`; иначе прямой EulerStream (free tier).
- `apps/launcher/src-tauri/src/integrations.rs` — спавн сайдкара держит
  stdin piped, пишет конфиг-строку и закрывает поток. JWT идёт по
  пайпу, не виден в argv/списке процессов.
- `commands.rs::tiktok_connect` — собирает `(base/api/tiktok-sign, jwt)`
  из сессии; без логина — free tier.
- `config.js` — `EULERSTREAM_API_KEY`, `EULERSTREAM_BASE_URL`,
  `TIKTOK_SIGN_MAX_PER_MIN`.
- `app.js` — raw-body parser для префикса `/api/tiktok-sign/` (тело
  проксируется байт-в-байт).

**Необходимое действие:** задать `EULERSTREAM_API_KEY` на сервере для
платного тира. Без него всё работает, но на бесплатных лимитах.

## 2. Персистентный rate-limit на логин

- In-memory `Map` заменён таблицей `login_attempts` (миграция v4):
  ключ `hmac(ip)|email_lower`, 5 фейлов / 15 мин → 429 + `retry_after_ms`.
  Локаут переживает рестарт; сырые IP в таблице не хранятся.
- Sweep раз в 10 мин (`unref`'d, снимается в `onClose`) — таблица не
  растёт от спрея случайных email.
- HTTP-лимиты поверх: register 20/min, login 30/min, admin уже был
  300/min — защита от флуда ещё до обращения к БД.
- `/api/health` есть (уже был): `{ok, ts}`.

## 3. Security headers

`x-content-type-options: nosniff`, `x-frame-options: DENY`,
`referrer-policy: no-referrer` на все ответы (onSend-хук, дёшево).
CORS-whitelist и trustProxy без изменений.

## 4. Разгадана «GNU loader-проблема» — починена

Долгоживущий `STATUS_ENTRYPOINT_NOT_FOUND` у test/example-бинарников
оказался **не toolchain-багом**, а отсутствием манифеста:

- `tauri-build` встраивает манифест (Common Controls v6) только в
  финальные бинарники (`rustc-link-arg-bins`).
- Дерево зависимостей импортирует `TaskDialogIndirect` — он существует
  только в comctl32 **v6**, которая подключается через манифест.
- Итог: unittest/example-бинарники падали на стадии загрузчика ДО main.

**Фикс** (`build.rs` + `embed-resource` в build-deps): мини-манифест
comctl32-v6 линкуется во все линкуемые таргеты на Windows. Теперь:

- `cargo test` — **8/8 unit-тестов зелёные** (forwarder, logging, process).
- `cargo run --example e2e_launch` — **PASS**: реальный прогон
  WS-сервер → spawn mock-game → токен через stdin → handshake →
  dispatch события → корректный shutdown.

Второй слой бага при прогоне e2e: `WebView2Loader.dll` должен лежать
рядом с exe (cargo кладёт его в `deps/`, для example — нужна копия;
осторожно — в target есть и ARM64-вариант, не перепутать).
В шипуемом инсталлере NSIS кладёт DLL рядом с exe — всё ок.

Следствие: `cargo clippy --all-targets`/`fmt`/`test` теперь работают и
на GNU-override этой машины, и на MSVC в CI без костылей.

## 5. Прочая зачистка

- `.env.example` — секция TikTok signing: режим A (серверный ключ,
  рекомендуемый) vs режим B (личный/free-tier в лаунчере).
- Prod-`unwrap` скан — чисто (оставшиеся только в `#[cfg(test)]`).
- Починены отступы в `auth.js` после правок rate-limit.
- Удалены временные файлы (`uniq_imports.txt`, манифест-пробы).

## Проверки (актуальный прогон)

| Проверка | Результат |
|---|---|
| `npm run test:server` | **70/70 PASS** |
| `npm run build` (launcher frontend) | OK |
| `cargo test --workspace --exclude chlauncher` (SDK+mock-game) | 3+1 PASS |
| `cargo test` (src-tauri unit) | **8/8 PASS** (раньше крашились) |
| e2e_launch harness | **PASS** (handshake+events+shutdown) |
| `cargo clippy --all-targets` | 0 warnings |
| `cargo fmt --check` | clean |
| sidecar bundle (`npm run bundle`) | 3.2 MB, single file |
| sidecar: пустой юзер / несуществующий / dead-proxy | структурные ошибки, без крашей |
| release без `VITE_API_URL` | преднамеренный compile error ✓ |

## Открытые пункты (нужен ты)

1. GitHub Vars/Secrets: `VITE_API_URL`, `TAURI_SIGNING_PRIVATE_KEY(+
   _PASSWORD)`, опц. `ADMIN_EMAIL`/`ADMIN_PASSWORD`.
2. `EULERSTREAM_API_KEY` на сервере — иначе сайдкар на free-тир лимитах.
3. Тег `v0.1.0-rc1` → прогон release.yml → установка артефакта на
   чистую ВМ/Windows Sandbox.
4. Code signing cert (Trusted Signing/Certum) — вне репо.
