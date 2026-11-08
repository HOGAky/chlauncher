# Production-hardening sprint report

One constrained sprint (8 tasks) over the existing codebase — minimal,
reversible changes, no architecture rewrites, no new integrations.

## Выполнено

### T1 — Production safety
- `config.js`: `loadConfig()` now hard-requires `JWT_SECRET` ≠ dev sentinel,
  `HWID_HASH_SECRET`, and forbids `ENABLE_MOCK_BILLING=1` when
  `NODE_ENV=production`; `ADMIN_EMAILS` is ignored (with warning) in prod —
  grant via `tools/grant-admin.mjs`.
- `app.js`: CORS whitelist from `CORS_ORIGINS` (dev defaults for
  Vite/Tauri; prod = explicit only; disallowed origins get no headers);
  `trustProxy` behind `TRUST_PROXY=true`.
- `.env.example`: `NODE_ENV`, `CORS_ORIGINS`, `TRUST_PROXY`,
  `HWID_HASH_SECRET`, `SERVER_HOST` documented.
- Tests: `test/production.test.js` covers all fail-fast scenarios.

### T2 — Secure download/install/process lifecycle
- Slug regex `^[a-z0-9][a-z0-9_-]{0,63}$` on server routes and Tauri commands.
- `games.js`: filename validated + canonicalized inside `static/games`.
- Client `verify_install`: exe canonicalized inside install dir, name
  checked against catalog, SHA-256 re-verified when recorded.
- `process.rs`: states `Launching/Running/Exited/Crashed/FailedToStart`,
  200-line stdout/stderr ring buffers, saved `ExitStatus`, PID.
- Handshake gate: 15 s `wait_for_handshake` → `HANDSHAKE_TIMEOUT` + kill.
- Force close: WS `shutdown` → 5 s grace → kill. Launcher exit: same for all.
- Token delivery moved from argv to stdin (`game-sdk`, mock-game,
  `build_args`/`stdin_payload`, e2e harness, `docs/protocol.md`).
- Tests: `test/security.test.js` (slug/filename traversal).

### T3 — Dynamic ports
- Game WS + overlay bind `127.0.0.1:0`; real port propagates to argv and
  `get_bootstrap` (`overlay_url: null` when unbound).
- Bind failures are explicit → `service_error` surfaced in bootstrap;
  `services_health` self-test command.
- `docs/protocol.md` updated.

### T4 — Unified error contract
- Server: `errors.js` — envelope `{error, message, retryable, details}`,
  `x-request-id` echo, safe global handler (no stacks/SQL/paths), 404
  handler. Tests: `test/errors.test.js`.
- Rust: `ApiError` with `status/code/request_id/detail`;
  `Display = CODE[|req=id][|detail]`; GET-only retry (500 ms, 1500 ms).
- Frontend: `errorMessages.ts` (code → RU text + request-id support) +
  `errorMessages.test.ts` (8 unit tests, runs on `node --test`); all pages
  render `humanError(e)` — no raw Rust/JS strings.

### T5 — HWID/session hardening
- `!hwid-unavailable` and friends rejected: `HWID_UNAVAILABLE` (client
  `hwid.rs` returns `Option`, commands guard).
- Server `hwid.js`: HMAC-SHA256 of HWIDs/IPs keyed by `HWID_HASH_SECRET`
  (required in prod; derived from JWT secret in dev). Migration v3 rehashes
  stored bindings in place; rotating the secret re-binds all devices.
- `device_events` journal: `bound`, `login_denied`, `reset`,
  `reset_requested`.
- Login brute-force: 5 fails / (ip,email) / 15 min →
  `429 TOO_MANY_ATTEMPTS` + `retry_after_ms`.
- `users.token_version` + `tv` JWT claim: `POST /api/auth/logout`
  invalidates the session; stale tokens get `401 SESSION_EXPIRED`.
- `/api/account/me` and `publicUser` return `hwid_bound`, never the value.
- Tests: `test/session.test.js` (8 cases).

### T6 — Logging & diagnostics
- `tracing` + `tracing-subscriber`; `logging.rs`: dual stderr+file sink at
  `%APPDATA%/com.chlauncher.app/logs/chlauncher.log`, size rotation
  5 × 5 MB, `RUST_LOG` env filter.
- All `eprintln!` replaced; info/warn/error on startup, bind, install,
  spawn, handshake, exit.
- `redact()` masks JWT/`token|password|secret|cookie|hwid|stream_key` k=v
  pairs (3 unit tests inside `logging.rs`).
