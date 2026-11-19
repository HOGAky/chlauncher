/**
 * @file types.ts
 * TypeScript mirrors of the Rust types in `src-tauri/src/types.rs` —
 * keep field names aligned (serde uses snake_case).
 */

/** Subscription state returned by the licensing server. */
export interface Subscription {
  status: 'active' | 'expired' | 'canceled';
  current_period_end: string | null;
  auto_renew: boolean;
  days_left: number;
  /** Tariff code ('free' | 'pro' | …) — absent on pre-v6 servers. */
  plan_code?: string;
}

/** What a plan unlocks — mirrors the server `entitlements` JSON (§8.2). */
export interface Entitlements {
  max_presets: number | null;
  max_rules_per_preset: number | null;
  max_media_triggers: number | null;
  tts: boolean;
  spinner: boolean;
  custom_overlay_style: boolean;
  interrupts: boolean;
  earn_limit_coins_month: number | null;
  paid_games: boolean;
  mc_premium_plugins: boolean;
  /** Built-in game ids the plan may launch; absent = all games. */
  interactive_games?: string[] | null;
}

/** Tariff plan row for the pricing table (`GET /api/plans`). */
export interface Plan {
  code: string;
  title: string;
  price_minor: number;
  currency: string;
  period_days: number;
  entitlements: Entitlements;
  active: boolean;
  sort: number;
}

/** `usage_monthly` view for the UI progress bar. */
export interface MonthlyUsage {
  month: string;
  coins: number;
}

/** `GET /api/account/entitlements` — plan + limits + this month's usage. */
export interface EntitlementsResponse {
  plan: Plan;
  entitlements: Entitlements;
  usage: MonthlyUsage;
}

/** A mapped stream event (same shape the games receive). */
export interface StreamEvent {
  source: string;
  event_kind: string;
  user: string;
  avatar_url: string;
  action_command: string;
  amount: number;
  raw_name: string;
  /** Frontend-assigned feed key — unique per event instance. */
  fid?: string;
}

/** A raw event fed into the trigger mapper (simulator input shape). */
export interface RawStreamEvent {
  source: string;
  event_kind: string;
  user: string;
  avatar_url: string;
  raw_name: string;
  amount: number;
  /** Item count (gift repeatCount / like batch size); default 1. */
  count?: number;
  /** TikTok-coin value of the event — feeds the earn limit. */
  coins?: number;
  /** Stable TikTok gift id (locale-independent matching). */
  gift_id?: number | null;
  /** Unix ms the event reached the launcher (filled at ingest). */
  ts_ms?: number;
  /** Уровень «команды» (фан-клуба) зрителя; 0 = не в фан-клубе. */
  fan_level?: number;
  /** Модератор чата — байпасит min_level в правилах озвучки. */
  is_moderator?: boolean;
  /** Суперфан/подписчик/топ-гифтер — байпасит min_level. */
  is_superfan?: boolean;
}

/** Reference to a media-library file (Settings.media). */
export interface MediaRef {
  id: string;
}

/** Sound attachment for an alert. */
export interface SoundRef {
  id: string;
  volume?: number;
}

/** Video/GIF/image attachment for an alert. */
export interface MediaPlayRef {
  id: string;
  fit?: string;
  volume?: number;
}

/** On-overlay alert attached to a rule fire. */
export interface AlertSpec {
  /** Template — placeholders {user} {gift} {count} {coins} {action} {label}. */
  text?: string;
  duration_ms?: number;
  sound?: SoundRef | null;
  media?: MediaPlayRef | null;
  position?: 'top' | 'center' | 'bottom' | string;
  style?: 'default' | 'minimal' | 'big' | string;
}

/** TTS voice-over attached to a rule. */
export interface TtsRuleSpec {
  template?: string;
  voice?: string | null;
}

/** Look & layout of the preset cheat-sheet overlay (/overlay/preset). */
export interface OverlayStyle {
  template?: 'cards' | 'list' | 'text' | string;
  accent_color?: string;
  bg_opacity?: number;
  font_scale?: number;
  border?: 'none' | 'thin' | 'glow' | string;
  columns?: number;
  max_rows?: number;
  rotate_ms?: number;
}

/** One segment of a gift spinner wheel. */
export interface SpinnerSegment {
  label: string;
  action: string;
  weight?: number;
  color?: string;
  alert?: AlertSpec | null;
}

