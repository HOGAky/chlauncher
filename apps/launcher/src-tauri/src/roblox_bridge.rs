//! Embedded Roblox relay («мост») — developer mode.
//!
//! The standalone cloud relay (`docs/roblox-integration.md`) exposes a tiny
//! HTTP API that the Roblox place polls (`RelayClient.lua` in the game).
//! This module serves the same public surface straight from the launcher,
//! fed by the `EventHub` — no forward/ingest hop and no admin secret:
//!
//! ```text
//! EventHub ──► room queue (500, TTL 60 s) ──► GET  /api/stream/events?key&since
//!                                             POST /api/stream/{claim,release,validate,ingest}
//! ```
//!
//! Reachability: a Roblox Studio play-test runs the game server on this PC,
//! so the game's default `Config.RELAY_URL = "http://localhost:8790"` works
//! as is. Published places run in Roblox cloud — they need a public tunnel
//! to this port, or the standalone relay + [`crate::forwarder`].

use axum::{
    body::Bytes,
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::net::TcpListener;
use tokio::sync::{broadcast, watch, Mutex};

use crate::events::EventHub;
use crate::settings::SettingsStore;

/// Same port the standalone relay and the game's `Config.RELAY_URL` use.
pub const DEFAULT_PORT: u16 = 8790;
/// Trigger-profile slug the library card activates.
pub const PROFILE_SLUG: &str = "roblox-sts";
/// Built-in preset seeded into [`PROFILE_SLUG`] on first play.
pub const PRESET: &str = "steal-the-stream";
const QUEUE_CAP: usize = 500;
const EVENT_TTL: Duration = Duration::from_secs(60);

/// Developer mode: dev builds, or an admin account. Gates the unreleased
/// Roblox card and the embedded bridge.
pub fn dev_mode(role: Option<&str>) -> bool {
    cfg!(debug_assertions) || role == Some("admin")
}

/// One streamer «room»: cursor-addressed event queue + claim/bind state,
/// mirroring the relay's per-key record.
#[derive(Default)]
struct Room {
    events: VecDeque<(u64, Instant, Value)>,
    /// Last assigned event id == the cursor returned to pollers.
    cursor: u64,
    claimed_job_id: Option<String>,
    bound_user_id: Option<String>,
    served: u64,
    last_poll_ms: Option<u64>,
}

impl Room {
    fn push(&mut self, ev: Value) {
        self.sweep();
        self.cursor += 1;
        self.events.push_back((self.cursor, Instant::now(), ev));
        while self.events.len() > QUEUE_CAP {
            self.events.pop_front();
        }
    }

    fn sweep(&mut self) {
        while self
            .events
            .front()
            .is_some_and(|(_, t, _)| t.elapsed() > EVENT_TTL)
        {
            self.events.pop_front();
        }
    }

    /// Events newer than `since`. A cursor from the future means the bridge
    /// restarted (ids start over) — replay from 0 instead of going deaf
    /// until the new ids catch up with the room's stale cursor.
    fn since(&mut self, since: u64) -> Vec<Value> {
        self.sweep();
        let since = if since > self.cursor { 0 } else { since };
        let out: Vec<Value> = self
            .events
            .iter()
            .filter(|(id, ..)| *id > since)
            .map(|(.., v)| v.clone())
            .collect();
        self.served += out.len() as u64;
        out
    }
}

struct Shared {
    room: std::sync::Mutex<Room>,
    settings: Arc<Mutex<SettingsStore>>,
    /// Hub events are queued only while the HTTP server is up.
    live: AtomicBool,
}

impl Shared {
    fn room(&self) -> std::sync::MutexGuard<'_, Room> {
        self.room.lock().unwrap_or_else(|p| p.into_inner())
    }
}

/// Runtime view for the library card.
#[derive(Debug, Clone, Default, Serialize)]
pub struct BridgeStatus {
    pub running: bool,
    pub port: Option<u16>,
    /// What to put into the game's `Config.RELAY_URL`.
    pub url: Option<String>,
    pub error: Option<String>,
    pub queued: usize,
    pub cursor: u64,
    /// Events handed out to pollers so far.
    pub served: u64,
    /// Unix ms of the last `GET /events` — «игра на связи».
    pub last_poll_ms: Option<u64>,
    pub claimed_job_id: Option<String>,
    pub bound_user_id: Option<String>,
}

