//! External stream integrations: TikTok Live + DonationAlerts.
//!
//! Architecture: a single `mpsc` ingest channel carries [`RawStreamEvent`]s
//! from every source (real integrations AND the built-in simulator) to the
//! trigger-mapper task, which turns them into game-ready [`StreamEvent`]s.
//! Games never touch the network — this module is the only internet-facing
//! edge besides the licensing API.
//!
//! ## TikTok
//! Real TikTok LIVE ingestion through a Node.js sidecar
//! (`tools/tiktok-sidecar`) running `tiktok-live-connector` — the actively
//! maintained unofficial webcast client, signed via EulerStream's free
//! tier. The launcher spawns `node index.js <username>` and reads
//! normalized NDJSON events from its stdout (gifts/likes/comments/
//! joins/follows/shares/subs). `EULERSTREAM_API_KEY` raises signing rate
//! limits; the free tier works without it.
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
use tokio::io::AsyncBufReadExt;
use tokio::sync::{mpsc, Mutex};
use tokio::task::JoinHandle;

use crate::types::{IntegrationStatus, RawStreamEvent};

/// Tauri event emitted whenever an integration's status changes.
pub const STATUS_EVENT: &str = "integration-status";

/// Aggregates both connectors and their task handles.
pub struct IntegrationManager {
    pub tiktok_status: Arc<Mutex<IntegrationStatus>>,
    pub tiktok_username: Arc<Mutex<Option<String>>>,
    /// Unix seconds of the last sidecar heartbeat (ping) or event — the UI
    /// shows "связь жива N сек назад" and offers a reconnect when stale.
    tiktok_last_activity: Arc<Mutex<Option<i64>>>,
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
            tiktok_last_activity: Arc::new(Mutex::new(None)),
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

    /// Connects to a public TikTok Live room by username via the
    /// `tiktoklive` webcast client (gifts/likes/chat/joins/follows).
    /// `sign_cfg` — optional `(sign_url, jwt)` routed to the sidecar over
    /// stdin: when our backend runs the sign proxy, the paid EulerStream
    /// key stays server-side and the sidecar signs through it.
    pub async fn tiktok_connect(
        &self,
        username: String,
        sign_cfg: Option<(String, String)>,
    ) -> Result<(), String> {
        self.tiktok_disconnect().await;
        let username = username.trim().trim_start_matches('@').to_string();
        if username.is_empty() {
            return Err("пустой username".into());
        }
        *self.tiktok_username.lock().await = Some(username.clone());
        self.set_status("tiktok", IntegrationStatus::Connecting)
            .await;

        let status = self.tiktok_status.clone();
        let app = self.app.clone();
        let raw_tx = self.raw_tx.clone();
        let last_activity = self.tiktok_last_activity.clone();
        let handle = tokio::spawn(async move {
            run_tiktok(username, raw_tx, status, app, sign_cfg, last_activity).await;
        });
        *self.tiktok_task.lock().await = Some(handle);
        Ok(())
    }

