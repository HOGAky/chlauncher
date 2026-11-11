//! Chat polls («Голосования») — the streamer asks, chat votes by typing
//! the option number (`1`, `2`…) or `!vote N`, the winner can trigger a
//! normal trigger rule.
//!
//! Flow: `poll_start` → comments counted one-per-viewer → `poll_stop`
//! (or the duration timer) → winner announced via an overlay alert AND
//! re-injected into the ingest pipeline as a synthetic
//! `RawStreamEvent{ kind: "poll" }` — so a regular rule
//! (`kind = poll`, `match = option text`) runs the action through the
//! scheduler (cooldowns, queue, media, Minecraft RCON) exactly like a
//! gift trigger.
//!
//! Live bars render on `/overlay/poll` via `/poll.json`. One poll at a
//! time — starting a new one discards the running poll's votes.
//! Runtime is in-memory only.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{broadcast, mpsc, Mutex};

use crate::types::{OverlayFrame, RawStreamEvent};

/// Config the streamer sends from the UI — not persisted (a poll is a
/// live-stream moment, not settings).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct PollConfig {
    pub title: String,
    /// 2..=8 options; chat votes by typing the 1-based number.
    pub options: Vec<String>,
    /// Seconds until auto-close; 0 = until `poll_stop`.
    pub duration_s: u64,
    /// Action template the winning option injects; `{option}` expands to
    /// the winner's text. Empty = just announce, no action event.
    pub action: String,
}

impl Default for PollConfig {
    fn default() -> Self {
        Self {
            title: String::new(),
            options: Vec::new(),
            duration_s: 30,
            action: String::new(),
        }
    }
}

/// Live status for `/poll.json` + the UI card.
#[derive(Debug, Clone, serde::Serialize)]
pub struct PollStatus {
    pub running: bool,
    pub title: String,
    pub options: Vec<String>,
    /// Votes per option, aligned with `options`.
    pub counts: Vec<u64>,
    pub total: u64,
    /// Seconds until auto-close (0 = manual).
    pub ends_in_s: u64,
    /// Winner text after a finished poll — kept until the next start.
    pub last_winner: String,
}

struct Running {
    cfg: PollConfig,
    counts: Vec<u64>,
    voters: HashSet<String>,
    ends_at: Option<Instant>,
    /// Bumped on every start/stop so a stale timer can't finish the
    /// poll that replaced the one it was spawned for.
    gen: u64,
}

/// Bound on the voter set — a huge raid can't grow memory without end.
const MAX_VOTERS: usize = 100_000;

pub struct PollTracker {
    state: Mutex<Option<Running>>,
    last_winner: Mutex<String>,
    /// Synthetic `kind:"poll"` winner events go back through the mapper
    /// so ordinary trigger rules can act on them.
    raw_tx: mpsc::Sender<RawStreamEvent>,
    overlay_tx: broadcast::Sender<OverlayFrame>,
}

impl PollTracker {
    pub fn new(
        raw_tx: mpsc::Sender<RawStreamEvent>,
        overlay_tx: broadcast::Sender<OverlayFrame>,
    ) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(None),
            last_winner: Mutex::new(String::new()),
            raw_tx,
            overlay_tx,
        })
    }

    /// Starts (or replaces) the running poll. Spawns the auto-close
    /// timer when `duration_s > 0`.
    pub async fn start(self: &Arc<Self>, cfg: PollConfig) -> Result<(), String> {
        if cfg.options.len() < 2 || cfg.options.len() > 8 {
            return Err("Опции голосования: от 2 до 8".into());
        }
        if cfg.options.iter().any(|o| o.trim().is_empty()) {
            return Err("Опции не должны быть пустыми".into());
        }
        let dur = cfg.duration_s;
        let gen;
        {
            let mut st = self.state.lock().await;
            gen = st.as_ref().map(|r| r.gen + 1).unwrap_or(1);
            *st = Some(Running {
                counts: vec![0; cfg.options.len()],
                ends_at: (dur > 0).then(|| Instant::now() + Duration::from_secs(dur)),
                cfg,
                voters: HashSet::new(),
                gen,
            });
        }
        if dur > 0 {
            let this = self.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_secs(dur)).await;
                this.finish(gen).await;
            });
        }
        Ok(())
    }

    /// Ends the running poll now (`poll_stop`).
    pub async fn stop(&self) -> Result<(), String> {
        let gen = self
            .state
            .lock()
            .await
            .as_ref()
            .map(|r| r.gen)
            .ok_or_else(|| "Нет активного голосования".to_string())?;
        self.finish(gen).await;
        Ok(())
    }

    /// Counts a chat comment as a vote when a poll is running. Accepted:
    /// `N`, `!N`, `!vote N` — one vote per viewer (first counts).
    pub async fn note_raw(&self, raw: &RawStreamEvent) {
        if raw.event_kind != "comment" {
            return;
        }
        // A non-vote comment must NOT consume the viewer's vote slot.
        let Some(idx) = parse_vote(&raw.raw_name) else {
            return;
        };
        let mut st = self.state.lock().await;
        let Some(r) = st.as_mut() else { return };
        if idx >= r.counts.len() {
            return;
        }
        let user = raw.user.trim().to_lowercase();
        if user.is_empty() || r.voters.contains(&user) || r.voters.len() >= MAX_VOTERS {
            return;
        }
        r.voters.insert(user);
        r.counts[idx] = r.counts[idx].saturating_add(1);
    }

    /// Snapshot for the UI + `/poll.json`.
    pub async fn status(&self) -> PollStatus {
        let st = self.state.lock().await;
        match st.as_ref() {
            Some(r) => PollStatus {
                running: true,
                title: r.cfg.title.clone(),
                options: r.cfg.options.clone(),
                total: r.counts.iter().sum(),
                counts: r.counts.clone(),
                ends_in_s: r
                    .ends_at
                    .map(|e| e.saturating_duration_since(Instant::now()).as_secs())
                    .unwrap_or(0),
                last_winner: self.last_winner.lock().await.clone(),
            },
            None => PollStatus {
                running: false,
                title: String::new(),
                options: Vec::new(),
                counts: Vec::new(),
                total: 0,
                ends_in_s: 0,
                last_winner: self.last_winner.lock().await.clone(),
            },
        }
    }

    /// Closes the poll if `gen` still matches (guards the auto-timer
    /// against finishing a poll that replaced its own).
    async fn finish(&self, gen: u64) {
        let Some(r) = ({
            let mut st = self.state.lock().await;
            match st.as_ref() {
                Some(r) if r.gen == gen => st.take(),
                _ => None,
            }
        }) else {
            return;
        };
        // Winner = first max; tie → earliest option (deterministic).
        let (win_idx, win_votes) = r
            .counts
            .iter()
            .enumerate()
            .max_by_key(|(i, c)| (**c, std::cmp::Reverse(*i)))
            .map(|(i, c)| (i, *c))
            .unwrap_or((0, 0));
        let winner = r.cfg.options.get(win_idx).cloned().unwrap_or_default();
        let title = if r.cfg.title.is_empty() {
            "Голосование".to_string()
        } else {
            r.cfg.title.clone()
        };
        *self.last_winner.lock().await = winner.clone();

        let _ = self.overlay_tx.send(OverlayFrame::Alert {
            id: format!("poll-{gen}"),
            text: format!("{title}: «{winner}» ({win_votes} голосов)"),
            duration_ms: 6000,
            sound: None,
            media: None,
            position: "top".into(),
            style: "poll".into(),
            user: String::new(),
        });

        // Winner → synthetic ingest event: a rule `kind=poll` can match
        // the option text and run its action through the scheduler.
        if !r.cfg.action.trim().is_empty() {
            let action = r.cfg.action.replace("{option}", &winner);
            let ev = RawStreamEvent {
                source: "poll".into(),
                event_kind: "poll".into(),
                user: "poll".into(),
                avatar_url: String::new(),
                raw_name: format!("{winner}|{action}"),
                amount: win_votes as i32,
                count: 1,
                coins: 0,
                gift_id: None,
                vip: false,
                ts_ms: crate::types::now_ms(),
            };
            let _ = self.raw_tx.try_send(ev);
        }
    }
}