/// The embedded bridge: hub consumer + start/stop-able HTTP server.
pub struct RobloxBridge {
    shared: Arc<Shared>,
    /// `(port, shutdown signal)` while serving.
    server: Mutex<Option<(u16, watch::Sender<bool>)>>,
    error: std::sync::Mutex<Option<String>>,
}

impl RobloxBridge {
    /// Subscribes to the hub; the HTTP side starts via [`Self::start`].
    pub fn new(hub: &EventHub, settings: Arc<Mutex<SettingsStore>>) -> Arc<Self> {
        let shared = Arc::new(Shared {
            room: Default::default(),
            settings,
            live: AtomicBool::new(false),
        });
        let mut rx = hub.tx.subscribe();
        let sh = shared.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(ev) if sh.live.load(Ordering::Relaxed) => {
                        sh.room().push(crate::forwarder::event_body(&ev));
                    }
                    Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {}
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        });
        Arc::new(Self {
            shared,
            server: Mutex::new(None),
            error: Default::default(),
        })
    }

    /// (Re)binds `localhost:<port>` (0 = OS-assigned) and starts serving.
    /// Must run inside a tokio runtime (commands / `async_runtime`).
    pub async fn start(&self, port: u16) -> Result<u16, String> {
        self.stop().await;
        let v4 = match TcpListener::bind(("127.0.0.1", port)).await {
            Ok(l) => l,
            Err(e) => {
                let msg =
                    format!("порт {port} занят ({e}) — закройте старый relay или смените порт");
                *self.error.lock().unwrap_or_else(|p| p.into_inner()) = Some(msg.clone());
                return Err(msg);
            }
        };
        let port = v4.local_addr().map_err(|e| e.to_string())?.port();
        // Studio may resolve `localhost` to ::1 first — best-effort twin.
        let v6 = TcpListener::bind(("::1", port)).await.ok();
        let (stop_tx, stop_rx) = watch::channel(false);
        let app = router(self.shared.clone());
        for listener in std::iter::once(v4).chain(v6) {
            let app = app.clone();
            let mut stop = stop_rx.clone();
            tokio::spawn(async move {
                let res = axum::serve(listener, app)
                    .with_graceful_shutdown(async move {
                        let _ = stop.changed().await;
                    })
                    .await;
                if let Err(e) = res {
                    tracing::error!(error = %e, "roblox bridge stopped");
                }
            });
        }
        self.shared.live.store(true, Ordering::Relaxed);
        *self.server.lock().await = Some((port, stop_tx));
        *self.error.lock().unwrap_or_else(|p| p.into_inner()) = None;
        tracing::info!(port, "roblox bridge listening on localhost");
        Ok(port)
    }

    pub async fn stop(&self) {
        if let Some((_, stop)) = self.server.lock().await.take() {
            let _ = stop.send(true);
        }
        self.shared.live.store(false, Ordering::Relaxed);
    }

    /// Drops queue + claim/bind — after a stream-key rotation.
    pub fn reset_room(&self) {
        *self.shared.room() = Room::default();
    }

    pub async fn status(&self) -> BridgeStatus {
        let port = self.server.lock().await.as_ref().map(|(p, _)| *p);
        let mut room = self.shared.room();
        room.sweep();
        BridgeStatus {
            running: port.is_some(),
            port,
            url: port.map(|p| format!("http://localhost:{p}")),
            error: self.error.lock().unwrap_or_else(|p| p.into_inner()).clone(),
            queued: room.events.len(),
            cursor: room.cursor,
            served: room.served,
            last_poll_ms: room.last_poll_ms,
            claimed_job_id: room.claimed_job_id.clone(),
            bound_user_id: room.bound_user_id.clone(),
        }
    }
}

