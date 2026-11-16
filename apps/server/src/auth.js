/**
 * @file auth.js
 * Authentication utilities for the licensing server:
 *  - scrypt-based password hashing (Node built-in `crypto`, no dependencies)
 *  - JWT issuing/verification via `jsonwebtoken`
 *  - a Fastify `authenticate` decorator that guards protected routes
 *
 * Tokens are valid for 30 days; the launcher refreshes them on login.
 */

import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from './config.js';

const SCRYPT_KEYLEN = 64;
const TOKEN_TTL = '30d';

/**
 * Hashes a plaintext password with a random salt (scrypt).
 * @param {string} password
 * @returns {string} `salt:hexhash` pair, safe to store.
 */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return `${salt}:${hash}`;
}

/**
 * Constant-time verification of a password against a `salt:hexhash` string.
 * @param {string} password
 * @param {string} stored
 * @returns {boolean}
 */
export function verifyPassword(password, stored) {
  const [salt, expected] = (stored || '').split(':');
  if (!salt || !expected) return false;
  const actual = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  const expectedBuf = Buffer.from(expected, 'hex');
  return (
    actual.length === expectedBuf.length &&
    crypto.timingSafeEqual(actual, expectedBuf)
  );
}

/**
 * Signs a JWT for a user row. The `role` claim is informational — the server
 * never trusts it for authorization (DB is checked on every admin request).
 * @param {{id:number,email:string,role?:string}} user
 * @returns {string}
 */
export function signToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      email: user.email,
      role: user.role || 'user',
      // Session generation — bumped by logout/reset; a stale JWT whose tv
      // no longer matches users.token_version is rejected (Task 5).
      tv: user.token_version || 0,
    },
    config.jwtSecret,
    { expiresIn: TOKEN_TTL }
  );
}

/**
 * Fastify preHandler factory: verifies `Authorization: Bearer <jwt>` and
 * attaches `{ userId, email }` to `request.auth`. Responds 401 on failure.
 */
export function makeAuthenticate(db) {
  const tvQuery = db.prepare('SELECT token_version FROM users WHERE id = ?');
  return async function authenticate(request, reply) {
    const header = request.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) {
      return reply.code(401).send({ error: 'UNAUTHORIZED' });
    }
    let payload;
    try {
      payload = jwt.verify(token, config.jwtSecret);
    } catch (err) {
      const expired = err && err.name === 'TokenExpiredError';
      return reply
        .code(401)
        .send({ error: expired ? 'SESSION_EXPIRED' : 'UNAUTHORIZED' });
    }
    // Session invalidation: a JWT signed before logout carries an old tv.
    const row = tvQuery.get(payload.sub);
    if (!row || (payload.tv || 0) !== row.token_version) {
      return reply.code(401).send({ error: 'SESSION_EXPIRED' });
    }
    request.auth = { userId: payload.sub, email: payload.email };
  };
}

/**
 * Fastify preHandler factory: `authenticate` + DB-side role check.
 * The JWT role claim is never trusted — `users.role` is read on every call.
 * Responds 403 FORBIDDEN when the caller's role isn't in `roles`.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string[]} roles
 */
export function makeRequireRole(db, roles) {
  const authenticate = makeAuthenticate(db);
  const roleQuery = db.prepare('SELECT role FROM users WHERE id = ?');
  const allowed = new Set(roles);
  return async function requireRole(request, reply) {
    await authenticate(request, reply);
    if (reply.sent) return;
    const row = roleQuery.get(request.auth.userId);
    if (!row || !allowed.has(row.role)) {
      return reply.code(403).send({ error: 'FORBIDDEN' });
    }
    request.auth.role = row.role;
  };
}

/** Admin-only preHandler. */
export function makeRequireAdmin(db) {
  return makeRequireRole(db, ['admin']);
}

/** Publisher self-service preHandler — admins also pass. */
export function makeRequirePublisher(db) {
  return makeRequireRole(db, ['publisher', 'admin']);
}

/**
 * Syncs the admin flag from `config.adminEmails` onto a user row — runs on
 * every register/login. Promote-only: emails removed from ADMIN_EMAILS keep
 * whatever role they have, so `grant-admin.mjs` grants survive logins.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} user - mutable user row (role updated in place)
 */
export function syncAdminRole(db, user) {
  if (user.role !== 'admin' && config.adminEmails.has(user.email.toLowerCase())) {
    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(user.id);
    user.role = 'admin';
  }
  return user;
}
