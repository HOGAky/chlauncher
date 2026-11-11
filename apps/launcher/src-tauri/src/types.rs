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
    /// Unique dispatch id — external adapters (§10.1) echo it back in
    /// `ack` frames so the UI feed can show «выполнено в игре».
    #[serde(default)]
    pub event_id: String,
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
    /// Item count inside this event: gift `repeatCount`, batched
    /// `likeCount`, 1 for everything else. Kept separate from `amount`
    /// (legacy units) so `per_unit`/`every_n` rules can count items.
    #[serde(default = "default_one_i32")]
    pub count: i32,
    /// TikTok-coin value of the whole event (`diamondCount × repeatCount`;
    /// donations converted at `da_coins_per_rub`). 0 for free events —
    /// the earn limit ignores those.
    #[serde(default)]
    pub coins: i64,
    /// Stable TikTok gift id — survives gift-name localization.
    #[serde(default)]
    pub gift_id: Option<i64>,
    /// Subscriber/moderator/super-fan flag from the sidecar — feeds VIP
    /// multipliers (points) and can gate VIP-only rules later.
    #[serde(default)]
    pub vip: bool,
    /// Unix ms when the event reached the launcher (queueing latency).
    #[serde(default)]
    pub ts_ms: u64,
}

/// Current unix time in milliseconds — fills `ts_ms` at ingest points.
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn default_true() -> bool {
    true
}
fn default_one_i32() -> i32 {
    1
}
fn default_one_u32() -> u32 {
    1
}
fn default_one_f32() -> f32 {
    1.0
}
fn default_any() -> String {
    "any".into()
}
fn default_contains() -> String {
    "contains".into()
}
fn default_once() -> String {
    "once".into()
}
fn default_max_repeat() -> u32 {
    20
}
fn default_interrupt_ms() -> u64 {
    60_000
}
fn default_version() -> u32 {
    1
}
fn default_alert_ms() -> u64 {
    4_000
}
fn default_top() -> String {
    "top".into()
}
fn default_alert_style() -> String {
    "default".into()
}
fn default_contain() -> String {
    "contain".into()
}
fn default_accent() -> String {
    "#7c3aed".into()
}
fn default_cards() -> String {
    "cards".into()
}
fn default_columns() -> u32 {
    3
}
fn default_rotate_ms() -> u64 {
    8_000
}
fn default_opacity() -> f32 {
    0.85
}
fn default_spin_ms() -> u64 {
    4_500
}

/// Reference to a media-library file (`Settings::media`, §4.1).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MediaRef {
    pub id: String,
}

/// Sound attachment for an alert — plays inside the overlay.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SoundRef {
    pub id: String,
    #[serde(default = "default_one_f32")]
    pub volume: f32,
}

/// Video/GIF/image attachment for an alert.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MediaPlayRef {
    pub id: String,
    /// `"contain"` | `"cover"`.
    #[serde(default = "default_contain")]
    pub fit: String,
    #[serde(default = "default_one_f32")]
    pub volume: f32,
}

/// On-overlay alert attached to a rule fire (§3).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AlertSpec {
    /// Template — placeholders `{user} {gift} {count} {coins} {action} {label}`.
    #[serde(default)]
    pub text: String,
    #[serde(default = "default_alert_ms")]
    pub duration_ms: u64,
    #[serde(default)]
    pub sound: Option<SoundRef>,
    #[serde(default)]
    pub media: Option<MediaPlayRef>,
    /// `"top"` | `"center"` | `"bottom"`.
    #[serde(default = "default_top")]
    pub position: String,
    /// `"default"` | `"minimal"` | `"big"`.
    #[serde(default = "default_alert_style")]
    pub style: String,
}

/// TTS voice-over attached to a rule (§6).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TtsRuleSpec {
    /// Phrase template with the same placeholders as alerts.
    #[serde(default)]
    pub template: String,
    /// Voice override — `None` falls back to `TtsSettings::voice`.
    #[serde(default)]
    pub voice: Option<String>,
}

