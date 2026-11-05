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

## Production keys

See `.env.example`:
- `JWT_SECRET` — **required** before any real deployment.
- `STRIPE_WEBHOOK_SECRET` / `YOOKASSA_*` — wire real payment webhooks in
  `apps/server/src/routes/billing.js::/webhook` (currently 501 stub).
- `DONATIONALERTS_CLIENT_ID/SECRET` — for a proper OAuth flow; the MVP
  accepts a pasted access token in the Integrations UI.
- TikTok: the connector is best-effort presence polling; a production
  webcast client needs TikTok's signing service — see
  `apps/launcher/src-tauri/src/integrations.rs` module docs.
