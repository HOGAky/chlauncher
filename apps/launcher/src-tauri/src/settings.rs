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
    /// Optional `sessionid` cookie — when set, the sidecar opens an
    /// authenticated WebSocket (TikFinity-style) which bypasses the
    /// anonymous-device DEVICE_BLOCKED waves on the free sign tier.
    #[serde(default)]
    pub tiktok_session: Option<String>,
    /// Restore the saved TikTok room connection on launcher start.
    /// `None`/missing = on (automation default), `Some(false)` = manual.
    #[serde(default)]
    pub tiktok_autoconnect: Option<bool>,
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
    /// Правила «подарок → анимация» для виджета `animbox.html` —
    /// отдаются виджету через `/anim/cfg`.
    #[serde(default)]
    pub anims: Vec<crate::types::AnimRule>,
    /// Subathon countdown config — see `subathon.rs`.
    #[serde(default)]
    pub subathon: crate::types::SubathonCfg,
    /// EFIR-style timer — trigger/effect engine, roulettes, styles.
    /// See `efirtimer.rs`.
    #[serde(default)]
    pub efirtimer: crate::types::EfirTimerCfg,
    /// Балансы кошельков зрителей (username → монеты) для режима
    /// `donationMode="balance"` — лежат отдельно от `efirtimer`, чтобы
    /// сохранение конфига из UI не затирало балансы.
    #[serde(default)]
    pub efir_wallets: std::collections::HashMap<String, i64>,
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
    /// Built-in interactive games keyed by id (`gift_tower`,
    /// `boy_vs_girl`, `survive_horde`) — per-game rules/round/antiflood
    /// config, applied by the overlay game pages via gamekit.js.
    #[serde(default)]
    pub builtin_games: HashMap<String, crate::types::BuiltinGameCfg>,
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
    /// Speech engine: `"edge"` (neural cloud voices, needs internet) or
    /// `"sapi"` (system Windows voices, works offline).
    #[serde(default = "default_tts_engine")]
    pub engine: String,
    /// Voice id — Edge ShortName (`ru-RU-SvetlanaNeural`) or a SAPI
    /// display name (empty = default voice of the engine).
    pub voice: String,
    pub rate: f32,
    pub volume: f32,
    /// Pitch multiplier around 1.0 (Edge `pitch` prosody, SAPI ignores).
    #[serde(default = "default_tts_pitch")]
    pub pitch: f32,
    /// Delivery style: `"normal"` | `"whisper"` | `"loud"` | `"cheerful"`.
    /// Edge tries `mstts:express-as` first and falls back to prosody;
    /// SAPI approximates via rate/volume.
    #[serde(default = "default_tts_style")]
    pub style: String,
    /// Emotional reading: laughing emoji/«ахах»/«лол» → cheerful tone +
    /// spoken laughter where the emoji were; ALL CAPS → loud (§6.4).
    #[serde(default = "default_true")]
    pub emotions: bool,
    /// TikTok usernames (без @) whose comments are ALWAYS read —
    /// regardless of `read_comments` mode. У каждого может быть свой
    /// персональный голос (`voice`), иначе общий выбор.
    #[serde(default, deserialize_with = "de_whitelist_users")]
    pub whitelist: Vec<WhitelistUser>,
    /// TikTok usernames (без @) whose comments are NEVER read.
    #[serde(default)]
    pub blacklist: Vec<String>,
    /// When true, comments are read only for `whitelist` users.
    #[serde(default)]
    pub only_whitelist: bool,
    /// Whitelisted users skip the global/per-user cooldown and jump to
    /// the front of the speech queue.
    #[serde(default = "default_true")]
    pub whitelist_priority: bool,
    /// Give every viewer a fixed random neural voice (crowd effect) —
    /// only when `engine = "edge"` and the job has no voice override.
    #[serde(default)]
    pub voice_per_user: bool,
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
    /// Голосовые правила по уровню команды (фан-клуба) — экран
    /// «Правила озвучки». Первое подошедшее правило выбирает голос(а);
    /// пустой список = читать всем выбранным голосом без гейта уровня.
    #[serde(default)]
    pub rules: Vec<TtsVoiceRule>,
    /// Звуки/фразы, привязанные к конкретным подаркам (карточка
    /// «Rose» со скриншота — громкость, «каждый подарок/после серии»).
    #[serde(default)]
    pub gift_sounds: Vec<GiftSoundRule>,
    /// API-ключ Google AI Studio для движка `"gemini"` — 30 облачных
    /// нейроголосов (Puck, Charon, Kore...). API геоблокирован в ряде
    /// регионов — работает через VPN.
    #[serde(default)]
    pub gemini_key: String,
}

/// Зритель из белого списка: `username` (без @) озвучивается всегда;
/// `voice` — персональный голос (Edge id / SAPI name / `custom:*`),
/// None или пустая строка = голос как у всех остальных.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WhitelistUser {
    pub username: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub voice: Option<String>,
}

