//! Browser overlay server — `http://127.0.0.1:<port>`.
//!
//! TikTok Live Studio / OBS consume the pages as Browser Sources:
//!
//! | Route               | Purpose |
//! |---------------------|---------|
//! | `/overlay`          | Legacy all-in-one (feed + top + banner) |
//! | `/overlay/alerts`   | Alert cards — text/sound/media (spec §3–§4) |
//! | `/overlay/preset`   | Live preset cheat sheet (§5.2) |
//! | `/overlay/spinner`  | Gift-spinner wheel (§7) |
//! | `/overlay/tts`      | TTS badge + subtitle (§6) |
//! | `/overlay/progress` | Accumulator progress bars (§2.3) |
//! | `/gifts/<file>`     | Bundled gift icons (webp) |
//! | `/ws`               | Shared socket — `subscribe` picks channels (§5.3) |
//!
//! All routes require `?t=<overlay_token>` (§5.4): the pages hold
//! streamer-facing data, and loopback is still readable by other local
//! processes. The token is generated on first launch and shown only in
//! the launcher UI's copy-buttons.
//!
//! Pages are embedded via `include_str!` — zero file deps, no CDN.

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, Query, State,
    },
    http::StatusCode,
    response::{Html, IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use tauri::Manager;
use tokio::net::TcpListener;
use tokio::sync::broadcast;

use crate::events::EventHub;
use crate::settings::SettingsStore;
use crate::types::{OverlayFrame, PresetRow, RawStreamEvent, StreamEvent, TriggerProfile};

/// Overlay frame channels — the `subscribe` vocabulary (§5.3).
const CH_EVENTS: &str = "events";
const CH_ALERTS: &str = "alerts";
const CH_PRESET: &str = "preset";
const CH_SPINNER: &str = "spinner";
const CH_TTS: &str = "tts";
const CH_PROGRESS: &str = "progress";
/// Raw ingest events for built-in game pages (`/overlay/game/<id>`).
const CH_GAME: &str = "game";
/// Raw (pre-mapper) events — the widget library subscribes to this so
/// chat/likes widgets work even without trigger rules.
const CH_RAW: &str = "raw";
/// EFIR timer frames — tick/alert/spin/bonus envelopes for efir* widgets.
const CH_TIMER: &str = "timer";

/// Maps an overlay frame to its channel name.
fn frame_channel(f: &OverlayFrame) -> &'static str {
    match f {
        OverlayFrame::Alert { .. }
        | OverlayFrame::AlertCancel { .. }
        | OverlayFrame::Takeover { .. } => CH_ALERTS,
        OverlayFrame::Preset { .. } => CH_PRESET,
        OverlayFrame::Spinner { .. } => CH_SPINNER,
        OverlayFrame::Tts { .. } => CH_TTS,
        OverlayFrame::Progress { .. } => CH_PROGRESS,
    }
}

/// Shared state for every overlay route/socket.
#[derive(Clone)]
struct OverlayState {
    hub: Arc<EventHub>,
    /// Broadcast of scheduler overlay frames (alerts/spinner/progress…).
    frames: broadcast::Sender<OverlayFrame>,
    /// Access token — every route requires `?t=` matching this. Shared
    /// with `AppState` so `rotate_overlay_token` takes effect instantly
    /// (a static copy would keep accepting the old token while the UI
    /// already shows the new one — the rotation would be inverted).
    token: Arc<std::sync::RwLock<String>>,
    /// Directory with bundled gift icons (`*.webp` + `gifts.json`).
    gifts_dir: Option<PathBuf>,
    /// `<app-data>/media` — files behind `/media/:id` (§4.1).
    media_dir: PathBuf,
    /// Media index lives in settings — resolving `:id` → file needs it.
    settings: Arc<tokio::sync::Mutex<SettingsStore>>,
    /// Last frame per channel — replayed to late-joining subscribers so a
    /// newly opened preset/progress page isn't blank until the next event.
    last_frames: Arc<Mutex<HashMap<&'static str, OverlayFrame>>>,
    /// Synthesized TTS WAVs for `output = "overlay"` (`/tts/<id>.wav`, §6).
    wavs: crate::tts::WavStore,
    /// Stream-goal counters for `/goals.json` + `/overlay/goals`.
    goals: Arc<crate::goals::GoalTracker>,
    /// Chat-poll state for `/poll.json` + `/overlay/poll`.
    polls: Arc<crate::polls::PollTracker>,
    /// Subathon countdown for `/subathon.json` + `/overlay/subathon`.
    subathon: Arc<crate::subathon::Subathon>,
    /// Viewer queue for `/queue.json` + `/overlay/queue`.
    queue: Arc<crate::queue::ViewerQueue>,
    /// Hype meter for `/hype.json` + `/overlay/hype`.
    hype: Arc<crate::hype::HypeTracker>,
    /// Raw ingest events re-broadcast by the mapper — the `game` WS
    /// channel streams them to built-in game pages.
    game_events: broadcast::Sender<crate::types::RawStreamEvent>,
    /// Built-in game sessions/results — `/games/state.json` + `/games/report`.
    games: Arc<crate::builtin_games::BuiltinGames>,
    /// Raw event broadcast — forwarded to `/ws` clients subscribed to
    /// the `raw` channel (widget library).
    raw: broadcast::Sender<RawStreamEvent>,
    /// EFIR timer JSON frames: tick/alert/spin/bonus_roll/settings.
    timer: broadcast::Sender<serde_json::Value>,
    /// Engine handle — snapshot replays state+cfg to late subscribers.
    efirtimer: Arc<crate::efirtimer::EfirTimer>,
    /// Editable widget library directory (`public/widgets`), served at
    /// `/widgets/<path>` — files are NOT embedded so they can be
    /// customised without rebuilding the launcher.
    widgets_dir: Option<PathBuf>,
    /// Game asset packs (`public/games/<pack>` — sprites/sfx/skin.json),
    /// served at `/games-assets/<path>`; also disk-based so skins can be
    /// dropped in without a rebuild.
    games_dir: Option<PathBuf>,
    /// User drop-in game packs root (`<app-data>/games`) — second lookup
    /// for `/games-assets` and the `/overlay/game/{id}` dynamic route.
    user_games_dir: PathBuf,
    /// App data dir — pack scanning + `cfg_for` need it.
    data_dir: PathBuf,
    /// TTS queue — `/tts/say` lets game pages voice donor names through
    /// the streamer's configured TTS output.
    tts: Arc<crate::tts::Tts>,
    /// Lets `/overlay-close` shut frameless capture windows — the Escape
    /// handler injected into them can only reach the app through HTTP.
    app_handle: tauri::AppHandle,
}

