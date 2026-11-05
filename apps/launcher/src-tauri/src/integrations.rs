//! External stream integrations: TikTok Live + DonationAlerts.
//!
//! Architecture: a single `mpsc` ingest channel carries [`RawStreamEvent`]s
//! from every source (real integrations AND the built-in simulator) to the
//! trigger-mapper task, which turns them into game-ready [`StreamEvent`]s.
//! Games never touch the network — this module is the only internet-facing
//! edge besides the licensing API.
//!
//! ## TikTok
//! Public webcast access requires TikTok's signing infrastructure which is
//! not available offline, so the connector performs **best-effort room
//! detection**: it polls `tiktok.com/@<user>/live` and reports
//! Disconnected/Connecting/Live transitions. Gift/like/comment ingestion is
//! exercised end-to-end through the built-in simulator; the seam for a real
//! webcast client is `TikTokConnector`'s poll task.
//!
//! ## DonationAlerts
//! Implements the community-documented Centrifugo flow:
//! `GET /api/v1/user/oauth` → `GET /api/v1/centrifuge/token` →
//! `wss://centrifugo.donationalerts.com` → subscribe `$alerts:donation_<uid>`.

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, Mutex};
use tokio::task::JoinHandle;

use crate::types::{IntegrationStatus, RawStreamEvent};

/// Tauri event emitted whenever an integration's status changes.
pub const STATUS_EVENT: &str = "integration-status";

/// Aggregates both connectors and their task handles.
pub struct IntegrationManager {
    pub tiktok_status: Arc<Mutex<IntegrationStatus>>,
    pub tiktok_username: Arc<Mutex<Option<String>>>,
    tiktok_task: Mutex<Option<JoinHandle<()>>>,
    pub da_status: Arc<Mutex<IntegrationStatus>>,
    da_task: Mutex<Option<JoinHandle<()>>>,
    /// Ingest channel toward the mapper (shared with the simulator).
    raw_tx: mpsc::Sender<RawStreamEvent>,
    app: AppHandle,
}

impl IntegrationManager {
    pub fn new(raw_tx: mpsc::Sender<RawStreamEvent>, app: AppHandle) -> Self {
        Self {
            tiktok_status: Arc::new(Mutex::new(IntegrationStatus::Disconnected)),
            tiktok_username: Arc::new(Mutex::new(None)),
            tiktok_task: Mutex::new(None),
            da_status: Arc::new(Mutex::new(IntegrationStatus::Disconnected)),
            da_task: Mutex::new(None),
            raw_tx,
            app,
        }
    }

    /// Sets a status and notifies the frontend.
    async fn set_status(&self, which: &str, st: IntegrationStatus) {
        let (target, is_tiktok) = match which {
            "tiktok" => (&self.tiktok_status, true),
            _ => (&self.da_status, false),
        };
        *target.lock().await = st.clone();
        let username: Option<String> = if is_tiktok {
            self.tiktok_username.lock().await.clone()
        } else {
            None
        };
        let _ = self.app.emit(
            STATUS_EVENT,
            json!({
                "integration": which,
                "status": st,
                "username": username,
            }),
        );
    }

