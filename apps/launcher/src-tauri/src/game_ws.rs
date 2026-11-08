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
use std::sync::Arc;
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

/// First frame a game must send.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ClientFrame {
    Hello { token: String },
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
    pub fn bind(hub: Arc<EventHub>) -> std::io::Result<Arc<Self>> {
        let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
        listener.set_nonblocking(true)?;
        let port = listener.local_addr()?.port();
        tracing::info!(port, "game-ws bound on 127.0.0.1");
        let (handshake_tx, _) = broadcast::channel(64);
        Ok(Arc::new(Self {
            tokens: Mutex::new(HashMap::new()),
            clients: Mutex::new(HashMap::new()),
            handshake_tx,
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
    pub fn bind_placeholder(hub: Arc<EventHub>) -> Arc<Self> {
        let (handshake_tx, _) = broadcast::channel(64);
        Arc::new(Self {
            tokens: Mutex::new(HashMap::new()),
            clients: Mutex::new(HashMap::new()),
            handshake_tx,
            port: 0,
            listener: Mutex::new(None),
            hub,
        })
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

        // --- handshake: first frame must be hello{token} within 5 s ---
        let token = match tokio::time::timeout(HELLO_TIMEOUT, ws_rx.next()).await {
            Ok(Some(Ok(Message::Text(text)))) => match serde_json::from_str::<ClientFrame>(&text) {
                Ok(ClientFrame::Hello { token }) => token,
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

        // Consume the one-time token — replay is impossible afterwards.
        let slug = self.tokens.lock().await.remove(&token);
        let Some(slug) = slug else {
            send_frame(
                &mut ws_tx,
                &ServerFrame::Error {
                    reason: "invalid token",
                },
            )
            .await;
            return Err("invalid token".into());
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
                // Drain inbound frames — detects close & answers pings.
                msg = ws_rx.next() => {
                    match msg {
                        Some(Ok(Message::Ping(p))) => {
                            let _ = ws_tx.send(Message::Pong(p)).await;
                        }
                        Some(Ok(_)) => { /* games send nothing post-hello */ }
                        Some(Err(_)) | None => break,
                    }
                }
            }
        }

        // Deregister this client.
        if let Some(map) = self.clients.lock().await.get_mut(&slug) {
            map.remove(&client_id);
        }
        Ok(())
    }
}
