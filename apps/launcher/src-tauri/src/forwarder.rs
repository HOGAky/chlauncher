//! HTTP-forward of mapped `StreamEvent`s to a cloud relay (Roblox games).
//!
//! See `docs/roblox-integration.md`: cloud-hosted games (no WebSocket
//! client, no local process) poll a standalone relay; the launcher is the
//! producer. This module is a third consumer on `EventHub.tx`, next to
//! the game WS and overlay WS:
//!
//! ```text
//! EventHub ── broadcast ──► queue (500) ──► POST {forward_url}/api/stream/ingest
//!                                        X-Stream-Key: {stream_key}
//! ```
//!
//! Delivery is fire-and-forget with a 5 s timeout — relay outages must
//! never stall the local pipeline. Separately, a renewal loop keeps the
//! stream key registered on the relay (`POST /api/admin/register`) while
//! the subscription is active, so `valid_until` outlives the launcher
//! by ≤ 24 h and lapses when the subscription does.

use serde::Serialize;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{broadcast, mpsc, Mutex};

use crate::api::ApiClient;
use crate::events::EventHub;
use crate::settings::{ForwardSettings, SettingsStore};
use crate::types::StreamEvent;

/// Bounded queue depth — drops lag behind this are counted and discarded.
const QUEUE_CAPACITY: usize = 500;
/// Per-request timeout for relay calls.
const REQ_TIMEOUT: Duration = Duration::from_secs(5);
/// How often the stream key registration is renewed while enabled.
const RENEW_INTERVAL: Duration = Duration::from_secs(12 * 60 * 60);
/// `valid_until` window pushed to the relay per registration (seconds).
const VALID_WINDOW_SECS: i64 = 24 * 60 * 60;

/// Bounded drop-oldest queue shared by the hub consumer and the ingest
/// worker (an mpsc channel cannot evict the oldest from the producer
/// side). `push` reports whether it had to evict.
#[derive(Default)]
struct EventQueue {
    dq: Mutex<std::collections::VecDeque<StreamEvent>>,
    notify: tokio::sync::Notify,
}

impl EventQueue {
    /// Appends an event; evicts the oldest when at capacity (false then).
    async fn push(&self, ev: StreamEvent) -> bool {
        let evicted = {
            let mut dq = self.dq.lock().await;
            let evicted = dq.len() >= QUEUE_CAPACITY;
            if evicted {
                dq.pop_front();
            }
            dq.push_back(ev);
            evicted
        };
        self.notify.notify_one();
        !evicted
    }

    /// Waits for and removes the oldest queued event.
    async fn pop(&self) -> Option<StreamEvent> {
        loop {
            {
                let mut dq = self.dq.lock().await;
                if let Some(ev) = dq.pop_front() {
                    return Some(ev);
                }
            }
            self.notify.notified().await;
        }
    }
}

/// Formats unix seconds as `YYYY-MM-DDTHH:MM:SSZ` (UTC) — enough for the
/// relay's `valid_until` field without pulling in a date crate.
fn rfc3339_utc(secs: i64) -> String {
    // civil-from-days (H. Hinnant's algorithm)
    let z = secs.div_euclid(86400) + 719468;
    let era = z.div_euclid(146097);
    let doe = z.rem_euclid(146097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    let t = secs.rem_euclid(86400);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        t / 3600,
        t % 3600 / 60,
        t % 60
    )
}

/// Runtime view of the forwarder for the UI.
#[derive(Debug, Default, Clone, Serialize)]
pub struct ForwardStatus {
    /// Events currently waiting for the relay.
    pub queued: u32,
    /// Events dropped because the queue was full or the relay lagged.
    pub dropped: u64,
    /// Events successfully POSTed to `/api/stream/ingest`.
    pub delivered: u64,
    /// Last ingest error (human readable), cleared on success.
    pub last_error: Option<String>,
    /// Last successful admin-register time (RFC3339) and expiry pushed.
    pub registered_until: Option<String>,
}

