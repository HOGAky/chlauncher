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
}

/** A raw event fed into the trigger mapper (simulator input shape). */
export interface RawStreamEvent {
  source: string;
  event_kind: string;
  user: string;
  avatar_url: string;
  raw_name: string;
  amount: number;
}

/** One trigger rule in a streamer profile. */
export interface TriggerRule {
  id: string;
  source: string;
  event_kind: string;
  match_value: string;
  min_amount: number;
  action: string;
  multiplier: number;
}

/** Full trigger profile for a game. */
export interface TriggerProfile {
  game_slug: string;
  rules: TriggerRule[];
}

/** Catalog game merged with local install/runtime state. */
export interface LibraryEntry {
  slug: string;
  title: string;
  description: string;
  version: string;
  executable_name: string;
  installed: { version: string; install_dir: string; exe_path: string } | null;
  update_available: boolean;
  running: boolean;
  connected_clients: number;
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

/** Boot snapshot returned by `get_bootstrap`. */
export interface Bootstrap {
  authed: boolean;
  email: string | null;
  hwid: string;
  subscription: Subscription | null;
  streamer_mode: boolean;
  window_options: WindowOptions;
  tiktok_username: string | null;
  integrations: {
    tiktok: IntegrationStatus;
    tiktok_username: string | null;
    donationalerts: IntegrationStatus;
  };
  running: string[];
  overlay_url: string;
  game_ws_port: number;
}
