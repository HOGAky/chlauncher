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
use crate::forwarder::Forwarder;
use crate::game_ws::GameServer;
use crate::integrations::IntegrationManager;
use crate::overlay::overlay_url;
use crate::process::ProcessManager;
use crate::settings::SettingsStore;
use crate::types::*;

/// How long `play_game` waits for the game to complete the WS handshake
/// before declaring the launch failed.
const HANDSHAKE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);
/// Grace period for a graceful shutdown (WS `shutdown` frame) before the
/// process is force-killed.
const SHUTDOWN_GRACE: std::time::Duration = std::time::Duration::from_secs(5);

/// Shared application state managed by Tauri.
pub struct AppState {
    pub data_dir: std::path::PathBuf,
    pub settings: Arc<Mutex<SettingsStore>>,
    pub api: ApiClient,
    /// `None` when the OS refuses a machine id — register/login then fail
    /// with `HWID_UNAVAILABLE` instead of sending a fake sentinel.
    pub hwid: Option<String>,
    pub hub: Arc<EventHub>,
    pub game_server: Arc<GameServer>,
    pub processes: ProcessManager,
    pub integrations: Arc<IntegrationManager>,
    /// HTTP-forward to the cloud relay (Roblox games).
    pub forwarder: Arc<Forwarder>,
    /// Ingest channel for raw events (integrations + simulator).
    pub raw_tx: tokio::sync::mpsc::Sender<RawStreamEvent>,
    /// Slug whose trigger profile currently maps events (last played/selected).
    /// Shared with the mapper forwarder task.
    pub active_game_slug: Arc<Mutex<Option<String>>>,
    /// Action scheduler — cooldowns/queue/alerts engine (parity spec §2).
    pub scheduler: Arc<crate::scheduler::ActionScheduler>,
    /// Broadcast of overlay frames (alerts/spinner/progress/takeover).
    pub overlay_tx: tokio::sync::broadcast::Sender<OverlayFrame>,
    /// Last seen slug→version snapshot for catalog-change detection (§6.3).
    pub catalog_seen: Arc<Mutex<Option<std::collections::BTreeMap<String, String>>>>,
    /// Actual OS-assigned overlay port (None until bound / on bind failure).
    pub overlay_port: Mutex<Option<u16>>,
    /// Startup error for a local service that failed to bind — surfaced in
    /// bootstrap so the UI can warn instead of silently degrading.
    pub service_error: Mutex<Option<String>>,
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

/// Slug boundary check: `^[a-z0-9][a-z0-9_-]{0,63}$`. Rejects `..`,
/// separators, absolute paths and encoded traversal before anything
/// touches the filesystem or a URL path segment.
fn valid_slug(slug: &str) -> bool {
    let b = slug.as_bytes();
    if b.is_empty() || b.len() > 64 || !(b[0].is_ascii_lowercase() || b[0].is_ascii_digit()) {
        return false;
    }
    b.iter()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'_' || *c == b'-')
}