/// Обратная совместимость: раньше `whitelist` был `Vec<String>` —
/// принимаем и строки `"name"`, и объекты `{username, voice}`.
pub(crate) fn de_whitelist_users<'de, D>(d: D) -> Result<Vec<WhitelistUser>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum One {
        Name(String),
        Full(WhitelistUser),
    }
    Ok(Vec::<One>::deserialize(d)?
        .into_iter()
        .map(|o| match o {
            One::Name(username) => WhitelistUser {
                username,
                voice: None,
            },
            One::Full(u) => u,
        })
        .collect())
}

/// Одно правило озвучки по уровню команды: зритель проходит, если его
/// уровень фан-клуба ≥ `min_level`, либо по bypass-флагу (модератор /
/// суперфан). Правила проверяются сверху вниз — первое подошедшее
/// определяет голос(а).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TtsVoiceRule {
    pub id: String,
    /// «Обычная озвучка», «VIP-озвучка»…
    pub name: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Минимальный уровень команды (fan-club level; 0 = без порога).
    #[serde(default)]
    pub min_level: i64,
    /// Пул голосов — один = «Обычный голос», несколько = стабильный
    /// выбор по зрителю («5 голосов»). Пусто = голос из настроек.
    #[serde(default)]
    pub voices: Vec<String>,
    /// Модераторов озвучивать без минимального уровня.
    #[serde(default = "default_true")]
    pub read_mods: bool,
    /// Суперфанатов озвучивать без минимального уровня.
    #[serde(default = "default_true")]
    pub read_superfans: bool,
}

/// Звук или фраза, привязанная к подарку: `kind = "sound"` играет файл
/// из медиатеки (`media_id`), `kind = "tts"` проговаривает шаблон
/// `text` ({user} {gift} {count} {coins}).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GiftSoundRule {
    pub id: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Точный TikTok gift id (устойчив к локализации имени) — optional.
    #[serde(default)]
    pub gift_id: Option<i64>,
    /// Имя подарка для матча ("Rose") — contains, регистронезависимо.
    pub gift_name: String,
    /// `"sound"` (файл медиатеки) | `"tts"` (проговорить шаблон).
    #[serde(default = "default_gift_sound_kind")]
    pub kind: String,
    /// MediaItem.id для kind="sound".
    #[serde(default)]
    pub media_id: Option<String>,
    /// Шаблон для kind="tts" и подпись правила.
    #[serde(default = "default_gift_sound_text")]
    pub text: String,
    /// Голос для kind="tts" ("" = голос из настроек; `custom:*` тоже ок).
    #[serde(default)]
    pub voice: String,
    /// 0.0..1.0 — громкость конкретного правила.
    #[serde(default = "default_gift_sound_volume")]
    pub volume: f32,
    /// `"each"` (каждый подарок — включая юниты внутри серии) |
    /// `"series"` (один раз по окончании серии).
    #[serde(default = "default_gift_sound_mode")]
    pub mode: String,
}

fn default_gift_sound_kind() -> String {
    "sound".into()
}
fn default_gift_sound_text() -> String {
    "{user} подарил {gift}".into()
}
fn default_gift_sound_volume() -> f32 {
    1.0
}
fn default_gift_sound_mode() -> String {
    "series".into()
}

fn default_tts_engine() -> String {
    "edge".into()
}

fn default_tts_pitch() -> f32 {
    1.0
}

fn default_tts_style() -> String {
    "normal".into()
}

