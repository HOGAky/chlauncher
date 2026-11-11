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

use crate::types::{RawStreamEvent, StreamEvent, TriggerPreset, TriggerProfile, TriggerRule};

/// How many recent events are kept for the overlay snapshot & UI feed.
const RECENT_CAPACITY: usize = 100;

/// Broadcast hub: every consumer subscribes to `tx`.
pub struct EventHub {
    pub tx: broadcast::Sender<StreamEvent>,
    /// Rolling window of recent events (newest last) for late joiners.
    pub recent: Mutex<VecDeque<StreamEvent>>,
    /// Aggregate stats for the overlay's "top gifters" board.
    pub totals: Mutex<HashMap<String, i64>>,
    /// UI feed — fired *and* skipped events with a status label (§2.2:
    /// the streamer sees why a rule didn't fire). Newest last.
    pub feed: Mutex<VecDeque<crate::types::FeedItem>>,
}

impl Default for EventHub {
    fn default() -> Self {
        Self::new()
    }
}

impl EventHub {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(512);
        Self {
            tx,
            recent: Mutex::new(VecDeque::with_capacity(RECENT_CAPACITY)),
            totals: Mutex::new(HashMap::new()),
            feed: Mutex::new(VecDeque::with_capacity(RECENT_CAPACITY)),
        }
    }

    /// Records and broadcasts one mapped event to all consumers.
    pub fn dispatch(&self, ev: StreamEvent) {
        self.note(ev.clone(), "done");
        {
            let mut recent = self.recent.lock().unwrap_or_else(|p| p.into_inner());
            if recent.len() >= RECENT_CAPACITY {
                recent.pop_front();
            }
            recent.push_back(ev.clone());
        }
        {
            // Session-scoped leaderboard — hard-capped so a marathon
            // stream with hundreds of thousands of distinct viewers
            // can't grow this map without bound.
            const TOTALS_CAP: usize = 100_000;
            let mut totals = self.totals.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(v) = totals.get_mut(&ev.user) {
                *v += ev.amount as i64;
            } else if totals.len() < TOTALS_CAP {
                totals.insert(ev.user.clone(), ev.amount as i64);
            }
        }
        // No receivers is fine — broadcast just drops the message.
        let _ = self.tx.send(ev);
    }

    /// Appends an entry to the statusful UI feed (bounded like `recent`).
    /// Called by `dispatch` for fired events and by the scheduler for
    /// skipped ones (cooldown/limit/paused) — never reaches games.
    pub fn note(&self, ev: StreamEvent, status: &str) {
        let mut feed = self.feed.lock().unwrap_or_else(|p| p.into_inner());
        if feed.len() >= RECENT_CAPACITY {
            feed.pop_front();
        }
        feed.push_back(crate::types::FeedItem {
            ts: crate::types::now_ms() / 1000,
            status: status.into(),
            ack: None,
            event: ev,
        });
    }

    /// Adapter back-channel (§10.1): marks the feed entry carrying
    /// `event_id` as executed/failed in-game — «выполнено в игре».
    pub fn note_ack(&self, event_id: &str, ok: bool) {
        if event_id.is_empty() {
            return;
        }
        let mut feed = self.feed.lock().unwrap_or_else(|p| p.into_inner());
        for item in feed.iter_mut().rev() {
            if item.event.event_id == event_id {
                item.ack = Some(ok);
                break;
            }
        }
    }

    /// Snapshot of the statusful feed (newest first) for the UI.
    pub fn feed_items(&self) -> Vec<crate::types::FeedItem> {
        self.feed
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .iter()
            .rev()
            .cloned()
            .collect()
    }

    /// Snapshot of recent events (newest first) for overlays/UI catch-up.
    pub fn recent_events(&self) -> Vec<StreamEvent> {
        self.recent
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .iter()
            .rev()
            .cloned()
            .collect()
    }

    /// Top contributors by cumulative amount (for the overlay leaderboard).
    /// Sorts references and clones only the top N — the map can hold
    /// 100k entries and this is polled every few seconds per page.
    pub fn top_supporters(&self, n: usize) -> Vec<(String, i64)> {
        let totals = self.totals.lock().unwrap_or_else(|p| p.into_inner());
        let mut v: Vec<(&String, &i64)> = totals.iter().collect();
        v.sort_by(|a, b| b.1.cmp(a.1).then_with(|| a.0.cmp(b.0)));
        v.truncate(n);
        v.into_iter().map(|(u, t)| (u.clone(), *t)).collect()
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

    /// All rules matching a raw event — walks top→bottom, skips disabled
    /// rules, stops at the first match that doesn't set
    /// `continue_matching` (§2.1).
    pub fn match_all<'a>(
        raw: &RawStreamEvent,
        profile: &'a TriggerProfile,
    ) -> Vec<&'a TriggerRule> {
        let mut out = Vec::new();
        for rule in &profile.rules {
            if !Self::matches(rule, raw) {
                continue;
            }
            let cont = rule.continue_matching;
            out.push(rule);
            if !cont {
                break;
            }
        }
        out
    }

    /// Whether one rule matches a raw event. Disabled rules never match;
    /// `match_mode` picks the comparison — `"contains"` (legacy),
    /// `"exact"` (case-insensitive whole name) or `"gift_id"` (stable id).
    fn matches(rule: &TriggerRule, raw: &RawStreamEvent) -> bool {
        if !rule.enabled {
            return false;
        }
        let source_ok = rule.source == "any" || rule.source == raw.source;
        let kind_ok = rule.event_kind == "any" || rule.event_kind == raw.event_kind;
        let name_ok = if rule.match_value.is_empty() {
            true
        } else {
            match rule.match_mode.as_str() {
                "exact" => raw.raw_name.eq_ignore_ascii_case(&rule.match_value),
                "gift_id" => raw
                    .gift_id
                    .map(|id| id.to_string() == rule.match_value)
                    .unwrap_or(false),
                _ => raw
                    .raw_name
                    .to_lowercase()
                    .contains(&rule.match_value.to_lowercase()),
            }
        };
        let amount_ok = raw.amount >= rule.min_amount;
        source_ok && kind_ok && name_ok && amount_ok
    }

    /// Produces the mapped event from a matched rule.
    pub fn apply(rule: &TriggerRule, raw: &RawStreamEvent) -> StreamEvent {
        StreamEvent {
            source: raw.source.clone(),
            event_kind: raw.event_kind.clone(),
            user: raw.user.clone(),
            avatar_url: raw.avatar_url.clone(),
            action_command: rule.action.clone(),
            amount: ((raw.amount as f32) * rule.multiplier.max(0.0)) as i32,
            raw_name: raw.raw_name.clone(),
            // Unique id per dispatch — adapters echo it in `ack` frames.
            event_id: uuid::Uuid::new_v4().to_string(),
        }
    }

    /// The factory-default profile seeded for every game — mirrors the
    /// examples in the product spec.
    pub fn default_profile(game_slug: &str) -> TriggerProfile {
        let mk =
            |source: &str, kind: &str, match_value: &str, min: i32, action: &str| TriggerRule {
                id: uuid::Uuid::new_v4().to_string(),
                source: source.into(),
                event_kind: kind.into(),
                match_value: match_value.into(),
                min_amount: min,
                action: action.into(),
                ..Default::default()
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
            ..Default::default()
        }
    }

    /// The presets shipped with the launcher. `"steal-the-stream"`
    /// covers the whitelist from `docs/roblox-integration.md` §C /
    /// `DESIGN.md` §5.7 in the Roblox project.
    pub fn builtin_presets() -> Vec<TriggerPreset> {
        let mk =
            |source: &str, kind: &str, match_value: &str, min: i32, action: &str| TriggerRule {
                id: uuid::Uuid::new_v4().to_string(),
                source: source.into(),
                event_kind: kind.into(),
                match_value: match_value.into(),
                min_amount: min,
                action: action.into(),
                ..Default::default()
            };
        vec![
        TriggerPreset {
            name: "steal-the-stream".into(),
            game_slug: None,
            description: "Обстрел подарками: дорогие — хаос, бесплатные действия — помощь".into(),
            builtin: true,
            rules: vec![
                // Sabotage tier — the expensive gifts do the mean things.
                mk("tiktok", "gift", "Drama", 0, "drop_floor"),
                mk("tiktok", "gift", "Whale", 0, "yeet"),
                mk("tiktok", "gift", "Lion", 0, "spawn_chaser"),
                mk("tiktok", "gift", "Galaxy", 0, "invert_controls"),
                mk("tiktok", "gift", "Rocket", 0, "camera_spin"),
                // Mid tier.
                mk("tiktok", "gift", "Rose", 0, "coin_rain"),
                // Amount tiers for any unnamed gift (first match wins —
                // thresholds run high → low, matching the ~coin values).
                mk("tiktok", "gift", "", 2000, "drop_floor"),
                mk("tiktok", "gift", "", 1000, "spawn_chaser"),
                mk("tiktok", "gift", "", 500, "slow_field"),
                mk("tiktok", "gift", "", 100, "coin_rain"),
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
                // Room bootstrap — the streamer appends the real room id
                // in the UI: action becomes start_game:<id>.
                mk("tiktok", "comment", "!start", 0, "start_game"),
                mk("donationalerts", "donation", "", 10000, "yeet"),
                mk("any", "any", "", 0, "log_only"),
            ],
            ..Default::default()
        },
        // §9 pilot — Survival on vanilla commands only (no plugins).
        // `action` IS the console command; `{player}`/ `{user}`/`{count}`/
        // `{gift}` are rendered+sanitized by minecraft::templates.
        TriggerPreset {
            name: "mc-survival".into(),
            game_slug: Some("minecraft".into()),
            description: "Minecraft Survival: ванильные команды — подарки хаосят, бесплатные действия помогают".into(),
            builtin: true,
            rules: vec![
                // Big gifts — chaos around the player.
                mk("tiktok", "gift", "Whale", 0,
                   "execute at {player} run summon minecraft:warden ~ ~3 ~\nsay {user} призвал Warden!"),
                mk("tiktok", "gift", "Lion", 0,
                   "execute at {player} run summon minecraft:lightning_bolt ~ ~ ~\nexecute at {player} run summon minecraft:zombie ~2 ~ ~"),
                mk("tiktok", "gift", "Galaxy", 0,
                   "execute at {player} run effect give @p minecraft:levitation 10 1\nsay {user} отправил стримера в полёт"),
                mk("tiktok", "gift", "Drama", 0,
                   "execute at {player} run summon minecraft:creeper ~ ~ ~\nexecute at {player} run summon minecraft:creeper ~1 ~ ~1"),
                // Mid tier.
                mk("tiktok", "gift", "Rose", 0,
                   "give {player} minecraft:diamond {count}\nsay спасибо {user} за {gift}"),
                mk("tiktok", "gift", "", 2000,
                   "execute at {player} run summon minecraft:tnt ~ ~3 ~"),
                mk("tiktok", "gift", "", 500,
                   "execute at {player} run summon minecraft:zombie ~2 ~ ~"),
                mk("tiktok", "gift", "", 100,
                   "give {player} minecraft:golden_apple 1"),
                mk("tiktok", "gift", "", 0,
                   "execute at {player} run summon minecraft:firework_rocket ~ ~ ~"),
                // Free interactions help.
                mk("tiktok", "like", "", 500,
                   "effect give {player} minecraft:speed 30 0"),
                mk("tiktok", "follow", "", 0,
                   "give {player} minecraft:cooked_beef 8"),
                mk("tiktok", "subscribe", "", 0,
                   "give {player} minecraft:totem_of_undying 1\ntitle {player} title \"Новый саб!\""),
                // Chat commands.
                mk("tiktok", "comment", "!storm", 0, "weather thunder"),
                mk("tiktok", "comment", "!clear", 0, "weather clear"),
                mk("tiktok", "comment", "!night", 0, "time set night"),
                mk("tiktok", "comment", "!day", 0, "time set day"),
                mk("tiktok", "comment", "!heal", 0,
                   "effect give {player} minecraft:instant_health 1 1"),
                mk("donationalerts", "donation", "", 10000,
                   "execute at {player} run summon minecraft:wither ~ ~5 ~\nsay ДОНАТ {user}: WITHER!"),
                mk("donationalerts", "donation", "", 0,
                   "give {player} minecraft:diamond 1\nsay донат от {user}"),
                // Catch-all stays visible in console without spamming
                // the world — `say` is the vanilla-safe no-op.
                mk("any", "any", "", 0, "say {user}: {gift}"),
            ],
            ..Default::default()
        }]
    }

    /// Looks up a preset by name — built-ins first, then streamer customs.
    pub fn find_preset<'a>(
        name: &str,
        customs: &'a std::collections::HashMap<String, TriggerPreset>,
    ) -> Option<TriggerPreset> {
        Self::builtin_presets()
            .into_iter()
            .find(|p| p.name == name)
            .or_else(|| customs.get(name).cloned())
    }

    /// Whether a name is reserved by a built-in preset.
    pub fn is_builtin_preset(name: &str) -> bool {
        Self::builtin_presets().iter().any(|p| p.name == name)
    }

    /// Applies a preset over a game's profile — records the preset name
    /// and inherits its overlay style / global cooldown.
    pub fn profile_from_preset(game_slug: &str, preset: &TriggerPreset) -> TriggerProfile {
        TriggerProfile {
            game_slug: game_slug.into(),
            preset: Some(preset.name.clone()),
            overlay: preset.overlay.clone(),
            global_cooldown_ms: preset.global_cooldown_ms,
            rules: preset.rules.clone(),
            ..Default::default()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn customs() -> std::collections::HashMap<String, TriggerPreset> {
        let mut m = std::collections::HashMap::new();
        m.insert(
            "my-mix".into(),
            TriggerPreset {
                name: "my-mix".into(),
                game_slug: Some("mock-game".into()),
                rules: vec![TriggerRule {
                    id: "r1".into(),
                    source: "tiktok".into(),
                    event_kind: "gift".into(),
                    match_value: "Lion".into(),
                    action: "spawn_boss".into(),
                    ..Default::default()
                }],
                ..Default::default()
            },
        );
        m
    }

    #[test]
    fn builtin_then_custom_lookup() {
        assert!(TriggerMapper::find_preset("steal-the-stream", &customs()).is_some());
        assert!(TriggerMapper::find_preset("my-mix", &customs()).is_some());
        assert!(TriggerMapper::find_preset("nope", &customs()).is_none());
        assert!(TriggerMapper::is_builtin_preset("steal-the-stream"));
        assert!(!TriggerMapper::is_builtin_preset("my-mix"));
    }

    #[test]
    fn applied_profile_records_preset() {
        let p = TriggerMapper::find_preset("my-mix", &customs()).unwrap();
        let profile = TriggerMapper::profile_from_preset("mock-game", &p);
        assert_eq!(profile.preset.as_deref(), Some("my-mix"));
        assert_eq!(profile.rules.len(), 1);
        assert_eq!(profile.rules[0].action, "spawn_boss");
    }

    #[test]
    fn steal_the_stream_rules_match() {
        let profile =
            TriggerMapper::profile_from_preset("mock-game", &TriggerMapper::builtin_presets()[0]);
        let whale = RawStreamEvent {
            source: "tiktok".into(),
            event_kind: "gift".into(),
            user: "u".into(),
            avatar_url: String::new(),
            amount: 1,
            raw_name: "Whale".into(),
            count: 1,
            coins: 0,
            gift_id: None,
            vip: false,
            ts_ms: 0,
        };
        let ev = TriggerMapper::map(&whale, &profile).unwrap();
        assert_eq!(ev.action_command, "yeet");
        assert_eq!(profile.preset.as_deref(), Some("steal-the-stream"));
    }

    #[test]
    fn mapped_events_get_unique_event_ids() {
        let profile =
            TriggerMapper::profile_from_preset("mock-game", &TriggerMapper::builtin_presets()[0]);
        let raw = RawStreamEvent {
            source: "tiktok".into(),
            event_kind: "gift".into(),
            user: "u".into(),
            avatar_url: String::new(),
            amount: 1,
            raw_name: "Whale".into(),
            count: 1,
            coins: 0,
            gift_id: None,
            vip: false,
            ts_ms: 0,
        };
        let a = TriggerMapper::map(&raw, &profile).unwrap();
        let b = TriggerMapper::map(&raw, &profile).unwrap();
        assert!(!a.event_id.is_empty());
        assert_ne!(a.event_id, b.event_id);
    }

    #[test]
    fn note_ack_marks_feed_entry_by_event_id() {
        let hub = EventHub::new();
        let ev = StreamEvent {
            source: "simulator".into(),
            event_kind: "gift".into(),
            user: "u".into(),
            avatar_url: String::new(),
            action_command: "x".into(),
            amount: 1,
            raw_name: "r".into(),
            event_id: "evt-1".into(),
        };
        hub.dispatch(ev.clone());
        assert_eq!(hub.feed_items()[0].ack, None);
        hub.note_ack("evt-1", true);
        assert_eq!(hub.feed_items()[0].ack, Some(true));
        hub.note_ack("unknown", false); // no match — nothing changes
        assert_eq!(hub.feed_items()[0].ack, Some(true));
        hub.note_ack("", false); // empty ids are ignored
    }

    /// The session leaderboard is hard-capped: a marathon stream with
    /// hundreds of thousands of distinct viewers must not grow `totals`
    /// without bound — new users stop being tracked past the cap while
    /// existing entries keep accumulating.
    #[test]
    fn totals_map_is_capped() {
        let hub = EventHub::new();
        let ev_for = |user: String| StreamEvent {
            source: "s".into(),
            event_kind: "gift".into(),
            user,
            avatar_url: String::new(),
            action_command: "x".into(),
            amount: 1,
            raw_name: "r".into(),
            event_id: String::new(),
        };
        for i in 0..100_005 {
            hub.dispatch(ev_for(format!("u{i}")));
        }
        hub.dispatch(ev_for("u0".into())); // existing entry still counts
        assert_eq!(hub.totals.lock().unwrap().len(), 100_000);
        let top = hub.top_supporters(1);
        assert_eq!(top[0].0, "u0");
        assert_eq!(top[0].1, 2);
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
