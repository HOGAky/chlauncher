//! Built-in interactive TikTok games (parity spec — игры внутри лаунчера).
//!
//! The game LOGIC lives in the overlay pages (`/overlay/game/<id>` +
//! `gamekit.js`): they subscribe to the `game` WS channel, receive
//! normalized `RawStreamEvent`s (sidecar already filters streak
//! intermediates) and apply the per-game rule table. This module owns
//! what must NOT live in a webview:
//!
//! - the game registry (id → title/desc/overlay path),
//! - the session state machine (idle → running ⇄ paused → stopped),
//! - per-game config in settings (`enabled`, `round_sec`, `rules`, …),
//! - plan gating (`Entitlements::interactive_games` allow-list),
//! - the results ledger (`game_results.json`, bounded append).
//!
//! Antiflood/dedupe run twice: the launcher-side mapper queue caps raw
//! flow, and each page applies `antiflood` per-rule cooldowns — cheap
//! protection that survives a WebView reload.

use std::path::{Path, PathBuf};
use std::sync::RwLock;

use serde::Serialize;
use serde_json::json;

use crate::settings::SettingsStore;
use crate::types::{now_ms, BuiltinGameCfg, Entitlements, GameSessionInfo};

/// Registry row for the Games page / allow-list checks.
pub struct GameMeta {
    pub id: &'static str,
    pub title: &'static str,
    pub desc: &'static str,
}

/// The MVP catalogue (§7–§9): tower duel, team war, survival.
pub const GAMES: &[GameMeta] = &[
    GameMeta {
        id: "gift_tower",
        title: "Gift Tower",
        desc: "Зрители строят башни из подарков: блоки по стоимости доната, случайные события, разрушения у соперника.",
    },
    GameMeta {
        id: "boy_vs_girl",
        title: "Boy vs Girl",
        desc: "Команды !boy и !girl тянут шкалу перевеса подарками, лайками и !attack.",
    },
    GameMeta {
        id: "survive_horde",
        title: "Survive the Horde",
        desc: "Стример выживает волнами (WASD), зрители спавнят врагов и эффекты подарками.",
    },
];

pub fn find(id: &str) -> Option<&'static GameMeta> {
    GAMES.iter().find(|g| g.id == id)
}

/// Game ids a plan may launch. `interactive_games = None` (offline cache
/// miss or plan without the key) means «all» — a network blip must not
/// degrade a paying streamer mid-broadcast.
pub fn allowed_games(ent: &Entitlements) -> Vec<&'static str> {
    match &ent.interactive_games {
        Some(list) => GAMES
            .iter()
            .filter(|g| list.iter().any(|x| x == g.id))
            .map(|g| g.id)
            .collect(),
        None => GAMES.iter().map(|g| g.id).collect(),
    }
}