/// Look & layout of the preset cheat-sheet overlay (`/overlay/preset`, §5.2).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OverlayStyle {
    /// `"cards"` | `"list"` | `"text"`.
    #[serde(default = "default_cards")]
    pub template: String,
    #[serde(default = "default_accent")]
    pub accent_color: String,
    #[serde(default = "default_opacity")]
    pub bg_opacity: f32,
    #[serde(default = "default_one_f32")]
    pub font_scale: f32,
    /// `"none"` | `"thin"` | `"glow"`.
    #[serde(default)]
    pub border: String,
    #[serde(default = "default_columns")]
    pub columns: u32,
    /// Rows per page; when there are more rules the pages rotate every
    /// `rotate_ms` (0 = show everything at once).
    #[serde(default)]
    pub max_rows: u32,
    #[serde(default = "default_rotate_ms")]
    pub rotate_ms: u64,
}

impl Default for OverlayStyle {
    fn default() -> Self {
        Self {
            template: default_cards(),
            accent_color: default_accent(),
            bg_opacity: default_opacity(),
            font_scale: 1.0,
            border: "none".into(),
            columns: default_columns(),
            max_rows: 0,
            rotate_ms: default_rotate_ms(),
        }
    }
}

/// One segment of a gift spinner wheel (§7).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpinnerSegment {
    pub label: String,
    /// Game command emitted when the wheel lands here.
    pub action: String,
    #[serde(default = "default_one_u32")]
    pub weight: u32,
    #[serde(default = "default_accent")]
    pub color: String,
    #[serde(default)]
    pub alert: Option<AlertSpec>,
}

/// A named wheel of fortune — rules reference it via `TriggerRule::spinner`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpinnerPool {
    pub name: String,
    #[serde(default)]
    pub segments: Vec<SpinnerSegment>,
    #[serde(default = "default_spin_ms")]
    pub spin_ms: u64,
}

/// Media-library index row; the file itself lives in
/// `<app-data>/media/<id>.<ext>` and is served at `/media/:id` (§4.1).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MediaItem {
    pub id: String,
    pub name: String,
    /// `"video"` | `"gif"` | `"image"` | `"audio"`.
    pub kind: String,
    /// File extension without the dot (`mp4`, `webp`, `mp3`, …).
    pub ext: String,
    #[serde(default)]
    pub size: u64,
    #[serde(default)]
    pub duration_ms: Option<u64>,
}

/// A stream-level goal — "300 roses → spawn boss" (§goals).
///
/// Unlike per-rule accumulators (`every_n`, reset on each fire), a goal
/// accumulates over the whole stream and fires its `action` once on
/// reaching `target`. Counters live in memory — a launcher restart or
/// `reset_goals` zeroes them.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreamGoal {
    pub id: String,
    /// Overlay caption, e.g. «300 роз → босс».
    pub label: String,
    /// `"tiktok"` | `"donationalerts"` | `"simulator"` | `"any"`.
    #[serde(default = "default_any")]
    pub source: String,
    /// `"gift"` | `"like"` | `"donation"` | `"comment"` | `"follow"` | `"any"`.
    #[serde(default = "default_any")]
    pub event_kind: String,
    /// Case-insensitive substring of `raw_name`; empty = all of the kind.
    #[serde(default)]
    pub match_value: String,
    /// Accumulate `raw.coins` (coins/RUB value) instead of `raw.count`.
    /// Use for "5000 coins worth of gifts"; off for "300 roses".
    #[serde(default)]
    pub count_coins: bool,
    pub target: i64,
    /// Game action dispatched once on completion ("" = celebrate only).
    #[serde(default)]
    pub action: String,
    /// Alert text shown on completion; empty uses the default template.
    #[serde(default)]
    pub celebrate: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

/// Subathon («субатон») config — paid events extend the countdown
/// rendered on `/overlay/subathon`. Runtime is in-memory; only these
/// knobs persist.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct SubathonCfg {
    /// Seconds added per TikTok coin of a gift (donations count via
    /// their converted `coins`, same knob).
    pub sec_per_coin: u32,
    /// Flat seconds per `subscribe` event.
    pub sec_per_sub: u32,
    /// Hard cap on remaining time — a whale can't extend forever.
    pub max_s: u32,
}

