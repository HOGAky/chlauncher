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
    /// Отображаемое имя (nickname) — для «X пишет:» и лент.
    pub user: String,
    /// Стабильный TikTok @username (uniqueId). Whitelist/blacklist и
    /// привязка аккаунта матчатся по нему — nickname меняется свободно.
    /// Пусто у симулятора/DonationAlerts.
    #[serde(default)]
    pub unique_id: String,
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
    /// Authoritative room total carried on like batches (`d.total` from
    /// the webcast payload). Lets like-goals resync to the real counter
    /// instead of summing batches — sums drift when events drop.
    #[serde(default)]
    pub like_total: i64,
    /// Fan-club («команда») level reported by the sidecar —
    /// 0 = зритель не в фан-клубе стримера.
    #[serde(default)]
    pub fan_level: i64,
    /// Chat-moderator flag — «Озвучивать модераторов» TTS rules bypass
    /// the minimum team level.
    #[serde(default)]
    pub is_moderator: bool,
    /// Super-fan/subscriber/top-gifter — «Озвучивать суперфанатов» TTS
    /// rules bypass the minimum team level.
    #[serde(default)]
    pub is_superfan: bool,
    /// Ник зрителя, которому отвечает этот комментарий (TikTok reply/
    /// упоминание). Пусто для обычных сообщений — озвучка читает только
    /// текст; для ответов — «{ник адресата}, {текст}».
    #[serde(default)]
    pub reply_to: String,
    /// Unix ms when the event reached the launcher (queueing latency).
    #[serde(default)]
    pub ts_ms: u64,
    /// Upstream stable id (connector `msgId`/`eventId`, DA alert id) —
    /// lets gamekit dedupe reconnect replays authoritatively instead of
    /// fingerprinting. Empty for sources without stable ids.
    #[serde(default)]
    pub event_id: String,
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

/// Правило «подарок → анимация» для оверлея `/widgets/animbox.html`.
/// Ассет — файл медиатеки (`/media/<id>`) с альфой (webm/gif/png);
/// без `media_id` виджет рисует встроенную процедурную анимацию
/// «рука протягивает розу, которая расцветает».
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnimRule {
    pub id: String,
    /// Подпись в списке правил (UI).
    #[serde(default)]
    pub label: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Подстрока имени подарка (`raw_name`), регистр не важен;
    /// пусто + `gift_id: None` = любой подарок.
    #[serde(default)]
    pub gift_name: String,
    /// Точный TikTok `gift_id` — переживает локализацию имён подарков.
    #[serde(default)]
    pub gift_id: Option<i64>,
    /// `MediaItem.id` видео/GIF/картинки; пусто = встроенная «рука с розой».
    #[serde(default)]
    pub media_id: Option<String>,
    /// Мин. стоимость подарка в монетах за событие (0 = любой).
    #[serde(default)]
    pub min_coins: i64,
    /// `"series"` — раз на серию (кадр `gift`), `"each"` — на каждый
    /// юнит стрика (кадры `gift_tick`).
    #[serde(default = "default_anim_mode")]
    pub mode: String,
    /// Тримминг видео-монтажа: играть с `start_ms` до `end_ms`
    /// (0/0 = файл целиком). Для ассетов-наборов анимаций подряд.
    #[serde(default)]
    pub start_ms: u64,
    #[serde(default)]
    pub end_ms: u64,
    /// Максимум показа на экране, мс; 0 = до конца ассета/дефолт виджета.
    #[serde(default)]
    pub duration_ms: u64,
    /// Громкость видео со звуком 0..1.
    #[serde(default = "default_anim_volume")]
    pub volume: f32,
    /// Масштаб 0.2..3 относительно кадра виджета.
    #[serde(default = "default_anim_scale")]
    pub scale: f32,
    /// Якорь на экране: `center|top|bottom|left|right|top-left|top-right|
    /// bottom-left|bottom-right`.
    #[serde(default = "default_anim_pos")]
    pub position: String,
    /// Персональный кулдаун правила, мс — повторный триггер раньше срока
    /// пропускается (0 = без кулдауна).
    #[serde(default)]
    pub cooldown_ms: u64,
}

