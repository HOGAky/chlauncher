//! Event hub + trigger mapper — the launcher's nervous system.
//!
//! ```text
//! integrations ─┐
//! simulator  ───┤ raw events → TriggerMapper → StreamEvent ─┬→ game WS :9876
//!               │                                            ├→ overlay WS :9877
//!               └────────────────────────────────────────────┴→ frontend (tauri event)
//! ```
//!
//! `EventHub::dispatch` is the single funnel every event flows through —
//! that's what lets one TikTok/DonationAlerts connection serve every game.

use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use tokio::sync::broadcast;

use crate::types::{RawStreamEvent, StreamEvent, TriggerProfile, TriggerRule};

/// How many recent events are kept for the overlay snapshot & UI feed.
const RECENT_CAPACITY: usize = 100;

/// Broadcast hub: every consumer subscribes to `tx`.
pub struct EventHub {
    pub tx: broadcast::Sender<StreamEvent>,
    /// Rolling window of recent events (newest last) for late joiners.
    pub recent: Mutex<VecDeque<StreamEvent>>,
    /// Aggregate stats for the overlay's "top gifters" board.
    pub totals: Mutex<HashMap<String, i64>>,
}

impl EventHub {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(512);
        Self {
            tx,
            recent: Mutex::new(VecDeque::with_capacity(RECENT_CAPACITY)),
            totals: Mutex::new(HashMap::new()),
        }
    }

    /// Records and broadcasts one mapped event to all consumers.
    pub fn dispatch(&self, ev: StreamEvent) {
        {
            let mut recent = self.recent.lock().unwrap();
            if recent.len() >= RECENT_CAPACITY {
                recent.pop_front();
            }
            recent.push_back(ev.clone());
        }
        {
            let mut totals = self.totals.lock().unwrap();
            *totals.entry(ev.user.clone()).or_default() += ev.amount as i64;
        }
        // No receivers is fine — broadcast just drops the message.
        let _ = self.tx.send(ev);
    }

    /// Snapshot of recent events (newest first) for overlays/UI catch-up.
    pub fn recent_events(&self) -> Vec<StreamEvent> {
        self.recent
            .lock()
            .unwrap()
            .iter()
            .rev()
            .cloned()
            .collect()
    }

    /// Top contributors by cumulative amount (for the overlay leaderboard).
    pub fn top_supporters(&self, n: usize) -> Vec<(String, i64)> {
        let totals = self.totals.lock().unwrap();
        let mut v: Vec<(String, i64)> = totals.clone().into_iter().collect();
        v.sort_by(|a, b| b.1.cmp(&a.1));
        v.truncate(n);
        v
    }
}

/// Stateless mapper from raw integration events to game commands.
pub struct TriggerMapper;

impl TriggerMapper {
    /// Applies a profile's rules to a raw event. First matching rule wins;
    /// returns `None` when nothing matches (event is dropped).
    pub fn map(raw: &RawStreamEvent, profile: &TriggerProfile) -> Option<StreamEvent> {
        let rule = profile.rules.iter().find(|r| Self::matches(r, raw))?;
        Some(Self::apply(rule, raw))
    }

    /// Whether one rule matches a raw event.
    fn matches(rule: &TriggerRule, raw: &RawStreamEvent) -> bool {
        let source_ok = rule.source == "any" || rule.source == raw.source;
        let kind_ok = rule.event_kind == "any" || rule.event_kind == raw.event_kind;
        let name_ok = rule.match_value.is_empty()
            || raw
                .raw_name
                .to_lowercase()
                .contains(&rule.match_value.to_lowercase());
        let amount_ok = raw.amount >= rule.min_amount;
        source_ok && kind_ok && name_ok && amount_ok
    }

    /// Produces the mapped event from a matched rule.
    fn apply(rule: &TriggerRule, raw: &RawStreamEvent) -> StreamEvent {
        StreamEvent {
            source: raw.source.clone(),
            event_kind: raw.event_kind.clone(),
            user: raw.user.clone(),
            avatar_url: raw.avatar_url.clone(),
            action_command: rule.action.clone(),
            amount: ((raw.amount as f32) * rule.multiplier.max(0.0)) as i32,
            raw_name: raw.raw_name.clone(),
        }
    }

    /// The factory-default profile seeded for every game — mirrors the
    /// examples in the product spec.
    pub fn default_profile(game_slug: &str) -> TriggerProfile {
        let mk = |source: &str, kind: &str, match_value: &str, min: i32, action: &str| {
            TriggerRule {
                id: uuid::Uuid::new_v4().to_string(),
                source: source.into(),
                event_kind: kind.into(),
                match_value: match_value.into(),
                min_amount: min,
                action: action.into(),
                multiplier: 1.0,
            }
        };
        TriggerProfile {
            game_slug: game_slug.into(),
            rules: vec![
                mk("tiktok", "gift", "Rose", 0, "spawn_enemy"),
                mk("donationalerts", "donation", "", 100, "spawn_boss"),
                mk("tiktok", "like", "", 100, "heal_player"),
                // Catch-all so unmapped traffic still shows up in-game.
                mk("any", "any", "", 0, "log_only"),
            ],
        }
    }

    /// Named presets a streamer can apply in one click. `"steal-the-stream"`
    /// covers the whitelist from `docs/roblox-integration.md` §C /
    /// `DESIGN.md` §5.7 in the Roblox project.
    pub fn template_profile(game_slug: &str, name: &str) -> Option<TriggerProfile> {
        let mk = |source: &str, kind: &str, match_value: &str, min: i32, action: &str| {
            TriggerRule {
                id: uuid::Uuid::new_v4().to_string(),
                source: source.into(),
                event_kind: kind.into(),
                match_value: match_value.into(),
                min_amount: min,
                action: action.into(),
                multiplier: 1.0,
            }
        };
        let rules = match name {
            "steal-the-stream" => vec![
                // Sabotage tier — the expensive gifts do the mean things.
                mk("tiktok", "gift", "Drama", 0, "drop_floor"),
                mk("tiktok", "gift", "Whale", 0, "yeet"),
                mk("tiktok", "gift", "Lion", 0, "spawn_chaser"),
                mk("tiktok", "gift", "Galaxy", 0, "invert_controls"),
                mk("tiktok", "gift", "Rocket", 0, "camera_spin"),
                // Mid tier.
                mk("tiktok", "gift", "Rose", 0, "coin_rain"),
                mk("tiktok", "gift", "", 500, "slow_field"),
                mk("tiktok", "gift", "", 0, "fireworks"),
                // Free interactions.
                mk("tiktok", "like", "", 100, "speed_boost"),
                mk("tiktok", "follow", "", 0, "fireworks"),
                mk("tiktok", "share", "", 0, "shield"),
                mk("tiktok", "subscribe", "", 0, "checkpoint"),
                mk("tiktok", "comment", "!chase", 0, "spawn_chaser"),
                mk("tiktok", "comment", "!freeze", 0, "freeze"),
                mk("tiktok", "comment", "!wall", 0, "wall_ahead"),
                mk("tiktok", "comment", "!clones", 0, "decoy_clones"),
                mk("donationalerts", "donation", "", 10000, "yeet"),
                mk("any", "any", "", 0, "log_only"),
            ],
            _ => return None,
        };
        Some(TriggerProfile {
            game_slug: game_slug.into(),
            rules,
        })
    }
}

/// Serializable notification pushed to the React frontend for its live
/// feed panel — wraps the mapped event plus a wall-clock timestamp.
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize)]
pub struct EventFeedItem {
    pub ts: u64,
    pub event: StreamEvent,
}