impl Default for TtsSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            engine: default_tts_engine(),
            voice: String::new(),
            rate: 1.0,
            volume: 0.9,
            pitch: 1.0,
            style: default_tts_style(),
            emotions: true,
            whitelist: Vec::new(),
            blacklist: Vec::new(),
            only_whitelist: false,
            whitelist_priority: true,
            voice_per_user: false,
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
            // Одно дефолтное правило — «Обычная озвучка, от 0 уровня»
            // читает всех выбранным голосом; порог поднимают в UI.
            rules: vec![TtsVoiceRule {
                id: "default".into(),
                name: "Обычная озвучка".into(),
                enabled: true,
                min_level: 0,
                voices: Vec::new(),
                read_mods: true,
                read_superfans: true,
            }],
            gift_sounds: Vec::new(),
            gemini_key: String::new(),
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
    /// Dev mode: serve the relay API from the launcher itself
    /// (`roblox_bridge.rs`, `localhost:<port>`) — Studio polls it directly.
    #[serde(default)]
    pub local_bridge: bool,
    /// Embedded bridge port; `None` = `roblox_bridge::DEFAULT_PORT` (8790).
    #[serde(default)]
    pub local_bridge_port: Option<u16>,
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
    /// The first launch of each build snapshots the file to
    /// `settings.json.bak-<version>` (last 3 kept) so a bad upgrade or a
    /// migration bug never costs the streamer their config.
    pub fn load(dir: &std::path::Path) -> Self {
        let path = dir.join("settings.json");
        Self::versioned_backup(&path);
        // BOM-толерантность: Notepad/PowerShell пишут UTF-8 BOM,
        // который для serde_json — мусор в нулевой позиции.
        let mut data: Settings = fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(s.trim_start_matches('\u{feff}')).ok())
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

    /// Copies `path` to `settings.json.bak-<pkg-version>` once per build
    /// and prunes older snapshots beyond the newest three.
    fn versioned_backup(path: &std::path::Path) {
        if !path.exists() {
            return;
        }
        let bak = path.with_file_name(format!(
            "settings.json.bak-{}",
            env!("CARGO_PKG_VERSION")
        ));
        if !bak.exists() {
            let _ = fs::copy(path, &bak);
        }
        const KEEP: usize = 3;
        let Some(dir) = path.parent() else { return };
        let mut olds: Vec<PathBuf> = fs::read_dir(dir)
            .map(|rd| {
                rd.filter_map(|e| e.ok().map(|e| e.path()))
                    .filter(|p| {
                        p.file_name()
                            .and_then(|n| n.to_str())
                            .is_some_and(|n| n.starts_with("settings.json.bak-"))
                    })
                    .collect()
            })
            .unwrap_or_default();
        if olds.len() > KEEP {
            olds.sort_by_key(|p| {
                fs::metadata(p)
                    .and_then(|m| m.modified())
                    .unwrap_or(std::time::SystemTime::UNIX_EPOCH)
            });
            for p in olds.iter().take(olds.len() - KEEP) {
                let _ = fs::remove_file(p);
            }
        }
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
        // Прежняя копия — settings.json.bak: внешняя правка с битым
        // JSON не должна безвозвратно стирать конфиг пользователя.
        if self.path.exists() {
            let _ = fs::copy(&self.path, self.path.with_extension("json.bak"));
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

    /// Десериализация реального settings.json целиком — если efirtimer
    /// ломает парс, падает ВСЁ в дефолт. `SETTINGS_PATH=<file>`.
    #[test]
    fn settings_file_parses() {
        let Ok(path) = std::env::var("SETTINGS_PATH") else { return };
        let raw = std::fs::read_to_string(path).expect("read settings");
        match serde_json::from_str::<crate::settings::Settings>(&raw) {
            Ok(s) => println!("OK efirtimer.rlts={}", s.efirtimer.roulettes.len()),
            Err(e) => println!("PARSE_ERR: {e}"),
        }
    }

    /// Починка кракозябр в settings.json: строки, в которых UTF-8 был
    /// ошибочно прочитан как CP1251 (признак — буквы ЈџњЉљ±№, которых
    /// нет в русском тексте), ре-энкодируются CP1251→bytes→UTF-8.
    /// Запуск: `MOJIBAKE_FIX=<settings.json> cargo test mojibake_fix`
    #[cfg(test)]
    #[test]
    fn mojibake_fix_file() {
        let Ok(path) = std::env::var("MOJIBAKE_FIX") else { return };
        let raw = std::fs::read_to_string(&path).expect("read settings");
        let mut v: serde_json::Value = serde_json::from_str(&raw).expect("parse");
        let n = mojibake_fix_value(&mut v);
        // UTF-8 без BOM — BOM ломает serde_json и роняет всё в дефолт.
        std::fs::write(&path, serde_json::to_string_pretty(&v).unwrap()).unwrap();
        println!("MOJIBAKE_FIXED:{n}");
    }

    #[cfg(test)]
    fn mojibake_fix_value(v: &mut serde_json::Value) -> usize {
        match v {
            serde_json::Value::String(s) => usize::from(mojibake_fix_str(s)),
            serde_json::Value::Array(a) => a.iter_mut().map(mojibake_fix_value).sum(),
            serde_json::Value::Object(o) => {
                let mut n: usize = o.values_mut().map(mojibake_fix_value).sum();
                // ключи тоже могут быть битыми (walletCommands: "!руина")
                let keys: Vec<String> = o.keys().cloned().collect();
                for k in keys {
                    let mut nk = k.clone();
                    if mojibake_fix_str(&mut nk) {
                        if let Some(val) = o.remove(&k) {
                            o.insert(nk, val);
                            n += 1;
                        }
                    }
                }
                n
            }
            _ => 0,
        }
    }

    /// true, если строка была кракозябрами и восстановлена.
    #[cfg(test)]
    fn mojibake_fix_str(s: &mut String) -> bool {
        const MARKERS: &[char] = &[
            'Ј', 'ј', 'Љ', 'љ', 'Њ', 'њ', 'Џ', 'џ', 'Ђ', 'ђ', 'Ѓ', 'ѓ',
            'Ѕ', 'ѕ', 'Є', 'є', 'І', 'і', 'Ї', 'ї', 'Ґ', 'ґ', '±', '№',
            'Ў', 'ў', '‰', '‚', 'ƒ', '„', 'ˆ', '‹', '›', '˜', '™', '†',
            '‡', 'Š', 'Œ', 'Ž', 'š', 'œ', 'ž', 'Ÿ',
        ];
        if !s.chars().any(|c| MARKERS.contains(&c)) {
            return false;
        }
        let (bytes, _, had_errors) = encoding_rs::WINDOWS_1251.encode(s);
        if had_errors {
            return false;
        }
        if let Ok(fixed) = String::from_utf8(bytes.into_owned()) {
            *s = fixed;
            true
        } else {
            false
        }
    }
