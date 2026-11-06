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
/// `valid_until` window pushed to the relay per registration.
const VALID_WINDOW: chrono::Duration = chrono::Duration::hours(24);

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
}

impl Forwarder {
    /// Spawns the ingest consumer and the key-renewal loop.
    pub fn start(
        hub: &EventHub,
        settings: Arc<Mutex<SettingsStore>>,
        api: ApiClient,
    ) -> Arc<Self> {
        let (register_tx, register_rx) = mpsc::channel::<()>(4);
        let status = Arc::new(Mutex::new(ForwardStatus::default()));

        // Producer: hub broadcast → bounded queue (drop on overflow).
        let (qtx, qrx) = mpsc::channel::<StreamEvent>(QUEUE_CAPACITY);
        {
            let mut rx = hub.tx.subscribe();
            let status = status.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    match rx.recv().await {
                        Ok(ev) => {
                            if qtx.try_send(ev).is_ok() {
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
            tauri::async_runtime::spawn(Self::ingest_worker(qrx, settings, status));
        }
        // Renewal: startup + every 12h + on-demand → POST /api/admin/register.
        {
            let settings = settings.clone();
            let status = status.clone();
            tauri::async_runtime::spawn(Self::renew_loop(
                register_rx, settings, api, status,
            ));
        }

        Arc::new(Self {
            status,
            register_tx,
        })
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
    async fn ingest_worker(
        mut qrx: mpsc::Receiver<StreamEvent>,
        settings: Arc<Mutex<SettingsStore>>,
        status: Arc<Mutex<ForwardStatus>>,
    ) {
        let http = reqwest::Client::builder()
            .timeout(REQ_TIMEOUT)
            .build()
            .unwrap_or_default();
        while let Some(ev) = qrx.recv().await {
            let cfg = settings.lock().await.data.forward.clone();
            let (Some(url), Some(key)) = (cfg.forward_url, cfg.stream_key) else {
                continue;
            };
            if !cfg.enabled || url.is_empty() || key.is_empty() {
                continue;
            }
            {
                let mut st = status.lock().await;
                st.queued = st.queued.saturating_sub(1);
            }
            let body = event_body(&ev);
            let res = http
                .post(format!("{}/api/stream/ingest", url.trim_end_matches('/')))
                .header("X-Stream-Key", &key)
                .json(&body)
                .send()
                .await;
            let mut st = status.lock().await;
            match res {
                Ok(r) if r.status().is_success() => {
                    st.delivered += 1;
                    st.last_error = None;
                }
                Ok(r) => {
                    st.dropped += 1;
                    st.last_error = Some(format!("relay {}", r.status()));
                }
                Err(e) => {
                    st.dropped += 1;
                    st.last_error = Some(format!("{e}"));
                }
            }
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
        let (Some(url), Some(key), Some(secret)) = (
            cfg.forward_url.clone(),
            cfg.stream_key.clone(),
            cfg.relay_admin_secret.clone(),
        ) else {
            return Err("forward_url / stream_key / admin_secret не заданы".into());
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

        let cap = chrono::Utc::now() + VALID_WINDOW;
        let valid_until = sub
            .current_period_end
            .as_deref()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|d| d.with_timezone(&chrono::Utc))
            .map(|end| end.min(cap))
            .unwrap_or(cap);

        let http = reqwest::Client::builder()
            .timeout(REQ_TIMEOUT)
            .build()
            .unwrap_or_default();
        let res = http
            .post(format!(
                "{}/api/admin/register",
                url.trim_end_matches('/')
            ))
            .header("X-Admin-Secret", secret)
            .json(&json!({
                "stream_key": key,
                "valid_until": valid_until.to_rfc3339(),
            }))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !res.status().is_success() {
            return Err(format!("relay {}", res.status()));
        }
        status.lock().await.registered_until = Some(valid_until.to_rfc3339());
        Ok(())
    }
}

/// Wire body for `POST /api/stream/ingest`: flat StreamEvent + `"type"`.
fn event_body(ev: &StreamEvent) -> Value {
    let mut v = serde_json::to_value(ev).unwrap_or_else(|_| json!({}));
    if let Value::Object(ref mut m) = v {
        m.insert("type".into(), json!("event"));
    }
    v
}