/** One row of the preset cheat sheet (preset overlay frame + poster). */
export interface PresetRow {
  gift: string;
  gift_image?: string;
  count: number;
  coins: number;
  label: string;
  image?: string;
}

/** Голосовое правило по уровню команды — карточка «Правила озвучки». */
export interface TtsVoiceRule {
  id: string;
  /** «Обычная озвучка», «VIP-озвучка»… */
  name: string;
  enabled: boolean;
  /** Минимальный уровень команды (fan-club level; 0 = без порога). */
  min_level: number;
  /** Пул голосов (можно и `custom:*`); пусто = голос из настроек. */
  voices: string[];
  /** Модераторов озвучивать без минимального уровня. */
  read_mods: boolean;
  /** Суперфанатов озвучивать без минимального уровня. */
  read_superfans: boolean;
}

/** Звук/фраза на конкретный подарок (карточка «Rose» со скриншота). */
export interface GiftSoundRule {
  id: string;
  enabled: boolean;
  /** Точный TikTok gift id — optional, устойчив к локализации. */
  gift_id?: number | null;
  /** Имя подарка для contains-матча ("Rose"). */
  gift_name: string;
  /** "sound" (файл медиатеки) | "tts" (проговорить шаблон). */
  kind: string;
  media_id?: string | null;
  /** TTS-шаблон: {user} {gift} {count} {coins}. */
  text: string;
  /** Голос для kind="tts" ("" = из настроек; `custom:*` тоже ок). */
  voice: string;
  /** 0..1 — громкость правила. */
  volume: number;
  /** "each" (каждый подарок) | "series" (после серии). */
  mode: string;
}

/** Chat-to-speech configuration (parity spec §6.2). */
export interface TtsSettings {
  enabled: boolean;
  /** "edge" (neural cloud) | "sapi" (system Windows voices). */
  engine: string;
  voice: string;
  rate: number;
  volume: number;
  /** Pitch multiplier around 1.0 (Edge only). */
  pitch: number;
  /** "normal" | "whisper" | "loud" | "cheerful". */
  style: string;
  /** Laughing emoji/«ахах» → cheerful + spoken laughter; CAPS → loud. */
  emotions: boolean;
  /** TikTok usernames (без @) — always read; each may carry its own voice. */
  whitelist: TtsWhitelistUser[];
  /** TikTok usernames (без @) — never read. */
  blacklist: string[];
  /** Read comments only from the whitelist. */
  only_whitelist: boolean;
  /** Whitelisted users skip cooldowns and jump the queue. */
  whitelist_priority: boolean;
  /** Fixed random neural voice per viewer (edge only). */
  voice_per_user: boolean;
  /** "off" | "all" | "prefix" | "gifters". */
  read_comments: string;
  comment_prefix: string;
  gifters_min_coins: number;
  read_gifts: boolean;
  gift_template: string;
  read_nickname: boolean;
  max_chars: number;
  cooldown_ms: number;
  user_cooldown_ms: number;
  queue_max: number;
  blocklist: string[];
  strip_links: boolean;
  strip_emoji: boolean;
  mute_hotkey: string;
  /** "device" | "overlay". */
  output: string;
  /** Правила озвучки по уровню команды (пусто = без гейта). */
  rules: TtsVoiceRule[];
  /** Звуки/фразы на конкретные подарки. */
  gift_sounds: GiftSoundRule[];
  /** API-ключ Google AI Studio — движок "gemini" (нужен VPN). */
  gemini_key: string;
}

/** Whitelisted viewer — always read; `voice` overrides the common voice. */
export interface TtsWhitelistUser {
  /** TikTok username без @. */
  username: string;
  /** Voice id / `custom:*` / SAPI name; null = голос как у всех. */
  voice?: string | null;
}

/** One TTS voice as returned by `tts_voices`. */
export interface TtsVoice {
  /** Value stored in `TtsSettings.voice`. */
  id: string;
  /** Human-readable label for the dropdown. */
  label: string;
  /** "Female" | "Male" | "" (SAPI doesn't report gender). */
  gender: string;
  /** e.g. "ru-RU". */
  locale: string;
  /** Owning engine: "edge" | "sapi" | "piper". */
  engine: string;
  /** Piper only: модель уже на диске. */
  downloaded?: boolean;
  /** Piper only: примерный размер модели, МБ. */
  size_mb?: number;
}

/** Status of the local Piper engine (piper_status command). */
export interface PiperStatus {
  installed: boolean;
  downloaded_voices: number;
}

