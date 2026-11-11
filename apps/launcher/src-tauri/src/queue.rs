//! Viewer queue («Очередь зрителей») — chat types `!join` to line up,
//! `!leave` to step out; the streamer pulls the next viewer, which
//! injects a `queue` event into the ingest pipeline so a trigger rule
//! can act on it (e.g. teleport them into the Roblox room / spawn them
//! in Minecraft).
//!
//! In-memory only (a queue belongs to one stream), capped at
//! [`MAX_QUEUE`] so a raid can't grow it without bound. Names render
//! on `/overlay/queue` via `/queue.json`.

use std::collections::{HashSet, VecDeque};
use std::sync::Arc;
use tokio::sync::{broadcast, mpsc, Mutex};

use crate::types::{OverlayFrame, RawStreamEvent};

/// One queued viewer for `/queue.json` + the UI.
#[derive(Debug, Clone, serde::Serialize)]
pub struct QueueEntry {
    pub user: String,
    /// 1-based position in line.
    pub pos: usize,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct QueueStatus {
    /// Whether `!join` comments are accepted.
    pub open: bool,
    pub entries: Vec<QueueEntry>,
    /// The most recently pulled viewer (kept until the next `next`).
    pub last_called: String,
}

const MAX_QUEUE: usize = 200;

struct State {
    open: bool,
    line: VecDeque<String>,
    in_line: HashSet<String>,
    last_called: String,
}

/// `!join`/`!leave` tracking + `queue_next` dispatch.
pub struct ViewerQueue {
    state: Mutex<State>,
    raw_tx: mpsc::Sender<RawStreamEvent>,
    overlay_tx: broadcast::Sender<OverlayFrame>,
}

impl ViewerQueue {
    pub fn new(
        raw_tx: mpsc::Sender<RawStreamEvent>,
        overlay_tx: broadcast::Sender<OverlayFrame>,
    ) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(State {
                open: true,
                line: VecDeque::new(),
                in_line: HashSet::new(),
                last_called: String::new(),
            }),
            raw_tx,
            overlay_tx,
        })
    }

    /// Handles `!join`/`!leave` comments — called per raw event from the
    /// mapper loop (early-out on non-comments, before any lock beyond
    /// this module).
    pub async fn note_raw(&self, raw: &RawStreamEvent) {
        if raw.event_kind != "comment" {
            return;
        }
        let cmd = raw.raw_name.trim().to_lowercase();
        if cmd != "!join" && cmd != "!leave" {
            return;
        }
        let user = raw.user.trim().to_string();
        if user.is_empty() {
            return;
        }
        let mut st = self.state.lock().await;
        if cmd == "!join" {
            if !st.open || st.line.len() >= MAX_QUEUE || st.in_line.contains(&user) {
                return;
            }
            st.in_line.insert(user.clone());
            st.line.push_back(user);
        } else {
            st.in_line.remove(&user);
            st.line.retain(|u| u != &user);
        }
    }

    /// Opens or closes `!join` (streamer toggle — «очередь открыта»).
    pub async fn set_open(&self, open: bool) {
        self.state.lock().await.open = open;
    }

    /// Empties the queue («новый стрим» / reset between rounds).
    pub async fn clear(&self) {
        let mut st = self.state.lock().await;
        st.line.clear();
        st.in_line.clear();
        st.last_called.clear();
    }

    /// Snapshot for `/queue.json` + the card.
    pub async fn status(&self) -> QueueStatus {
        let st = self.state.lock().await;
        QueueStatus {
            open: st.open,
            entries: st
                .line
                .iter()
                .enumerate()
                .map(|(i, u)| QueueEntry {
                    user: u.clone(),
                    pos: i + 1,
                })
                .collect(),
            last_called: st.last_called.clone(),
        }
    }

    /// Pulls the next viewer: records them as called, announces on the
    /// alerts channel and injects a `queue` event into the pipeline —
    /// a trigger rule (`kind=queue`, `match={user}`) decides the action.
    pub async fn next(&self) -> Result<String, String> {
        let user = {
            let mut st = self.state.lock().await;
            let Some(user) = st.line.pop_front() else {
                return Err("Очередь пуста".into());
            };
            st.in_line.remove(&user);
            st.last_called = user.clone();
            user
        };
        let _ = self.overlay_tx.send(OverlayFrame::Alert {
            id: format!("queue-{}", crate::types::now_ms()),
            text: format!("Следующий: {user}"),
            duration_ms: 5000,
            sound: None,
            media: None,
            position: "top".into(),
            style: "queue".into(),
            user: user.clone(),
        });
        let ev = RawStreamEvent {
            source: "queue".into(),
            event_kind: "queue".into(),
            user: user.clone(),
            avatar_url: String::new(),
            raw_name: user.clone(),
            amount: 1,
            count: 1,
            coins: 0,
            gift_id: None,
            ts_ms: crate::types::now_ms(),
        };
        // Full ingest channel: the caller still gets the viewer — the
        // trigger rule just won't fire this round.
        let _ = self.raw_tx.try_send(ev);
        Ok(user)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (Arc<ViewerQueue>, mpsc::Receiver<RawStreamEvent>) {
        let (raw_tx, raw_rx) = mpsc::channel(16);
        let (otx, _rx) = broadcast::channel(16);
        (ViewerQueue::new(raw_tx, otx), raw_rx)
    }

    fn comment(user: &str, text: &str) -> RawStreamEvent {
        RawStreamEvent {
            source: "tiktok".into(),
            event_kind: "comment".into(),
            user: user.into(),
            avatar_url: String::new(),
            raw_name: text.into(),
            amount: 1,
            count: 1,
            coins: 0,
            gift_id: None,
            ts_ms: 0,
        }
    }

    #[tokio::test]
    async fn join_leave_dedupe_and_next_injects_event() {
        let (q, mut raw_rx) = fixture();
        q.note_raw(&comment("alice", "!join")).await;
        q.note_raw(&comment("alice", "!join")).await; // dup — ignored
        q.note_raw(&comment("bob", "!join")).await;
        q.note_raw(&comment("bob", "!leave")).await;
        q.note_raw(&comment("carol", "hi")).await; // not a command
        let st = q.status().await;
        assert_eq!(st.entries.len(), 1);
        assert_eq!(st.entries[0].user, "alice");

        let called = q.next().await.unwrap();
        assert_eq!(called, "alice");
        let ev = raw_rx.recv().await.expect("queue event injected");
        assert_eq!(ev.event_kind, "queue");
        assert_eq!(ev.raw_name, "alice");
        assert!(q.next().await.is_err(), "empty queue errors");
    }

    #[tokio::test]
    async fn closed_queue_rejects_join() {
        let (q, _rx) = fixture();
        q.set_open(false).await;
        q.note_raw(&comment("alice", "!join")).await;
        assert!(q.status().await.entries.is_empty());
        q.set_open(true).await;
        q.note_raw(&comment("alice", "!join")).await;
        assert_eq!(q.status().await.entries.len(), 1);
    }
}
