# Wire Protocol — game ⇄ launcher (`ws://127.0.0.1:<dynamic port>`)

JSON text frames, snake_case `type` tags. Mirrors `LauncherMessage` /
`ClientMessage` in `packages/game-sdk` and `ServerFrame` in
`apps/launcher/src-tauri/src/game_ws.rs`.

## Launch arguments

Both local services bind `127.0.0.1:0` — the OS assigns a free port per
launcher instance (no fixed `9876`/`9877`). The launcher delivers the
actual port and the session token to the game like this:

- **argv**: `--port <p>` plus window flags (`--width --height
  [--borderless] [--always-on-top] [--chroma-key]`).
- **stdin** (first line, then stdin is closed):
  `{"token":"<one-time-uuid>","port":<p>}` — the token never appears in
  the process command line, where it would be readable by any local user
  (`wmic`, Task Manager). The SDK accepts a bare `token\n` line too.

A spawned game must finish the WS handshake within **15 s** or the
launcher kills it (`FailedToStart`). `ProcessManager` and `game_ws.rs`
are the reference implementation.

## Handshake

```jsonc
// game → launcher (must be the first frame, ≤5 s after connect)
{ "type": "hello", "token": "<one-time-uuid>", "protocol": 1 }

// launcher → game
{ "type": "welcome", "protocol": 1 }
// or rejection:
{ "type": "error", "reason": "invalid token" }
```

Tokens are minted per launch (`issue_token`) and **consumed on first use**.

### External adapters (mods, spec §10.1)

Mods for third-party games aren't launcher processes — they can't receive
a one-time token. They handshake with the persistent, revocable
`adapter_key` (Интеграции → Внешние моды):

```jsonc
// mod → launcher (first frame, ≤5 s)
{ "type": "hello_adapter", "key": "<adapter_key>", "game": "gta5", "protocol": 1 }
// launcher → mod
{ "type": "welcome", "protocol": 1 }
// or: { "type": "error", "reason": "invalid adapter key" }
```

`game` must be a catalog slug (`[a-z0-9_-]{1,64}`); events are dispatched
when that slug's trigger profile is active. Regenerating the key sends
`shutdown` to all adapter clients and invalidates the old key.

## Steady state (launcher → game)

```jsonc
{ "type": "event", "event": {
    "source": "tiktok" | "donationalerts" | "simulator",
    "event_kind": "gift" | "like" | "comment" | "donation" | "system",
    "user": "viewer_name",
    "avatar_url": "",
    "action_command": "spawn_enemy",
    "amount": 1,
    "raw_name": "Rose",
    "event_id": "uuid-v4"              // §10.1 — echoed back by ack frames
}}

{ "type": "heartbeat", "ts": 1730000000 }        // every 30 s
{ "type": "set_chroma_key", "enabled": true }
{ "type": "shutdown" }
```

The game replies to transport-level `ping` with `pong` and otherwise stays
silent after `hello`. Adapters may additionally send an execution
confirmation back-channel (§10.1):

```jsonc
// adapter → launcher — marks the dispatch as executed/failed in-game;
// the UI feed shows «выполнено в игре».
{ "type": "ack", "event_id": "<uuid from the event frame>", "ok": true }
```

## Overlay feed (`ws://127.0.0.1:<port>/ws?t=<overlay_token>`)

The overlay server hosts one Browser Source page per widget
(`/overlay`, `/overlay/alerts`, `/overlay/preset`, `/overlay/spinner`,
`/overlay/tts`, `/overlay/progress`, `/overlay/leaderboard`) plus
`/gifts/*.webp` icons. Every HTTP route and the socket require
`?t=<overlay_token>` — the exact URLs come from
`get_bootstrap().overlay_pages`. The port is OS-assigned unless
`overlay_port` pins it (`set_overlay_port`).

Auxiliary routes: `/top.json?n=<1..50>` — session leaderboard
(`[{"user","total"}…]`, polled by the leaderboard page every 3 s);
`/media/<id>` (range-enabled), `/tts/<id>.wav`, `/health`.

**Capture windows (TikTok LIVE Studio):** the Studio has no Browser
Source — `open_overlay_window {page, chroma}` opens a transparent
always-on-top `WebviewWindow` hosting any `/overlay*` page so the
streamer captures it via Window/Game capture. `chroma: true` appends
`&bg=ff00ff` (solid magenta for chroma-key filters — real transparency
can render black under some capture paths). `close_overlay_window {page}`
closes it. Pages accept the `?bg=rrggbb` parameter.

```jsonc
// client → server, once after connect:
{ "type": "subscribe", "channels": ["alerts", "preset"] }
// channels: events | alerts | preset | spinner | tts | progress
```

Without `subscribe` the client gets the legacy stream (overlay v1):

```jsonc
// on connect:
{ "type": "snapshot", "recent": [StreamEvent…], "top": [["user", total]…] }
// then live:
{ "type": "event", "event": { …StreamEvent… } }
```

Subscribed clients receive `OverlayFrame`s for their channels; the last
`preset`/`progress`/`alerts` frame is replayed on subscribe so pages
aren't blank on open:

```jsonc
{ "type": "alert",  "id": "…", "text": "…", "duration_ms": 3000,
  "sound": {"url": "/media/x", "volume": 1}, "media": null,
  "position": "top", "style": "default", "user": "…" }
{ "type": "alert_cancel", "id": "…" }
{ "type": "takeover", "user": "…", "preset": "…", "until_ms": 0 }
{ "type": "preset", "name": "…", "style": {…OverlayStyle…},
  "rows": [{"gift":"Rose","gift_image":"/gifts/rose.webp","count":1,
            "coins":1,"label":"spawn_enemy","image":null}] }
{ "type": "spinner", "id": "…", "pool": "…",
  "segments": [SpinnerSegment…], "result_index": 3,
  "spin_ms": 4500, "user": "…" }
{ "type": "tts", "id": "…", "text": "…", "state": "start" }
{ "type": "progress", "items": [{"rule_id":"…","label":"лайки",
                                 "value":63,"target":100}] }
```

## Trigger rules

A `TriggerRule` matches on `source` + `event_kind` (each supports `"any"`),
a case-insensitive `match_value` substring of `raw_name`, and
`min_amount`. First match wins; `multiplier` scales the emitted amount.
