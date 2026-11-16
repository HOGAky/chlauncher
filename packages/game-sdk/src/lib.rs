//! # tiktok-game-sdk
//!
//! IPC SDK that every chlauncher game links against. It provides:
//!
//! 1. **DRM / anti-piracy handshake** — a game binary refuses to run unless it
//!    was spawned by the launcher with a valid one-time session token
//!    (`--port <p>` in argv + `{"token":…}` on the first stdin line).
//!    Without a successful handshake the
//!    game must exit immediately, so a copied `.exe` is useless.
//! 2. **Live event feed** — the launcher aggregates TikTok Live events and
//!    DonationAlerts donations, maps them through the streamer's trigger
//!    profile, and pushes game-ready [`StreamEvent`]s over a local WebSocket.
//! 3. **Heartbeat supervision** — the launcher pings the game every ~60 s; if
//!    the launcher dies or the subscription lapses the link reports
//!    [`LauncherLink::is_alive`] == `false` and the game must shut down.
//!
//! ## Wire protocol (JSON text frames on `ws://127.0.0.1:<port>`)
//!
//! game → launcher: `{"type":"hello","token":"…","protocol":1}`
//! launcher → game: `{"type":"welcome","protocol":1}` |
//!                  `{"type":"event","event":{…}}` |
//!                  `{"type":"heartbeat","ts":…}` |
//!                  `{"type":"set_chroma_key","enabled":true}` |
//!                  `{"type":"shutdown"}` |
//!                  `{"type":"error","reason":"…"}`
//!
//! ## Usage
//!
//! ```no_run
//! let link = tiktok_game_sdk::init_or_exit();
//! loop {
//!     for msg in link.poll() {
//!         match msg {
//!             tiktok_game_sdk::LauncherMessage::Event { event } => { /* spawn(event) */ }
//!             tiktok_game_sdk::LauncherMessage::Shutdown => std::process::exit(0),
//!             _ => {}
//!         }
//!     }
//!     if !link.is_alive() { std::process::exit(0); }
//! #    break;
//! }
//! ```

use serde::{Deserialize, Serialize};
use std::net::TcpStream;
use std::process;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tungstenite::{connect, Message};

/// Wire-protocol version. Bump when the frame schema changes incompatibly.
pub const PROTOCOL_VERSION: u32 = 1;

/// If no heartbeat arrives within this window the link is considered dead.
/// Launcher sends one every 60 s, so 150 s leaves generous headroom.
pub const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(150);

// ---------------------------------------------------------------------------
// Protocol messages
// ---------------------------------------------------------------------------

/// A normalized, game-ready stream event produced by the launcher's trigger
/// mapper. `source`/`event_kind` describe where it came from;
/// `action_command` is the game-side verb the streamer bound to it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreamEvent {
    /// Origin service: `"tiktok"`, `"donationalerts"` or `"simulator"`.
    pub source: String,
    /// Raw event kind: `"gift"`, `"like"`, `"comment"`, `"donation"`, …
    pub event_kind: String,
    /// Display name of the viewer who triggered the event.
    pub user: String,
    /// Avatar URL (may be empty when the source provides none).
    pub avatar_url: String,
    /// Mapped game command, e.g. `"spawn_enemy"`, `"spawn_boss"`, `"heal_player"`.
    pub action_command: String,
    /// Quantity/multiplier (gift count, donation amount in minor units, likes).
    pub amount: i32,
    /// Human-readable raw payload name (gift name, donation text, comment).
    pub raw_name: String,
}

/// Messages sent from the launcher to the game.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum LauncherMessage {
    /// Handshake accepted — the game may proceed.
    Welcome { protocol: u32 },
    /// A game-ready stream event.
    Event { event: StreamEvent },
    /// Keepalive ping; resets the heartbeat watchdog.
    Heartbeat { ts: u64 },
    /// Toggle the chroma-key (pure green) background for stream capture.
    SetChromaKey { enabled: bool },
    /// The launcher demands an immediate, orderly shutdown.
    Shutdown,
    /// Handshake or runtime failure — `reason` is human-readable.
    Error { reason: String },
}

/// The single message the game sends to complete the handshake.
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ClientMessage {
    Hello { token: String, protocol: u32 },
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// Why [`init_and_verify`] can fail.
#[derive(Debug)]
pub enum SdkError {
    /// `--port` and/or `--token` were missing or malformed — the binary was
    /// almost certainly started directly instead of through the launcher.
    MissingArgs,
    /// Could not reach the local launcher WebSocket (launcher not running?).
    Connect(String),
    /// Launcher rejected the session token.
    Rejected(String),
    /// The launcher answered with something unparseable.
    Protocol(String),
}

impl std::fmt::Display for SdkError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SdkError::MissingArgs => write!(
                f,
                "missing --port or stdin credentials (run the game via the launcher)"
            ),
            SdkError::Connect(e) => write!(f, "cannot reach launcher: {e}"),
            SdkError::Rejected(r) => write!(f, "launcher rejected session: {r}"),
            SdkError::Protocol(e) => write!(f, "protocol error: {e}"),
        }
    }
}

