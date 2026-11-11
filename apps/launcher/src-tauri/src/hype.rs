//! Hype meter («шкала хайпа») — a sliding-window sum of paid event
//! coins rendered as a filling bar on `/overlay/hype`. Gift trains and
//! donation bursts push it toward 100%, quiet minutes drain it.
//!
//! In-memory ring of (timestamp, coins) pairs, pruned on every read —
//! free events (likes/comments) don't feed it, money does.

use std::collections::VecDeque;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

use crate::settings::SettingsStore;
use crate::types::RawStreamEvent;

/// Live status for `/hype.json`.
#[derive(Debug, Clone, serde::Serialize)]
pub struct HypeStatus {
    /// Coins seen inside the window.
    pub coins: i64,
    /// 0..=100 — `coins / target_coins`.
    pub level: u32,
    pub target_coins: u32,
    pub window_s: u32,
}

/// Hard cap on stored entries — a batched-like flood can't grow it.
const MAX_ENTRIES: usize = 10_000;

pub struct HypeTracker {
    settings: Arc<Mutex<SettingsStore>>,
    events: Mutex<VecDeque<(Instant, i64)>>,
}

impl HypeTracker {
    pub fn new(settings: Arc<Mutex<SettingsStore>>) -> Arc<Self> {
        Arc::new(Self {
            settings,
            events: Mutex::new(VecDeque::new()),
        })
    }

    /// Feeds one raw event — only coin-bearing kinds count. Called per
    /// event from the mapper loop; a no-op fast path when coins == 0.
    pub async fn note_raw(&self, raw: &RawStreamEvent) {
        if raw.coins <= 0 {
            return;
        }
        let window = {
            let s = self.settings.lock().await;
            Duration::from_secs(s.data.hype.window_s.max(5) as u64)
        };
        let mut ev = self.events.lock().await;
        let cutoff = Instant::now() - window;
        while ev.front().map(|(t, _)| *t < cutoff).unwrap_or(false) {
            ev.pop_front();
        }
        if ev.len() < MAX_ENTRIES {
            ev.push_back((Instant::now(), raw.coins));
        }
    }

    /// Snapshot for `/hype.json` — prunes the ring on read so a silent
    /// stream doesn't need a background reaper.
    pub async fn status(&self) -> HypeStatus {
        let cfg = self.settings.lock().await.data.hype.clone();
        let mut ev = self.events.lock().await;
        let cutoff = Instant::now() - Duration::from_secs(cfg.window_s.max(5) as u64);
        while ev.front().map(|(t, _)| *t < cutoff).unwrap_or(false) {
            ev.pop_front();
        }
        let coins: i64 = ev.iter().map(|(_, c)| c).sum();
        let level = if cfg.target_coins > 0 {
            (coins * 100 / cfg.target_coins as i64).clamp(0, 100) as u32
        } else {
            0
        };
        HypeStatus {
            coins,
            level,
            target_coins: cfg.target_coins,
            window_s: cfg.window_s,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Arc<HypeTracker> {
        let dir = std::env::temp_dir().join(format!("hype-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        HypeTracker::new(Arc::new(Mutex::new(SettingsStore::load(&dir))))
    }

    fn gift(coins: i64) -> RawStreamEvent {
        RawStreamEvent {
            source: "tiktok".into(),
            event_kind: "gift".into(),
            user: "u".into(),
            avatar_url: String::new(),
            raw_name: "Rose".into(),
            amount: 1,
            count: 1,
            coins,
            gift_id: None,
            ts_ms: 0,
        }
    }

    #[tokio::test]
    async fn coins_fill_level_and_free_events_do_nothing() {
        let h = fixture();
        h.settings.lock().await.data.hype.target_coins = 100;
        h.note_raw(&gift(0)).await;
        h.note_raw(&gift(40)).await;
        h.note_raw(&gift(60)).await;
        let st = h.status().await;
        assert_eq!(st.coins, 100);
        assert_eq!(st.level, 100);
    }
}