/// DNS-rebinding / CSRF guard (§P0.6): browsers can reach loopback
/// listeners under an attacker-controlled hostname — require a loopback
/// `Host` and, when present, a loopback/`tauri.localhost` `Origin`.
/// Roblox HttpService sends neither custom Host names nor Origin, so
/// this changes nothing for the real client.
async fn guard_loopback(req: axum::extract::Request, next: axum::middleware::Next) -> Response {
    fn host_is_loopback(host_header: &str) -> bool {
        let host = host_header
            .trim_start_matches('[')
            .split([':', ']'])
            .next()
            .unwrap_or("");
        matches!(host, "127.0.0.1" | "localhost" | "::1")
    }
    let host_ok = req
        .headers()
        .get(axum::http::header::HOST)
        .and_then(|v| v.to_str().ok())
        .map(host_is_loopback)
        .unwrap_or(false);
    if !host_ok {
        return fail(StatusCode::FORBIDDEN, "loopback_host_required");
    }
    if let Some(origin) = req
        .headers()
        .get(axum::http::header::ORIGIN)
        .and_then(|v| v.to_str().ok())
    {
        let oh = origin
            .split("://")
            .nth(1)
            .unwrap_or("")
            .split('/')
            .next()
            .unwrap_or("");
        if !(host_is_loopback(oh) || oh == "tauri.localhost") {
            return fail(StatusCode::FORBIDDEN, "foreign_origin");
        }
    }
    next.run(req).await
}

fn router(sh: Arc<Shared>) -> Router {
    Router::new()
        .route(
            "/health",
            get(|| async { Json(json!({"ok": true, "bridge": "chlauncher"})) }),
        )
        .route(
            "/api/stream/health",
            get(|| async { Json(json!({"ok": true, "bridge": "chlauncher"})) }),
        )
        .route("/api/stream/events", get(events))
        .route("/api/stream/ingest", post(ingest))
        .route("/api/stream/claim", post(claim))
        .route("/api/stream/release", post(release))
        .route("/api/stream/validate", post(validate))
        .route("/api/stream/redeem", post(redeem))
        .layer(axum::middleware::from_fn(guard_loopback))
        .with_state(sh)
}

/// Relay-compatible error envelope (`RelayClient` reads `body.error`).
fn fail(code: StatusCode, error: &str) -> Response {
    (code, Json(json!({ "error": error }))).into_response()
}

fn ok() -> Response {
    Json(json!({"ok": true})).into_response()
}

/// Constant-time compare — the key doubles as the room pass.
fn key_eq(a: &str, b: &str) -> bool {
    a.len() == b.len()
        && a.bytes()
            .zip(b.bytes())
            .fold(0u8, |acc, (x, y)| acc | (x ^ y))
            == 0
}

/// Key from `X-Stream-Key`, `?key=` or `body.stream_key` (relay order)
/// against the launcher's own `forward.stream_key`.
// Err is an early axum response — idiomatic for middleware-style
// guards; boxing it would only add an indirection per rejection.
#[allow(clippy::result_large_err)]
async fn authorize(
    sh: &Shared,
    headers: &HeaderMap,
    q: &HashMap<String, String>,
    body: &Value,
) -> Result<(), Response> {
    let given = headers
        .get("x-stream-key")
        .and_then(|v| v.to_str().ok())
        .filter(|s| !s.is_empty())
        .or_else(|| q.get("key").map(String::as_str))
        .or_else(|| body.get("stream_key").and_then(Value::as_str));
    let expected = sh.settings.lock().await.data.forward.stream_key.clone();
    match (given, expected) {
        (Some(g), Some(e)) if !e.is_empty() && key_eq(g, &e) => Ok(()),
        _ => Err(fail(StatusCode::UNAUTHORIZED, "unauthorized")),
    }
}

fn parse(body: &Bytes) -> Value {
    serde_json::from_slice(body).unwrap_or(Value::Null)
}

