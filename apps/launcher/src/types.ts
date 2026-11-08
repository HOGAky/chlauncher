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
  installed: { version: string; install_dir: string; exe_path: string; sha256?: string | null } | null;
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

/** HTTP-forward runtime counters (Roblox relay). */
export interface ForwardStatus {
  queued: number;
  dropped: number;
  delivered: number;
  last_error: string | null;
  registered_until: string | null;
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
export interface Bootstrap {
  authed: boolean;
  email: string | null;
  /** 'user' | 'admin' — shows the admin tab; server never trusts it. */
  role: string | null;
  hwid: string | null;
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
  /** null when the overlay failed to bind — see service_error. */
  overlay_url: string | null;
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
    status: ForwardStatus;
  } | null;
}
