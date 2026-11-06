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
import { openDatabase } from './db.js';
import { makeAuthenticate, makeRequireAdmin } from './auth.js';
import authRoutes from './routes/auth.js';
import accountRoutes from './routes/account.js';
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
  const app = Fastify({ logger: opts.logger ?? false });

  await app.register(cors, { origin: true });

  const authenticate = makeAuthenticate();
  const requireAdmin = makeRequireAdmin(db);
  const deps = { db, authenticate, requireAdmin };

  app.get('/api/health', async () => ({ ok: true, ts: Date.now() }));
  await app.register(authRoutes, { prefix: '/api/auth', ...deps });
  await app.register(accountRoutes, { prefix: '/api/account', ...deps });
  await app.register(billingRoutes, { prefix: '/api/billing', ...deps });
  await app.register(gamesRoutes, { prefix: '/api/games', ...deps });
  await app.register(licenseRoutes, { prefix: '/api/license', ...deps });

  app.addHook('onClose', async () => db.close());
  return { app, db };
}