fn default_anim_mode() -> String {
    "series".into()
}
fn default_anim_volume() -> f32 {
    1.0
}
fn default_anim_scale() -> f32 {
    1.0
}
fn default_anim_pos() -> String {
    "bottom".into()
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
/// Gift-specific time rule for the timer app: exact gift-name match
/// (case-insensitive) → flat `sec` per gift unit. Negative values
/// STEAL time — the classic "Rose −10 s" prank rule.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct GiftTimeRule {
    pub name: String,
    pub sec: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct SubathonCfg {
    /// Master switch — off = events never touch the clock.
    pub enabled: bool,
    /// Default start duration when the page's "start" has no explicit
    /// override, seconds.
    pub start_s: u32,
    /// Seconds added per TikTok coin of a gift (donations count via
    /// their converted `coins`, same knob). Ignored for gifts that
    /// match an entry in `gift_rules`.
    pub sec_per_coin: u32,
    /// Flat seconds per `subscribe` event.
    pub sec_per_sub: u32,
    /// Flat seconds per `follow`.
    pub sec_per_follow: u32,
    /// Flat seconds per `share`.
    pub sec_per_share: u32,
    /// Likes needed for one `like_add_s` batch (0 = likes don't count).
    /// Carried over between batched LikeEvents.
    pub likes_per_add: u32,
    /// Seconds added per `likes_per_add` likes.
    pub like_add_s: u32,
    /// Hard cap on remaining time — a whale can't extend forever.
    pub max_s: u32,
    /// Per-gift overrides (checked before the coin-rate fallback);
    /// negative `sec` subtracts time.
    pub gift_rules: Vec<GiftTimeRule>,
    // --- overlay app styling ---
    /// `dark` | `light` | `neon` | `minimal`.
    pub theme: String,
    /// Accent hex color (`#rrggbb`).
    pub accent: String,
    /// UI scale multiplier (0.5–2.0).
    pub scale: f32,
    /// `center` | `top-right` | `top-left` | `bottom-right` | `bottom-left`.
    pub position: String,
    /// Show the "+Ns @user" ticker under the clock.
    pub show_feed: bool,
    /// Beep when time is added.
    pub sound: bool,
}

impl Default for SubathonCfg {
    fn default() -> Self {
        Self {
            enabled: true,
            start_s: 3600,
            sec_per_coin: 5,
            sec_per_sub: 300,
            sec_per_follow: 10,
            sec_per_share: 20,
            likes_per_add: 100,
            like_add_s: 10,
            max_s: 12 * 3600,
            gift_rules: Vec::new(),
            theme: "dark".into(),
            accent: "#f472b6".into(),
            scale: 1.0,
            position: "center".into(),
            show_feed: true,
            sound: true,
        }
    }
}

// ---------------------------------------------------------------------------
// EFIR-style stream timer — the full gift/effect engine ported from the
// TIMER app: triggers, roulettes, shield/reverse/multipliers, ruiner.
// ---------------------------------------------------------------------------

/// One wheel slot — `kind` picks the effect (`EfirSlotKind::*`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct EfirSlot {
    pub id: String,
    /// Text on the reel card (viewers see this land under the pointer).
    pub label: String,
    /// `add_time|sub_time|set_time|reset_time|multiply_time|divide_time|
    /// freeze|unfreeze|reverse_time|extra_spin|ruiner|save|multiplier|
    /// debuff|special|swap_time`
    #[serde(rename = "type")]
    pub kind: String,
    /// Seconds (or count for extra_spin/ruiner/save, duration for
    /// multiplier/debuff).
    pub value: i64,
    /// Factor for multiply/divide/multiplier/debuff (`x2`, `x1.5`…).
    #[serde(rename = "multiplierValue")]
    pub mult_value: f64,
    /// Free text for `special` slots.
    #[serde(rename = "textValue")]
    pub text: String,
    /// Weight — picked with probability chance/Σchance.
    pub chance: f64,
    pub color: String,
    #[serde(rename = "isEnabled")]
    pub enabled: bool,
    /// Consumed when won; the wheel restores `original_slots` once empty.
    #[serde(rename = "isEliminable")]
    pub eliminable: bool,
    /// `extra_spin`: which wheel to spin next (empty = same wheel).
    #[serde(rename = "extraSpinRouletteId")]
    pub extra_roulette_id: String,
    /// Multiplayer target from EFIR (`self` | `opponent` | `all` |
    /// `random`). Single-timer build: non-self targets apply to self.
    #[serde(default = "default_slot_target")]
    pub target: String,
    #[serde(skip)]
    pub original: bool,
}

