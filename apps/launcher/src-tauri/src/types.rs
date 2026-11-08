//! Shared data types for the launcher backend.
//!
//! These mirror the wire format of `packages/game-sdk` — keep the JSON
//! shapes in sync (the same serde-tag protocol is spoken to games).

use serde::{Deserialize, Serialize};

/// A normalized, game-ready stream event — identical in shape to
/// `tiktok_game_sdk::StreamEvent` on the game side.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreamEvent {
    /// Origin service: `"tiktok"`, `"donationalerts"` or `"simulator"`.
    pub source: String,
    /// Raw event kind: `"gift"`, `"like"`, `"comment"`, `"donation"`.
    pub event_kind: String,
    /// Viewer display name.
    pub user: String,
    /// Avatar URL or empty string.
    pub avatar_url: String,
    /// Mapped game command (`spawn_enemy`, `spawn_boss`, `heal_player`, …).
    pub action_command: String,
    /// Quantity / amount (gift count, donation minor units, like count).
    pub amount: i32,
    /// Raw human-readable payload (gift name, donation text, comment body).
    pub raw_name: String,
}

/// A raw, unmapped event as produced by an integration or the simulator —
/// input side of the trigger mapper.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RawStreamEvent {
    pub source: String,
    pub event_kind: String,
    pub user: String,
    pub avatar_url: String,
    /// Raw name/payload: gift name ("Rose"), donation message, comment text.
    pub raw_name: String,
    /// Amount in source units (gift repeat count, donation minor units,
    /// batched like count).
    pub amount: i32,
}

/// One trigger-mapping rule in a streamer's profile.
///
/// Matching semantics: `source` and `event_kind` support the wildcard
/// `"any"`; `match_value` is a case-insensitive substring/`=` check against
/// the raw payload name (empty string = match all); `min_amount` filters
/// on the event amount.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TriggerRule {
    pub id: String,
    /// `"tiktok"` | `"donationalerts"` | `"simulator"` | `"any"`.
    pub source: String,
    /// `"gift"` | `"like"` | `"comment"` | `"donation"` | `"any"`.
    pub event_kind: String,
    /// Gift name / text to match ("" = everything).
    pub match_value: String,
    /// Minimum amount to trigger (0 = no threshold).
    pub min_amount: i32,
    /// Game command to emit, e.g. `spawn_enemy`.
    pub action: String,
    /// Multiplies the emitted `amount` (default 1.0).
    pub multiplier: f32,
}

/// The full trigger profile for one game, persisted as JSON.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TriggerProfile {
    pub game_slug: String,
    pub rules: Vec<TriggerRule>,
}

/// Catalog game as returned by the licensing server.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogGame {
    pub slug: String,
    pub title: String,
    pub description: String,
    pub version: String,
    pub executable_name: String,
    pub cover_image: String,
    /// SHA-256 of the published build — verified after download (spec §6.1).
    #[serde(default)]
    pub sha256: Option<String>,
    #[serde(default)]
    pub size_bytes: Option<i64>,
    #[serde(default)]
    pub changelog: Option<String>,
}

/// Locally installed game state.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstalledGame {
    pub version: String,
    pub install_dir: String,
    pub exe_path: String,
    /// SHA-256 the install was verified against (absent for pre-v2 installs).
    #[serde(default)]
    pub sha256: Option<String>,
    /// SHA-256 of the executable itself — re-verified before launch.
    #[serde(default)]
    pub exe_sha256: Option<String>,
}

/// Subscription view returned by the backend.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Subscription {
    pub status: String,
    pub current_period_end: Option<String>,
    pub auto_renew: bool,
    pub days_left: i64,
}

/// Connection status of an external integration.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum IntegrationStatus {
    #[default]
    Disconnected,
    Connecting,
    Connected,
    /// Connected to a live room / realtime feed.
    Live,
    Error(String),
}

/// Window-shaping options for game launch (TikTok Live Studio capture).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WindowOptions {
    pub width: u32,
    pub height: u32,
    pub borderless: bool,
    pub always_on_top: bool,
    pub chroma_key: bool,
}

impl Default for WindowOptions {
    fn default() -> Self {
        Self {
            width: 540,
            height: 960,
            borderless: true,
            always_on_top: true,
            chroma_key: false,
        }
    }
}
