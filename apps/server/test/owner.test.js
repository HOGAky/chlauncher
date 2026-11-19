/**
 * @file owner.test.js
 * Tests for owner-only admin actions (tg-auth-spec §7c): grant-days,
 * set-plan, set-role, plan CRUD and promo codes require an account bound
 * to a Telegram id from OWNER_TG_IDS. Staff admins keep the rest of the
 * admin surface. OWNER_TG_IDS must be set before the app modules load,
 * so everything is imported dynamically inside `before`.
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.ADMIN_EMAILS = 'root@example.com, staff@example.com';
process.env.OWNER_TG_IDS = '424242, 777';

let app;
let db;
let config;
let isOwner;
let syncAdminRole;
let ownerToken;
let staffToken;
const OWNER_TG = 424242;
const OWNER_TG_2 = 777;

const auth = (token) => ({ authorization: `Bearer ${token}` });
const post = (url, token, payload) =>
  app.inject({ method: 'POST', url, headers: auth(token), payload });

async function register(email) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password: 'secret123', hwid: 'HWID-X' },
  });
  return res.json();
}

function bindTg(userId, tgId, username = 'owner') {
  db.prepare(
    `INSERT INTO tg_bindings (user_id, telegram_user_id, telegram_username, bound_at)
     VALUES (?, ?, ?, ?)`
  ).run(userId, tgId, username, new Date().toISOString());
}

before(async () => {
  const { buildApp } = await import('../src/app.js');
  ({ config } = await import('../src/config.js'));
  ({ isOwner, syncAdminRole } = await import('../src/auth.js'));
  ({ app, db } = await buildApp({ databasePath: ':memory:' }));

  const staff = await register('staff@example.com'); // admin, no owner TG
  staffToken = staff.token;
  const owner = await register('root@example.com'); // admin + owner TG
  ownerToken = owner.token;
  bindTg(owner.user.id, OWNER_TG);

  await register('target@example.com'); // grant/set-role target
});

test('isOwner: true only for accounts bound to OWNER_TG_IDS', async () => {
  const owner = db.prepare('SELECT id FROM users WHERE email = ?').get('root@example.com');
  const staff = db.prepare('SELECT id FROM users WHERE email = ?').get('staff@example.com');
  const plain = db.prepare('SELECT id FROM users WHERE email = ?').get('target@example.com');
  assert.equal(isOwner(db, owner.id), true);
  assert.equal(isOwner(db, staff.id), false);
  assert.equal(isOwner(db, plain.id), false);
});

test('staff admin is refused owner-only routes with OWNER_ONLY', async () => {
  const target = db.prepare('SELECT id FROM users WHERE email = ?').get('target@example.com');
  const cases = [
    post(`/api/admin/users/${target.id}/grant-days`, staffToken, { days: 30 }),
    post(`/api/admin/users/${target.id}/set-role`, staffToken, { role: 'publisher' }),
    post(`/api/admin/users/${target.id}/set-plan`, staffToken, { plan_code: 'pro' }),
    post('/api/admin/plans', staffToken, {
      code: 'staff-plan',
      title: 'Nope',
      price_minor: 100,
    }),
    post('/api/admin/promo', staffToken, { code: 'STAFF10', days: 7 }),
  ];
  for (const res of await Promise.all(cases)) {
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error, 'OWNER_ONLY');
  }
  // PATCH plan and DELETE promo are gated the same way.
  const patch = await app.inject({
    method: 'PATCH',
    url: '/api/admin/plans/pro',
    headers: auth(staffToken),
    payload: { title: 'staffed' },
  });
  assert.equal(patch.json().error, 'OWNER_ONLY');
  const del = await app.inject({
    method: 'DELETE',
    url: '/api/admin/promo/SOMECODE',
    headers: auth(staffToken),
  });
  assert.equal(del.json().error, 'OWNER_ONLY');
});

test('staff admin keeps non-owner admin routes', async () => {
  const target = db.prepare('SELECT id, email FROM users WHERE email = ?').get(
    'target@example.com'
  );
  const res = await post(`/api/admin/users/${target.id}/reset-hwid`, staffToken, {});
  assert.equal(res.statusCode, 200);
  const list = await app.inject({
    method: 'GET',
    url: '/api/admin/users?query=target',
    headers: auth(staffToken),
  });
  assert.equal(list.statusCode, 200);
  assert.ok(list.json().users.some((u) => u.id === target.id));
});

test('owner passes owner-only routes', async () => {
  const target = db.prepare('SELECT id FROM users WHERE email = ?').get('target@example.com');
  const res = await post(`/api/admin/users/${target.id}/grant-days`, ownerToken, {
    days: 14,
    comment: 'tester grant',
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().ok, true);
  const plan = await post('/api/admin/plans', ownerToken, {
    code: 'tester',
    title: 'Tester',
    price_minor: 0,
  });
  assert.equal(plan.statusCode, 201);
});

test('admin users list exposes the owner flag', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/admin/users',
    headers: auth(staffToken),
  });
  const users = res.json().users;
  const owner = users.find((u) => u.email === 'root@example.com');
  const staff = users.find((u) => u.email === 'staff@example.com');
  assert.equal(owner.owner, true);
  assert.equal(staff.owner, false);
});

test('owner TG binding auto-promotes to admin on role sync', async () => {
  const reg = await register('owner2@example.com');
  assert.equal(reg.user.role, 'user');
  bindTg(reg.user.id, OWNER_TG_2, 'owner2');
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(reg.user.id);
  syncAdminRole(db, user);
  assert.equal(user.role, 'admin');
  // And the new owner account can actually grant.
  const target = db.prepare('SELECT id FROM users WHERE email = ?').get('target@example.com');
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: 'owner2@example.com', password: 'secret123', hwid: 'HWID-Y' },
  });
  assert.equal(login.statusCode, 200);
  const res = await post(
    `/api/admin/users/${target.id}/grant-days`,
    login.json().token,
    { days: 1 }
  );
  assert.equal(res.statusCode, 200);
});

test('unbound regular user is not owner even with a matching Telegram username', async () => {
  // tg_bindings rows are keyed by telegram_user_id — a lookalike username
  // on another account must not matter.
  const reg = await register('lookalike@example.com');
  db.prepare(
    `INSERT INTO tg_bindings (user_id, telegram_user_id, telegram_username, bound_at)
     VALUES (?, 999999, 'owner', ?)`
  ).run(reg.user.id, new Date().toISOString());
  assert.equal(isOwner(db, reg.user.id), false);
});

test('empty OWNER_TG_IDS falls back to legacy any-admin behaviour', async () => {
  const saved = [...config.ownerTgIds];
  try {
    config.ownerTgIds.clear();
    const target = db
      .prepare('SELECT id FROM users WHERE email = ?')
      .get('target@example.com');
    const res = await post(`/api/admin/users/${target.id}/grant-days`, staffToken, {
      days: 1,
    });
    assert.equal(res.statusCode, 200);
    // isOwner reports false for everyone while the set is empty.
    const owner = db
      .prepare('SELECT id FROM users WHERE email = ?')
      .get('root@example.com');
    assert.equal(isOwner(db, owner.id), false);
  } finally {
    for (const id of saved) config.ownerTgIds.add(id);
  }
});

test('non-admin still gets FORBIDDEN on owner-only routes', async () => {
  const reg = await register('plain2@example.com');
  const target = db.prepare('SELECT id FROM users WHERE email = ?').get('target@example.com');
  const res = await post(`/api/admin/users/${target.id}/grant-days`, reg.token, {
    days: 30,
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'FORBIDDEN');
});