    /// Disconnects TikTok (kills the sidecar task).
    pub async fn tiktok_disconnect(&self) {
        if let Some(h) = self.tiktok_task.lock().await.take() {
            h.abort();
        }
        *self.tiktok_last_activity.lock().await = None;
        self.set_status("tiktok", IntegrationStatus::Disconnected)
            .await;
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
            "tiktok_last_activity": *self.tiktok_last_activity.lock().await,
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
    let (ws, _) = tokio_tungstenite::connect_async(
        "wss://centrifugo.donationalerts.com/connection/websocket",
    )
    .await
    .map_err(|e| format!("ws connect: {e}"))?;
    let (mut tx, mut rx) = ws.split();

    tx.send(
        json!({"params":{"token":socket_token,"name":"js"},"id":1})
            .to_string()
            .into(),
    )
    .await
    .map_err(|e| e.to_string())?;

    // 4) Subscribe to the donation alerts channel.
    let channel = format!("$alerts:donation_{user_id}");
    tx.send(
        json!({"params":{"channel":channel},"id":2})
            .to_string()
            .into(),
    )
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

// ---------------------------------------------------------------------------
// TikTok LIVE — Node sidecar running tiktok-live-connector.
// ---------------------------------------------------------------------------
//
// The unofficial webcast API requires request signing, which EulerStream
// provides (free rate-limited tier; `EULERSTREAM_API_KEY` raises limits).
// Rather than embedding an abandoned Rust port that targets a dead sign
// endpoint, the launcher spawns `node index.js <username>` from the
// sidecar directory and consumes its NDJSON stdout stream.

/// Locates the sidecar directory. Order: env override → alongside the exe
/// (`resources/tiktok-sidecar`, then `tiktok-sidecar`) → the dev path
/// (`<manifest>/../../tools/tiktok-sidecar`).
fn sidecar_dir(app: &AppHandle) -> Option<std::path::PathBuf> {
    let candidates: Vec<std::path::PathBuf> = {
        let mut v = Vec::new();
        if let Ok(p) = std::env::var("CHLAUNCHER_SIDECAR_DIR") {
            v.push(p.into());
        }
        if let Ok(exe) = std::env::current_exe() {
            if let Some(d) = exe.parent() {
                v.push(d.join("resources").join("tiktok-sidecar"));
                v.push(d.join("tiktok-sidecar"));
            }
        }
        use tauri::Manager;
        if let Ok(d) = app.path().app_data_dir() {
            v.push(d.join("tiktok-sidecar"));
        }
        // Dev layout: <repo>/apps/launcher/src-tauri → <repo>/tools/tiktok-sidecar
        v.push(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../tools/tiktok-sidecar"),
        );
        v
    };
    candidates.into_iter().find(|p| sidecar_script(p).is_some())
}

/// Resolves the entry script inside a sidecar dir. Prefer the bundled
/// single-file build (`sidecar.js`, produced by `npm run bundle` — no
/// node_modules required) over the dev entry `index.js`. In packaged
/// builds the bundled file sits at the top level; in the repo it lives
/// under `dist/`.
fn sidecar_script(dir: &std::path::Path) -> Option<std::path::PathBuf> {
    ["sidecar.js", "dist/sidecar.js", "index.js"]
        .iter()
        .map(|rel| dir.join(rel))
        .find(|p| p.is_file())
}

/// Locates a Node.js executable: `node` on PATH first, then a bundled
/// `node.exe` inside the sidecar dir (portable distribution).
fn node_bin(sidecar: &std::path::Path) -> Option<String> {
    let bundled = sidecar.join("node.exe");
    if bundled.is_file() {
        return Some(bundled.to_string_lossy().into_owned());
    }
    // `Command::new("node")` resolves PATH at spawn; we just check it works
    // implicitly — if spawn fails the caller surfaces the error.
    Some("node".into())
}

/// Runs one TikTok sidecar session: spawn → read NDJSON lines → push
/// events/status. Returns a human-readable error on setup/connect failure.
async fn run_tiktok(
    username: String,
    raw_tx: mpsc::Sender<RawStreamEvent>,
    status: Arc<Mutex<IntegrationStatus>>,
    app: AppHandle,
    sign_cfg: Option<(String, String)>,
    last_activity: Arc<Mutex<Option<i64>>>,
) {
    let unix_now = || {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0)
    };
    let touch = |last_activity: &Arc<Mutex<Option<i64>>>| {
        let la = last_activity.clone();
        async move {
            *la.lock().await = Some(unix_now());
        }
    };
    let finish = |st: IntegrationStatus| {
        let status = status.clone();
        let app = app.clone();
        let username = username.clone();
        async move {
            *status.lock().await = st.clone();
            let _ = app.emit(
                STATUS_EVENT,
                json!({"integration":"tiktok","status":st,"username":username}),
            );
        }
    };

    let Some(dir) = sidecar_dir(&app) else {
        finish(IntegrationStatus::Error(
            "tiktok-sidecar не найден (ни рядом с exe, ни в tools/)".into(),
        ))
        .await;
        return;
    };
    let Some(node) = node_bin(&dir) else {
        finish(IntegrationStatus::Error("node.exe не найден".into())).await;
        return;
    };
    let Some(script) = sidecar_script(&dir) else {
        finish(IntegrationStatus::Error(
            "tiktok-sidecar: нет entry-скрипта".into(),
        ))
        .await;
        return;
    };

    let mut cmd = tokio::process::Command::new(node);
    cmd.arg(&script)
        .arg(&username)
        .current_dir(&dir)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .stdin(if sign_cfg.is_some() {
            std::process::Stdio::piped()
        } else {
            std::process::Stdio::null()
        })
        .env("EULERSTREAM_API_KEY", eulerstream_key(&app))
        .kill_on_drop(true);

    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW — hide console for GUI launches

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            finish(IntegrationStatus::Error(format!(
                "не удалось запустить node: {e} — нужен Node.js в PATH или node.exe рядом с сайдкаром"
            )))
            .await;
            return;
        }
    };

    // Launcher → sidecar bootstrap: one JSON line with the sign-proxy URL
    // and the user's JWT, then close stdin. The JWT travels over a pipe —
    // never in argv, never in env — so it doesn't show up in process
    // listings. Without a line the sidecar hits EOF and goes direct.
    if let (Some((sign_url, token)), Some(mut stdin)) = (sign_cfg, child.stdin.take()) {
        use tokio::io::AsyncWriteExt;
        let line = serde_json::json!({"sign_url": sign_url, "token": token}).to_string() + "\n";
        let _ = stdin.write_all(line.as_bytes()).await;
        drop(stdin); // close → sidecar proceeds
    }

    let Some(stdout) = child.stdout.take() else {
        finish(IntegrationStatus::Error("sidecar: нет stdout".into())).await;
        return;
    };

    let mut lines = tokio::io::BufReader::new(stdout).lines();
    let mut last_ping = std::time::Instant::now();

    // Read NDJSON until the sidecar dies or the task is aborted.
    loop {
        let line = match tokio::time::timeout(Duration::from_secs(45), lines.next_line()).await {
            Ok(Ok(Some(l))) => l,
            Ok(Ok(None)) => break, // EOF — process exited
            Ok(Err(e)) => {
                finish(IntegrationStatus::Error(format!("sidecar read: {e}"))).await;
                return;
            }
            Err(_) => {
                // No output for 45s — probe aliveness.
                if last_ping.elapsed() > Duration::from_secs(60) {
                    let _ = child.kill().await;
                    finish(IntegrationStatus::Error("sidecar не отвечает".into())).await;
                    return;
                }
                continue;
            }
        };

        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        match v["type"].as_str().unwrap_or("") {
            "ping" => {
                last_ping = std::time::Instant::now();
                touch(&last_activity).await;
            }
            "status" => {
                // Unknown status strings (e.g. "sign_proxy") are
                // informational only — never flip the UI state on them.
                let st = match v["status"].as_str() {
                    Some("live") => Some(IntegrationStatus::Live),
                    Some("disconnected") => Some(IntegrationStatus::Disconnected),
                    _ => None,
                };
                if let Some(st) = st {
                    *status.lock().await = st.clone();
                    let _ = app.emit(
                        STATUS_EVENT,
                        json!({"integration":"tiktok","status":st,"username":username}),
                    );
                }
            }
            "event" => {
                touch(&last_activity).await;
                let ev = RawStreamEvent {
                    source: "tiktok".into(),
                    event_kind: v["event_kind"].as_str().unwrap_or("other").into(),
                    user: v["user"].as_str().unwrap_or("viewer").into(),
                    avatar_url: v["avatar_url"].as_str().unwrap_or_default().into(),
                    raw_name: v["raw_name"].as_str().unwrap_or_default().into(),
                    amount: v["amount"].as_i64().unwrap_or(0) as i32,
                };
                let _ = raw_tx.send(ev).await;
            }
            "error" => {
                let msg = v["message"].as_str().unwrap_or("sidecar error");
                finish(IntegrationStatus::Error(msg.into())).await;
                let _ = child.kill().await;
                return;
            }
            _ => {}
        }
    }

    let _ = child.kill().await;
    finish(IntegrationStatus::Disconnected).await;
}

/// EulerStream signing key: `EULERSTREAM_API_KEY` env var first, then an
/// `eulerstream.key` file in the app-data dir (GUI apps rarely inherit env).
/// Empty string = anonymous free tier of the public sign endpoint.
fn eulerstream_key(app: &AppHandle) -> String {
    if let Ok(k) = std::env::var("EULERSTREAM_API_KEY") {
        let k = k.trim().to_string();
        if !k.is_empty() {
            return k;
        }
    }
    use tauri::Manager;
    app.path()
        .app_data_dir()
        .ok()
        .and_then(|d| std::fs::read_to_string(d.join("eulerstream.key")).ok())
        .map(|k| k.trim().to_string())
        .unwrap_or_default()
}