/// Query-param extractor shared by all guarded routes.
type Token = Query<HashMap<String, String>>;

/// `?t=` matches the *current* token — read under the shared lock so a
/// rotation flips every route at once.
fn check_token(q: &Token, st: &OverlayState) -> bool {
    token_ok(q.0.get("t").map(String::as_str), &st.token)
}

/// Raw comparison helper — takes the shared token cell directly so it
/// stays testable without constructing a whole `OverlayState`.
fn token_ok(given: Option<&str>, token: &std::sync::RwLock<String>) -> bool {
    match (given, token.read()) {
        (Some(g), Ok(exp)) => g == exp.as_str(),
        _ => false,
    }
}

/// URL the Browser Source should consume, given the bound port + token.
pub fn overlay_url(port: u16, token: &str) -> String {
    format!("http://127.0.0.1:{port}/overlay?t={token}")
}

/// Base URL for building page links in the UI (token already appended).
pub fn overlay_page(port: u16, token: &str, path: &str) -> String {
    format!("http://127.0.0.1:{port}{path}?t={token}")
}

/// Locates the bundled gift-icon directory (`public/gifts`). Order:
/// env override → `resources/gifts` beside the exe (bundled builds) →
/// the dev path `<manifest>/../public/gifts`.
fn gifts_dir() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("CHLAUNCHER_GIFTS_DIR") {
        let p = PathBuf::from(p);
        if p.is_dir() {
            return Some(p);
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(d) = exe.parent() {
            let p = d.join("resources").join("gifts");
            if p.is_dir() {
                return Some(p);
            }
        }
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("public")
        .join("gifts");
    dev.is_dir().then_some(dev)
}

/// Cached name → icon-file index parsed once from `gifts.json`.
fn gift_index() -> &'static HashMap<String, String> {
    static INDEX: OnceLock<HashMap<String, String>> = OnceLock::new();
    INDEX.get_or_init(|| {
        let mut m = HashMap::new();
        let Some(dir) = gifts_dir() else {
            return m;
        };
        let path = dir.join("gifts.json");
        let Ok(text) = std::fs::read_to_string(&path) else {
            return m;
        };
        let Ok(rows) = serde_json::from_str::<Vec<serde_json::Value>>(&text) else {
            return m;
        };
        for r in rows {
            if let (Some(name), Some(img)) = (r["name"].as_str(), r["image"].as_str()) {
                m.insert(name.to_lowercase(), img.to_string());
            }
        }
        m
    })
}

/// Resolves a gift name to its icon URL — exact first, then substring
/// (mirrors `src/lib/gifts.ts`). Catalog `image` already carries the
/// `gifts/` prefix, so the URL is a plain `/{img}`.
fn gift_icon(name: &str) -> Option<String> {
    if name.len() < 3 {
        return None;
    }
    let idx = gift_index();
    let key = name.to_lowercase();
    if let Some(img) = idx.get(&key) {
        return Some(format!("/{img}"));
    }
    idx.iter()
        .find(|(k, _)| key.contains(k.as_str()) || k.contains(key.as_str()))
        .map(|(_, img)| format!("/{img}"))
}

/// Coin price lookup for the preset rows — same index, coins column.
fn gift_coins(name: &str) -> i64 {
    static PRICES: OnceLock<HashMap<String, i64>> = OnceLock::new();
    let prices = PRICES.get_or_init(|| {
        let mut m = HashMap::new();
        let Some(dir) = gifts_dir() else {
            return m;
        };
        let Ok(text) = std::fs::read_to_string(dir.join("gifts.json")) else {
            return m;
        };
        if let Ok(rows) = serde_json::from_str::<Vec<serde_json::Value>>(&text) {
            for r in rows {
                if let (Some(name), Some(coins)) = (r["name"].as_str(), r["coins"].as_i64()) {
                    m.insert(name.to_lowercase(), coins);
                }
            }
        }
        m
    });
    prices.get(&name.to_lowercase()).copied().unwrap_or(0)
}

/// Builds the `preset` overlay frame for a profile — the cheat sheet
/// rows (/overlay/preset live-updates on these, §5.2).
pub fn preset_frame(profile: &TriggerProfile) -> OverlayFrame {
    let rows = profile
        .rules
        .iter()
        .filter(|r| r.enabled && !(r.action.is_empty() && r.label.is_empty()))
        .map(|r| PresetRow {
            gift: if r.match_value.is_empty() {
                r.event_kind.clone()
            } else {
                r.match_value.clone()
            },
            gift_image: if r.event_kind == "gift" {
                gift_icon(&r.match_value)
            } else {
                None
            },
            count: if r.every_n > 0 { r.every_n as i32 } else { 1 },
            coins: gift_coins(&r.match_value),
            label: if r.label.is_empty() {
                r.action.clone()
            } else {
                r.label.clone()
            },
            image: r.image.as_ref().map(|m| format!("/media/{}", m.id)),
        })
        .collect();
    OverlayFrame::Preset {
        name: profile
            .preset
            .clone()
            .unwrap_or_else(|| profile.game_slug.clone()),
        style: profile.overlay.clone(),
        rows,
    }
}

