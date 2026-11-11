//! Tauri command surface — every function callable from the React frontend
//! via `invoke()`.
//!
//! Conventions: commands return `Result<T, String>` where the error string
//! is already user-presentable (server codes like `SUBSCRIPTION_REQUIRED`
//! pass through verbatim so the UI can localize them).

use serde::Serialize;
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Mutex;

use crate::api::ApiClient;
use crate::downloads;
use crate::events::{EventHub, TriggerMapper};
use crate::forwarder::Forwarder;
use crate::game_ws::GameServer;
use crate::integrations::IntegrationManager;
use crate::overlay::{overlay_page, overlay_url};
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
    /// Chat-to-speech service (§6) — queue, filters, SAPI engine, mute.
    pub tts: Arc<crate::tts::Tts>,
    /// Earn-limit meter + entitlements cache (§8).
    pub usage: Arc<crate::usage::UsageMeter>,
    /// Stream-goal counters («Цели стрима») — raw events accrue here,
    /// `/goals.json` + `/overlay/goals` render progress.
    pub goals: Arc<crate::goals::GoalTracker>,
    /// Chat polls («Голосования») — votes counted on raw comments, the
    /// winner re-entering the pipeline as a `poll` event.
    pub polls: Arc<crate::polls::PollTracker>,
    /// Subathon countdown — paid events extend the clock (§S2E parity).
    pub subathon: Arc<crate::subathon::Subathon>,
    /// Viewer queue (!join) — `queue_next` injects a `queue` event.
    pub queue: Arc<crate::queue::ViewerQueue>,
    /// Hype meter - sliding-window coins for /overlay/hype.
    pub hype: Arc<crate::hype::HypeTracker>,
    /// Viewer points + !buy shop - see `points.rs`.
    pub points: Arc<crate::points::ViewerPoints>,
    /// Managed Paper server lifecycle (§9).
    pub mc: Arc<crate::minecraft::MinecraftManager>,
    /// Shared adapter key for `hello_adapter` validation (§10.1).
    pub adapter_key: Arc<std::sync::RwLock<String>>,
    /// Live overlay access token — the overlay server reads this cell
    /// per request, so `rotate_overlay_token` must update it.
    pub overlay_token: Arc<std::sync::RwLock<String>>,
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
    /// Free-tier launchable without a subscription (§8.3).
    is_free: bool,
    /// `paid_games` entitlement — UI shows a lock badge on paid titles
    /// for Free accounts (server still enforces on download/launch).
    paid_games_allowed: bool,
    /// `"game"` or `"adapter"` (external mod, §10.3).
    kind: String,
    /// Adapter action manifest JSON blob — parsed client-side.
    adapter_manifest: String,
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
        "overlay_url": state.overlay_port.lock().await.map(|p| {
            overlay_url(p, &settings.overlay_token)
        }),
        "overlay_pages": state.overlay_port.lock().await.map(|p| {
            let t = &settings.overlay_token;
            json!({
                "main": overlay_page(p, t, "/overlay"),
                "alerts": overlay_page(p, t, "/overlay/alerts"),
                "preset": overlay_page(p, t, "/overlay/preset"),
                "spinner": overlay_page(p, t, "/overlay/spinner"),
                "tts": overlay_page(p, t, "/overlay/tts"),
                "progress": overlay_page(p, t, "/overlay/progress"),
                "leaderboard": overlay_page(p, t, "/overlay/leaderboard"),
                "goals": overlay_page(p, t, "/overlay/goals"),
            })
        }),
        "game_ws_port": state.game_server.port(),
        "service_error": state.service_error.lock().await.clone(),
        "server_url": state.api.base(),
        "forward": {
            "enabled": settings.forward.enabled,
            "forward_url": settings.forward.forward_url,
            "stream_key": settings.forward.stream_key,
            "has_admin_secret": settings.forward.relay_admin_secret.is_some(),
            "roblox_place_id": settings.forward.roblox_place_id,
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
pub async fn billing_checkout(
    plan_code: Option<String>,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    state
        .api
        .checkout(&token(&state).await?, plan_code.as_deref().unwrap_or("pro"))
        .await
        .map_err(|e| e.to_string())
}

/// TEST billing: grants/extends one billing period of `plan_code`.
#[tauri::command]
pub async fn mock_pay(
    plan_code: Option<String>,
    state: State<'_, AppState>,
) -> Result<Subscription, String> {
    state
        .api
        .mock_pay(&token(&state).await?, plan_code.as_deref().unwrap_or("pro"))
        .await
        .map_err(|e| e.to_string())
}

/// `GET /api/plans` — tariff catalog for the pricing table.
#[tauri::command]
pub async fn get_plans(state: State<'_, AppState>) -> Result<Vec<crate::types::Plan>, String> {
    state.api.plans().await.map_err(|e| e.to_string())
}

/// `GET /api/account/entitlements` — effective plan + limits + usage.
/// Falls back to the cached snapshot when the backend is unreachable so
/// the UI never flickers between plans on a network blip.
#[tauri::command]
pub async fn get_entitlements(
    state: State<'_, AppState>,
) -> Result<crate::types::EntitlementsResponse, String> {
    let token = token(&state).await?;
    match state.api.entitlements(&token).await {
        Ok(res) => {
            state.usage.update_from_server(&res).await;
            Ok(res)
        }
        Err(e) => state
            .usage
            .cached_response()
            .await
            .ok_or_else(|| e.to_string()),
    }
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
    let paid_games_allowed = state.usage.entitlements().await.paid_games;

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
            is_free: g.is_free,
            paid_games_allowed,
            kind: g.kind,
            adapter_manifest: g.adapter_manifest,
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
        .verify_license(&token, require_hwid(&state)?, Some(&slug))
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
    // Preset cheat-sheet follows the active profile (§5.2) — resolve the
    // slug before `active_game_slug` consumes it.
    let effective = if slug.is_empty() {
        "default".to_string()
    } else {
        slug.clone()
    };
    *state.active_game_slug.lock().await = if slug.is_empty() { None } else { Some(slug) };
    // Switching the active profile resets runtime cooldowns/accumulators.
    state.scheduler.reset_runtime();
    let profile = {
        let s = state.settings.lock().await;
        s.data
            .trigger_profiles
            .get(&effective)
            .cloned()
            .unwrap_or_else(|| TriggerMapper::default_profile(&effective))
    };
    let _ = state
        .overlay_tx
        .send(crate::overlay::preset_frame(&profile));
    Ok(())
}

/// Plan-limit gate for profile writes (§8.4). Rejects only NET-NEW
/// violations — a downgraded streamer can still edit/save an over-limit
/// profile (runtime executes only the first allowed entries); what they
/// can't do is grow it further. Returns `PLAN_LIMIT|<feature>|<cap>`.
async fn gate_profile_write(state: &AppState, profile: &TriggerProfile) -> Result<(), String> {
    let ent = state.usage.entitlements().await;
    let prev = {
        let s = state.settings.lock().await;
        s.data.trigger_profiles.get(&profile.game_slug).cloned()
    };

    if let Some(max) = ent.max_rules_per_preset {
        let enabled = profile.rules.iter().filter(|r| r.enabled).count() as i64;
        let prev_enabled = prev
            .as_ref()
            .map(|p| p.rules.iter().filter(|r| r.enabled).count() as i64)
            .unwrap_or(0);
        if enabled > max && enabled > prev_enabled {
            return Err(format!("PLAN_LIMIT|max_rules_per_preset|{max}"));
        }
    }

    // Feature usage of a profile: (interrupts, spinner, tts, media count).
    fn usage_of(p: &TriggerProfile) -> (bool, bool, bool, i64) {
        let (mut it, mut sp, mut tt, mut media) = (false, false, false, 0i64);
        for r in p.rules.iter().filter(|r| r.enabled) {
            it |= r.interrupt;
            sp |= r.spinner.is_some();
            tt |= r.tts.is_some();
            if r.image.is_some()
                || r.alert
                    .as_ref()
                    .is_some_and(|a| a.sound.is_some() || a.media.is_some())
            {
                media += 1;
            }
        }
        (it, sp, tt, media)
    }
    let (it, sp, tt, media) = usage_of(profile);
    let (pit, psp, ptt, pmedia) = prev.as_ref().map(usage_of).unwrap_or_default();

    if it && !pit && !ent.interrupts {
        return Err("PLAN_LIMIT|interrupts".into());
    }
    if sp && !psp && !ent.spinner {
        return Err("PLAN_LIMIT|spinner".into());
    }
    if tt && !ptt && !ent.tts {
        return Err("PLAN_LIMIT|tts".into());
    }
    if let Some(max) = ent.max_media_triggers {
        if media > max && media > pmedia {
            return Err(format!("PLAN_LIMIT|max_media_triggers|{max}"));
        }
    }
    if !ent.custom_overlay_style {
        let is_custom = profile.overlay != crate::types::OverlayStyle::default();
        let was_custom = prev
            .as_ref()
            .is_some_and(|p| p.overlay != crate::types::OverlayStyle::default());
        if is_custom && !was_custom {
            return Err("PLAN_LIMIT|custom_overlay_style".into());
        }
    }
    Ok(())
}

/// Persists an edited trigger profile.
#[tauri::command]
pub async fn save_triggers(
    profile: TriggerProfile,
    state: State<'_, AppState>,
) -> Result<(), String> {
    gate_profile_write(&state, &profile).await?;
    let mut s = state.settings.lock().await;
    s.data
        .trigger_profiles
        .insert(profile.game_slug.clone(), profile.clone());
    let _ = s.save();
    drop(s);
    state.scheduler.reset_runtime();
    // Live-update the cheat sheet when the saved profile is on air (§5.2).
    let active = state.active_game_slug.lock().await.clone();
    let on_air = match &active {
        Some(slug) => slug == &profile.game_slug,
        None => profile.game_slug == "default",
    };
    if on_air {
        let _ = state
            .overlay_tx
            .send(crate::overlay::preset_frame(&profile));
    }
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
    let s = state.settings.lock().await;
    let p = TriggerMapper::find_preset(&preset, &s.data.trigger_presets)
        .ok_or_else(|| format!("неизвестный пресет: {preset}"))?;
    let profile = TriggerMapper::profile_from_preset(&game_slug, &p);
    drop(s);
    gate_profile_write(&state, &profile).await?;
    let mut s = state.settings.lock().await;
    s.data
        .trigger_profiles
        .insert(game_slug.clone(), profile.clone());
    let _ = s.save();
    drop(s);
    // Profile switch resets runtime cooldowns/accumulators (§2.2).
    state.scheduler.reset_runtime();
    // Preset cheat-sheet follows the newly applied profile when on air.
    let active = state.active_game_slug.lock().await.clone();
    let on_air = match &active {
        Some(slug) => slug == &game_slug,
        None => game_slug == "default",
    };
    if on_air {
        let _ = state
            .overlay_tx
            .send(crate::overlay::preset_frame(&profile));
    }
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
    // §8.4: new presets count against `max_presets`; editing an existing
    // one is always allowed.
    let ent = state.usage.entitlements().await;
    if let Some(max) = ent.max_presets {
        let s = state.settings.lock().await;
        let exists = s.data.trigger_presets.contains_key(&preset.name);
        let count = s.data.trigger_presets.len() as i64;
        drop(s);
        if !exists && count >= max {
            return Err(format!("PLAN_LIMIT|max_presets|{max}"));
        }
    }
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

/// Spinner pools from settings — the mapper's 🎡 pool picker (§7).
#[tauri::command]
pub async fn list_spinners(state: State<'_, AppState>) -> Result<Vec<SpinnerPool>, String> {
    Ok(state
        .settings
        .lock()
        .await
        .data
        .spinners
        .values()
        .cloned()
        .collect())
}

/// Creates/updates a spinner pool (§7). Validates name, at least one
/// segment and non-empty actions.
#[tauri::command]
pub async fn save_spinner(pool: SpinnerPool, state: State<'_, AppState>) -> Result<(), String> {
    let name = pool.name.trim();
    if name.is_empty() || name.len() > 64 {
        return Err("имя пула: 1–64 символа".into());
    }
    if pool.segments.is_empty() {
        return Err("у колеса должен быть хотя бы один сегмент".into());
    }
    if pool.segments.len() > 64 {
        return Err("максимум 64 сегмента".into());
    }
    if pool.segments.iter().any(|s| s.action.trim().is_empty()) {
        return Err("у каждого сегмента должно быть действие".into());
    }
    if !state.usage.entitlements().await.spinner {
        return Err("PLAN_LIMIT|spinner".into());
    }
    let mut s = state.settings.lock().await;
    s.data.spinners.insert(name.to_string(), pool);
    let _ = s.save();
    Ok(())
}

/// Deletes a spinner pool — refused while rules still reference it
/// (same contract as media deletion).
#[tauri::command]
pub async fn delete_spinner(name: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut s = state.settings.lock().await;
    let users: Vec<String> = s
        .data
        .trigger_profiles
        .iter()
        .flat_map(|(slug, p)| {
            let slug = slug.clone();
            let name = name.clone();
            p.rules
                .iter()
                .filter(move |r| r.spinner.as_deref() == Some(name.as_str()))
                .map(move |r| format!("{slug}: {}", r.display_label()))
                .collect::<Vec<_>>()
        })
        .collect();
    if !users.is_empty() {
        return Err(format!("пул используется в правилах: {}", users.join(", ")));
    }
    s.data.spinners.remove(&name);
    let _ = s.save();
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
        vip: false,
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
        usage_base: 0,
        bypass: true,
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// Misc settings
// ---------------------------------------------------------------------------

/// Alert playback settings for the mapper status bar (§3.1–§3.2):
/// master switch, default-alert coin threshold, default duration,
/// master volume.
#[tauri::command]
pub async fn get_alerts_settings(state: State<'_, AppState>) -> Result<Value, String> {
    let s = state.settings.lock().await;
    let a = &s.data.alerts;
    Ok(json!({
        "enabled": a.enabled,
        "default_for_gifts_from_coins": a.default_for_gifts_from_coins,
        "default_duration_ms": a.default_duration_ms,
        "volume": a.volume,
    }))
}

/// Persists alert playback settings; `enabled` applies to the running
/// scheduler immediately (§3.1 master switch).
#[tauri::command]
pub async fn set_alerts_settings(
    enabled: bool,
    default_for_gifts_from_coins: i64,
    default_duration_ms: u64,
    volume: f32,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut s = state.settings.lock().await;
    s.data.alerts.enabled = enabled;
    s.data.alerts.default_for_gifts_from_coins = default_for_gifts_from_coins.max(0);
    s.data.alerts.default_duration_ms = default_duration_ms.clamp(200, 60_000);
    s.data.alerts.volume = volume.clamp(0.0, 1.0);
    let _ = s.save();
    drop(s);
    state.scheduler.set_alerts_enabled(enabled);
    Ok(())
}

// ---------------------------------------------------------------------------
// Chat-to-speech (§6)
// ---------------------------------------------------------------------------

/// Current TTS settings (§6.2).
#[tauri::command]
pub async fn get_tts_settings(
    state: State<'_, AppState>,
) -> Result<crate::settings::TtsSettings, String> {
    Ok(state.settings.lock().await.data.tts.clone())
}

/// Persists the whole `TtsSettings` block; takes effect from the next
/// dequeued phrase (the queue re-reads settings per job).
#[tauri::command]
pub async fn set_tts_settings(
    tts: crate::settings::TtsSettings,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // §8.4: turning TTS ON needs the entitlement; disabling always works.
    if tts.enabled && !state.usage.entitlements().await.tts {
        return Err("PLAN_LIMIT|tts".into());
    }
    let mut s = state.settings.lock().await;
    s.data.tts = tts;
    let _ = s.save();
    Ok(())
}

/// Installed SAPI voices — cached by the engine after first lookup.
#[tauri::command]
pub async fn tts_voices(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let engine = state.tts.engine();
    tokio::task::spawn_blocking(move || engine.voices())
        .await
        .map_err(|e| e.to_string())
}

/// Test phrase from the TTS page — bypasses `read_*` modes and
/// cooldowns, still obeys mute/filters.
#[tauri::command]
pub async fn tts_say(
    text: String,
    voice: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err("пустая фраза".into());
    }
    state.tts.speak_rule("streamer".into(), text, voice);
    Ok(())
}

/// Mute/unmute (§6.3) — muting kills the running synthesis and drains
/// the queue instantly. Also emits `tts-muted` for the UI.
#[tauri::command]
pub async fn tts_set_muted(
    muted: bool,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    state.tts.set_muted(muted);
    let _ = app.emit("tts-muted", muted);
    Ok(())
}

/// Current mute flag — the hotkey path flips it without a command.
#[tauri::command]
pub async fn get_tts_muted(state: State<'_, AppState>) -> Result<bool, String> {
    Ok(state.tts.is_muted())
}

// ---------------------------------------------------------------------------
// Media library (§4.1)
// ---------------------------------------------------------------------------

/// All indexed media items (files live in `<app-data>/media/`).
#[tauri::command]
pub async fn media_list(
    state: State<'_, AppState>,
) -> Result<Vec<crate::types::MediaItem>, String> {
    Ok(state.settings.lock().await.data.media.clone())
}

/// Imports a file into the media library (magic-byte sniffed, §4.1
/// limits enforced). `path` comes from the tauri dialog plugin.
#[tauri::command]
pub async fn media_import(
    path: String,
    state: State<'_, AppState>,
) -> Result<crate::types::MediaItem, String> {
    let dir = crate::media::media_dir(&state.data_dir);
    let mut s = state.settings.lock().await;
    let used: u64 = s.data.media.iter().map(|m| m.size).sum();
    let item = crate::media::import(&dir, std::path::Path::new(&path), "", used).await?;
    s.data.media.push(item.clone());
    let _ = s.save();
    Ok(item)
}

/// Deletes a media item — refused while any rule still references it
/// (returns the list of referencing rules).
#[tauri::command]
pub async fn media_delete(id: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut s = state.settings.lock().await;
    let refs = crate::media::usages(&id, &s.data);
    if !refs.is_empty() {
        return Err(format!(
            "файл используется правилами — уберите его оттуда:\n{}",
            refs.join("\n")
        ));
    }
    let Some(pos) = s.data.media.iter().position(|m| m.id == id) else {
        return Err("медиа не найдено".into());
    };
    let item = s.data.media.remove(pos);
    let _ = s.save();
    let dir = crate::media::media_dir(&state.data_dir);
    let _ = crate::media::delete(&dir, &item).await;
    Ok(())
}

/// Renames a media item (display name only).
#[tauri::command]
pub async fn media_rename(
    id: String,
    name: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("имя пустое".into());
    }
    let mut s = state.settings.lock().await;
    let Some(m) = s.data.media.iter_mut().find(|m| m.id == id) else {
        return Err("медиа не найдено".into());
    };
    m.name = name;
    let _ = s.save();
    Ok(())
}

/// Pins the overlay server to a fixed port (§5.4). `0` = OS-assigned.
/// The server binds at startup only, so the change applies on the next
/// launch — the UI warns accordingly.
#[tauri::command]
pub async fn set_overlay_port(port: u16, state: State<'_, AppState>) -> Result<(), String> {
    if port != 0 && port < 1024 {
        return Err("Порт должен быть 0 (авто) или ≥1024".into());
    }
    let mut s = state.settings.lock().await;
    s.data.overlay_port = port;
    let _ = s.save();
    Ok(())
}

/// Rotates the overlay access token — every `/overlay*` URL changes and
/// previously copied Browser Source URLs stop working (§5.4). The new
/// value is pushed into the overlay server's shared cell too — without
/// that the server would keep accepting the OLD token (and reject the
/// new one the UI already shows).
#[tauri::command]
pub async fn rotate_overlay_token(state: State<'_, AppState>) -> Result<(), String> {
    // Same 64-hex shape `SettingsStore::load` generates on first launch.
    let new_token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let mut s = state.settings.lock().await;
    s.data.overlay_token = new_token.clone();
    let _ = s.save();
    if let Ok(mut t) = state.overlay_token.write() {
        *t = new_token;
    }
    Ok(())
}

/// Overlay pages that may be hosted in a capture window — kept in sync
/// with the routes in `overlay.rs`. Whitelisting prevents the command
/// from opening arbitrary local URLs in a privileged webview.
const OVERLAY_WINDOW_PAGES: &[&str] = &[
    "overlay",
    "overlay/alerts",
    "overlay/preset",
    "overlay/spinner",
    "overlay/tts",
    "overlay/progress",
    "overlay/leaderboard",
    "overlay/goals",
];

/// Opens (or focuses) a transparent always-on-top window hosting one of
/// the local overlay pages. TikTok LIVE Studio has no Browser Source —
/// the streamer captures THIS window via Window/Game capture. `chroma`
/// requests a solid magenta background inside the page (`?bg=ff00ff`)
/// for chroma-key filters instead of real transparency.
#[tauri::command]
pub async fn open_overlay_window(
    page: String,
    chroma: bool,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if !OVERLAY_WINDOW_PAGES.contains(&page.as_str()) {
        return Err("UNKNOWN_OVERLAY_PAGE".into());
    }
    let port = (*state.overlay_port.lock().await)
        .ok_or("Оверлей-сервер не запущен — см. ошибку сервиса")?;
    let token = state
        .overlay_token
        .read()
        .map(|t| t.clone())
        .unwrap_or_default();
    let label = format!("overlay-{}", page.replace('/', "-"));
    let mut url = format!("http://127.0.0.1:{port}/{page}?t={token}");
    if chroma {
        url.push_str("&bg=ff00ff");
    }
    if let Some(w) = app.get_webview_window(&label) {
        // Re-opening a live window: navigate to the freshest URL (token
        // or chroma mode may have changed since it was created), keep its
        // geometry and focus it.
        let js = format!("location.href = {}", serde_json::json!(url));
        let _ = w.eval(&js);
        let _ = w.set_focus();
        return Ok(());
    }
    let url = url.parse::<tauri::Url>().map_err(|e| e.to_string())?;
    tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::External(url))
        .title(format!("chlauncher — {page}"))
        .inner_size(420.0, 640.0)
        .resizable(true)
        .decorations(false)
        .transparent(!chroma)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(true)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Closes a capture window previously opened by `open_overlay_window`.
#[tauri::command]
pub async fn close_overlay_window(page: String, app: AppHandle) -> Result<(), String> {
    if !OVERLAY_WINDOW_PAGES.contains(&page.as_str()) {
        return Err("UNKNOWN_OVERLAY_PAGE".into());
    }
    let label = format!("overlay-{}", page.replace('/', "-"));
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.close();
    }
    Ok(())
}

