//! Persistent launcher settings — a single JSON document in the app-data
//! directory (`%APPDATA%/com.chlauncher.app/settings.json`).
//!
//! Stores the auth session token, TikTok username, DonationAlerts token,
//! window options, streamer-mode flag and per-game trigger profiles.
//! Writes are atomic (tmp file + rename) so a crash can't corrupt state.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use crate::types::{MediaItem, SpinnerPool, TriggerPreset, TriggerProfile, WindowOptions};

/// Everything the launcher persists between restarts.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Settings {
    /// Backend base URL set from the auth screen (empty → env/default).
    pub server_url: Option<String>,
    /// JWT from the licensing server.
    pub auth_token: Option<String>,
    /// Account email (for the dashboard; masked in streamer mode).
    pub email: Option<String>,
    /// 'user' | 'admin' — drives the admin tab; the server never trusts it.
    #[serde(default)]
    pub role: Option<String>,
    /// TikTok username the streamer connects to.
    pub tiktok_username: Option<String>,
    /// DonationAlerts access token pasted by the streamer.
    pub donationalerts_token: Option<String>,
    /// Hide personal data on screen (for streamers on one monitor).
    pub streamer_mode: bool,
    /// Default window options for game launches.
    pub window_options: WindowOptions,
    /// Trigger profiles keyed by game slug.
    pub trigger_profiles: HashMap<String, TriggerProfile>,
    /// Streamer-defined trigger presets keyed by name — reusable rule sets
    /// applied onto any game's profile in one click.
    #[serde(default)]
    pub trigger_presets: HashMap<String, TriggerPreset>,
    /// Roblox/cloud relay: forward mapped StreamEvents over HTTP.
    #[serde(default)]
    pub forward: ForwardSettings,
    /// Alert queue + master switches (parity spec §3/§4).
    #[serde(default)]
    pub alerts: AlertSettings,
    /// Chat-to-speech configuration (§6.2).
    #[serde(default)]
    pub tts: TtsSettings,
    /// Named spinner pools for the gift wheel (§7).
    #[serde(default)]
    pub spinners: HashMap<String, SpinnerPool>,
    /// Media-library index; files live in `<app-data>/media/` (§4.1).
    #[serde(default)]
    pub media: Vec<MediaItem>,
    /// Token guarding overlay pages (`?t=…`) — generated on first launch.
    #[serde(default)]
    pub overlay_token: String,
    /// DA→coin exchange rate: coins credited per 1 RUB of donation.
    /// 0 (default) = donations don't count toward the earn limit (§8.4).
    #[serde(default)]
    pub da_coins_per_rub: f32,
    /// Fixed overlay port — 0 lets the OS pick a fresh one per launch.
    #[serde(default)]
    pub overlay_port: u16,
    /// Managed Minecraft server (§9): EULA, RAM, RCON credentials.
    #[serde(default)]
    pub mc: McSettings,
    /// Shared secret external game adapters (mods) use in their
    /// `hello_adapter` handshake (§10.1) — generated on demand,
    /// revocable via regeneration. Never logged.
    #[serde(default)]
    pub adapter_key: String,
    /// Stream-level goals ("300 роз → босс") — counters are in-memory,
    /// see `goals.rs`.
    #[serde(default)]
    pub goals: Vec<crate::types::StreamGoal>,
    /// Subathon countdown config — see `subathon.rs`.
    #[serde(default)]
    pub subathon: crate::types::SubathonCfg,
    /// Hype-meter knobs (window + 100% target) — see `hype.rs`.
    #[serde(default)]
    pub hype: crate::types::HypeCfg,
    /// Timed auto-events («каждые N минут») — see `timed.rs`.
    #[serde(default)]
    pub timed_events: Vec<crate::types::TimedEvent>,
    /// Viewer-points economy — see `points.rs`.
    #[serde(default)]
    pub points: crate::types::PointsCfg,
    /// `!buy` shop items — see `points.rs`.
    #[serde(default)]
    pub shop_items: Vec<crate::types::ShopItem>,
}

