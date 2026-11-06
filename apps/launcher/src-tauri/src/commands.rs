//! Tauri command surface — every function callable from the React frontend
//! via `invoke()`.
//!
//! Conventions: commands return `Result<T, String>` where the error string
//! is already user-presentable (server codes like `SUBSCRIPTION_REQUIRED`
//! pass through verbatim so the UI can localize them).

use serde::Serialize;
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;

use crate::api::ApiClient;
use crate::downloads;
use crate::events::{EventHub, TriggerMapper};
use crate::game_ws::{GameServer, GAME_WS_PORT};
use crate::integrations::IntegrationManager;
use crate::overlay::OVERLAY_URL;
use crate::process::ProcessManager;
use crate::settings::SettingsStore;
use crate::types::*;

/// Shared application state managed by Tauri.
pub struct AppState {
    pub data_dir: std::path::PathBuf,
    pub settings: Arc<Mutex<SettingsStore>>,
    pub api: ApiClient,
    pub hwid: String,
    pub hub: Arc<EventHub>,
    pub game_server: Arc<GameServer>,
    pub processes: ProcessManager,
    pub integrations: Arc<IntegrationManager>,
    /// Ingest channel for raw events (integrations + simulator).
    pub raw_tx: tokio::sync::mpsc::Sender<RawStreamEvent>,
    /// Slug whose trigger profile currently maps events (last played/selected).
    /// Shared with the mapper forwarder task.
    pub active_game_slug: Arc<Mutex<Option<String>>>,
}

/// One row of the library view: catalog + local + runtime merged.
#[derive(Serialize)]
struct LibraryEntry {
    slug: String,
    title: String,
    description: String,
    version: String,
    executable_name: String,
    installed: Option<InstalledGame>,
    update_available: bool,
    running: bool,
    connected_clients: usize,
}

/// Helper: current auth token or an error the UI sends back to login.
async fn token(state: &AppState) -> Result<String, String> {
    state
        .settings
        .lock()
        .await
        .data
        .auth_token
        .clone()
        .ok_or_else(|| "NOT_AUTHENTICATED".to_string())
}

// ---------------------------------------------------------------------------
// Bootstrap & session
// ---------------------------------------------------------------------------

/// Aggregated snapshot consumed by the frontend once at startup.
#[tauri::command]
pub async fn get_bootstrap(state: State<'_, AppState>) -> Result<Value, String> {
    let settings = state.settings.lock().await.data.clone();
    let authed = settings.auth_token.is_some();
    let subscription = if authed {
        state
            .api
            .subscription(settings.auth_token.as_deref().unwrap())
            .await
            .ok()
    } else {
        None
    };
    Ok(json!({
        "authed": authed,
        "email": settings.email,
        "hwid": state.hwid,
        "subscription": subscription,
        "streamer_mode": settings.streamer_mode,
        "window_options": settings.window_options,
        "tiktok_username": settings.tiktok_username,
        "integrations": state.integrations.snapshot().await,
        "running": state.processes.running_slugs(),
        "overlay_url": OVERLAY_URL,
        "game_ws_port": GAME_WS_PORT,
        "server_url": state.api.base(),
    }))
}

/// `POST /api/auth/register` → stores JWT.
#[tauri::command]
pub async fn register_account(
    email: String,
    password: String,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let res = state
        .api
        .register(&email, &password, &state.hwid)
        .await
        .map_err(|e| e.to_string())?;
    {
        let mut s = state.settings.lock().await;
        s.data.auth_token = Some(res.token.clone());
        s.data.email = Some(res.user.email.clone());
        let _ = s.save();
    }
    Ok(json!({"user": res.user, "subscription": res.subscription}))
}

/// `POST /api/auth/login` → stores JWT.
#[tauri::command]
pub async fn login(
    email: String,
    password: String,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let res = state
        .api
        .login(&email, &password, &state.hwid)
        .await
        .map_err(|e| e.to_string())?;
    {
        let mut s = state.settings.lock().await;
        s.data.auth_token = Some(res.token.clone());
        s.data.email = Some(res.user.email.clone());
        let _ = s.save();
    }
    Ok(json!({"user": res.user, "subscription": res.subscription}))
}

/// Clears the stored session.
#[tauri::command]
pub async fn logout(state: State<'_, AppState>) -> Result<(), String> {
    let mut s = state.settings.lock().await;
    s.data.auth_token = None;
    s.data.email = None;
    let _ = s.save();
    Ok(())
}

// ---------------------------------------------------------------------------
// Subscription / billing
// ---------------------------------------------------------------------------