/// Stream goals: live progress (`goals`) + the stored definitions
/// (`defs`) the editor round-trips.
#[tauri::command]
pub async fn get_goals(state: State<'_, AppState>) -> Result<Value, String> {
    let defs = state.settings.lock().await.data.goals.clone();
    Ok(json!({
        "goals": state.goals.snapshot().await,
        "defs": defs,
    }))
}

/// Replaces the whole goal list (UI edits locally then saves). Caps at
/// 20 goals — enough bars for one stream, keeps the overlay readable.
#[tauri::command]
pub async fn save_goals(
    mut goals: Vec<crate::types::StreamGoal>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if goals.len() > 20 {
        return Err("Не больше 20 целей".into());
    }
    for g in goals.iter_mut() {
        g.label = g.label.trim().chars().take(80).collect();
        if g.id.is_empty() {
            g.id = uuid::Uuid::new_v4().to_string();
        }
        g.target = g.target.clamp(0, 1_000_000_000);
    }
    let mut s = state.settings.lock().await;
    s.data.goals = goals;
    s.save().map_err(|e| e.to_string())?;
    Ok(())
}

/// Zeroes all goal counters and re-arms completed goals («новый стрим»).
#[tauri::command]
pub async fn reset_goals(state: State<'_, AppState>) -> Result<(), String> {
    state.goals.reset().await;
    Ok(())
}

