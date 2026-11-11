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

## Stream connection status

The header always shows the TikTok link state (`LIVE` / `связь…` /
`оффлайн`), and the Integrations card shows whether the room is on air
plus the age of the last sidecar heartbeat (`tiktok_last_activity` —
pings arrive every ~30 s). Staleness > 60 s flags «связь устарела» and
**Обновить связь** (`tiktok_reconnect`) respawns the sidecar with the
saved username; `get_integration_status` is the lightweight snapshot the
UI polls every 5 s.

## Cloud servers (Roblox · Minecraft)

External game servers can't connect to the launcher's local WebSocket,
so `forwarder` pushes every mapped `StreamEvent` (TikTok **and**
DonationAlerts — the source is transport-agnostic) to a standalone
relay; consumers poll `GET /api/stream/events?key&since`:

- **Roblox** — the game server validates `stream_key` via
  `/api/stream/validate`, claims the room and polls events
  (`docs/roblox-integration.md`).
- **Minecraft (remote)** — `tools/mc-bridge` polls the same relay and
  sends RCON console commands to any server (`enable-rcon=true`; no
  plugins). Templates map `action_command` → console commands — see
  `tools/mc-bridge/README.md`.

Streamer setup lives in the launcher's *Integrations → Облачные
серверы*: relay URL + admin secret, stream key (generated + copyable,
registered on the relay while the subscription is active), delivery
stats and per-game connect instructions.

## Managed Minecraft server

The *Minecraft* page runs a full Paper server inside the launcher — no
manual setup (parity spec §9). `mc_install` resolves Java 21 (PATH /
JAVA_HOME, or downloads Temurin JRE via the Adoptium API) and the latest
stable Paper build via the Fill API — every download is SHA-256-verified
from the API metadata; the Mojang jar is never redistributed (Paperclip
fetches it on first run). Starting requires explicit EULA consent —
`eula=true` is written only after the checkbox.

`server.properties` is generated with `enable-rcon=true` on a free port
and a generated 24-byte password stored in `settings.mc.rcon_password`
(never logged, never sent to the renderer). Lifecycle: `mc_start` /
`mc_stop` (RCON `stop`, force-kill after 30 s), `mc_console`, `mc_logs`,
live stdout via `mc-log` events, RAM (`-Xmx`, default 4096 MB), MC
version, `online-mode`, the `{player}` target name, world backup (zip)
and reset.

Mapper integration: apply the built-in **mc-survival** preset
(vanilla commands — `summon`, `effect`, `weather`, `give`, …) and
activate the `minecraft` profile; while it is active and the server is
running, each mapped event's `action` is rendered as console-command
templates (`{player}` `{user}` `{count}` `{amount}` `{gift}`, multi-line
templates split on `\n`) and sent over RCON. Viewer-controlled
`{user}`/`{gift}` are sanitized to `[A-Za-z0-9_.-]` — no newline/quote/`§`
injection (`minecraft::templates`). The external `tools/mc-bridge`
remains for remote servers.

**Plugin catalog (§9.4).** `GET /api/mc/plugins` serves the server-side
catalog (name, version, sha256, `premium`); `GET /api/mc/plugins/:slug/download`
streams the jar, gated by the `mc_premium_plugins` entitlement for
premium rows. Admins manage it via `/api/admin/mc-plugins*` (create,
patch, jar upload — the server computes sha256/size itself, delete).
On the Minecraft page, *Плагины* lists the catalog; installing
downloads + SHA-256-verifies the jar into `server/plugins/` — Paper
loads it on the next start (a restart hint shows while running).

## Trigger presets & the gift catalog

The mapper's reusable unit is the **preset** — a named set of trigger
rules a streamer applies to any game's profile in one click (the same
concept as StreamToEarn's "привяжи события к пресету"). Built-in:
`steal-the-stream` (the Roblox whitelist from
`docs/roblox-integration.md`). Streamer-defined presets live in
`settings.trigger_presets` — *Маппер → Как пресет* saves the current
rules under a name, the dropdown applies one to the selected game, and
`profile.preset` records which preset a game currently runs. Built-in
names are reserved server-side; deleting a preset never touches game
profiles already applied from it. The **PNG** button renders the profile
as a cheat-sheet poster (gift icon × quantity → action glyph + name) for
viewer pin/print. Presets are shareable: `export_trigger_preset` /
`import_trigger_preset` round-trip them as
`{format:"chlauncher-preset", version:1, …}` JSON (media embedding lands
with the media library).

