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

import crypto from 'node:crypto';
import { config } from '../config.js';
import {
  findUserByEmail,
  createUser,
  setUserHwid,
  nowIso,
  recordDeviceEvent,
  bumpTokenVersion,
  getLoginAttempts,
  noteLoginAttempt,
  clearLoginAttempts,
  sweepLoginAttempts,
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
  // Credential-failure journal is DB-backed (login_attempts, schema v4) —
  // the lockout survives restarts and rows are keyed by `ip_hash|email`,
  // so no raw IPs or passwords touch the table.
  const failKey = (request, email) =>
    `${ipHash(request.ip)}|${(email || '').toLowerCase()}`;

  // Sweep expired rows every 10 min — without it the table grows forever
  // on failed attempts that never repeat (random-email spraying).
  const sweep = setInterval(() => sweepLoginAttempts(db), 10 * 60 * 1000);
  sweep.unref();
  app.addHook('onClose', async () => clearInterval(sweep));

  /**
   * POST /api/auth/register
   * Body: {email, password, hwid?}
   * Creates the account (+expired subscription row) and returns a JWT.
   */
  app.post(
    '/register',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
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
    }
  );

  /**
   * POST /api/auth/login
   * Body: {email, password, hwid}
   * Verifies credentials, enforces the HWID binding, returns a JWT.
   */
  app.post(
    '/login',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { email, password, hwid } = request.body || {};
      const key = failKey(request, email);

      const blocked = getLoginAttempts(db, key);
      if (blocked && blocked.count >= LOGIN_MAX_FAILS) {
        return reply.code(429).send({
          error: 'TOO_MANY_ATTEMPTS',
          retry_after_ms: blocked.reset_at - Date.now(),
        });
      }

      const user = email ? findUserByEmail(db, email) : undefined;
      if (!user || !verifyPassword(password || '', user.password_hash)) {
        noteLoginAttempt(db, key, LOGIN_WINDOW_MS);
        return reply.code(401).send({ error: 'INVALID_CREDENTIALS' });
      }
      clearLoginAttempts(db, key);

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
    }
  );

  /**
   * POST /api/auth/telegram-start — begins a "sign in with Telegram"
   * session (EFIR parity: TG is the primary login for the CIS audience).
   * Returns a one-shot code; the launcher opens
   * `t.me/<bot>?start=login_<code>` and polls /telegram-status.
   */
  app.post(
    '/telegram-start',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      if (!config.tributeBotUrl) {
        return reply.code(503).send({ error: 'TG_LOGIN_UNAVAILABLE' });
      }
      const code = crypto.randomBytes(12).toString('base64url');
      db.prepare(
        `INSERT INTO tg_login_codes (code, expires_at, created_at) VALUES (?,?,?)`
      ).run(code, new Date(Date.now() + 10 * 60 * 1000).toISOString(), nowIso());
      return { code, url: `${config.tributeBotUrl}login_${code}`, expires_in: 600 };
    }
  );

  /**
   * POST /api/auth/telegram-status {code, hwid?}
   * 'pending' until the bind-bot claims the code; on the first status
   * call after claiming, the code is consumed and a session is issued:
   * existing user bound to that Telegram id, or a fresh tg_* account
   * (random password — the owner can add email/password later).
   * HWID rules mirror /login (non-admin accounts only).
   */
  app.post(
    '/telegram-status',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { code, hwid } = request.body || {};
      const row = code
        ? db.prepare('SELECT * FROM tg_login_codes WHERE code = ?').get(String(code))
        : undefined;
      if (!row || row.consumed || row.expires_at < nowIso()) {
        return reply.code(404).send({ error: 'CODE_INVALID' });
      }
      if (row.telegram_user_id == null) {
        return { status: 'pending' };
      }

      const claimed = db
        .prepare('UPDATE tg_login_codes SET consumed = 1 WHERE code = ? AND consumed = 0')
        .run(row.code);
      if (claimed.changes === 0) {
        return reply.code(404).send({ error: 'CODE_INVALID' });
      }

      const tgId = row.telegram_user_id;
      let user = db
        .prepare(
          `SELECT u.* FROM users u
           JOIN tg_bindings b ON b.user_id = u.id
           WHERE b.telegram_user_id = ?`
        )
        .get(tgId);
      if (!user) {
        const email = `tg_${tgId}@telegram.local`;
        user = createUser(db, {
          email,
          passwordHash: hashPassword(crypto.randomBytes(24).toString('hex')),
          hwid: hwid && isUsableHwid(hwid) ? hwidHash(hwid) : null,
        });
        db.prepare(
          `INSERT INTO tg_bindings (user_id, telegram_user_id, telegram_username, bound_at)
           VALUES (?,?,?,?)`
        ).run(user.id, tgId, row.telegram_username || '', nowIso());
      }
      syncAdminRole(db, user);

      if (user.role !== 'admin') {
        if (!hwid) {
          return reply.code(400).send({ error: 'HWID_REQUIRED' });
        }
        if (!isUsableHwid(hwid)) {
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
        status: 'ready',
        token: signToken(user),
        user: publicUser(user),
        subscription: subscriptionView(subscription),
      };
    }
  );

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
