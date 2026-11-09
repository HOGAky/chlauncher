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
pub mod logging;
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
    let app = tauri::Builder::default()
        // `chlauncher://` deep links (billing return_url after checkout)
        // and opening external URLs (the hosted checkout page) in the
        // system browser.
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            // --- filesystem roots -------------------------------------
            let data_dir = app.path().app_data_dir().unwrap_or_else(|_| {
                dirs::data_dir()
                    .unwrap_or_else(|| std::path::PathBuf::from("."))
                    .join("com.chlauncher.app")
            });
            std::fs::create_dir_all(&data_dir).ok();
            logging::init(&data_dir);
            tracing::info!(dir = %data_dir.display(), "chlauncher starting");

            // --- shared state ------------------------------------------
            let settings = Arc::new(Mutex::new(SettingsStore::load(&data_dir)));
            let hub = Arc::new(EventHub::new());
            let (raw_tx, raw_rx) = mpsc::channel::<RawStreamEvent>(256);

            // Local services bind 127.0.0.1:0 — the OS picks free ports.
            // A bind failure is recorded (not fatal): the UI shows the
            // "local service unavailable" warning from bootstrap instead
            // of silently degrading.
            let mut service_error: Option<String> = None;
            let game_server = match GameServer::bind(hub.clone()) {
                Ok(gs) => gs,
                Err(e) => {
                    let msg = format!(
                        "Не удалось открыть локальный сервис (game ws): {e}. \
                         Возможно, запущена другая копия chlauncher или порт заблокирован."
                    );
                    tracing::error!("{msg}");
                    service_error = Some(msg);
                    // Fallback: bind lazily on port 0 again — will fail the
                    // same way, but keeps AppState constructible.
                    GameServer::bind(hub.clone()).unwrap_or_else(|_| {
                        // Absolute last resort so the app can still start
                        // and show the error instead of crashing.
                        GameServer::bind_placeholder(hub.clone())
                    })
                }
            };
            {
                let gs = game_server.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = gs.run_accept_loop().await {
                        tracing::error!(error = %e, "game-ws accept loop failed");
                    }
                });
            }
            let overlay_port =
                match tauri::async_runtime::block_on(overlay::start_overlay_server(hub.clone())) {
                    Ok(port) => Some(port),
                    Err(e) => {
                        let msg = format!(
                            "Не удалось открыть локальный сервис (overlay): {e}. \
                             Возможно, запущена другая копия chlauncher или порт заблокирован."
                        );
                        tracing::error!("{msg}");
                        service_error = Some(match service_error {
                            Some(prev) => format!("{prev}\n{msg}"),
                            None => msg,
                        });
                        None
                    }
                };

            let integrations = Arc::new(IntegrationManager::new(
                raw_tx.clone(),
                app.handle().clone(),
            ));

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
                catalog_seen: Arc::new(Mutex::new(None)),
                overlay_port: Mutex::new(overlay_port),
                service_error: Mutex::new(service_error),
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

            // --- catalog poller: detect new versions every 10 min (§6.3) --
            tauri::async_runtime::spawn(catalog_poller_loop(app.handle().clone()));

            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_bootstrap,
            commands::register_account,
            commands::login,
            commands::logout,
            commands::get_subscription,
            commands::billing_checkout,
            commands::mock_pay,
            commands::mock_expire,
            commands::list_games,
            commands::download_game,
            commands::play_game,
            commands::kill_game,
            commands::tiktok_connect,
            commands::tiktok_disconnect,
            commands::tiktok_reconnect,
            commands::get_integration_status,
            commands::da_connect,
            commands::da_disconnect,
            commands::get_triggers,
            commands::save_triggers,
            commands::get_active_trigger_profile,
            commands::set_active_trigger_profile,
            commands::apply_trigger_template,
            commands::apply_trigger_preset,
            commands::list_trigger_presets,
            commands::save_trigger_preset,
            commands::delete_trigger_preset,
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
            commands::admin_list_games,
            commands::admin_create_game,
            commands::admin_update_game,
            commands::admin_upload_build,
            commands::admin_publish,
            commands::admin_unpublish,
            commands::admin_rollback,
            commands::admin_list_users,
            commands::admin_grant_days,
            commands::admin_reset_hwid,
            commands::admin_audit,
            commands::services_health,
            commands::get_proc_info,
            commands::get_diagnostics,
            commands::check_launcher_update,
        ])
        .build(tauri::generate_context!());
    let app = match app {
        Ok(a) => a,
        Err(e) => {
            eprintln!("[fatal] failed to build tauri application: {e}");
            std::process::exit(1);
        }
    };
    app.run(|app, event| {
        match event {
            tauri::RunEvent::Exit => {
                // Graceful first: WS `shutdown` to every game, up to 5 s
                // to exit cleanly, then force-kill stragglers so no
                // licensed binary outlives the launcher.
                if let Some(state) = app.try_state::<AppState>() {
                    tauri::async_runtime::block_on(async {
                        for slug in state.processes.running_slugs() {
                            state.game_server.shutdown_slug(&slug).await;
                        }
                        let deadline =
                            std::time::Instant::now() + std::time::Duration::from_secs(5);
                        while !state.processes.running_slugs().is_empty()
                            && std::time::Instant::now() < deadline
                        {
                            state.processes.collect_exited();
                            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                        }
                    });
                    state.processes.kill_all();
                }
            }
            // Fresh catalog check when the window regains focus (§6.3).
            tauri::RunEvent::WindowEvent {
                event: tauri::WindowEvent::Focused(true),
                ..
            } => {
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    check_catalog(&handle).await;
                });
            }
            _ => {}
        }
    });
}

/// Fetches the catalog and emits `catalog-changed` when the slug→version
/// map differs from the last snapshot. The first fetch only sets a
/// baseline — no event on startup.
async fn check_catalog(app: &tauri::AppHandle) {
    use tauri::Manager;
    let state = app.state::<AppState>();
    let token = state.settings.lock().await.data.auth_token.clone();
    let Some(token) = token else { return };
    let Ok(games) = state.api.games(&token).await else {
        return;
    };
    let map: std::collections::BTreeMap<String, String> = games
        .iter()
        .map(|g| (g.slug.clone(), g.version.clone()))
        .collect();
    let mut seen = state.catalog_seen.lock().await;
    if let Some(prev) = seen.as_ref() {
        if *prev != map {
            let _ = app.emit("catalog-changed", ());
        }
    }
    *seen = Some(map);
}

/// Polls the game catalog every 10 minutes (§6.3); the diff →
/// `catalog-changed` event refreshes the library badge in the UI.
async fn catalog_poller_loop(app: tauri::AppHandle) {
    let mut tick = tokio::time::interval(Duration::from_secs(600));
    loop {
        tick.tick().await;
        check_catalog(&app).await;
    }
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
            tracing::info!(slug = %slug, "game process exited");
            let _ = app.emit("game-exited", serde_json::json!({"slug": slug}));
        }
    }
}
