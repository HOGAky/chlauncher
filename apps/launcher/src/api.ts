/**
 * @file api.ts
 * Typed wrapper over the Tauri IPC surface (`src-tauri/src/commands.rs`).
 * Every function maps 1:1 to a `#[tauri::command]`; errors arrive as
 * human-presentable strings (server codes like `SUBSCRIPTION_REQUIRED`).
 */
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { onOpenUrl, getCurrent } from '@tauri-apps/plugin-deep-link';
import { openUrl } from '@tauri-apps/plugin-opener';
import type {
  MediaItem,
  AdminBuild,
  AdminGame,
  AdminUser,
  AuditEntry,
  Bootstrap,
  FeedItem,
  ForwardStatus,
  LibraryEntry,
  RawStreamEvent,
  SchedulerStatus,
  SpinnerPool,
  StreamEvent,
  Subscription,
  TriggerPreset,
  TriggerProfile,
  TtsSettings,
  WindowOptions,
} from './types';

/** Generic invoke helper. */
async function cmd<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(name, args);
}

// ---- session ---------------------------------------------------------------

/** Fetches the boot snapshot (auth, integrations, options). */
export const getBootstrap = () => cmd<Bootstrap>('get_bootstrap');

/** Registers a new account. */
export const registerAccount = (email: string, password: string) =>
  cmd<{ user: unknown; subscription: Subscription }>('register_account', {
    email,
    password,
  });

/** Logs into an existing account (enforces HWID). */
export const login = (email: string, password: string) =>
  cmd<{ user: unknown; subscription: Subscription }>('login', { email, password });

/** Clears the stored session. */
export const logout = () => cmd<void>('logout');

// ---- billing ---------------------------------------------------------------

/** Fresh subscription status. */
export const getSubscription = () => cmd<Subscription>('get_subscription');

/**
 * Real billing: creates a pending payment and opens the provider's hosted
 * checkout page in the system browser. After paying, YooKassa redirects to
 * `chlauncher://billing/return` (the deep-link plugin reopens this app and
 * `onBillingReturn` fires → the UI re-reads the subscription).
 */
export const checkout = async (): Promise<void> => {
  const r = await cmd<{ payment_id: string; checkout_url: string | null }>(
    'billing_checkout'
  );
  if (!r.checkout_url) throw new Error('NO_CHECKOUT_URL');
  await openUrl(r.checkout_url);
};

/** Fires when the OS delivers a `chlauncher://…` deep link to this app. */
export const onBillingReturn = (cb: () => void): Promise<UnlistenFn> =>
  onOpenUrl((urls) => {
    if (urls.some((u) => u.startsWith('chlauncher://billing'))) cb();
  });

/** Deep links that launched the app cold (e.g. click while closed). */
export const getColdBillingReturn = async (): Promise<boolean> => {
  const urls = await getCurrent().catch(() => null);
  return !!urls?.some((u) => u.startsWith('chlauncher://billing'));
};

/** TEST: pays for 30 days. */
export const mockPay = () => cmd<Subscription>('mock_pay');

/** TEST: forces subscription expiry. */
export const mockExpire = () => cmd<Subscription>('mock_expire');

// ---- library ---------------------------------------------------------------

/** Merged catalog + installed + running view. */
export const listGames = () => cmd<{ games: LibraryEntry[] }>('list_games');

/** Downloads + extracts a game. */
export const downloadGame = (slug: string) =>
  cmd<{ installed: unknown }>('download_game', { slug });

/** Launches a game behind the license gate. */
export const playGame = (slug: string, windowOptions?: WindowOptions) =>
  cmd<{ launched: string }>('play_game', { slug, windowOptions });

/** Force-closes a running game. */
export const killGame = (slug: string) => cmd<void>('kill_game', { slug });

// ---- integrations ----------------------------------------------------------

/** Connect TikTok presence polling for a username. */
export const tiktokConnect = (username: string) =>
  cmd<void>('tiktok_connect', { username });

/** Disconnect TikTok. */
export const tiktokDisconnect = () => cmd<void>('tiktok_disconnect');

/** Reconnect TikTok to the saved username («Обновить связь»). */
export const tiktokReconnect = () => cmd<void>('tiktok_reconnect');

/** Lightweight status snapshot (statuses + last activity) for UI polling. */
export const getIntegrationStatus = () =>
  cmd<Bootstrap['integrations']>('get_integration_status');

/** Connect DonationAlerts with an OAuth token. */
export const daConnect = (token: string) => cmd<void>('da_connect', { tokenInput: token });

/** Disconnect DonationAlerts. */
export const daDisconnect = () => cmd<void>('da_disconnect');

// ---- mapper & simulator ----------------------------------------------------

/** Loads (or seeds) the trigger profile for a game. */
export const getTriggers = (gameSlug: string) =>
  cmd<TriggerProfile>('get_triggers', { gameSlug });

/** Persists an edited trigger profile. */
export const saveTriggers = (profile: TriggerProfile) =>
  cmd<void>('save_triggers', { profile });

/** Which slug's profile currently maps live events (null = "default"). */
export const getActiveTriggerProfile = () =>
  cmd<string | null>('get_active_trigger_profile');