/** Status of the local RVC voice-conversion server (rvc_status command). */
export interface RvcStatus {
  /** True when tools/rvc-server is running and sees models. */
  running: boolean;
  /** Voice ids usable as `rvc:<name>` in any voice selector. */
  models: string[];
  /** Ошибка инициализации на сервере (если была) — показываем, а не «работает». */
  error?: string;
  /** Последняя ошибка синтеза/проигрывания (квота, VPN, устройство звука). */
  tts_error?: string;
}

/** A named wheel of fortune — rules reference it by name. */
export interface SpinnerPool {
  name: string;
  segments: SpinnerSegment[];
  spin_ms?: number;
}

/** Media-library index row (file at /media/<id>). */
export interface MediaItem {
  id: string;
  name: string;
  kind: 'video' | 'gif' | 'image' | 'audio' | string;
  ext: string;
  size?: number;
  duration_ms?: number | null;
}

/** One trigger rule in a streamer profile. */
export interface TriggerRule {
  id: string;
  source: string;
  event_kind: string;
  /** Match text — or the numeric gift id when match_mode='gift_id'. */
  match_value: string;
  min_amount: number;
  /** Game command (ignored when spinner names a pool). */
  action: string;
  multiplier: number;
  /** Off-switch that keeps the rule in the profile (default true). */
  enabled?: boolean;
  /** Human-readable action label for overlays/posters. */
  label?: string;
  /** Description used by the 'text' overlay template. */
  description?: string;
  /** Action artwork for the preset overlay. */
  image?: MediaRef | null;
  /** 'contains' (default) | 'exact' | 'gift_id'. */
  match_mode?: string;
  /** 'once' (default) | 'per_unit' — N items → N firings. */
  repeat?: string;
  /** Cap on per-unit firings from one event (default 20). */
  max_repeat?: number;
  /** Fire once per every_n collected units (0 = off). */
  every_n?: number;
  cooldown_ms?: number;
  user_cooldown_ms?: number;
  priority?: number;
  /** Paid interrupt — jumps the alert queue. */
  interrupt?: boolean;
  interrupt_preset?: string | null;
  interrupt_duration_ms?: number;
  alert?: AlertSpec | null;
  tts?: TtsRuleSpec | null;
  /** Spinner pool name — replaces action with a weighted segment. */
  spinner?: string | null;
  delay_ms?: number;
  /** Keep evaluating later rules after this one matches. */
  continue_matching?: boolean;
}

/** Full trigger profile for a game. */
export interface TriggerProfile {
  game_slug: string;
  /** Name of the preset last applied to this profile (absent = hand-built). */
  preset?: string;
  /** Overlay look for this profile's cheat-sheet. */
  overlay?: OverlayStyle;
  /** Minimum gap between any two fired actions of this profile. */
  global_cooldown_ms?: number;
  rules: TriggerRule[];
}

/** A named, shareable set of trigger rules — the streamer's preset. */
export interface TriggerPreset {
  name: string;
  /** Game this preset was built for (absent = universal, offered everywhere). */
  game_slug?: string | null;
  description?: string;
  /** Built-ins ship with the launcher and can't be overwritten/deleted. */
  builtin?: boolean;
  /** Overlay look applied to the profile along with the rules. */
  overlay?: OverlayStyle;
  global_cooldown_ms?: number;
  version?: number;
  rules: TriggerRule[];
}

/** Statusful feed entry — fired AND skipped events (§2.6). */
export interface FeedItem {
  ts: number;
  /** 'done' | 'cooldown' | 'limit' | 'interrupt_cooldown' | 'paused' | 'dropped' */
  status: string;
  event: StreamEvent;
}

/** One accumulator row in the scheduler status (every_n progress). */
export interface AccumulatorView {
  rule_id: string;
  label: string;
  value: number;
  target: number;
}

/** Live scheduler snapshot from get_scheduler_status (§2.6). */
export interface SchedulerStatus {
  queued: number;
  running_alert: string | null;
  dropped: number;
  skipped_cooldown: number;
  skipped_limit: number;
  paused: boolean;
  usage_coins: number;
  takeover: { preset: string; until_ms: number } | null;
  accumulators: AccumulatorView[];
}

/** One row of the bundled TikTok gift catalog (public/gifts.json). */
export interface GiftEntry {
  name: string;
  coins: number;
  image: string;
}

