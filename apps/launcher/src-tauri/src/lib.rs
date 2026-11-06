//! # chlauncher — Tauri application assembly
//!
//! `run()` boots the launcher:
//!
//! 1. Resolves the app-data dir (`%APPDATA%/com.chlauncher.app`) and loads
//!    persisted [`SettingsStore`].
//! 2. Starts the game WebSocket server (`:9876`), the browser overlay
//!    server (`:9877`) and the trigger-mapper forwarder task.
//! 3. Spawns the watchdog that reaps exited game processes and re-verifies
//!    the subscription every ~60 s while games run (lapsed sub → shutdown).
//! 4. Registers all [`commands`] as the frontend IPC surface.
//!
//! Event pipeline:
//! `integrations/simulator → raw_tx → mapper(profile) → EventHub →
//! {game WS, overlay WS, frontend "stream-event"}`.

// Modules are `pub` so integration tests under `tests/` can exercise the
// internals (e.g. the game WS handshake) without the Tauri shell.
pub mod api;
pub mod commands;
pub mod downloads;
pub mod events;
pub mod forwarder;
pub mod game_ws;
pub mod hwid;
pub mod integrations;
pub mod overlay;
pub mod process;
pub mod settings;
pub mod types;

use std::sync::Arc;
use std::time::Duration;
use tauri::{Emitter, Manager};
use tokio::sync::{mpsc, Mutex};

use commands::AppState;
use events::{EventHub, TriggerMapper};
use game_ws::GameServer;
use integrations::IntegrationManager;
use settings::SettingsStore;
use types::RawStreamEvent;

/// Builds and runs the Tauri app.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // --- filesystem roots -------------------------------------
            let data_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| {
                    dirs::data_dir()
                        .unwrap_or_else(|| std::path::PathBuf::from("."))
                        .join("com.chlauncher.app")
                });
            std::fs::create_dir_all(&data_dir).ok();

            // --- shared state ------------------------------------------
            let settings = Arc::new(Mutex::new(SettingsStore::load(&data_dir)));
            let hub = Arc::new(EventHub::new());
            let (raw_tx, raw_rx) = mpsc::channel::<RawStreamEvent>(256);

            let game_server = GameServer::new(hub.clone());
            {
                let gs = game_server.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = gs.run_accept_loop().await {
                        eprintln!("[game-ws] accept loop failed: {e}");
                    }
                });
            }
            {
                let hub = hub.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = overlay::start_overlay_server(hub).await {
                        eprintln!("[overlay] server failed: {e}");
                    }
                });
            }

            let integrations =
                Arc::new(IntegrationManager::new(raw_tx.clone(), app.handle().clone()));

            // One shared cell: `play_game` writes it, the mapper reads it.
            let active_game_slug = Arc::new(Mutex::new(None));

            let api = api::ApiClient::new(api::resolve_base_url(
                settings
                    .try_lock()
                    .ok()
                    .and_then(|s| s.data.server_url.clone())
                    .as_deref(),
            ));

            // Third EventHub consumer: HTTP-forward to the cloud relay
            // (Roblox-side games poll the relay; see docs/roblox-integration.md).
            let forwarder = forwarder::Forwarder::start(&hub, settings.clone(), api.clone());

            let state = AppState {
                data_dir: data_dir.clone(),
                settings: settings.clone(),
                api,
                hwid: hwid::hardware_id(),
                hub: hub.clone(),
                game_server: game_server.clone(),
                processes: process::ProcessManager::new(),
                integrations: integrations.clone(),
                forwarder: forwarder.clone(),
                raw_tx,
                active_game_slug: active_game_slug.clone(),
            };

            // --- mapper forwarder: raw → mapped → hub + frontend --------
            {
                tauri::async_runtime::spawn(mapper_loop(
                    raw_rx,
                    settings.clone(),
                    hub.clone(),
                    app.handle().clone(),
                    active_game_slug.clone(),
                ));
            }

            // --- watchdog: reap exited game processes -------------------
            tauri::async_runtime::spawn(watchdog_loop(app.handle().clone()));

            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_bootstrap,
            commands::register_account,
            commands::login,
            commands::logout,
            commands::get_subscription,
            commands::mock_pay,
            commands::mock_expire,
            commands::list_games,
            commands::download_game,
            commands::play_game,
            commands::kill_game,
            commands::tiktok_connect,
            commands::tiktok_disconnect,
            commands::da_connect,
            commands::da_disconnect,
            commands::get_triggers,
            commands::save_triggers,
            commands::apply_trigger_template,
            commands::simulate_event,
            commands::get_event_feed,
            commands::set_streamer_mode,
            commands::set_chroma_key,
            commands::get_hwid,
            commands::get_server_url,
            commands::set_server_url,
            commands::set_forward_config,
            commands::regenerate_stream_key,
            commands::get_forward_status,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                // Kill every spawned game so no licensed binary outlives
                // the launcher.
                if let Some(state) = app.try_state::<AppState>() {
                    state.processes.kill_all();
                }
            }
        });
}

/// Maps raw ingest events through the active game's trigger profile and
/// dispatches the result to the hub + frontend.
async fn mapper_loop(
    mut raw_rx: mpsc::Receiver<RawStreamEvent>,
    settings: Arc<Mutex<SettingsStore>>,
    hub: Arc<EventHub>,
    app: tauri::AppHandle,
    active_slug: Arc<Mutex<Option<String>>>,
) {
    while let Some(raw) = raw_rx.recv().await {
        let slug = active_slug
            .lock()
            .await
            .clone()
            .unwrap_or_else(|| "default".to_string());
        let profile = {
            let mut s = settings.lock().await;
            s.data
                .trigger_profiles
                .entry(slug.clone())
                .or_insert_with(|| TriggerMapper::default_profile(&slug))
                .clone()
        };
        if let Some(ev) = TriggerMapper::map(&raw, &profile) {
            hub.dispatch(ev.clone());
            let _ = app.emit("stream-event", &ev);
        }
    }
}

/// Reaps exited game processes every 2 s and emits `game-exited` so the UI
/// can re-enable Play buttons. (License re-verification mid-session is
/// handled client-side through the SDK heartbeat watchdog.)
async fn watchdog_loop(app: tauri::AppHandle) {
    let mut tick = tokio::time::interval(Duration::from_secs(2));
    loop {
        tick.tick().await;
        let state = app.state::<AppState>();
        for slug in state.processes.collect_exited() {
            let _ = app.emit("game-exited", serde_json::json!({"slug": slug}));
        }
    }
}
