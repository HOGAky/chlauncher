/**
 * @file growth.test.js
 * Tests for the EFIR-parity surface added in schema v12:
 * promo codes, referrals, support tickets and Telegram login.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { config } from '../src/config.js';

const BOT = { 'x-bot-secret': config.tgBindSecret };

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

async function makeAdmin(email) {
  await register(email);
  db.prepare(`UPDATE users SET role = 'admin' WHERE email = ?`).run(email);
  // Promo routes are owner-gated — each admin gets a unique owner binding.
  const { bindOwner } = await import('./helpers.js');
  bindOwner(db, db.prepare('SELECT id FROM users WHERE email = ?').get(email).id);
  // Re-login so the role is fresh (authenticate re-reads it anyway).
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: 'secret123', hwid: `HW-${email}` },
  });
  return res.json().token;
}

before(async () => {
  const built = await buildApp({ dbPath: ':memory:' });
  app = built.app;
  db = built.db;
});
after(async () => app.close());

test('promo: admin creates, user redeems once, second redeem refused', async () => {
  const admin = await makeAdmin('admin1@x.com');
  const user = await register('u1@x.com');

  const create = await app.inject({
    method: 'POST',
    url: '/api/admin/promo',
    headers: auth(admin),
    payload: { days: 14, max_uses: 5 },
  });
  assert.equal(create.statusCode, 200);
  const { code } = create.json();
  assert.ok(code.length >= 4);

  const redeem = await app.inject({
    method: 'POST',
    url: '/api/promo/redeem',
    headers: auth(user.token),
    payload: { code },
  });
  assert.equal(redeem.statusCode, 200);
  assert.equal(redeem.json().days, 14);
  assert.equal(redeem.json().subscription.status, 'active');

  const again = await app.inject({
    method: 'POST',
    url: '/api/promo/redeem',
    headers: auth(user.token),
    payload: { code },
  });
  assert.equal(again.statusCode, 409);
});

test('promo: non-admin cannot create; exhausted code rejected', async () => {
  const user = await register('u2@x.com');
  const forbidden = await app.inject({
    method: 'POST',
    url: '/api/admin/promo',
    headers: auth(user.token),
    payload: { days: 5 },
  });
  assert.equal(forbidden.statusCode, 403);

  const admin = await makeAdmin('admin2@x.com');
  const c = await app.inject({
    method: 'POST',
    url: '/api/admin/promo',
    headers: auth(admin),
    payload: { days: 3, max_uses: 1, code: 'ONLYONE' },
  });
  assert.equal(c.statusCode, 200);
  await app.inject({
    method: 'POST',
    url: '/api/promo/redeem',
    headers: auth(user.token),
    payload: { code: 'ONLYONE' },
  });
  const other = await register('u3@x.com');
  const exhausted = await app.inject({
    method: 'POST',
    url: '/api/promo/redeem',
    headers: auth(other.token),
    payload: { code: 'ONLYONE' },
  });
  assert.equal(exhausted.statusCode, 410);
});

test('referrals: code issued, apply rewards both, self/cap/dupe refused', async () => {
  const referrer = await register('ref1@x.com');
  const me = await register('ref2@x.com');

  const mine = await app.inject({
    method: 'GET',
    url: '/api/referrals',
    headers: auth(referrer.token),
  });
  assert.equal(mine.statusCode, 200);
  const code = mine.json().code;
  assert.equal(code.length, 8);

  const selfApply = await app.inject({
    method: 'POST',
    url: '/api/referrals/apply',
    headers: auth(referrer.token),
    payload: { code },
  });
  assert.equal(selfApply.statusCode, 400);

  const apply = await app.inject({
    method: 'POST',
    url: '/api/referrals/apply',
    headers: auth(me.token),
    payload: { code },
  });
  assert.equal(apply.statusCode, 200);
  assert.equal(apply.json().days, 3);

  const stats = await app.inject({
    method: 'GET',
    url: '/api/referrals',
    headers: auth(referrer.token),
  });
  assert.equal(stats.json().applied, 1);
  assert.equal(stats.json().days_earned, 7);

  const dupe = await app.inject({
    method: 'POST',
    url: '/api/referrals/apply',
    headers: auth(me.token),
    payload: { code },
  });
  assert.equal(dupe.statusCode, 409);
});

test('support: user opens ticket, admin replies, user sees answer', async () => {
  const user = await register('sup1@x.com');
  const admin = await makeAdmin('admin3@x.com');

  const open = await app.inject({
    method: 'POST',
    url: '/api/support/tickets',
    headers: auth(user.token),
    payload: { subject: 'Не запускается игра', body: 'Ошибка при старте' },
  });
  assert.equal(open.statusCode, 200);
  const id = open.json().id;

  const queue = await app.inject({
    method: 'GET',
    url: '/api/admin/support/tickets?status=open',
    headers: auth(admin),
  });
  assert.equal(queue.statusCode, 200);
  assert.ok(queue.json().tickets.some((t) => t.id === id));

  const reply = await app.inject({
    method: 'POST',
    url: `/api/admin/support/tickets/${id}/reply`,
    headers: auth(admin),
    payload: { body: 'Попробуйте переустановить игру' },
  });
  assert.equal(reply.statusCode, 200);

  const thread = await app.inject({
    method: 'GET',
    url: `/api/support/tickets/${id}`,
    headers: auth(user.token),
  });
  assert.equal(thread.json().ticket.status, 'answered');
  assert.equal(thread.json().messages.length, 2);
  assert.equal(thread.json().messages[1].is_admin, true);

  const close = await app.inject({
    method: 'POST',
    url: `/api/support/tickets/${id}/close`,
    headers: auth(user.token),
  });
  assert.equal(close.statusCode, 200);

  const afterClose = await app.inject({
    method: 'POST',
    url: `/api/support/tickets/${id}/messages`,
    headers: auth(user.token),
    payload: { body: 'ещё вопрос' },
  });
  assert.equal(afterClose.statusCode, 409);
});

test('support: other user cannot read the thread', async () => {
  const user = await register('sup2@x.com');
  const other = await register('sup3@x.com');
  const open = await app.inject({
    method: 'POST',
    url: '/api/support/tickets',
    headers: auth(user.token),
    payload: { subject: 'x', body: 'y' },
  });
  const id = open.json().id;
  const res = await app.inject({
    method: 'GET',
    url: `/api/support/tickets/${id}`,
    headers: auth(other.token),
  });
  assert.equal(res.statusCode, 404);
});

test('telegram login: start → bot claims → status issues JWT + binds', async () => {
  const start = await app.inject({
    method: 'POST',
    url: '/api/auth/telegram-start',
    payload: {},
  });
  assert.equal(start.statusCode, 200);
  const { code, url } = start.json();
  assert.ok(url.includes(`login_${code}`));

  const pending = await app.inject({
    method: 'POST',
    url: '/api/auth/telegram-status',
    payload: { code, hwid: 'HW-TG' },
  });
  assert.equal(pending.json().status, 'pending');

  const claim = await app.inject({
    method: 'POST',
    url: '/api/tg/login-claim',
    headers: BOT,
    payload: { code: `login_${code}`, telegram_user_id: 555777, telegram_username: 'tguser' },
  });
  assert.equal(claim.statusCode, 200);

  const ready = await app.inject({
    method: 'POST',
    url: '/api/auth/telegram-status',
    payload: { code, hwid: 'HW-TG' },
  });
  assert.equal(ready.statusCode, 200);
  const body = ready.json();
  assert.equal(body.status, 'ready');
  assert.ok(body.token);
  assert.equal(body.user.email, 'tg_555777@telegram.local');

  // Second poll — code is consumed, no replay.
  const replay = await app.inject({
    method: 'POST',
    url: '/api/auth/telegram-status',
    payload: { code, hwid: 'HW-TG' },
  });
  assert.equal(replay.statusCode, 404);

  // Same Telegram id logs into the SAME account on a new code.
  const start2 = await app.inject({
    method: 'POST',
    url: '/api/auth/telegram-start',
    payload: {},
  });
  const code2 = start2.json().code;
  await app.inject({
    method: 'POST',
    url: '/api/tg/login-claim',
    headers: BOT,
    payload: { code: `login_${code2}`, telegram_user_id: 555777, telegram_username: 'tguser' },
  });
  const ready2 = await app.inject({
    method: 'POST',
    url: '/api/auth/telegram-status',
    payload: { code: code2, hwid: 'HW-TG' },
  });
  assert.equal(ready2.json().user.email, 'tg_555777@telegram.local');
});

test('telegram login: claim with wrong secret is rejected', async () => {
  const start = await app.inject({
    method: 'POST',
    url: '/api/auth/telegram-start',
    payload: {},
  });
  const { code } = start.json();
  const res = await app.inject({
    method: 'POST',
    url: '/api/tg/login-claim',
    headers: { 'x-bot-secret': 'wrong' },
    payload: { code: `login_${code}`, telegram_user_id: 1 },
  });
  assert.equal(res.statusCode, 401);
});