impl Default for SubathonCfg {
    fn default() -> Self {
        Self {
            sec_per_coin: 5,
            sec_per_sub: 300,
            max_s: 12 * 3600,
        }
    }
}

/// Hype-meter config — the overlay bar fills as paid events pour in.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct HypeCfg {
    /// Sliding window the meter sums, seconds.
    pub window_s: u32,
    /// Coins inside the window that mean "100% hype".
    pub target_coins: u32,
}

impl Default for HypeCfg {
    fn default() -> Self {
        Self {
            window_s: 60,
            target_coins: 500,
        }
    }
}

/// Timed auto-event («каждые N минут → действие»): a synthetic
/// `timer` event re-enters the ingest pipeline, so a rule
/// (`kind=timer`, `match=label`) runs the action like any trigger.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct TimedEvent {
    pub id: String,
    /// Overlay/match label ("напоминание о подписке").
    pub label: String,
    /// Fire interval in minutes.
    pub interval_min: u32,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

impl Default for TimedEvent {
    fn default() -> Self {
        Self {
            id: String::new(),
            label: String::new(),
            interval_min: 10,
            enabled: true,
        }
    }
}

/// Viewer-points economy config — how chat activity converts to points.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct PointsCfg {
    /// Master switch — off = no earning and `!buy` is ignored.
    pub enabled: bool,
    /// Points per comment (once per `comment_cooldown_s` per viewer —
    /// anti-spam so "а а а" doesn't farm).
    pub per_comment: u32,
    /// Per-user earn cooldown for comment points, seconds.
    pub comment_cooldown_s: u32,
    /// Points per TikTok coin of a gift / donation.
    pub per_coin: u32,
    /// Flat points per `subscribe` event.
    pub per_sub: u32,
    /// Flat points per `follow`.
    pub per_follow: u32,
    /// Earn multiplier for VIP viewers (subscriber/moderator/super-fan
    /// per the sidecar `vip` flag). 1.0 = no bonus.
    pub vip_multiplier: f32,
}

impl Default for PointsCfg {
    fn default() -> Self {
        Self {
            enabled: false,
            per_comment: 1,
            comment_cooldown_s: 60,
            per_coin: 10,
            per_sub: 500,
            per_follow: 50,
            vip_multiplier: 2.0,
        }
    }
}

/// One purchasable item — `!buy <name>` deducts `price` points and
/// injects a `shop` event (`raw_name = name`) a trigger rule can act on.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ShopItem {
    pub id: String,
    /// What viewers type after `!buy` — e.g. "kill" → `!buy kill`.
    pub name: String,
    pub price: u32,
    /// Optional note shown in the UI ("спавнит крипера").
    pub hint: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

impl Default for ShopItem {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            price: 0,
            hint: String::new(),
            enabled: true,
        }
    }
}

impl Default for StreamGoal {
    fn default() -> Self {
        Self {
            id: String::new(),
            label: String::new(),
            source: "any".into(),
            event_kind: "any".into(),
            match_value: String::new(),
            count_coins: false,
            target: 0,
            action: String::new(),
            celebrate: String::new(),
            enabled: true,
        }
    }
}

