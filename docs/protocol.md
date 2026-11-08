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

## Steady state (launcher → game)

```jsonc
{ "type": "event", "event": {
    "source": "tiktok" | "donationalerts" | "simulator",
    "event_kind": "gift" | "like" | "comment" | "donation" | "system",
    "user": "viewer_name",
    "avatar_url": "",
    "action_command": "spawn_enemy",
    "amount": 1,
    "raw_name": "Rose"
}}

{ "type": "heartbeat", "ts": 1730000000 }        // every 30 s
{ "type": "set_chroma_key", "enabled": true }
{ "type": "shutdown" }
```

The game replies to transport-level `ping` with `pong` and otherwise stays
silent after `hello`.

## Overlay feed (`ws://127.0.0.1:<dynamic port>/ws`)

The overlay page is served on the same OS-assigned port as `/overlay`
(the exact URL comes from `get_bootstrap`). The page derives the socket
address from `location.host` — no hardcoded port.

```jsonc
// on connect:
{ "type": "snapshot", "recent": [StreamEvent…], "top": [["user", total]…] }
// then live:
{ "type": "event", "event": { …StreamEvent… } }
```

## Trigger rules

A `TriggerRule` matches on `source` + `event_kind` (each supports `"any"`),
a case-insensitive `match_value` substring of `raw_name`, and
`min_amount`. First match wins; `multiplier` scales the emitted amount.