/** Catalog game merged with local install/runtime state. */
export interface LibraryEntry {
  slug: string;
  title: string;
  description: string;
  version: string;
  executable_name: string;
  installed: { version: string; install_dir: string; exe_path: string; sha256?: string | null } | null;
  update_available: boolean;
  running: boolean;
  connected_clients: number;
  /** Free-tier launchable without a subscription (§8.3). */
  is_free?: boolean;
  /** The account's `paid_games` entitlement — UI lock badge only. */
  paid_games_allowed?: boolean;
  /** `"game"` (launcher-spawned) or `"adapter"` (external mod, §10.3). */
  kind?: 'game' | 'adapter';
  /** Adapter manifest JSON blob `{actions:[{id,label,params}]}`. */
  adapter_manifest?: string;
}

/** Parsed `adapter_manifest` — actions the mapper offers as a dropdown. */
export interface AdapterManifest {
  game?: string;
  actions?: { id: string; label?: string; params?: Record<string, unknown> }[];
}

/** `adapter_status` response — key, ws port, connected mod slugs. */
export interface AdapterStatus {
  key: string;
  port: number;
  connected: string[];
}

/** Window-shaping options passed to the game process. */
export interface WindowOptions {
  width: number;
  height: number;
  borderless: boolean;
  always_on_top: boolean;
  chroma_key: boolean;
}

/** Integration status union as serde serializes `IntegrationStatus`. */
export type IntegrationStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'live'
  | { error: string };

/** HTTP-forward runtime counters (Roblox relay). */
export interface ForwardStatus {
  queued: number;
  dropped: number;
  delivered: number;
  last_error: string | null;
  registered_until: string | null;
}

/** Server-side stream state (`GET /api/stream/status`). */
export interface RobloxStreamStatus {
  has_key: boolean;
  /** Roblox account the stream is bound to (first redeem/validate wins). */
  roblox_user_id: number | null;
  claimed_job_id: string | null;
  room: {
    job_id: string;
    roblox_user_id: number | null;
    claimed_at: string;
    last_seen_at: string;
  } | null;
  queued_events: number;
  subscription: Subscription;
}

/** Embedded Roblox bridge (`roblox_bridge.rs`, developer mode). */
export interface RobloxBridgeStatus {
  running: boolean;
  port: number | null;
  /** Value for the game's `Config.RELAY_URL`. */
  url: string | null;
  error: string | null;
  queued: number;
  cursor: number;
  served: number;
  /** Unix ms of the last poll from the place. */
  last_poll_ms: number | null;
  claimed_job_id: string | null;
  bound_user_id: string | null;
}

/** One uploaded build as seen by the admin API. */
export interface AdminBuild {
  id: number;
  version: string;
  sha256: string;
  size_bytes: number;
  changelog: string;
  uploaded_by: string | null;
  created_at: string;
}

/** Game row in the admin panel (includes drafts/archived + all builds). */
export interface AdminGame {
  id: number;
  slug: string;
  title: string;
  description: string;
  executable_name: string;
  cover_image: string;
  status: 'draft' | 'published' | 'archived';
  published_version: string | null;
  updated_at: string | null;
  builds: AdminBuild[];
}

/** Payment ledger row shown under an admin user. */
export interface AdminPayment {
  id: number;
  provider: string;
  external_id: string | null;
  days: number;
  status: string;
  actor_id: number | null;
  created_at: string;
}

/** User row in the admin panel. */
export interface AdminUser {
  id: number;
  email: string;
  role: 'user' | 'admin';
  hwid: string | null;
  created_at: string;
  subscription: Subscription;
  /** Effective tariff code ('free' when the sub is expired). */
  plan_code?: string;
  /** This month's earn-limit usage. */
  usage?: { month: string; coins: number };
  payments: AdminPayment[];
}

/** One admin_audit log entry. */
export interface AuditEntry {
  id: number;
  actor_email: string;
  action: string;
  target: string;
  meta: string;
  created_at: string;
}

/** Boot snapshot returned by `get_bootstrap`. */
/** TikTok account binding state as returned by /api/tiktok/bind. */
export interface TikTokBindStatus {
  bound: boolean;
  username: string | null;
  verified: boolean;
  /** One-shot bio code, present while the binding is unverified. */
  code: string | null;
  code_expires_at: string | null;
  bound_at: string | null;
  verified_at: string | null;
  /** Set for OAuth-verified bindings — TikTok's stable per-app identity. */
  open_id: string | null;
  display_name: string | null;
  avatar_url: string | null;
  /** 'oauth' | null (bio/comment code). */
  auth_method: string | null;
}

