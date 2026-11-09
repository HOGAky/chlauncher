# chlauncher

Desktop launcher & hub for interactive **TikTok Live** games written in
Rust — monthly-subscription licensing, HWID-bound accounts, a unified
event pipeline (TikTok + DonationAlerts → games + stream overlay) and a
built-in event simulator.

## Architecture at a glance

```text
                 ┌──────────────────────────┐
                 │   apps/server (Fastify)  │  licensing + billing
                 │  JWT · HWID · SQLite     │  30-day subscriptions
                 └────────────▲─────────────┘
                              │ HTTPS/JSON
   TikTok Live ──┐            │
   (public room) │   ┌────────┴─────────────┐       ws://127.0.0.1:9876
                  ├──▶│  apps/launcher       │──────▶ apps/mock-game …
   DonationAlerts─┤   │  (Tauri v2, Rust)    │        (+ real games via
   (Centrifugo)  │   │                      │         tiktok-game-sdk)
                  └──▶│  EventHub + Mapper   │──────▶ http://127.0.0.1:9877/overlay
                      │  WS:9876  HTTP:9877  │        (Browser Source)
                      └──────────────────────┘
```

- **Games never touch the internet.** The launcher aggregates events,
  maps them through the streamer's trigger rules and pushes game-ready
  `StreamEvent`s over a local WebSocket.
- **DRM**: games only run when spawned by the launcher with a one-time
  token (`--port 9876 --token …`); a 30 s heartbeat + 150 s watchdog kill
  the game if the launcher dies.
- **Subscriptions**: exactly 30 days per payment; lazy expiry on every
  read + hourly sweeper; downloads and launches are gated server-side.
- **HWID anti-sharing**: OS machine GUID bound per account, resettable
  once per 7 days.

Full details: [`docs/architecture.md`](docs/architecture.md),
[`docs/protocol.md`](docs/protocol.md), [`docs/operations.md`](docs/operations.md).

## Repository layout

| Path                 | Stack                                   | Purpose                                      |
| -------------------- | --------------------------------------- | -------------------------------------------- |
| `apps/server`        | Node.js · Fastify · `node:sqlite` · JWT | Auth, HWID, subscriptions, game distribution |
| `apps/launcher`      | Tauri v2 · React · TS · Tailwind        | Desktop launcher & streamer hub              |
| `packages/game-sdk`  | Rust crate (`tiktok-game-sdk`)          | Game-side handshake + event feed + watchdog  |
| `apps/mock-game`     | Rust · eframe/egui                      | Test game for the full loop                  |
| `docs/`              | Markdown                                | Architecture, wire protocol, operations      |
| `tools/`             | Node scripts                            | icon generator, CDP e2e driver               |

## Quick start

**Prerequisites:** Node ≥ 22.5 (built-in `node:sqlite`), Rust
`stable-x86_64-pc-windows-gnu` (pinned via `rust-toolchain.toml`), a
MinGW-w64 `bin` on `PATH` for `dlltool` (e.g. w64devkit), WebView2 runtime.

```bash
npm install                              # once — sets up workspaces

# terminal 1 — licensing backend :8787
npm run dev:server

# terminal 2 — launcher frontend :1420
npm run dev --workspace @chlauncher/launcher

# terminal 3 — launcher shell
cd apps/launcher/src-tauri && cargo run
```

Rebuild the bundled test game artifact:

```bash
cargo build -p mock-game --release
powershell Compress-Archive -Force -Path target/release/mock-game.exe `
  -DestinationPath apps/server/static/games/mock-game-0.1.0.zip
```

## Testing

```bash
npm run test:server                      # backend e2e tests (auth, HWID, billing, admin, prod-safety)
cargo test -p tiktok-game-sdk            # SDK protocol tests (4)

