/**
 * @file routes/license.js
 * License verification endpoint — called by the launcher right before it
 * spawns a game process.
 *
 * The server only answers "is this user, on this hardware, allowed to play
 * right now?". When allowed, the LAUNCHER (not the server) mints the
 * one-time local session token that the game must present over the local
 * WebSocket handshake — see `packages/game-sdk` and the launcher docs.
 */

import { findUserById, findGameBySlug } from '../db.js';
import { isUsableHwid, hwidHash } from '../hwid.js';
import {
  refreshSubscription,
  subscriptionView,
} from '../subscriptions.js';
import { gameEntitlementError } from './games.js';

/**
 * @param {import('fastify').FastifyInstance} app
 * @param {{db: import('node:sqlite').DatabaseSync, authenticate: Function}} opts
 */
export default async function licenseRoutes(app, { db, authenticate }) {
  /**
   * POST /api/license/verify
   * Body: {hwid, game_slug?}
   * → 200 {allowed:true, subscription}  when everything checks out
   * → 403 {allowed:false, error}        on HWID mismatch / expired sub
   */
  app.post('/verify', { preHandler: authenticate }, async (request, reply) => {
    const { hwid, game_slug } = request.body || {};
    const user = findUserById(db, request.auth.userId);
    if (!user) return reply.code(401).send({ allowed: false, error: 'UNKNOWN_USER' });

    if (user.hwid && hwid && user.hwid !== hwidHash(hwid)) {
      return reply.code(403).send({ allowed: false, error: 'HWID_MISMATCH' });
    }
    if (hwid != null && !isUsableHwid(hwid)) {
      return reply
        .code(400)
        .send({ allowed: false, error: 'HWID_UNAVAILABLE' });
    }

    const sub = refreshSubscription(db, user.id);
    // P0.2: entitlement gate — the plan (not "any subscription") decides.
    // Catalog rows need `paid_games` (or is_free); non-catalog slugs
    // (built-in interactive packs) need the plan's `interactive_games`
    // allow-list. A modified client asking for an unlisted slug gets a
    // stable machine-readable denial.
    const game = game_slug ? findGameBySlug(db, String(game_slug)) : null;
    const denied = gameEntitlementError(
      db,
      user.id,
      game || { slug: game_slug ? String(game_slug) : null, is_free: 0 }
    );
    if (denied !== true) {
      // "Wrong plan for this slug" vs "no paid plan at all" — the client
      // shows a paywall for the latter and a plan-upsell for the former.
      const error =
        sub && sub.status === 'active'
          ? `PLAN_LIMIT:${denied}`
          : 'SUBSCRIPTION_REQUIRED';
      return reply.code(403).send({
        allowed: false,
        error,
        subscription: subscriptionView(sub),
      });
    }

    return { allowed: true, subscription: subscriptionView(sub) };
  });
}