/// Starts the overlay server. `port_cfg` pins the port when > 0 (§5.4 —
/// a stable Browser Source URL); on a bind failure the server falls back
/// to an OS-assigned port and reports the fallback so the UI can warn.
/// Returns (actual port, fell_back).
pub async fn start_overlay_server(
    hub: Arc<EventHub>,
    frames: broadcast::Sender<OverlayFrame>,
    token: Arc<std::sync::RwLock<String>>,
    port_cfg: u16,
    media_dir: PathBuf,
    settings: Arc<tokio::sync::Mutex<SettingsStore>>,
    wavs: crate::tts::WavStore,
    goals: Arc<crate::goals::GoalTracker>,
    polls: Arc<crate::polls::PollTracker>,
    subathon: Arc<crate::subathon::Subathon>,
    queue: Arc<crate::queue::ViewerQueue>,
    hype: Arc<crate::hype::HypeTracker>,
    game_events: broadcast::Sender<crate::types::RawStreamEvent>,
    games: Arc<crate::builtin_games::BuiltinGames>,
    app_handle: tauri::AppHandle,
    raw: broadcast::Sender<RawStreamEvent>,
    // EFIR timer JSON frames: tick/alert/spin/bonus_roll/settings.
    timer: broadcast::Sender<serde_json::Value>,
    // Engine handle — snapshot replays state+cfg to late subscribers.
    efirtimer: Arc<crate::efirtimer::EfirTimer>,
    // TTS queue for `/tts/say` (game pages voice donor names).
    tts: Arc<crate::tts::Tts>,
    // App data dir — user game packs live in `<data>/games`.
    data_dir: PathBuf,
) -> std::io::Result<(u16, bool)> {
    let state = OverlayState {
        hub,
        frames,
        token,
        gifts_dir: gifts_dir(),
        media_dir,
        settings,
        last_frames: Arc::new(Mutex::new(HashMap::new())),
        wavs,
        goals,
        polls,
        subathon,
        queue,
        hype,
        game_events,
        games,
        raw,
        timer,
        efirtimer,
        widgets_dir: widgets_dir(),
        games_dir: games_dir(),
        user_games_dir: crate::game_packs::user_dir(&data_dir),
        data_dir,
        tts,
        app_handle,
    };

    // Recorder: remember the last frame per channel for late joiners.
    {
        let st = state.clone();
        let mut rx = st.frames.subscribe();
        tokio::spawn(async move {
            while let Ok(f) = rx.recv().await {
                st.last_frames
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .insert(frame_channel(&f), f);
            }
        });
    }

    // One token-guarded page handler per route — the factory gives each
    // closure its own state clone (a plain `move` would steal it).
    let page_route = |html: &'static str| {
        let st = state.clone();
        move |q: Token| page(q, st.clone(), html)
    };
    let app = Router::new()
        .route("/overlay", get(page_route(OVERLAY_HTML)))
        .route("/overlay/alerts", get(page_route(ALERTS_HTML)))
        .route("/overlay/preset", get(page_route(PRESET_HTML)))
        .route("/overlay/spinner", get(page_route(SPINNER_HTML)))
        .route("/overlay/tts", get(page_route(TTS_HTML)))
        .route("/overlay/progress", get(page_route(PROGRESS_HTML)))
        .route("/overlay/leaderboard", get(page_route(LEADERBOARD_HTML)))
        .route("/overlay/goals", get(page_route(GOALS_HTML)))
        .route("/overlay/poll", get(page_route(POLL_HTML)))
        .route("/overlay/subathon", get(page_route(SUBATHON_HTML)))
        .route("/overlay/timer", get(page_route(TIMER_HTML)))
        .route("/overlay/queue", get(page_route(QUEUE_HTML)))
        .route("/overlay/hype", get(page_route(HYPE_HTML)))
        // Interactive games — every `games/<slug>/overlay.html` (bundled
        // `public/games` or `<app-data>/games` drop-in) resolves here;
        // remote link-packs have no page and 404 naturally.
        .route("/overlay/game/{id}", get(serve_pack_game))
        .route("/games-assets/{*path}", get(serve_game_asset))
        .route("/tts/say", post(tts_say))
        .route("/gamekit.js", get(serve_gamekit))
        .route("/games/cfg/{id}", get(serve_game_cfg))
        .route("/games/state.json", get(serve_game_state))
        .route("/games/report", post(serve_game_report))
        .route("/games/asset", post(save_game_asset))
        .route("/top.json", get(serve_top))
        .route("/goals.json", get(serve_goals))
        .route("/poll.json", get(serve_poll))
        .route("/subathon.json", get(serve_subathon))
        .route("/queue.json", get(serve_queue))
        .route("/hype.json", get(serve_hype))
        .route("/gifts/{file}", get(serve_gift))
        .route("/widgets/{*path}", get(serve_widget))
        .route("/media/{id}", get(serve_media))
        .route("/tts/{file}", get(serve_tts))
        .route("/overlay-close", get(overlay_close))
        .route("/timer/cmd", post(timer_cmd))
        .route("/anim/cfg", get(serve_anim_cfg))
        .route("/health", get(|| async { "ok" }))
        .route("/ws", get(ws_upgrade))
        .with_state(state);

    // Fixed port first (§5.4) — fall back to OS-assigned on conflict.
    let bind = async |p: u16| TcpListener::bind(("127.0.0.1", p)).await;
    let (listener, fell_back) = if port_cfg > 0 {
        match bind(port_cfg).await {
            Ok(l) => (l, false),
            Err(_) => (bind(0).await?, true),
        }
    } else {
        (bind(0).await?, false)
    };
    let port = listener.local_addr()?.port();
    tracing::info!(port, port_cfg, fell_back, "overlay listening on 127.0.0.1");
    tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, app).await {
            tracing::error!(error = %e, "overlay server stopped");
        }
    });
    Ok((port, fell_back))
}

