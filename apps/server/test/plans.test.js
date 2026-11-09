/**
 * @file plans.test.js
 * Tariff plans & usage metering tests (parity spec §8): public plan
 * catalog, entitlements endpoint, plan-aware mock-pay, free-tier game
 * gating, usage report idempotency, admin set-plan + plan CRUD.
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.ADMIN_EMAILS = 'admin@example.com';
process.env.ENABLE_MOCK_BILLING = '1';

let app;
let db;
let adminToken;

const auth = (token) => ({ authorization: `Bearer ${token}` });

async function register(email) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password: 'secret123', hwid: `HW-${email}` },
  });
  return res.json();
}

async function mockPay(token, planCode) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/billing/mock-pay',
    headers: auth(token),
    payload: planCode ? { plan_code: planCode } : {},
  });
  return { status: res.statusCode, body: res.json() };
}

async function entitlements(token) {
  const res = await app.inject({
    method: 'GET',
    url: '/api/account/entitlements',
    headers: auth(token),
  });
  return { status: res.statusCode, body: res.json() };
}

before(async () => {
  const { buildApp } = await import('../src/app.js');
  ({ app, db } = await buildApp({ databasePath: ':memory:' }));
  adminToken = (await register('admin@example.com')).token;
});

// ---------------------------------------------------------------- catalog

test('GET /api/plans is public and returns seeded tiers', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/plans' });
  assert.equal(res.statusCode, 200);
  const codes = res.json().plans.map((p) => p.code);
  assert.deepEqual(codes, ['free', 'pro', 'expert']);
  const free = res.json().plans[0];
  assert.equal(free.price_minor, 0);
  assert.equal(free.entitlements.tts, false);
  assert.equal(free.entitlements.earn_limit_coins_month, 5000);
});

// ---------------------------------------------------------- entitlements

test('entitlements: fresh account resolves to free', async () => {
  const { token } = await register('newbie@example.com');
  const { status, body } = await entitlements(token);
  assert.equal(status, 200);
  assert.equal(body.plan.code, 'free');
  assert.equal(body.entitlements.paid_games, false);
  assert.equal(body.usage.coins, 0);
});

test('mock-pay pro activates the pro plan', async () => {
  const { token } = await register('pro@example.com');
  const pay = await mockPay(token, 'pro');
  assert.equal(pay.status, 200);
  assert.equal(pay.body.subscription.plan_code, 'pro');

  const { body } = await entitlements(token);
  assert.equal(body.plan.code, 'pro');
  assert.equal(body.entitlements.tts, true);
  assert.equal(body.entitlements.earn_limit_coins_month, null);
});

test('mock-pay expert switches plan + stacks days', async () => {
  const { token } = await register('vip@example.com');
  await mockPay(token, 'pro');
  const pay2 = await mockPay(token, 'expert');
  assert.equal(pay2.status, 200);
  assert.equal(pay2.body.subscription.plan_code, 'expert');
  // §8.3: days stack without recalculation — ≥ 55 left of 60 paid.
  assert.ok(pay2.body.subscription.days_left >= 55);
});

test('mock-pay rejects unknown or free plan codes', async () => {
  const { token } = await register('bad@example.com');
  const bad = await mockPay(token, 'diamond');
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'UNKNOWN_PLAN');
  const free = await mockPay(token, 'free');
  assert.equal(free.status, 400);
});

test('expired subscription falls back to free entitlements', async () => {
  const { token } = await register('lapsed@example.com');
  await mockPay(token, 'pro');
  await app.inject({
    method: 'POST',
    url: '/api/billing/mock-expire',
    headers: auth(token),
  });
  const { body } = await entitlements(token);
  assert.equal(body.plan.code, 'free');
});

// ------------------------------------------------------------ usage

test('usage report applies once per nonce (idempotent)', async () => {
  const { token } = await register('metered@example.com');
  const month = new Date().toISOString().slice(0, 7);
  const nonce = `n-${Date.now()}`;

  const first = await app.inject({
    method: 'POST',
    url: '/api/usage/report',
    headers: auth(token),
    payload: { month, coins_delta: 100, nonce },
  });
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().applied, true);
  assert.equal(first.json().coins, 100);

  const retry = await app.inject({
    method: 'POST',
    url: '/api/usage/report',
    headers: auth(token),
    payload: { month, coins_delta: 100, nonce },
  });
  assert.equal(retry.json().applied, false);
  assert.equal(retry.json().coins, 100);

  const { body } = await entitlements(token);
  assert.equal(body.usage.coins, 100);
});

test('usage report validates month, delta and nonce', async () => {
  // Each user gets a fresh 2/min budget — split checks across users.
  const { token: t1 } = await register('strict1@example.com');
  const { token: t2 } = await register('strict2@example.com');
  const month = new Date().toISOString().slice(0, 7);
  const post = (token, payload) =>
    app.inject({
      method: 'POST',
      url: '/api/usage/report',
      headers: auth(token),
      payload,
    });
  assert.equal(
    (await post(t1, { month: '1999-01', coins_delta: 1, nonce: 'abcdefgh' })).json().error,
    'INVALID_MONTH'
  );
  assert.equal(
    (await post(t1, { month, coins_delta: 2_000_000, nonce: 'abcdefgh' })).json().error,
    'INVALID_COINS_DELTA'
  );
  assert.equal(
    (await post(t2, { month, coins_delta: -5, nonce: 'abcdefgh' })).json().error,
    'INVALID_COINS_DELTA'
  );
  assert.equal(
    (await post(t2, { month, coins_delta: 1, nonce: 'x' })).json().error,
    'INVALID_NONCE'
  );
});

// ----------------------------------------------------------- free games

test('free-tier users verify only is_free games', async () => {
  const { token } = await register('free@example.com');
  // Catalog JOINs on published_build_id — give each game a build row.
  const insertGame = (slug, isFree) => {
    const now = new Date().toISOString();
    const g = db
      .prepare(
        `INSERT INTO games (slug, title, description, version, file_name, executable_name, status, is_free, updated_at)
         VALUES (?, ?, '', '1.0.0', '', '', 'published', ?, ?)`
      )
      .run(slug, slug, isFree ? 1 : 0, now);
    const b = db
      .prepare(
        `INSERT INTO game_builds (game_id, version, file_name, sha256, size_bytes, created_at)
         VALUES (?, '1.0.0', ?, '', 0, ?)`
      )
      .run(g.lastInsertRowid, `${slug}.zip`, now);
    db.prepare('UPDATE games SET published_build_id = ? WHERE id = ?').run(
      b.lastInsertRowid,
      g.lastInsertRowid
    );
  };
  insertGame('freebie', true);
  insertGame('paidgame', false);

  const verify = (slug) =>
    app.inject({
      method: 'POST',
      url: '/api/license/verify',
      headers: auth(token),
      payload: { hwid: 'HW-free@example.com', game_slug: slug },
    });

  const freeRes = await verify('freebie');
  assert.equal(freeRes.statusCode, 200);
  assert.equal(freeRes.json().allowed, true);

  const paidRes = await verify('paidgame');
  assert.equal(paidRes.statusCode, 403);
  assert.equal(paidRes.json().error, 'SUBSCRIPTION_REQUIRED');
});

test('catalog exposes is_free flags', async () => {
  const { token } = await register('cat@example.com');
  const res = await app.inject({
    method: 'GET',
    url: '/api/games',
    headers: auth(token),
  });
  const freebie = res.json().games.find((g) => g.slug === 'freebie');
  const paid = res.json().games.find((g) => g.slug === 'paidgame');
  assert.equal(freebie.is_free, true);
  assert.equal(paid.is_free, false);
});

// ---------------------------------------------------------------- admin

test('admin set-plan switches effective plan', async () => {
  const { token, user } = await register('switch@example.com');
  await mockPay(token, 'pro');
  const res = await app.inject({
    method: 'POST',
    url: `/api/admin/users/${user.id}/set-plan`,
    headers: auth(adminToken),
    payload: { plan_code: 'expert' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().user.plan_code, 'expert');

  const { body } = await entitlements(token);
  assert.equal(body.plan.code, 'expert');

  const bad = await app.inject({
    method: 'POST',
    url: `/api/admin/users/${user.id}/set-plan`,
    headers: auth(adminToken),
    payload: { plan_code: 'nope' },
  });
  assert.equal(bad.statusCode, 400);
});

test('admin plan CRUD: create, patch, list', async () => {
  const create = await app.inject({
    method: 'POST',
    url: '/api/admin/plans',
    headers: auth(adminToken),
    payload: {
      code: 'vip',
      title: 'VIP',
      price_minor: 99900,
      period_days: 60,
      entitlements: { tts: true, max_presets: 7 },
      sort: 5,
    },
  });
  assert.equal(create.statusCode, 201);
  assert.equal(create.json().plan.entitlements.max_presets, 7);

  const dup = await app.inject({
    method: 'POST',
    url: '/api/admin/plans',
    headers: auth(adminToken),
    payload: { code: 'vip', title: 'x', price_minor: 1 },
  });
  assert.equal(dup.statusCode, 409);

  const patch = await app.inject({
    method: 'PATCH',
    url: '/api/admin/plans/vip',
    headers: auth(adminToken),
    payload: { price_minor: 49900, active: false },
  });
  assert.equal(patch.statusCode, 200);
  assert.equal(patch.json().plan.price_minor, 49900);
  assert.equal(patch.json().plan.active, false);

  // Inactive plans disappear from the public catalog.
  const pub = await app.inject({ method: 'GET', url: '/api/plans' });
  assert.ok(!pub.json().plans.some((p) => p.code === 'vip'));

  const all = await app.inject({
    method: 'GET',
    url: '/api/admin/plans',
    headers: auth(adminToken),
  });
  assert.ok(all.json().plans.some((p) => p.code === 'vip'));
});

test('admin user list carries plan + usage', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/admin/users',
    headers: auth(adminToken),
  });
  const u = res.json().users.find((x) => x.email === 'metered@example.com');
  assert.ok(u);
  assert.equal(u.plan_code, 'free');
  assert.equal(u.usage.coins, 100);
});