/** Selects which profile maps live events — the "activate for stream" control. */
export const setActiveTriggerProfile = (slug: string) =>
  cmd<void>('set_active_trigger_profile', { slug });

/** Applies a named preset (e.g. 'steal-the-stream') to a game's profile. */
export const applyTriggerTemplate = (gameSlug: string, template: string) =>
  cmd<TriggerProfile>('apply_trigger_template', { gameSlug, template });

/** Applies a named preset (built-in or custom) to a game's profile. */
export const applyTriggerPreset = (gameSlug: string, preset: string) =>
  cmd<TriggerProfile>('apply_trigger_preset', { gameSlug, preset });

/** Lists built-in and streamer-defined trigger presets. */
export const listTriggerPresets = () => cmd<TriggerPreset[]>('list_trigger_presets');

/** Saves a streamer-defined preset (built-in names are reserved). */
export const saveTriggerPreset = (preset: TriggerPreset) =>
  cmd<TriggerPreset>('save_trigger_preset', { preset });

/** Deletes a streamer-defined preset. */
export const deleteTriggerPreset = (name: string) =>
  cmd<void>('delete_trigger_preset', { name });

/** Exports a preset (built-in or custom) as portable JSON for sharing. */
export const exportTriggerPreset = (name: string) =>
  cmd<string>('export_trigger_preset', { name });

/** Imports an exported preset; renames on collision. Returns the stored preset. */
export const importTriggerPreset = (jsonStr: string) =>
  cmd<TriggerPreset>('import_trigger_preset', { jsonStr });

/** Injects a raw event into the mapping pipeline (simulator). */
export const simulateEvent = (raw: RawStreamEvent) => cmd<void>('simulate_event', { raw });

/** Recent mapped events for the feed. */
export const getEventFeed = () => cmd<StreamEvent[]>('get_event_feed');

/** Statusful feed — fired and skipped events, newest first (§2.6). */
export const getEventFeedItems = () => cmd<FeedItem[]>('get_event_feed_items');

/** Global scheduler pause («перерыв»): actions stop, events keep queueing. */
export const schedulerPause = (paused: boolean) => cmd<void>('scheduler_pause', { paused });

/** Live scheduler snapshot — queued/dropped/skipped/accumulators. */
export const getSchedulerStatus = () => cmd<SchedulerStatus>('get_scheduler_status');

/** Clears every_n accumulators («Сбросить счётчики»). */
export const schedulerResetCounters = () => cmd<void>('scheduler_reset_counters');

/** Runs one rule through the pipeline bypassing cooldowns/limit — the ▶ button. */
export const testRule = (gameSlug: string, ruleId: string) =>
  cmd<void>('test_rule', { gameSlug, ruleId });

/** Spinner pools for the 🎡 pool picker in the mapper. */
export const listSpinners = () => cmd<SpinnerPool[]>('list_spinners');
export const saveSpinner = (pool: SpinnerPool) =>
  cmd<void>('save_spinner', { pool });
/** Refused while rules reference the pool (error lists them). */
export const deleteSpinner = (name: string) =>
  cmd<void>('delete_spinner', { name });

// ---- settings --------------------------------------------------------------

/** Toggles streamer mode (masks personal data). */
export const setStreamerMode = (enabled: boolean) =>
  cmd<void>('set_streamer_mode', { enabled });

/** Broadcasts a chroma-key toggle to connected games. */
export const setChromaKey = (enabled: boolean) => cmd<void>('set_chroma_key', { enabled });

/** Pins the overlay port (0 = OS-assigned); applies on next launch. */
export const setOverlayPort = (port: number) => cmd<void>('set_overlay_port', { port });

/** Rotates the overlay token — all copied Browser Source URLs expire. */
export const rotateOverlayToken = () => cmd<void>('rotate_overlay_token');

/** Alert playback settings for the mapper status bar (§3.1–§3.2). */
export const getAlertsSettings = () =>
  cmd<{
    enabled: boolean;
    default_for_gifts_from_coins: number;
    default_duration_ms: number;
    volume: number;
  }>('get_alerts_settings');

/** Media-library items (files served at /media/<id>). */
export const mediaList = () => cmd<MediaItem[]>('media_list');

/** Copies a picked file into the media library (sniffed + capped). */
export const mediaImport = (path: string) => cmd<MediaItem>('media_import', { path });

/** Deletes an item — fails while rules still reference it. */
export const mediaDelete = (id: string) => cmd<void>('media_delete', { id });

/** Renames an item (display name). */
export const mediaRename = (id: string, name: string) =>
  cmd<void>('media_rename', { id, name });

/** Persists alert settings; the master switch applies live. */
/** TTS settings block (§6.2). */
export const getTtsSettings = () => cmd<TtsSettings>('get_tts_settings');
export const setTtsSettings = (tts: TtsSettings) =>
  cmd<void>('set_tts_settings', { tts });
/** Installed SAPI voice names. */
export const ttsVoices = () => cmd<string[]>('tts_voices');
/** Speaks a test phrase (bypasses read_* modes, obeys mute). */
export const ttsSay = (text: string, voice?: string) =>
  cmd<void>('tts_say', { text, voice: voice ?? null });
