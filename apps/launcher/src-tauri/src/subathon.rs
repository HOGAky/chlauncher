//! Stream timer («субатон») — the countdown app paid events extend:
//! every matched event adds (or steals) seconds, the overlay page
//! renders the clock, and hitting zero fires an alert.
//!
//! Rates and style live in `settings.subathon` (`sec_per_coin`,
//! `sec_per_sub/follow/share`, like batches, `gift_rules`, `max_s`,
//! theme/accent/scale/…); the running state is in-memory only. A
//! single watchdog task (guarded by a generation counter) checks the
//! deadline once a second — extensions just move `ends_at` forward,
//! capped at `max_s` so a whale can't extend forever. Negative gift
//! rules subtract time but can never kill the clock early below 0.

use std::collections::VecDeque;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{broadcast, Mutex};

use crate::settings::SettingsStore;
use crate::types::{OverlayFrame, RawStreamEvent, SubathonCfg};

/// One "+Ns @user" entry for the overlay ticker and the status card.
#[derive(Debug, Clone, serde::Serialize)]
pub struct TimeAdd {
    pub user: String,
    /// Signed seconds applied (negative = stolen time).
    pub sec: i64,
    /// Short label: gift name / `like` / `follow` …
    pub via: String,
}

/// Live status for `/subathon.json` + the UI card.
#[derive(Debug, Clone, serde::Serialize)]
pub struct SubathonStatus {
    pub running: bool,
    pub paused: bool,
    /// Seconds left on the clock (rounded down).
    pub remaining_s: u64,
    /// Absolute deadline epoch ms — pages compute a smooth clock
    /// locally between polls.
    pub ends_at_ms: u64,
    /// Total seconds added by events this run (bragging stat).
    pub added_s: u64,
    /// Recent +/− additions for the ticker (newest last, ≤8).
    pub last_adds: Vec<TimeAdd>,
    /// Full cfg echo so the overlay page styles itself from one call.
    pub cfg: SubathonCfg,
}

struct Running {
    ends_at: Instant,
    added_s: u64,
    /// Some(remaining) while paused — resume restores `ends_at`.
    paused_remaining: Option<Duration>,
    /// Like-batches are fractional: carry leftover likes to the next
    /// event so 60+60 with `likes_per_add=100` still adds once.
    like_carry: u32,
    /// Bumped on start/stop so a stale watchdog can't end the next run.
    gen: u64,
    last_adds: VecDeque<TimeAdd>,
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
                paused_remaining: None,
                like_carry: 0,
                gen,
                last_adds: VecDeque::new(),
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
                        // Paused clocks can't expire.
                        Some(r) if r.gen == gen && r.paused_remaining.is_none() => {
                            Some(r.ends_at.saturating_duration_since(Instant::now()))
                        }
                        _ => None, // stopped/restarted/paused — exit the task
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

    /// Freezes the clock; the expiry watchdog exits.
    pub async fn pause(&self) -> bool {
        let mut st = self.state.lock().await;
        let Some(r) = st.as_mut() else { return false };
        if r.paused_remaining.is_none() {
            r.paused_remaining = Some(r.ends_at.saturating_duration_since(Instant::now()));
            true
        } else {
            false
        }
    }

