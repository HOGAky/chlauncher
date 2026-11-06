/**
 * @file api.ts
 * Typed wrapper over the Tauri IPC surface (`src-tauri/src/commands.rs`).
 * Every function maps 1:1 to a `#[tauri::command]`; errors arrive as
 * human-presentable strings (server codes like `SUBSCRIPTION_REQUIRED`).
 */
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type {
  Bootstrap,
  ForwardStatus,
  LibraryEntry,
  RawStreamEvent,
  StreamEvent,
  Subscription,
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