/// Starts a chat poll — viewers vote by typing the option number.
/// Replaces any poll already running (its votes are discarded).
#[tauri::command]
pub async fn poll_start(
    cfg: crate::polls::PollConfig,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.polls.start(cfg).await
}

/// Ends the running poll: announces the winner and injects the poll
/// event into the ingest pipeline.
#[tauri::command]
pub async fn poll_stop(state: State<'_, AppState>) -> Result<(), String> {
    state.polls.stop().await
}

/// Live poll status for the UI card (running/options/counts/timer).
#[tauri::command]
pub async fn poll_status(state: State<'_, AppState>) -> Result<Value, String> {
    Ok(json!(state.polls.status().await))
}

/// Starts (or restarts) the subathon countdown for N seconds.
#[tauri::command]
pub async fn subathon_start(dur_s: u64, state: State<'_, AppState>) -> Result<(), String> {
    state.subathon.start(dur_s).await;
    Ok(())
}

/// Stops the countdown without firing the end alert.
#[tauri::command]
pub async fn subathon_stop(state: State<'_, AppState>) -> Result<(), String> {
    state.subathon.stop().await;
    Ok(())
}

/// Live subathon status (remaining/added seconds + rates).
#[tauri::command]
pub async fn subathon_status(state: State<'_, AppState>) -> Result<Value, String> {
    Ok(json!(state.subathon.status().await))
}