/// One trigger-mapping rule in a streamer's profile.
///
/// Matching semantics: `source` and `event_kind` support the wildcard
/// `"any"`; `match_value` checks against the raw payload name per
/// `match_mode` (empty string = match all); `min_amount` filters
/// on the event amount.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TriggerRule {
    pub id: String,
    /// `"tiktok"` | `"donationalerts"` | `"simulator"` | `"any"`.
    pub source: String,
    /// `"gift"` | `"like"` | `"comment"` | `"donation"` | `"any"`.
    pub event_kind: String,
    /// Gift name / text to match ("" = everything). Under
    /// `match_mode="gift_id"` this stores the numeric gift id.
    pub match_value: String,
    /// Minimum amount to trigger (0 = no threshold).
    pub min_amount: i32,
    /// Game command to emit, e.g. `spawn_enemy`. Ignored when `spinner`
    /// names a pool (the wheel decides the action instead).
    pub action: String,
    /// Multiplies the emitted `amount` (default 1.0).
    #[serde(default = "default_one_f32")]
    pub multiplier: f32,
    /// Off-switch that keeps the rule in the profile.
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Human-readable action label for overlays/posters («Спавн зомби»).
    #[serde(default)]
    pub label: String,
    /// Description used by the "text" overlay template.
    #[serde(default)]
    pub description: String,
    /// Action artwork for the preset overlay (media-library reference).
    #[serde(default)]
    pub image: Option<MediaRef>,
    /// `"contains"` (legacy substring), `"exact"` or `"gift_id"`.
    #[serde(default = "default_contains")]
    pub match_mode: String,
    /// `"once"` per event or `"per_unit"` — N items → N firings.
    #[serde(default = "default_once")]
    pub repeat: String,
    /// Cap on `per_unit` firings produced by one event.
    #[serde(default = "default_max_repeat")]
    pub max_repeat: u32,
    /// Accumulator: fire once per `every_n` collected units (0 = off).
    #[serde(default)]
    pub every_n: u32,
    /// Per-rule cooldown — the rule skips events while cooling.
    #[serde(default)]
    pub cooldown_ms: u64,
    /// Cooldown applied per viewer (`user`).
    #[serde(default)]
    pub user_cooldown_ms: u64,
    /// Alert-queue priority (higher first; FIFO inside a priority).
    #[serde(default)]
    pub priority: i32,
    /// Paid interrupt — jumps the alert queue, can swap the preset (§3.3).
    #[serde(default)]
    pub interrupt: bool,
    /// Preset temporarily activated while this interrupt runs.
    #[serde(default)]
    pub interrupt_preset: Option<String>,
    /// How long the interrupt preset stays active.
    #[serde(default = "default_interrupt_ms")]
    pub interrupt_duration_ms: u64,
    /// On-screen alert (text/sound/media) shown with the action.
    #[serde(default)]
    pub alert: Option<AlertSpec>,
    /// Speak the event through TTS.
    #[serde(default)]
    pub tts: Option<TtsRuleSpec>,
    /// Spinner pool name — replaces `action` with a weighted segment (§7).
    #[serde(default)]
    pub spinner: Option<String>,
    /// Delay before the action dispatches.
    #[serde(default)]
    pub delay_ms: u64,
    /// Keep evaluating later rules after this one matches.
    #[serde(default)]
    pub continue_matching: bool,
}

impl Default for TriggerRule {
    fn default() -> Self {
        Self {
            id: String::new(),
            source: "any".into(),
            event_kind: "any".into(),
            match_value: String::new(),
            min_amount: 0,
            action: String::new(),
            multiplier: 1.0,
            enabled: true,
            label: String::new(),
            description: String::new(),
            image: None,
            match_mode: default_contains(),
            repeat: default_once(),
            max_repeat: default_max_repeat(),
            every_n: 0,
            cooldown_ms: 0,
            user_cooldown_ms: 0,
            priority: 0,
            interrupt: false,
            interrupt_preset: None,
            interrupt_duration_ms: default_interrupt_ms(),
            alert: None,
            tts: None,
            spinner: None,
            delay_ms: 0,
            continue_matching: false,
        }
    }
}

fn default_interrupt_cd_ms() -> u64 {
    30_000
}

/// The full trigger profile for one game, persisted as JSON.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TriggerProfile {
    pub game_slug: String,
    /// Name of the preset this profile was last applied from — `None` for
    /// the seeded default or a hand-built profile.
    #[serde(default)]
    pub preset: Option<String>,
    /// Overlay look for this profile's cheat-sheet (§5.2).
    #[serde(default)]
    pub overlay: OverlayStyle,
    /// Minimum gap between any two fired actions of this profile.
    #[serde(default)]
    pub global_cooldown_ms: u64,
    /// Minimum gap between two interrupt jobs (anti-cascade, §3.3.3).
    #[serde(default = "default_interrupt_cd_ms")]
    pub interrupt_cooldown_ms: u64,
    #[serde(default)]
    pub rules: Vec<TriggerRule>,
}