/// Default per-game config — seeded into settings on first use.
/// `rules` matches the ТЗ default trigger tables; the page interprets:
/// `event` (gift/like/comment/follow/share/subscribe/join/timer),
/// `match.names` (case-insensitive gift-name or comment-command list),
/// `match.min_coins`, `action{type,...}`, `cooldownMs`, `perUserCdMs`,
/// `priority` (visual effects dropped first when the queue floods).
pub fn default_cfg(game_id: &str) -> BuiltinGameCfg {
    let rules = match game_id {
        "gift_tower" => json!([
            {"event":"gift","match":{"names":["Rose"]},"action":{"type":"add_block","value":1}},
            {"event":"gift","match":{"names":["Finger Heart"]},"action":{"type":"add_block","value":2}},
            {"event":"gift","match":{"names":["TikTok"]},"action":{"type":"add_block","value":5}},
            {"event":"gift","match":{"names":["Rosa"]},"action":{"type":"add_block","value":10}},
            {"event":"gift","match":{"names":["Galaxy"]},"action":{"type":"destroy","min":1,"max":3,"target":"enemy"},"cooldownMs":3000},
            {"event":"gift","match":{"names":["Lion"]},"action":{"type":"destroy","min":4,"max":8,"target":"enemy"},"cooldownMs":3000},
            {"event":"like","match":{},"action":{"type":"add_block","value":1,"per":100}},
            {"event":"comment","match":{"commands":["!red","!blue"]},"action":{"type":"join_team"}},
            {"event":"follow","match":{},"action":{"type":"add_block","value":1}},
            {"event":"share","match":{},"action":{"type":"add_block","value":3}}
        ]),
        "boy_vs_girl" => json!([
            {"event":"gift","match":{},"action":{"type":"add_score","per_coin":1}},
            {"event":"gift","match":{"names":["Rose"]},"action":{"type":"add_score","value":1}},
            {"event":"gift","match":{"names":["Galaxy"]},"action":{"type":"add_score","value":25,"fx":"hit"}},
            {"event":"gift","match":{"names":["Lion"]},"action":{"type":"add_score","value":100,"fx":"big"}},
            {"event":"like","match":{},"action":{"type":"add_score","per":10,"value":1}},
            {"event":"follow","match":{},"action":{"type":"add_score","value":2}},
            {"event":"share","match":{},"action":{"type":"add_score","value":5}},
            {"event":"comment","match":{"commands":["!boy","!girl"]},"action":{"type":"join_team"}},
            {"event":"comment","match":{"commands":["!attack"]},"action":{"type":"attack","value":5},"perUserCdMs":10000}
        ]),
        "survive_horde" => json!([
            {"event":"gift","match":{"names":["Rose"]},"action":{"type":"spawn_enemy","count":1,"tier":"weak"}},
            {"event":"gift","match":{"names":["Finger Heart"]},"action":{"type":"spawn_enemy","count":3,"tier":"weak"}},
            {"event":"gift","match":{"names":["TikTok"]},"action":{"type":"spawn_enemy","count":10,"tier":"weak"}},
            {"event":"gift","match":{"names":["Rosa"]},"action":{"type":"spawn_enemy","count":1,"tier":"miniboss"}},
            {"event":"gift","match":{"names":["Galaxy"]},"action":{"type":"meteor"},"cooldownMs":5000},
            {"event":"gift","match":{"names":["Lion"]},"action":{"type":"spawn_enemy","count":1,"tier":"boss"},"cooldownMs":10000},
            {"event":"like","match":{},"action":{"type":"random_buff","per":50}},
            {"event":"comment","match":{"commands":["!heal"]},"action":{"type":"heal","value":25},"perUserCdMs":60000},
            {"event":"comment","match":{"commands":["!weapon"]},"action":{"type":"weapon"},"perUserCdMs":30000},
            {"event":"follow","match":{},"action":{"type":"shield","sec":10}},
            {"event":"share","match":{},"action":{"type":"slow","sec":10}}
        ]),
        _ => json!([]),
    };
    BuiltinGameCfg {
        enabled: true,
        round_sec: match game_id {
            "survive_horde" => 300,
            _ => 300,
        },
        volume: 0.7,
        antiflood: Default::default(),
        rules,
    }
}

/// Live session + result ledger. Sessions are single-instance: starting
/// a second game stops the first (one capture window per stream).
pub struct BuiltinGames {
    session: RwLock<Option<GameSessionInfo>>,
    results_path: PathBuf,
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionView {
    pub active: Option<GameSessionInfo>,
}

impl BuiltinGames {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            session: RwLock::new(None),
            results_path: data_dir.join("game_results.json"),
        }
    }

    pub fn status(&self) -> SessionView {
        SessionView {
            active: self
                .session
                .read()
                .unwrap_or_else(|p| p.into_inner())
                .clone(),
        }
    }

    /// Starts (or restarts) a session for `game_id`. Callers validate the
    /// plan allow-list BEFORE calling this.
    pub fn start(&self, game_id: &str) -> GameSessionInfo {
        let s = GameSessionInfo {
            game_id: game_id.to_string(),
            status: "running".into(),
            started_at_ms: now_ms(),
            paused_total_ms: 0,
            pause_began_ms: 0,
        };
        *self.session.write().unwrap_or_else(|p| p.into_inner()) = Some(s.clone());
        s
    }

    pub fn pause(&self) -> Option<GameSessionInfo> {
        let mut g = self.session.write().unwrap_or_else(|p| p.into_inner());
        let s = g.as_mut()?;
        if s.status == "running" {
            s.status = "paused".into();
            s.pause_began_ms = now_ms();
        }
        Some(s.clone())
    }

    pub fn resume(&self) -> Option<GameSessionInfo> {
        let mut g = self.session.write().unwrap_or_else(|p| p.into_inner());
        let s = g.as_mut()?;
        if s.status == "paused" {
            s.status = "running".into();
            s.paused_total_ms += now_ms().saturating_sub(s.pause_began_ms);
            s.pause_began_ms = 0;
        }
        Some(s.clone())
    }

    /// Stops the session; returns it so callers can prompt a result POST.
    pub fn stop(&self) -> Option<GameSessionInfo> {
        self.session
            .write()
            .unwrap_or_else(|p| p.into_inner())
            .take()
    }

    /// Appends a finished-session summary to the bounded results ledger.
    /// The overlay page POSTs here on round end — the file is append-only
    /// JSON lines… actually a bounded JSON array (≤200) rewritten
    /// atomically via a .tmp swap.
    pub fn record_result(&self, entry: serde_json::Value) -> std::io::Result<()> {
        let mut rows: Vec<serde_json::Value> = self.results();
        rows.push(entry);
        if rows.len() > 200 {
            rows.drain(..rows.len() - 200);
        }
        let tmp = self.results_path.with_extension("tmp");
        std::fs::write(&tmp, serde_json::to_string_pretty(&rows)?)?;
        std::fs::rename(&tmp, &self.results_path)?;
        Ok(())
    }

    /// Result history, newest-last (the UI reverses for display).
    pub fn results(&self) -> Vec<serde_json::Value> {
        std::fs::read_to_string(&self.results_path)
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default()
    }
}