impl std::error::Error for SdkError {}

// ---------------------------------------------------------------------------
// LauncherLink — the live connection handed back to the game
// ---------------------------------------------------------------------------

/// Handle to the verified launcher connection. Cheap to keep in the game
/// state; call [`poll`](LauncherLink::poll) once per frame.
pub struct LauncherLink {
    rx: Receiver<LauncherMessage>,
    connected: Arc<AtomicBool>,
    /// Seconds-since-epoch of the last heartbeat (0 = none yet).
    last_heartbeat: Arc<AtomicU64>,
    /// When the link was established — used while no heartbeat arrived yet.
    established: Instant,
}

impl std::fmt::Debug for LauncherLink {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LauncherLink")
            .field("connected", &self.connected.load(Ordering::Relaxed))
            .field("alive", &self.is_alive())
            .finish()
    }
}

impl LauncherLink {
    /// Drains pending launcher messages. Call once per frame/tick; O(n) in
    /// the number of queued messages and never blocks.
    pub fn poll(&self) -> Vec<LauncherMessage> {
        let mut out = Vec::new();
        while let Ok(msg) = self.rx.try_recv() {
            out.push(msg);
        }
        out
    }

    /// Non-blocking variant: pops at most one queued message.
    pub fn try_next(&self) -> Option<LauncherMessage> {
        self.rx.try_recv().ok()
    }

    /// `true` while the socket is open and heartbeats keep arriving.
    /// When this flips to `false` the game must shut down — the launcher is
    /// gone or the session was revoked.
    pub fn is_alive(&self) -> bool {
        if !self.connected.load(Ordering::Relaxed) {
            return false;
        }
        let last = self.last_heartbeat.load(Ordering::Relaxed);
        if last == 0 {
            // No heartbeat received yet — tolerate the establishment window.
            return self.established.elapsed() < HEARTBEAT_TIMEOUT;
        }
        let now = epoch_secs();
        now.saturating_sub(last) < HEARTBEAT_TIMEOUT.as_secs()
    }
}

fn epoch_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

/// Parses `--key value` / `--key=value` arguments from the command line.
/// Returns the game-WS port or [`SdkError::MissingArgs`].
fn parse_launch_args() -> Result<u16, SdkError> {
    let args: Vec<String> = std::env::args().collect();
    let mut port: Option<u16> = None;

    let mut i = 1;
    while i < args.len() {
        let arg = &args[i];
        let (key, inline) = match arg.split_once('=') {
            Some((k, v)) => (k, Some(v.to_string())),
            None => (arg.as_str(), None),
        };
        if key == "--port" {
            let v = inline.or_else(|| {
                if i + 1 < args.len() {
                    i += 1;
                    Some(args[i].clone())
                } else {
                    None
                }
            });
            port = v.and_then(|v| v.parse().ok());
        }
        i += 1;
    }

    port.ok_or(SdkError::MissingArgs)
}

/// Reads the session token from the first stdin line.
///
/// The launcher writes `{"token":"…","port":…}` and closes stdin. Reading
/// credentials this way keeps the token out of the process command line —
/// `wmic`/Task Manager/`ps` would expose an argv token to any local user.
///
/// A 3 s bound guards the direct-launch path: a game started by hand has a
/// live-but-silent stdin, so a plain `read_line` would hang forever.
/// Plain `token\n` (non-JSON) is also accepted for launcher stubs/tests.
fn read_token_from_stdin() -> Result<String, SdkError> {
    let (tx, rx) = channel::<Option<String>>();
    std::thread::spawn(move || {
        let mut line = String::new();
        let read = std::io::stdin().read_line(&mut line);
        let token = match read {
            Ok(0) | Err(_) => None,
            Ok(_) => {
                let line = line.trim().to_string();
                if line.is_empty() {
                    None
                } else if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                    v["token"].as_str().map(|s| s.to_string())
                } else {
                    Some(line)
                }
            }
        };
        let _ = tx.send(token);
    });
    match rx.recv_timeout(Duration::from_secs(3)) {
        Ok(Some(t)) if !t.is_empty() => Ok(t),
        _ => Err(SdkError::MissingArgs),
    }
}