/// Non-empty string field (`job_id`), or a number/string id rendered as text.
fn text_field(body: &Value, field: &str) -> Option<String> {
    match body.get(field)? {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

async fn events(
    State(sh): State<Arc<Shared>>,
    headers: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    if let Err(r) = authorize(&sh, &headers, &q, &Value::Null).await {
        return r;
    }
    let since = q
        .get("since")
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);
    let mut room = sh.room();
    room.last_poll_ms = Some(crate::types::now_ms());
    let events = room.since(since);
    Json(json!({"cursor": room.cursor, "events": events})).into_response()
}

/// External producers (test scripts, another launcher) — same as the relay.
async fn ingest(
    State(sh): State<Arc<Shared>>,
    headers: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
    body: Bytes,
) -> Response {
    let body = parse(&body);
    if let Err(r) = authorize(&sh, &headers, &q, &body).await {
        return r;
    }
    if !body.is_object() {
        return fail(StatusCode::BAD_REQUEST, "bad_request");
    }
    sh.room().push(body);
    ok()
}

async fn claim(
    State(sh): State<Arc<Shared>>,
    headers: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
    body: Bytes,
) -> Response {
    let body = parse(&body);
    if let Err(r) = authorize(&sh, &headers, &q, &body).await {
        return r;
    }
    let Some(job) = text_field(&body, "job_id") else {
        return fail(StatusCode::BAD_REQUEST, "bad_request");
    };
    let mut room = sh.room();
    match &room.claimed_job_id {
        Some(cur) if cur != &job => fail(StatusCode::CONFLICT, "already_claimed"),
        _ => {
            room.claimed_job_id = Some(job);
            ok()
        }
    }
}

async fn release(
    State(sh): State<Arc<Shared>>,
    headers: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
    body: Bytes,
) -> Response {
    let body = parse(&body);
    if let Err(r) = authorize(&sh, &headers, &q, &body).await {
        return r;
    }
    let Some(job) = text_field(&body, "job_id") else {
        return fail(StatusCode::BAD_REQUEST, "bad_request");
    };
    let mut room = sh.room();
    if room.claimed_job_id.as_deref() == Some(job.as_str()) {
        room.claimed_job_id = None;
    }
    ok()
}

/// Binds the key to one Roblox UserId (anti-sharing, like the relay).
async fn validate(
    State(sh): State<Arc<Shared>>,
    headers: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
    body: Bytes,
) -> Response {
    let body = parse(&body);
    if let Err(r) = authorize(&sh, &headers, &q, &body).await {
        return r;
    }
    let Some(uid) = text_field(&body, "roblox_user_id") else {
        return fail(StatusCode::BAD_REQUEST, "bad_request");
    };
    let mut room = sh.room();
    match &room.bound_user_id {
        Some(cur) if cur != &uid => fail(StatusCode::CONFLICT, "bound_to_other_user"),
        _ => {
            room.bound_user_id = Some(uid);
            ok()
        }
    }
}

/// Dev counterpart of the server's `POST /api/stream/redeem`: any
/// non-empty ticket + `roblox_user_id` hands back the launcher's stream
/// key and binds the uid, letting Studio exercise the same
/// launchData→redeem code path the production game uses. Dev-mode only —
/// the bridge itself never runs for regular users.
async fn redeem(State(sh): State<Arc<Shared>>, body: Bytes) -> Response {
    let body = parse(&body);
    let ticket = body.get("ticket").and_then(Value::as_str).unwrap_or("");
    if ticket.is_empty() {
        return fail(StatusCode::UNAUTHORIZED, "invalid_ticket");
    }
    let Some(uid) = text_field(&body, "roblox_user_id") else {
        return fail(StatusCode::BAD_REQUEST, "bad_request");
    };
    let key = sh
        .settings
        .lock()
        .await
        .data
        .forward
        .stream_key
        .clone()
        .filter(|k| !k.is_empty());
    let Some(key) = key else {
        return fail(StatusCode::UNAUTHORIZED, "invalid_key");
    };
    {
        let mut room = sh.room();
        match &room.bound_user_id {
            Some(cur) if cur != &uid => return fail(StatusCode::CONFLICT, "bound_to_other_user"),
            _ => room.bound_user_id = Some(uid.clone()),
        }
    }
    Json(json!({"ok": true, "stream_key": key, "roblox_user_id": uid})).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::StreamEvent;

    fn ev(cmd: &str) -> StreamEvent {
        StreamEvent {
            source: "simulator".into(),
            event_kind: "gift".into(),
            user: "viewer".into(),
            avatar_url: String::new(),
            raw_name: "Lion".into(),
            amount: 1,
            action_command: cmd.into(),
            event_id: String::new(),
        }
    }

    #[test]
    fn stale_cursor_after_restart_replays_from_zero() {
        let mut room = Room::default();
        room.push(json!({"n": 1}));
        room.push(json!({"n": 2}));
        assert_eq!(room.since(1).len(), 1);
        // The place still holds cursor 40 from before a launcher restart.
        assert_eq!(room.since(40).len(), 2);
        assert_eq!(room.since(2).len(), 0);
    }

    #[test]
    fn queue_is_capped() {
        let mut room = Room::default();
        for i in 0..QUEUE_CAP + 10 {
            room.push(json!({ "n": i }));
        }
        assert_eq!(room.events.len(), QUEUE_CAP);
        assert_eq!(room.cursor, (QUEUE_CAP + 10) as u64);
    }

    /// The `RelayClient.lua` call sequence end to end: validate → claim →
    /// hub event → poll by cursor → release; foreign user/job → 409.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn relay_client_flow() {
        let dir = std::env::temp_dir().join(format!("rbx-bridge-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let settings = Arc::new(Mutex::new(SettingsStore::load(&dir)));
        settings.lock().await.data.forward.stream_key = Some("sk_test".into());
        let hub = EventHub::new();
        let bridge = RobloxBridge::new(&hub, settings);
        let port = bridge.start(0).await.unwrap();
        let base = format!("http://127.0.0.1:{port}");
        let http = reqwest::Client::new();
        let post = |path: &str, body: Value| {
            http.post(format!("{base}{path}"))
                .header("X-Stream-Key", body["stream_key"].as_str().unwrap_or(""))
                .json(&body)
                .send()
        };

        let r = post(
            "/api/stream/validate",
            json!({"stream_key": "nope", "roblox_user_id": 1}),
        )
        .await
        .unwrap();
        assert_eq!(r.status(), 401);
        let r = post(
            "/api/stream/validate",
            json!({"stream_key": "sk_test", "roblox_user_id": 111}),
        )
        .await
        .unwrap();
        assert_eq!(r.status(), 200);
        let r = post(
            "/api/stream/validate",
            json!({"stream_key": "sk_test", "roblox_user_id": 222}),
        )
        .await
        .unwrap();
        assert_eq!(r.status(), 409);

        // The ticket-redeem path hands back the same dev key the server
        // would return as a room credential in production.
        let r = http
            .post(format!("{base}/api/stream/redeem"))
            .json(&json!({"ticket": "any-dev-ticket", "roblox_user_id": 111}))
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 200);
        assert_eq!(r.json::<Value>().await.unwrap()["stream_key"], "sk_test");

        let claim = |job: &str| {
            post(
                "/api/stream/claim",
                json!({"stream_key": "sk_test", "job_id": job}),
            )
        };
        assert_eq!(claim("studio-1").await.unwrap().status(), 200);
        assert_eq!(claim("other").await.unwrap().status(), 409);

        for _ in 0..200 {
            if hub.tx.receiver_count() >= 1 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        hub.dispatch(ev("spawn_chaser"));
        let mut body = Value::Null;
        for _ in 0..100 {
            body = http
                .get(format!("{base}/api/stream/events?key=sk_test&since=0"))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            if body["cursor"].as_u64() > Some(0) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(body["events"][0]["action_command"], "spawn_chaser");
        assert_eq!(body["events"][0]["type"], "event");
        let cursor = body["cursor"].as_u64().unwrap();
        let again: Value = http
            .get(format!(
                "{base}/api/stream/events?key=sk_test&since={cursor}"
            ))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(again["events"].as_array().unwrap().len(), 0);

        let r = post(
            "/api/stream/release",
            json!({"stream_key": "sk_test", "job_id": "studio-1"}),
        )
        .await
        .unwrap();
        assert_eq!(r.status(), 200);
        assert_eq!(claim("other").await.unwrap().status(), 200);

        let st = bridge.status().await;
        assert!(st.running && st.last_poll_ms.is_some());
        assert_eq!(st.bound_user_id.as_deref(), Some("111"));
        bridge.stop().await;
        assert!(!bridge.status().await.running);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