impl Default for EfirSlot {
    fn default() -> Self {
        Self {
            id: String::new(),
            label: String::new(),
            kind: "add_time".into(),
            value: 60,
            mult_value: 2.0,
            text: String::new(),
            chance: 10.0,
            color: "#6366f1".into(),
            enabled: true,
            eliminable: false,
            extra_roulette_id: String::new(),
            target: default_slot_target(),
            original: false,
        }
    }
}

fn default_slot_target() -> String {
    "self".into()
}
fn default_wheel_mode() -> String {
    "wheel".into()
}
fn default_true_b() -> bool {
    true
}

/// A named wheel: triggers by gift / likes-milestone / both; slots are
/// weighted entries. `original_slots` is the restore pool for
/// eliminable wheels (captured lazily on first elimination).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct EfirRoulette {
    pub id: String,
    pub name: String,
    /// `gift` | `like` | `both`.
    #[serde(rename = "triggerType")]
    pub trigger_type: String,
    #[serde(rename = "triggerGiftIds")]
    pub trigger_gift_ids: Vec<String>,
    /// Room-total likes per auto-spin (0 = off).
    #[serde(rename = "likesThreshold")]
    pub likes_threshold: i64,
    /// Charge the triggering gift's coins to the clock before spinning.
    #[serde(rename = "addsCost")]
    pub adds_cost: bool,
    #[serde(rename = "isEnabled")]
    pub enabled: bool,
    /// Fires while the shield is up.
    #[serde(rename = "worksWhenShielded")]
    pub works_when_shielded: bool,
    /// `wheel` (лента) | `cards` («ход судьбы» — 2-6 карт рубашкой
    /// вверх, донатер выбирает цифрой в чате до таймаута).
    #[serde(default = "default_wheel_mode")]
    pub mode: String,
    /// Cards mode: seconds the donor has to pick a card (EFIR default
    /// 120; clamped 1..3600).
    #[serde(rename = "choiceTimeoutSeconds")]
    pub choice_timeout_seconds: i64,
    /// Кнопка этой рулетки в пульте EFIR — цвет и видимость.
    #[serde(rename = "remoteButtonColor")]
    pub remote_button_color: String,
    #[serde(default = "default_true_b", rename = "showInRemote")]
    pub show_in_remote: bool,
    /// Главная рулетка (EFIR isMain — пометка для пульта/виджетов).
    #[serde(rename = "isMain")]
    pub is_main: bool,
    /// Точная сумма доната-триггер (EFIR parity; donation events у нас
    /// не приходят — поле хранится для импорта/экспорта).
    #[serde(rename = "donationAmount")]
    pub donation_amount: String,
    pub slots: Vec<EfirSlot>,
    /// Restore pool for eliminable wheels.
    #[serde(default)]
    pub original_slots: Vec<EfirSlot>,
}

impl Default for EfirRoulette {
    fn default() -> Self {
        Self {
            id: "default-1".into(),
            name: "Стандартная рулетка".into(),
            trigger_type: "both".into(),
            trigger_gift_ids: Vec::new(),
            likes_threshold: 100_000,
            adds_cost: false,
            enabled: true,
            works_when_shielded: false,
            mode: default_wheel_mode(),
            choice_timeout_seconds: 120,
            remote_button_color: String::new(),
            show_in_remote: true,
            is_main: false,
            donation_amount: String::new(),
            slots: Vec::new(),
            original_slots: Vec::new(),
        }
    }
}

/// Steal-time rule: matched gift subtracts `penalty_amount` seconds,
/// never pushing the clock below `penalty_threshold` (EFIR mercy floor).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct EfirPenalty {
    pub id: String,
    pub name: String,
    #[serde(rename = "giftIds")]
    pub gift_ids: Vec<String>,
    #[serde(rename = "penaltyAmount")]
    pub penalty_amount: i64,
    #[serde(rename = "penaltyThreshold")]
    pub penalty_threshold: i64,
    #[serde(rename = "isEnabled")]
    pub enabled: bool,
    #[serde(rename = "worksWhenShielded")]
    pub works_when_shielded: bool,
}

