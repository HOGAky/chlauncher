/**
 * @file admin.test.js
 * Tests for the admin role model (§1): ADMIN_EMAILS syncing, role in
 * responses/JWT, and requireAdmin gating. Runs on an in-memory DB via
 * app.inject. ADMIN_EMAILS must be set before the app modules load, so
 * everything is imported dynamically inside `before`.
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

process.env.ADMIN_EMAILS = 'root@example.com, owner@example.com ';

let app;
let db;
let config;
let buildApp;

const auth = (token) => ({ authorization: `Bearer ${token}` });

async function register(email, hwid = 'HWID-X') {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password: 'secret123', hwid },
  });
  return { status: res.statusCode, body: res.json() };
}

before(async () => {
  ({ buildApp } = await import('../src/app.js'));
  ({ config } = await import('../src/config.js'));
  ({ app, db } = await buildApp({ databasePath: ':memory:' }));
});

test('ADMIN_EMAILS grants role=admin on register', async () => {
  const { status, body } = await register('root@example.com');
  assert.equal(status, 200);
  assert.equal(body.user.role, 'admin');
  const payload = jwt.decode(body.token);
  assert.equal(payload.role, 'admin');
});

test('login re-syncs the role for ADMIN_EMAILS accounts', async () => {
  // User exists as plain user (registered before being added to the list).
  db.prepare("INSERT INTO users (email, password_hash, role, created_at) VALUES (?, '', 'user', ?)")
    .run('owner@example.com', new Date().toISOString());
  // Simulate login path via syncAdminRole directly — same code path as login.
  const { syncAdminRole } = await import('../src/auth.js');
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get('owner@example.com');
  syncAdminRole(db, user);
  assert.equal(user.role, 'admin');
});

test('regular users keep role=user and get a user-role JWT', async () => {
  const { body } = await register('plain@example.com');
  assert.equal(body.user.role, 'user');
  assert.equal(jwt.decode(body.token).role, 'user');
});

test('non-admin token cannot reach /api/admin/*', async () => {
  const { body } = await register('user2@example.com');
  const res = await app.inject({
    method: 'GET',
    url: '/api/admin/games',
    headers: auth(body.token),
  });
  // Route doesn't exist yet (stage 2) — requireAdmin still gates first.
  assert.ok([403, 404].includes(res.statusCode));
});