/// Saves the subathon rate knobs (sec/coin, sec/sub, cap).
#[tauri::command]
pub async fn save_subathon_cfg(
    cfg: crate::types::SubathonCfg,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut s = state.settings.lock().await;
    s.data.subathon = cfg;
    s.save().map_err(|e| e.to_string())
}

/// Pulls the next viewer from the queue - announces them and injects
/// the queue event into the ingest pipeline.
#[tauri::command]
pub async fn queue_next(state: State<'_, AppState>) -> Result<Value, String> {
    let user = state.queue.next().await?;
    Ok(json!({ "user": user }))
}

/// Queue snapshot (open flag + ordered viewers + last called).
#[tauri::command]
pub async fn queue_status(state: State<'_, AppState>) -> Result<Value, String> {
    Ok(json!(state.queue.status().await))
}

/// Opens or closes join-commands.
#[tauri::command]
pub async fn queue_set_open(open: bool, state: State<'_, AppState>) -> Result<(), String> {
    state.queue.set_open(open).await;
    Ok(())
}

/// Empties the queue.
#[tauri::command]
pub async fn queue_clear(state: State<'_, AppState>) -> Result<(), String> {
    state.queue.clear().await;
    Ok(())
}

/// Live hype-meter status (coins in window + 0-100 level).
#[tauri::command]
pub async fn hype_status(state: State<'_, AppState>) -> Result<Value, String> {
    Ok(json!(state.hype.status().await))
}