The parity data model (`docs/streamtoearn-parity-spec.md` §1) is in
place: `RawStreamEvent` carries `count` (gift repeats / like batch),
`coins` (TikTok coin value; DA converts at `da_coins_per_rub`), `gift_id`
and `ts_ms`; `TriggerRule` gained enabled/label/description/image,
`match_mode` (`contains`|`exact`|`gift_id`), `repeat` (`per_unit`),
`every_n`, cooldowns, priority, interrupt, `alert`/`tts`/`spinner` and
`delay_ms`/`continue_matching` — all serde-defaulted so old settings
load untouched (`settings::tests::old_settings_deserialize`).

The **ActionScheduler** (`src-tauri/src/scheduler.rs`, spec §2–§3) now
owns the pipeline between matching and dispatch: `match_all` with
`continue_matching`, `every_n` accumulators (with overlay `progress`
frames), rule/user/global cooldowns, `per_unit` expansion capped by
`max_repeat`, a priority queue (`queue_max` overflow drops the lowest
priority), `delay_ms` timers, paid interrupts that cut the running
alert and temporarily swap the preset (in-memory only), the earn-limit
gate (wired to plans in stage 10) and a usage meter. IPC:
`scheduler_pause`, `get_scheduler_status`, `scheduler_reset_counters`,
`test_rule` — and `get_event_feed_items` exposes a statusful feed
(`done`/`cooldown`/`limit`/`dropped`). Paid interrupts cut the running
alert, jump a FIFO interrupt queue (queued interrupts never cut each
other) and optionally swap the preset in-memory for
`interrupt_duration_ms`; the mapper's 🔔 drawer edits the alert
(text/duration/position/style + live preview + «Показать на оверлее»)
and TTS template, while the status bar toggles the master switch and
the default-alert coin threshold (`set_alerts_settings`).

The **overlay server** (`src-tauri/src/overlay.rs` + `src-tauri/overlay/*.html`,
spec §5) is now a multi-page Browser Source host. Every page takes
`?t=<overlay_token>` (generated on first launch, rotatable from the UI —
without it the routes return 403) and `/ws` speaks the `subscribe`
protocol (`{"type":"subscribe","channels":[…]}` with `events`, `alerts`,
`preset`, `spinner`, `tts`, `progress`); unsubscribed legacy clients keep
the old snapshot+event stream. Pages: `/overlay` (all-in-one),
`/overlay/alerts` (alert cards + sound/media + takeover),
`/overlay/preset` (live cheat sheet — re-renders on every profile
save/apply via `preset` frames), `/overlay/spinner` (weighted wheel,
lands on the scheduler-picked `result_index`), `/overlay/tts` (badge +
subtitle), `/overlay/progress` (accumulator bars), `/gifts/*.webp`
(bundled catalog icons), `/media/:id` for the media library. `overlay_port` in
settings pins the port for
stable OBS URLs (`set_overlay_port`, 0 = OS-assigned with fallback); the
Integrations page lists every URL with copy buttons and can rotate the
token (`rotate_overlay_token`).

The **Overlays page** («Оверлеи», spec §5.2) edits the preset cheat
sheet's `OverlayStyle` per game — three templates (`cards`/`list`/
`text`), accent color, background opacity, font scale, border mode,
grid columns, `max_rows` paging and page rotation — with a live DOM
preview rendered from the same `presetRows` model (`src/lib/presetRows.ts`)
that feeds the `/overlay/preset` frame builder and the PNG poster, so
OBS, preview and download always agree. Saving the profile emits a
`preset` frame and every open Browser Source re-renders without reload;
the PNG export now honors the profile's accent/scale too.

The **Gift Spinner** («Спиннер» page, spec §7) edits named weighted
wheel pools: segments carry a game action + label + weight + color, the
editor shows live percentages and a canvas preview, and deletion is
refused while rules reference the pool. A rule's 🎡 field swaps its
direct action for a spin: the scheduler picks `result_index`
deterministically (seedable RNG — `spin_dispatches_segment_action` e2e
covers it), `/overlay/spinner` only animates the wheel and lands
exactly on the picked segment, then the segment's own action dispatches
after `spin_ms`.