# full system e2e — needs server + vite + launcher running with
# WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222:
node tools/e2e-cdp.mjs                   # 10-step CDP-driven scenario
```

The e2e driver performs the complete streamer flow: register → play
blocked → mock-pay (+30d) → download game → launch (real WS handshake) →
simulator events mapped to game commands → force-kill → mock-expire →
play blocked again.

## Production readiness

The server **refuses to start** in production on insecure settings
(`apps/server/src/config.js::validateProductionConfig`).

Required env vars for `NODE_ENV=production` (see [`.env.example`](.env.example)):

| Variable | Why | Required |
|---|---|---|
| `NODE_ENV=production` | enables strict startup checks | yes |
| `JWT_SECRET` | signs JWTs; `openssl rand -hex 64` | yes |
| `HWID_HASH_SECRET` | HMAC for stored HWIDs/IPs; `openssl rand -hex 32` | yes |
| `CORS_ORIGINS` | comma-separated browser origin whitelist; **only** these get CORS headers | yes, if browsers connect |
| `TRUST_PROXY=true` | only behind a reverse proxy / Cloudflare (client-IP for rate limits + webhook checks) | no |
| `SERVER_HOST` / `SERVER_PORT` | bind address; `0.0.0.0` only when intentionally public | no (default `127.0.0.1:8787`) |
| `DATABASE_PATH` | SQLite file location | no |
| `ENABLE_MOCK_BILLING` | **forbidden** in production — startup fails | never set to `1` |
| `ADMIN_EMAILS` | **ignored** in production — grant roles via `node tools/grant-admin.mjs <email>` | never |
| `YOOKASSA_*` / `STRIPE_WEBHOOK_SECRET` | real billing webhooks | when billing is live |
| `VITE_API_URL` | launcher → backend base URL | launcher build |

Production checks the startup validator enforces:

- `JWT_SECRET` missing or the dev sentinel → **refuse to boot**
- `HWID_HASH_SECRET` missing → **refuse to boot**
- `ENABLE_MOCK_BILLING=1` → **refuse to boot**
- `ADMIN_EMAILS` set → warning + ignored (no auto-admin promotion)

### Verification commands

```bash
npm run test:server                          # server suite (uses test/test.env)
npm run build --workspace @chlauncher/launcher   # TS + Vite frontend build
node --test apps/launcher/src/errorMessages.test.ts  # error-contract unit tests
cargo test -p tiktok-game-sdk                # SDK protocol tests
cargo test -p mock-game                      # mock game unit tests
cargo check --manifest-path apps/launcher/src-tauri/Cargo.toml
cargo check -p tiktok-game-sdk && cargo check -p mock-game
cargo clippy --workspace --all-targets -- -D warnings
```

### Logs & diagnostics

- Launcher logs: `%APPDATA%/com.chlauncher.app/logs/chlauncher.log`
  (size-rotated, 5 × 5 MB; `RUST_LOG=debug` for verbose).
- In-app: Header → clipboard icon copies a secrets-free diagnostics report
  (version, OS, ports, service errors, last 50 redacted log lines).
- Server: Fastify structured logs carry `x-request-id`; clients show it as
  «Код обращения» in error messages — quote it in bug reports.
- Logs never contain tokens, passwords, HWIDs, stream keys or cookies.

### Secrets policy

`.env`, `*.key`, `*.pem`, `data/*.db*`, and game zips are git-ignored.
Never commit them; rotate `JWT_SECRET`/`HWID_HASH_SECRET` on any leak
(rotating the HWID secret re-binds all devices).

## Release pipeline

`.github/workflows/release.yml` fires on `v*` tags and builds the NSIS
installer on `windows-latest` (MSVC — the only toolchain Tauri ships for
production). Static CRT (`.cargo/config.toml`, `+crt-static`) means no
VC++ Redist needed on clean Windows 10/11.

- `rust-toolchain.toml` pins `stable` (MSVC on Windows hosts). Local dev
  without MSVC Build Tools: `rustup override set
  stable-x86_64-pc-windows-gnu` — never ship a GNU binary.
- `tools/tiktok-sidecar` ships as a single-file esbuild bundle
  (`dist/sidecar.js`) + an official `node.exe` fetched in CI — no
  `node_modules` in the installer. Rebuild locally with
  `(cd tools/tiktok-sidecar && npm ci && npm run bundle)` before `tauri build`.
- Release builds pin `VITE_API_URL` at compile time (`env!` — build fails
  without it) and ignore `settings.server_url`/`set_server_url`; the
  server-URL field on the auth screen is dev-only (`import.meta.env.DEV`).
- Self-updates: `tauri-plugin-updater` verifies minisign signatures
  against `pubkey` in `tauri.conf.json`. Private key lives at
  `~/.tauri/chlauncher` (never in the repo) and in the
  `TAURI_SIGNING_PRIVATE_KEY` GitHub secret; `latest.json` is served from
  GitHub Releases.
- Required repo config for releases: var `VITE_API_URL`, secrets
  `TAURI_SIGNING_PRIVATE_KEY` (+ `..._PASSWORD` if set), and optional
  `ADMIN_EMAIL`/`ADMIN_PASSWORD` for auto-publishing mock-game.
- Server deployment on a VPS: [`docs/vps-deploy.md`](docs/vps-deploy.md)
  (systemd unit, Cloudflare, SQLite `.backup` cron via `tools/backup-db.sh`).

## Publishing games

Two ways a game build reaches the catalog:

**Publisher self-service** (`role='publisher'`, granted via
`POST /api/admin/users/:id/set-role` or admin panel):

```bash
node tools/publisher.mjs create --slug my-game --title "My Game" --exe game.exe ...
node tools/publisher.mjs upload --slug my-game --version 1.0.0 --zip dist/game.zip ...
node tools/publisher.mjs submit --slug my-game --version 1.0.0 ...   # → admin review queue
node tools/publisher.mjs list  ...                                   # status + reject feedback
```

An admin then approves (`POST /api/admin/submissions/:id/approve` → live)
or rejects with feedback. Publishers only see games they own
(`games.owner_id`); `POST /api/admin/games/:slug/transfer` reassigns
ownership. Metadata edits are locked while a submission is pending; a
pending submission can be withdrawn with
`POST /api/publisher/submissions/:id/cancel`.

**Admin direct** (internal/first-party titles — no review step):

```bash
node tools/publish-game.mjs --slug mock-game --version 1.2.0 \
  --zip dist.zip --publish --email admin@x --password ...
```

Both paths share the same pipeline (`src/build_store.js`): the zip is
validated (executable at root, no traversal), SHA-256 hashed, stored
atomically as `static/games/<slug>/<version>.zip` and recorded as an
immutable `game_builds` row — a `(slug, version)` can never be
overwritten; rollbacks produce a new patch version.

## Cloud servers (Roblox · Minecraft)

External game servers can't connect to the launcher's local WebSocket,
so `forwarder` pushes every mapped `StreamEvent` (TikTok **and**
DonationAlerts — the source is transport-agnostic) to a standalone
relay; consumers poll `GET /api/stream/events?key&since`:

- **Roblox** — the game server validates `stream_key` via
  `/api/stream/validate`, claims the room and polls events
  (`docs/roblox-integration.md`).
- **Minecraft** — `tools/mc-bridge` polls the same relay and sends
  RCON console commands to any server (`enable-rcon=true`; no plugins).
  Templates map `action_command` → console commands — see
  `tools/mc-bridge/README.md`.

Streamer setup lives in the launcher's *Integrations → Облачные
серверы*: relay URL + admin secret, stream key (generated + copyable,
registered on the relay while the subscription is active), delivery
stats and per-game connect instructions.

## Where the real keys go

See [`.env.example`](.env.example):

- `JWT_SECRET` — **must** be set for production.
- `STRIPE_WEBHOOK_SECRET` / `YOOKASSA_*` — wire real billing in
  `apps/server/src/routes/billing.js` (`POST /api/billing/webhook` stub).
- `DONATIONALERTS_CLIENT_ID/SECRET` — for a full OAuth flow; the MVP
  accepts a pasted access token in the launcher's Integrations page.
- `VITE_API_URL` — point the launcher at a non-local backend.
- `EULERSTREAM_API_KEY` — optional TikTok signing key (see below).

## Known limitations (MVP honesty list)

- **TikTok connector** ingests real live events (chat, gifts, likes,
  joins, follows/shares, subs) via a Node.js sidecar
  (`tools/tiktok-sidecar`) running `tiktok-live-connector` — the actively
  maintained unofficial webcast client, signed through EulerStream's
  free tier (works keyless, rate-limited; `EULERSTREAM_API_KEY` or
  `%APPDATA%/com.chlauncher.app/eulerstream.key` raises limits). The
  launcher spawns `node index.js <username>` and reads NDJSON events
  from stdout, so Node.js must be on `PATH` (or a `node.exe` next to the
  sidecar). Requirements: no TikTok credentials, the target must be live.
  TikTok can break this at any time; the simulator covers the downstream
  pipeline identically.
- **DonationAlerts** implements the community Centrifugo flow; untested
  against the live service without a real token.
- **Launcher tests**: cargo test binaries that link `chlauncher_lib`
  fail to load on this machine (`STATUS_ENTRYPOINT_NOT_FOUND`, likely a
  loader quirk of GNU-built webview2-linked test exes). Protocol coverage
  lives in `packages/game-sdk/tests/` + `tools/e2e-cdp.mjs` instead.
- **VS Build Tools / MSVC**: not installed (needs admin). Everything
  builds on the GNU toolchain; to switch, edit `rust-toolchain.toml`.