    /// Unfreezes the clock and respawns the watchdog for `gen`.
    pub async fn resume(self: &Arc<Self>) -> bool {
        let gen = {
            let mut st = self.state.lock().await;
            let Some(r) = st.as_mut() else { return false };
            let Some(rem) = r.paused_remaining.take() else {
                return false;
            };
            r.ends_at = Instant::now() + rem;
            r.gen
        };
        // Restart the expiry loop exactly like `start` does, same gen.
        let this = self.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(1)).await;
                let remaining = {
                    let st = this.state.lock().await;
                    match st.as_ref() {
                        Some(r) if r.gen == gen && r.paused_remaining.is_none() => {
                            Some(r.ends_at.saturating_duration_since(Instant::now()))
                        }
                        _ => None,
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
        true
    }

    /// Live status for `/subathon.json` and the card.
    pub async fn status(&self) -> SubathonStatus {
        let cfg = self.settings.lock().await.data.subathon.clone();
        let st = self.state.lock().await;
        let running = st.as_ref();
        SubathonStatus {
            running: running.is_some(),
            paused: running
                .map(|r| r.paused_remaining.is_some())
                .unwrap_or(false),
            remaining_s: running
                .map(|r| match r.paused_remaining {
                    Some(rem) => rem.as_secs(),
                    None => r
                        .ends_at
                        .saturating_duration_since(Instant::now())
                        .as_secs(),
                })
                .unwrap_or(0),
            ends_at_ms: running
                .filter(|r| r.paused_remaining.is_none())
                .map(|r| {
                    crate::types::now_ms()
                        + r.ends_at
                            .saturating_duration_since(Instant::now())
                            .as_millis() as u64
                })
                .unwrap_or(0),
            added_s: running.map(|r| r.added_s).unwrap_or(0),
            last_adds: running
                .map(|r| r.last_adds.iter().cloned().collect())
                .unwrap_or_default(),
            cfg,
        }
    }

    /// Paid/social events move the clock — called per raw event from
    /// the mapper loop (cheap early-out when stopped or disabled).
    pub async fn note_raw(&self, raw: &RawStreamEvent) {
        let cfg = self.settings.lock().await.data.subathon.clone();
        if !cfg.enabled {
            return;
        }
        let mut st = self.state.lock().await;
        let Some(r) = st.as_mut() else { return };

        // Resolve the signed delta + ticker label.
        let mut add: i64 = 0;
        let mut via = raw.event_kind.clone();
        match raw.event_kind.as_str() {
            "gift" | "donation" => {
                let name = raw.raw_name.to_lowercase();
                if let Some(rule) = cfg
                    .gift_rules
                    .iter()
                    .find(|g| !g.name.is_empty() && g.name.to_lowercase() == name)
                {
                    add = rule.sec * (raw.count.max(1) as i64);
                    via = raw.raw_name.clone();
                } else {
                    add = raw.coins.max(0) * cfg.sec_per_coin as i64;
                    via = raw.raw_name.clone();
                }
            }
            "subscribe" => add = cfg.sec_per_sub as i64,
            "follow" => add = cfg.sec_per_follow as i64,
            "share" => add = cfg.sec_per_share as i64,
            "like" if cfg.likes_per_add > 0 && cfg.like_add_s > 0 => {
                r.like_carry = r.like_carry.saturating_add(raw.count.max(0) as u32);
                let batches = r.like_carry / cfg.likes_per_add;
                r.like_carry %= cfg.likes_per_add;
                add = (batches * cfg.like_add_s) as i64;
            }
            _ => {}
        }
        if add == 0 {
            return;
        }

        if add > 0 {
            let cap = Instant::now() + Duration::from_secs(cfg.max_s as u64);
            if let Some(rem) = r.paused_remaining {
                r.paused_remaining = Some(
                    (rem + Duration::from_secs(add as u64))
                        .min(Duration::from_secs(cfg.max_s as u64)),
                );
            } else {
                r.ends_at = (r.ends_at + Duration::from_secs(add as u64)).min(cap);
            }
            r.added_s = r.added_s.saturating_add(add as u64);
        } else {
            let steal = Duration::from_secs((-add) as u64);
            if let Some(rem) = r.paused_remaining {
                r.paused_remaining = Some(rem.saturating_sub(steal));
            } else {
                // Never push the deadline into the past below ~now —
                // the watchdog handles an actual expiry.
                r.ends_at = r.ends_at.checked_sub(steal).unwrap_or_else(Instant::now);
            }
        }

        r.last_adds.push_back(TimeAdd {
            user: raw.user.clone(),
            sec: add,
            via,
        });
        while r.last_adds.len() > 8 {
            r.last_adds.pop_front();
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
            text: "Время вышло!".into(),
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

    fn ev(kind: &str, name: &str, coins: i64, count: i64) -> RawStreamEvent {
        RawStreamEvent {
            source: "tiktok".into(),
            event_kind: kind.into(),
            user: "u".into(),
            avatar_url: String::new(),
            raw_name: name.into(),
            amount: 1,
            count: count.try_into().unwrap_or(i32::MAX),
            coins,
            gift_id: None,
            vip: false,
            ts_ms: 0,
        }
    }

    #[tokio::test]
    async fn gifts_extend_and_events_while_stopped_do_nothing() {
        let (s, _rx) = fixture();
        s.note_raw(&ev("gift", "Rose", 10, 1)).await; // stopped — ignored
        assert_eq!(s.status().await.remaining_s, 0);

        s.settings.lock().await.data.subathon.sec_per_coin = 10;
        s.start(100).await;
        s.note_raw(&ev("gift", "Rose", 2, 1)).await; // +20 s
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
    async fn pause_freezes_and_resume_restores() {
        let (s, _rx) = fixture();
        s.start(60).await;
        assert!(s.pause().await);
        let frozen = s.status().await.remaining_s;
        tokio::time::sleep(Duration::from_millis(1100)).await;
        assert_eq!(s.status().await.remaining_s, frozen);
        // Events still count while paused.
        s.note_raw(&ev("follow", "", 0, 1)).await;
        let st = s.status().await;
        assert!(st.paused);
        assert!(st.remaining_s > frozen);
        assert!(s.resume().await);
        assert!(!s.status().await.paused);
    }

    #[tokio::test]
    async fn gift_rule_overrides_coin_rate_and_can_steal() {
        let (s, _rx) = fixture();
        {
            let mut set = s.settings.lock().await;
            set.data.subathon.sec_per_coin = 5;
            set.data.subathon.gift_rules = vec![
                crate::types::GiftTimeRule {
                    name: "Rose".into(),
                    sec: 60,
                },
                crate::types::GiftTimeRule {
                    name: "Heart".into(),
                    sec: -30,
                },
            ];
        }
        s.start(300).await;
        s.note_raw(&ev("gift", "rose", 1, 1)).await; // rule: +60 (not 5)
        s.note_raw(&ev("gift", "Heart", 1, 2)).await; // rule: −60
        let st = s.status().await;
        assert!(
            st.remaining_s >= 299 && st.remaining_s <= 300,
            "{}",
            st.remaining_s
        );
        assert_eq!(st.added_s, 60); // only positive adds count toward stat
        assert_eq!(st.last_adds.len(), 2);
        assert_eq!(st.last_adds[1].sec, -60);
    }

    #[tokio::test]
    async fn like_batches_accumulate_fractional() {
        let (s, _rx) = fixture();
        s.start(100).await;
        // 60 + 60 likes with 100-per-batch → +10 once, not twice or never.
        s.note_raw(&ev("like", "", 0, 60)).await;
        s.note_raw(&ev("like", "", 0, 60)).await;
        let st = s.status().await;
        assert!(
            st.remaining_s >= 109 && st.remaining_s <= 110,
            "{}",
            st.remaining_s
        );
    }

    #[tokio::test]
    async fn disabled_cfg_ignores_events() {
        let (s, _rx) = fixture();
        s.settings.lock().await.data.subathon.enabled = false;
        s.start(100).await;
        s.note_raw(&ev("gift", "Rose", 50, 1)).await;
        assert_eq!(s.status().await.added_s, 0);
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