/// Saves the hype-meter knobs (window seconds + 100% target).
#[tauri::command]
pub async fn save_hype_cfg(
    cfg: crate::types::HypeCfg,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut s = state.settings.lock().await;
    s.data.hype = cfg;
    s.save().map_err(|e| e.to_string())
}

/// Timed auto-events list (id/label/interval/enabled).
#[tauri::command]
pub async fn get_timed_events(state: State<'_, AppState>) -> Result<Value, String> {
    Ok(json!(state.settings.lock().await.data.timed_events))
}

/// Replaces the timed-event list (UI edits locally then saves).
#[tauri::command]
pub async fn save_timed_events(
    mut events: Vec<crate::types::TimedEvent>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if events.len() > 20 {
        return Err("Не больше 20 автособытий".into());
    }
    for e in events.iter_mut() {
        e.label = e.label.trim().chars().take(120).collect();
        if e.id.is_empty() {
            e.id = uuid::Uuid::new_v4().to_string();
        }
        e.interval_min = e.interval_min.clamp(1, 24 * 60);
    }
    let mut s = state.settings.lock().await;
    s.data.timed_events = events;
    s.save().map_err(|e| e.to_string())
}

/// Top-N viewers by points balance (leaderboard in the card).
#[tauri::command]
pub async fn points_top(state: State<'_, AppState>) -> Result<Value, String> {
    Ok(json!(state.points.top(50).await))
}

