/**
 * @file routes/auth.js
 * Public authentication routes: registration, login, logout.
 *
 * HWID (hardware id) rules:
 *  - On register the client may already send its HWID → it is bound at once.
 *  - On login, if the account has no HWID bound yet, the presented HWID is
 *    bound transparently. If a *different* HWID is presented, login is
 *    rejected with HWID_MISMATCH — this is the account-sharing protection.
 *    The streamer can unbind via POST /api/account/reset-hwid (1 per 7 days).
 *  - HWIDs are stored HMAC-SHA256'd (see hwid.js); the client's
 *    `!sentinel` values are rejected with HWID_UNAVAILABLE.
 *
 * Brute-force protection: at most 5 failed credential checks per
 * (ip, email) pair per 15 minutes → 429 TOO_MANY_ATTEMPTS + retry_after_ms.
 */

import {
  findUserByEmail,
  createUser,
  setUserHwid,
  recordDeviceEvent,
  bumpTokenVersion,
} from '../db.js';
import {
  hashPassword,
  verifyPassword,
  signToken,
  syncAdminRole,
} from '../auth.js';
import { isUsableHwid, hwidHash, ipHash } from '../hwid.js';
import {
  refreshSubscription,
  subscriptionView,
} from '../subscriptions.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILS = 5;

/**
 * Registers the auth routes on a Fastify instance.
 * @param {import('fastify').FastifyInstance} app
 * @param {{db: import('node:sqlite').DatabaseSync, authenticate: Function}} opts
 */
export default async function authRoutes(app, { db, authenticate }) {
  // Per-process credential-failure journal: key `ip|email` → {count, resetAt}.
  const loginFails = new Map();

  // Sweep expired entries every 10 min — without it the Map grows forever
  // on failed attempts that never repeat (random-email spraying = memory
  // leak). unref() so the timer never keeps the process alive.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, e] of loginFails) {
      if (e.resetAt <= now) loginFails.delete(k);
    }
  }, 10 * 60 * 1000);
  sweep.unref();
  app.addHook('onClose', async () => clearInterval(sweep));

  const failCount = (key) => {
    const e = loginFails.get(key);
    if (!e || e.resetAt <= Date.now()) return null;
    return e;
  };
  const noteFail = (key) => {
    const e = failCount(key) || { count: 0, resetAt: Date.now() + LOGIN_WINDOW_MS };
    e.count += 1;
    loginFails.set(key, e);
  };
  const clearFails = (key) => loginFails.delete(key);

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
    if (hwid != null && !isUsableHwid(hwid)) {
      return reply.code(400).send({ error: 'HWID_UNAVAILABLE' });
    }
    if (findUserByEmail(db, email)) {
      return reply.code(409).send({ error: 'EMAIL_TAKEN' });
    }

    const user = createUser(db, {
      email,
      passwordHash: hashPassword(password),
      hwid: hwid ? hwidHash(hwid) : null,
    });
    if (hwid) {
      recordDeviceEvent(db, user.id, 'bound', hwidHash(hwid), ipHash(request.ip));
    }
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
    const key = `${request.ip}|${(email || '').toLowerCase()}`;

    const blocked = failCount(key);
    if (blocked && blocked.count >= LOGIN_MAX_FAILS) {
      return reply.code(429).send({
        error: 'TOO_MANY_ATTEMPTS',
        retry_after_ms: blocked.resetAt - Date.now(),
      });
    }

    const user = email ? findUserByEmail(db, email) : undefined;
    if (!user || !verifyPassword(password || '', user.password_hash)) {
      noteFail(key);
      return reply.code(401).send({ error: 'INVALID_CREDENTIALS' });
    }
    clearFails(key);

    syncAdminRole(db, user);

    // HWID anti-sharing applies to regular accounts only. Admins are the
    // operators — they legitimately log in from the launcher, the publish
    // CLI and elsewhere, so binding them to one machine only creates
    // lockout footguns (HWID_MISMATCH / 7-day reset cooldown).
    if (user.role !== 'admin') {
      if (!hwid) {
        recordDeviceEvent(db, user.id, 'login_denied', null, ipHash(request.ip));
        return reply.code(400).send({ error: 'HWID_REQUIRED' });
      }
      if (!isUsableHwid(hwid)) {
        recordDeviceEvent(db, user.id, 'login_denied', null, ipHash(request.ip));
        return reply.code(400).send({ error: 'HWID_UNAVAILABLE' });
      }
      const hash = hwidHash(hwid);
      if (user.hwid && user.hwid !== hash) {
        recordDeviceEvent(db, user.id, 'login_denied', hash, ipHash(request.ip));
        return reply.code(403).send({ error: 'HWID_MISMATCH' });
      }
      if (!user.hwid) {
        setUserHwid(db, user.id, hash);
        recordDeviceEvent(db, user.id, 'bound', hash, ipHash(request.ip));
      }
    }
    const subscription = refreshSubscription(db, user.id);
    return {
      token: signToken(user),
      user: publicUser(user),
      subscription: subscriptionView(subscription),
    };
  });

  /**
   * POST /api/auth/logout — invalidates the current session: every JWT
   * issued with the previous token_version stops authorizing (Task 5).
   */
  app.post('/logout', { preHandler: authenticate }, async (request) => {
    bumpTokenVersion(db, request.auth.userId);
    return { ok: true };
  });
}

/** Strips secret fields from a user row before sending it to the client. */
function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    role: user.role || 'user',
    // Never return the stored value — it is an HMAC anyway, and the UI only
    // needs to know whether a device is bound.
    hwid_bound: !!user.hwid,
    hwid_last_reset: user.hwid_last_reset,
    created_at: user.created_at,
  };
}
