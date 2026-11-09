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
    routing::get,
    Router,
};
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use tokio::net::TcpListener;
use tokio::sync::broadcast;

use crate::events::EventHub;
use crate::settings::SettingsStore;
use crate::types::{OverlayFrame, PresetRow, StreamEvent, TriggerProfile};

/// Overlay frame channels — the `subscribe` vocabulary (§5.3).
const CH_EVENTS: &str = "events";
const CH_ALERTS: &str = "alerts";
const CH_PRESET: &str = "preset";
const CH_SPINNER: &str = "spinner";
const CH_TTS: &str = "tts";
const CH_PROGRESS: &str = "progress";

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
    /// Access token — every route requires `?t=` matching this.
    token: Arc<String>,
    /// Directory with bundled gift icons (`*.webp` + `gifts.json`).
    gifts_dir: Option<PathBuf>,
    /// `<app-data>/media` — files behind `/media/:id` (§4.1).
    media_dir: PathBuf,
    /// Media index lives in settings — resolving `:id` → file needs it.
    settings: Arc<tokio::sync::Mutex<SettingsStore>>,
    /// Last frame per channel — replayed to late-joining subscribers so a
    /// newly opened preset/progress page isn't blank until the next event.
    last_frames: Arc<Mutex<HashMap<&'static str, OverlayFrame>>>,
}

/// Query-param extractor shared by all guarded routes.
type Token = Query<HashMap<String, String>>;

fn check_token(q: &Token, st: &OverlayState) -> bool {
    q.0.get("t")
        .map(|t| t == st.token.as_str())
        .unwrap_or(false)
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
/// (mirrors `src/lib/gifts.ts`).
fn gift_icon(name: &str) -> Option<String> {
    let idx = gift_index();
    let key = name.to_lowercase();
    if let Some(img) = idx.get(&key) {
        return Some(format!("/gifts/{img}"));
    }
    idx.iter()
        .find(|(k, _)| key.contains(k.as_str()) || k.contains(key.as_str()))
        .map(|(_, img)| format!("/gifts/{img}"))
        .filter(|_| key.len() >= 3)
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
    token: String,
    port_cfg: u16,
    media_dir: PathBuf,
    settings: Arc<tokio::sync::Mutex<SettingsStore>>,
) -> std::io::Result<(u16, bool)> {
    let state = OverlayState {
        hub,
        frames,
        token: Arc::new(token),
        gifts_dir: gifts_dir(),
        media_dir,
        settings,
        last_frames: Arc::new(Mutex::new(HashMap::new())),
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
        .route("/gifts/:file", get(serve_gift))
        .route("/media/:id", get(serve_media))
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
    if q.get("t").map(|t| t == st.token.as_str()) != Some(true) {
        return StatusCode::FORBIDDEN.into_response();
    }
    // Whitelist: catalog files are lowercase slugs ending in .webp.
    let ok = file.len() <= 128
        && file.ends_with(".webp")
        && file
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '-' | '_' | '.'));
    if !ok {
        return StatusCode::NOT_FOUND.into_response();
    }
    let Some(dir) = &st.gifts_dir else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let path = dir.join(&file);
    match tokio::fs::read(&path).await {
        Ok(bytes) => ([("content-type", "image/webp")], bytes).into_response(),
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
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
    if q.get("t").map(|t| t == st.token.as_str()) != Some(true) {
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

/// `/ws` upgrade — token checked here as well (pages pass their own `?t=`).
async fn ws_upgrade(
    ws: WebSocketUpgrade,
    Query(q): Query<HashMap<String, String>>,
    State(st): State<OverlayState>,
) -> Response {
    if q.get("t").map(|t| t == st.token.as_str()) != Some(true) {
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
const SPINNER_HTML: &str = include_str!("../overlay/spinner.html");
const TTS_HTML: &str = include_str!("../overlay/tts.html");