The **TTS service** (`src-tauri/src/tts.rs` + «TTS» page, spec §6)
speaks chat through Windows SAPI voices — spawned via PowerShell
`-EncodedCommand` so viewer text never reaches a command line.
`read_comments` modes (`off`/`all`/`prefix`/`gifters` with per-viewer
session coins), `read_gifts` templates, `{user} пишет:` prefix,
blocklist words+regexes, link/emoji stripping, global + per-user
cooldowns and a drop-oldest `queue_max` all live behind the
`TtsEngine` trait so a cloud engine can replace SAPI later. Rule-level
`tts:` voice-overs fire independently of `read_*` modes on their own
queue — never stuck behind a 4-second alert. Output goes to the audio
device or to `/overlay/tts` (`output = "overlay"`) where the Browser
Source plays `/tts/<id>.wav` into the OBS mix. `Ctrl+Shift+M`
(configurable, `tauri-plugin-global-shortcut`) or the page's mute
button kills the running synthesis and drains the queue instantly —
the overlay shows a red MUTED badge.

The **media library** (`src-tauri/src/media.rs` + «Медиатека» page,
spec §4) stores alert assets under `<app-data>/media/` — import via the
native picker (`media_import`, magic-byte sniffed:
mp4/webm/gif/png/webp/jpg/mp3/ogg/wav, ≤ 50 MB each, mp4 ≤ 30 s via
`mvhd` parsing, 2 GB total), `media_list`/`media_rename`/`media_delete`
(delete is refused while rules reference the file and names them).
The alert drawer picks sound/media from the library; `/media/:id`
serves files with byte ranges (`ServeFile`) so video actually plays in
a Browser Source.

The bundled **gift catalog** (`apps/launcher/public/gifts.json` +
`public/gifts/*.webp`, ~1.7k entries) backs the 🎁 picker next to each
rule's match field — icon, display name and coin price for every public
TikTok gift. Icons are TikTok's public CDN images mirrored locally so
the picker works offline and never pings a CDN from the webview.
Refresh with `node tools/fetch-gifts.mjs` (re-scrapes the community
list at streamtoearn.io); CI validates the committed catalog with
`--check`.

## Tariff plans & usage limits (§8)

The server now ships a `plans` table (migration v6 → `free`/`pro`/`expert`
seeds — placeholder prices the owner adjusts in «Управление → Тарифы»)
with a JSON `entitlements` blob per plan: preset/rule/media caps,
feature flags (`tts`, `spinner`, `custom_overlay_style`, `interrupts`,
`paid_games`) and the monthly earn limit (`earn_limit_coins_month`,
`null` = unlimited). An **active** subscription carries `plan_code`
(existing subs migrated to `pro`); an expired one resolves to `free`.

API: `GET /api/plans` (public), `GET /api/account/entitlements`,
`POST /api/billing/checkout { plan_code }` (price/period read from the
plan row; the webhook activates the plan actually paid — switching plans
stacks days without recalculation), `POST /api/usage/report
{ month, coins_delta, nonce }` (idempotent by nonce, 2/min per account,
delta ≤ 1M). Admin: `POST /api/admin/users/:id/set-plan`, plan CRUD under
`/api/admin/plans`, plan + usage columns in the user list.

On the launcher, `src-tauri/src/usage.rs` is the `UsageMeter`: coins of
events that actually produced actions accumulate in `usage.json` and are
reported every 60 s (and on exit) with per-report nonces. Entitlements
are cached (startup + every 10 min) and enforced two ways — save-time
gates reject NET-NEW violations (`PLAN_LIMIT|<feature>|<cap>`, localized
in `errorMessages.ts`) while `enforce_profile_limits` trims the runtime
profile copy: a downgrade never deletes the streamer's rules, excess and
gated features just stop executing. `games.is_free` marks Free-tier
titles — they download and launch without a subscription
(`/api/license/verify` accepts `game_slug`); paid titles show a lock
badge when `paid_games` isn't entitled. «Подписка» renders the plan
comparison table with the monthly usage bar; the main screen banners
«Лимит месяца исчерпан» when the free cap is hit.

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
