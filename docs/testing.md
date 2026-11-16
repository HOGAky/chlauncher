# Testing guide

Three layers, increasing in scope:

## 1. Backend API tests — `apps/server`

```bash
npm run test:server
```

`node --test` suite (`test/api.test.js`): registers users on an in-memory
SQLite db and drives the HTTP surface via `app.inject`. Covers auth, HWID
binding + 7-day reset cooldown, 30-day mock-pay stacking, lazy expiry,
license gating and download gating (12 tests).

## 2. Game SDK protocol tests — `packages/game-sdk`

```bash
cargo test -p tiktok-game-sdk
```

`tests/client_handshake.rs` spins up an in-test mock launcher (raw
`tungstenite` accept loop) and verifies: hello→welcome handshake, event
frame → `poll()`, shutdown frame, invalid-token rejection, and the
missing-args (direct launch) guard.

## 3. Full-system e2e — `tools/e2e-cdp.mjs`

Drives the **real running launcher** through Chrome DevTools Protocol:

```bash
# 1) licensing backend
npm run dev:server

# 2) vite dev server (debug builds load devUrl)
npm run dev --workspace @chlauncher/launcher

# 3) launcher shell with webview remote debugging
cd apps/launcher/src-tauri
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 cargo run

# 4) in another terminal — run the 10-step scenario
node tools/e2e-cdp.mjs
```

Steps: bootstrap → register → **play blocked (no sub)** → mock-pay →
download zip → **real game launch + WS handshake** → simulator events →
mapped commands reach the game → force-kill → mock-expire → **play
blocked again**.

Last verified: **10/10 PASS**.

### Note on `cargo test` in src-tauri

Binaries that link `chlauncher_lib` (tests/examples) fail to load on this
machine with `STATUS_ENTRYPOINT_NOT_FOUND` — a GNU-toolchain + WebView2
loader quirk unrelated to code correctness (the main binary runs fine).
Protocol verification therefore lives on the SDK side + the CDP driver.