/// A named, shareable rule set — the streamer's preset. Presets are the
/// reusable unit: build one gift/event mapping once, apply it to any game's
/// profile in one click. A preset is usually built *for* a game
/// (`game_slug` = its action vocabulary); `None` marks universal presets
/// offered for every game.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TriggerPreset {
    /// Unique key, e.g. `steal-the-stream` or the streamer's own name.
    pub name: String,
    /// Game this preset was built for; `None` = universal.
    #[serde(default)]
    pub game_slug: Option<String>,
    /// One-line description shown in the preset picker.
    #[serde(default)]
    pub description: String,
    /// Built-in presets ship with the launcher and can't be overwritten or
    /// deleted; the flag is always cleared for streamer-saved presets.
    #[serde(default)]
    pub builtin: bool,
    /// Overlay look applied to the profile along with the rules.
    #[serde(default)]
    pub overlay: OverlayStyle,
    /// Minimum gap between actions when this preset is active.
    #[serde(default)]
    pub global_cooldown_ms: u64,
    /// Schema version — bumped when the share format changes (§1.5).
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default)]
    pub rules: Vec<TriggerRule>,
}

// ---------------------------------------------------------------------------
// Overlay wire frames — §5.3 of the parity spec.
// ---------------------------------------------------------------------------

/// Sound payload inside an `alert` frame — `MediaRef` resolved to a URL.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FrameSound {
    pub url: String,
    pub volume: f32,
}

/// Media payload inside an `alert` frame.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FrameMedia {
    pub url: String,
    pub fit: String,
    pub volume: f32,
}

/// One accumulator row in a `progress` frame («лайки: 63/100»).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProgressItem {
    pub rule_id: String,
    pub label: String,
    pub value: u64,
    pub target: u64,
}

/// One row of the preset cheat-sheet pushed in a `preset` frame.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PresetRow {
    /// Matched gift/event name shown to viewers.
    pub gift: String,
    /// Icon URL (`/gifts/…`) when the catalog knows the gift.
    #[serde(default)]
    pub gift_image: Option<String>,
    /// Items needed (count/`every_n` target).
    pub count: i32,
    /// Coin value hint (0 = free/unknown).
    pub coins: i64,
    /// What happens — `label` or `action`.
    pub label: String,
    /// Action artwork (`/media/…`) when set.
    #[serde(default)]
    pub image: Option<String>,
}

/// A frame pushed on the overlay broadcast channel (`OverlayFrame` is the
/// tagged union consumed by `/ws` subscribers, spec §5.3).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum OverlayFrame {
    Alert {
        id: String,
        text: String,
        duration_ms: u64,
        #[serde(default)]
        sound: Option<FrameSound>,
        #[serde(default)]
        media: Option<FrameMedia>,
        position: String,
        style: String,
        #[serde(default)]
        user: String,
    },
    /// Interrupt cut the currently shown alert short.
    AlertCancel { id: String },
    /// Active preset changed — preset pages re-render live (§5.2).
    Preset {
        name: String,
        style: OverlayStyle,
        rows: Vec<PresetRow>,
    },
    /// Gift-spinner spin — the overlay animates and lands on
    /// `result_index` (the launcher decides the outcome, §7).
    Spinner {
        id: String,
        pool: String,
        segments: Vec<SpinnerSegment>,
        result_index: usize,
        spin_ms: u64,
        user: String,
    },
    /// TTS voice-over state for `/overlay/tts` (§6).
    Tts {
        id: String,
        text: String,
        /// `"start"` | `"end"` | `"muted"`.
        state: String,
        /// `"/tts/<id>.wav"` for `output = "overlay"` — the page plays it.
        #[serde(default)]
        audio_url: Option<String>,
    },
    /// Accumulator progress (`every_n` rules) for `/overlay/progress`.
    Progress { items: Vec<ProgressItem> },
    /// Paid interrupt took over the profile for a while (§3.3).
    Takeover {
        user: String,
        preset: String,
        until_ms: u64,
    },
}

