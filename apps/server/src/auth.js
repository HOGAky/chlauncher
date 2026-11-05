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
 * Signs a JWT for a user row.
 * @param {{id:number,email:string}} user
 * @returns {string}
 */
export function signToken(user) {
  return jwt.sign({ sub: user.id, email: user.email }, config.jwtSecret, {
    expiresIn: TOKEN_TTL,
  });
}

/**
 * Fastify preHandler factory: verifies `Authorization: Bearer <jwt>` and
 * attaches `{ userId, email }` to `request.auth`. Responds 401 on failure.
 */
export function makeAuthenticate() {
  return async function authenticate(request, reply) {
    const header = request.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) {
      return reply.code(401).send({ error: 'UNAUTHORIZED' });
    }
    try {
      const payload = jwt.verify(token, config.jwtSecret);
      request.auth = { userId: payload.sub, email: payload.email };
    } catch {
      return reply.code(401).send({ error: 'UNAUTHORIZED' });
    }
  };
}
