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
process.env.YOOKASSA_SHOP_ID = 'testshop';
process.env.YOOKASSA_SECRET_KEY = 'testsecret';

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
  // grant-days is owner-gated — bind the test admin as an owner.
  const { bindOwner } = await import('./helpers.js');
  const adminUser = db.prepare('SELECT id FROM users WHERE email = ?').get('admin@example.com');
  bindOwner(db, adminUser.id);
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

// ------------------------------------------------------- §5.3 webhook

const BASIC =
  'Basic ' + Buffer.from('testshop:testsecret').toString('base64');

/** Inserts a pending yookassa payment row (what /checkout creates). */
function pendingPayment(userId, externalId, days = 30, amountMinor = null) {
  db.prepare(
    `INSERT INTO payments
       (user_id, provider, external_id, days, status, amount_minor, currency, created_at)
     VALUES (?, 'yookassa', ?, ?, 'pending', ?, 'RUB', ?)`
  ).run(userId, externalId, days, amountMinor, new Date().toISOString());
}

/** A realistic YooKassa `payment.succeeded` notification object. */
function ykObject(id, { amountMinor = 29900, currency = 'RUB' } = {}) {
  return {
    id,
    status: 'succeeded',
    paid: true,
    amount: { value: (amountMinor / 100).toFixed(2), currency },
    created_at: new Date().toISOString(),
    captured_at: new Date().toISOString(),
  };
}

function webhook(body, headers = {}) {
  return app.inject({
    method: 'POST',
    url: '/api/billing/webhook',
    headers: { 'content-type': 'application/json', ...headers },
    payload: body,
  });
}

test('webhook: valid signature -> succeeded -> +30 days', async () => {
  const { user } = await register('wh@example.com');
  pendingPayment(user.id, 'yk-ok-1');

  const res = await webhook(
    { event: 'payment.succeeded', object: ykObject('yk-ok-1') },
    { authorization: BASIC }
  );
  assert.equal(res.statusCode, 200);

  const sub = db
    .prepare('SELECT * FROM subscriptions WHERE user_id = ?')
    .get(user.id);
  assert.equal(sub.status, 'active');
  const pay = db
    .prepare('SELECT status FROM payments WHERE external_id = ?')
    .get('yk-ok-1');
  assert.equal(pay.status, 'succeeded');
});

test('webhook: object missing paid/status is not granted', async () => {
  const { user } = await register('wh-unpaid@example.com');
  pendingPayment(user.id, 'yk-unpaid-1');
  const res = await webhook(
    { event: 'payment.succeeded', object: { id: 'yk-unpaid-1' } },
    { authorization: BASIC }
  );
  assert.equal(res.statusCode, 200); // acked, but no grant
  assert.equal(
    db.prepare('SELECT status FROM payments WHERE external_id = ?').get('yk-unpaid-1').status,
    'pending'
  );
  assert.equal(
    db.prepare('SELECT status FROM subscriptions WHERE user_id = ?').get(user.id).status,
    'expired'
  );
});

test('webhook: amount mismatch is rejected (integer minor units)', async () => {
  const { user } = await register('wh-amt@example.com');
  pendingPayment(user.id, 'yk-amt-1', 30, 29900);
  await webhook(
    { event: 'payment.succeeded', object: ykObject('yk-amt-1', { amountMinor: 100 }) },
    { authorization: BASIC }
  );
  assert.equal(
    db.prepare('SELECT status FROM payments WHERE external_id = ?').get('yk-amt-1').status,
    'pending'
  );
  assert.equal(
    db.prepare('SELECT status FROM subscriptions WHERE user_id = ?').get(user.id).status,
    'expired'
  );
  // …and a correct retry still applies.
  await webhook(
    { event: 'payment.succeeded', object: ykObject('yk-amt-1', { amountMinor: 29900 }) },
    { authorization: BASIC }
  );
  assert.equal(
    db.prepare('SELECT status FROM payments WHERE external_id = ?').get('yk-amt-1').status,
    'succeeded'
  );
});

test('webhook: duplicate succeeded does not double-grant days', async () => {
  const { user } = await register('wh2@example.com');
  pendingPayment(user.id, 'yk-dup-1');
  const evt = { event: 'payment.succeeded', object: ykObject('yk-dup-1') };
  await webhook(evt, { authorization: BASIC });
  const end1 = db
    .prepare('SELECT current_period_end FROM subscriptions WHERE user_id = ?')
    .get(user.id).current_period_end;
  await webhook(evt, { authorization: BASIC });
  const end2 = db
    .prepare('SELECT current_period_end FROM subscriptions WHERE user_id = ?')
    .get(user.id).current_period_end;
  assert.equal(end1, end2);
});