/// Managed Minecraft server configuration (parity spec §9.2–§9.3).
/// `rcon_password` is generated on install — stored here, never logged.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McSettings {
    /// Streamer explicitly accepted the Minecraft EULA (checkbox in the UI).
    #[serde(default)]
    pub eula_accepted: bool,
    /// `-Xmx`/`-Xms` in MB.
    #[serde(default = "default_mc_ram")]
    pub ram_mb: u32,
    /// Requested MC version ("" = latest stable from the Fill API).
    #[serde(default)]
    pub mc_version: String,
    /// `online-mode` in server.properties — Mojang auth for player names.
    #[serde(default = "default_true")]
    pub online_mode: bool,
    /// Default `{player}` target for command templates (`@a` when empty).
    #[serde(default)]
    pub player: String,
    /// RCON port chosen at install (0 = not yet assigned).
    #[serde(default)]
    pub rcon_port: u16,
    /// Generated 48-hex password (24 random bytes) — written to
    /// server.properties on install; never sent to the renderer.
    #[serde(default)]
    pub rcon_password: String,
    /// Installed Paper version ("" = not installed).
    #[serde(default)]
    pub paper_version: String,
}

fn default_mc_ram() -> u32 {
    4096
}

fn default_true() -> bool {
    true
}

impl Default for McSettings {
    fn default() -> Self {
        Self {
            eula_accepted: false,
            ram_mb: default_mc_ram(),
            mc_version: String::new(),
            online_mode: true,
            player: String::new(),
            rcon_port: 0,
            rcon_password: String::new(),
            paper_version: String::new(),
        }
    }
}

/// Alert queue + playback settings (parity spec §3.1–§3.2, §4.3).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AlertSettings {
    /// Master switch — off = rules fire actions but show no overlay alerts.
    pub enabled: bool,
    /// Max queued alert jobs before the lowest-priority one drops (§2.4).
    pub queue_max: u32,
    /// Default on-screen time when a rule's `AlertSpec` doesn't say.
    pub default_duration_ms: u64,
    /// Master volume multiplied into every sound/media play.
    pub volume: f32,
    /// Gifts worth ≥ N coins get a default alert even without a rule
    /// `AlertSpec` (0 = off).
    pub default_for_gifts_from_coins: i64,
    /// `"overlay"` — sound captured by the Browser Source (default);
    /// `"device"` — played by the launcher on the output device.
    pub audio_output: String,
}

impl Default for AlertSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            queue_max: 200,
            default_duration_ms: 4_000,
            volume: 1.0,
            default_for_gifts_from_coins: 0,
            audio_output: "overlay".into(),
        }
    }
}

/// Chat-to-speech settings (parity spec §6.2). `read_comments` selects the
/// comment-reading mode: `"off"` | `"all"` | `"prefix"` | `"gifters"`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TtsSettings {
    /// Master switch.
    pub enabled: bool,
    /// System voice id (empty = OS default voice).
    pub voice: String,
    pub rate: f32,
    pub volume: f32,
    /// `"off"` | `"all"` | `"prefix"` | `"gifters"`.
    pub read_comments: String,
    /// Prefix that marks a comment for reading in `"prefix"` mode.
    pub comment_prefix: String,
    /// In `"gifters"` mode, read comments only from viewers who donated
    /// ≥ this many coins this session.
    pub gifters_min_coins: i64,
    /// Speak "{user} подарил {gift} ×{count}" for gift events.
    pub read_gifts: bool,
    pub gift_template: String,
    /// Prefix comments with "{user} пишет: ".
    pub read_nickname: bool,
    /// Max characters spoken per phrase (rest is cut).
    pub max_chars: u32,
    pub cooldown_ms: u64,
    pub user_cooldown_ms: u64,
    /// Phrases queued before the oldest drop.
    pub queue_max: u32,
    /// Words/regexes that mute a phrase entirely.
    pub blocklist: Vec<String>,
    pub strip_links: bool,
    pub strip_emoji: bool,
    /// Global mute hotkey — also flushes the speech queue (§6.3).
    pub mute_hotkey: String,
    /// Where synthesized audio goes: `"device"` (default) or `"overlay"`.
    pub output: String,
}

impl Default for TtsSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            voice: String::new(),
            rate: 1.0,
            volume: 0.9,
            read_comments: "off".into(),
            comment_prefix: "!say ".into(),
            gifters_min_coins: 1,
            read_gifts: false,
            gift_template: "{user} подарил {gift}".into(),
            read_nickname: true,
            max_chars: 200,
            cooldown_ms: 3_000,
            user_cooldown_ms: 15_000,
            queue_max: 20,
            blocklist: Vec::new(),
            strip_links: true,
            strip_emoji: true,
            mute_hotkey: "Ctrl+Shift+M".into(),
            output: "device".into(),
        }
    }
}

