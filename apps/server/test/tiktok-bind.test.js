/**
 * @file tiktok-bind.test.js
 * TikTok account binding: bio-code issuance, verification against a
 * stubbed profile fetch, username-taken conflicts, expiry, rebind and
 * unbind semantics.
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';

const { buildApp } = await import('../src/app.js');

let app;
let db;
/** Mutable bio per username — tests steer the stub between calls. */
const bios = new Map();

const auth = (t) => ({ authorization: `Bearer ${t}` });

async function register(email) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password: 'secret123', hwid: `HW-${email}` },
  });
  return res.json();
}

const bind = (t, username) =>
  app.inject({
    method: 'POST',
    url: '/api/tiktok/bind',
    headers: auth(t),
    payload: { username },
  }).then((r) => ({ code: r.statusCode, body: r.json() }));

const verify = (t) =>
  app.inject({
    method: 'POST',
    url: '/api/tiktok/verify',
    headers: auth(t),
    payload: {},
  }).then((r) => ({ code: r.statusCode, body: r.json() }));

const status = (t) =>
  app
    .inject({ method: 'GET', url: '/api/tiktok/bind', headers: auth(t) })
    .then((r) => r.json());

before(async () => {
  ({ app, db } = await buildApp({
    tiktokFetchBio: async (username) => {
      if (!bios.has(username)) return { ok: false, error: 'USER_NOT_FOUND' };
      return {
        ok: true,
        bio: bios.get(username),
        nickname: username,
        avatar: '',
        follower_count: 42,
      };
    },
  }));
});

test('bind issues a code and status exposes it while unverified', async () => {
  const { token } = await register('bind1@test.dev');
  const r = await bind(token, 'streamer_one');
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(r.body.username, 'streamer_one');
  assert.equal(r.body.verified, false);
  assert.match(r.body.code, /^[A-Z2-9]{8}$/);
  const s = await status(token);
  assert.equal(s.bound, true);
  assert.equal(s.code, r.body.code);
});

test('verify flips verified once the code lands in the bio', async () => {
  const { token } = await register('bind2@test.dev');
  const r = await bind(token, 'streamer_two');
  assert.equal(r.code, 200);

  bios.set('streamer_two', 'playing games');
  const early = await verify(token);
  assert.equal(early.code, 400);
  assert.equal(early.body.error, 'CODE_NOT_IN_BIO');

  bios.set('streamer_two', `code is ${r.body.code} ✓`);
  const ok = await verify(token);
  assert.equal(ok.code, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.verified, true);
  assert.equal(ok.body.nickname, 'streamer_two');
  assert.equal(ok.body.follower_count, 42);
  // Code wiped — a status call no longer leaks it.
  const s = await status(token);
  assert.equal(s.verified, true);
  assert.equal(s.code, null);
});

test('a username verified by one account cannot be claimed by another', async () => {
  const a = await register('bind3a@test.dev');
  const b = await register('bind3b@test.dev');
  const r = await bind(a.token, 'taken_name');
  bios.set('taken_name', r.body.code);
  assert.equal((await verify(a.token)).code, 200);

  const clash = await bind(b.token, 'taken_name');
  assert.equal(clash.code, 409);
  assert.equal(clash.body.error, 'USERNAME_TAKEN');
});

test('verify without a binding → 404; invalid username → 400', async () => {
  const { token } = await register('bind4@test.dev');
  assert.equal((await verify(token)).code, 404);
  assert.equal((await bind(token, 'bad name!')).code, 400);
  assert.equal((await bind(token, '')).code, 400);
});

test('expired code refuses verification', async () => {
  const { token } = await register('bind5@test.dev');
  const r = await bind(token, 'expired_flow');
  bios.set('expired_flow', r.body.code);
  db.prepare(
    "UPDATE tiktok_bindings SET code_expires_at = '2000-01-01T00:00:00Z' WHERE user_id = (SELECT id FROM users WHERE email = 'bind5@test.dev')"
  ).run();
  const res = await verify(token);
  assert.equal(res.code, 410);
  assert.equal(res.body.error, 'CODE_EXPIRED');
});

test('rebind replaces the username; unbind clears the row', async () => {
  const { token } = await register('bind6@test.dev');
  const r1 = await bind(token, 'first_name');
  const r2 = await bind(token, 'second_name');
  assert.notEqual(r1.body.code, r2.body.code);
  assert.equal(r2.body.username, 'second_name');

  bios.set('second_name', r2.body.code);
  assert.equal((await verify(token)).code, 200);

  const un = await app.inject({
    method: 'POST',
    url: '/api/tiktok/unbind',
    headers: auth(token),
    payload: {},
  }).then((x) => x.json());
  assert.equal(un.bound, false);
  const s = await status(token);
  assert.equal(s.bound, false);
});

test('all endpoints require auth', async () => {
  for (const url of ['/api/tiktok/bind', '/api/tiktok/verify', '/api/tiktok/unbind']) {
    const r = await app.inject({ method: 'POST', url, payload: {} });
    assert.equal(r.statusCode, 401, url);
  }
  const r = await app.inject({ method: 'GET', url: '/api/tiktok/bind' });
  assert.equal(r.statusCode, 401);
});
