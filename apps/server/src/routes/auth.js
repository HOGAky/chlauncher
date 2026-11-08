/**
 * @file routes/auth.js
 * Public authentication routes: registration and login.
 *
 * HWID (hardware id) rules:
 *  - On register the client may already send its HWID → it is bound at once.
 *  - On login, if the account has no HWID bound yet, the presented HWID is
 *    bound transparently. If a *different* HWID is presented, login is
 *    rejected with HWID_MISMATCH — this is the account-sharing protection.
 *    The streamer can unbind via POST /api/account/reset-hwid (1 per 7 days).
 */

import {
  findUserByEmail,
  createUser,
  setUserHwid,
} from '../db.js';
import {
  hashPassword,
  verifyPassword,
  signToken,
  syncAdminRole,
} from '../auth.js';
import {
  refreshSubscription,
  subscriptionView,
} from '../subscriptions.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Registers the auth routes on a Fastify instance.
 * @param {import('fastify').FastifyInstance} app
 * @param {{db: import('node:sqlite').DatabaseSync}} opts
 */
export default async function authRoutes(app, { db }) {
  /**
   * POST /api/auth/register
   * Body: {email, password, hwid?}
   * Creates the account (+expired subscription row) and returns a JWT.
   */
  app.post('/register', async (request, reply) => {
    const { email, password, hwid } = request.body || {};
    if (!email || !EMAIL_RE.test(email)) {
      return reply.code(400).send({ error: 'INVALID_EMAIL' });
    }
    if (!password || password.length < 6) {
      return reply.code(400).send({ error: 'PASSWORD_TOO_SHORT' });
    }
    if (findUserByEmail(db, email)) {
      return reply.code(409).send({ error: 'EMAIL_TAKEN' });
    }

    const user = createUser(db, {
      email,
      passwordHash: hashPassword(password),
      hwid: hwid || null,
    });
    syncAdminRole(db, user);
    const subscription = refreshSubscription(db, user.id);
    return {
      token: signToken(user),
      user: publicUser(user),
      subscription: subscriptionView(subscription),
    };
  });

  /**
   * POST /api/auth/login
   * Body: {email, password, hwid}
   * Verifies credentials, enforces the HWID binding, returns a JWT.
   */
  app.post('/login', async (request, reply) => {
    const { email, password, hwid } = request.body || {};
    const user = email ? findUserByEmail(db, email) : undefined;
    if (!user || !verifyPassword(password || '', user.password_hash)) {
      return reply.code(401).send({ error: 'INVALID_CREDENTIALS' });
    }

    syncAdminRole(db, user);

    // HWID anti-sharing applies to regular accounts only. Admins are the
    // operators — they legitimately log in from the launcher, the publish
    // CLI and elsewhere, so binding them to one machine only creates
    // lockout footguns (HWID_MISMATCH / 7-day reset cooldown).
    if (user.role !== 'admin') {
      if (!hwid) {
        return reply.code(400).send({ error: 'HWID_REQUIRED' });
      }
      if (user.hwid && user.hwid !== hwid) {
        return reply.code(403).send({ error: 'HWID_MISMATCH' });
      }
      if (!user.hwid) {
        setUserHwid(db, user.id, hwid);
        user.hwid = hwid;
      }
    }
    const subscription = refreshSubscription(db, user.id);
    return {
      token: signToken(user),
      user: publicUser(user),
      subscription: subscriptionView(subscription),
    };
  });
}

/** Strips secret fields from a user row before sending it to the client. */
function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    role: user.role || 'user',
    hwid: user.hwid,
    hwid_last_reset: user.hwid_last_reset,
    created_at: user.created_at,
  };
}
