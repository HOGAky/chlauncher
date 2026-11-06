/**
 * @file billing.test.js
 * Subscription-granting tests (spec §5): manual grant-days via the admin
 * API, payments ledger rows, stacking semantics, audit entries, and
 * recordPayment idempotency. Webhook coverage lands in stage 4.
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

async function grantDays(userId, days, comment) {
  const res = await app.inject({
    method: 'POST',
    url: `/api/admin/users/${userId}/grant-days`,
    headers: auth(adminToken),
    payload: { days, comment },
  });
  return res;
}

before(async () => {
  const { buildApp } = await import('../src/app.js');
  ({ app, db } = await buildApp({ databasePath: ':memory:' }));
  adminToken = (await register('admin@example.com')).token;
});

test('grant-days activates an expired subscription (+30)', async () => {
  const { user } = await register('exp@example.com');
  const res = await grantDays(user.id, 30, 'paid by invoice');
  assert.equal(res.statusCode, 200);
  const sub = res.json().subscription;
  assert.equal(sub.status, 'active');
  assert.ok(sub.days_left >= 29 && sub.days_left <= 30);

  const pay = db
    .prepare("SELECT * FROM payments WHERE user_id = ? AND provider = 'manual'")
    .get(user.id);
  assert.ok(pay);
  assert.equal(pay.days, 30);
  assert.equal(pay.actor_id, 1);
  assert.equal(pay.status, 'succeeded');
});

test('grant-days stacks onto remaining active period', async () => {
  const { user, token } = await register('act@example.com');
  await app.inject({
    method: 'POST',
    url: '/api/billing/mock-pay',
    headers: auth(token),
  });
  const before1 = db
    .prepare('SELECT current_period_end FROM subscriptions WHERE user_id = ?')
    .get(user.id).current_period_end;

  const res = await grantDays(user.id, 15);
  const after1 = res.json().subscription.current_period_end;
  const deltaMs = new Date(after1) - new Date(before1);
  assert.ok(
    deltaMs >= 14 * 86400000 && deltaMs <= 16 * 86400000,
    `expected ~15d extension, got ${deltaMs / 86400000}d`
  );
});

test('grant-days writes admin_audit entry with comment', async () => {
  const { user } = await register('aud@example.com');
  await grantDays(user.id, 7, 'promo week');
  const row = db
    .prepare("SELECT * FROM admin_audit WHERE action = 'grant_days' ORDER BY id DESC LIMIT 1")
    .get();
  assert.ok(row);
  assert.equal(row.target, 'aud@example.com');
  const meta = JSON.parse(row.meta);
  assert.equal(meta.days, 7);
  assert.equal(meta.comment, 'promo week');
});

test('grant-days rejects non-admins and invalid days', async () => {
  const { user, token } = await register('nope@example.com');
  const forbidden = await app.inject({
    method: 'POST',
    url: `/api/admin/users/${user.id}/grant-days`,
    headers: auth(token),
    payload: { days: 30 },
  });
  assert.equal(forbidden.statusCode, 403);

  const bad = await grantDays(user.id, 0);
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error, 'INVALID_DAYS');
});

test('recordPayment is idempotent on (provider, external_id)', async () => {
  const { recordPayment } = await import('../src/subscriptions.js');
  const { user } = await register('idem@example.com');
  const args = {
    userId: user.id,
    provider: 'yookassa',
    externalId: 'pay-123',
    days: 30,
  };
  const first = recordPayment(db, args);
  const second = recordPayment(db, args);
  assert.equal(first.applied, true);
  assert.equal(second.applied, false);
  // One payment row, one 30-day extension (not 60).
  const count = db
    .prepare('SELECT COUNT(*) c FROM payments WHERE external_id = ?')
    .get('pay-123').c;
  assert.equal(count, 1);
  const sub = db
    .prepare('SELECT current_period_end FROM subscriptions WHERE user_id = ?')
    .get(user.id);
  const days = (new Date(sub.current_period_end) - Date.now()) / 86400000;
  assert.ok(days > 29 && days < 31, `expected ~30d, got ${days}`);
});