/// The forwarder service: broadcast consumer + bounded worker queue.
pub struct Forwarder {
    status: Arc<Mutex<ForwardStatus>>,
    /// Wakes the register task immediately (on enable/regenerate).
    register_tx: mpsc::Sender<()>,
    /// Shared with the worker — the exit flush drains what is left.
    queue: Arc<EventQueue>,
}

impl Forwarder {
    /// Spawns the ingest consumer and the key-renewal loop.
    pub fn start(hub: &EventHub, settings: Arc<Mutex<SettingsStore>>, api: ApiClient) -> Arc<Self> {
        let (register_tx, register_rx) = mpsc::channel::<()>(4);
        let status = Arc::new(Mutex::new(ForwardStatus::default()));

        // Bounded drop-oldest queue: VecDeque + Notify (an mpsc channel
        // can't evict the oldest from the producer side).
        let queue = Arc::new(EventQueue::default());

        // Producer: hub broadcast → bounded queue (drop OLDEST on overflow).
        {
            let mut rx = hub.tx.subscribe();
            let queue = queue.clone();
            let status = status.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    match rx.recv().await {
                        Ok(ev) => {
                            if queue.push(ev).await {
                                status.lock().await.queued += 1;
                            } else {
                                status.lock().await.dropped += 1;
                            }
                        }
                        Err(broadcast::error::RecvError::Lagged(_)) => {
                            status.lock().await.dropped += 1;
                        }
                        Err(broadcast::error::RecvError::Closed) => break,
                    }
                }
            });
        }
        // Worker: queue → POST /api/stream/ingest.
        {
            let settings = settings.clone();
            let status = status.clone();
            let queue = queue.clone();
            let api = api.clone();
            tauri::async_runtime::spawn(async move {
                Self::ingest_worker(queue, settings, api, status).await;
            });
        }
        // Renewal: startup + every 12h + on-demand → POST /api/admin/register.
        {
            let settings = settings.clone();
            let status = status.clone();
            tauri::async_runtime::spawn(Self::renew_loop(register_rx, settings, api, status));
        }

        Arc::new(Self {
            status,
            register_tx,
            queue,
        })
    }

    /// Exit grace: drains whatever the worker did not deliver, bounded by
    /// `budget` — undelivered events must not be silently lost on quit.
    /// The worker keeps racing us for pops; either way the queue empties.
    pub async fn flush(
        &self,
        settings: &Arc<Mutex<SettingsStore>>,
        api: &ApiClient,
        budget: Duration,
    ) {
        let deadline = std::time::Instant::now() + budget;
        let http = reqwest::Client::builder()
            .timeout(REQ_TIMEOUT)
            .build()
            .unwrap_or_default();
        loop {
            let ev = {
                let mut dq = self.queue.dq.lock().await;
                dq.pop_front()
            };
            let Some(ev) = ev else { break };
            if std::time::Instant::now() >= deadline {
                break;
            }
            let (cfg, token) = {
                let s = settings.lock().await;
                (s.data.forward.clone(), s.data.auth_token.clone())
            };
            if !cfg.enabled {
                continue;
            }
            let _ = Self::send_one(&http, &cfg, token.as_deref(), api, &ev).await;
        }
    }

    /// Current status snapshot for the UI.
    pub async fn snapshot(&self) -> ForwardStatus {
        self.status.lock().await.clone()
    }

    /// Asks the renewal task to push a fresh `valid_until` right now.
    pub async fn register_now(&self) {
        let _ = self.register_tx.send(()).await;
    }

    /// Drains the queue: every event → `POST {url}/api/stream/ingest`.
    /// `forward_url` empty = the licensing server itself hosts the relay
    /// (routes/stream.js) — then the JWT is the credential and no
    /// `relay_admin_secret` is ever needed. When a stream key is set it
    /// is sent too, keeping compatibility with the standalone relay.
    async fn ingest_worker(
        queue: Arc<EventQueue>,
        settings: Arc<Mutex<SettingsStore>>,
        api: ApiClient,
        status: Arc<Mutex<ForwardStatus>>,
    ) {
        let http = reqwest::Client::builder()
            .timeout(REQ_TIMEOUT)
            .build()
            .unwrap_or_default();
        while let Some(ev) = queue.pop().await {
            // The event is dequeued now — `queued` must drop regardless
            // of whether it ends up delivered or skipped (disabled /
            // misconfigured forwarding would otherwise leak the counter).
            {
                let mut st = status.lock().await;
                st.queued = st.queued.saturating_sub(1);
            }
            let (cfg, token) = {
                let s = settings.lock().await;
                (s.data.forward.clone(), s.data.auth_token.clone())
            };
            if !cfg.enabled {
                continue;
            }
            let mut st = status.lock().await;
            match Self::send_one(&http, &cfg, token.as_deref(), &api, &ev).await {
                Ok(()) => {
                    st.delivered += 1;
                    st.last_error = None;
                }
                Err(e) => {
                    st.dropped += 1;
                    st.last_error = Some(e);
                }
            }
        }
    }

    /// One `POST {url}/api/stream/ingest` attempt. `forward_url` empty =
    /// the licensing server itself hosts the relay — then the JWT is the
    /// credential. `X-Stream-Key` rides along when set for standalone-
    /// relay compatibility (the server prefers the JWT).
    async fn send_one(
        http: &reqwest::Client,
        cfg: &ForwardSettings,
        token: Option<&str>,
        api: &ApiClient,
        ev: &StreamEvent,
    ) -> Result<(), String> {
        let url = cfg
            .forward_url
            .clone()
            .filter(|u| !u.trim().is_empty())
            .unwrap_or_else(|| api.base());
        let mut req = http
            .post(format!("{}/api/stream/ingest", url.trim_end_matches('/')))
            .json(&event_body(ev));
        if let Some(t) = token {
            req = req.bearer_auth(t);
        }
        if let Some(key) = cfg.stream_key.clone().filter(|k| !k.is_empty()) {
            req = req.header("X-Stream-Key", key);
        }
        match req.send().await {
            Ok(r) if r.status().is_success() => Ok(()),
            Ok(r) => Err(format!("relay {}", r.status())),
            Err(e) => Err(format!("{e}")),
        }
    }

    /// Registers/renews the stream key on the relay:
    /// on demand (channel), at startup, and on a 12 h timer — but only
    /// while enabled AND the subscription is active.
    async fn renew_loop(
        mut rx: mpsc::Receiver<()>,
        settings: Arc<Mutex<SettingsStore>>,
        api: ApiClient,
        status: Arc<Mutex<ForwardStatus>>,
    ) {
        let mut tick = tokio::time::interval(RENEW_INTERVAL);
        loop {
            tokio::select! {
                _ = tick.tick() => {}
                _ = rx.recv() => {}
            }
            let cfg = settings.lock().await.data.forward.clone();
            if !cfg.enabled {
                continue;
            }
            if let Err(e) = Self::register_once(&settings, &api, &cfg, &status).await {
                status.lock().await.last_error = Some(format!("register: {e}"));
            }
        }
    }

    /// One `POST {url}/api/admin/register` call. `valid_until` is
    /// `min(subscription_end, now+24h)`; skipped entirely when the
    /// subscription is expired (the relay then 402s stale keys itself).
    async fn register_once(
        settings: &Arc<Mutex<SettingsStore>>,
        api: &ApiClient,
        cfg: &ForwardSettings,
        status: &Arc<Mutex<ForwardStatus>>,
    ) -> Result<(), String> {
        // Server-hosted relay needs no admin registration — key validity
        // derives from the subscription server-side. The standalone
        // relay still requires the admin secret.
        let url = cfg
            .forward_url
            .clone()
            .filter(|u| !u.trim().is_empty())
            .unwrap_or_else(|| api.base());
        let server_mode = url.trim_end_matches('/') == api.base().trim_end_matches('/');
        if server_mode {
            return Ok(());
        }
        let (Some(key), Some(secret)) = (cfg.stream_key.clone(), cfg.relay_admin_secret.clone())
        else {
            return Err("stream_key / admin_secret не заданы для стороннего релея".into());
        };
        let token = settings
            .lock()
            .await
            .data
            .auth_token
            .clone()
            .ok_or("NOT_AUTHENTICATED")?;
        let sub = api.subscription(&token).await.map_err(|e| e.to_string())?;
        if sub.status != "active" {
            return Err("подписка не активна — ключ не продлен".into());
        }

        // valid_until = min(subscription_end, now + 24h); subscription_end
        // is approximated by days_left (server granularity). A sub ending
        // today still gets a 1 h floor — renewal runs every 12 h anyway.
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        let secs = (sub.days_left.max(0) * 86400).clamp(3600, VALID_WINDOW_SECS);
        let valid_until = rfc3339_utc(now + secs);

        let http = reqwest::Client::builder()
            .timeout(REQ_TIMEOUT)
            .build()
            .unwrap_or_default();
        let res = http
            .post(format!("{}/api/admin/register", url.trim_end_matches('/')))
            .header("X-Admin-Secret", secret)
            .json(&json!({
                "stream_key": key,
                "valid_until": valid_until,
            }))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !res.status().is_success() {
            return Err(format!("relay {}", res.status()));
        }
        status.lock().await.registered_until = Some(valid_until);
        Ok(())
    }
}

