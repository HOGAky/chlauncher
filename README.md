# chlauncher

Desktop launcher & hub for interactive **TikTok Live** games (Rust) with a
monthly subscription model and DonationAlerts integration.

> Work in progress — full documentation lands in `README.md` / `docs/` at the
> end of the MVP build-out.

## Monorepo layout

| Path                 | Stack                                   | Purpose                                   |
| -------------------- | --------------------------------------- | ----------------------------------------- |
| `apps/launcher`      | Tauri v2 · React · TS · Tailwind        | Desktop launcher & streamer hub           |
| `apps/server`        | Node.js · Fastify · SQLite (`node:sqlite`) | Auth, licensing, 30-day subscriptions  |
| `packages/game-sdk`  | Rust crate                              | IPC SDK: launcher handshake + event feed  |
| `apps/mock-game`     | Rust · eframe/egui                      | Test game for launch/DRM/event pipeline   |
| `docs/`              | Markdown                                | Architecture & operations documentation   |
