/**
 * @file api.test.js
 * End-to-end tests for the licensing server, run with `node --test`.
 *
 * Each test builds an isolated app on an in-memory SQLite database and
 * exercises the HTTP surface via `app.inject` (no real sockets needed).
 * Covers: registration/login, HWID binding + 7-day reset cooldown,
 * 30-day subscription lifecycle, license gating and gated downloads.
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { updateSubscription, isoInDays } from '../src/db.js';

let app;
let db;

/** Registers a fresh user and returns {token, body}. */
async function register(email, hwid = 'HWID-A') {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password: 'secret123', hwid },
  });
  return { status: res.statusCode, body: res.json() };
}

/** Performs mock-pay for a token and returns the subscription view. */
async function mockPay(token) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/billing/mock-pay',
    headers: { authorization: `Bearer ${token}` },
  });
  return res.json();
}

const auth = (token) => ({ authorization: `Bearer ${token}` });

before(async () => {
  ({ app, db } = await buildApp({ databasePath: ':memory:' }));
  // Catalog is no longer auto-seeded (schema v2) — insert a published
  // fixture game + build so the catalog/download tests have something.
  const g = db
    .prepare(
      `INSERT INTO games (slug, title, description, version, file_name, executable_name)
       VALUES ('mock-game', 'Mock Arena', '', '0.1.0', 'mock-game/0.1.0.zip', 'mock-game.exe')`
    )
    .run();
  const b = db
    .prepare(
      `INSERT INTO game_builds (game_id, version, file_name, sha256, size_bytes, created_at)
       VALUES (?, '0.1.0', 'mock-game/0.1.0.zip', '', 0, ?)`
    )
    .run(Number(g.lastInsertRowid), new Date().toISOString());
  db.prepare('UPDATE games SET published_build_id = ? WHERE id = ?').run(
    Number(b.lastInsertRowid),
    Number(g.lastInsertRowid)
  );
});

test('health check responds', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().ok, true);
});

test('register creates account with an expired subscription', async () => {
  const { status, body } = await register('a@example.com');
  assert.equal(status, 200);
  assert.ok(body.token);
  assert.equal(body.user.email, 'a@example.com');
  assert.equal(body.subscription.status, 'expired');
});

test('duplicate registration is rejected', async () => {
  await register('dup@example.com');
  const { status, body } = await register('dup@example.com');
  assert.equal(status, 409);
  assert.equal(body.error, 'EMAIL_TAKEN');
});

test('login binds HWID on first use, rejects a foreign HWID later', async () => {
  await register('hwid@example.com', 'HWID-1');

  const loginOk = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: 'hwid@example.com', password: 'secret123', hwid: 'HWID-1' },
  });
  assert.equal(loginOk.statusCode, 200);

  const loginBad = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: 'hwid@example.com', password: 'secret123', hwid: 'HWID-OTHER' },
  });
  assert.equal(loginBad.statusCode, 403);
  assert.equal(loginBad.json().error, 'HWID_MISMATCH');
});

test('HWID reset is limited to once per 7 days', async () => {
  const { body } = await register('reset@example.com', 'HWID-R');
  const token = body.token;

  const first = await app.inject({
    method: 'POST',
    url: '/api/account/reset-hwid',
    headers: auth(token),
    payload: {},
  });
  assert.equal(first.statusCode, 200);

  const second = await app.inject({
    method: 'POST',
    url: '/api/account/reset-hwid',
    headers: auth(token),
    payload: {},
  });
  assert.equal(second.statusCode, 403);
  assert.equal(second.json().error, 'HWID_RESET_COOLDOWN');
});

test('license verify is denied without an active subscription', async () => {
  const { body } = await register('nosub@example.com', 'HWID-N');
  const res = await app.inject({
    method: 'POST',
    url: '/api/license/verify',
    headers: auth(body.token),
    payload: { hwid: 'HWID-N' },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'SUBSCRIPTION_REQUIRED');
});

test('mock-pay grants 30 days and unlocks license verify + download', async () => {
  const { body } = await register('paid@example.com', 'HWID-P');
  const token = body.token;

  const pay = await mockPay(token);
  assert.equal(pay.subscription.status, 'active');
  // ~30 days, allow a small drift
  assert.ok(pay.subscription.days_left >= 29 && pay.subscription.days_left <= 30);

  const verify = await app.inject({
    method: 'POST',
    url: '/api/license/verify',
    headers: auth(token),
    payload: { hwid: 'HWID-P' },
  });
  assert.equal(verify.statusCode, 200);
  assert.equal(verify.json().allowed, true);

  const games = await app.inject({
    method: 'GET',
    url: '/api/games',
    headers: auth(token),
  });
  assert.equal(games.statusCode, 200);
  assert.ok(games.json().games.some((g) => g.slug === 'mock-game'));
});

test('game download is gated by subscription', async () => {
  const { body } = await register('gate@example.com', 'HWID-G');
  const res = await app.inject({
    method: 'GET',
    url: '/api/games/mock-game/download',
    headers: auth(body.token),
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'SUBSCRIPTION_REQUIRED');
});

test('mock-expire immediately locks the account out again', async () => {
  const { body } = await register('expire@example.com', 'HWID-E');
  const token = body.token;
  await mockPay(token);

  const expire = await app.inject({
    method: 'POST',
    url: '/api/billing/mock-expire',
    headers: auth(token),
  });
  assert.equal(expire.json().subscription.status, 'expired');

  const verify = await app.inject({
    method: 'POST',
    url: '/api/license/verify',
    headers: auth(token),
    payload: { hwid: 'HWID-E' },
  });
  assert.equal(verify.statusCode, 403);
});

test('lazy expiry: elapsed period flips active -> expired on next read', async () => {
  const { body } = await register('lazy@example.com', 'HWID-L');
  const token = body.token;
  await mockPay(token);

  // Simulate time passing: push period_end into the past directly in DB.
  const userId = body.user.id;
  updateSubscription(db, userId, 'active', isoInDays(-1));

  const res = await app.inject({
    method: 'GET',
    url: '/api/billing/subscription',
    headers: auth(token),
  });
  assert.equal(res.json().subscription.status, 'expired');
});

test('second payment stacks onto remaining period', async () => {
  const { body } = await register('stack@example.com', 'HWID-S');
  const token = body.token;
  const first = await mockPay(token);
  const second = await mockPay(token);
  const end1 = new Date(first.subscription.current_period_end).getTime();
  const end2 = new Date(second.subscription.current_period_end).getTime();
  assert.ok(end2 - end1 >= 29 * 86400000, 'period should extend by ~30 days');
});

test('protected routes require a token', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/account/me' });
  assert.equal(res.statusCode, 401);
});