impl Default for EfirPenalty {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            gift_ids: Vec::new(),
            penalty_amount: 600,
            penalty_threshold: 300,
            enabled: true,
            works_when_shielded: false,
        }
    }
}

/// User-defined time trigger: `add|sub|set|reset` `value` seconds on a
/// gift match.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct EfirCustomTrigger {
    pub id: String,
    pub name: String,
    #[serde(rename = "giftIds")]
    pub gift_ids: Vec<String>,
    /// `add` | `sub` | `set` | `reset`.
    #[serde(rename = "type")]
    pub action: String,
    pub value: i64,
    #[serde(rename = "isEnabled")]
    pub enabled: bool,
    #[serde(rename = "worksWhenShielded")]
    pub works_when_shielded: bool,
}

impl Default for EfirCustomTrigger {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            gift_ids: Vec::new(),
            action: "add".into(),
            value: 60,
            enabled: true,
            works_when_shielded: false,
        }
    }
}

/// Widget styling — mirrors the EFIR appearance panel (theme presets
/// on the page side set these same keys).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct EfirStyles {
    #[serde(rename = "themeId")]
    pub theme_id: String,
    #[serde(rename = "roulettePrimary")]
    pub roulette_primary: String,
    #[serde(rename = "rouletteSecondary")]
    pub roulette_secondary: String,
    #[serde(rename = "rouletteSurface")]
    pub roulette_surface: String,
    #[serde(rename = "rouletteText")]
    pub roulette_text: String,
    #[serde(rename = "fontFamily")]
    pub font_family: String,
    #[serde(rename = "timerColor")]
    pub timer_color: String,
    /// Glow alpha 0..1.
    #[serde(rename = "timerGlow")]
    pub timer_glow: f32,
    #[serde(rename = "enableStroke")]
    pub enable_stroke: bool,
    #[serde(rename = "buffColor")]
    pub buff_color: String,
    #[serde(rename = "debuffColor")]
    pub debuff_color: String,
    #[serde(rename = "floatPlusColor")]
    pub float_plus_color: String,
    #[serde(rename = "floatMinusColor")]
    pub float_minus_color: String,
    #[serde(rename = "buffCardBg")]
    pub buff_card_bg: String,
    #[serde(rename = "debuffCardBg")]
    pub debuff_card_bg: String,
    /// Статистика без фона — только цифры со свечением.
    #[serde(rename = "statsTransparent", default)]
    pub stats_transparent: bool,
    /// Свои подписи строк статистики (пусто = стандартные).
    #[serde(rename = "statsUptimeLabel", default)]
    pub stats_uptime_label: String,
    #[serde(rename = "statsLikesLabel", default)]
    pub stats_likes_label: String,
}

impl Default for EfirStyles {
    fn default() -> Self {
        Self {
            theme_id: "roulette".into(),
            roulette_primary: "#6366f1".into(),
            roulette_secondary: "#f59e0b".into(),
            roulette_surface: "#111827".into(),
            roulette_text: "#ffffff".into(),
            font_family: "Inter, sans-serif".into(),
            timer_color: "#ffffff".into(),
            timer_glow: 0.4,
            enable_stroke: true,
            buff_color: "#34d399".into(),
            debuff_color: "#f43f5e".into(),
            float_plus_color: "#34d399".into(),
            float_minus_color: "#f87171".into(),
            buff_card_bg: "#10b981".into(),
            debuff_card_bg: "#e11d48".into(),
            stats_transparent: false,
            stats_uptime_label: String::new(),
            stats_likes_label: String::new(),
        }
    }
}

/// Rich sound spec — media-lib file + обрезка + громкость (EFIR
/// `soundVolume`/`trimStartMs`/`trimEndMs`). `volume` множится на
/// глобальную `cfg.volume`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct EfirSoundSpec {
    /// MediaItem.id → `/media/<id>`; пусто = синтезированный сигнал.
    pub media: String,
    #[serde(rename = "trimStartMs")]
    pub trim_start_ms: i64,
    /// 0 = до конца файла.
    #[serde(rename = "trimEndMs")]
    pub trim_end_ms: i64,
    /// 0..1 per-sound gain (EFIR soundVolume).
    #[serde(default = "default_sound_vol")]
    pub volume: f32,
}

