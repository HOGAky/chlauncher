/**
 * @file tribute.test.js
 * Tribute (Telegram) provider tests: webhook signature verification,
 * account binding via one-shot codes, unmatched-event replay on bind,
 * idempotent period grants, cancellation capping, and unbind.
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.TRIBUTE_API_KEY = 'trb-test-key';
process.env.TRIBUTE_BOT_URL = 'https://t.me/testbind_bot?start=';
process.env.TG_BIND_SECRET = 'bind-test-secret';
process.env.TRIBUTE_PRODUCT_LINKS = JSON.stringify({ pro: 'https://t.me/tribute?startapp=pro' });
process.env.TRIBUTE_PLAN_MAP = JSON.stringify({ '1644': 'pro' });

const KEY = process.env.TRIBUTE_API_KEY;
const SECRET = process.env.TG_BIND_SECRET;
const BOT = { 'x-bot-secret': SECRET };

let app;
let db;

const auth = (t) => ({ authorization: `Bearer ${t}` });

async function register(email) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password: 'secret123', hwid: `HW-${email}` },
  });
  return res.json();
}

/** Sends a webhook with a valid (or forged) trbt-signature. */
function webhook(body, sig) {
  const raw = JSON.stringify(body);
  const signature =
    sig ?? crypto.createHmac('sha256', KEY).update(raw).digest('hex');
  return app.inject({
    method: 'POST',
    url: '/api/billing/tribute/webhook',
    headers: {
      'content-type': 'application/json',
      'trbt-signature': signature,
    },
    payload: body,
  });
}

const subEvent = (name, over = {}) => ({
  name,
  created_at: new Date().toISOString(),
  sent_at: new Date().toISOString(),
  payload: {
    subscription_name: 'chlauncher Pro',
    subscription_id: 1644,
    period_id: 1547,
    period: 'monthly',
    type: 'regular',
    price: 29900,
    amount: 27000,
    currency: 'rub',
    trb_user_id: 'T-777',
    telegram_user_id: 555000111,
    telegram_username: 'tester',
    channel_id: 61,
    channel_name: 'chlauncher',
    expires_at: new Date(Date.now() + 30 * 86400000).toISOString(),
    ...over,
  },
});

async function linkCode(token, planCode) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/tg/link-code',
    headers: auth(token),
    payload: planCode ? { plan_code: planCode } : {},
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json();
}

async function bind(code, tgId, tgName = 'tester', headers = BOT) {
  return app.inject({
    method: 'POST',
    url: '/api/tg/bind',
    headers: { 'content-type': 'application/json', ...headers },
    payload: { code, telegram_user_id: tgId, telegram_username: tgName },
  });
}

const subOf = (userId) =>
  db.prepare('SELECT * FROM subscriptions WHERE user_id = ?').get(userId);

before(async () => {
  const { buildApp } = await import('../src/app.js');
  ({ app, db } = await buildApp({ databasePath: ':memory:' }));
});

// ------------------------------------------------------- signature gate

test('webhook: 401 on bad/missing signature', async () => {
  const evt = subEvent('new_subscription');
  const bad = await webhook(evt, 'deadbeef');
  assert.equal(bad.statusCode, 401);
  const none = await app.inject({
    method: 'POST',
    url: '/api/billing/tribute/webhook',
    headers: { 'content-type': 'application/json' },
    payload: evt,
  });
  assert.equal(none.statusCode, 401);
});

// --------------------------------------------------- unmatched → replay

test('paid event before binding is journaled, then applied on bind', async () => {
  const { user, token } = await register('trb1@example.com');
  const res = await webhook(subEvent('new_subscription', { telegram_user_id: 900001 }));
  assert.equal(res.statusCode, 200);
  // No binding yet — the event is parked, nothing granted.
  assert.equal(subOf(user.id).status, 'expired');
  const parked = db
    .prepare('SELECT * FROM billing_events WHERE telegram_user_id = 900001')
    .get();
  assert.ok(parked);
  assert.equal(parked.applied, 0);

  const { code, bot_url } = await linkCode(token, 'pro');
  assert.ok(bot_url.endsWith(code));
  const b = await bind(code, 900001);
  assert.equal(b.statusCode, 200);
  assert.equal(b.json().applied_events, 1);
  assert.equal(b.json().product_url, 'https://t.me/tribute?startapp=pro');

  const sub = subOf(user.id);
  assert.equal(sub.status, 'active');
  assert.equal(sub.plan_code, 'pro');
  const days = (new Date(sub.current_period_end) - Date.now()) / 86400000;
  assert.ok(days > 29 && days < 31, `expected ~30d, got ${days}`);
  assert.equal(
    db.prepare('SELECT applied FROM billing_events WHERE id = ?').get(parked.id).applied,
    1
  );
});

// ---------------------------------------------------------- happy path

