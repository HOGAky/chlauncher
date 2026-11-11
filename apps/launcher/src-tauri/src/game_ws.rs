//! Local WebSocket server for games — `ws://127.0.0.1:<dynamic port>`.
//!
//! This is the runtime half of the DRM scheme:
//!
//! 1. At "Play" the launcher mints a one-time session token and starts the
//!    game process with `--port <p>` in argv + `{token,port}` on stdin.
//! 2. The game (via `tiktok-game-sdk`) connects and sends
//!    `{type:"hello", token, protocol}`; the token is consumed on use so it
//!    can't be replayed by a second process.
//! 3. From then on the launcher pushes mapped `StreamEvent`s, a 30-second
//!    heartbeat, `set_chroma_key` toggles and `shutdown` orders.
//! 4. If the subscription lapses or the user kills the game, a `shutdown`
//!    frame is sent and the socket closed — the SDK's watchdog exits the game.

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Duration;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{broadcast, mpsc, Mutex};
use tokio::time::interval;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;

use crate::events::EventHub;
use crate::types::StreamEvent;

/// Heartbeat cadence — well under the SDK's 150 s watchdog.
const HEARTBEAT_EVERY: Duration = Duration::from_secs(30);
/// How long to wait for the `hello` frame before dropping the socket.
const HELLO_TIMEOUT: Duration = Duration::from_secs(5);

/// First frame a client must send: one-time `hello` from launcher-spawned
/// games, or `hello_adapter` from external mods (§10.1) that carry the
/// persistent adapter key instead — mods aren't launcher processes, so
/// they can't receive a one-time token.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ClientFrame {
    Hello {
        token: String,
    },
    HelloAdapter {
        key: String,
        game: String,
        #[allow(dead_code)]
        protocol: Option<u32>,
    },
}

/// Frames an adapter (or a future SDK) may send after the handshake —
/// the optional back-channel. `ack` marks the dispatch `event_id` as
/// executed/failed inside the actual game (§10.1).
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum AdapterFrame {
    Ack { event_id: String, ok: bool },
}

