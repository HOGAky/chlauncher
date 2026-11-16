/**
 * @file routes/usage.js
 * Earn-limit usage reporting (parity spec §8.4):
 *
 *  - POST /api/usage/report — {month, coins_delta, nonce}
 *
 * The launcher ships its local usage delta every 60 s and on exit.
 * Idempotent by `nonce`: a retried report inserts the nonce first, so a
 * duplicate never double-counts. Rate-limited to 2/min per IP and
 * coins_delta is capped — this meter drives the free-tier earn limit,
 * so accepting arbitrary deltas would make the limit meaningless.
 */

import { reportUsage, currentMonth } from '../db.js';

/**
 * @param {import('fastify').FastifyInstance} app
 * @param {{db: import('node:sqlite').DatabaseSync, authenticate: Function}} opts
 */
export default async function usageRoutes(app, { db, authenticate }) {
  app.post(
    '/report',
    {
      preHandler: authenticate,
      // 2/min per ACCOUNT (the bearer token identifies the user before
      // auth runs) — a per-IP cap would let one network starve every
      // streamer behind it.
      config: {
        rateLimit: {
          max: 2,
          timeWindow: '1 minute',
          keyGenerator: (req) => req.headers.authorization || req.ip,
        },
      },
    },
    async (request, reply) => {
      const { month, coins_delta, nonce } = request.body || {};

      // Month must be the current UTC 'YYYY-MM' — no back-filling.
      if (typeof month !== 'string' || month !== currentMonth()) {
        return reply.code(400).send({ error: 'INVALID_MONTH' });
      }
      const delta = Number(coins_delta);
      if (!Number.isFinite(delta) || delta < 0 || delta > 1_000_000) {
        return reply.code(400).send({ error: 'INVALID_COINS_DELTA' });
      }
      if (typeof nonce !== 'string' || nonce.length < 8 || nonce.length > 128) {
        return reply.code(400).send({ error: 'INVALID_NONCE' });
      }

      const { applied, coins } = reportUsage(
        db,
        request.auth.userId,
        month,
        Math.round(delta),
        nonce
      );
      return { ok: true, applied, month, coins };
    }
  );
}