/// Fresh subscription status (lazy-expired server-side).
#[tauri::command]
pub async fn get_subscription(state: State<'_, AppState>) -> Result<Subscription, String> {
    state
        .api
        .subscription(&token(&state).await?)
        .await
        .map_err(|e| e.to_string())
}

/// TEST billing: grants/extends a 30-day period.
#[tauri::command]
pub async fn mock_pay(state: State<'_, AppState>) -> Result<Subscription, String> {
    state
        .api
        .mock_pay(&token(&state).await?)
        .await
        .map_err(|e| e.to_string())
}

/// TEST billing: forces expiry (for lockout testing).
#[tauri::command]
pub async fn mock_expire(state: State<'_, AppState>) -> Result<Subscription, String> {
    state
        .api
        .mock_expire(&token(&state).await?)
        .await
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Library: catalog, install, launch, kill
// ---------------------------------------------------------------------------

/// Merged catalog + installed + running view for the library grid.
#[tauri::command]
pub async fn list_games(state: State<'_, AppState>) -> Result<Value, String> {
    let catalog = state
        .api
        .games(&token(&state).await?)
        .await
        .map_err(|e| e.to_string())?;
    let installed: std::collections::HashMap<String, InstalledGame> =
        downloads::all_installed(&state.data_dir).into_iter().collect();
    let running = state.processes.running_slugs();

    let mut entries = Vec::new();
    for g in catalog {
        let inst = installed.get(&g.slug);
        let update_available = inst.map(|i| i.version != g.version).unwrap_or(false);
        entries.push(LibraryEntry {
            connected_clients: state.game_server.client_count(&g.slug).await,
            running: running.contains(&g.slug),
            slug: g.slug,
            title: g.title,
            description: g.description,
            version: g.version,
            executable_name: g.executable_name,
            installed: inst.cloned(),
            update_available,
        });
    }
    Ok(json!({"games": entries}))
}

/// Downloads + extracts a game (subscription-gated server-side).
#[tauri::command]
pub async fn download_game(slug: String, state: State<'_, AppState>) -> Result<Value, String> {
    let token = token(&state).await?;
    let catalog = state.api.games(&token).await.map_err(|e| e.to_string())?;
    let game = catalog
        .iter()
        .find(|g| g.slug == slug)
        .ok_or_else(|| "GAME_NOT_FOUND".to_string())?;
    let info = downloads::download_and_install(
        &state.api,
        &token,
        &game.slug,
        &game.version,
        &game.executable_name,
        &state.data_dir,
    )
    .await
    .map_err(|e| e.to_string())?;
    Ok(json!({"installed": info}))
}

/// Launches an installed game behind the license gate.
///
/// Flow: verify license → mint one-time WS token → spawn process with
/// `--port --token` + window flags. The game must handshake within seconds
/// or it exits itself.
#[tauri::command]
pub async fn play_game(
    slug: String,
    window_options: Option<WindowOptions>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let token = token(&state).await?;
    if !state
        .api
        .verify_license(&token, &state.hwid)
        .await
        .map_err(|e| e.to_string())?
    {
        return Err("LICENSE_DENIED".into());
    }

    let installed = downloads::installed_info(&state.data_dir, &slug)
        .ok_or_else(|| "NOT_INSTALLED".to_string())?;
    let exe = std::path::PathBuf::from(&installed.exe_path);
    if !exe.exists() {
        return Err("EXECUTABLE_MISSING".into());
    }

    let opts = match window_options {
        Some(o) => o,
        None => state.settings.lock().await.data.window_options.clone(),
    };
    // Persist the last-used window options.
    {
        let mut s = state.settings.lock().await;
        s.data.window_options = opts.clone();
        let _ = s.save();
    }

    let session_token = state.game_server.issue_token(&slug).await;
    let args = ProcessManager::build_args(GAME_WS_PORT, &session_token, &opts);
    state
        .processes
        .spawn(&slug, &exe, &args)
        .map_err(|e| e.to_string())?;
    *state.active_game_slug.lock().await = Some(slug.clone());
    let _ = app.emit("game-launched", json!({"slug": slug}));
    Ok(json!({"launched": slug, "args": args}))
}

/// Sends `shutdown` to the game's WS link and hard-kills the process.
#[tauri::command]
pub async fn kill_game(slug: String, state: State<'_, AppState>) -> Result<(), String> {
    state.game_server.shutdown_slug(&slug).await;
    state.processes.kill(&slug).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Integrations
// ---------------------------------------------------------------------------

/// Connect TikTok Live presence polling for `username`.
#[tauri::command]
pub async fn tiktok_connect(username: String, state: State<'_, AppState>) -> Result<(), String> {
    state.integrations.tiktok_connect(username.clone()).await?;
    let mut s = state.settings.lock().await;
    s.data.tiktok_username = Some(username);
    let _ = s.save();
    Ok(())
}

/// Disconnect TikTok polling.
#[tauri::command]
pub async fn tiktok_disconnect(state: State<'_, AppState>) -> Result<(), String> {
    state.integrations.tiktok_disconnect().await;
    Ok(())
}

/// Connect DonationAlerts with an OAuth access token.
#[tauri::command]
pub async fn da_connect(token_input: String, state: State<'_, AppState>) -> Result<(), String> {
    state.integrations.da_connect(token_input.clone()).await?;
    let mut s = state.settings.lock().await;
    s.data.donationalerts_token = Some(token_input);
    let _ = s.save();
    Ok(())
}

/// Disconnect DonationAlerts.
#[tauri::command]
pub async fn da_disconnect(state: State<'_, AppState>) -> Result<(), String> {
    state.integrations.da_disconnect().await;
    Ok(())
}

// ---------------------------------------------------------------------------
// Trigger mapper & simulator
// ---------------------------------------------------------------------------

/// Returns the trigger profile for a game (seeds defaults on first access).
#[tauri::command]
pub async fn get_triggers(
    game_slug: String,
    state: State<'_, AppState>,
) -> Result<TriggerProfile, String> {
    let mut s = state.settings.lock().await;
    let profile = s
        .data
        .trigger_profiles
        .entry(game_slug.clone())
        .or_insert_with(|| TriggerMapper::default_profile(&game_slug))
        .clone();
    let _ = s.save();
    Ok(profile)
}

/// Persists an edited trigger profile.
#[tauri::command]
pub async fn save_triggers(
    profile: TriggerProfile,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut s = state.settings.lock().await;
    s.data
        .trigger_profiles
        .insert(profile.game_slug.clone(), profile);
    let _ = s.save();
    Ok(())
}

/// Injects a raw event into the mapping pipeline — the event simulator.
/// Works even with no game running (still reaches overlay + feed).
#[tauri::command]
pub async fn simulate_event(
    raw: RawStreamEvent,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .raw_tx
        .send(raw)
        .await
        .map_err(|_| "ingest closed".to_string())
}

/// Recent mapped events for the UI feed.
#[tauri::command]
pub async fn get_event_feed(state: State<'_, AppState>) -> Result<Vec<StreamEvent>, String> {
    Ok(state.hub.recent_events())
}

// ---------------------------------------------------------------------------
// Misc settings
// ---------------------------------------------------------------------------

/// Toggles streamer mode (masks personal data in the UI).
#[tauri::command]
pub async fn set_streamer_mode(enabled: bool, state: State<'_, AppState>) -> Result<(), String> {
    let mut s = state.settings.lock().await;
    s.data.streamer_mode = enabled;
    let _ = s.save();
    Ok(())
}

/// Broadcasts a chroma-key toggle to all connected games.
#[tauri::command]
pub async fn set_chroma_key(enabled: bool, state: State<'_, AppState>) -> Result<(), String> {
    state.game_server.broadcast_chroma_key(enabled).await;
    let mut s = state.settings.lock().await;
    s.data.window_options.chroma_key = enabled;
    let _ = s.save();
    Ok(())
}

/// Machine HWID (shown masked in the UI; needed for support).
#[tauri::command]
pub async fn get_hwid(state: State<'_, AppState>) -> Result<String, String> {
    Ok(state.hwid.clone())
}

/// Current backend base URL (shown on the auth screen).
#[tauri::command]
pub async fn get_server_url(state: State<'_, AppState>) -> Result<String, String> {
    Ok(state.api.base())
}

/// Points the launcher at another backend and persists the choice.
/// Accepts `http(s)://host[:port]`; trailing slashes are stripped.
#[tauri::command]
pub async fn set_server_url(url: String, state: State<'_, AppState>) -> Result<(), String> {
    let u = url.trim().trim_end_matches('/').to_string();
    if !(u.starts_with("http://") || u.starts_with("https://")) {
        return Err("URL должен начинаться с http:// или https://".into());
    }
    state.api.set_base(u.clone());
    let mut s = state.settings.lock().await;
    s.data.server_url = if u == crate::api::DEFAULT_BASE_URL {
        None
    } else {
        Some(u)
    };
    let _ = s.save();
    Ok(())
}
