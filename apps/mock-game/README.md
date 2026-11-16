# mock-game — test game for chlauncher

`eframe`/`egui` window that exercises the whole launcher pipeline.

## Behavior

- **Direct start** (no `--port/--token`): shows a "Ошибка лицензии" window
  and exits after ~3 s — proves the DRM handshake.
- **Launched via launcher**: opens in the requested proportions
  (default 540×960 = 9:16), shows a green "Подключено к Лаунчеру" badge,
  a scrolling event log and animated spawn markers for mapped commands
  (`spawn_enemy` orange, `spawn_boss` red, `heal_player` green).
- Honors `--width --height --borderless --always-on-top --chroma-key`
  and runtime `set_chroma_key` messages (background → `#00FF00`).
- Exits automatically when the launcher link dies (`is_alive()` watchdog).

## Build & package

```bash
cargo build -p mock-game --release          # binary → target/release/mock-game(.exe)
powershell Compress-Archive target/release/mock-game.exe \
    apps/server/static/games/mock-game-0.1.0.zip   # package for download
```

Keep the zip name aligned with the `file_name`/`version` columns seeded in
`apps/server/src/db.js`.