export interface Bootstrap {
  authed: boolean;
  email: string | null;
  /** 'user' | 'admin' — shows the admin tab; server never trusts it. */
  role: string | null;
  /** Dev build or admin account — unlocks unreleased cards (Roblox). */
  dev_mode?: boolean;
  hwid: string | null;
  subscription: Subscription | null;
  streamer_mode: boolean;
  window_options: WindowOptions;
  tiktok_username: string | null;
  /** True when a sessionid cookie is stored for authenticated WS connect. */
  has_tiktok_session?: boolean;
  integrations: {
    tiktok: IntegrationStatus;
    tiktok_username: string | null;
    /** Unix seconds of the last sidecar heartbeat/event — staleness signal. */
    tiktok_last_activity?: number | null;
    donationalerts: IntegrationStatus;
  };
  running: string[];
  /** null when the overlay failed to bind — see service_error. */
  overlay_url: string | null;
  /** All overlay page URLs (token already appended), §5.4. */
  overlay_pages?: {
    main: string;
    alerts: string;
    preset: string;
    spinner: string;
    tts: string;
    progress: string;
    leaderboard: string;
    goals: string;
    poll?: string;
    subathon?: string;
    queue?: string;
    hype?: string;
    widgets?: string;
  } | null;
  /** Actual OS-assigned game WS port (0 = service failed to bind). */
  game_ws_port: number;
  /** Startup failure of a local service, if any — shown as a banner. */
  service_error: string | null;
  server_url: string;
  forward: {
    enabled: boolean;
    forward_url: string | null;
    stream_key: string | null;
    has_admin_secret: boolean;
    roblox_place_id: string | null;
    status: ForwardStatus;
  } | null;
}

/** `mc_status` snapshot — managed Paper server (parity spec §9). */
export interface McStatus {
  state: 'not_installed' | 'stopped' | 'starting' | 'running' | 'stopping';
  eula_accepted: boolean;
  installed: boolean;
  paper_version: string;
  mc_version: string;
  ram_mb: number;
  online_mode: boolean;
  player: string;
  rcon_port: number;
  last_error: string | null;
  log_tail: string[];
}

/** `GET /api/mc/plugins` entry — Paper plugin in the catalog (§9.4). */
export interface McPlugin {
  slug: string;
  name: string;
  version: string;
  description: string;
  sha256: string;
  size_bytes: number;
  premium: boolean;
}

/** `mc_plugin_catalog` response — catalog merged with installed jars. */
export interface McPluginCatalog {
  catalog: McPlugin[];
  installed: string[];
  premium_allowed: boolean;
}

/** Stream-level goal definition («Цель стрима») — mirrors `StreamGoal`. */
export interface StreamGoal {
  id: string;
  label: string;
  source: string;
  event_kind: string;
  match_value: string;
  count_coins: boolean;
  target: number;
  action: string;
  celebrate: string;
  enabled: boolean;
}

/** Goal with live counter — `get_goals` / `/goals.json` row. */
export interface GoalProgress {
  id: string;
  label: string;
  value: number;
  target: number;
  done: boolean;
  enabled: boolean;
}

/** Chat poll config — sent to `poll_start` (not persisted). */
export interface PollConfig {
  title: string;
  options: string[];
  duration_s: number;
  action: string;
}

/** Live poll state — `poll_status` / `/poll.json`. */
export interface PollStatus {
  running: boolean;
  title: string;
  options: string[];
  counts: number[];
  total: number;
  ends_in_s: number;
  last_winner: string;
}

/** Per-gift override: exact name → flat ±seconds per unit. */
export interface GiftTimeRule {
  name: string;
  sec: number;
}

/** Timer app config — persisted in settings (`save_subathon_cfg`).
 *  New fields are optional on the wire: Rust fills serde defaults. */
export interface SubathonCfg {
  enabled?: boolean;
  start_s?: number;
  sec_per_coin: number;
  sec_per_sub: number;
  sec_per_follow?: number;
  sec_per_share?: number;
  likes_per_add?: number;
  like_add_s?: number;
  max_s: number;
  gift_rules?: GiftTimeRule[];
  theme?: 'dark' | 'light' | 'neon' | 'minimal' | string;
  accent?: string;
  scale?: number;
  position?: 'center' | 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left' | string;
  show_feed?: boolean;
  sound?: boolean;
}