/// One viewer's balance.
#[tauri::command]
pub async fn points_balance(user: String, state: State<'_, AppState>) -> Result<Value, String> {
    Ok(json!({ "points": state.points.balance(&user).await }))
}

/// Admin adjust: +N grants, -N takes (floored at 0).
#[tauri::command]
pub async fn points_adjust(
    user: String,
    delta: i64,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .points
        .adjust(&user, delta.clamp(-1_000_000, 1_000_000))
        .await;
    Ok(())
}

/// Current earn-rate knobs (for the card's initial render).
#[tauri::command]
pub async fn get_points_cfg(state: State<'_, AppState>) -> Result<Value, String> {
    Ok(json!(state.settings.lock().await.data.points))
}

/// Saves the earn-rate knobs (per_comment/per_coin/sub/follow).
#[tauri::command]
pub async fn save_points_cfg(
    cfg: crate::types::PointsCfg,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut s = state.settings.lock().await;
    s.data.points = cfg;
    s.save().map_err(|e| e.to_string())
}

/// Soundboard: plays a media-library sound through the alerts overlay —
/// the capture window makes it audible on stream (LIVE Studio/OBS).
#[tauri::command]
pub async fn soundboard_play(id: String, state: State<'_, AppState>) -> Result<(), String> {
    if id.len() != 32
        || !id
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
    {
        return Err("Некорректный id медиа".into());
    }
    let item = state
        .settings
        .lock()
        .await
        .data
        .media
        .iter()
        .find(|m| m.id == id)
        .cloned()
        .ok_or_else(|| "Файл не найден".to_string())?;
    if item.kind != "audio" {
        return Err("Саундборд играет только аудиофайлы".into());
    }
    let _ = state.overlay_tx.send(OverlayFrame::Alert {
        id: format!("sb-{id}-{}", crate::types::now_ms()),
        text: item.name,
        duration_ms: 1500,
        sound: Some(FrameSound {
            url: format!("/media/{id}"),
            volume: 1.0,
        }),
        media: None,
        position: "top".into(),
        style: "soundboard".into(),
        user: String::new(),
    });
    Ok(())
}

/// `!buy` shop items list.
#[tauri::command]
pub async fn get_shop_items(state: State<'_, AppState>) -> Result<Value, String> {
    Ok(json!(state.settings.lock().await.data.shop_items))
}

/// Replaces the shop list (UI edits locally then saves).
#[tauri::command]
pub async fn save_shop_items(
    mut items: Vec<crate::types::ShopItem>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if items.len() > 50 {
        return Err("Не больше 50 товаров".into());
    }
    for i in items.iter_mut() {
        i.name = i.name.trim().chars().take(40).collect();
        i.hint = i.hint.trim().chars().take(120).collect();
        if i.id.is_empty() {
            i.id = uuid::Uuid::new_v4().to_string();
        }
        i.price = i.price.min(1_000_000_000);
    }
    let mut s = state.settings.lock().await;
    s.data.shop_items = items;
    s.save().map_err(|e| e.to_string())
}

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

/// Saves the Roblox place ID used by `roblox_launch`.
#[tauri::command]
pub async fn set_roblox_place_id(
    place_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let id = place_id.trim().to_string();
    if !id.is_empty() && !id.chars().all(|c| c.is_ascii_digit()) {
        return Err("Place ID — только цифры".into());
    }
    let mut s = state.settings.lock().await;
    s.data.forward.roblox_place_id = if id.is_empty() { None } else { Some(id) };
    let _ = s.save();
    Ok(())
}