/// `POST /timer/cmd?t=` — управление EFIR-таймером из виджета-пульта.
/// Тело: `{action, secs?, rouletteId?, index?, durS?}` — те же действия,
/// что и Tauri-команды `efirtimer_*` (пульт — внешняя страница, invoke там
/// недоступен, поэтому управление идёт по HTTP на тот же движок).
async fn timer_cmd(
    Query(q): Query<HashMap<String, String>>,
    State(st): State<OverlayState>,
    Json(body): Json<serde_json::Value>,
) -> Response {
    if !token_ok(q.get("t").map(String::as_str), &st.token) {
        return (StatusCode::FORBIDDEN, "overlay token required (?t=…)").into_response();
    }
    let t = &st.efirtimer;
    let action = body.get("action").and_then(|x| x.as_str()).unwrap_or("");
    let secs = body.get("secs").and_then(|x| x.as_i64()).unwrap_or(60);
    match action {
        "start" => t.start(body.get("durS").and_then(|x| x.as_i64()).unwrap_or(300)).await,
        "stop" => t.stop().await,
        "pause" => {
            t.pause().await;
        }
        "resume" => {
            t.resume().await;
        }
        "add" => t.manual_add(secs).await,
        "sub" => t.manual_sub(secs).await,
        "set" => t.manual_set(secs).await,
        "freeze" => t.manual_freeze().await,
        "unfreeze" => t.manual_unfreeze().await,
        "reverse" => t.manual_reverse().await,
        "ruiner" => t.manual_ruiner().await,
        "save" => t.manual_save().await,
        "spin" => {
            t.manual_spin(body.get("rouletteId").and_then(|x| x.as_str()).unwrap_or(""))
                .await;
        }
        "card" => {
            let idx = body.get("index").and_then(|x| x.as_u64()).unwrap_or(0) as usize;
            t.manual_card_pick(idx).await;
        }
        other => return (StatusCode::BAD_REQUEST, format!("unknown action: {other}")).into_response(),
    }
    Json(serde_json::json!({"ok": true})).into_response()
}

/// `GET /anim/cfg?t=` — правила «подарок → анимация» для виджета
/// `animbox.html`: список `AnimRule` + карта media-id → {kind, ext},
/// чтобы виджет знал, рендерить `<video>` или `<img>`.
async fn serve_anim_cfg(
    Query(q): Query<HashMap<String, String>>,
    State(st): State<OverlayState>,
) -> Response {
    if !token_ok(q.get("t").map(String::as_str), &st.token) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let s = st.settings.lock().await;
    let rules = s.data.anims.clone();
    let ids: std::collections::HashSet<&str> = rules
        .iter()
        .filter_map(|r| r.media_id.as_deref())
        .collect();
    let media: Vec<serde_json::Value> = s
        .data
        .media
        .iter()
        .filter(|m| ids.contains(m.id.as_str()))
        .map(|m| serde_json::json!({"id": m.id, "kind": m.kind, "ext": m.ext}))
        .collect();
    Json(serde_json::json!({"rules": rules, "media": media})).into_response()
}

/// Token gate + embedded page response for the `/overlay*` routes.
async fn page(q: Token, st: OverlayState, html: &'static str) -> Response {
    if !check_token(&q, &st) {
        return (StatusCode::FORBIDDEN, "overlay token required (?t=…)").into_response();
    }
    Html(html).into_response()
}

/// `/gifts/<file>` — bundled webp icons. Only files matching the catalog
/// naming scheme are served (no path traversal — the name itself is the
/// whitelist).
async fn serve_gift(
    Path(file): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    State(st): State<OverlayState>,
) -> Response {
    if !token_ok(q.get("t").map(String::as_str), &st.token) {
        return StatusCode::FORBIDDEN.into_response();
    }
    // Whitelist: catalog files are lowercase slugs ending in .webp;
    // the catalog index itself (gifts.json) is served as JSON so
    // widget pages can resolve gift names to icon files.
    let is_catalog = file == "gifts.json";
    let ok = is_catalog
        || (file.len() <= 128
            && file.ends_with(".webp")
            && file.chars().all(|c| {
                c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '-' | '_' | '.')
            }));
    if !ok {
        return StatusCode::NOT_FOUND.into_response();
    }
    let Some(dir) = &st.gifts_dir else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let path = dir.join(&file);
    let mime = if is_catalog {
        "application/json"
    } else {
        "image/webp"
    };
    match tokio::fs::read(&path).await {
        Ok(bytes) => ([("content-type", mime)], bytes).into_response(),
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}

