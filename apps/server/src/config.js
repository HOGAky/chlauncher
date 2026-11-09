/**
 * @file config.js
 * Central runtime configuration for the licensing server.
 *
 * Loads variables from a local `.env` file (if present) using Node's
 * built-in `process.loadEnvFile`, then exposes a normalized config object.
 * Every secret-bearing value has an insecure dev default and MUST be
 * overridden via environment variables in production — see `.env.example`.
 *
 * Production safety: `loadConfig()` is pure — tests can re-derive config
 * from any env map. `validateProductionConfig()` is called at startup and
 * hard-fails on insecure production settings (missing JWT secret, mock
 * billing enabled).
 */

import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path of the apps/server package root. */
export const SERVER_ROOT = path.resolve(__dirname, '..');

/** The JWT secret that must never be used in production. */
export const DEV_JWT_SECRET = 'dev-only-insecure-secret-change-me';

// Try to hydrate process.env from apps/server/.env — silently ignore if absent.
try {
  process.loadEnvFile(path.join(SERVER_ROOT, '.env'));
} catch {
  /* no .env file — rely on real environment */
}

/**
 * Builds a normalized config from an env map (pure — safe to call in tests).
 * @param {Record<string, string|undefined>} [env]
 */
export function loadConfig(env = process.env) {
  const isProduction = env.NODE_ENV === 'production';
  const adminEmailsRaw = (env.ADMIN_EMAILS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (isProduction && adminEmailsRaw.length > 0) {
    // Auto-promotion via env is a privilege-escalation shortcut — forbidden
    // in production. Grant roles via `node tools/grant-admin.mjs <email>`.
    console.warn(
      '[config] WARNING: ADMIN_EMAILS is ignored in production — grant admin ' +
        'roles via tools/grant-admin.mjs instead.'
    );
  }
  const corsOrigins = (env.CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    port: Number(env.SERVER_PORT || 8787),
    host: env.SERVER_HOST || '127.0.0.1',
    isProduction,
    jwtSecret: env.JWT_SECRET || DEV_JWT_SECRET,
    databasePath:
      env.DATABASE_PATH || path.join(SERVER_ROOT, 'data', 'chlauncher.db'),
    staticDir: env.STATIC_DIR || path.join(SERVER_ROOT, 'static'),
    /**
     * Emails that receive role='admin' on every register/login (§1.1).
     * Empty in production regardless of env — see warning above.
     */
    adminEmails: new Set(isProduction ? [] : adminEmailsRaw),
    /**
     * CORS whitelist. Requests whose Origin is not listed get no CORS
     * headers at all. Dev default covers the Vite/Tauri webviews.
     */
    corsOrigins:
      corsOrigins.length > 0
        ? corsOrigins
        : isProduction
          ? []
          : [
              'http://localhost:1420',
              'http://127.0.0.1:1420',
              'http://tauri.localhost',
              'https://tauri.localhost',
            ],
    /** Upload cap for admin build POSTs (§3). Default: 2 GiB. */
    maxBuildSize: Number(env.MAX_BUILD_SIZE || 2 * 1024 * 1024 * 1024),
    /**
     * Trust X-Forwarded-For / CF-Connecting-IP for client IPs. Enable ONLY
     * behind a reverse proxy / Cloudflare (rate-limit, webhook IP checks).
     */
    trustProxy: env.TRUST_PROXY === 'true',
    /** mock-pay/mock-expire routes only exist when this is true (§5.5). */
    enableMockBilling:
      env.ENABLE_MOCK_BILLING === '1' || !isProduction,
    /** YooKassa provider credentials (§5.3) — empty when not configured. */
    yookassaShopId: env.YOOKASSA_SHOP_ID || '',
    yookassaSecretKey: env.YOOKASSA_SECRET_KEY || '',
    /** Stripe signing secret — reserved for the v1.1 provider. */
    stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET || '',
    /** Escape hatch for dev/tunnels: trust webhook sources other than the
     *  official YooKassa subnets (Basic-auth check still applies). */
    webhookSkipIpCheck: env.BILLING_WEBHOOK_SKIP_IP_CHECK === '1',
    /**
     * HMAC key for hashing stored HWIDs/IPs — required in production (T5).
     * In dev/test it is derived from the JWT secret so behaviour stays
     * deterministic without another env var. Rotating the secret invalidates
     * all stored bindings (users must re-login/rebind).
     */
    hwidHashSecret:
      env.HWID_HASH_SECRET ||
      (isProduction
        ? ''
        : crypto
            .createHash('sha256')
            .update(`chlauncher-dev-hwid:${env.JWT_SECRET || DEV_JWT_SECRET}`)
            .digest('hex')),
    /**
     * EulerStream signing API — server-side key for the /api/tiktok-sign
     * proxy. When set, subscribed launchers sign TikTok webcast requests
     * through OUR backend and the paid key never ships in the client.
     * Empty → proxy answers 503 and sidecars fall back to the free tier.
     */
    eulerApiKey: env.EULERSTREAM_API_KEY || '',
    /** Upstream base URL the sign proxy forwards to (test-overridable). */
    eulerBaseUrl: (env.EULERSTREAM_BASE_URL || 'https://api.eulerstream.com')
      .replace(/\/+$/, ''),
    /** Per-user proxy rate cap — a connect burst is ~5 calls. */
    tiktokSignMaxPerMin: Number(env.TIKTOK_SIGN_MAX_PER_MIN || 120),
  };
}

/**
 * Hard startup checks. In production the server MUST refuse to boot on an
 * insecure configuration — silent insecure defaults are how tokens get
 * forged and test endpoints leak into prod.
 * @param {ReturnType<typeof loadConfig>} cfg
 */
export function validateProductionConfig(cfg) {
  if (!cfg.isProduction) return;
  if (!cfg.jwtSecret || cfg.jwtSecret === DEV_JWT_SECRET) {
    throw new Error(
      '[config] FATAL: NODE_ENV=production requires a real JWT_SECRET ' +
        '(generate e.g. `openssl rand -hex 64`). Refusing to start.'
    );
  }
  if (cfg.enableMockBilling) {
    throw new Error(
      '[config] FATAL: ENABLE_MOCK_BILLING=1 is forbidden in production — ' +
        'mock billing grants free subscriptions. Refusing to start.'
    );
  }
  if (!cfg.hwidHashSecret) {
    throw new Error(
      '[config] FATAL: NODE_ENV=production requires HWID_HASH_SECRET ' +
        '(generate e.g. `openssl rand -hex 32`) — HWIDs are stored ' +
        'HMAC-hashed and need a stable key. Refusing to start.'
    );
  }
}

/**
 * Normalized server configuration.
 * @type {ReturnType<typeof loadConfig>}
 */
export const config = loadConfig();
validateProductionConfig(config);

if (config.jwtSecret === DEV_JWT_SECRET) {
  console.warn(
    '[config] WARNING: using the built-in development JWT secret. Set JWT_SECRET before deploying.'
  );
}

if (config.enableMockBilling) {
  console.warn(
    '[config] WARNING: mock billing endpoints are ENABLED — mock-pay grants free ' +
      'subscriptions to any account. Deploy with NODE_ENV=production (and without ' +
      'ENABLE_MOCK_BILLING) to disable them.'
  );
}