/// One entry in the UI's statusful event feed — fired *and* skipped
/// events (cooldown/limit/paused) so the streamer sees why a rule
/// didn't fire.
#[derive(Debug, Clone, Serialize)]
pub struct FeedItem {
    pub ts: u64,
    /// `"done"` | `"cooldown"` | `"limit"` | `"interrupt_cooldown"` |
    /// `"paused"` | `"dropped"`.
    pub status: String,
    /// Adapter `ack` for this dispatch: `true` = выполнено в игре,
    /// `false` = adapter reported failure; `None` = no ack yet.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ack: Option<bool>,
    pub event: StreamEvent,
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
    /// Free-tier games launch/download without a subscription (§8.3).
    #[serde(default)]
    pub is_free: bool,
    /// `"game"` (launcher-spawned, SDK) or `"adapter"` (external mod, §10.3).
    #[serde(default = "default_game_kind")]
    pub kind: String,
    /// JSON blob `{actions:[{id,label,params}]}` for adapters — the mapper
    /// renders it as an action dropdown instead of a free-text field.
    #[serde(default)]
    pub adapter_manifest: String,
}

fn default_game_kind() -> String {
    "game".into()
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
    /// Tariff code ('free'|'pro'|'expert'|…) — absent on pre-v6 servers.
    #[serde(default)]
    pub plan_code: Option<String>,
}

/// What a plan unlocks — mirrors the `entitlements` JSON column (§8.2).
/// `None` on numeric fields = unlimited. Unknown keys are ignored so
/// servers can add entitlements without breaking old launchers.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Entitlements {
    #[serde(default)]
    pub max_presets: Option<i64>,
    #[serde(default)]
    pub max_rules_per_preset: Option<i64>,
    #[serde(default)]
    pub max_media_triggers: Option<i64>,
    #[serde(default)]
    pub tts: bool,
    #[serde(default)]
    pub spinner: bool,
    #[serde(default)]
    pub custom_overlay_style: bool,
    #[serde(default)]
    pub interrupts: bool,
    #[serde(default)]
    pub earn_limit_coins_month: Option<i64>,
    #[serde(default)]
    pub paid_games: bool,
    #[serde(default)]
    pub mc_premium_plugins: bool,
}

/// Unrestricted map — used when the entitlements fetch fails (offline /
/// old server) so a network blip never silently degrades a paying user.
impl Default for Entitlements {
    fn default() -> Self {
        Self {
            max_presets: None,
            max_rules_per_preset: None,
            max_media_triggers: None,
            tts: true,
            spinner: true,
            custom_overlay_style: true,
            interrupts: true,
            earn_limit_coins_month: None,
            paid_games: true,
            mc_premium_plugins: true,
        }
    }
}

/// Tariff plan row for the pricing table (`GET /api/plans`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Plan {
    pub code: String,
    pub title: String,
    pub price_minor: i64,
    pub currency: String,
    pub period_days: i64,
    pub entitlements: Entitlements,
    #[serde(default)]
    pub active: bool,
    #[serde(default)]
    pub sort: i64,
}

/// `GET /api/account/entitlements` — plan + limits + this month's usage.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EntitlementsResponse {
    pub plan: Plan,
    pub entitlements: Entitlements,
    pub usage: MonthlyUsage,
}

/// `usage_monthly` view for the UI progress bar.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MonthlyUsage {
    pub month: String,
    pub coins: i64,
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

/// One entry of `GET /api/mc/plugins` — a Paper plugin in the catalog
/// (parity spec §9.4). `sha256` is the download-integrity contract.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McPlugin {
    pub slug: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub sha256: String,
    #[serde(default)]
    pub size_bytes: i64,
    /// Requires the `mc_premium_plugins` entitlement to download.
    #[serde(default)]
    pub premium: bool,
}
