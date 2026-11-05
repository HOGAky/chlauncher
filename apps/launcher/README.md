# @chlauncher/launcher — Desktop Launcher & Streamer Hub

Tauri v2 (Rust backend) + React + TypeScript + TailwindCSS frontend.

## Responsibilities

- Auth against the licensing server (JWT + HWID via `machine-uid`).
- Library: download/update/play/force-kill games; launch window options
  for TikTok Live Studio (9:16, borderless, always-on-top, chroma key).
- **Event hub**: local WS server `ws://127.0.0.1:9876` — games handshake
  with a one-time token and receive mapped `StreamEvent`s + 30 s heartbeats.
- **Overlay**: `http://127.0.0.1:9877/overlay` — Browser Source page for
  TikTok Live Studio (recent events, alerts, top supporters).
- **Integrations**: TikTok Live presence polling (public, by username) +
  DonationAlerts realtime via Centrifugo; all sources feed the trigger
  mapper → game + overlay + UI feed.
- **Trigger mapper**: per-game JSON profiles stored in settings.
- **Simulator**: injects raw events through the same pipeline for testing.
- **Streamer mode**: masks email/tokens on screen.

## Layout

```
src/                  React frontend (screens/, pages/, components/ui/, api.ts)
src-tauri/src/        Rust backend:
  lib.rs              app assembly, mapper loop, watchdog
  commands.rs         Tauri commands (IPC surface)
  api.rs              licensing REST client
  game_ws.rs          game WS server :9876 (DRM handshake + heartbeat)
  overlay.rs          overlay HTTP+WS server :9877 (embedded HTML page)
  events.rs           EventHub broadcast + TriggerMapper
  integrations.rs     TikTok + DonationAlerts connectors → raw events
  downloads.rs        zip download/extract + installed.json markers
  process.rs          game process spawn/kill
  settings.rs         persistent JSON settings store
  hwid.rs             machine GUID
```

## Commands

```bash
npm install          # once, at repo root (workspaces)
npm run tauri:dev    # dev mode (vite + tauri)
npm run build        # type-check + bundle frontend
npm run tauri:build  # produce the Windows installer/exe
```

Requires the licensing server on `VITE_API_URL` (default
`http://127.0.0.1:8787`) — start `apps/server` first.