/// HTTP-forward configuration for cloud games (Roblox relay).
/// The relay is a standalone service (see `docs/roblox-integration.md`);
/// the launcher only POSTs to it.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ForwardSettings {
    /// Master switch for `POST {forward_url}/api/stream/ingest`.
    pub enabled: bool,
    /// Relay base URL, e.g. `https://relay.example.com`.
    pub forward_url: Option<String>,
    /// Streamer key — ingest auth + Roblox room pass (generated in the UI).
    pub stream_key: Option<String>,
    /// Admin secret for `POST /api/admin/register` key renewals.
    pub relay_admin_secret: Option<String>,
    /// Roblox place ID for the "Запустить игру" deep link.
    pub roblox_place_id: Option<String>,
}

/// File-backed settings store.
pub struct SettingsStore {
    path: PathBuf,
    pub data: Settings,
    /// Mutation counter — bumped by `save()`. Hot readers (the event
    /// mapper) cache cloned sections and rebuild only when this changes.
    /// NOT serialized: in-memory only.
    rev: std::sync::atomic::AtomicU64,
}

impl SettingsStore {
    /// Loads settings from `dir/settings.json`; missing/corrupt files fall
    /// back to defaults. Generates `overlay_token` on first launch.
    pub fn load(dir: &std::path::Path) -> Self {
        let path = dir.join("settings.json");
        let mut data: Settings = fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        if data.overlay_token.is_empty() {
            // 64 hex chars = 32 random bytes — used as the `?t=` overlay key.
            data.overlay_token = format!(
                "{}{}",
                uuid::Uuid::new_v4().simple(),
                uuid::Uuid::new_v4().simple()
            );
            let store = Self::new(path, data);
            let _ = store.save();
            return store;
        }
        Self::new(path, data)
    }

    fn new(path: PathBuf, data: Settings) -> Self {
        Self {
            path,
            data,
            rev: std::sync::atomic::AtomicU64::new(0),
        }
    }

    /// Current mutation counter (see `rev`).
    pub fn revision(&self) -> u64 {
        self.rev.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// Atomically persists the current settings to disk.
    pub fn save(&self) -> std::io::Result<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let tmp = self.path.with_extension("json.tmp");
        fs::write(&tmp, serde_json::to_string_pretty(&self.data)?)?;
        fs::rename(&tmp, &self.path)?;
        self.rev.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `settings.json` as written before the StreamToEarn-parity data model
    /// — must deserialize with all new sections defaulted, not fail.
    const OLD_SETTINGS_JSON: &str = r#"{
        "server_url": "http://localhost:8787",
        "auth_token": "jwt-token",
        "email": "streamer@example.com",
        "role": "user",
        "tiktok_username": "my_stream",
        "donationalerts_token": "da-token",
        "streamer_mode": false,
        "window_options": {
            "width": 540, "height": 960, "borderless": true,
            "always_on_top": true, "chroma_key": false
        },
        "trigger_profiles": {
            "mock-game": {
                "game_slug": "mock-game",
                "preset": "steal-the-stream",
                "rules": [
                    {
                        "id": "r1", "source": "tiktok", "event_kind": "gift",
                        "match_value": "Rose", "min_amount": 0,
                        "action": "spawn_enemy", "multiplier": 1.0
                    }
                ]
            }
        },
        "trigger_presets": {},
        "forward": {
            "enabled": false, "forward_url": null,
            "stream_key": null, "relay_admin_secret": null
        }
    }"#;

    #[test]
    fn old_settings_deserialize() {
        let s: Settings = serde_json::from_str(OLD_SETTINGS_JSON).unwrap();
        assert_eq!(s.tiktok_username.as_deref(), Some("my_stream"));
        // New sections get spec defaults.
        assert!(s.alerts.enabled);
        assert_eq!(s.alerts.queue_max, 200);
        assert!(!s.tts.enabled);
        assert_eq!(s.tts.comment_prefix, "!say ");
        assert!(s.spinners.is_empty());
        assert!(s.media.is_empty());
        assert!(s.overlay_token.is_empty()); // filled by SettingsStore::load
        assert_eq!(s.da_coins_per_rub, 0.0);
        // Old rule deserializes with the new defaults applied.
        let rule = &s.trigger_profiles["mock-game"].rules[0];
        assert!(rule.enabled);
        assert_eq!(rule.match_mode, "contains");
        assert_eq!(rule.repeat, "once");
        assert_eq!(rule.max_repeat, 20);
        assert!(!rule.interrupt);
        assert!(!rule.continue_matching);
        let profile = &s.trigger_profiles["mock-game"];
        assert_eq!(profile.overlay.template, "cards");
        assert_eq!(profile.global_cooldown_ms, 0);
    }
}