/// Helper: usable hardware id or `HWID_UNAVAILABLE` — never a sentinel.
fn require_hwid(state: &AppState) -> Result<&str, String> {
    state
        .hwid
        .as_deref()
        .ok_or_else(|| "HWID_UNAVAILABLE".to_string())
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
    let subscription = if let Some(t) = settings.auth_token.as_deref() {
        state.api.subscription(t).await.ok()
    } else {
        None
    };
    Ok(json!({
        "authed": authed,
        "email": settings.email,
        "role": settings.role,
        "hwid": state.hwid,
        "subscription": subscription,
        "streamer_mode": settings.streamer_mode,
        "window_options": settings.window_options,
        "tiktok_username": settings.tiktok_username,
        "integrations": state.integrations.snapshot().await,
        "running": state.processes.running_slugs(),
        "overlay_url": state.overlay_port.lock().await.map(overlay_url),
        "game_ws_port": state.game_server.port(),
        "service_error": state.service_error.lock().await.clone(),
        "server_url": state.api.base(),
        "forward": {
            "enabled": settings.forward.enabled,
            "forward_url": settings.forward.forward_url,
            "stream_key": settings.forward.stream_key,
            "has_admin_secret": settings.forward.relay_admin_secret.is_some(),
            "status": state.forwarder.snapshot().await,
        },
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
        .register(&email, &password, require_hwid(&state)?)
        .await
        .map_err(|e| e.to_string())?;
    {
        let mut s = state.settings.lock().await;
        s.data.auth_token = Some(res.token.clone());
        s.data.email = Some(res.user.email.clone());
        s.data.role = res.user.role.clone();
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
        .login(&email, &password, require_hwid(&state)?)
        .await
        .map_err(|e| e.to_string())?;
    {
        let mut s = state.settings.lock().await;
        s.data.auth_token = Some(res.token.clone());
        s.data.email = Some(res.user.email.clone());
        s.data.role = res.user.role.clone();
        let _ = s.save();
    }
    Ok(json!({"user": res.user, "subscription": res.subscription}))
}

/// Clears the stored session. Best-effort server-side invalidation first —
/// a JWT issued before this call stops authorizing on the server (Task 5).
/// Local logout always succeeds even when the server is unreachable.
#[tauri::command]
pub async fn logout(state: State<'_, AppState>) -> Result<(), String> {
    if let Some(t) = state.settings.lock().await.data.auth_token.clone() {
        let _ = state.api.logout(&t).await; // best-effort; never blocks logout
    }
    let mut s = state.settings.lock().await;
    s.data.auth_token = None;
    s.data.email = None;
    s.data.role = None;
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

/// `POST /api/billing/checkout` → `{payment_id, checkout_url}` for the UI
/// to open in the system browser. The YooKassa webhook extends the
/// subscription; the UI refreshes on the `chlauncher://` deep-link return.
#[tauri::command]
pub async fn billing_checkout(state: State<'_, AppState>) -> Result<Value, String> {
    state
        .api
        .checkout(&token(&state).await?)
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
        downloads::all_installed(&state.data_dir)
            .into_iter()
            .collect();
    let running = state.processes.running_slugs();

    let mut entries = Vec::new();
    for g in catalog {
        let inst = installed.get(&g.slug);
        let update_available = inst
            .map(|i| semver_gt(&g.version, &i.version))
            .unwrap_or(false);
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

/// Whether catalog version `a` is strictly newer than installed `b`
/// (semver when parseable; falls back to plain inequality for odd tags).
fn semver_gt(a: &str, b: &str) -> bool {
    match (semver::Version::parse(a), semver::Version::parse(b)) {
        (Ok(va), Ok(vb)) => va > vb,
        _ => a != b,
    }
}

/// Downloads + extracts a game (subscription-gated server-side).
#[tauri::command]
pub async fn download_game(slug: String, state: State<'_, AppState>) -> Result<Value, String> {
    if !valid_slug(&slug) {
        return Err("INVALID_SLUG".to_string());
    }
    if state.processes.running_slugs().contains(&slug) {
        // A running game holds file locks — the UI must stop it first.
        return Err("GAME_RUNNING".to_string());
    }
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
        game.sha256.as_deref(),
        &state.data_dir,
    )
    .await
    .map_err(|e| {
        tracing::error!(slug = %slug, error = %e, "game install failed");
        e.to_string()
    })?;
    tracing::info!(slug = %slug, version = %info.version, "game installed");
    Ok(json!({"installed": info}))
}

/// Verifies the on-disk install before launching: the executable must
/// live inside its install dir (canonicalized, no symlink escape), carry
/// the name the catalog expects, and — when the installer recorded one —
/// match its SHA-256.
fn verify_install(
    installed: &InstalledGame,
    catalog_exe: Option<&str>,
) -> Result<std::path::PathBuf, String> {
    let install_dir = std::path::PathBuf::from(&installed.install_dir);
    let exe = std::path::PathBuf::from(&installed.exe_path);
    let canon_dir = install_dir
        .canonicalize()
        .map_err(|_| "INSTALL_FAILED".to_string())?;
    // Canonicalizing the exe path resolves symlinks — a link escaping the
    // install dir is rejected here.
    let canon_exe = exe
        .canonicalize()
        .map_err(|_| "EXECUTABLE_MISSING".to_string())?;
    if !canon_exe.starts_with(&canon_dir) {
        return Err("EXECUTABLE_OUTSIDE_INSTALL_DIR".into());
    }
    if let Some(expected) = catalog_exe {
        let actual = canon_exe
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        if actual != expected {
            return Err("EXECUTABLE_NAME_MISMATCH".into());
        }
    }
    if let Some(expected_sha) = installed.exe_sha256.as_deref() {
        let actual =
            downloads::sha256_file(&canon_exe).map_err(|_| "INSTALL_FAILED".to_string())?;
        if !actual.eq_ignore_ascii_case(expected_sha) {
            return Err("HASH_MISMATCH".into());
        }
    }
    Ok(exe)
}

/// Launches an installed game behind the license gate.
///
/// Flow: verify license → verify install (path/sha256) → mint one-time
/// WS token → spawn process (`{token,port}` via **stdin**, never argv) →
/// wait ≤ 15 s for the WS handshake. On timeout the process is killed and
/// marked `FailedToStart` so the user gets a clear `HANDSHAKE_TIMEOUT`.
#[tauri::command]
pub async fn play_game(
    slug: String,
    window_options: Option<WindowOptions>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    if !valid_slug(&slug) {
        return Err("INVALID_SLUG".into());
    }
    let token = token(&state).await?;
    if !state
        .api
        .verify_license(&token, require_hwid(&state)?)
        .await
        .map_err(|e| e.to_string())?
    {
        return Err("LICENSE_DENIED".into());
    }

    let catalog_exe = state.api.games(&token).await.ok().and_then(|g| {
        g.iter()
            .find(|x| x.slug == slug)
            .map(|x| x.executable_name.clone())
    });

    let installed = downloads::installed_info(&state.data_dir, &slug)
        .ok_or_else(|| "NOT_INSTALLED".to_string())?;
    let exe = verify_install(&installed, catalog_exe.as_deref())?;

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

    let port = state.game_server.port();
    let session_token = state.game_server.issue_token(&slug).await;
    let args = ProcessManager::build_args(port, &opts);
    let payload = ProcessManager::stdin_payload(port, &session_token);
    state
        .processes
        .spawn(&slug, &exe, &args, &payload)
        .map_err(|e| {
            tracing::error!(slug = %slug, error = %e, "game spawn failed");
            e.to_string()
        })?;
    tracing::info!(slug = %slug, "game process spawned");
    *state.active_game_slug.lock().await = Some(slug.clone());

    // Launch gate: the game must connect + hello within HANDSHAKE_TIMEOUT.
    if !state
        .game_server
        .wait_for_handshake(&slug, HANDSHAKE_TIMEOUT)
        .await
    {
        tracing::warn!(slug = %slug, "game handshake timed out — killing process");
        state.processes.fail_and_kill(&slug);
        let _ = app.emit("game-exited", json!({"slug": slug}));
        return Err("HANDSHAKE_TIMEOUT".into());
    }
    state.processes.mark_handshaken(&slug);
    tracing::info!(slug = %slug, "game handshake ok");
    let _ = app.emit("game-launched", json!({"slug": slug}));
    Ok(json!({"launched": slug}))
}

/// Graceful stop: WS `shutdown` frame first, up to 5 s to let the game
/// exit cleanly, then force-kill if it ignored the order.
#[tauri::command]
pub async fn kill_game(slug: String, state: State<'_, AppState>) -> Result<(), String> {
    if !state.processes.is_alive(&slug) {
        // Still try the WS path — the socket may outlive the marker.
        state.game_server.shutdown_slug(&slug).await;
        return Err("GAME_NOT_RUNNING".into());
    }
    state.game_server.shutdown_slug(&slug).await;
    if !state.processes.wait_for_exit(&slug, SHUTDOWN_GRACE).await {
        state.processes.kill(&slug).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Integrations
// ---------------------------------------------------------------------------

/// Connect TikTok Live presence polling for `username`.
#[tauri::command]
pub async fn tiktok_connect(username: String, state: State<'_, AppState>) -> Result<(), String> {
    // When signed in, hand the sidecar our sign-proxy URL + JWT over
    // stdin: the backend injects the paid EulerStream key there, so it
    // never ships inside the client. Signed-out users get the free tier.
    let sign_cfg = state
        .settings
        .lock()
        .await
        .data
        .auth_token
        .clone()
        .map(|t| (format!("{}/api/tiktok-sign", state.api.base()), t));
    state
        .integrations
        .tiktok_connect(username.clone(), sign_cfg)
        .await?;
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

/// Reconnects TikTok to the saved username — the «Обновить связь» button.
#[tauri::command]
pub async fn tiktok_reconnect(state: State<'_, AppState>) -> Result<(), String> {
    let username = state
        .settings
        .lock()
        .await
        .data
        .tiktok_username
        .clone()
        .ok_or("ник TikTok не сохранён — подключитесь вручную")?;
    tiktok_connect(username, state).await
}

/// Lightweight status snapshot (statuses + last activity) for UI polling —
/// cheaper than `get_bootstrap` for a 5 s freshness loop.
#[tauri::command]
pub async fn get_integration_status(state: State<'_, AppState>) -> Result<Value, String> {
    Ok(state.integrations.snapshot().await)
}

/// Connect DonationAlerts with an OAuth access token.
#[tauri::command]
pub async fn da_connect(token_input: String, state: State<'_, AppState>) -> Result<(), String> {
    let coins_per_rub = state.settings.lock().await.data.da_coins_per_rub;
    state
        .integrations
        .da_connect(token_input.clone(), coins_per_rub)
        .await?;
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

/// Which slug's profile currently maps live events (normally the last
/// launched game). `None` → the mapper falls back to "default".
#[tauri::command]
pub async fn get_active_trigger_profile(
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    Ok(state.active_game_slug.lock().await.clone())
}

/// Manually selects which profile maps live events — the streamer's
/// "activate this preset for the stream" control (cloud-only streams set
/// it without launching a local game). `play_game` re-points routing at
/// the launched game's profile.
#[tauri::command]
pub async fn set_active_trigger_profile(
    slug: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let slug = slug.trim().to_string();
    *state.active_game_slug.lock().await = if slug.is_empty() { None } else { Some(slug) };
    // Switching the active profile resets runtime cooldowns/accumulators.
    state.scheduler.reset_runtime();
    Ok(())
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
    drop(s);
    state.scheduler.reset_runtime();
    Ok(())
}

/// Applies a named preset (built-in or custom) over a game's profile.
#[tauri::command]
pub async fn apply_trigger_template(
    game_slug: String,
    template: String,
    state: State<'_, AppState>,
) -> Result<TriggerProfile, String> {
    apply_trigger_preset(game_slug, template, state).await
}

/// Applies a named preset over a game's profile — built-in or streamer-defined.
#[tauri::command]
pub async fn apply_trigger_preset(
    game_slug: String,
    preset: String,
    state: State<'_, AppState>,
) -> Result<TriggerProfile, String> {
    let mut s = state.settings.lock().await;
    let p = TriggerMapper::find_preset(&preset, &s.data.trigger_presets)
        .ok_or_else(|| format!("неизвестный пресет: {preset}"))?;
    let profile = TriggerMapper::profile_from_preset(&game_slug, &p);
    s.data.trigger_profiles.insert(game_slug, profile.clone());
    let _ = s.save();
    drop(s);
    // Profile switch resets runtime cooldowns/accumulators (§2.2).
    state.scheduler.reset_runtime();
    Ok(profile)
}

/// Lists built-in and streamer-defined presets (built-ins first, customs sorted).
#[tauri::command]
pub async fn list_trigger_presets(
    state: State<'_, AppState>,
) -> Result<Vec<TriggerPreset>, String> {
    let s = state.settings.lock().await;
    let mut out = TriggerMapper::builtin_presets();
    let mut customs: Vec<TriggerPreset> = s.data.trigger_presets.values().cloned().collect();
    customs.sort_by(|a, b| a.name.cmp(&b.name));
    out.extend(customs);
    Ok(out)
}

/// Saves a streamer-defined preset. Built-in names are reserved — a preset
/// named like a built-in is rejected rather than shadowing it.
#[tauri::command]
pub async fn save_trigger_preset(
    mut preset: TriggerPreset,
    state: State<'_, AppState>,
) -> Result<TriggerPreset, String> {
    preset.name = preset.name.trim().to_string();
    if preset.name.is_empty() {
        return Err("имя пресета пусто".into());
    }
    if TriggerMapper::is_builtin_preset(&preset.name) {
        return Err(format!(
            "{name} — встроенный пресет, имя занято",
            name = preset.name
        ));
    }
    preset.builtin = false;
    let mut s = state.settings.lock().await;
    s.data
        .trigger_presets
        .insert(preset.name.clone(), preset.clone());
    let _ = s.save();
    Ok(preset)
}

/// Deletes a streamer-defined preset. Built-ins can't be deleted.
#[tauri::command]
pub async fn delete_trigger_preset(name: String, state: State<'_, AppState>) -> Result<(), String> {
    if TriggerMapper::is_builtin_preset(&name) {
        return Err(format!("{name} — встроенный пресет, удалить нельзя"));
    }
    let mut s = state.settings.lock().await;
    s.data.trigger_presets.remove(&name);
    let _ = s.save();
    Ok(())
}

/// Serializes a preset (built-in or custom) into the portable share format
/// `{ "format": "chlauncher-preset", "version": 1, "preset": …, "media": [] }`.
/// Media embedding lands with the media library (spec stage 6) — for now
/// rules keep their `MediaRef` ids and `media` stays empty.
#[tauri::command]
pub async fn export_trigger_preset(
    name: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let preset = {
        let s = state.settings.lock().await;
        TriggerMapper::find_preset(&name, &s.data.trigger_presets)
            .ok_or_else(|| format!("пресет «{name}» не найден"))?
    };
    serde_json::to_string_pretty(&json!({
        "format": "chlauncher-preset",
        "version": 1,
        "preset": preset,
        "media": [],
    }))
    .map_err(|e| e.to_string())
}

/// Imports a preset exported by `export_trigger_preset`. Name collisions
/// (with built-ins or existing customs) get a `" (2)"` suffix rather than
/// an overwrite. Returns the stored preset.
#[tauri::command]
pub async fn import_trigger_preset(
    json_str: String,
    state: State<'_, AppState>,
) -> Result<TriggerPreset, String> {
    let v: Value =
        serde_json::from_str(&json_str).map_err(|_| "невалидный JSON пресета".to_string())?;
    if v["format"].as_str() != Some("chlauncher-preset") {
        return Err("это не файл пресета chlauncher".into());
    }
    let mut preset: TriggerPreset = serde_json::from_value(v["preset"].clone())
        .map_err(|e| format!("битый preset в файле: {e}"))?;
    preset.name = preset.name.trim().to_string();
    if preset.name.is_empty() {
        return Err("у пресета пустое имя".into());
    }
    preset.builtin = false;

    let mut s = state.settings.lock().await;
    if TriggerMapper::is_builtin_preset(&preset.name)
        || s.data.trigger_presets.contains_key(&preset.name)
    {
        let base = preset.name.clone();
        let mut n = 2;
        loop {
            let candidate = format!("{base} ({n})");
            if !TriggerMapper::is_builtin_preset(&candidate)
                && !s.data.trigger_presets.contains_key(&candidate)
            {
                preset.name = candidate;
                break;
            }
            n += 1;
        }
    }
    s.data
        .trigger_presets
        .insert(preset.name.clone(), preset.clone());
    let _ = s.save();
    Ok(preset)
}

/// Injects a raw event into the mapping pipeline — the event simulator.
/// Works even with no game running (still reaches overlay + feed).
#[tauri::command]
pub async fn simulate_event(
    mut raw: RawStreamEvent,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if raw.ts_ms == 0 {
        raw.ts_ms = now_ms();
    }
    if raw.count < 1 {
        raw.count = 1;
    }
    state
        .raw_tx
        .send(raw)
        .await
        .map_err(|_| "ingest closed".to_string())
}

/// Recent mapped events for the UI feed (legacy shape — fired only).
#[tauri::command]
pub async fn get_event_feed(state: State<'_, AppState>) -> Result<Vec<StreamEvent>, String> {
    Ok(state.hub.recent_events())
}

/// Statusful feed — fired *and* skipped events with a status label
/// (cooldown/limit/paused/dropped), newest first (§2.6).
#[tauri::command]
pub async fn get_event_feed_items(state: State<'_, AppState>) -> Result<Vec<FeedItem>, String> {
    Ok(state.hub.feed_items())
}

// ---------------------------------------------------------------------------
// Action scheduler (parity spec §2)
// ---------------------------------------------------------------------------

/// Global scheduler pause — «перерыв»: actions stop, events keep queueing.
#[tauri::command]
pub async fn scheduler_pause(paused: bool, state: State<'_, AppState>) -> Result<(), String> {
    state.scheduler.set_paused(paused);
    Ok(())
}

/// Live scheduler snapshot for the mapper page (§2.6).
#[tauri::command]
pub async fn get_scheduler_status(
    state: State<'_, AppState>,
) -> Result<crate::scheduler::SchedulerStatus, String> {
    Ok(state.scheduler.status())
}

/// «Сбросить счётчики» — clears `every_n` accumulators (§2.3).
#[tauri::command]
pub async fn scheduler_reset_counters(state: State<'_, AppState>) -> Result<(), String> {
    state.scheduler.reset_counters();
    Ok(())
}

/// Runs one rule through the whole pipeline bypassing cooldowns and the
/// earn limit — the ▶ test button (§2.5). Uses a synthetic event shaped
/// after the rule so `match_all` picks exactly it.
#[tauri::command]
pub async fn test_rule(
    game_slug: String,
    rule_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let (profile, spinners, alerts_cfg) = {
        let s = state.settings.lock().await;
        let Some(profile) = s.data.trigger_profiles.get(&game_slug).cloned() else {
            return Err(format!("нет профиля для {game_slug}"));
        };
        (profile, s.data.spinners.clone(), s.data.alerts.clone())
    };
    let Some(rule) = profile.rules.iter().find(|r| r.id == rule_id).cloned() else {
        return Err("правило не найдено".into());
    };
    let raw = RawStreamEvent {
        source: "simulator".into(),
        event_kind: if rule.event_kind == "any" {
            "gift".into()
        } else {
            rule.event_kind.clone()
        },
        user: "test".into(),
        avatar_url: String::new(),
        raw_name: rule.match_value.clone(),
        amount: rule.min_amount.max(1),
        count: rule.min_amount.max(1),
        coins: 0,
        gift_id: None,
        ts_ms: now_ms(),
    };
    // Single-rule profile so match_all can't pull in neighbors.
    let p = TriggerProfile {
        rules: vec![rule],
        ..profile
    };
    state.scheduler.ingest(&crate::scheduler::IngestInput {
        profile: &p,
        raw,
        spinners: &spinners,
        alerts: &alerts_cfg,
        earn_limit_coins: 0,
        bypass: true,
    });
    Ok(())
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
    Ok(state.hwid.clone().unwrap_or_default())
}

/// Current backend base URL (shown on the auth screen).
#[tauri::command]
pub async fn get_server_url(state: State<'_, AppState>) -> Result<String, String> {
    Ok(state.api.base())
}

/// Points the launcher at another backend and persists the choice.
/// Accepts `http(s)://host[:port]`; trailing slashes are stripped.
/// Dev builds only — release binaries pin the prod endpoint at compile
/// time so a settings-file edit can't redirect licensing to a fake server.
#[tauri::command]
pub async fn set_server_url(url: String, state: State<'_, AppState>) -> Result<(), String> {
    #[cfg(not(debug_assertions))]
    {
        let _ = (url, state);
        return Err("Смена сервера доступна только в dev-сборке".into());
    }
    #[cfg(debug_assertions)]
    {
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
}

// ---------------------------------------------------------------------------
// HTTP-forward (Roblox/cloud relay)
// ---------------------------------------------------------------------------

/// Saves forward settings; enabling pushes a key registration right away.
#[tauri::command]
pub async fn set_forward_config(
    enabled: bool,
    forward_url: String,
    relay_admin_secret: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let u = forward_url.trim().trim_end_matches('/').to_string();
    if enabled && !(u.starts_with("http://") || u.starts_with("https://")) {
        return Err("forward_url должен начинаться с http:// или https://".into());
    }
    {
        let mut s = state.settings.lock().await;
        s.data.forward.enabled = enabled;
        s.data.forward.forward_url = if u.is_empty() { None } else { Some(u) };
        if !relay_admin_secret.trim().is_empty() {
            s.data.forward.relay_admin_secret = Some(relay_admin_secret.trim().to_string());
        }
        if s.data.forward.stream_key.is_none() {
            s.data.forward.stream_key = Some(format!("sk_{}", uuid::Uuid::new_v4().simple()));
        }
        let _ = s.save();
    }
    if enabled {
        state.forwarder.register_now().await;
    }
    Ok(())
}

/// Generates a fresh stream key (old Roblox-room binds die with it) and
/// re-registers immediately if forwarding is on.
#[tauri::command]
pub async fn regenerate_stream_key(state: State<'_, AppState>) -> Result<String, String> {
    let key = format!("sk_{}", uuid::Uuid::new_v4().simple());
    {
        let mut s = state.settings.lock().await;
        s.data.forward.stream_key = Some(key.clone());
        let _ = s.save();
    }
    if state.settings.lock().await.data.forward.enabled {
        state.forwarder.register_now().await;
    }
    Ok(key)
}

/// Runtime forwarder counters for the UI (queue/drops/last error).
#[tauri::command]
pub async fn get_forward_status(state: State<'_, AppState>) -> Result<Value, String> {
    Ok(serde_json::to_value(state.forwarder.snapshot().await).unwrap_or_default())
}

// ---------------------------------------------------------------------------
// Admin API — thin JWT-authenticated wrappers; the server enforces role=admin
// (403 FORBIDDEN) so a non-admin UI simply gets the error back (spec §7).
// ---------------------------------------------------------------------------

use reqwest::Method;

#[tauri::command]
pub async fn admin_list_games(state: State<'_, AppState>) -> Result<Value, String> {
    state
        .api
        .admin_json(Method::GET, "/api/admin/games", &token(&state).await?, None)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn admin_create_game(
    slug: String,
    title: String,
    description: String,
    executable_name: String,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    state
        .api
        .admin_json(
            Method::POST,
            "/api/admin/games",
            &token(&state).await?,
            Some(json!({
                "slug": slug,
                "title": title,
                "description": description,
                "executable_name": executable_name,
            })),
        )
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn admin_update_game(
    slug: String,
    patch: Value,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    state
        .api
        .admin_json(
            Method::PATCH,
            &format!("/api/admin/games/{slug}"),
            &token(&state).await?,
            Some(patch),
        )
        .await
        .map_err(|e| e.to_string())
}

/// Streams a local zip to the server as a new build; emits
/// `build-upload-progress {slug, sent, total}` per 256 KiB chunk.
#[tauri::command]
pub async fn admin_upload_build(
    app: AppHandle,
    slug: String,
    version: String,
    changelog: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let t = token(&state).await?;
    let ev_slug = slug.clone();
    state
        .api
        .admin_upload_build(
            &t,
            &slug,
            &version,
            &changelog,
            std::path::Path::new(&path),
            move |sent, total| {
                let _ = app.emit(
                    "build-upload-progress",
                    json!({"slug": ev_slug, "sent": sent, "total": total}),
                );
            },
        )
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn admin_publish(
    slug: String,
    version: String,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    state
        .api
        .admin_json(
            Method::POST,
            &format!("/api/admin/games/{slug}/publish"),
            &token(&state).await?,
            Some(json!({"version": version})),
        )
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn admin_unpublish(slug: String, state: State<'_, AppState>) -> Result<Value, String> {
    state
        .api
        .admin_json(
            Method::POST,
            &format!("/api/admin/games/{slug}/unpublish"),
            &token(&state).await?,
            Some(json!({})),
        )
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn admin_rollback(slug: String, state: State<'_, AppState>) -> Result<Value, String> {
    state
        .api
        .admin_json(
            Method::POST,
            &format!("/api/admin/games/{slug}/rollback"),
            &token(&state).await?,
            Some(json!({})),
        )
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn admin_list_users(query: String, state: State<'_, AppState>) -> Result<Value, String> {
    let enc: String = query
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect();
    state
        .api
        .admin_json(
            Method::GET,
            &format!("/api/admin/users?query={enc}"),
            &token(&state).await?,
            None,
        )
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn admin_grant_days(
    user_id: i64,
    days: i64,
    comment: String,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    state
        .api
        .admin_json(
            Method::POST,
            &format!("/api/admin/users/{user_id}/grant-days"),
            &token(&state).await?,
            Some(json!({"days": days, "comment": comment})),
        )
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn admin_reset_hwid(user_id: i64, state: State<'_, AppState>) -> Result<Value, String> {
    state
        .api
        .admin_json(
            Method::POST,
            &format!("/api/admin/users/{user_id}/reset-hwid"),
            &token(&state).await?,
            Some(json!({})),
        )
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn admin_audit(state: State<'_, AppState>) -> Result<Value, String> {
    state
        .api
        .admin_json(Method::GET, "/api/admin/audit", &token(&state).await?, None)
        .await
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Local services health (self-test)
// ---------------------------------------------------------------------------

/// Checks that the loopback services actually answer: TCP-connect to the
/// game WS port and GET the overlay `/health`. Returns per-service status.
#[tauri::command]
pub async fn services_health(state: State<'_, AppState>) -> Result<Value, String> {
    let game_port = state.game_server.port();
    let game_ws = if game_port > 0 {
        tokio::net::TcpStream::connect(("127.0.0.1", game_port))
            .await
            .is_ok()
    } else {
        false
    };
    let overlay = match *state.overlay_port.lock().await {
        Some(p) => reqwest::get(format!("http://127.0.0.1:{p}/health"))
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false),
        None => false,
    };
    Ok(json!({
        "game_ws": { "port": game_port, "ok": game_ws },
        "overlay": { "port": *state.overlay_port.lock().await, "ok": overlay },
        "service_error": state.service_error.lock().await.clone(),
    }))
}

/// Diagnostics for one running process: state, pid, exit code, log tails.
#[tauri::command]
pub async fn get_proc_info(slug: String, state: State<'_, AppState>) -> Result<Value, String> {
    let info = state
        .processes
        .proc_info(&slug)
        .ok_or_else(|| "GAME_NOT_RUNNING".to_string())?;
    serde_json::to_value(info).map_err(|e| e.to_string())
}

/// Copy-safe diagnostics report for bug reports: versions, OS, service
/// health, integration state and the last ~50 redacted log lines. Never
/// contains tokens, passwords, HWIDs, stream keys or cookies (Task 6).
#[tauri::command]
pub async fn get_diagnostics(state: State<'_, AppState>) -> Result<String, String> {
    let health = services_health(state.clone()).await.unwrap_or_default();
    let integrations = state.integrations.snapshot().await;
    let running = state.processes.running_slugs();
    let log_tail = crate::logging::tail_log(&state.data_dir, 50);
    Ok(format!(
        "chlauncher diagnostics\n\
         ======================\n\
         app: {} ({})\n\
         os: {} {}\n\
         services: {}\n\
         integrations: {}\n\
         running games: {}\n\
         ---- last log lines (redacted) ----\n{}",
        env!("CARGO_PKG_NAME"),
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
        std::env::consts::ARCH,
        serde_json::to_string_pretty(&health).unwrap_or_default(),
        serde_json::to_string_pretty(&integrations).unwrap_or_default(),
        running.join(", "),
        if log_tail.is_empty() {
            "(log file empty)"
        } else {
            &log_tail
        }
    ))
}

// ---------------------------------------------------------------------------
// Launcher self-update
// ---------------------------------------------------------------------------

/// Checks the signed updater endpoint (GitHub Releases `latest.json`).
/// If a newer version exists it is downloaded, signature-verified and
/// installed, then the app relaunches — on success this command never
/// resolves. `null` means already up to date; errors surface as strings.
#[tauri::command]
pub async fn check_launcher_update(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater().map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Ok(None);
    };
    let version = update.version.clone();
    tracing::info!(version = %version, "launcher update available, installing");
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    // NSIS passive install applies on the next start — relaunch now.
    app.restart();
}
