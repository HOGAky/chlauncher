/**
 * @file routes/account.js
 * Authenticated account routes: profile fetch and HWID reset.
 *
 * HWID reset is rate-limited to once per 7 days — this is the anti
 * account-sharing control: a streamer may move to a new PC, but cannot
 * hop the same subscription across many machines.
 */

import {
  findUserById,
  setUserHwid,
  markHwidReset,
  nowIso,
} from '../db.js';
import { refreshSubscription, subscriptionView } from '../subscriptions.js';

const HWID_RESET_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * @param {import('fastify').FastifyInstance} app
 * @param {{db: import('node:sqlite').DatabaseSync, authenticate: Function}} opts
 */
export default async function accountRoutes(app, { db, authenticate }) {
  app.addHook('preHandler', authenticate);

  /**
   * GET /api/account/me — current profile + live subscription status.
   */
  app.get('/me', async (request) => {
    const user = findUserById(db, request.auth.userId);
    const subscription = refreshSubscription(db, user.id);
    return {
      user: {
        id: user.id,
        email: user.email,
        hwid: user.hwid,
        hwid_last_reset: user.hwid_last_reset,
        created_at: user.created_at,
      },
      subscription: subscriptionView(subscription),
    };
  });

  /**
   * POST /api/account/reset-hwid
   * Body: {hwid?} — if provided, binds that device immediately; otherwise
   * the binding is cleared and the next login re-binds automatically.
   * Allowed at most once per 7 days → 403 HWID_RESET_COOLDOWN otherwise.
   */
  app.post('/reset-hwid', async (request, reply) => {
    const user = findUserById(db, request.auth.userId);
    if (user.hwid_last_reset) {
      const elapsed = Date.now() - new Date(user.hwid_last_reset).getTime();
      if (elapsed < HWID_RESET_COOLDOWN_MS) {
        return reply.code(403).send({
          error: 'HWID_RESET_COOLDOWN',
          retry_after_ms: HWID_RESET_COOLDOWN_MS - elapsed,
        });
      }
    }
    const { hwid } = request.body || {};
    setUserHwid(db, user.id, hwid || null);
    markHwidReset(db, user.id);
    return { ok: true, hwid: hwid || null, reset_at: nowIso() };
  });
}
