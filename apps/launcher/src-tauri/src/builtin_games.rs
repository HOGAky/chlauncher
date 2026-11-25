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

/// Registry row for the merged catalogue — every entry is a folder
/// package from `game_packs::scan` (`public/games` bundled +
/// `<app-data>/games` user drop-in). `"type": "remote"` link-packs point
/// at a published server instead of shipping a page.
#[derive(Debug, Clone)]
pub struct GameEntry {
    pub id: String,
    pub title: String,
    pub desc: String,
    /// `true` for `"type": "remote"` link-packs — no overlay page, the
    /// `launch` spec drives the start flow (e.g. kind `"roblox"`).
    pub remote: bool,
    /// `launch` object from the manifest (remote entries only).
    pub launch: Option<serde_json::Value>,
    /// `true` when the pack lives in `<app-data>/games` (user drop-in).
    pub user: bool,
    /// `/games-assets/<dir>` base for pack-provided games.
    pub assets_base: Option<String>,
    /// Manifest icon path relative to `assets_base`.
    pub icon: Option<String>,
    /// `afk: true` in the manifest — idle/viewer-driven («АФК-стримы»).
    pub afk: bool,
    /// Effective `free` flag for UI tabs («Бесплатные» vs «По тарифу»).
    pub free: bool,
    /// Raw manifest `free` (`Some(true)` = exempt from plan gate,
    /// `Some(false)` = requires paid plan, `None` = defer to plan list).
    pub free_explicit: Option<bool>,
    /// `section` in the manifest — custom library tab name.
    pub section: Option<String>,
    /// `true` — user `game.json` patches a bundled pack (editable entry).
    pub overridden: bool,
    /// `hidden: true` in the manifest — populated only by `registry_all`
    /// (the admin section panel); the public catalogue never sees these.
    pub hidden: bool,
}

/// Full game catalogue — folder packs only, sorted by title for a
/// stable Games-page order.
pub fn registry(data_dir: &Path) -> Vec<GameEntry> {
    registry_from(crate::game_packs::scan(data_dir))
}

/// Catalogue including `hidden` packs — admin panel only.
pub fn registry_all(data_dir: &Path) -> Vec<GameEntry> {
    registry_from(crate::game_packs::scan_all(data_dir))
}

fn registry_from(packs: Vec<crate::game_packs::GamePack>) -> Vec<GameEntry> {
    let mut out: Vec<GameEntry> = packs
        .into_iter()
        .map(|p| {
            let assets_base = p.assets_base();
            GameEntry {
                section: p.manifest.section.clone(),
                overridden: p.overridden,
                hidden: p.is_hidden(),
                title: p
                    .manifest
                    .title
                    .clone()
                    .unwrap_or_else(|| p.dir_name.clone()),
                desc: p.manifest.desc.clone().unwrap_or_default(),
                remote: p.is_remote(),
                launch: p.manifest.launch.clone(),
                user: p.user,
                assets_base: Some(assets_base),
                icon: p.manifest.icon.clone(),
                afk: p.is_afk(),
                free: p.is_free(),
                free_explicit: p.manifest.free,
                id: p.id,
            }
        })
        .collect();
    out.sort_by_key(|g| g.title.to_lowercase());
    out
}

/// Does the id name a registered game pack (local or remote)?
pub fn exists(id: &str, data_dir: &Path) -> bool {
    crate::game_packs::find(id, data_dir).is_some()
}

/// Game ids a plan may launch. `interactive_games = None` (offline cache
/// miss or plan without the key) means «all» — a network blip must not
/// degrade a paying streamer mid-broadcast. USER packs (`<data>/games`)
/// are local additions, not server-published catalogue items — they
/// bypass the plan allow-list by design; bundled packs stay gated.
/// Remote link-packs are exempt too — their real gate is the launch
/// command's server check (ticket/plan), not `interactive_games`.
pub fn allowed_games(ent: &Entitlements, data_dir: &Path) -> Vec<String> {
    registry(data_dir)
        .into_iter()
        .filter(|e| {
            if e.user {
                return true;
            }
            match e.free_explicit {
                Some(true) => true,
                Some(false) => ent.paid_games,
                None => {
                    if e.remote {
                        ent.paid_games
                    } else {
                        match &ent.interactive_games {
                            Some(list) => list.iter().any(|x| x == &e.id),
                            None => true,
                        }
                    }
                }
            }
        })
        .map(|e| e.id)
        .collect()
}