fn default_sound_vol() -> f32 {
    1.0
}

/// Sound value: либо просто media id (`"abc"`), либо полный
/// `EfirSoundSpec` — untagged держит обратную совместимость со старым
/// `soundMap` (строки) и новыми объектами.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum EfirSound {
    Id(String),
    Spec(EfirSoundSpec),
}

impl Default for EfirSound {
    fn default() -> Self {
        Self::Id(String::new())
    }
}

/// Чат-команда кошелька (`!судьба2`, `!руина`…): ключ — id триггера
/// (`freeze|unfreeze|reverse|ruin|save|boost|debuff|settime|reset` или
/// `roulette:<id>` / `penalty:<id>` / `custom:<id>`). Зритель пишет
/// `!cmd [N]` — списывается `price × N` монет с его баланса.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct EfirWalletCmd {
    /// `!command` — регистронезависимо, 1-32 символа после `!`.
    pub command: String,
    /// Цена срабатывания в монетах TikTok (EFIR берёт cost подарка
    /// триггера — импорт подставляет его автоматически, поле правится).
    pub price: i64,
    /// Звук на срабатывание команды (воспроизводится на оверлее).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sound: Option<EfirSoundSpec>,
}

/// Whole EFIR timer config — mirrors the TIMER app's `defConfig` 1:1
/// (donation-amount triggers are unused: our events carry gifts only).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct EfirTimerCfg {
    pub enabled: bool,
    /// `"gifts"` — подарки сразу бьют по триггерам; `"balance"` — монеты
    /// подарков копятся на кошельках зрителей, а эффекты вызываются
    /// чат-командами из `wallet_commands` (EFIR donationMode).
    #[serde(rename = "donationMode")]
    pub donation_mode: String,
    /// Команды кошелька по id триггера — см. `EfirWalletCmd`.
    #[serde(rename = "walletCommands")]
    pub wallet_commands: std::collections::HashMap<String, EfirWalletCmd>,
    /// Off = unmatched gifts never touch the clock.
    #[serde(rename = "defaultGiftsEnabled")]
    pub default_gifts_enabled: bool,
    /// Seconds per coin for unmatched gifts.
    #[serde(rename = "defaultGiftSeconds")]
    pub default_gift_seconds: i64,
    #[serde(rename = "initialTime")]
    pub initial_time: i64,
    // --- bonus phase (extra-time roll instead of instant victory) ---
    #[serde(rename = "bonusEnabled")]
    pub bonus_enabled: bool,
    #[serde(rename = "bonusMin")]
    pub bonus_min: i64,
    #[serde(rename = "bonusMax")]
    pub bonus_max: i64,
    // --- shield (freeze) ---
    #[serde(rename = "isFreezeEnabled")]
    pub freeze_enabled: bool,
    #[serde(rename = "giftFreezeIds")]
    pub gift_freeze_ids: Vec<String>,
    #[serde(rename = "freezeDuration")]
    pub freeze_duration: i64,
    #[serde(rename = "giftUnfreezeIds")]
    pub gift_unfreeze_ids: Vec<String>,
    #[serde(rename = "unfreezeDuration")]
    pub unfreeze_duration: i64,
    #[serde(rename = "unfreezeWorksWhenShielded")]
    pub unfreeze_works_when_shielded: bool,
    // --- reverse ---
    #[serde(rename = "isReverseEnabled")]
    pub reverse_enabled: bool,
    #[serde(rename = "giftReverseIds")]
    pub gift_reverse_ids: Vec<String>,
    #[serde(rename = "reverseWorksWhenShielded")]
    pub reverse_works_when_shielded: bool,
    // --- ruiner + save ---
    #[serde(rename = "isRuinerEnabled")]
    pub ruiner_enabled: bool,
    #[serde(rename = "giftRuinerIds")]
    pub gift_ruiner_ids: Vec<String>,
    #[serde(rename = "ruinerDuration")]
    pub ruiner_duration: i64,
    #[serde(rename = "ruinerMinTime")]
    pub ruiner_min_time: i64,
    #[serde(rename = "ruinerMaxTime")]
    pub ruiner_max_time: i64,
    #[serde(rename = "giftSaveIds")]
    pub gift_save_ids: Vec<String>,
    #[serde(rename = "ruinerWorksWhenShielded")]
    pub ruiner_works_when_shielded: bool,
    #[serde(rename = "saveWorksWhenShielded")]
    pub save_works_when_shielded: bool,
    // --- multiplier buff / debuff ---
    #[serde(rename = "isMultiplierGiftEnabled")]
    pub multiplier_enabled: bool,
    #[serde(rename = "multiplierValue")]
    pub multiplier_value: f64,
    #[serde(rename = "multiplierDuration")]
    pub multiplier_duration: i64,
    #[serde(rename = "giftMultiplierIds")]
    pub gift_multiplier_ids: Vec<String>,
    #[serde(rename = "multiplierWorksWhenShielded")]
    pub multiplier_works_when_shielded: bool,
    #[serde(rename = "isDebuffGiftEnabled")]
    pub debuff_enabled: bool,
    #[serde(rename = "debuffValue")]
    pub debuff_value: f64,
    #[serde(rename = "debuffDuration")]
    pub debuff_duration: i64,
    #[serde(rename = "giftDebuffIds")]
    pub gift_debuff_ids: Vec<String>,
    #[serde(rename = "debuffWorksWhenShielded")]
    pub debuff_works_when_shielded: bool,
    // --- set / reset ---
    #[serde(rename = "isSetTimeEnabled")]
    pub set_time_enabled: bool,
    #[serde(rename = "giftSetTimeIds")]
    pub gift_set_time_ids: Vec<String>,
    #[serde(rename = "setTimeValue")]
    pub set_time_value: i64,
    #[serde(rename = "setTimeWorksWhenShielded")]
    pub set_time_works_when_shielded: bool,
    #[serde(rename = "isResetEnabled")]
    pub reset_enabled: bool,
    #[serde(rename = "giftResetIds")]
    pub gift_reset_ids: Vec<String>,
    #[serde(rename = "resetWorksWhenShielded")]
    pub reset_works_when_shielded: bool,
    // --- penalties & custom triggers ---
    #[serde(rename = "isPenaltyEnabled")]
    pub penalty_enabled: bool,
    pub penalties: Vec<EfirPenalty>,
    #[serde(rename = "customTriggers")]
    pub custom_triggers: Vec<EfirCustomTrigger>,
    // --- likes / follows ---
    #[serde(rename = "likesEnabled")]
    pub likes_enabled: bool,
    /// Likes from ONE viewer needed per `like_time` addition.
    #[serde(rename = "likeThreshold")]
    pub like_threshold: i64,
    #[serde(rename = "likeTime")]
    pub like_time: i64,
    #[serde(rename = "likesWorksWhenShielded")]
    pub likes_works_when_shielded: bool,
    #[serde(rename = "subsEnabled")]
    pub subs_enabled: bool,
    /// Seconds per first-time follow.
    #[serde(rename = "subTime")]
    pub sub_time: i64,
    #[serde(rename = "subsWorksWhenShielded")]
    pub subs_works_when_shielded: bool,
    // --- roulettes & appearance ---
    pub roulettes: Vec<EfirRoulette>,
    pub styles: EfirStyles,
    /// Master sound volume 0..1 (trigger sounds ride the media lib).
    pub volume: f32,
    /// Trigger-key → media id ИЛИ `EfirSoundSpec` (обрезка+громкость).
    /// Keys: alert types ("like","follow","roulette","ruiner",…),
    /// "spin", "win", "bonus", "default" fallback.
    #[serde(rename = "soundMap")]
    pub sound_map: std::collections::HashMap<String, EfirSound>,
    /// Рулетка, чья статистика/аптайм выводится в STATS-виджете
    /// (EFIR uptimeRouletteId; "" = общая).
    #[serde(rename = "uptimeRouletteId")]
    pub uptime_roulette_id: String,
    /// Дата старта аптайма (строка `YYYY-MM-DDTHH:mm` как в EFIR).
    #[serde(rename = "uptimeStartTime")]
    pub uptime_start_time: String,
}

