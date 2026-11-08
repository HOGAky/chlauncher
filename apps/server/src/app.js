/**
 * @file app.js
 * Fastify application factory for the licensing server.
 *
 * `buildApp()` wires together the database, auth decorator and all route
 * modules. Both the production entry point (`index.js`) and the test suite
 * call it — tests pass `':memory:'` as the database path for isolation.
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import crypto from 'node:crypto';
import { openDatabase } from './db.js';
import { config } from './config.js';
import { registerErrorContract } from './errors.js';
import { makeAuthenticate, makeRequireAdmin } from './auth.js';
import authRoutes from './routes/auth.js';
import accountRoutes from './routes/account.js';
import adminRoutes from './routes/admin.js';
import billingRoutes from './routes/billing.js';
import gamesRoutes from './routes/games.js';
import licenseRoutes from './routes/license.js';

/**
 * Builds a configured (but not yet listening) Fastify instance.
 *
 * @param {{databasePath?: string, logger?: boolean}} [opts]
 * @returns {Promise<{app: import('fastify').FastifyInstance, db: import('node:sqlite').DatabaseSync}>}
 */
export async function buildApp(opts = {}) {
  const db = openDatabase(opts.databasePath || ':memory:');
  // trustProxy only when explicitly enabled — behind Cloudflare/proxy the
  // real client IP arrives via X-Forwarded-For / CF-Connecting-IP (needed
  // for correct rate-limiting and the YooKassa webhook subnet check).
  const app = Fastify({
    logger: opts.logger ?? false,
    trustProxy: opts.trustProxy ?? config.trustProxy,
    // Correlation id per request — echoed back as `x-request-id` for
    // support tickets ("Код обращения").
    genReqId: () => crypto.randomUUID(),
    requestIdHeader: 'x-request-id',
  });

  registerErrorContract(app);

  // CORS whitelist: only the origins in config.corsOrigins get
  // Access-Control-Allow-Origin; anything else is answered without CORS
  // headers (non-browser clients like the launcher don't need them).
  const allowed = opts.corsOrigins ?? config.corsOrigins;
  const allowedSet = new Set(allowed);
  await app.register(cors, {
    origin: (origin, cb) => {
      // No Origin header → non-browser client → allow (CORS is a browser
      // construct; withholding headers here would break nothing anyway).
      if (!origin) return cb(null, true);
      cb(null, allowedSet.has(origin));
    },
  });

  const authenticate = makeAuthenticate(db);
  const requireAdmin = makeRequireAdmin(db);
  const deps = { db, authenticate, requireAdmin };

  app.get('/api/health', async () => ({ ok: true, ts: Date.now() }));
  await app.register(adminRoutes, { prefix: '/api/admin', ...deps });
  await app.register(authRoutes, { prefix: '/api/auth', ...deps });
  await app.register(accountRoutes, { prefix: '/api/account', ...deps });
  await app.register(billingRoutes, { prefix: '/api/billing', ...deps });
  await app.register(gamesRoutes, { prefix: '/api/games', ...deps });
  await app.register(licenseRoutes, { prefix: '/api/license', ...deps });

  app.addHook('onClose', async () => db.close());
  return { app, db };
}
