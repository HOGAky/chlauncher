//! # chlauncher — Tauri application assembly
//!
//! `run()` boots the launcher:
//!
//! 1. Resolves the app-data dir (`%APPDATA%/com.chlauncher.app`) and loads
//!    persisted [`SettingsStore`].
//! 2. Starts the game WebSocket server and the browser overlay server
//!    (both bind `127.0.0.1` on OS-assigned ports) plus the
//!    trigger-mapper forwarder task.
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
pub mod builtin_games;
pub mod commands;
pub mod downloads;
pub mod efirtimer;
pub mod events;
pub mod forwarder;
pub mod game_packs;
pub mod game_ws;
pub mod goals;
pub mod hwid;
pub mod hype;
pub mod integrations;
pub mod logging;
pub mod media;
pub mod minecraft;
pub mod overlay;
pub mod points;
pub mod polls;
pub mod process;
pub mod queue;
pub mod roblox_bridge;
pub mod scheduler;
pub mod secrets;
pub mod settings;
pub mod subathon;
pub mod timed;
pub mod tts;
pub mod types;
pub mod usage;

use std::sync::Arc;
use std::time::Duration;
use tauri::{Emitter, Manager};
use tokio::sync::{broadcast, mpsc, Mutex};

use commands::AppState;
use events::{EventHub, TriggerMapper};
use game_ws::GameServer;
use integrations::IntegrationManager;
use scheduler::ActionScheduler;
use settings::SettingsStore;
use std::collections::HashMap;
use types::{OverlayFrame, RawStreamEvent, SpinnerPool, TriggerProfile};