/// Locates the editable widget library (`public/widgets`). Same lookup
/// order as `gifts_dir`: env override → `resources/widgets` beside the
/// exe → dev path `<manifest>/../public/widgets`.
fn widgets_dir() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("CHLAUNCHER_WIDGETS_DIR") {
        let p = PathBuf::from(p);
        if p.is_dir() {
            return Some(p);
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(d) = exe.parent() {
            let p = d.join("resources").join("widgets");
            if p.is_dir() {
                return Some(p);
            }
        }
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("public")
        .join("widgets");
    dev.is_dir().then_some(dev)
}

/// `/widgets/<path>` — the editable widget library (public/widgets).
/// Deliberately served from disk (not `include_str!`) so streamers can
/// restyle/extend widgets without a rebuild. Path is whitelisted char-
/// wise and `..` is rejected before it ever reaches the filesystem.
async fn serve_widget(
    Path(path): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    State(st): State<OverlayState>,
) -> Response {
    // Токен обязателен только для HTML-страниц. Вложенные ресурсы
    // (bridge.js, themes.js, шрифты, картинки) подключаются относительными
    // ссылками и не несут ?t= — блокируя их, мы ломали каждый виджет
    // (скрипты не грузились → TTW undefined → сцена не масштабировалась).
    let is_page = path.ends_with(".html") || path.is_empty();
    if is_page && !token_ok(q.get("t").map(String::as_str), &st.token) {
        return StatusCode::FORBIDDEN.into_response();
    }
    if !crate::game_packs::safe_relpath(&path) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let Some(dir) = &st.widgets_dir else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let file_path = dir.join(&path);
    let mime = match file_path.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "mp3" | "wav" | "ogg" => "audio/mpeg",
        "mp4" | "webm" => "video/mp4",
        _ => "application/octet-stream",
    };
    match tokio::fs::read(&file_path).await {
        Ok(bytes) => ([("content-type", mime)], bytes).into_response(),
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}

/// Locates the game skin/asset library (`public/games`) — delegated to
/// `game_packs::bundled_dir` (env override → `resources/games` beside
/// the exe → dev path `<manifest>/../public/games`).
fn games_dir() -> Option<PathBuf> {
    crate::game_packs::bundled_dir()
}

/// `/overlay/game/{id}` — serves a folder-pack game page from disk.
/// Compiled-in pages keep their static routes (matchit resolves exact
/// segments first); this handler covers everything else — so a new game
/// is a folder drop, not a rebuild.
async fn serve_pack_game(
    Path(id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    State(st): State<OverlayState>,
) -> Response {
    if !token_ok(q.get("t").map(String::as_str), &st.token) {
        return (StatusCode::FORBIDDEN, "overlay token required (?t=…)").into_response();
    }
    let ok = !id.is_empty()
        && id.len() <= 64
        && !id.starts_with('.')
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    if !ok {
        return StatusCode::NOT_FOUND.into_response();
    }
    let Some(pack) = crate::game_packs::find(&id, &st.data_dir) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Some(page) = pack.page_path() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    match tokio::fs::read(&page).await {
        Ok(bytes) => Html(String::from_utf8_lossy(&bytes).into_owned()).into_response(),
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}

/// `/games-assets/<path>` — game skin packs (sprites/sfx/skin.json).
/// Served from disk like `/widgets/` so a new skin drops in without a
/// rebuild. Assets carry no secrets → no token gate (same as widget
/// sub-resources); `..` and exotic chars are rejected char-wise.
async fn serve_game_asset(
    Path(path): Path<String>,
    State(st): State<OverlayState>,
) -> Response {
    if !crate::game_packs::safe_relpath(&path) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let mime = match std::path::Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
    {
        "json" => "application/json",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "mp3" | "wav" | "ogg" => "audio/mpeg",
        "mp4" | "webm" => "video/mp4",
        _ => return StatusCode::NOT_FOUND.into_response(),
    };
    // User packs override bundled ones — same precedence as the registry.
    let mut roots = vec![st.user_games_dir.clone()];
    if let Some(d) = &st.games_dir {
        roots.push(d.clone());
    }
    for root in roots {
        if let Ok(bytes) = tokio::fs::read(root.join(&path)).await {
            return ([("content-type", mime)], bytes).into_response();
        }
    }
    StatusCode::NOT_FOUND.into_response()
}

/// `POST /games/asset?t=` — dev-panel asset install: a game page
/// (Patrick's debug panel) pushes an image into the USER pack dir
/// (`<data>/games/<dir>/<path>`) so custom content rides the normal
/// `/games-assets` precedence (user > bundled) without touching the
/// installed bundle. Body: `{dir, path, data_b64}`; `data_b64:null`
/// deletes. dir/path/signature are validated — only images, ≤4 MiB.
async fn save_game_asset(
    Query(q): Query<HashMap<String, String>>,
    State(st): State<OverlayState>,
    Json(body): Json<serde_json::Value>,
) -> Response {
    use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
    if !token_ok(q.get("t").map(String::as_str), &st.token) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let dir = body.get("dir").and_then(|v| v.as_str()).unwrap_or("");
    let path = body.get("path").and_then(|v| v.as_str()).unwrap_or("");
    let dir_ok = !dir.is_empty()
        && dir.len() <= 64
        && !dir.starts_with('.')
        && dir
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    let ext_ok = path
        .rsplit_once('.')
        .map(|(_, e)| matches!(e, "png" | "jpg" | "jpeg" | "webp" | "mp3" | "wav" | "ogg"))
        .unwrap_or(false);
    if !dir_ok || !crate::game_packs::safe_relpath(path) || !ext_ok {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let dest = st.user_games_dir.join(dir).join(path);
    match body.get("data_b64") {
        // Explicit null = dev-panel "reset" → drop the user override.
        Some(serde_json::Value::Null) => {
            let _ = std::fs::remove_file(&dest);
            return axum::Json(serde_json::json!({ "ok": true, "deleted": true }))
                .into_response();
        }
        None => return StatusCode::BAD_REQUEST.into_response(),
        _ => {}
    }
    let b64 = body["data_b64"].as_str().unwrap_or("");
    if b64.len() > 6_000_000 {
        return (StatusCode::PAYLOAD_TOO_LARGE, "asset too large").into_response();
    }
    let Ok(bytes) = B64.decode(b64.trim()) else {
        return (StatusCode::BAD_REQUEST, "invalid base64").into_response();
    };
    if bytes.len() > 4 * 1024 * 1024 {
        return (StatusCode::PAYLOAD_TOO_LARGE, "asset >4MiB").into_response();
    }
    // Magic-byte sniff — the extension claim isn't proof of content.
    let sig_ok = bytes.starts_with(&[0x89, 0x50, 0x4E, 0x47])      // PNG
        || bytes.starts_with(&[0xFF, 0xD8, 0xFF])                // JPEG
        || (bytes.len() > 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP")
        || (bytes.len() > 3 && &bytes[..3] == b"ID3")            // MP3 (id3)
        || (bytes.len() > 2 && bytes[0] == 0xFF && bytes[1] & 0xE0 == 0xE0) // MP3 frame
        || bytes.starts_with(b"OggS")
        || (bytes.len() > 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WAVE");
    if !sig_ok {
        return (StatusCode::BAD_REQUEST, "unsupported file signature").into_response();
    }
    if let Some(parent) = dest.parent() {
        if std::fs::create_dir_all(parent).is_err() {
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    }
    // Atomic write: .tmp + rename so a half-written png is never served.
    let tmp = dest.with_extension("tmp");
    if std::fs::write(&tmp, &bytes).is_err()
        || std::fs::rename(&tmp, &dest).is_err()
    {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    axum::Json(serde_json::json!({ "ok": true })).into_response()
}

/// `POST /tts/say?t=` — game pages voice a donor nickname through the
/// streamer's configured TTS pipeline (`speak_rule` — obeys mute,
/// filters and the device/overlay output). Body: `{text, voice?, style?}`.
async fn tts_say(
    Query(q): Query<HashMap<String, String>>,
    State(st): State<OverlayState>,
    Json(body): Json<serde_json::Value>,
) -> Response {
    if !token_ok(q.get("t").map(String::as_str), &st.token) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let text = body.get("text").and_then(|v| v.as_str()).unwrap_or("");
    if text.trim().is_empty() || text.len() > 120 {
        return StatusCode::BAD_REQUEST.into_response();
    }
    // `game` picks the TTS rule profile (pack games may carry their own
    // profile name in game.json); "patrick" stays the default voice rule.
    let rule = body
        .get("game")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty() && s.len() <= 64)
        .unwrap_or("patrick");
    st.tts.speak_rule(
        rule.to_string(),
        text.to_string(),
        body.get("voice").and_then(|v| v.as_str()).map(String::from),
        body.get("style").and_then(|v| v.as_str()).map(String::from),
    );
    StatusCode::OK.into_response()
}

/// `/top.json` — session leaderboard (top supporters by cumulative
/// amount). The leaderboard page polls it every few seconds — cheap
/// enough that a WS channel isn't warranted.
async fn serve_top(
    Query(q): Query<HashMap<String, String>>,
    State(st): State<OverlayState>,
) -> Response {
    if !token_ok(q.get("t").map(String::as_str), &st.token) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let n = q
        .get("n")
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(10)
        .min(50);
    let top: Vec<serde_json::Value> = st
        .hub
        .top_supporters(n)
        .into_iter()
        .map(|(user, total)| serde_json::json!({"user": user, "total": total}))
        .collect();
    axum::Json(top).into_response()
}

/// `/goals.json` — stream-goal progress rows (`GoalProgress`), polled by
/// `/overlay/goals` and the settings card.
async fn serve_goals(
    Query(q): Query<HashMap<String, String>>,
    State(st): State<OverlayState>,
) -> Response {
    if !token_ok(q.get("t").map(String::as_str), &st.token) {
        return StatusCode::FORBIDDEN.into_response();
    }
    axum::Json(st.goals.snapshot().await).into_response()
}

/// `/poll.json` — live vote counters, polled by `/overlay/poll` and
/// the poll card every ~1 s while a vote runs.
async fn serve_poll(
    Query(q): Query<HashMap<String, String>>,
    State(st): State<OverlayState>,
) -> Response {
    if !token_ok(q.get("t").map(String::as_str), &st.token) {
        return StatusCode::FORBIDDEN.into_response();
    }
    axum::Json(st.polls.status().await).into_response()
}

/// `/subathon.json` — remaining seconds, polled by the countdown page.
async fn serve_subathon(
    Query(q): Query<HashMap<String, String>>,
    State(st): State<OverlayState>,
) -> Response {
    if !token_ok(q.get("t").map(String::as_str), &st.token) {
        return StatusCode::FORBIDDEN.into_response();
    }
    axum::Json(st.subathon.status().await).into_response()
}

/// `/queue.json` — the waiting viewers, polled by `/overlay/queue`.
async fn serve_queue(
    Query(q): Query<HashMap<String, String>>,
    State(st): State<OverlayState>,
) -> Response {
    if !token_ok(q.get("t").map(String::as_str), &st.token) {
        return StatusCode::FORBIDDEN.into_response();
    }
    axum::Json(st.queue.status().await).into_response()
}

/// `/hype.json` - sliding-window coins + level, polled by the meter page.
async fn serve_hype(
    Query(q): Query<HashMap<String, String>>,
    State(st): State<OverlayState>,
) -> Response {
    if !token_ok(q.get("t").map(String::as_str), &st.token) {
        return StatusCode::FORBIDDEN.into_response();
    }
    axum::Json(st.hype.status().await).into_response()
}

/// `/gamekit.js` — shared runtime for built-in game pages (WS client,
/// trigger engine, antiflood, HUD). Served with a JS mime so pages can
/// `<script src>` it directly.
async fn serve_gamekit(
    Query(q): Query<HashMap<String, String>>,
    State(st): State<OverlayState>,
) -> Response {
    if !token_ok(q.get("t").map(String::as_str), &st.token) {
        return StatusCode::FORBIDDEN.into_response();
    }
    (
        [("content-type", "text/javascript; charset=utf-8")],
        GAMEKIT_JS,
    )
        .into_response()
}

/// `/games/cfg/:id` — per-game cfg (seeded on first read) + session
/// status so a freshly opened page lands mid-round correctly.
async fn serve_game_cfg(
    Path(id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    State(st): State<OverlayState>,
) -> Response {
    if !token_ok(q.get("t").map(String::as_str), &st.token) {
        return StatusCode::FORBIDDEN.into_response();
    }
    if !crate::builtin_games::exists(&id, &st.data_dir) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let cfg = {
        let mut s = st.settings.lock().await;
        crate::builtin_games::cfg_for(&mut s, &id, &st.data_dir)
    };
    Json(serde_json::json!({
        "game_id": id,
        "cfg": cfg,
        "session": st.games.status().active,
    }))
    .into_response()
}

/// POST `/games/report` — the page reports a finished round; appended
/// to the bounded results ledger (token via `?t=`).
async fn serve_game_report(
    Query(q): Query<HashMap<String, String>>,
    State(st): State<OverlayState>,
    Json(body): Json<serde_json::Value>,
) -> Response {
    if !token_ok(q.get("t").map(String::as_str), &st.token) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let game_id = body["game_id"].as_str().unwrap_or("");
    if !crate::builtin_games::exists(game_id, &st.data_dir) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    match st.games.record_result(body) {
        Ok(()) => StatusCode::OK.into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

/// Closes the `overlay-<page>` capture window. Frameless windows have no
/// chrome to click, so the Escape handler injected into each capture
/// page pings this endpoint — token-guarded like the pages themselves.
async fn overlay_close(
    Query(q): Query<HashMap<String, String>>,
    State(st): State<OverlayState>,
) -> Response {
    if !token_ok(q.get("t").map(String::as_str), &st.token) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Some(page) = q.get("page") else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let label = format!("overlay-{}", page.replace('/', "-"));
    if let Some(w) = st.app_handle.get_webview_window(&label) {
        let _ = w.close();
    }
    "ok".into_response()
}

/// `/games/state.json` — session snapshot for late-joining pages and
/// the Games page status badge.
async fn serve_game_state(
    Query(q): Query<HashMap<String, String>>,
    State(st): State<OverlayState>,
) -> Response {
    if !token_ok(q.get("t").map(String::as_str), &st.token) {
        return StatusCode::FORBIDDEN.into_response();
    }
    Json(st.games.status()).into_response()
}

/// `/media/:id` — media-library file with byte-range support (§4.1:
/// video in a Browser Source won't seek — and sometimes won't play —
/// without Range). The id must be a 32-hex index row; paths never come
/// from the client.
async fn serve_media(
    Path(id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    State(st): State<OverlayState>,
    req: axum::extract::Request,
) -> Response {
    if !token_ok(q.get("t").map(String::as_str), &st.token) {
        return StatusCode::FORBIDDEN.into_response();
    }
    if id.len() != 32
        || !id
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
    {
        return StatusCode::NOT_FOUND.into_response();
    }
    let item = {
        st.settings
            .lock()
            .await
            .data
            .media
            .iter()
            .find(|m| m.id == id)
            .cloned()
    };
    let Some(item) = item else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let path = crate::media::media_path(&st.media_dir, &item);
    if !path.exists() {
        // §4.2: file gone from disk → alert renders without media; log it.
        tracing::warn!(id, "media file missing on disk");
        return StatusCode::NOT_FOUND.into_response();
    }
    use tower::Service;
    match tower_http::services::ServeFile::new(&path).call(req).await {
        Ok(res) => res.into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

/// `/tts/<id>.<ext>` — synthesized phrase for `output = "overlay"` (§6).
/// `.wav` (SAPI) and `.mp3` (Edge) are both served; the mime comes from
/// the store. The id is a uuid → `WavStore` lookup; nothing
/// filesystem-derived.
async fn serve_tts(
    Path(file): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    State(st): State<OverlayState>,
) -> Response {
    if !token_ok(q.get("t").map(String::as_str), &st.token) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let (id, ext) = file.rsplit_once('.').unwrap_or(("", ""));
    if !matches!(ext, "wav" | "mp3")
        || id.len() != 36
        || !id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
    {
        return StatusCode::NOT_FOUND.into_response();
    }
    match st.wavs.get(id) {
        Some((mime, bytes)) => ([("content-type", mime)], bytes).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

/// `/ws` upgrade — token checked here as well (pages pass their own `?t=`).
async fn ws_upgrade(
    ws: WebSocketUpgrade,
    Query(q): Query<HashMap<String, String>>,
    State(st): State<OverlayState>,
) -> Response {
    if !token_ok(q.get("t").map(String::as_str), &st.token) {
        return StatusCode::FORBIDDEN.into_response();
    }
    ws.on_upgrade(move |sock| overlay_ws(sock, st))
}

/// Legacy frame types for unsubscribed clients (pre-§5.3 protocol).
#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum LegacyFrame<'a> {
    Snapshot {
        recent: &'a [StreamEvent],
        top: &'a [(String, i64)],
    },
    Event {
        event: &'a StreamEvent,
    },
}

async fn send(
    sock: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    text: String,
) -> bool {
    sock.send(Message::Text(text.into())).await.is_ok()
}

/// One overlay socket. Legacy clients (no `subscribe`) get the snapshot
/// + event stream exactly as before. After `{type:"subscribe",
/// channels:[…]}` the client gets only its channels' frames plus the
/// last frame replayed per channel (§5.3).
async fn overlay_ws(socket: WebSocket, st: OverlayState) {
    let (mut tx, mut rx) = socket.split();
    let mut events = st.hub.tx.subscribe();
    let mut frames = st.frames.subscribe();
    let mut game_events = st.game_events.subscribe();
    let mut raw = st.raw.subscribe();
    let mut timer = st.timer.subscribe();
    // `None` = legacy (all event traffic); Some(set) = subscribed channels.
    let mut channels: Option<HashSet<String>> = None;

    let snapshot = serde_json::to_string(&LegacyFrame::Snapshot {
        recent: &st.hub.recent_events(),
        top: &st.hub.top_supporters(5),
    })
    .unwrap_or_default();
    if !send(&mut tx, snapshot).await {
        return;
    }

    loop {
        tokio::select! {
            ev = events.recv() => {
                match ev {
                    Ok(event) => {
                        // StreamEvents map to the "events" channel for
                        // subscribed clients; legacy always gets them.
                        if channels.as_ref().map(|c| !c.contains(CH_EVENTS)).unwrap_or(false) {
                            continue;
                        }
                        let frame = serde_json::to_string(&LegacyFrame::Event { event: &event })
                            .unwrap_or_default();
                        if !send(&mut tx, frame).await { break; }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(_) => break,
                }
            }
            f = frames.recv() => {
                match f {
                    Ok(frame) => {
                        let ch = frame_channel(&frame);
                        let Some(set) = &channels else { continue }; // legacy: no frames
                        if !set.contains(ch) { continue; }
                        let text = serde_json::to_string(&frame).unwrap_or_default();
                        if !send(&mut tx, text).await { break; }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(_) => break,
                }
            }
            gev = game_events.recv() => {
                match gev {
                    Ok(raw) => {
                        let Some(set) = &channels else { continue }; // game pages only
                        if !set.contains(CH_GAME) { continue; }
                        let text = serde_json::json!({
                            "type": "game_event",
                            "event": raw,
                        }).to_string();
                        if !send(&mut tx, text).await { break; }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(_) => break,
                }
            }
            tf = timer.recv() => {
                match tf {
                    Ok(frame) => {
                        // EFIR timer frames go only to "timer"
                        // subscribers — widgets never see them unless
                        // they opt in.
                        if channels.as_ref().map(|c| !c.contains(CH_TIMER)).unwrap_or(true) {
                            continue;
                        }
                        if !send(&mut tx, frame.to_string()).await { break; }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(_) => break,
                }
            }
            re = raw.recv() => {
                match re {
                    Ok(event) => {
                        // Raw events go only to explicit "raw" subscribers
                        // (the widget library); legacy clients never see them.
                        if channels.as_ref().map(|c| !c.contains(CH_RAW)).unwrap_or(true) {
                            continue;
                        }
                        let text = serde_json::json!({"type":"raw","event":event}).to_string();
                        if !send(&mut tx, text).await { break; }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(_) => break,
                }
            }
            msg = rx.next() => {
                match msg {
                    Some(Ok(Message::Ping(p))) => {
                        let _ = tx.send(Message::Pong(p)).await;
                    }
                    Some(Ok(Message::Text(t))) => {
                        let Ok(v) = serde_json::from_str::<serde_json::Value>(&t) else {
                            continue;
                        };
                        if v["type"].as_str() == Some("subscribe") {
                            let set: HashSet<String> = v["channels"]
                                .as_array()
                                .map(|a| {
                                    a.iter()
                                        .filter_map(|c| c.as_str().map(String::from))
                                        .collect()
                                })
                                .unwrap_or_default();
                            channels = Some(set.clone());
                            // Replay the last frame per subscribed channel
                            // so the page isn't blank until the next event.
                            for ch in &[CH_PRESET, CH_PROGRESS, CH_ALERTS] {
                                if set.contains(*ch) {
                                    // Clone out of the lock — a MutexGuard
                                    // held across `send().await` is !Send.
                                    let frame = st
                                        .last_frames
                                        .lock()
                                        .unwrap_or_else(|p| p.into_inner())
                                        .get(ch)
                                        .cloned();
                                    if let Some(f) = frame {
                                        let text = serde_json::to_string(&f).unwrap_or_default();
                                        if !send(&mut tx, text).await { return; }
                                    }
                                }
                            }
                            // Subscribed to the EFIR timer → replay the
                            // engine snapshot (state + cfg) so widgets
                            // render immediately, not on the next tick.
                            if set.contains(CH_TIMER) {
                                let snap = st.efirtimer.snapshot().await;
                                if !send(&mut tx, snap.to_string()).await { return; }
                            }
                            // Subscribed to events → fresh snapshot.
                            if set.contains(CH_EVENTS) {
                                let snap = serde_json::to_string(&LegacyFrame::Snapshot {
                                    recent: &st.hub.recent_events(),
                                    top: &st.hub.top_supporters(5),
                                })
                                .unwrap_or_default();
                                if !send(&mut tx, snap).await { return; }
                            }
                        }
                    }
                    Some(Err(_)) | None => break,
                    _ => {}
                }
            }
        }
    }
}

const OVERLAY_HTML: &str = include_str!("../overlay/overlay.html");
const ALERTS_HTML: &str = include_str!("../overlay/alerts.html");
const PRESET_HTML: &str = include_str!("../overlay/preset.html");
const PROGRESS_HTML: &str = include_str!("../overlay/progress.html");
const LEADERBOARD_HTML: &str = include_str!("../overlay/leaderboard.html");
const GOALS_HTML: &str = include_str!("../overlay/goals.html");
const POLL_HTML: &str = include_str!("../overlay/poll.html");
const SUBATHON_HTML: &str = include_str!("../overlay/subathon.html");
const TIMER_HTML: &str = include_str!("../overlay/timer.html");
const QUEUE_HTML: &str = include_str!("../overlay/queue.html");
const HYPE_HTML: &str = include_str!("../overlay/hype.html");
const SPINNER_HTML: &str = include_str!("../overlay/spinner.html");
const TTS_HTML: &str = include_str!("../overlay/tts.html");
const GAMEKIT_JS: &str = include_str!("../overlay/gamekit.js");

#[cfg(test)]
mod tests {
    use super::*;

    /// Token rotation regression: a value written into the shared cell
    /// must take effect immediately — a static copy captured at server
    /// start would keep accepting the OLD token (rotation inverted).
    #[test]
    fn token_ok_reads_live_cell_value() {
        let token = std::sync::RwLock::new("old-token".to_string());
        assert!(token_ok(Some("old-token"), &token));
        assert!(!token_ok(Some("new-token"), &token));
        assert!(!token_ok(None, &token));
        *token.write().unwrap() = "new-token".to_string();
        assert!(!token_ok(Some("old-token"), &token));
        assert!(token_ok(Some("new-token"), &token));
    }
}
