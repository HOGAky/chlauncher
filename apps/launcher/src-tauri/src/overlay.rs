//! Browser overlay server — `http://127.0.0.1:<dynamic port>`.
//!
//! TikTok Live Studio (or OBS) consumes `/overlay` as a Browser Source.
//! The page connects back over `ws://<host>/ws` (port taken from
//! `location`), receives a snapshot of recent events + top supporters,
//! then live `StreamEvent`s as they are dispatched through the launcher's
//! [`EventHub`]. Binds `127.0.0.1:0` — loopback only, OS-assigned port,
//! no collisions between launcher instances.
//!
//! The page is embedded as a constant so the server has zero file deps.

use axum::{
    extract::ws::{Message, WebSocket, WebSocketUpgrade},
    response::Html,
    routing::get,
    Router,
};
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::sync::broadcast;

use crate::events::EventHub;
use crate::types::StreamEvent;

/// URL the Browser Source should consume, given the bound port.
pub fn overlay_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/overlay")
}

/// JSON payload types sent to overlay clients.
#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum OverlayFrame<'a> {
    /// Sent right after connect so late joiners see history.
    Snapshot {
        recent: &'a [StreamEvent],
        top: &'a [(String, i64)],
    },
    /// A live mapped event.
    Event { event: &'a StreamEvent },
}

/// Starts the overlay server on `127.0.0.1:0` (OS-assigned loopback port)
/// and returns the actual port so bootstrap can hand the real URL to the
/// UI. Fails fast with an io error when the listener can't be opened.
pub async fn start_overlay_server(hub: Arc<EventHub>) -> std::io::Result<u16> {
    let app = Router::new()
        .route("/overlay", get(|| async { Html(OVERLAY_HTML) }))
        .route("/health", get(|| async { "ok" }))
        .route(
            "/ws",
            get(move |ws: WebSocketUpgrade| {
                let hub = hub.clone();
                async move { ws.on_upgrade(move |sock| overlay_ws(sock, hub)) }
            }),
        );

    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let port = listener.local_addr()?.port();
    tracing::info!(port, "overlay listening on 127.0.0.1");
    tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, app).await {
            tracing::error!(error = %e, "overlay server stopped");
        }
    });
    Ok(port)
}

/// One overlay socket: snapshot first, then forward broadcast events.
async fn overlay_ws(socket: WebSocket, hub: Arc<EventHub>) {
    let (mut tx, mut rx) = socket.split();
    let mut events = hub.tx.subscribe();

    let snapshot = serde_json::to_string(&OverlayFrame::Snapshot {
        recent: &hub.recent_events(),
        top: &hub.top_supporters(5),
    })
    .unwrap_or_default();
    if tx.send(Message::Text(snapshot.into())).await.is_err() {
        return;
    }

    loop {
        tokio::select! {
            ev = events.recv() => {
                match ev {
                    Ok(event) => {
                        let frame = serde_json::to_string(&OverlayFrame::Event { event: &event })
                            .unwrap_or_default();
                        if tx.send(Message::Text(frame.into())).await.is_err() {
                            break;
                        }
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
                    Some(Ok(_)) => {}
                    Some(Err(_)) | None => break,
                }
            }
        }
    }
}

/// Embedded overlay page: dark, transparent-ready, TikTok-portrait friendly.
/// Renders an alert banner on each event, a feed of recent events and a
/// top-supporters leaderboard — no build step, no external assets.
const OVERLAY_HTML: &str = r#"<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>chlauncher overlay</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: transparent;
    font-family: 'Segoe UI', system-ui, sans-serif;
    color: #fff;
    overflow: hidden;
    width: 100vw; height: 100vh;
  }
  #alert {
    position: absolute; top: 24px; left: 50%; transform: translateX(-50%) scale(.8);
    background: linear-gradient(135deg,#7c3aed,#db2777);
    border-radius: 16px; padding: 14px 28px;
    font-size: 22px; font-weight: 700; text-align: center;
    opacity: 0; transition: all .25s ease;
    box-shadow: 0 8px 32px rgba(0,0,0,.5);
    max-width: 90vw;
  }
  #alert.show { opacity: 1; transform: translateX(-50%) scale(1); }
  #alert .sub { font-size: 14px; font-weight: 400; opacity: .85; margin-top: 4px; }
  #feed {
    position: absolute; right: 16px; top: 16px; width: 300px;
    display: flex; flex-direction: column; gap: 6px;
  }
  .feed-item {
    background: rgba(15,17,26,.82); border: 1px solid rgba(255,255,255,.08);
    border-left: 3px solid #7c3aed;
    border-radius: 10px; padding: 8px 12px; font-size: 13px;
    animation: slidein .2s ease;
  }
  .feed-item .who { font-weight: 600; }
  .feed-item .what { opacity: .75; font-size: 12px; }
  @keyframes slidein { from { transform: translateX(20px); opacity: 0; } }
  #top {
    position: absolute; left: 16px; bottom: 16px; width: 240px;
    background: rgba(15,17,26,.82); border: 1px solid rgba(255,255,255,.08);
    border-radius: 12px; padding: 12px 16px;
  }
  #top h3 { font-size: 13px; text-transform: uppercase; letter-spacing: .08em; opacity: .6; margin-bottom: 8px; }
  #top .row { display: flex; justify-content: space-between; font-size: 14px; padding: 3px 0; }