impl Default for EfirTimerCfg {
    fn default() -> Self {
        Self {
            enabled: true,
            donation_mode: "gifts".into(),
            wallet_commands: std::collections::HashMap::new(),
            default_gifts_enabled: true,
            default_gift_seconds: 1,
            initial_time: 60,
            bonus_enabled: true,
            bonus_min: 60,
            bonus_max: 300,
            freeze_enabled: false,
            gift_freeze_ids: Vec::new(),
            freeze_duration: 60,
            gift_unfreeze_ids: Vec::new(),
            unfreeze_duration: 60,
            unfreeze_works_when_shielded: false,
            reverse_enabled: false,
            gift_reverse_ids: Vec::new(),
            reverse_works_when_shielded: false,
            ruiner_enabled: false,
            gift_ruiner_ids: Vec::new(),
            ruiner_duration: 60,
            ruiner_min_time: 60,
            ruiner_max_time: 300,
            gift_save_ids: Vec::new(),
            ruiner_works_when_shielded: false,
            save_works_when_shielded: false,
            multiplier_enabled: true,
            multiplier_value: 2.0,
            multiplier_duration: 60,
            gift_multiplier_ids: Vec::new(),
            multiplier_works_when_shielded: false,
            debuff_enabled: false,
            debuff_value: 2.0,
            debuff_duration: 60,
            gift_debuff_ids: Vec::new(),
            debuff_works_when_shielded: false,
            set_time_enabled: true,
            gift_set_time_ids: Vec::new(),
            set_time_value: 300,
            set_time_works_when_shielded: false,
            reset_enabled: true,
            gift_reset_ids: Vec::new(),
            reset_works_when_shielded: false,
            penalty_enabled: true,
            penalties: Vec::new(),
            custom_triggers: Vec::new(),
            likes_enabled: true,
            like_threshold: 100,
            like_time: 10,
            likes_works_when_shielded: false,
            subs_enabled: true,
            sub_time: 180,
            subs_works_when_shielded: false,
            roulettes: vec![EfirRoulette::default()],
            styles: EfirStyles::default(),
            volume: 0.5,
            sound_map: std::collections::HashMap::new(),
            uptime_roulette_id: String::new(),
            uptime_start_time: String::new(),
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

/// Per-game antiflood knobs — enforced in the overlay page by gamekit.js
/// (Rust only stores/transports them).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GameFloodCfg {
    /// Global action budget per second across all rules.
    pub max_per_sec: u32,
    /// Per-viewer action cap per minute (comment commands etc.).
    pub per_user_per_min: u32,
    /// Pending-action queue; overflow drops visual-only effects first.
    pub queue_cap: u32,
}

impl Default for GameFloodCfg {
    fn default() -> Self {
        Self {
            max_per_sec: 20,
            per_user_per_min: 30,
            queue_cap: 500,
        }
    }
}

/// Built-in interactive game config. `rules` stays free-form JSON so the
/// overlay game pages can grow their action vocabulary without a schema
/// migration — the page validates and applies them via gamekit.js.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BuiltinGameCfg {
    pub enabled: bool,
    /// Round length in seconds (0 = endless until manual stop).
    pub round_sec: u32,
    /// Sound volume 0..1 for game SFX.
    pub volume: f32,
    #[serde(default)]
    pub antiflood: GameFloodCfg,
    /// Rule table: `[{event, match{names,min_coins,command}, action{type,...}}]`.
    #[serde(default)]
    pub rules: serde_json::Value,
}

/// Live session of a built-in game — what `/games/state.json` reports.
#[derive(Debug, Clone, Serialize)]
pub struct GameSessionInfo {
    pub game_id: String,
    /// `running` | `paused`
    pub status: String,
    pub started_at_ms: u64,
    /// Accumulated paused milliseconds — pages subtract it from the timer.
    pub paused_total_ms: u64,
    /// When the last pause began (0 = not paused).
    pub pause_began_ms: u64,
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
        /// Per-clip playback volume (gift-sound rules); 1.0 = as encoded.
        #[serde(default = "default_one_f32")]
        volume: f32,
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
    /// Built-in interactive games the plan may launch (game ids).
    /// Missing/`None` = all games (offline fallback never degrades).
    #[serde(default)]
    pub interactive_games: Option<Vec<String>>,
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
            interactive_games: None,
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