/// Default per-game config — seeded into settings on first use.
/// `rules` matches the ТЗ default trigger tables; the page interprets:
/// `event` (gift/like/comment/follow/share/subscribe/join/timer),
/// `match.names` (case-insensitive gift-name or comment-command list),
/// `match.min_coins`, `action{type,...}`, `cooldownMs`, `perUserCdMs`,
/// `priority` (visual effects dropped first when the queue floods).
/// The rule table, `round_sec` and `volume` come from the pack's
/// `game.json`; an unknown id gets an empty table.
pub fn default_cfg(game_id: &str, data_dir: &Path) -> BuiltinGameCfg {
    if let Some(pack) = crate::game_packs::find(game_id, data_dir) {
        let m = &pack.manifest;
        return BuiltinGameCfg {
            enabled: true,
            round_sec: m.round_sec.unwrap_or(300),
            volume: m.volume.unwrap_or(0.7),
            antiflood: Default::default(),
            rules: m.rules.clone().unwrap_or_else(|| json!([])),
        };
    }
    BuiltinGameCfg {
        enabled: true,
        round_sec: 300,
        volume: 0.7,
        antiflood: Default::default(),
        rules: json!([]),
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
pub fn cfg_for(settings: &mut SettingsStore, game_id: &str, data_dir: &Path) -> BuiltinGameCfg {
    if let Some(c) = settings.data.builtin_games.get(game_id) {
        return c.clone();
    }
    let c = default_cfg(game_id, data_dir);
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
        if arr.len() > 128 {
            return Err("rules: max 128 entries".into());
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

/// UI shape for the Games page + Library: merged registry of folder
/// packs (local pages + remote links) + session + per-game cfg.
pub fn catalog_view(
    settings: &mut SettingsStore,
    ent: &Entitlements,
    session: &BuiltinGames,
    data_dir: &Path,
) -> serde_json::Value {
    let allowed = allowed_games(ent, data_dir);
    let games: Vec<_> = registry(data_dir)
        .iter()
        .map(|g| {
            json!({
                "id": g.id,
                "title": g.title,
                "desc": g.desc,
                "allowed": allowed.iter().any(|a| a == &g.id),
                "pack": !g.remote,
                "remote": g.remote,
                "user_pack": g.user,
                "launch": g.launch,
                "assets_base": g.assets_base,
                "icon": g.icon.as_ref().map(|i| format!("{}/{}", g.assets_base.as_deref().unwrap_or(""), i)),
                "afk": g.afk,
                "free": g.free,
                "section": g.section,
                "overridden": g.overridden,
                "cfg": cfg_for(settings, &g.id, data_dir),
                "overlay_path": (!g.remote).then(|| format!("/overlay/game/{}", g.id)),
            })
        })
        .collect();
    json!({ "games": games, "session": session.status() })
}

/// Admin catalogue — EVERY pack on disk including `hidden` ones, so the
/// section-distribution panel can re-show hidden games too. Local data
/// only; the UI gates the panel by role.
pub fn admin_catalog(data_dir: &Path) -> serde_json::Value {
    let games: Vec<_> = registry_all(data_dir)
        .iter()
        .map(|g| {
            json!({
                "id": g.id,
                "title": g.title,
                "desc": g.desc,
                "pack": !g.remote,
                "remote": g.remote,
                "user_pack": g.user,
                "launch": g.launch,
                "assets_base": g.assets_base,
                "icon": g.icon.as_ref().map(|i| format!("{}/{}", g.assets_base.as_deref().unwrap_or(""), i)),
                "afk": g.afk,
                "free": g.free,
                "hidden": g.hidden,
                "section": g.section,
                "overridden": g.overridden,
            })
        })
        .collect();
    json!({ "games": games })
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
        // An empty data dir means "no user packs" — bundled packs still
        // appear, so assertions only cover the static allow-list logic.
        let empty = std::env::temp_dir().join(format!("chlg-ent-{}", std::process::id()));
        std::fs::create_dir_all(&empty).unwrap();
        let bundled: Vec<String> = registry(&empty)
            .into_iter()
            .filter(|e| !e.user && !e.remote)
            .map(|e| e.id)
            .collect();
        assert!(bundled.contains(&"patrick_cabbage".to_string()));
        assert!(bundled.contains(&"aquarium".to_string()));
        let mut ent = Entitlements {
            paid_games: false,
            interactive_games: Some(vec!["patrick_cabbage".into()]),
            ..Default::default()
        };
        let allowed = allowed_games(&ent, &empty);
        assert!(allowed.contains(&"patrick_cabbage".to_string()));
        // aquarium ships with `free: true` → allowed even when omitted from list.
        assert!(allowed.contains(&"aquarium".to_string()));
        // roblox_sts is remote without `free: true` → gated by `paid_games`.
        assert!(!allowed.contains(&"roblox_sts".to_string()));
        ent.paid_games = true;
        ent.interactive_games = None;
        // None + paid_games = «all bundled + remote».
        assert!(bundled
            .iter()
            .all(|id| allowed_games(&ent, &empty).contains(id)));
        assert!(allowed_games(&ent, &empty).contains(&"roblox_sts".to_string()));
        ent.paid_games = false;
        ent.interactive_games = Some(vec![]);
        // Empty list on free plan: `free:true` (aquarium) stays, plan-gated
        // bundled (patrick_cabbage) and paid remote (roblox_sts) vanish.
        let allowed = allowed_games(&ent, &empty);
        assert!(allowed.contains(&"aquarium".to_string()));
        assert!(!allowed.contains(&"patrick_cabbage".to_string()));
        assert!(!allowed.contains(&"roblox_sts".to_string()));
        let _ = std::fs::remove_dir_all(&empty);
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
        let empty = std::env::temp_dir().join(format!("chlg-rules-{}", std::process::id()));
        std::fs::create_dir_all(&empty).unwrap();
        // Only live (non-hidden) bundled packs — hidden prototypes are
        // out of the catalogue by design, `find` never reaches them.
        for id in ["patrick_cabbage"] {
            let c = default_cfg(id, &empty);
            let rules = c.rules.as_array().unwrap();
            assert!(!rules.is_empty(), "{id} needs default rules");
            for r in rules {
                assert!(r["event"].is_string() && r["action"]["type"].is_string());
            }
        }
        let _ = std::fs::remove_dir_all(&empty);
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
