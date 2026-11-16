# tiktok-game-sdk — Rust IPC SDK for chlauncher games

Crate linked into every game distributed through the launcher.

## What it does

- **DRM handshake** — `init_and_verify()` parses `--port` / `--token` from
  argv, connects to the launcher's local WebSocket (`ws://127.0.0.1:<port>`),
  sends `hello` and waits for `welcome`. On any failure the game must exit —
  see `init_or_exit()`.
- **Event feed** — `LauncherLink::poll()` yields `LauncherMessage`s:
  `Event` (mapped `StreamEvent`), `SetChromaKey`, `Heartbeat`, `Shutdown`,
  `Error`.
- **Watchdog** — `LauncherLink::is_alive()` goes `false` when the socket
  drops or no heartbeat arrives for 150 s; the game must then terminate.

## Protocol

| Direction        | Frame                                                   |
| ---------------- | ------------------------------------------------------- |
| game → launcher  | `{type:"hello", token, protocol}`                       |
| launcher → game  | `{type:"welcome", protocol}`                            |
| launcher → game  | `{type:"event", event:{source,event_kind,user,…}}`      |
| launcher → game  | `{type:"heartbeat", ts}` (every ~60 s)                  |
| launcher → game  | `{type:"set_chroma_key", enabled}`                      |
| launcher → game  | `{type:"shutdown"}` / `{type:"error", reason}`          |

## Adding to a game

```toml
[dependencies]
tiktok-game-sdk = { path = "../../packages/game-sdk" }
```

```rust
let link = tiktok_game_sdk::init_or_exit();
// per frame:
for msg in link.poll() { /* … */ }
if !link.is_alive() { std::process::exit(0); }
```

See `apps/mock-game` for a complete reference implementation.
