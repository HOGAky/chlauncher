/**
 * @file routes/plans.js
 * Tariff plans (parity spec §8.3):
 *
 *  - GET /api/plans                  — PUBLIC catalog of active plans
 *  - GET /api/account/entitlements   — caller's effective plan +
 *    entitlement map + this month's usage (the launcher caches this)
 *
 * Plan admin CRUD lives in routes/admin.js under /api/admin/plans/*.
 * Prices/titles are placeholders until the owner decides (§15).
 */

import {
  listActivePlans,
  activePlanForUser,
  usageForMonth,
  currentMonth,
  findUserById,
} from '../db.js';
import { syncAdminRole } from '../auth.js';

/**
 * @param {import('fastify').FastifyInstance} app
 * @param {{db: import('node:sqlite').DatabaseSync, authenticate: Function}} opts
 */
export default async function plansRoutes(app, { db, authenticate }) {
  /** GET /api/plans — public catalog; the pricing table reads this. */
  app.get('/', async () => ({ plans: listActivePlans(db) }));
}

/**
 * Mounted under /api/account — effective plan + entitlements + usage.
 * Kept in this module because the data IS plan-domain.
 * @param {import('fastify').FastifyInstance} app
 * @param {{db: import('node:sqlite').DatabaseSync, authenticate: Function}} opts
 */
export async function entitlementsRoutes(app, { db, authenticate }) {
  app.get(
    '/entitlements',
    { preHandler: authenticate },
    async (request) => {
      // Role self-heals here, not only on login: a TG bind made after the
      // JWT was issued promotes to admin on the next poll (OWNER_TG_IDS),
      // and a demotion propagates without a forced re-login.
      const user = findUserById(db, request.auth.userId);
      if (user) syncAdminRole(db, user);
      const plan = activePlanForUser(db, request.auth.userId);
      const month = currentMonth();
      return {
        plan,
        entitlements: plan.entitlements,
        usage: {
          month,
          coins: usageForMonth(db, request.auth.userId, month),
        },
        role: user?.role,
      };
    }
  );
}