/** One "+Ns @user" ticker entry. */
export interface TimeAdd {
  user: string;
  sec: number;
  via: string;
}

/** Live subathon state — `subathon_status` / `/subathon.json`. */
export interface SubathonStatus {
  running: boolean;
  paused: boolean;
  remaining_s: number;
  ends_at_ms: number;
  added_s: number;
  last_adds: TimeAdd[];
  cfg: SubathonCfg;
}

/** One viewer in the `!join` queue. */
export interface QueueEntry {
  user: string;
  pos: number;
}

/** `queue_status` / `/queue.json`. */
export interface QueueStatus {
  open: boolean;
  entries: QueueEntry[];
  last_called: string;
}

/** Hype-meter knobs — persisted in settings (`save_hype_cfg`). */
export interface HypeCfg {
  window_s: number;
  target_coins: number;
}

/** Live hype state — `hype_status` / `/hype.json`. */
export interface HypeStatus {
  coins: number;
  level: number;
  target_coins: number;
  window_s: number;
}

/** Timed auto-event («каждые N минут → действие»). */
export interface TimedEvent {
  id: string;
  label: string;
  interval_min: number;
  enabled: boolean;
}

/** Viewer-points earn rates — persisted in settings. */
export interface PointsCfg {
  enabled: boolean;
  per_comment: number;
  comment_cooldown_s: number;
  per_coin: number;
  per_sub: number;
  per_follow: number;
  vip_multiplier: number;
}

/** `!buy` shop item — `kind=shop` event with `raw_name = name`. */
export interface ShopItem {
  id: string;
  name: string;
  price: number;
  hint: string;
  enabled: boolean;
}

/** `points_top` leaderboard row. */
export interface PointsRow {
  user: string;
  points: number;
}

// --- Built-in interactive games (§7–§9) ---------------------------------------

/** Per-game config — `rules` stays free-form JSON (page interprets it). */
export interface BuiltinGameCfg {
  enabled: boolean;
  round_sec: number;
  volume: number;
  antiflood: {
    max_actions_per_sec: number;
    max_per_user_per_min: number;
    queue_cap: number;
  };
  rules: unknown[];
}

export interface BuiltinGameMeta {
  id: string;
  title: string;
  desc: string;
  allowed: boolean;
  cfg: BuiltinGameCfg;
  overlay_path: string;
}

export interface GameSessionInfo {
  game_id: string;
  status: 'running' | 'paused';
  started_at_ms: number;
  paused_total_ms: number;
  pause_began_ms: number;
}

export interface BuiltinGamesView {
  games: BuiltinGameMeta[];
  session: { active: GameSessionInfo | null };
}

export interface GameResult {
  game_id: string;
  ended_at: string;
  duration_s?: number;
  winner?: string;
  score?: unknown;
  top?: { user: string; score: number }[];
  stats?: Record<string, unknown>;
}

