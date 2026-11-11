//! Viewer points + `!buy` shop («очки зрителей») — the retention loop:
//! chat activity earns points, viewers spend them on shop items that
//! fire game actions.
//!
//! Earning: comment → `per_comment` (once per `comment_cooldown_s`,
//! anti-spam), gift/donation → `per_coin` per coin, sub/follow → flat.
//! Spending: `!buy <name>` looks the item up in `settings.shop_items`,
//! checks the balance, deducts and injects a `shop` event into the
//! ingest pipeline — a trigger rule (`kind=shop`, `match=<name>`) runs
//! the action. An insufficient balance just stays silent (TikTok chat
//! is read-only for us — no error reply possible).
//!
//! Balances persist to `<data_dir>/points.json` with a debounced write
//! (5 s) so a gift train doesn't thrash the disk; caps guard memory.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, Mutex};

use crate::settings::SettingsStore;
use crate::types::RawStreamEvent;

/// Leaderboard row for `points_top` / a future overlay.
#[derive(Debug, Clone, serde::Serialize)]
pub struct PointsRow {
    pub user: String,
    pub points: i64,
}

const MAX_BALANCES: usize = 200_000;
const MAX_COOLDOWNS: usize = 100_000;
/// Coalesce balance writes — a burst marks dirty, one flush per window.
const FLUSH_EVERY: Duration = Duration::from_secs(5);

struct State {
    balances: HashMap<String, i64>,
    /// user → last time comment-points were credited.
    comment_cd: HashMap<String, Instant>,
    dirty: bool,
    last_flush: Instant,
}

pub struct ViewerPoints {
    settings: Arc<Mutex<SettingsStore>>,
    raw_tx: mpsc::Sender<RawStreamEvent>,
    file: std::path::PathBuf,
    state: Mutex<State>,
}

impl ViewerPoints {
    pub fn new(
        settings: Arc<Mutex<SettingsStore>>,
        raw_tx: mpsc::Sender<RawStreamEvent>,
        data_dir: &std::path::Path,
    ) -> Arc<Self> {
        let file = data_dir.join("points.json");
        let balances = std::fs::read_to_string(&file)
            .ok()
            .and_then(|t| serde_json::from_str::<HashMap<String, i64>>(&t).ok())
            .unwrap_or_default();
        Arc::new(Self {
            settings,
            raw_tx,
            file,
            state: Mutex::new(State {
                balances,
                comment_cd: HashMap::new(),
                dirty: false,
                last_flush: Instant::now(),
            }),
        })
    }

    /// Earn + `!buy` handling — one raw event in, called by the mapper
    /// loop. Early-out before any state lock when the economy is off.
    pub async fn note_raw(&self, raw: &RawStreamEvent) {
        let cfg = self.settings.lock().await.data.points.clone();
        if !cfg.enabled {
            return;
        }
        let user = raw.user.trim().to_lowercase();
        if user.is_empty() {
            return;
        }
        // --- earning ---
        let base: i64 = match raw.event_kind.as_str() {
            "comment" => {
                // `!buy` is spending, not earning — skip the point.
                if raw.raw_name.trim_start().starts_with("!buy") {
                    0
                } else {
                    let mut st = self.state.lock().await;
                    let now = Instant::now();
                    let cool = st
                        .comment_cd
                        .get(&user)
                        .map(|t| t.elapsed() < Duration::from_secs(cfg.comment_cooldown_s as u64))
                        .unwrap_or(false);
                    if cool {
                        0
                    } else {
                        if st.comment_cd.len() >= MAX_COOLDOWNS {
                            st.comment_cd.retain(|_, t| {
                                t.elapsed()
                                    < Duration::from_secs(cfg.comment_cooldown_s as u64 * 10)
                            });
                        }
                        st.comment_cd.insert(user.clone(), now);
                        cfg.per_comment as i64
                    }
                }
            }
            "gift" | "donation" => raw.coins.max(0) * cfg.per_coin as i64,
            "subscribe" => cfg.per_sub as i64,
            "follow" => cfg.per_follow as i64,
            _ => 0,
        };
        // VIP viewers (subscriber/mod/super-fan) earn at a multiplier.
        let earn = if raw.vip {
            (base as f64 * cfg.vip_multiplier.max(1.0) as f64) as i64
        } else {
            base
        };
        if earn > 0 {
            let mut st = self.state.lock().await;
            if st.balances.len() < MAX_BALANCES || st.balances.contains_key(&user) {
                *st.balances.entry(user.clone()).or_insert(0) += earn;
                st.dirty = true;
            }
        }
        // --- spending: `!buy <name>` ---
        if raw.event_kind == "comment" {
            if let Some(item_name) = raw
                .raw_name
                .trim()
                .strip_prefix("!buy")
                .map(|s| s.trim().to_lowercase())
                .filter(|s| !s.is_empty())
            {
                self.buy(&user, &item_name).await;
            }
        }
    }