/** Mute/unmute — drains the speech queue instantly (§6.3). */
export const ttsSetMuted = (muted: boolean) => cmd<void>('tts_set_muted', { muted });
export const getTtsMuted = () => cmd<boolean>('get_tts_muted');
/** Fired by the global mute hotkey and the mute button. */
export const onTtsMuted = (cb: (muted: boolean) => void): Promise<UnlistenFn> =>
  listen<boolean>('tts-muted', (e) => cb(e.payload));

export const setAlertsSettings = (
  enabled: boolean,
  defaultForGiftsFromCoins: number,
  defaultDurationMs: number,
  volume: number
) =>
  cmd<void>('set_alerts_settings', {
    enabled,
    defaultForGiftsFromCoins,
    defaultDurationMs,
    volume,
  });

/** Backend base URL currently in use. */
export const getServerUrl = () => cmd<string>('get_server_url');

/** Points the launcher at another backend (persisted). */
export const setServerUrl = (url: string) => cmd<void>('set_server_url', { url });

// ---- cloud forward (Roblox relay) -------------------------------------------

/** Saves forward config; enabling also registers the key on the relay. */
export const setForwardConfig = (
  enabled: boolean,
  forwardUrl: string,
  relayAdminSecret: string
) =>
  cmd<void>('set_forward_config', {
    enabled,
    forwardUrl,
    relayAdminSecret,
  });

/** Rotates the stream key (re-registers when forwarding is on). */
export const regenerateStreamKey = () => cmd<string>('regenerate_stream_key');

/** Forwarder counters for the UI. */
export const getForwardStatus = () => cmd<ForwardStatus>('get_forward_status');

/** Sanitized diagnostics report text (no secrets) — for bug reports. */
export const getDiagnostics = () => cmd<string>('get_diagnostics');

/**
 * Self-update check: `null` when up to date. When an update is found it is
 * installed and the app relaunches, so a resolving promise means "no
 * update". Best-effort — callers should swallow failures.
 */
export const checkLauncherUpdate = () => cmd<string | null>('check_launcher_update');

// ---- events ----------------------------------------------------------------

/** Subscribes to mapped stream events pushed to the UI feed. */
export const onStreamEvent = (cb: (ev: StreamEvent) => void): Promise<UnlistenFn> =>
  listen<StreamEvent>('stream-event', (e) => cb(e.payload));

/** Subscribes to integration status changes. */
export const onIntegrationStatus = (
  cb: (p: { integration: string; status: unknown }) => void
): Promise<UnlistenFn> =>
  listen<{ integration: string; status: unknown }>('integration-status', (e) => cb(e.payload));

/** Subscribes to game process exits. */
export const onGameExited = (cb: (slug: string) => void): Promise<UnlistenFn> =>
  listen<{ slug: string }>('game-exited', (e) => cb(e.payload.slug));

/** Catalog snapshot changed on the backend — refresh the library badge. */
export const onCatalogChanged = (cb: () => void): Promise<UnlistenFn> =>
  listen('catalog-changed', () => cb());

// ---------------------------------------------------------------------------
// Admin API — thin wrappers; the server enforces role=admin (403 otherwise).
// ---------------------------------------------------------------------------

export const adminListGames = () => cmd<{ games: AdminGame[] }>('admin_list_games');
export const adminCreateGame = (
  slug: string,
  title: string,
  description: string,
  executable_name: string
) =>
  cmd<{ game: AdminGame }>('admin_create_game', {
    slug, title, description, executableName: executable_name,
  });
export const adminUpdateGame = (slug: string, patch: Record<string, string>) =>
  cmd<{ game: AdminGame }>('admin_update_game', { slug, patch });
export const adminUploadBuild = (
  slug: string,
  version: string,
  changelog: string,
  path: string
) => cmd<{ build: AdminBuild }>('admin_upload_build', { slug, version, changelog, path });
export const adminPublish = (slug: string, version: string) =>
  cmd<{ game: AdminGame }>('admin_publish', { slug, version });
export const adminUnpublish = (slug: string) =>
  cmd<{ game: AdminGame }>('admin_unpublish', { slug });
export const adminRollback = (slug: string) =>
  cmd<{ game: AdminGame }>('admin_rollback', { slug });
export const adminListUsers = (query: string) =>
  cmd<{ users: AdminUser[] }>('admin_list_users', { query });
export const adminGrantDays = (userId: number, days: number, comment: string) =>
  cmd<{ ok: boolean; subscription: Subscription }>('admin_grant_days', {
    userId, days, comment,
  });
export const adminResetHwid = (userId: number) =>
  cmd<{ ok: boolean }>('admin_reset_hwid', { userId });
export const adminAudit = () => cmd<{ entries: AuditEntry[] }>('admin_audit');

/** Upload progress events emitted by adminUploadBuild. */
export const onBuildUploadProgress = (
  cb: (p: { slug: string; sent: number; total: number }) => void
): Promise<UnlistenFn> =>
  listen<{ slug: string; sent: number; total: number }>('build-upload-progress', (e) =>
    cb(e.payload)
  );