/// Wire body for `POST /api/stream/ingest`: flat StreamEvent + `"type"`.
pub(crate) fn event_body(ev: &StreamEvent) -> Value {
    let mut v = serde_json::to_value(ev).unwrap_or_else(|_| json!({}));
    if let Value::Object(ref mut m) = v {
        m.insert("type".into(), json!("event"));
    }
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(kind: &str) -> StreamEvent {
        StreamEvent {
            source: "simulator".into(),
            event_kind: kind.into(),
            user: "u".into(),
            avatar_url: String::new(),
            raw_name: "Rose".into(),
            amount: 1,
            action_command: "log_only".into(),
            event_id: String::new(),
        }
    }

    #[tokio::test]
    async fn queue_drops_oldest_on_overflow() {
        let q = EventQueue::default();
        // Fill to capacity + 2 extra pushes → the two oldest must be gone.
        for i in 0..QUEUE_CAPACITY + 2 {
            q.push(ev(&format!("e{i}"))).await;
        }
        let first = q.pop().await.unwrap();
        assert_eq!(first.event_kind, "e2");
        // The newest is still at the tail (queue held CAPACITY-1 more).
        let mut last = first;
        for _ in 0..QUEUE_CAPACITY - 1 {
            last = q.pop().await.unwrap();
        }
        assert_eq!(last.event_kind, format!("e{}", QUEUE_CAPACITY + 1));
    }

    #[test]
    fn rfc3339_roundtrip_epoch() {
        assert_eq!(rfc3339_utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(rfc3339_utc(1794000318), "2026-11-06T21:25:18Z");
    }

    /// Regression: a dequeued-but-skipped event (forwarding disabled or
    /// missing URL/key) used to leave `queued` incremented forever —
    /// the UI counter drifted upward with every skipped event.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn queued_metric_returns_to_zero_when_disabled() {
        let hub = EventHub::new();
        let dir = std::env::temp_dir().join(format!("fw-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let settings = Arc::new(Mutex::new(SettingsStore::load(&dir)));
        // forward.enabled defaults to false — events will be skipped.
        let api = ApiClient::new("http://127.0.0.1:1".into());
        let fwd = Forwarder::start(&hub, settings, api);
        // Wait for the producer task to subscribe — otherwise the test
        // would pass vacuously with the events simply never queued.
        for _ in 0..200 {
            if hub.tx.receiver_count() >= 1 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(hub.tx.receiver_count() >= 1, "forwarder never subscribed");
        for _ in 0..5 {
            hub.note(ev("gift"), "done");
        }
        let mut snap = fwd.snapshot().await;
        for _ in 0..200 {
            snap = fwd.snapshot().await;
            if snap.queued == 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(snap.queued, 0, "queued leaked: {snap:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