    /// Attempts a purchase: finds the item, checks balance, deducts and
    /// fires the `shop` event. Silent on failure (no chat write-back).
    async fn buy(&self, user: &str, item_name: &str) {
        let item = {
            let s = self.settings.lock().await;
            s.data
                .shop_items
                .iter()
                .find(|i| i.enabled && i.name.trim().eq_ignore_ascii_case(item_name))
                .cloned()
        };
        let Some(item) = item else { return };
        {
            let mut st = self.state.lock().await;
            let bal = st.balances.get_mut(user);
            let Some(b) = bal else { return };
            if *b < item.price as i64 {
                return;
            }
            *b -= item.price as i64;
            st.dirty = true;
        }
        let ev = RawStreamEvent {
            source: "shop".into(),
            event_kind: "shop".into(),
            user: user.to_string(),
            avatar_url: String::new(),
            raw_name: item.name.clone(),
            amount: item.price as i32,
            count: 1,
            coins: 0,
            gift_id: None,
            vip: false,
            ts_ms: crate::types::now_ms(),
        };
        let _ = self.raw_tx.try_send(ev);
    }

    /// One viewer's balance (UI row).
    pub async fn balance(&self, user: &str) -> i64 {
        self.state
            .lock()
            .await
            .balances
            .get(&user.to_lowercase())
            .copied()
            .unwrap_or(0)
    }

    /// Top-N richest viewers — the UI leaderboard.
    pub async fn top(&self, n: usize) -> Vec<PointsRow> {
        let st = self.state.lock().await;
        let mut rows: Vec<(&String, &i64)> = st.balances.iter().collect();
        rows.sort_by(|a, b| b.1.cmp(a.1));
        rows.into_iter()
            .take(n)
            .map(|(u, p)| PointsRow {
                user: u.clone(),
                points: *p,
            })
            .collect()
    }

    /// Admin adjust — give or take points (UI button).
    pub async fn adjust(&self, user: &str, delta: i64) {
        let user = user.trim().to_lowercase();
        if user.is_empty() {
            return;
        }
        let mut st = self.state.lock().await;
        let b = st.balances.entry(user).or_insert(0);
        *b = (*b + delta).max(0);
        st.dirty = true;
    }

    /// Debounced persistence — call periodically (the reporter ticks
    /// every few seconds; a write happens at most once per window and
    /// only when balances changed).
    pub async fn flush_if_dirty(&self) {
        let write = {
            let mut st = self.state.lock().await;
            if !st.dirty || st.last_flush.elapsed() < FLUSH_EVERY {
                return;
            }
            st.dirty = false;
            st.last_flush = Instant::now();
            st.balances.clone()
        };
        // Atomic-ish write: tmp + rename so a crash mid-save can't
        // leave a truncated points.json.
        let tmp = self.file.with_extension("json.tmp");
        if let Ok(text) = serde_json::to_string(&write) {
            if tokio::fs::write(&tmp, text).await.is_ok() {
                let _ = tokio::fs::rename(&tmp, &self.file).await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{PointsCfg, ShopItem};

    fn fixture() -> (Arc<ViewerPoints>, mpsc::Receiver<RawStreamEvent>) {
        let dir = std::env::temp_dir().join(format!("pts-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let settings = Arc::new(Mutex::new(SettingsStore::load(&dir)));
        let (raw_tx, raw_rx) = mpsc::channel(16);
        (ViewerPoints::new(settings, raw_tx, &dir), raw_rx)
    }

    fn ev(user: &str, kind: &str, name: &str, coins: i64) -> RawStreamEvent {
        RawStreamEvent {
            source: "tiktok".into(),
            event_kind: kind.into(),
            user: user.into(),
            avatar_url: String::new(),
            raw_name: name.into(),
            amount: 1,
            count: 1,
            coins,
            gift_id: None,
            vip: false,
            ts_ms: 0,
        }
    }

    async fn enable(p: &Arc<ViewerPoints>) {
        let mut s = p.settings.lock().await;
        s.data.points = PointsCfg {
            enabled: true,
            per_comment: 5,
            comment_cooldown_s: 60,
            per_coin: 10,
            ..Default::default()
        };
        s.data.shop_items = vec![ShopItem {
            id: "i1".into(),
            name: "kill".into(),
            price: 100,
            ..Default::default()
        }];
    }

    #[tokio::test]
    async fn earn_buy_and_insufficient_balance() {
        let (p, mut rx) = fixture();
        enable(&p).await;
        // 3 gifts of 10 coins → 300 pts; comments throttled.
        for _ in 0..3 {
            p.note_raw(&ev("alice", "gift", "Rose", 10)).await;
        }
        p.note_raw(&ev("alice", "comment", "hi", 0)).await; // +5
        p.note_raw(&ev("alice", "comment", "spam", 0)).await; // cooled
        assert_eq!(p.balance("alice").await, 305);

        p.note_raw(&ev("alice", "comment", "!buy kill", 0)).await;
        let e = rx.recv().await.expect("shop event injected");
        assert_eq!(e.event_kind, "shop");
        assert_eq!(e.raw_name, "kill");
        assert_eq!(e.user, "alice");
        assert_eq!(p.balance("alice").await, 205);

        // Bob has nothing — !buy does nothing.
        p.note_raw(&ev("bob", "comment", "!buy kill", 0)).await;
        assert!(rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn balances_round_trip_disk() {
        let (p, _rx) = fixture();
        enable(&p).await;
        p.note_raw(&ev("alice", "gift", "Rose", 7)).await;
        {
            let mut st = p.state.lock().await;
            st.last_flush = Instant::now() - Duration::from_secs(60);
        }
        p.flush_if_dirty().await;
        let dir = p.file.parent().unwrap().to_path_buf();
        let p2 = ViewerPoints::new(p.settings.clone(), p.raw_tx.clone(), &dir);
        assert_eq!(p2.balance("alice").await, 70);
    }
}
