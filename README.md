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
npm run test:server                      # backend: 12 e2e tests (auth, HWID, billing)
cargo test -p tiktok-game-sdk            # SDK protocol tests (4)

# full system e2e — needs server + vite + launcher running with
# WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222:
node tools/e2e-cdp.mjs                   # 10-step CDP-driven scenario
```

The e2e driver performs the complete streamer flow: register → play
blocked → mock-pay (+30d) → download game → launch (real WS handshake) →
simulator events mapped to game commands → force-kill → mock-expire →
play blocked again.

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