/// Launches the Roblox client straight into the configured experience via
/// the `roblox://` deep link — the room server spins up in Roblox cloud and
/// claims the stream by the stream_key.
#[tauri::command]
pub async fn roblox_launch(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let place_id = state
        .settings
        .lock()
        .await
        .data
        .forward
        .roblox_place_id
        .clone()
        .ok_or("Укажите Place ID игры")?;
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(
            format!("roblox://experiences/start?placeId={place_id}"),
            None::<&str>,
        )
        .map_err(|e| format!("не удалось запустить Roblox: {e}"))
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

/// Switches a user's plan code (§8.3) — expiry untouched.
#[tauri::command]
pub async fn admin_set_plan(
    user_id: i64,
    plan_code: String,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    state
        .api
        .admin_json(
            Method::POST,
            &format!("/api/admin/users/{user_id}/set-plan"),
            &token(&state).await?,
            Some(json!({"plan_code": plan_code})),
        )
        .await
        .map_err(|e| e.to_string())
}

/// All tariff plans incl. inactive (admin CRUD list).
#[tauri::command]
pub async fn admin_list_plans(state: State<'_, AppState>) -> Result<Value, String> {
    state
        .api
        .admin_json(Method::GET, "/api/admin/plans", &token(&state).await?, None)
        .await
        .map_err(|e| e.to_string())
}

/// Creates a tariff plan; `entitlements` is a raw JSON object.
#[tauri::command]
pub async fn admin_create_plan(plan: Value, state: State<'_, AppState>) -> Result<Value, String> {
    state
        .api
        .admin_json(
            Method::POST,
            "/api/admin/plans",
            &token(&state).await?,
            Some(plan),
        )
        .await
        .map_err(|e| e.to_string())
}

/// Partial plan update (title/price/entitlements/active/sort).
#[tauri::command]
pub async fn admin_update_plan(
    code: String,
    patch: Value,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    state
        .api
        .admin_json(
            Method::PATCH,
            &format!("/api/admin/plans/{code}"),
            &token(&state).await?,
            Some(patch),
        )
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

// ---------------------------------------------------------------------------
// Managed Minecraft (Paper) server — parity spec §9.3
// ---------------------------------------------------------------------------

/// Status snapshot: install state, running flag, settings, log tail.
/// Never includes the RCON password — it never leaves the Rust side.
#[tauri::command]
pub async fn mc_status(state: State<'_, AppState>) -> Result<Value, String> {
    Ok(state.mc.status().await)
}

/// Explicit EULA consent — the only writer of `eula=true`. The UI links
/// to https://www.minecraft.net/eula next to the checkbox.
#[tauri::command]
pub async fn mc_accept_eula(state: State<'_, AppState>) -> Result<(), String> {
    state.mc.accept_eula().await
}

/// Downloads Java (when missing) + Paper jar, writes server.properties.
/// Progress lines stream via the `mc-log` event — takes a minute.
#[tauri::command]
pub async fn mc_install(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    state.mc.install(&app).await
}

#[tauri::command]
pub async fn mc_start(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    state.mc.start(&app).await
}

/// RCON `stop`, force-kill after the 30 s grace period.
#[tauri::command]
pub async fn mc_stop(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    state.mc.stop(&app).await
}

/// Sends one console command through RCON (the server's own console —
/// the streamer types `say hi`, `give …`). Multi-line input is split
/// into sequential commands; template sanitization does NOT apply here
/// (this is the owner's own input, like typing at the real console).
#[tauri::command]
pub async fn mc_console(cmd: String, state: State<'_, AppState>) -> Result<String, String> {
    let cmd = cmd.trim();
    if cmd.is_empty() || cmd.len() > 500 {
        return Err("MC_CMD_INVALID".into());
    }
    let mut last = String::new();
    for line in cmd.lines().map(str::trim).filter(|l| !l.is_empty()) {
        last = state.mc.console(line).await?;
    }
    Ok(last)
}

/// Replays the log ring — the page polls this after the initial status
/// snapshot; `since` is the number of lines already shown.
#[tauri::command]
pub async fn mc_logs(since: u32, state: State<'_, AppState>) -> Result<Value, String> {
    let status = state.mc.status().await;
    let tail = status
        .get("log_tail")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let skip = (since as usize).min(tail.len());
    Ok(serde_json::json!({
        "total": tail.len(),
        "lines": tail[skip..],
    }))
}

/// Editable server settings (§9.2): RAM, MC version, online-mode,
/// player name used by `{player}` templates. RCON port/password are
/// managed internally and not settable here.
#[tauri::command]
pub async fn mc_set_settings(
    ram_mb: Option<u32>,
    mc_version: Option<String>,
    online_mode: Option<bool>,
    player: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut s = state.settings.lock().await;
    if let Some(ram) = ram_mb {
        s.data.mc.ram_mb = ram.clamp(1024, 32768);
    }
    if let Some(v) = mc_version {
        let v = v.trim().to_string();
        // The version lands in a Fill-API URL path segment later — keep
        // it to the version-string charset (same rule install.rs enforces).
        if v.is_empty()
            || (v.len() <= 32
                && v.chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_')))
        {
            s.data.mc.mc_version = v;
        }
    }
    if let Some(m) = online_mode {
        s.data.mc.online_mode = m;
        // Keep the live properties file in sync for the next start.
        if s.data.mc.eula_accepted {
            let _ = crate::minecraft::install::write_server_properties(
                &state.mc.dir.join("server"),
                s.data.mc.rcon_port,
                &s.data.mc.rcon_password,
                m,
            );
        }
    }
    if let Some(p) = player {
        // Same rules as the {player} template placeholder.
        let p = crate::minecraft::templates::sanitize_player(&p);
        if !p.is_empty() {
            s.data.mc.player = p;
        }
    }
    let _ = s.save();
    Ok(())
}

/// Deletes `world*` dirs (stopped server only) — fresh map on next start.
#[tauri::command]
pub async fn mc_world_reset(state: State<'_, AppState>) -> Result<(), String> {
    state.mc.world_reset().await
}

/// Zips `world*` into `minecraft/backups/` — returns the archive name.
#[tauri::command]
pub async fn mc_world_backup(state: State<'_, AppState>) -> Result<String, String> {
    state.mc.world_backup().await
}

// ---------------------------------------------------------------------------
// Minecraft plugin catalog (§9.4)
// ---------------------------------------------------------------------------

/// Server catalog merged with locally-installed jar names — the page
/// renders premium badges, "installed" state and per-plan availability.
#[tauri::command]
pub async fn mc_plugin_catalog(state: State<'_, AppState>) -> Result<Value, String> {
    let token = state
        .settings
        .lock()
        .await
        .data
        .auth_token
        .clone()
        .ok_or("AUTH_REQUIRED")?;
    let catalog = state
        .api
        .mc_plugins(&token)
        .await
        .map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "catalog": catalog,
        "installed": state.mc.installed_plugins(),
        "premium_allowed": state.usage.entitlements().await.mc_premium_plugins,
    }))
}