/// Builds and runs the Tauri app.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        // One instance only — a second launch just focuses the existing
        // window. Two launchers meant two WebView2 trees (~1.6 GB RAM).
        // MUST be registered first (plugin docs requirement).
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        // `chlauncher://` deep links (billing return_url after checkout)
        // and opening external URLs (the hosted checkout page) in the
        // system browser.
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Global TTS-mute hotkey (§6.2 `mute_hotkey`) — flips the flag,
        // drains the speech queue and notifies the UI.
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        if let Some(state) = app.try_state::<AppState>() {
                            let muted = !state.tts.is_muted();
                            state.tts.set_muted(muted);
                            let _ = app.emit("tts-muted", muted);
                        }
                    }
                })
                .build(),
        )
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
            // Raw-event fan-out for built-in interactive games: the
            // mapper re-broadcasts every normalized event here and the
            // overlay /ws "game" channel streams them to game pages.
            // Capacity 512 absorbs bursts; Lagged receivers resync.
            let game_events = broadcast::channel::<RawStreamEvent>(512).0;
            // Built-in game sessions + results ledger (<data>/game_results.json).
            let builtin = Arc::new(builtin_games::BuiltinGames::new(&data_dir));
            // User drop-in game packs root — folders added here are
            // picked up by the registry without a rebuild.
            let user_games = game_packs::user_dir(&data_dir);
            std::fs::create_dir_all(&user_games).ok();
            // Renamed bundled packs (aquarium → gif_constructor): move the
            // user's drop-in dir so custom assets keep applying.
            game_packs::migrate_legacy_dirs(&user_games);
            if let Ok(s) = settings.try_lock() {
                game_packs::set_server_overrides(s.data.pack_overrides.clone());
            }
            {
                let packs = game_packs::scan(&data_dir);
                let user = packs.iter().filter(|p| p.user).count();
                tracing::info!(
                    total = packs.len(),
                    user_packs = user,
                    dir = %user_games.display(),
                    "game packs scanned"
                );
            }

            // Local services bind 127.0.0.1:0 — the OS picks free ports.
            // A bind failure is recorded (not fatal): the UI shows the
            // "local service unavailable" warning from bootstrap instead
            // of silently degrading.
            let mut service_error: Option<String> = None;
            // Shared adapter-key cell (§10.1): settings is the source of
            // truth on disk; this copy lets `hello_adapter` validate and
            // `regenerate_adapter_key` take effect instantly.
            let adapter_key = Arc::new(std::sync::RwLock::new(
                settings
                    .try_lock()
                    .map(|s| s.data.adapter_key.clone())
                    .unwrap_or_default(),
            ));
            let game_server = match GameServer::bind(hub.clone(), adapter_key.clone()) {
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
                    GameServer::bind(hub.clone(), adapter_key.clone()).unwrap_or_else(|_| {
                        // Absolute last resort so the app can still start
                        // and show the error instead of crashing.
                        GameServer::bind_placeholder(hub.clone(), adapter_key.clone())
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
            // Overlay frames (alerts/spinner/progress/takeover) — the
            // overlay server relays these to /ws subscribers (§5.3).
            // Created before the server so it can relay from day one.
            let (overlay_tx, _) = broadcast::channel::<OverlayFrame>(256);
            // Raw-event broadcast for the widget library's "raw" /ws
            // channel — post-mapper clients (events hub) can't see
            // comments when a profile has no chat catch-all rule.
            let (raw_stream_tx, _) = broadcast::channel::<RawStreamEvent>(256);

            // TTS service (§6) — created before the overlay server so
            // its WavStore can serve `/tts/<id>.wav`.
            let tts = tts::Tts::new(settings.clone(), overlay_tx.clone(), data_dir.join("tts"));
            {
                let t = tts.clone();
                tauri::async_runtime::spawn(async move { t.run().await });
            }

            let (overlay_token, overlay_write_token, overlay_port_cfg) = settings
                .try_lock()
                .map(|s| {
                    (
                        s.data.overlay_token.clone(),
                        s.data.overlay_write_token.clone(),
                        s.data.overlay_port,
                    )
                })
                .unwrap_or_default();
            // Shared token cell: the overlay server validates `?t=` per
            // request, `rotate_overlay_token` writes the new value here.
            let overlay_token = Arc::new(std::sync::RwLock::new(overlay_token));
            // Write-scope token for mutating overlay routes (§P0.6) —
            // rotated together with the read token.
            let overlay_write_token = Arc::new(std::sync::RwLock::new(overlay_write_token));
            // Stream-goal counters — counted on raw events in the mapper
            // loop, rendered by /overlay/goals via /goals.json.
            let goals = goals::GoalTracker::new(settings.clone(), hub.clone(), overlay_tx.clone());
            // Chat polls — votes counted on raw comments; the winner is
            // re-injected into the ingest pipeline as a synthetic `poll`
            // event so trigger rules can act on it.
            let polls = polls::PollTracker::new(raw_tx.clone(), overlay_tx.clone());
            // Subathon countdown — paid events extend the clock
            // (settings.subathon rates), rendered on /overlay/subathon.
            let subathon = subathon::Subathon::new(settings.clone(), overlay_tx.clone());
            // EFIR-style stream timer — trigger/effect engine fed by raw
            // events; widgets subscribe to the `timer` WS channel.
            let (timer_tx, _) = broadcast::channel::<efirtimer::TimerFrame>(256);
            let efirtimer = efirtimer::EfirTimer::new(settings.clone(), timer_tx.clone());
            // Viewer queue (!join) — `queue_next` injects a `queue` event
            // into the pipeline so a rule can act on the called viewer.
            let queue = queue::ViewerQueue::new(raw_tx.clone(), overlay_tx.clone());
            // Hype meter — sliding-window coins sum on /overlay/hype.
            let hype = hype::HypeTracker::new(settings.clone());
            // Timed auto-events — every-N-minutes synthetic `timer` events
            // re-enter the ingest pipeline for trigger rules to act on.
            let timed = timed::TimedEvents::new(settings.clone(), raw_tx.clone());
            {
                let t = timed.clone();
                tauri::async_runtime::spawn(async move { t.run().await });
            }
            // Viewer points + !buy shop — balances persist to
            // <data>/points.json, purchases inject `shop` events.
            let points = points::ViewerPoints::new(settings.clone(), raw_tx.clone(), &data_dir);
            {
                let pts = points.clone();
                tauri::async_runtime::spawn(async move {
                    let mut tick = tokio::time::interval(std::time::Duration::from_secs(3));
                    loop {
                        tick.tick().await;
                        pts.flush_if_dirty().await;
                    }
                });
            }
            let overlay_port = match tauri::async_runtime::block_on(overlay::start_overlay_server(
                hub.clone(),
                overlay_tx.clone(),
                overlay_token.clone(),
                overlay_write_token.clone(),
                overlay_port_cfg,
                media::media_dir(&data_dir),
                settings.clone(),
                tts.wavs.clone(),
                goals.clone(),
                polls.clone(),
                subathon.clone(),
                queue.clone(),
                hype.clone(),
                game_events.clone(),
                builtin.clone(),
                app.handle().clone(),
                raw_stream_tx.clone(),
                timer_tx.clone(),
                efirtimer.clone(),
                tts.clone(),
                data_dir.clone(),
            )) {
                Ok((port, fell_back)) => {
                    if fell_back {
                        let msg = format!(
                            "Фиксированный порт оверлея {overlay_port_cfg} занят — \
                                 оверлей запущен на случайном порту {port}. \
                                 Обновите URL в OBS или освободите порт."
                        );
                        tracing::warn!("{msg}");
                        service_error = Some(match service_error {
                            Some(prev) => format!("{prev}\n{msg}"),
                            None => msg,
                        });
                    }
                    Some(port)
                }
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
            // Dev mode: the same relay API served locally — Roblox Studio
            // polls `localhost:8790` directly (roblox_bridge.rs).
            let roblox = roblox_bridge::RobloxBridge::new(&hub, settings.clone());
            {
                let (autostart, port) = settings
                    .try_lock()
                    .map(|s| {
                        let f = &s.data.forward;
                        (
                            f.local_bridge && roblox_bridge::dev_mode(s.data.role.as_deref()),
                            f.local_bridge_port.unwrap_or(roblox_bridge::DEFAULT_PORT),
                        )
                    })
                    .unwrap_or((false, roblox_bridge::DEFAULT_PORT));
                if autostart {
                    let r = roblox.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = r.start(port).await;
                    });
                }
            }

            // Earn-limit meter + entitlements cache (§8) — reports coins
            // every 60 s, refreshes the plan snapshot every 10 min.
            let usage = usage::UsageMeter::new(
                &data_dir,
                api.clone(),
                settings.clone(),
                Some(app.handle().clone()),
            );
            {
                let u = usage.clone();
                tauri::async_runtime::spawn(async move { u.reporter_loop().await });
            }
            {
                let u = usage.clone();
                tauri::async_runtime::spawn(async move { u.entitlements_loop().await });
            }

            let scheduler = Arc::new(ActionScheduler::new(hub.clone(), overlay_tx.clone()));
            scheduler.set_tts(tts.clone());
            scheduler.set_alerts_enabled(
                settings
                    .try_lock()
                    .map(|s| s.data.alerts.enabled)
                    .unwrap_or(true),
            );
            {
                let sched = scheduler.clone();
                tauri::async_runtime::spawn(async move { sched.run().await });
            }

            // Managed Paper server (§9) — the event router subscribes to
            // the EventHub; while `active_profile == "minecraft"` and the
            // server is up, mapped actions become RCON console commands.
            let mc = minecraft::MinecraftManager::new(&data_dir, settings.clone());
            {
                let mc2 = mc.clone();
                let hub2 = hub.clone();
                let slug2 = active_game_slug.clone();
                let app_h = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    mc2.event_router(hub2, app_h, slug2).await;
                });
            }
            // Frontend live-feed relay: every dispatched event reaches the
            // React feed as `stream-event` (games get it via WS, the
            // overlay via its own WS — one source of truth).
            {
                let mut rx = hub.tx.subscribe();
                let app_h = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    loop {
                        match rx.recv().await {
                            Ok(ev) => {
                                let _ = app_h.emit("stream-event", &ev);
                            }
                            // A burst > capacity must not kill the feed —
                            // skip the lost events and keep relaying.
                            Err(broadcast::error::RecvError::Lagged(_)) => continue,
                            Err(broadcast::error::RecvError::Closed) => break,
                        }
                    }
                });
            }

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
                roblox: roblox.clone(),
                raw_tx,
                active_game_slug: active_game_slug.clone(),
                scheduler: scheduler.clone(),
                overlay_tx: overlay_tx.clone(),
                tts: tts.clone(),
                usage: usage.clone(),
                goals: goals.clone(),
                polls: polls.clone(),
                subathon: subathon.clone(),
                efirtimer: efirtimer.clone(),
                queue: queue.clone(),
                hype: hype.clone(),
                points: points.clone(),
                games: builtin.clone(),
                mc: mc.clone(),
                adapter_key: adapter_key.clone(),
                overlay_token: overlay_token.clone(),
                overlay_write_token: overlay_write_token.clone(),
                catalog_seen: Arc::new(Mutex::new(None)),
                overlay_port: Mutex::new(overlay_port),
                service_error: Mutex::new(service_error),
            };

            // --- mapper forwarder: raw → scheduler → hub ----------------
            {
                tauri::async_runtime::spawn(mapper_loop(
                    raw_rx,
                    settings.clone(),
                    scheduler.clone(),
                    active_game_slug.clone(),
                    tts.clone(),
                    usage.clone(),
                    goals.clone(),
                    polls.clone(),
                    subathon.clone(),
                    efirtimer.clone(),
                    queue.clone(),
                    hype.clone(),
                    points.clone(),
                    game_events.clone(),
                    raw_stream_tx.clone(),
                ));
            }

            // Seed the preset cheat-sheet so a late-joining /overlay/preset
            // page renders immediately (replayed from last_frames).
            {
                let settings2 = settings.clone();
                let otx = overlay_tx.clone();
                tauri::async_runtime::spawn(async move {
                    let s = settings2.lock().await;
                    let profile = s
                        .data
                        .trigger_profiles
                        .get("default")
                        .cloned()
                        .unwrap_or_else(|| TriggerMapper::default_profile("default"));
                    drop(s);
                    let _ = otx.send(overlay::preset_frame(&profile));
                });
            }

            // --- watchdog: reap exited game processes -------------------
            tauri::async_runtime::spawn(watchdog_loop(app.handle().clone()));

            // --- catalog poller: detect new versions every 10 min (§6.3) --
            tauri::async_runtime::spawn(catalog_poller_loop(app.handle().clone()));

            app.manage(state);

            // --- startup auto-connect + re-verification --------------------
            // Restore the saved TikTok room a few seconds after boot, then
            // actively re-check the connection: Error/Disconnected retries
            // (up to 3 attempts — each respawn re-rolls the sign node and
            // re-runs the sidecar's fetchIsLive online check); a stuck
            // «Подключение…» also gets a fresh respawn per check round.
            // Skipped only when the streamer turned `tiktok_autoconnect` off.
            {
                let app_h = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    use crate::types::IntegrationStatus;
                    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                    let state = app_h.state::<AppState>();
                    let username = {
                        let s = state.settings.lock().await;
                        if s.data.tiktok_autoconnect == Some(false) {
                            None
                        } else {
                            s.data.tiktok_username.clone()
                        }
                    };
                    let Some(username) = username else { return };

                    for attempt in 1..=3u8 {
                        let bs =
                            commands::sidecar_bootstrap(&state.settings, &state.api.base()).await;
                        if let Err(e) = state
                            .integrations
                            .tiktok_connect(username.clone(), bs)
                            .await
                        {
                            tracing::warn!(error = %e, attempt, "tiktok auto-connect failed");
                        }
                        // Epoch guard: every manual connect/disconnect
                        // bumps the counter. If it moved while we slept,
                        // the user (or the session-capture flow) took
                        // over — retrying now would kill their connect.
                        let epoch = state.integrations.tiktok_epoch();
                        let my_epoch = epoch.load(std::sync::atomic::Ordering::SeqCst);
                        // Re-check: poll the reported status for ~60 s.
                        // Connecting = the sidecar is up and waiting for
                        // the room to go live — normal, but the next round
                        // still gives it one fresh respawn/online re-check.
                        let mut settled = false;
                        for _ in 0..6 {
                            tokio::time::sleep(std::time::Duration::from_secs(10)).await;
                            if epoch.load(std::sync::atomic::Ordering::SeqCst) != my_epoch {
                                tracing::info!(
                                    "tiktok auto-connect: manual action superseded — \
                                     supervisor stops"
                                );
                                return;
                            }
                            // Narrow window cover: a manual connect that
                            // landed between our spawn and the epoch read
                            // points the room handle elsewhere — bail.
                            if state.integrations.tiktok_username.lock().await.as_deref()
                                != Some(username.as_str())
                            {
                                return;
                            }
                            match *state.integrations.tiktok_status.lock().await {
                                IntegrationStatus::Live | IntegrationStatus::Connected => {
                                    return;
                                }
                                IntegrationStatus::Disconnected | IntegrationStatus::Error(_) => {
                                    settled = true;
                                    break;
                                }
                                IntegrationStatus::Connecting => {}
                            }
                        }
                        if !settled && attempt == 3 {
                            tracing::info!(
                                "tiktok auto-connect: still connecting after re-checks — \
                                 sidecar supervisor keeps waiting for live"
                            );
                        }
                    }
                });
            }

            // Register the configured TTS-mute hotkey (§6.2). The
            // configured string is `Ctrl+Shift+M`-style; on parse failure
            // we log and continue — hotkey stays unbound.
            if let Some(state) = app.try_state::<AppState>() {
                let hotkey = {
                    let s = state.settings.try_lock();
                    s.map(|s| s.data.tts.mute_hotkey.clone())
                        .unwrap_or_default()
                };
                if !hotkey.is_empty() {
                    use tauri_plugin_global_shortcut::GlobalShortcutExt;
                    if let Err(e) = app.global_shortcut().register(hotkey.as_str()) {
                        tracing::warn!(hotkey, error = %e, "tts mute hotkey not registered");
                    }
                }
            }

            // --- system tray (EFIR parity) --------------------------------
            // Closing the window hides to tray — the stream connection,
            // game sessions and overlay server keep running in the
            // background. Quit only via the tray menu (or Ctrl+Q).
            {
                use tauri::menu::{MenuBuilder, MenuItemBuilder};
                use tauri::tray::TrayIconBuilder;
                let show = MenuItemBuilder::with_id("show", "Открыть chlauncher").build(app)?;
                let close_ov =
                    MenuItemBuilder::with_id("close-overlays", "Закрыть оверлеи").build(app)?;
                let quit = MenuItemBuilder::with_id("quit", "Выход").build(app)?;
                let menu = MenuBuilder::new(app)
                    .items(&[&show, &close_ov, &quit])
                    .build()?;
                let mut tray = TrayIconBuilder::with_id("main").menu(&menu);
                if let Some(icon) = app.default_window_icon() {
                    tray = tray.icon(icon.clone());
                }
                tray.on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.unminimize();
                            let _ = w.set_focus();
                        }
                    }
                    "close-overlays" => {
                        for (label, w) in app.webview_windows() {
                            if label.starts_with("overlay-") {
                                let _ = w.close();
                            }
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    // Left-click toggles the window like most launchers.
                    if let tauri::tray::TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left,
                        button_state: tauri::tray::MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.unminimize();
                            let _ = w.set_focus();
                        }
                    }
                })
                .build(app)?;
            }
            Ok(())
        })
        // Close button → hide to tray (stream/game sessions keep running).
        // Real exit lives in the tray menu and Ctrl+Q / app.exit.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_bootstrap,
            commands::register_account,
            commands::login,
            commands::logout,
            commands::get_subscription,
            commands::billing_checkout,
            commands::billing_providers,
            commands::tg_link_code,
            commands::tg_status,
            commands::tg_unbind,
            commands::tg_login_start,
            commands::tg_login_status,
            commands::pair_login_start,
            commands::pair_login_status,
            commands::promo_redeem,
            commands::get_referrals,
            commands::referral_apply,
            commands::support_tickets,
            commands::support_ticket_create,
            commands::support_ticket,
            commands::support_reply,
            commands::support_close,
            commands::tiktok_bind,
            commands::tiktok_verify,
            commands::tiktok_bind_status,
            commands::tiktok_oauth_url,
            commands::tiktok_unbind,
            commands::builtin_games,
            commands::game_start,
            commands::game_pause,
            commands::game_resume,
            commands::game_stop,
            commands::game_cfg,
            commands::game_set_cfg,
            commands::game_results,
            commands::pack_manifest,
            commands::pack_admin_list,
            commands::save_pack_manifest,
            commands::reset_pack_manifest,
            commands::mock_pay,
            commands::mock_expire,
            commands::get_plans,
            commands::get_entitlements,
            commands::list_games,
            commands::download_game,
            commands::play_game,
            commands::kill_game,
            commands::tiktok_connect,
            commands::set_tiktok_session,
            commands::set_tiktok_autoconnect,
            commands::open_tiktok_login,
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
            commands::export_trigger_preset,
            commands::import_trigger_preset,
            commands::simulate_event,
            commands::get_event_feed,
            commands::get_event_feed_items,
            commands::scheduler_pause,
            commands::get_scheduler_status,
            commands::scheduler_reset_counters,
            commands::list_spinners,
            commands::save_spinner,
            commands::delete_spinner,
            commands::test_rule,
            commands::set_streamer_mode,
            commands::set_chroma_key,
            commands::set_overlay_port,
            commands::rotate_overlay_token,
            commands::get_alerts_settings,
            commands::set_alerts_settings,
            commands::get_tts_settings,
            commands::set_tts_settings,
            commands::tts_voices,
            commands::tts_say,
            commands::tts_gift_preview,
            commands::tts_set_muted,
            commands::get_tts_muted,
            commands::piper_status,
            commands::piper_setup,
            commands::piper_voice_download,
            commands::piper_voice_install_url,
            commands::piper_voice_delete,
            commands::piper_voices_open_dir,
            commands::rvc_status,
            commands::media_list,
            commands::media_import,
            commands::media_delete,
            commands::media_rename,
            commands::get_hwid,
            commands::get_server_url,
            commands::dev_build,
            commands::set_server_url,
            commands::set_forward_config,
            commands::regenerate_stream_key,
            commands::get_forward_status,
            commands::set_roblox_place_id,
            commands::roblox_launch,
            commands::roblox_play,
            commands::roblox_stream_status,
            commands::roblox_stream_key_sync,
            commands::roblox_stream_key_rotate,
            commands::roblox_bridge_status,
            commands::roblox_bridge_set,
            commands::roblox_dev_play,
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
            commands::admin_set_plan,
            commands::admin_set_role,
            commands::admin_list_plans,
            commands::admin_create_plan,
            commands::admin_update_plan,
            commands::admin_audit,
            commands::admin_promo_list,
            commands::admin_promo_create,
            commands::admin_promo_retire,
            commands::admin_support_tickets,
            commands::admin_support_ticket,
            commands::admin_support_reply,
            commands::admin_support_status,
            commands::services_health,
            commands::get_proc_info,
            commands::get_diagnostics,
            commands::check_launcher_update,
            commands::mc_status,
            commands::mc_accept_eula,
            commands::mc_install,
            commands::mc_start,
            commands::mc_stop,
            commands::mc_console,
            commands::mc_logs,
            commands::mc_set_settings,
            commands::mc_world_reset,
            commands::mc_world_backup,
            commands::mc_plugin_catalog,
            commands::mc_install_plugin,
            commands::mc_remove_plugin,
            commands::adapter_status,
            commands::regenerate_adapter_key,
            commands::open_overlay_window,
            commands::close_overlay_window,
            commands::get_goals,
            commands::save_goals,
            commands::reset_goals,
            commands::poll_start,
            commands::poll_stop,
            commands::poll_status,
            commands::subathon_start,
            commands::subathon_stop,
            commands::subathon_pause,
            commands::subathon_resume,
            commands::subathon_status,
            commands::save_subathon_cfg,
            commands::efirtimer_start,
            commands::efirtimer_stop,
            commands::efirtimer_pause,
            commands::efirtimer_resume,
            commands::efirtimer_status,
            commands::save_efirtimer_cfg,
            commands::efirtimer_import,
            commands::efirtimer_card_pick,
            commands::efirtimer_manual,
            commands::open_timer_window,
            commands::close_timer_window,
            commands::queue_next,
            commands::queue_status,
            commands::queue_set_open,
            commands::queue_clear,
            commands::hype_status,
            commands::save_hype_cfg,
            commands::get_timed_events,
            commands::save_timed_events,
            commands::points_top,
            commands::points_balance,
            commands::points_adjust,
            commands::get_points_cfg,
            commands::save_points_cfg,
            commands::soundboard_play,
            commands::get_shop_items,
            commands::save_shop_items,
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
                        // Managed MC server: RCON `stop` + 5 s grace,
                        // then kill — no orphaned java process.
                        state.mc.shutdown().await;
                        // Last usage report before exit (§8.4) — bounded
                        // by its own 5 s timeout inside flush().
                        state.usage.flush().await;
                        // Undelivered relay events get a 2 s grace —
                        // otherwise they would silently vanish on quit.
                        state
                            .forwarder
                            .flush(
                                &state.settings,
                                &state.api,
                                std::time::Duration::from_secs(2),
                            )
                            .await;
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

