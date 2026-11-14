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
import rateLimit from '@fastify/rate-limit';
import crypto from 'node:crypto';
import { openDatabase } from './db.js';
import { config } from './config.js';
import { registerErrorContract } from './errors.js';
import { makeAuthenticate, makeRequireAdmin, makeRequirePublisher } from './auth.js';
import authRoutes from './routes/auth.js';
import accountRoutes from './routes/account.js';
import adminRoutes from './routes/admin.js';
import billingRoutes from './routes/billing.js';
import gamesRoutes from './routes/games.js';
import licenseRoutes from './routes/license.js';
import publisherRoutes from './routes/publisher.js';
import tiktokRoutes from './routes/tiktok.js';
import tiktokBindRoutes from './routes/tiktok_bind.js';
import plansRoutes, { entitlementsRoutes } from './routes/plans.js';
import tributeRoutes, { tgRoutes } from './routes/tribute.js';
import usageRoutes from './routes/usage.js';
import mcRoutes from './routes/mc.js';

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

  // Minimal security headers on every response (the API is consumed by
  // the launcher, but the same listener serves the admin uploads/docs).
  app.addHook('onSend', async (_request, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
  });

  // The sign proxy needs the raw request body (the SDK sends JSON, but we
  // forward it untouched). The Tribute webhook keeps a raw copy for HMAC
  // verification. Everywhere else JSON keeps parsing normally.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (req, body, done) => {
      if (req.raw.url?.startsWith('/api/tiktok-sign/')) {
        return done(null, body);
      }
      if (req.raw.url?.startsWith('/api/billing/tribute/webhook')) {
        req.raw.rawBody = body;
      }
      try {
        done(null, body.length ? JSON.parse(body.toString('utf8')) : {});
      } catch (err) {
        err.statusCode = 400;
        done(err);
      }
    }
  );

  // HTTP-level rate limit on the auth surface — the DB-backed lockout in
  // routes/auth.js throttles per (ip,email); this caps the route globally
  // per IP so a sprayed-email flood can't even reach the DB.
  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: () => ({
      error: 'TOO_MANY_ATTEMPTS',
      retryable: true,
    }),
  });

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
  const requirePublisher = makeRequirePublisher(db);
  const deps = {
    db,
    authenticate,
    requireAdmin,
    requirePublisher,
    // Test hook: stub the TikTok profile fetch so bind tests stay offline.
    fetchBio: opts.tiktokFetchBio,
  };

  app.get('/api/health', async () => ({ ok: true, ts: Date.now() }));
  await app.register(adminRoutes, { prefix: '/api/admin', ...deps });
  await app.register(authRoutes, { prefix: '/api/auth', ...deps });
  await app.register(accountRoutes, { prefix: '/api/account', ...deps });
  await app.register(entitlementsRoutes, { prefix: '/api/account', ...deps });
  await app.register(plansRoutes, { prefix: '/api/plans', ...deps });
  await app.register(usageRoutes, { prefix: '/api/usage', ...deps });
  await app.register(mcRoutes, { prefix: '/api/mc', ...deps });
  await app.register(billingRoutes, { prefix: '/api/billing', ...deps });
  await app.register(tributeRoutes, { prefix: '/api/billing', ...deps });
  await app.register(tgRoutes, { prefix: '/api/tg', ...deps });
  await app.register(gamesRoutes, { prefix: '/api/games', ...deps });
  await app.register(licenseRoutes, { prefix: '/api/license', ...deps });
  await app.register(publisherRoutes, { prefix: '/api/publisher', ...deps });
  await app.register(tiktokRoutes, { prefix: '/api/tiktok-sign', ...deps });
  await app.register(tiktokBindRoutes, { prefix: '/api/tiktok', ...deps });

  app.addHook('onClose', async () => db.close());
  return { app, db };
}
