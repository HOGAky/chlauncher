# Operations — running the stack

## Prerequisites

- Node.js ≥ 20 (uses built-in `node:sqlite` — Node ≥ 22.5 recommended)
- Rust stable **windows-gnu** toolchain (this machine lacks MSVC Build
  Tools — see "MSVC note" below), with a MinGW-w64 `bin` dir on `PATH`
  for `dlltool` (e.g. w64devkit).
- WebView2 runtime (preinstalled on Windows 10/11) for the Tauri shell.

## Start everything (dev)

```bash
npm install                 # once, at repo root

# 1) licensing backend  → http://127.0.0.1:8787
npm run dev:server

# 2) launcher frontend  → http://localhost:1420 (vite)
npm run dev --workspace @chlauncher/launcher

# 3) launcher shell     → Tauri window
cd apps/launcher/src-tauri && cargo run
#   (or `npm run tauri:dev` for the full vite+tauri flow)
```

## Rebuild the test game artifact

```bash
cargo build -p mock-game --release
powershell Compress-Archive -Force `
  -Path target/release/mock-game.exe `
  -DestinationPath apps/server/static/games/mock-game-0.1.0.zip
```

Bump `version`/`file_name` in `apps/server/src/db.js` `seedGames` when
shipping a new game build — the launcher's "Update" button keys off the
version comparison.

## Test flow

```bash
npm run test:server         # backend: 12 e2e tests
```

Manual E2E: register → (Play is locked) → mock-pay → Download → Play →
Simulator buttons → `mock-expire` → verify lockout. See README §Testing.

## MSVC note

Tauri docs recommend MSVC, but this repo builds fine on the GNU toolchain
(wry/tao/webview2-com all compile; WebView2 is loaded at runtime).
`rust-toolchain.toml` pins `stable-x86_64-pc-windows-gnu`. If you install
VS Build Tools anyway and prefer MSVC, just change the pinned channel.

## Production keys & bootstrap

See `.env.example` for the full list. The server **refuses to start** in
production unless all of these are sane (`config.js::validateProductionConfig`):

- `JWT_SECRET`, `HWID_HASH_SECRET` — real random secrets
  (`openssl rand -hex 64` / `-hex 32`).
- `OWNER_TG_IDS` — comma-separated Telegram ids of owner accounts
  (fail-closed: empty set = no boot). Find your id with the bind-bot
  `/whoami` command; grant admins afterwards via
  `node tools/grant-admin.mjs <email>`.
- `PUBLIC_BASE_URL` — public `https://` origin (OAuth callback + docs).
- Public bind: `SERVER_HOST=0.0.0.0`/`::` needs `ALLOW_PUBLIC_BIND=1`.
- `STRIPE_WEBHOOK_SECRET` / `YOOKASSA_SHOP_ID` + `YOOKASSA_SECRET_KEY` —
  real billing providers. The YooKassa webhook validates the source IP
  against its published ranges; `BILLING_WEBHOOK_SKIP_IP_CHECK=1` is
  dev-only and forbidden in production.
- `TRIBUTE_API_KEY` + `TG_BIND_SECRET` + bot env — for the Telegram
  Tribute provider (see `.env.example` and `apps/launcher/tg-bot`).
- `DONATIONALERTS_CLIENT_ID/SECRET` — for a proper OAuth flow; the MVP
  accepts a pasted access token in the Integrations UI.
- TikTok: the connector is best-effort presence polling; a production
  webcast client needs TikTok's signing service — see
  `apps/launcher/src-tauri/src/integrations.rs` module docs.

## Probes, upgrades & shutdown

- `GET /api/health` — liveness, no dependencies.
- `GET /api/ready` — readiness: SQLite answers and the static dir is
  writable; `503` with per-check detail otherwise. Point the LB/uptime
  probe here.
- `SIGTERM`/`SIGINT` — the server drains in-flight requests (payments,
  uploads) then closes SQLite (`src/index.js`).
- Uploaded game builds write to a `.part` temp file first and validate
  the zip central directory (traversal/symlink/dupes/size/ratio) before
  becoming available — partial kills never serve half a build.
- Settings backups: the launcher snapshots `settings.json` to
  `settings.json.bak-<version>` on the first launch of each build
  (last 3 kept).
- VPS autonomy: `tools/vps/` ships systemd units + timers — a per-minute
  watchdog (`/api/ready` probe → restart, failed-unit resurrection,
  disk-pressure cleanup, optional TG alerts), a daily cleanup (WAL
  checkpoint, stale `*.part` uploads, journald/apt vacuum), and a daily
  `sqlite .backup` timer. Install once with
  `sudo bash tools/vps/install.sh`; details in `docs/vps-automation.md`.
- The hourly in-server sweeper also purges expired/used one-shot codes
  (`pair_codes`, `tg_login_codes`, `billing_link_codes`) and stale
  `usage_nonces`, so the DB can't grow unboundedly.

## Credential storage

Launcher-side secrets (auth JWT, TikTok `sessionid`, DonationAlerts
token, stream key, relay admin secret, RCON password, adapter key,
Gemini key) live in the OS credential store — Windows Credential
Manager (DPAPI) on this platform — not in `settings.json`. The file
keeps only `kr:v1` markers; plaintext values migrate on load and the
file is rewritten scrubbed immediately. `rotate_overlay_token` (UI:
Integrations) regenerates both overlay tokens; logout clears the
auth/session entries.