/// Parses a vote comment: `"2"`, `"!3"`, `"!vote 1"` → 0-based index.
fn parse_vote(text: &str) -> Option<usize> {
    let t = text.trim();
    let digits = t
        .strip_prefix("!vote")
        .map(|s| s.trim())
        .or_else(|| t.strip_prefix('!'))
        .unwrap_or(t);
    let n: usize = digits.parse().ok()?;
    n.checked_sub(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (Arc<PollTracker>, mpsc::Receiver<RawStreamEvent>) {
        let (raw_tx, raw_rx) = mpsc::channel(16);
        let (otx, _rx) = broadcast::channel(16);
        (PollTracker::new(raw_tx, otx), raw_rx)
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
            vip: false,
            ts_ms: 0,
        }
    }

    #[tokio::test]
    async fn votes_deduped_per_user_and_winner_injected() {
        let (p, mut raw_rx) = fixture();
        p.start(PollConfig {
            title: "Кого спавнить?".into(),
            options: vec!["зомби".into(), "крипер".into()],
            duration_s: 0,
            action: "spawn {option}".into(),
        })
        .await
        .unwrap();

        p.note_raw(&comment("a", "1")).await;
        p.note_raw(&comment("a", "2")).await; // second vote ignored
        p.note_raw(&comment("b", "2")).await;
        p.note_raw(&comment("c", "!vote 2")).await;
        p.note_raw(&comment("d", "hello")).await; // not a number
        let s = p.status().await;
        assert_eq!(s.counts, vec![1, 2]);

        p.stop().await.unwrap();
        let ev = raw_rx.recv().await.expect("winner event injected");
        assert_eq!(ev.event_kind, "poll");
        assert_eq!(ev.raw_name, "крипер|spawn крипер");
        assert!(!p.status().await.running);
    }

    #[tokio::test]
    async fn auto_close_timer_finishes_once() {
        let (p, mut raw_rx) = fixture();
        p.start(PollConfig {
            title: "t".into(),
            options: vec!["a".into(), "b".into()],
            duration_s: 1,
            action: "x".into(),
        })
        .await
        .unwrap();
        // Restart — the first timer must not kill the second poll.
        p.start(PollConfig {
            title: "t2".into(),
            options: vec!["a".into(), "b".into()],
            duration_s: 0,
            action: "x".into(),
        })
        .await
        .unwrap();
        tokio::time::sleep(Duration::from_millis(1200)).await;
        assert!(p.status().await.running, "stale timer killed new poll");
        p.stop().await.unwrap();
        assert!(raw_rx.recv().await.is_some());
    }

    #[test]
    fn parse_vote_forms() {
        assert_eq!(parse_vote("1"), Some(0));
        assert_eq!(parse_vote("!2"), Some(1));
        assert_eq!(parse_vote("!vote 3"), Some(2));
        assert_eq!(parse_vote("hello"), None);
        assert_eq!(parse_vote("0"), None);
    }
}
