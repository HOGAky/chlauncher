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
  AdminBuild,
  AdminGame,
  AdminUser,
  AuditEntry,
  Bootstrap,
  ForwardStatus,
  LibraryEntry,
  RawStreamEvent,
  StreamEvent,
  Subscription,
  TriggerPreset,
  TriggerProfile,
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

/** Injects a raw event into the mapping pipeline (simulator). */
export const simulateEvent = (raw: RawStreamEvent) => cmd<void>('simulate_event', { raw });

/** Recent mapped events for the feed. */
export const getEventFeed = () => cmd<StreamEvent[]>('get_event_feed');

// ---- settings --------------------------------------------------------------

/** Toggles streamer mode (masks personal data). */
export const setStreamerMode = (enabled: boolean) =>
  cmd<void>('set_streamer_mode', { enabled });

/** Broadcasts a chroma-key toggle to connected games. */
export const setChromaKey = (enabled: boolean) => cmd<void>('set_chroma_key', { enabled });

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