</style>
</head>
<body>
  <div id="alert"><div class="main"></div><div class="sub"></div></div>
  <div id="feed"></div>
  <div id="top"><h3>Top supporters</h3><div id="toplist"></div></div>
<script>
const feed = document.getElementById('feed');
const alertBox = document.getElementById('alert');
const toplist = document.getElementById('toplist');
const topTotals = {};
let alertTimer = null;

function showAlert(ev) {
  alertBox.querySelector('.main').textContent = `${ev.user} — ${ev.raw_name || ev.action_command}`;
  alertBox.querySelector('.sub').textContent =
    `${ev.source} · ${ev.event_kind} · ${ev.action_command}${ev.amount ? ' x' + ev.amount : ''}`;
  alertBox.classList.add('show');
  clearTimeout(alertTimer);
  alertTimer = setTimeout(() => alertBox.classList.remove('show'), 3200);
}

function addFeedItem(ev) {
  const div = document.createElement('div');
  div.className = 'feed-item';
  div.innerHTML = `<div class="who">${escapeHtml(ev.user)}</div>` +
    `<div class="what">${escapeHtml(ev.source)} · ${escapeHtml(ev.event_kind)} → ` +
    `<b>${escapeHtml(ev.action_command)}</b> x${ev.amount}</div>`;
  feed.prepend(div);
  while (feed.children.length > 8) feed.lastChild.remove();
}

function renderTop() {
  const rows = Object.entries(topTotals).sort((a,b) => b[1]-a[1]).slice(0,5);
  toplist.innerHTML = rows.map(([u,v]) =>
    `<div class="row"><span>${escapeHtml(u)}</span><b>${v}</b></div>`).join('');
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function onEvent(ev) {
  topTotals[ev.user] = (topTotals[ev.user] || 0) + (ev.amount || 1);
  showAlert(ev); addFeedItem(ev); renderTop();
}

function connect() {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onmessage = (m) => {
    try {
      const msg = JSON.parse(m.data);
      if (msg.type === 'snapshot') {
        (msg.top || []).forEach(([u,v]) => topTotals[u] = v);
        (msg.recent || []).slice(0, 8).reverse().forEach(addFeedItem);
        renderTop();
      } else if (msg.type === 'event') {
        onEvent(msg.event);
      }
    } catch (e) {}
  };
  ws.onclose = () => setTimeout(connect, 2000); // auto-reconnect
}
connect();
</script>
</body>
</html>
"#;