/// Downloads + sha256-verifies a catalog plugin into `server/plugins/`.
/// Premium rows are gated both here (defense in depth — the server also
/// refuses the download) and in the UI. Installed jars load on the next
/// server start; `mc_status` tells the UI whether a restart is needed.
#[tauri::command]
pub async fn mc_install_plugin(slug: String, state: State<'_, AppState>) -> Result<(), String> {
    let token = state
        .settings
        .lock()
        .await
        .data
        .auth_token
        .clone()
        .ok_or("AUTH_REQUIRED")?;
    let catalog = state
        .api
        .mc_plugins(&token)
        .await
        .map_err(|e| e.to_string())?;
    let plugin = catalog
        .iter()
        .find(|p| p.slug == slug)
        .ok_or("PLUGIN_NOT_FOUND")?;
    if plugin.premium && !state.usage.entitlements().await.mc_premium_plugins {
        return Err("PLAN_LIMIT|mc_premium_plugins".into());
    }
    // slug/version become the local jar filename — keep both inside the
    // catalog charset so a hostile/broken catalog row can't escape
    // `server/plugins/` (defense in depth; the server validates too).
    let ok_name = |s: &str| {
        !s.is_empty()
            && s.len() <= 64
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
            && !s.contains("..")
    };
    if !ok_name(&plugin.slug) || !ok_name(&plugin.version) {
        return Err("PLUGIN_NAME_INVALID".into());
    }
    let dir = state.mc.plugins_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let dest = dir.join(format!("{}-{}.jar", plugin.slug, plugin.version));
    let got = state
        .api
        .download_mc_plugin(&token, &plugin.slug, &dest)
        .await
        .map_err(|e| e.to_string())?;
    if !got.eq_ignore_ascii_case(&plugin.sha256) {
        let _ = std::fs::remove_file(&dest);
        return Err("PLUGIN_HASH_MISMATCH".into());
    }
    Ok(())
}

/// Removes an installed jar by file name (server-side path-validated).
#[tauri::command]
pub async fn mc_remove_plugin(file: String, state: State<'_, AppState>) -> Result<(), String> {
    state.mc.remove_plugin(&file)
}

// ---------------------------------------------------------------------------
// External game adapters — mods connecting to the local game WS (§10.1)
// ---------------------------------------------------------------------------

/// Status of the adapter endpoint: the shared key (generated on first
/// call), the WS port to dial, and which adapters are connected now.
#[tauri::command]
pub async fn adapter_status(state: State<'_, AppState>) -> Result<Value, String> {
    let key = {
        let mut s = state.settings.lock().await;
        if s.data.adapter_key.is_empty() {
            s.data.adapter_key = uuid::Uuid::new_v4().to_string();
            let _ = s.save();
        }
        *state.adapter_key.write().map_err(|_| "LOCK")? = s.data.adapter_key.clone();
        s.data.adapter_key.clone()
    };
    Ok(serde_json::json!({
        "key": key,
        "port": state.game_server.port(),
        "connected": state.game_server.connected_adapters().await,
    }))
}

/// Rotates the adapter key: connected mods are force-disconnected and
/// must reconnect with the new key (§10.1 revocation).
#[tauri::command]
pub async fn regenerate_adapter_key(state: State<'_, AppState>) -> Result<String, String> {
    let key = uuid::Uuid::new_v4().to_string();
    {
        let mut s = state.settings.lock().await;
        s.data.adapter_key = key.clone();
        let _ = s.save();
    }
    *state.adapter_key.write().map_err(|_| "LOCK")? = key.clone();
    state.game_server.disconnect_adapters().await;
    Ok(key)
}