/// Reads (and seeds on first use) the config for `game_id`.
pub fn cfg_for(settings: &mut SettingsStore, game_id: &str) -> BuiltinGameCfg {
    if let Some(c) = settings.data.builtin_games.get(game_id) {
        return c.clone();
    }
    let c = default_cfg(game_id);
    settings
        .data
        .builtin_games
        .insert(game_id.to_string(), c.clone());
    c
}

/// Validates a user-supplied cfg blob before persisting. Loose on
/// purpose: unknown keys pass through (pages may add fields), but the
/// safety-critical knobs are type-checked.
pub fn validate_cfg(v: &serde_json::Value) -> Result<(), String> {
    let obj = v.as_object().ok_or("cfg must be a JSON object")?;
    if let Some(r) = obj.get("round_sec") {
        if !r.is_u64() {
            return Err("round_sec must be a number".into());
        }
    }
    if let Some(rules) = obj.get("rules") {
        let arr = rules.as_array().ok_or("rules must be an array")?;
        if arr.len() > 64 {
            return Err("rules: max 64 entries".into());
        }
        for (i, r) in arr.iter().enumerate() {
            if r.get("event").and_then(|e| e.as_str()).is_none()
                || r.get("action")
                    .and_then(|a| a.get("type"))
                    .and_then(|t| t.as_str())
                    .is_none()
            {
                return Err(format!("rules[{i}]: needs event + action.type"));
            }
        }
    }
    Ok(())
}

/// UI shape for the Games page: registry + session + per-game cfg.
pub fn catalog_view(
    settings: &mut SettingsStore,
    ent: &Entitlements,
    session: &BuiltinGames,
) -> serde_json::Value {
    let allowed = allowed_games(ent);
    let games: Vec<_> = GAMES
        .iter()
        .map(|g| {
            json!({
                "id": g.id,
                "title": g.title,
                "desc": g.desc,
                "allowed": allowed.contains(&g.id),
                "cfg": cfg_for(settings, g.id),
                "overlay_path": format!("/overlay/game/{}", g.id),
            })
        })
        .collect();
    json!({ "games": games, "session": session.status() })
}

/// Result-history view (newest first for the UI).
pub fn results_view(games: &BuiltinGames) -> serde_json::Value {
    let mut rows = games.results();
    rows.reverse();
    json!({ "results": rows })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_transitions() {
        let g = BuiltinGames::new(std::path::Path::new("."));
        assert!(g.status().active.is_none());
        let s = g.start("gift_tower");
        assert_eq!(s.status, "running");
        assert_eq!(g.pause().unwrap().status, "paused");
        assert_eq!(g.resume().unwrap().status, "running");
        assert!(g.stop().is_some());
        assert!(g.status().active.is_none());
        // Second stop is a no-op.
        assert!(g.stop().is_none());
    }

    #[test]
    fn entitlement_allow_list() {
        let mut ent = Entitlements::default();
        ent.interactive_games = Some(vec!["gift_tower".into()]);
        assert_eq!(allowed_games(&ent), vec!["gift_tower"]);
        ent.interactive_games = None;
        assert_eq!(allowed_games(&ent).len(), 3);
        ent.interactive_games = Some(vec![]);
        assert!(allowed_games(&ent).is_empty());
    }

    #[test]
    fn cfg_validation() {
        assert!(validate_cfg(&json!({"round_sec": 300, "rules": [
            {"event":"gift","action":{"type":"add_block"}}
        ]}))
        .is_ok());
        assert!(validate_cfg(&json!({"rules": "nope"})).is_err());
        assert!(validate_cfg(&json!({"rules": [{"event":"gift"}]})).is_err());
        assert!(validate_cfg(&json!(42)).is_err());
    }

    #[test]
    fn default_rules_cover_spec_tables() {
        for id in ["gift_tower", "boy_vs_girl", "survive_horde"] {
            let c = default_cfg(id);
            let rules = c.rules.as_array().unwrap();
            assert!(!rules.is_empty(), "{id} needs default rules");
            for r in rules {
                assert!(r["event"].is_string() && r["action"]["type"].is_string());
            }
        }
    }

    #[test]
    fn results_are_bounded() {
        let dir = std::env::temp_dir().join(format!("chlg-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let g = BuiltinGames::new(&dir);
        for i in 0..210 {
            g.record_result(json!({"game_id":"gift_tower","n":i}))
                .unwrap();
        }
        let rows = g.results();
        assert_eq!(rows.len(), 200);
        assert_eq!(rows.last().unwrap()["n"], 209);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