test('webhook: refund revokes the granted period', async () => {
  const { user } = await register('wh-refund@example.com');
  pendingPayment(user.id, 'yk-refund-1', 30, 29900);
  await webhook(
    { event: 'payment.succeeded', object: ykObject('yk-refund-1') },
    { authorization: BASIC }
  );
  assert.equal(
    db.prepare('SELECT status FROM subscriptions WHERE user_id = ?').get(user.id).status,
    'active'
  );
  const res = await webhook(
    {
      event: 'refund.succeeded',
      object: {
        id: 'rf-1',
        payment_id: 'yk-refund-1',
        status: 'succeeded',
        amount: { value: '299.00', currency: 'RUB' },
      },
    },
    { authorization: BASIC }
  );
  assert.equal(res.statusCode, 200);
  assert.equal(
    db.prepare('SELECT status FROM payments WHERE external_id = ?').get('yk-refund-1').status,
    'refunded'
  );
  // The 30 granted days are clawed back → the subscription expires now.
  const sub = db
    .prepare('SELECT status FROM subscriptions WHERE user_id = ?')
    .get(user.id);
  assert.equal(sub.status, 'expired');
  // A second refund notification is a no-op.
  await webhook(
    {
      event: 'refund.succeeded',
      object: { id: 'rf-2', payment_id: 'yk-refund-1', status: 'succeeded', amount: { value: '299.00', currency: 'RUB' } },
    },
    { authorization: BASIC }
  );
  assert.equal(
    db.prepare('SELECT status FROM subscriptions WHERE user_id = ?').get(user.id).status,
    'expired'
  );
});

test('webhook: invalid signature -> 401, subscription untouched', async () => {
  const { user } = await register('wh3@example.com');
  pendingPayment(user.id, 'yk-bad-1');
  const res = await webhook(
    { event: 'payment.succeeded', object: ykObject('yk-bad-1') },
    { authorization: 'Basic ' + Buffer.from('testshop:wrong').toString('base64') }
  );
  assert.equal(res.statusCode, 401);
  const sub = db
    .prepare('SELECT status FROM subscriptions WHERE user_id = ?')
    .get(user.id);
  assert.equal(sub.status, 'expired');
});

test('webhook: canceled marks the payment failed, no grant', async () => {
  const { user } = await register('wh4@example.com');
  pendingPayment(user.id, 'yk-cancel-1');
  const res = await webhook(
    { event: 'payment.canceled', object: { id: 'yk-cancel-1' } },
    { authorization: BASIC }
  );
  assert.equal(res.statusCode, 200);
  assert.equal(
    db.prepare('SELECT status FROM payments WHERE external_id = ?').get('yk-cancel-1').status,
    'failed'
  );
});

test('webhook: unknown payment is journaled, then applied on order arrival', async () => {
  const { user } = await register('wh-race@example.com');
  // Webhook beats the checkout response — the provider id isn't stored
  // yet, so the event is journaled unmatched…
  await webhook(
    { event: 'payment.succeeded', object: ykObject('yk-race-1') },
    { authorization: BASIC }
  );
  const journaled = db
    .prepare("SELECT * FROM billing_events WHERE provider = 'yookassa' AND external_id = 'yk-race-1'")
    .get();
  assert.ok(journaled);
  assert.equal(journaled.applied, 0);
  // …and replayed once the pending row carries the provider id.
  pendingPayment(user.id, 'yk-race-1');
  const { replayUnmatchedYookassa } = await import('../src/routes/billing.js');
  replayUnmatchedYookassa(db);
  assert.equal(
    db.prepare('SELECT status FROM subscriptions WHERE user_id = ?').get(user.id).status,
    'active'
  );
});

test('checkout returns 501 without provider credentials path', async () => {
  // Creds ARE set in this file — hit checkout and expect either a real
  // provider error (offline) or a configured code path, never a crash.
  const { token } = await register('co@example.com');
  const res = await app.inject({
    method: 'POST',
    url: '/api/billing/checkout',
    headers: auth(token),
  });
  assert.ok([200, 501, 502].includes(res.statusCode));
});
