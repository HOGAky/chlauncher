/**
 * @file config.js
 * Central runtime configuration for the licensing server.
 *
 * Loads variables from a local `.env` file (if present) using Node's
 * built-in `process.loadEnvFile`, then exposes a normalized config object.
 * Every secret-bearing value has an insecure dev default and MUST be
 * overridden via environment variables in production — see `.env.example`.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path of the apps/server package root. */
export const SERVER_ROOT = path.resolve(__dirname, '..');

// Try to hydrate process.env from apps/server/.env — silently ignore if absent.
try {
  process.loadEnvFile(path.join(SERVER_ROOT, '.env'));
} catch {
  /* no .env file — rely on real environment */
}

/**
 * Normalized server configuration.
 * @type {{port: number, host: string, jwtSecret: string, databasePath: string, staticDir: string,
 *         adminEmails: Set<string>, maxBuildSize: number, enableMockBilling: boolean}}
 */
export const config = {
  port: Number(process.env.SERVER_PORT || 8787),
  host: process.env.SERVER_HOST || '127.0.0.1',
  jwtSecret: process.env.JWT_SECRET || 'dev-only-insecure-secret-change-me',
  databasePath:
    process.env.DATABASE_PATH || path.join(SERVER_ROOT, 'data', 'chlauncher.db'),
  staticDir: path.join(SERVER_ROOT, 'static'),
  /** Emails that receive role='admin' on every register/login (§1.1). */
  adminEmails: new Set(
    (process.env.ADMIN_EMAILS || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  ),
  /** Upload cap for admin build POSTs (§3). Default: 2 GiB. */
  maxBuildSize: Number(
    process.env.MAX_BUILD_SIZE || 2 * 1024 * 1024 * 1024
  ),
  /** mock-pay/mock-expire routes only exist when this is true (§5.5). */
  enableMockBilling:
    process.env.ENABLE_MOCK_BILLING === '1' ||
    process.env.NODE_ENV !== 'production',
  /** YooKassa provider credentials (§5.3) — empty when not configured. */
  yookassaShopId: process.env.YOOKASSA_SHOP_ID || '',
  yookassaSecretKey: process.env.YOOKASSA_SECRET_KEY || '',
  /** Stripe signing secret — reserved for the v1.1 provider. */
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
  /** Escape hatch for dev/tunnels: trust webhook sources other than the
   *  official YooKassa subnets (Basic-auth check still applies). */
  webhookSkipIpCheck: process.env.BILLING_WEBHOOK_SKIP_IP_CHECK === '1',
};

if (config.jwtSecret === 'dev-only-insecure-secret-change-me') {
  console.warn(
    '[config] WARNING: using the built-in development JWT secret. Set JWT_SECRET before deploying.'
  );
}