    /// Connects to a public TikTok Live room by username (best-effort
    /// presence detection; see module docs for the limitation).
    pub async fn tiktok_connect(&self, username: String) -> Result<(), String> {
        self.tiktok_disconnect().await;
        *self.tiktok_username.lock().await = Some(username.clone());
        self.set_status("tiktok", IntegrationStatus::Connecting).await;

        let status = self.tiktok_status.clone();
        let app = self.app.clone();
        let raw_tx = self.raw_tx.clone();
        let handle = tokio::spawn(async move {
            let http = reqwest::Client::builder()
                .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) chlauncher/0.1")
                .timeout(Duration::from_secs(15))
                .build()
                .unwrap_or_default();
            let url = format!("https://www.tiktok.com/@{username}/live");
            let mut was_live = false;
            loop {
                match http.get(&url).send().await {
                    Ok(res) => {
                        let body = res.text().await.unwrap_or_default();
                        // Heuristic markers of an active room in the live page.
                        let live = body.contains("\"status\":2")
                            || body.contains("roomId")
                            || body.contains("isLiveBroadcast");
                        let st = if live {
                            IntegrationStatus::Live
                        } else {
                            IntegrationStatus::Connected
                        };
                        *status.lock().await = st.clone();
                        let _ = app.emit(
                            STATUS_EVENT,
                            json!({"integration":"tiktok","status":st,"username":username}),
                        );
                        // Surface first live detection in the feed.
                        if live && !was_live {
                            let _ = raw_tx
                                .send(RawStreamEvent {
                                    source: "tiktok".into(),
                                    event_kind: "system".into(),
                                    user: username.clone(),
                                    avatar_url: String::new(),
                                    raw_name: "room_live_detected".into(),
                                    amount: 0,
                                })
                                .await;
                        }
                        was_live = live;
                    }
                    Err(e) => {
                        *status.lock().await =
                            IntegrationStatus::Error(format!("fetch failed: {e}"));
                        let _ = app.emit(
                            STATUS_EVENT,
                            json!({"integration":"tiktok",
                                   "status":IntegrationStatus::Error(e.to_string()),
                                   "username":username}),
                        );
                        break;
                    }
                }
                tokio::time::sleep(Duration::from_secs(20)).await;
            }
        });
        *self.tiktok_task.lock().await = Some(handle);
        Ok(())
    }

    /// Disconnects TikTok polling.
    pub async fn tiktok_disconnect(&self) {
        if let Some(h) = self.tiktok_task.lock().await.take() {
            h.abort();
        }
        self.set_status("tiktok", IntegrationStatus::Disconnected).await;
    }

    /// Connects DonationAlerts realtime donations via Centrifugo.
    /// `token` is the streamer's OAuth access token.
    pub async fn da_connect(&self, token: String) -> Result<(), String> {
        self.da_disconnect().await;
        self.set_status("da", IntegrationStatus::Connecting).await;

        let status = self.da_status.clone();
        let app = self.app.clone();
        let raw_tx = self.raw_tx.clone();
        let handle = tokio::spawn(async move {
            if let Err(e) = run_da(token, raw_tx, status.clone()).await {
                *status.lock().await = IntegrationStatus::Error(e.clone());
                let _ = app.emit(
                    STATUS_EVENT,
                    json!({"integration":"donationalerts",
                           "status":IntegrationStatus::Error(e)}),
                );
            }
        });
        *self.da_task.lock().await = Some(handle);
        Ok(())
    }

    /// Disconnects DonationAlerts.
    pub async fn da_disconnect(&self) {
        if let Some(h) = self.da_task.lock().await.take() {
            h.abort();
        }
        self.set_status("da", IntegrationStatus::Disconnected).await;
    }

    /// Current status snapshot for the UI bootstrap.
    pub async fn snapshot(&self) -> Value {
        json!({
            "tiktok": *self.tiktok_status.lock().await,
            "tiktok_username": *self.tiktok_username.lock().await,
            "donationalerts": *self.da_status.lock().await,
        })
    }
}

/// DonationAlerts Centrifugo session — community-documented flow.
async fn run_da(
    token: String,
    raw_tx: mpsc::Sender<RawStreamEvent>,
    status: Arc<Mutex<IntegrationStatus>>,
) -> Result<(), String> {
    let http = reqwest::Client::new();

    // 1) Resolve the user id for the token.
    let user: Value = http
        .get("https://www.donationalerts.com/api/v1/user/oauth")
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| format!("oauth lookup: {e}"))?
        .json()
        .await
        .map_err(|e| format!("oauth parse: {e}"))?;
    let user_id = user["data"]["id"]
        .as_i64()
        .ok_or_else(|| "oauth: no user id".to_string())?;

    // 2) Fetch the Centrifugo socket token.
    let tok: Value = http
        .get("https://www.donationalerts.com/api/v1/centrifuge/token")
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| format!("centrifuge token: {e}"))?
        .json()
        .await
        .map_err(|e| format!("centrifuge token parse: {e}"))?;
    let socket_token = tok["data"]["token"]
        .as_str()
        .ok_or_else(|| "centrifuge: no socket token".to_string())?
        .to_string();

    // 3) Open the Centrifugo socket and handshake.
    let (ws, _) =
        tokio_tungstenite::connect_async("wss://centrifugo.donationalerts.com/connection/websocket")
            .await
            .map_err(|e| format!("ws connect: {e}"))?;
    let (mut tx, mut rx) = ws.split();

    tx.send(json!({"params":{"token":socket_token,"name":"js"},"id":1}).to_string().into())
        .await
        .map_err(|e| e.to_string())?;

    // 4) Subscribe to the donation alerts channel.
    let channel = format!("$alerts:donation_{user_id}");
    tx.send(json!({"params":{"channel":channel},"id":2}).to_string().into())
        .await
        .map_err(|e| e.to_string())?;

    *status.lock().await = IntegrationStatus::Live;

    // 5) Forward alerts into the ingest channel.
    while let Some(msg) = rx.next().await {
        let Ok(tokio_tungstenite::tungstenite::Message::Text(text)) = msg else {
            continue;
        };
        let Ok(v) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        // Centrifugo push → {"result":{"channel":…,"data":{"data":{…}}}}
        let data = &v["result"]["data"]["data"];
        if data.is_null() {
            continue;
        }
        let username = data["username"].as_str().unwrap_or("donor").to_string();
        let amount = data["amount_main"]
            .as_f64()
            .or_else(|| data["amount"].as_f64())
            .unwrap_or(0.0);
        let message = data["message"].as_str().unwrap_or("").to_string();
        let _ = raw_tx
            .send(RawStreamEvent {
                source: "donationalerts".into(),
                event_kind: "donation".into(),
                user: username,
                avatar_url: String::new(),
                raw_name: message,
                amount: (amount * 100.0) as i32, // minor units
            })
            .await;
    }
    Err("socket closed".into())
}