/// Frames sent to games (mirrors `LauncherMessage` in the game SDK).
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ServerFrame<'a> {
    Welcome { protocol: u32 },
    Event { event: &'a StreamEvent },
    Heartbeat { ts: u64 },
    SetChromaKey { enabled: bool },
    Shutdown,
    Error { reason: &'a str },
}

/// Control messages from the server handle into a client task.
enum Control {
    /// Push a ready-made JSON text frame (e.g. chroma-key toggle).
    Frame(String),
    /// Send `shutdown` and close the connection.
    Shutdown,
}

/// Monotonic client ids for deregistration.
static NEXT_CLIENT_ID: AtomicU64 = AtomicU64::new(1);

/// Handle to the running game WS server.
pub struct GameServer {
    /// One-time launch tokens: token → game slug.
    tokens: Mutex<HashMap<String, String>>,
    /// Connected games: slug → (client_id → control channel).
    clients: Mutex<HashMap<String, HashMap<u64, mpsc::Sender<Control>>>>,
    /// Notified (with the slug) every time a handshake completes — lets
    /// `play_game` bound the launch wait to 15 s.
    handshake_tx: broadcast::Sender<String>,
    /// Persistent adapter key (§10.1) — shared with settings so
    /// `regenerate_adapter_key` takes effect for the next handshake.
    adapter_key: Arc<RwLock<String>>,
    /// client_ids that arrived via `hello_adapter` — used to disconnect
    /// mods on key regeneration and to report adapter status.
    adapter_clients: Mutex<HashMap<u64, String>>,
    /// Actual OS-assigned loopback port.
    port: u16,
    /// The bound listener, moved into `run_accept_loop` on start.
    listener: Mutex<Option<std::net::TcpListener>>,
    hub: Arc<EventHub>,
}

type WsSink = futures_util::stream::SplitSink<WebSocketStream<TcpStream>, Message>;

/// Serializes and sends one server frame; a failed send just means the
/// socket is dying — the inbound side will notice on the next poll.
async fn send_frame(tx: &mut WsSink, frame: &ServerFrame<'_>) {
    if let Ok(text) = serde_json::to_string(frame) {
        let _ = tx.send(Message::Text(text.into())).await;
    }
}

impl GameServer {
    /// Binds `127.0.0.1:0` synchronously — the OS assigns a free port.
    /// Fails fast (returns Err) if the loopback listener can't be opened,
    /// so setup can surface "local service unavailable" instead of a
    /// silent dead launcher.
    pub fn bind(
        hub: Arc<EventHub>,
        adapter_key: Arc<RwLock<String>>,
    ) -> std::io::Result<Arc<Self>> {
        let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
        listener.set_nonblocking(true)?;
        let port = listener.local_addr()?.port();
        tracing::info!(port, "game-ws bound on 127.0.0.1");
        let (handshake_tx, _) = broadcast::channel(64);
        Ok(Arc::new(Self {
            tokens: Mutex::new(HashMap::new()),
            clients: Mutex::new(HashMap::new()),
            handshake_tx,
            adapter_key,
            adapter_clients: Mutex::new(HashMap::new()),
            port,
            listener: Mutex::new(Some(listener)),
            hub,
        }))
    }

    /// The OS-assigned port games should dial.
    pub fn port(&self) -> u16 {
        self.port
    }

    /// Unbound placeholder — lets `AppState` exist when the listener bind
    /// failed so the UI can still boot and show the service error.
    /// `port()` returns 0; no game can ever connect.
    pub fn bind_placeholder(hub: Arc<EventHub>, adapter_key: Arc<RwLock<String>>) -> Arc<Self> {
        let (handshake_tx, _) = broadcast::channel(64);
        Arc::new(Self {
            tokens: Mutex::new(HashMap::new()),
            clients: Mutex::new(HashMap::new()),
            handshake_tx,
            adapter_key,
            adapter_clients: Mutex::new(HashMap::new()),
            port: 0,
            listener: Mutex::new(None),
            hub,
        })
    }

    /// The current adapter key — read per handshake so regeneration is
    /// immediate.
    fn adapter_key(&self) -> String {
        self.adapter_key
            .read()
            .map(|k| k.clone())
            .unwrap_or_default()
    }

    /// Slugs of currently-connected adapters (mods) — for the status card.
    pub async fn connected_adapters(&self) -> Vec<String> {
        self.adapter_clients
            .lock()
            .await
            .values()
            .cloned()
            .collect()
    }

    /// Force-disconnects every adapter — used when the key is regenerated
    /// (old keys must stop working). Mods reconnect with the new key.
    pub async fn disconnect_adapters(&self) {
        let ids: Vec<u64> = self.adapter_clients.lock().await.keys().cloned().collect();
        for (slug, clients) in self.clients.lock().await.iter() {
            for (id, tx) in clients {
                if ids.contains(id) {
                    tracing::info!(slug = %slug, client_id = id, "adapter kicked (key regenerated)");
                    let _ = tx.try_send(Control::Shutdown);
                }
            }
        }
    }

    /// `true` when the slug's WS handshake completes before `timeout`;
    /// `false` on timeout — used by `play_game` for the 15 s launch gate.
    pub async fn wait_for_handshake(&self, slug: &str, timeout: Duration) -> bool {
        // Handshake may have already landed — check connected clients first.
        if self.client_count(slug).await > 0 {
            return true;
        }
        let mut rx = self.handshake_tx.subscribe();
        let res = tokio::time::timeout(timeout, async {
            loop {
                match rx.recv().await {
                    Ok(s) if s == slug => return,
                    Ok(_) => continue,
                    Err(_) => return,
                }
            }
        })
        .await;
        res.is_ok()
    }

    /// Accepts connections forever on the pre-bound listener.
    /// Intended to be awaited inside `tauri::async_runtime::spawn`.
    pub async fn run_accept_loop(self: &Arc<Self>) -> std::io::Result<()> {
        let std_listener = self.listener.lock().await.take();
        let Some(std_listener) = std_listener else {
            return Err(std::io::Error::other("accept loop already running"));
        };
        let listener = TcpListener::from_std(std_listener)?;
        while let Ok((socket, addr)) = listener.accept().await {
            let srv = self.clone();
            tokio::spawn(async move {
                if let Err(e) = srv.handle_conn(socket, addr).await {
                    tracing::warn!(addr = %addr, error = %e, "game-ws connection error");
                }
            });
        }
        Ok(())
    }

    /// Mints a one-time launch token for `slug` (called by `play_game`).
    pub async fn issue_token(&self, slug: &str) -> String {
        let token = uuid::Uuid::new_v4().to_string();
        self.tokens
            .lock()
            .await
            .insert(token.clone(), slug.to_string());
        token
    }

    /// Number of connected game clients for a slug.
    pub async fn client_count(&self, slug: &str) -> usize {
        self.clients
            .lock()
            .await
            .get(slug)
            .map(|m| m.len())
            .unwrap_or(0)
    }

    /// Broadcasts a chroma-key toggle to every connected game.
    pub async fn broadcast_chroma_key(&self, enabled: bool) {
        let frame =
            serde_json::to_string(&ServerFrame::SetChromaKey { enabled }).unwrap_or_default();
        for txs in self.clients.lock().await.values() {
            for tx in txs.values() {
                let _ = tx.try_send(Control::Frame(frame.clone()));
            }
        }
    }

    /// Sends `shutdown` to every client of `slug`; the socket close that
    /// follows lets the game-side watchdog terminate the process.
    pub async fn shutdown_slug(&self, slug: &str) {
        if let Some(clients) = self.clients.lock().await.get(slug) {
            for tx in clients.values() {
                let _ = tx.try_send(Control::Shutdown);
            }
        }
    }

    /// One connection lifecycle: handshake → forward hub events + heartbeats.
    async fn handle_conn(
        &self,
        socket: TcpStream,
        _addr: SocketAddr,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let ws = tokio_tungstenite::accept_async(socket).await?;
        let (mut ws_tx, mut ws_rx) = ws.split();

        // --- handshake: first frame must be hello/hello_adapter within 5 s
        let (slug, is_adapter) = match tokio::time::timeout(HELLO_TIMEOUT, ws_rx.next()).await {
            Ok(Some(Ok(Message::Text(text)))) => match serde_json::from_str::<ClientFrame>(&text) {
                Ok(ClientFrame::Hello { token }) => {
                    // Consume the one-time token — replay is impossible.
                    match self.tokens.lock().await.remove(&token) {
                        Some(slug) => (slug, false),
                        None => {
                            send_frame(
                                &mut ws_tx,
                                &ServerFrame::Error {
                                    reason: "invalid token",
                                },
                            )
                            .await;
                            return Err("invalid token".into());
                        }
                    }
                }
                Ok(ClientFrame::HelloAdapter { key, game, .. }) => {
                    // §10.1: persistent revocable key instead of a
                    // one-time token — mods are not launcher processes.
                    let expected = self.adapter_key();
                    let valid =
                        !expected.is_empty() && key == expected && is_valid_adapter_slug(&game);
                    if !valid {
                        send_frame(
                            &mut ws_tx,
                            &ServerFrame::Error {
                                reason: "invalid adapter key",
                            },
                        )
                        .await;
                        return Err("invalid adapter key".into());
                    }
                    (game, true)
                }
                _ => {
                    send_frame(
                        &mut ws_tx,
                        &ServerFrame::Error {
                            reason: "bad hello",
                        },
                    )
                    .await;
                    return Err("malformed hello".into());
                }
            },
            _ => return Err("hello timeout".into()),
        };

        send_frame(&mut ws_tx, &ServerFrame::Welcome { protocol: 1 }).await;

        // --- register client control channel ---
        let client_id = NEXT_CLIENT_ID.fetch_add(1, Ordering::Relaxed);
        let (ctl_tx, mut ctl_rx) = mpsc::channel::<Control>(8);
        self.clients
            .lock()
            .await
            .entry(slug.clone())
            .or_default()
            .insert(client_id, ctl_tx);
        if is_adapter {
            self.adapter_clients
                .lock()
                .await
                .insert(client_id, slug.clone());
        }

        // Handshake done — releases play_game's 15 s launch gate.
        let _ = self.handshake_tx.send(slug.clone());

        let mut events = self.hub.tx.subscribe();
        let mut hb = interval(HEARTBEAT_EVERY);
        hb.tick().await; // consume the immediate first tick

        loop {
            tokio::select! {
                // Hub → game: mapped stream events
                ev = events.recv() => {
                    match ev {
                        Ok(event) => {
                            send_frame(&mut ws_tx, &ServerFrame::Event { event: &event }).await;
                        }
                        Err(broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(_) => break,
                    }
                }
                // Heartbeat watchdog feed
                _ = hb.tick() => {
                    let ts = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_secs())
                        .unwrap_or(0);
                    send_frame(&mut ws_tx, &ServerFrame::Heartbeat { ts }).await;
                }
                // Control channel: pushed frames (chroma) or shutdown order
                ctl = ctl_rx.recv() => {
                    match ctl {
                        Some(Control::Frame(text)) => {
                            let _ = ws_tx.send(Message::Text(text.into())).await;
                        }
                        Some(Control::Shutdown) | None => {
                            send_frame(&mut ws_tx, &ServerFrame::Shutdown).await;
                            break;
                        }
                    }
                }
                // Drain inbound frames — detects close, answers pings,
                // consumes adapter `ack` back-channel frames (§10.1).
                msg = ws_rx.next() => {
                    match msg {
                        Some(Ok(Message::Ping(p))) => {
                            let _ = ws_tx.send(Message::Pong(p)).await;
                        }
                        Some(Ok(Message::Text(text))) => {
                            if let Ok(AdapterFrame::Ack { event_id, ok }) =
                                serde_json::from_str::<AdapterFrame>(&text)
                            {
                                self.hub.note_ack(&event_id, ok);
                            }
                        }
                        Some(Ok(_)) => { /* binary frames carry nothing */ }
                        Some(Err(_)) | None => break,
                    }
                }
            }
        }

        // Deregister this client.
        if let Some(map) = self.clients.lock().await.get_mut(&slug) {
            map.remove(&client_id);
        }
        self.adapter_clients.lock().await.remove(&client_id);
        Ok(())
    }
}

/// Adapter `game` names follow the same slug rules as catalog entries.
fn is_valid_adapter_slug(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
        && s.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
}

#[cfg(test)]
mod tests {
    use super::is_valid_adapter_slug;

    /// e2e: a real WS client performs `hello_adapter` against a bound
    /// GameServer and gets `welcome`; a wrong key is refused, and an
    /// `ack` frame marks the feed entry.
    #[tokio::test]
    async fn hello_adapter_handshake_accepts_valid_key() {
        use futures_util::{SinkExt, StreamExt};
        use std::sync::{Arc, RwLock};
        use tokio_tungstenite::tungstenite::Message;

        let hub = Arc::new(crate::events::EventHub::new());
        let key = Arc::new(RwLock::new("test-adapter-key".to_string()));
        let srv = super::GameServer::bind(hub.clone(), key).unwrap();
        let port = srv.port();
        let srv2 = srv.clone();
        tokio::spawn(async move {
            srv2.run_accept_loop().await.ok();
        });

        let url = format!("ws://127.0.0.1:{port}");
        // --- wrong key → error frame ----------------------------------
        let (mut ws, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
        ws.send(Message::Text(
            r#"{"type":"hello_adapter","key":"wrong","game":"gta5","protocol":1}"#.into(),
        ))
        .await
        .unwrap();
        let reply = ws.next().await.unwrap().unwrap();
        assert!(reply.to_text().unwrap().contains("invalid adapter key"));

        // --- correct key → welcome ------------------------------------
        let (mut ws, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
        ws.send(Message::Text(
            r#"{"type":"hello_adapter","key":"test-adapter-key","game":"gta5","protocol":1}"#
                .into(),
        ))
        .await
        .unwrap();
        let reply = ws.next().await.unwrap().unwrap();
        assert!(reply.to_text().unwrap().contains("welcome"));
        assert_eq!(srv.connected_adapters().await, vec!["gta5".to_string()]);

        // --- ack back-channel marks the feed entry --------------------
        hub.dispatch(crate::types::StreamEvent {
            source: "simulator".into(),
            event_kind: "gift".into(),
            user: "u".into(),
            avatar_url: String::new(),
            action_command: "explode".into(),
            amount: 1,
            raw_name: "r".into(),
            event_id: "evt-42".into(),
        });
        // Drain until the adapter sees the event frame, then ack it.
        loop {
            match ws.next().await.unwrap().unwrap() {
                Message::Text(t) if t.contains("\"event\"") => break,
                _ => continue,
            }
        }
        ws.send(Message::Text(
            r#"{"type":"ack","event_id":"evt-42","ok":true}"#.into(),
        ))
        .await
        .unwrap();
        // Give the connection task a moment to consume the frame.
        for _ in 0..50 {
            if hub.feed_items().first().and_then(|f| f.ack) == Some(true) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert_eq!(hub.feed_items()[0].ack, Some(true));
    }

    #[test]
    fn adapter_slug_rules_match_catalog() {
        assert!(is_valid_adapter_slug("gta5"));
        assert!(is_valid_adapter_slug("demo-adapter"));
        assert!(is_valid_adapter_slug("7dtd_adapter"));
        assert!(!is_valid_adapter_slug(""));
        assert!(!is_valid_adapter_slug("GTA5")); // lowercase only
        assert!(!is_valid_adapter_slug("-lead"));
        assert!(!is_valid_adapter_slug("a/../b"));
        assert!(!is_valid_adapter_slug(&"x".repeat(65)));
    }
}