test('bound user: new_subscription activates, retries dedupe', async () => {
  const { user, token } = await register('trb2@example.com');
  const { code } = await linkCode(token);
  assert.equal((await bind(code, 900002)).statusCode, 200);

  const evt = subEvent('new_subscription', { telegram_user_id: 900002 });
  assert.equal((await webhook(evt)).statusCode, 200);
  const end1 = subOf(user.id).current_period_end;
  assert.equal(subOf(user.id).status, 'active');

  // Same event redelivered → same external_id → no double grant.
  assert.equal((await webhook(evt)).statusCode, 200);
  assert.equal(subOf(user.id).current_period_end, end1);
  const ledger = db
    .prepare("SELECT COUNT(*) c FROM payments WHERE provider = 'tribute' AND user_id = ?")
    .get(user.id).c;
  assert.equal(ledger, 1);
});

test('renewed_subscription extends the period', async () => {
  const { user, token } = await register('trb3@example.com');
  const { code } = await linkCode(token);
  await bind(code, 900003);
  await webhook(subEvent('new_subscription', { telegram_user_id: 900003 }));
  const end1 = subOf(user.id).current_period_end;

  await webhook(
    subEvent('renewed_subscription', {
      telegram_user_id: 900003,
      expires_at: new Date(Date.now() + 60 * 86400000).toISOString(),
    })
  );
  const end2 = subOf(user.id).current_period_end;
  const delta = (new Date(end2) - new Date(end1)) / 86400000;
  assert.ok(delta > 29 && delta < 31, `expected +~30d, got ${delta}`);
  assert.equal(subOf(user.id).auto_renew, 1);
});

test('cancelled_subscription stops auto-renew, keeps paid time', async () => {
  const { user, token } = await register('trb4@example.com');
  const { code } = await linkCode(token);
  await bind(code, 900004);
  await webhook(subEvent('new_subscription', { telegram_user_id: 900004 }));
  const paidEnd = subOf(user.id).current_period_end;

  const res = await webhook(
    subEvent('cancelled_subscription', {
      telegram_user_id: 900004,
      expires_at: paidEnd,
      cancel_reason: 'user',
    })
  );
  assert.equal(res.statusCode, 200);
  const sub = subOf(user.id);
  assert.equal(sub.auto_renew, 0);
  assert.equal(sub.current_period_end, paidEnd); // paid time kept
});

test('cancelled with earlier expires_at caps the paid period', async () => {
  const { user, token } = await register('trb5@example.com');
  const { code } = await linkCode(token);
  await bind(code, 900005);
  await webhook(subEvent('new_subscription', { telegram_user_id: 900005 }));

  const early = new Date(Date.now() + 5 * 86400000).toISOString();
  await webhook(
    subEvent('cancelled_subscription', {
      telegram_user_id: 900005,
      expires_at: early,
      cancel_reason: 'chargeback',
    })
  );
  assert.equal(subOf(user.id).current_period_end, early);
});

// ------------------------------------------------------------- binding

test('link-code is one-shot and expires; bind needs the secret', async () => {
  const { token } = await register('trb6@example.com');
  const { code } = await linkCode(token);

  const noAuth = await bind(code, 900006, 'tester', { 'x-bot-secret': 'wrong' });
  assert.equal(noAuth.statusCode, 401);

  assert.equal((await bind(code, 900006)).statusCode, 200);
  // Same code again → already consumed.
  const again = await bind(code, 900006);
  assert.equal(again.statusCode, 410);
});

test('rebind moves the telegram id to the latest account', async () => {
  const a = await register('trb7a@example.com');
  const b = await register('trb7b@example.com');

  const c1 = await linkCode(a.token);
  assert.equal((await bind(c1.code, 900007)).statusCode, 200);
  assert.ok(
    db.prepare('SELECT user_id FROM tg_bindings WHERE telegram_user_id = 900007').get()
  );

  const c2 = await linkCode(b.token);
  assert.equal((await bind(c2.code, 900007)).statusCode, 200);
  const row = db
    .prepare('SELECT user_id FROM tg_bindings WHERE telegram_user_id = 900007')
    .get();
  assert.equal(row.user_id, b.user.id);
  // Old account lost the binding.
  assert.equal(
    db.prepare('SELECT COUNT(*) c FROM tg_bindings WHERE user_id = ?').get(a.user.id).c,
    0
  );
});

test('status/unbind reflect and clear the binding', async () => {
  const { user, token } = await register('trb8@example.com');
  const { code } = await linkCode(token);
  await bind(code, 900008, 'bounduser');

  const st = await app.inject({ method: 'GET', url: '/api/tg/status', headers: auth(token) });
  assert.equal(st.json().bound, true);
  assert.equal(st.json().telegram_username, 'bounduser');

  const un = await app.inject({
    method: 'POST',
    url: '/api/tg/unbind',
    headers: auth(token),
    payload: {},
  });
  assert.equal(un.statusCode, 200);
  assert.equal(
    db.prepare('SELECT COUNT(*) c FROM tg_bindings WHERE user_id = ?').get(user.id).c,
    0
  );
});

test('providers endpoint reports configured rails', async () => {
  const { token } = await register('trb9@example.com');
  const res = await app.inject({
    method: 'GET',
    url: '/api/billing/providers',
    headers: auth(token),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().tribute, true);
});