/// Performs the DRM handshake with the launcher.
///
/// Expects `--port <ws port>` in argv and `{token,port}` JSON on the first
/// stdin line (the launcher writes it right after spawn). Opens
/// `ws://127.0.0.1:<port>`, sends `hello`, and waits (≤5 s) for `welcome`.
/// On success returns a [`LauncherLink`] backed by a reader thread.
///
/// # Errors
/// [`SdkError::MissingArgs`] when launched directly (no `--port`, or stdin
/// carried no token within 3 s), [`SdkError::Connect`] when the launcher
/// is unreachable, [`SdkError::Rejected`] when the token is invalid or the
/// subscription lapsed.
pub fn init_and_verify() -> Result<LauncherLink, SdkError> {
    let port = parse_launch_args()?;
    let token = read_token_from_stdin()?;
    verify_with(port, &token)
}

/// Same as [`init_and_verify`] but with explicit parameters — useful for
/// integration tests that spin up their own launcher stub.
pub fn verify_with(port: u16, token: &str) -> Result<LauncherLink, SdkError> {
    let url = format!("ws://127.0.0.1:{port}/");
    let (mut socket, _response) = connect(&url).map_err(|e| SdkError::Connect(e.to_string()))?;

    let hello = serde_json::to_string(&ClientMessage::Hello {
        token: token.to_string(),
        protocol: PROTOCOL_VERSION,
    })
    .map_err(|e| SdkError::Protocol(e.to_string()))?;
    socket
        .send(Message::Text(hello.into()))
        .map_err(|e| SdkError::Protocol(e.to_string()))?;

    // Bound the handshake wait so a hung launcher can't freeze game start.
    set_read_timeout(&socket, Some(Duration::from_secs(5)));

    let reply = socket.read();
    set_read_timeout(&socket, None); // back to blocking for the reader thread

    match reply {
        Ok(Message::Text(text)) => match serde_json::from_str::<LauncherMessage>(&text) {
            Ok(LauncherMessage::Welcome { .. }) => Ok(spawn_reader(socket)),
            Ok(LauncherMessage::Error { reason }) => Err(SdkError::Rejected(reason)),
            Ok(other) => Err(SdkError::Protocol(format!(
                "unexpected first frame: {other:?}"
            ))),
            Err(e) => Err(SdkError::Protocol(e.to_string())),
        },
        Ok(Message::Close(_)) => Err(SdkError::Rejected("closed by launcher".into())),
        Ok(_) => Err(SdkError::Protocol("non-text handshake frame".into())),
        Err(e) => Err(SdkError::Connect(e.to_string())),
    }
}

/// Convenience wrapper: on failure prints the error to stderr and exits
/// with code 1 — the "refuse to run without the launcher" behaviour.
pub fn init_or_exit() -> LauncherLink {
    match init_and_verify() {
        Ok(link) => link,
        Err(e) => {
            eprintln!("[game-sdk] license check failed: {e}");
            process::exit(1);
        }
    }
}

/// Applies/clears a read timeout on the socket's underlying TCP stream.
fn set_read_timeout(
    socket: &tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<TcpStream>>,
    dur: Option<Duration>,
) {
    if let tungstenite::stream::MaybeTlsStream::Plain(s) = socket.get_ref() {
        let _ = s.set_read_timeout(dur);
    }
}

/// Moves the socket into a daemon reader thread that forwards parsed frames
/// onto the link's channel and maintains the heartbeat watchdog.
fn spawn_reader(
    mut socket: tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<TcpStream>>,
) -> LauncherLink {
    let (tx, rx) = channel();
    let connected = Arc::new(AtomicBool::new(true));
    let last_heartbeat = Arc::new(AtomicU64::new(0));

    let th_connected = connected.clone();
    let th_heartbeat = last_heartbeat.clone();
    std::thread::spawn(move || {
        loop {
            match socket.read() {
                Ok(Message::Text(text)) => {
                    match serde_json::from_str::<LauncherMessage>(&text) {
                        Ok(LauncherMessage::Heartbeat { ts }) => {
                            th_heartbeat.store(ts.max(epoch_secs()), Ordering::Relaxed);
                        }
                        Ok(msg) => {
                            if tx.send(msg).is_err() {
                                break; // game dropped the link
                            }
                        }
                        Err(_) => { /* ignore malformed frames */ }
                    }
                }
                Ok(Message::Ping(p)) => {
                    let _ = socket.send(Message::Pong(p));
                }
                Ok(_) => { /* binary/pong frames carry no meaning here */ }
                Err(_) => break,
            }
        }
        // Socket closed or errored — flag the link dead so the game exits.
        th_connected.store(false, Ordering::Relaxed);
    });

    LauncherLink {
        rx,
        connected,
        last_heartbeat,
        established: Instant::now(),
    }
}
