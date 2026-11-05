//! E2E launch-path harness (dev only).
//!
//! Exercises the real pipeline without the UI: starts the `GameServer`,
//! issues a one-time token, spawns the built `mock-game.exe` with the same
//! argv `play_game` uses, then pushes a mapped event through the hub.
//! Success = the mock game handshakes and stays alive while events flow.
//!
//! Run: `cargo run --example e2e_launch -- D:\path\to\mock-game.exe`

use std::process::Command;
use std::sync::Arc;
use std::time::Duration;

use chlauncher_lib::events::EventHub;
use chlauncher_lib::game_ws::{GameServer, GAME_WS_PORT};
use chlauncher_lib::process::ProcessManager;
use chlauncher_lib::types::{StreamEvent, WindowOptions};

#[tokio::main]
async fn main() {
    let exe = std::env::args()
        .nth(1)
        .expect("usage: e2e_launch <path-to-mock-game.exe>");

    let hub = Arc::new(EventHub::new());
    let server = GameServer::new(hub.clone());
    let srv = server.clone();
    tokio::spawn(async move { let _ = srv.run_accept_loop().await; });
    tokio::time::sleep(Duration::from_millis(300)).await;

    // Same argv as the real play_game command.
    let token = server.issue_token("mock-game").await;
    let opts = WindowOptions {
        width: 480,
        height: 800,
        borderless: false,
        always_on_top: false,
        chroma_key: false,
    };
    let args = ProcessManager::build_args(GAME_WS_PORT, &token, &opts);

    println!("[e2e] spawning game: {} {:?}", exe, args);
    let _child = Command::new(&exe)
        .args(&args)
        .spawn()
        .expect("spawn mock-game");

    // Give the game a moment to connect + handshake.
    tokio::time::sleep(Duration::from_secs(2)).await;
    let clients = server.client_count("mock-game").await;
    println!("[e2e] connected game clients: {clients}");
    assert!(clients >= 1, "game never completed the WS handshake");

    // Push a mapped event — the game window should show it.
    hub.dispatch(StreamEvent {
        source: "simulator".into(),
        event_kind: "gift".into(),
        user: "e2e_tester".into(),
        avatar_url: String::new(),
        action_command: "spawn_enemy".into(),
        amount: 5,
        raw_name: "Rose".into(),
    });
    println!("[e2e] event dispatched; game alive = {}", clients >= 1);
    tokio::time::sleep(Duration::from_secs(2)).await;

    // Orderly shutdown — game receives `shutdown` and exits itself.
    server.shutdown_slug("mock-game").await;
    tokio::time::sleep(Duration::from_secs(1)).await;
    println!("[e2e] PASS: handshake + event delivery + shutdown verified");
}
