//! Subathon («субатон») — the classic countdown timer paid events
//! extend: every gift coin and subscription adds seconds to the clock,
//! the overlay shows the remaining time, and hitting zero fires an
//! alert.
//!
//! Rates live in `settings.subathon` (`sec_per_coin`, `sec_per_sub`,
//! `max_s`); the running state is in-memory only. A single watchdog
//! task (started lazily, guarded by a generation counter) checks the
//! deadline once a second — extensions just move `ends_at` forward,
//! capped at `max_s` so a whale can't extend forever.

use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{broadcast, Mutex};

use crate::settings::SettingsStore;
use crate::types::{OverlayFrame, RawStreamEvent};

/// Live status for `/subathon.json` + the UI card.
#[derive(Debug, Clone, serde::Serialize)]
pub struct SubathonStatus {
    pub running: bool,
    /// Seconds left on the clock.
    pub remaining_s: u64,
    /// Total seconds added by events this run (bragging stat).
    pub added_s: u64,
    pub sec_per_coin: u32,
    pub sec_per_sub: u32,
    pub max_s: u32,
}

struct Running {
    ends_at: Instant,
    added_s: u64,
    /// Bumped on start/stop so a stale watchdog can't end the next run.
    gen: u64,
}

pub struct Subathon {
    settings: Arc<Mutex<SettingsStore>>,
    overlay_tx: broadcast::Sender<OverlayFrame>,
    state: Mutex<Option<Running>>,
}

impl Subathon {
    pub fn new(
        settings: Arc<Mutex<SettingsStore>>,
        overlay_tx: broadcast::Sender<OverlayFrame>,
    ) -> Arc<Self> {
        Arc::new(Self {
            settings,
            overlay_tx,
            state: Mutex::new(None),
        })
    }

    /// Starts (or restarts) the countdown for `dur_s` seconds and spawns
    /// the deadline watchdog.
    pub async fn start(self: &Arc<Self>, dur_s: u64) {
        let gen = {
            let mut st = self.state.lock().await;
            let gen = st.as_ref().map(|r| r.gen + 1).unwrap_or(1);
            *st = Some(Running {
                ends_at: Instant::now() + Duration::from_secs(dur_s.min(7 * 24 * 3600)),
                added_s: 0,
                gen,
            });
            gen
        };
        let this = self.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(1)).await;
                let remaining = {
                    let st = this.state.lock().await;
                    match st.as_ref() {
                        Some(r) if r.gen == gen => {
                            Some(r.ends_at.saturating_duration_since(Instant::now()))
                        }
                        _ => None, // stopped/restarted — exit the task
                    }
                };
                match remaining {
                    None => break,
                    Some(rem) if rem.is_zero() => {
                        this.finish(gen).await;
                        break;
                    }
                    _ => continue,
                }
            }
        });
    }

    /// Stops the countdown without firing the end alert.
    pub async fn stop(&self) {
        self.state.lock().await.take();
    }

    /// Live status for `/subathon.json` and the card.
    pub async fn status(&self) -> SubathonStatus {
        let cfg = self.settings.lock().await.data.subathon.clone();
        let st = self.state.lock().await;
        SubathonStatus {
            running: st.is_some(),
            remaining_s: st
                .as_ref()
                .map(|r| {
                    r.ends_at
                        .saturating_duration_since(Instant::now())
                        .as_secs()
                })
                .unwrap_or(0),
            added_s: st.as_ref().map(|r| r.added_s).unwrap_or(0),
            sec_per_coin: cfg.sec_per_coin,
            sec_per_sub: cfg.sec_per_sub,
            max_s: cfg.max_s,
        }
    }

    /// Paid events extend the clock — called per raw event from the
    /// mapper loop (cheap early-out when stopped or rates are 0).
    pub async fn note_raw(&self, raw: &RawStreamEvent) {
        let cfg = self.settings.lock().await.data.subathon.clone();
        let add = match raw.event_kind.as_str() {
            "gift" | "donation" => (raw.coins.max(0) as u64) * cfg.sec_per_coin as u64,
            "subscribe" => cfg.sec_per_sub as u64,
            _ => 0,
        };
        if add == 0 {
            return;
        }
        let mut st = self.state.lock().await;
        if let Some(r) = st.as_mut() {
            let cap = Instant::now() + Duration::from_secs(cfg.max_s as u64);
            r.ends_at = (r.ends_at + Duration::from_secs(add)).min(cap);
            r.added_s = r.added_s.saturating_add(add);
        }
    }

    /// Time's up — one alert, run over.
    async fn finish(&self, gen: u64) {
        let mut st = self.state.lock().await;
        match st.as_ref() {
            Some(r) if r.gen == gen => st.take(),
            _ => return,
        };
        let _ = self.overlay_tx.send(OverlayFrame::Alert {
            id: format!("subathon-{gen}"),
            text: "Субатон завершён!".into(),
            duration_ms: 8000,
            sound: None,
            media: None,
            position: "top".into(),
            style: "subathon".into(),
            user: String::new(),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (Arc<Subathon>, broadcast::Receiver<OverlayFrame>) {
        let dir = std::env::temp_dir().join(format!("suba-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let settings = Arc::new(Mutex::new(SettingsStore::load(&dir)));
        let (otx, rx) = broadcast::channel(16);
        (Subathon::new(settings, otx), rx)
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
    async fn gifts_extend_and_events_while_stopped_do_nothing() {
        let (s, _rx) = fixture();
        s.note_raw(&gift(10)).await; // stopped — ignored
        assert_eq!(s.status().await.remaining_s, 0);

        s.settings.lock().await.data.subathon.sec_per_coin = 10;
        s.start(100).await;
        s.note_raw(&gift(2)).await; // +20 s
        let st = s.status().await;
        assert!(
            st.remaining_s >= 118 && st.remaining_s <= 120,
            "{}",
            st.remaining_s
        );
        assert_eq!(st.added_s, 20);
        s.stop().await;
        assert!(!s.status().await.running);
    }

    #[tokio::test]
    async fn expiry_fires_alert_once() {
        let (s, mut rx) = fixture();
        s.start(1).await;
        tokio::time::sleep(Duration::from_millis(1600)).await;
        assert!(!s.status().await.running);
        let mut alerts = 0;
        while let Ok(f) = rx.try_recv() {
            if matches!(f, OverlayFrame::Alert { style, .. } if style == "subathon") {
                alerts += 1;
            }
        }
        assert_eq!(alerts, 1);
    }
}