// --- EFIR stream timer (efirtimer.rs) -----------------------------------------
export interface EfirSlot {
  id: string; label: string;
  type: string;              // add_time|sub_time|set_time|reset_time|multiply_time|divide_time|freeze|unfreeze|reverse_time|extra_spin|ruiner|save|multiplier|debuff|special|swap_time
  value: number;             // seconds / count / duration
  multiplierValue: number;   // factor for xN effects
  textValue: string;         // free text for "special"
  chance: number;            // weight
  color: string;
  isEnabled: boolean;
  isEliminable: boolean;
  extraSpinRouletteId: string;
  target: string;            // self|opponent|all|random (мульти; у нас все → себе)
}
export interface EfirRoulette {
  id: string; name: string;
  triggerType: string;       // gift | like | both
  triggerGiftIds: string[];
  likesThreshold: number;    // room likes per auto-spin (0 = off)
  addsCost: boolean;         // charge gift coins to the clock first
  isEnabled: boolean;
  worksWhenShielded: boolean;
  mode: string;              // wheel | cards (ход судьбы)
  choiceTimeoutSeconds: number;
  remoteButtonColor: string;
  showInRemote: boolean;
  isMain: boolean;
  donationAmount: string;
  slots: EfirSlot[];
}
export interface EfirPenalty {
  id: string; name: string; giftIds: string[];
  penaltyAmount: number; penaltyThreshold: number;
  isEnabled: boolean; worksWhenShielded: boolean;
}
export interface EfirCustomTrigger {
  id: string; name: string; giftIds: string[];
  type: string;              // add|sub|set|reset
  value: number;
  isEnabled: boolean; worksWhenShielded: boolean;
}
export interface EfirStyles {
  themeId: string;
  roulettePrimary: string; rouletteSecondary: string;
  rouletteSurface: string; rouletteText: string;
  fontFamily: string;
  timerColor: string; timerGlow: number; enableStroke: boolean;
  buffColor: string; debuffColor: string;
  floatPlusColor: string; floatMinusColor: string;
  buffCardBg: string; debuffCardBg: string;
  statsTransparent: boolean;   // статистика без фона
  statsUptimeLabel: string;    // своя подпись аптайма (пусто = стандарт)
  statsLikesLabel: string;     // своя подпись «до рулетки»
}
export interface EfirSoundSpec {
  media: string;             // MediaItem id; "" = синтезированный сигнал
  trimStartMs: number;
  trimEndMs: number;         // 0 = до конца
  volume: number;            // 0..1 per-sound (× глобальная)
}
export type EfirSound = string | EfirSoundSpec;
export interface EfirWalletCmd {
  command: string;           // !cmd
  price: number;             // цена в монетах TikTok
  sound?: EfirSoundSpec;
}
export interface EfirTimerCfg {
  enabled: boolean;
  donationMode: string;      // gifts | balance (кошельки + чат-команды)
  walletCommands: Record<string, EfirWalletCmd>;
  defaultGiftsEnabled: boolean;
  defaultGiftSeconds: number;   // sec per coin for unmatched gifts
  initialTime: number;
  bonusEnabled: boolean; bonusMin: number; bonusMax: number;
  isFreezeEnabled: boolean; giftFreezeIds: string[]; freezeDuration: number;
  giftUnfreezeIds: string[]; unfreezeDuration: number; unfreezeWorksWhenShielded: boolean;
  isReverseEnabled: boolean; giftReverseIds: string[]; reverseWorksWhenShielded: boolean;
  isRuinerEnabled: boolean; giftRuinerIds: string[]; ruinerDuration: number;
  ruinerMinTime: number; ruinerMaxTime: number;
  giftSaveIds: string[]; ruinerWorksWhenShielded: boolean; saveWorksWhenShielded: boolean;
  isMultiplierGiftEnabled: boolean; multiplierValue: number; multiplierDuration: number;
  giftMultiplierIds: string[]; multiplierWorksWhenShielded: boolean;
  isDebuffGiftEnabled: boolean; debuffValue: number; debuffDuration: number;
  giftDebuffIds: string[]; debuffWorksWhenShielded: boolean;
  isSetTimeEnabled: boolean; giftSetTimeIds: string[]; setTimeValue: number; setTimeWorksWhenShielded: boolean;
  isResetEnabled: boolean; giftResetIds: string[]; resetWorksWhenShielded: boolean;
  isPenaltyEnabled: boolean; penalties: EfirPenalty[];
  customTriggers: EfirCustomTrigger[];
  likesEnabled: boolean; likeThreshold: number; likeTime: number; likesWorksWhenShielded: boolean;
  subsEnabled: boolean; subTime: number; subsWorksWhenShielded: boolean;
  roulettes: EfirRoulette[];
  styles: EfirStyles;
  volume: number;
  /** trigger key -> media id или EfirSoundSpec (обрезка+громкость) */
  soundMap: Record<string, EfirSound>;
  uptimeRouletteId: string;
  uptimeStartTime: string;
}
export interface EfirTimerState {
  timeLeft: number; isRunning: boolean; isVictory: boolean;
  isBonusPhase: boolean; isRollingBonus: boolean;
  isFrozen: boolean; freezeTimeLeft: number; isReversed: boolean;
  multiplier: { active: boolean; type: string; value: number; timeLeft: number };
  ruiner: { active: boolean; timeLeft: number; username: string; avatar: string };
  currentTotalLikes: number; startedAt: number; ruinerPending: number;
  wallets?: { user: string; balance: number }[];
}
export interface EfirCardSession {
  id: string; rouletteId: string; rouletteName: string;
  user: { username: string; avatar: string };
  cards: EfirSlot[]; deadline: number; phase: string; index: number | null;
}
export interface EfirTimerStatus { state: EfirTimerState; cfg: EfirTimerCfg; card?: EfirCardSession | null; }