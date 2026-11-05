# Architecture

chlauncher is a monorepo of four parts. Games never touch the internet —
the launcher is the single edge that talks to TikTok, DonationAlerts and
the licensing backend, then fans a normalized event stream out to games
and the stream overlay.

```text
                 ┌──────────────────────────┐
                 │   apps/server (Fastify)  │  licensing + billing
                 │  JWT · HWID · SQLite     │  30-day subscriptions
                 └────────────▲─────────────┘
                              │ HTTPS/JSON
   TikTok Live ──┐            │
   (public room) │   ┌────────┴─────────────┐        ws://127.0.0.1:9876
                  ├──▶│  apps/launcher       │───────▶ apps/mock-game …
   DonationAlerts─┤   │  (Tauri v2, Rust)    │         (+ any real game
   (Centrifugo)  │   │                      │          built on game-sdk)
                  └──▶│  EventHub + Mapper   │───────▶ http://127.0.0.1:9877/overlay
                      │  WS:9876  HTTP:9877  │         (Browser Source for
                      └──────────────────────┘          TikTok Live Studio)
```

## Event pipeline

`integrations / simulator → raw_tx → TriggerMapper(profile) →
StreamEvent → EventHub.broadcast → {game WS, overlay WS, React feed}`

All three consumers subscribe to the same `tokio::sync::broadcast` channel,
so one TikTok/DA connection serves every game and the overlay for free.

## DRM / launch flow

1. `play_game(slug)` → `POST /api/license/verify` (JWT + HWID).
2. Launcher mints a one-time UUID token, spawns
   `game.exe --port 9876 --token <t> --width … --height … [--borderless …]`.
3. Game (`tiktok-game-sdk::init_and_verify`) connects to the WS, sends
   `{type:"hello", token}`; the launcher consumes the token (single use)
   and replies `{type:"welcome"}`.
4. Runtime: `{type:"event"}` frames, `{type:"heartbeat"}` every 30 s,
   `{type:"set_chroma_key"}`, `{type:"shutdown"}`.
5. Game-side watchdog: socket drop or >150 s without heartbeat → exit.
   Launcher-side: "Force close" sends `shutdown` then `child.kill()`.
   Launcher exit kills all spawned game processes.

## Subscription model (30 days)

- Server stores one subscription row per user (`status`,
  `current_period_end`, `auto_renew`).
- `mock-pay` extends 30 days from `max(now, period_end)` — payments stack.
- Expiry is enforced **lazily** on every read path (login, /me, verify,
  downloads) + an hourly background sweeper.
- Downloads are subscription-gated; launches are license-gated.

## Anti-sharing

- HWID = OS machine GUID (`machine-uid`), bound at register/first login.
- Login on a foreign HWID → `HWID_MISMATCH`.
- `POST /api/account/reset-hwid` — once per 7 days.

## Local ports

| Port | Consumer        | Purpose                            |
| ---- | --------------- | ---------------------------------- |
| 8787 | launcher→server | licensing REST API                 |
| 9876 | game→launcher   | handshake + events + heartbeat     |
| 9877 | browser→overlay | overlay HTML + WS event feed       |
