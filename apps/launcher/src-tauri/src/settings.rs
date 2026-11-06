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

use crate::types::{TriggerProfile, WindowOptions};

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
    /// Roblox/cloud relay: forward mapped StreamEvents over HTTP.
    #[serde(default)]
    pub forward: ForwardSettings,
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
}

/// File-backed settings store.
pub struct SettingsStore {
    path: PathBuf,
    pub data: Settings,
}

impl SettingsStore {
    /// Loads settings from `dir/settings.json`; missing/corrupt files fall
    /// back to defaults.
    pub fn load(dir: &std::path::Path) -> Self {
        let path = dir.join("settings.json");
        let data = fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        Self { path, data }
    }

    /// Atomically persists the current settings to disk.
    pub fn save(&self) -> std::io::Result<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let tmp = self.path.with_extension("json.tmp");
        fs::write(&tmp, serde_json::to_string_pretty(&self.data)?)?;
        fs::rename(&tmp, &self.path)?;
        Ok(())
    }
}