- `get_diagnostics` command → secrets-free report; Header clipboard button.
- Server: Fastify structured logger with `x-request-id` already wired.

### T7 — UI resilience
- `App.tsx`: boot skeleton, boot error + retry, offline banner state,
  bounded feed (100) with `fid` keys, `clearFeed`, 30 s connectivity probe.
- `EventFeed`: ids/`key={fid}`, render cap 50, «Очистить».
- `Header`: `subscription?.current_period_end` null-safe, logout confirm,
  diagnostics copy button.
- `LibraryPage`: kill confirm. `AdminPage`: publish/unpublish/rollback/
  HWID-reset confirms.
- `types.ts`: `overlay_url`/`hwid` nullable-safe.

### T8 — CI & docs
- `.github/workflows/ci.yml`: `server` job (Node 22, build, tests,
  errorMessages unit tests) + `rust` job (fmt, clippy, workspace tests,
  Tauri `cargo check` — full Tauri *build* excluded: needs platform
  toolchain bits (windres/WebKitGTK); documented in the workflow header).
- README: «Production readiness» section (required env vars, checks,
  verification commands, logs/diagnostics, secrets policy).

## Не выполнено
- `cargo test`/`cargo test --lib` for the Tauri crate: test binaries die
  with `STATUS_ENTRYPOINT_NOT_FOUND` on this machine's GNU toolchain
  (webview2 loader quirk — pre-existing, also noted in README). The
  `logging::redact` unit tests live in the crate and will run wherever the
  toolchain links.
- e2e_launch manual run: same loader issue on this machine; launch path is
  covered by `tools/e2e-cdp.mjs` + SDK protocol tests instead.

## Риски (оставшиеся)
- Login rate limit is in-memory per process — a clustered deployment needs
  a shared store (acceptable: server is single-instance SQLite).
- `HWID_HASH_SECRET` rotation invalidates all bindings (documented).
- `device_events`/`payments` tables grow unbounded — needs pruning later.
- JWT `tv` claim means tokens issued before v3 (no `tv`) still work until
  `tv` bump — migration sets `token_version=0`, `payload.tv` defaults 0.
- TikTok sidecar stays an unofficial connector — unchanged.

## Тесты — фактически запущенные команды
| Команда | Результат |
|---|---|
| `node --env-file=test/test.env --test test/` (server) | **65/65 pass** |
| `npm run build --workspace @chlauncher/launcher` | **pass** |
| `node --test src/errorMessages.test.ts` | **8/8 pass** |
| `cargo test -p tiktok-game-sdk` | **4/4 pass** (3 + doctest) |
| `cargo check` (src-tauri, game-sdk, mock-game) | **pass** |
| `cargo clippy --all-targets -- -D warnings` (оба workspace) | **clean** |
| `cargo fmt --check` | **clean** |
| `cargo test --lib` (src-tauri) | **env failure**: `STATUS_ENTRYPOINT_NOT_FOUND` — loader issue, не провал кода |

## Manual QA сценарий
1. `NODE_ENV=production` без `JWT_SECRET` → отказ старта (видно в
   `production.test.js` — тот же код-путь).
2. `NODE_ENV=production` + `ENABLE_MOCK_BILLING=1` → отказ старта.
3. Dev: register пользователя; `curl -H "Origin: http://evil.com"` → нет
   `Access-Control-Allow-Origin`; с `http://localhost:1420` → есть.
4. `tools/test-admin.mjs` или UI: `download_game` mock-game → installed.json
   содержит `exe_sha256`.
5. Подменить байт в zip на сервере → `HASH_MISMATCH`, старая установка цела.
6. Убить процесс лаунчера при запущенной игре → игра завершается по
   watchdog (SDK heartbeat).
7. Вторая копия лаунчера: порты 0 → конфликта нет; при отказе bind UI
   показывает service_error.
8. Любая 4xx/5xx из сервера → баннер с русским текстом + «Код обращения»
   (x-request-id).
9. `POST /api/auth/logout` → старый JWT даёт `401 SESSION_EXPIRED`.
10. `Get-Content logs/chlauncher.log` → нет token/password/hwid/stream_key.

## Next steps
- Shared (DB-backed) login rate limit if the server ever runs multi-node.
- `device_events` pruning job + admin view of device history.
- Real Tauri `cargo test` on CI with a working windres/WebKit toolchain.
- Real payment provider wiring (YooKassa creds → webhook) — out of scope here.
