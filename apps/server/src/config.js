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

/** Parses an env JSON value, falling back on malformed input. */
function safeJson(raw, fallback) {
  try {
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
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
  // Relative paths are anchored to the server package root — never to the
  // process cwd (systemd units often run with an unexpected cwd).
  const resolvePath = (p, fallback) =>
    path.resolve(SERVER_ROOT, p || fallback);
  const trustedCidrs = (env.TRUSTED_PROXY_CIDRS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    port: Number(env.SERVER_PORT || 8787),
    host: env.SERVER_HOST || '127.0.0.1',
    isProduction,
    jwtSecret: env.JWT_SECRET || DEV_JWT_SECRET,
    databasePath: resolvePath(env.DATABASE_PATH, 'data/chlauncher.db'),
    staticDir: resolvePath(env.STATIC_DIR, 'static'),
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
    /** P0.7 zip-bomb guards for uploaded game builds. */
    maxZipEntries: Number(env.MAX_ZIP_ENTRIES || 20000),
    maxZipExpandedBytes: Number(env.MAX_ZIP_EXPANDED_BYTES || 4 * 1024 * 1024 * 1024),
    maxZipFileBytes: Number(env.MAX_ZIP_FILE_BYTES || 2 * 1024 * 1024 * 1024),
    maxZipRatio: Number(env.MAX_ZIP_RATIO || 200),
    /**
     * Trust X-Forwarded-For / CF-Connecting-IP for client IPs. Enable ONLY
     * behind a reverse proxy / Cloudflare (rate-limit, webhook IP checks).
     * `true` alone would trust forwarded headers from ANY client — instead
     * we pass Fastify an allowlist of proxy hops: loopback always (local
     * nginx/Caddy) plus every CIDR in TRUSTED_PROXY_CIDRS.
     */
    trustProxy:
      env.TRUST_PROXY === 'true'
        ? ['127.0.0.1', '::1', ...trustedCidrs]
        : false,
    trustedProxyCidrs: trustedCidrs,
    /**
     * Escape hatch for deployments that intentionally bind the API on a
     * public interface without a proxy (NOT recommended). Production
     * refuses 0.0.0.0/:: binds unless this is set — see vps-deploy.md.
     */
    allowPublicBind: env.ALLOW_PUBLIC_BIND === '1',
    /** mock-pay/mock-expire routes only exist when this is true (§5.5). */
    enableMockBilling:
      env.ENABLE_MOCK_BILLING === '1' || !isProduction,
    /** YooKassa provider credentials (§5.3) — empty when not configured. */
    yookassaShopId: env.YOOKASSA_SHOP_ID || '',
    yookassaSecretKey: env.YOOKASSA_SECRET_KEY || '',
    /** Stripe signing secret — reserved for the v1.1 provider. */
    stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET || '',
    /**
     * Tribute (Telegram) provider. `TRIBUTE_API_KEY` signs webhook
     * payloads (`trbt-signature` = HMAC-SHA256 of the raw body) and
     * authorises api.tribute.tg calls. `TRIBUTE_BOT_URL` is the deep-link
     * base of our bind-bot (`https://t.me/<bot>?start=`); a generated
     * code is appended to it. `TRIBUTE_PRODUCT_LINKS` maps plan_code →
     * the Tribute payment link shown after binding; `TRIBUTE_PLAN_MAP`
     * maps Tribute `subscription_id` → our plan_code for webhooks.
     * `TG_BIND_SECRET` authenticates the bind-bot on POST /api/tg/bind.
     */
    tributeApiKey: env.TRIBUTE_API_KEY || '',
    tributeBotUrl: env.TRIBUTE_BOT_URL || '',
    /**
     * Deep-link base of the bot used for "sign in with Telegram" / QR
     * (`https://t.me/<bot>?start=`). Same bot as billing in practice —
     * falls back to TRIBUTE_BOT_URL so login doesn't depend on billing
     * naming.
     */
    tgBotUrl: env.TG_BOT_URL || env.TRIBUTE_BOT_URL || '',
    /**
     * Owner Telegram ids (comma-separated). Accounts bound to these ids
     * are the only ones allowed to grant subscriptions, switch plans,
     * assign roles and mint promo codes. Configurable only via env on
     * the server — never through the admin UI or the DB. Empty → legacy
     * behaviour (every admin may grant) with a startup warning.
     */
    ownerTgIds: new Set(
      (env.OWNER_TG_IDS || '')
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isInteger(n) && n > 0)
    ),
    tributeProductLinks: safeJson(env.TRIBUTE_PRODUCT_LINKS, {}),
    tributePlanMap: safeJson(env.TRIBUTE_PLAN_MAP, {}),
    tgBindSecret: env.TG_BIND_SECRET || '',
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
    /**
     * Public base URL of this API — used to derive the TikTok OAuth
     * redirect URI and shown in docs. Must be the https origin nginx
     * exposes (e.g. https://api.example.com), NOT the bind address.
     */
    publicBaseUrl: (
      env.PUBLIC_BASE_URL || `http://127.0.0.1:${env.SERVER_PORT || 8787}`
    ).replace(/\/+$/, ''),
    /**
     * TikTok Login Kit OAuth. Credentials come from
     * developers.tiktok.com → your app → Login Kit. `TIKTOK_REDIRECT_URI`
     * must match the URI registered in the TikTok app EXACTLY; when empty
     * it derives as `${PUBLIC_BASE_URL}/api/tiktok/oauth/callback`.
     * Empty client_key → OAuth endpoints answer 501 and the UI falls back
     * to the bio/comment code flow.
     */
    tiktokClientKey: env.TIKTOK_CLIENT_KEY || '',
    tiktokClientSecret: env.TIKTOK_CLIENT_SECRET || '',
    tiktokRedirectUri: env.TIKTOK_REDIRECT_URI || '',
    /**
     * Official Roblox place id of the published «Steal the Stream»
     * experience — advertised to launchers in /api/stream responses so
     * «Играть» needs no manual Place ID once the game is published.
     * A streamer-entered id in launcher settings still overrides it.
     */
    robloxPlaceId: (env.ROBLOX_PLACE_ID || '').replace(/\D/g, ''),
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
  // P0.3: fail-closed ownership. Without OWNER_TG_IDS the legacy rule lets
  // ANY admin grant subscriptions/roles/mint promos — unacceptable in prod.
  if (cfg.ownerTgIds.size === 0) {
    throw new Error(
      '[config] FATAL: NODE_ENV=production requires OWNER_TG_IDS ' +
        '(comma-separated Telegram ids of the owner accounts — the bind-bot ' +
        'answers /whoami with yours). Bootstrap via tools/grant-admin.mjs + ' +
        'tg bind, see docs/operations.md. Refusing to start.'
    );
  }
  // P0.8: webhook IP-bypass is a test-only flag — enabling it in prod lets
  // anyone forge provider notifications and mint subscriptions.
  if (cfg.webhookSkipIpCheck) {
    throw new Error(
      '[config] FATAL: BILLING_WEBHOOK_SKIP_IP_CHECK=1 is forbidden in ' +
        'production — it disables the YooKassa source-IP check. Refusing to start.'
    );
  }
  // P0.8: the API must sit behind the proxy, not on a public interface.
  // Binding 0.0.0.0/:: in prod exposes it around Cloudflare/firewall rules.
  const publicBind = cfg.host === '0.0.0.0' || cfg.host === '::' || cfg.host === '';
  if (publicBind && !cfg.allowPublicBind) {
    throw new Error(
      '[config] FATAL: SERVER_HOST binds a public interface in production. ' +
        'Bind 127.0.0.1 and put nginx/Cloudflare Tunnel in front; if a public ' +
        'bind is really intended, set ALLOW_PUBLIC_BIND=1 explicitly. ' +
        'Refusing to start.'
    );
  }
  // P0.8: OAuth/payment callbacks demand a real HTTPS public URL.
  if (!/^https:\/\//.test(cfg.publicBaseUrl)) {
    throw new Error(
      '[config] FATAL: PUBLIC_BASE_URL must be the https origin nginx ' +
        'exposes (e.g. https://api.example.com) in production — OAuth and ' +
        'payment callbacks are derived from it. Refusing to start.'
    );
  }
  if (!cfg.trustProxy) {
    console.warn(
      '[config] WARNING: TRUST_PROXY is off in production — client IPs are ' +
        'the proxy address, which breaks per-IP rate limits and the ' +
        'YooKassa webhook subnet check. Set TRUST_PROXY=true and ' +
        'TRUSTED_PROXY_CIDRS=<proxy CIDRs> if a proxy fronts this API.'
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

if (config.ownerTgIds.size === 0) {
  console.warn(
    '[config] WARNING: OWNER_TG_IDS is empty — every admin may grant ' +
      'subscriptions/plans/roles. Set OWNER_TG_IDS=<your telegram id> ' +
      '(bot command /whoami shows it).'
  );
}

if (config.enableMockBilling) {
  console.warn(
    '[config] WARNING: mock billing endpoints are ENABLED — mock-pay grants free ' +
      'subscriptions to any account. Deploy with NODE_ENV=production (and without ' +
      'ENABLE_MOCK_BILLING) to disable them.'
  );
}