/// Cached clone of the settings sections the mapper needs. Rebuilt only
/// when `SettingsStore::revision` changes (any `save()`) or the active
/// slug/takeover changes — on a like-storm this avoids cloning the whole
/// profile+spinner maps for every single event. A periodic rebuild bounds
/// staleness for any in-memory mutation that forgets `save()`.
struct MappingCache {
    rev: u64,
    slug: String,
    takeover: Option<String>,
    built: std::time::Instant,
    profile: TriggerProfile,
    spinners: HashMap<String, SpinnerPool>,
    alerts: crate::settings::AlertSettings,
}

/// How long a cached mapping survives without a settings save —
/// safety net against non-persisted in-memory changes.
const MAPPING_CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(30);

/// Maps raw ingest events through the active game's trigger profile —
/// hands them to the [`ActionScheduler`], which owns cooldowns,
/// accumulators, the priority queue, alerts and interrupts. An active
/// paid-interrupt takeover swaps the profile in memory only (§3.3).
// Event-pipeline wiring — the subsystem handles are already Arc'd;
// a config struct would just re-wrap the same handles.
#[allow(clippy::too_many_arguments)]
async fn mapper_loop(
    mut raw_rx: mpsc::Receiver<RawStreamEvent>,
    settings: Arc<Mutex<SettingsStore>>,
    scheduler: Arc<ActionScheduler>,
    active_slug: Arc<Mutex<Option<String>>>,
    tts: Arc<tts::Tts>,
    usage: Arc<usage::UsageMeter>,
    goals: Arc<goals::GoalTracker>,
    polls: Arc<polls::PollTracker>,
    subathon: Arc<subathon::Subathon>,
    efirtimer: Arc<efirtimer::EfirTimer>,
    queue: Arc<queue::ViewerQueue>,
    hype: Arc<hype::HypeTracker>,
    points: Arc<points::ViewerPoints>,
    game_events: broadcast::Sender<RawStreamEvent>,
    raw_stream: broadcast::Sender<RawStreamEvent>,
) {
    let mut cache: Option<MappingCache> = None;
    while let Some(raw) = raw_rx.recv().await {
        // Built-in game pages get every raw event — gifts arrive already
        // streak-deduplicated by the sidecar (repeatEnd only).
        let _ = game_events.send(raw.clone());
        // Widget-library subscribers (/ws "raw" channel) see every
        // event before the mapper decides what to do with it.
        let _ = raw_stream.send(raw.clone());
        // Chat-to-speech sees every event — gifter tracking, comment and
        // gift reading per `read_*` modes, gift-sound rules (§6.2).
        tts.note_event(&raw).await;
        // `gift_tick` — промежуточные юниты серии подарков: нужны только
        // TTS-звукам «каждый подарок»; трекеры и маппер их не считают,
        // иначе стата задвоится (монеты итак приходят в финале серии).
        if raw.event_kind == "gift_tick" {
            continue;
        }
        // Stream goals count the event flow itself (kind/count/coins) —
        // independent of which profile maps it.
        goals.note_raw(&raw).await;
        polls.note_raw(&raw).await;
        subathon.note_raw(&raw).await;
        efirtimer.note_raw(&raw).await;
        queue.note_raw(&raw).await;
        hype.note_raw(&raw).await;
        points.note_raw(&raw).await;
        let slug = active_slug
            .lock()
            .await
            .clone()
            .unwrap_or_else(|| "default".to_string());
        let takeover = scheduler
            .active_takeover()
            .map(|(preset, _user, _until)| preset);
        let stale = match &cache {
            None => true,
            Some(c) => {
                c.slug != slug
                    || c.takeover != takeover
                    || c.built.elapsed() > MAPPING_CACHE_TTL
                    || {
                        // Revision check needs the lock — but a shared read
                        // of one u64 is far cheaper than cloning profiles.
                        settings
                            .try_lock()
                            .map(|s| s.revision() != c.rev)
                            .unwrap_or(true)
                    }
            }
        };
        if stale {
            let mut s = settings.lock().await;
            let mut profile = s
                .data
                .trigger_profiles
                .entry(slug.clone())
                .or_insert_with(|| TriggerMapper::default_profile(&slug))
                .clone();
            // Paid-interrupt takeover: the override profile is built from
            // the interrupt's preset and never persisted (§3.3.4).
            if let Some(preset_name) = &takeover {
                if let Some(preset) =
                    TriggerMapper::find_preset(preset_name, &s.data.trigger_presets)
                {
                    profile = TriggerMapper::profile_from_preset(&slug, &preset);
                }
            }
            cache = Some(MappingCache {
                rev: s.revision(),
                slug: slug.clone(),
                takeover,
                built: std::time::Instant::now(),
                profile,
                spinners: s.data.spinners.clone(),
                alerts: s.data.alerts.clone(),
            });
        }
        let c = cache.as_mut().unwrap();
        // Plan entitlements (§8): trim the profile copy to what the plan
        // allows and seed the earn-limit check with the monthly total.
        let ent = usage.entitlements().await;
        usage::enforce_profile_limits(&mut c.profile, &ent);
        let before = scheduler.status().usage_coins;
        scheduler.ingest(&scheduler::IngestInput {
            profile: &c.profile,
            raw,
            spinners: &c.spinners,
            alerts: &c.alerts,
            earn_limit_coins: ent.earn_limit_coins_month.unwrap_or(0),
            usage_base: usage.month_coins().await,
            bypass: false,
        });
        // Coins of events that actually produced actions feed the meter —
        // skipped/queued events don't count (§8.4).
        let delta = scheduler.status().usage_coins - before;
        if delta > 0 {
            usage.note(delta).await;
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
