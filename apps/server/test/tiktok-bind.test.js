/**
 * @file tiktok-bind.test.js
 * TikTok account binding: bio-code issuance, verification against a
 * stubbed profile fetch, username-taken conflicts, expiry, rebind and
 * unbind semantics.
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.TIKTOK_CLIENT_KEY = 'tt-client-key';
process.env.TIKTOK_CLIENT_SECRET = 'tt-client-secret';
process.env.TIKTOK_REDIRECT_URI = 'http://localhost:8787/api/tiktok/oauth/callback';

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

/** User the oauthFetch stub hands back — per-call override in tests. */
let oauthUser = {
  open_id: 'oid-1',
  union_id: 'uid-1',
  username: 'oauth_user',
  display_name: 'OAuth User',
  avatar_url: 'https://x/a.png',
};

before(async () => {
  ({ app, db } = await buildApp({
    tiktokOauthFetch: async (url, init) => {
      if (url.includes('/oauth/token')) {
        return new Response(
          JSON.stringify({ access_token: 'at-1', token_type: 'Bearer' }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (url.includes('/user/info')) {
        return new Response(JSON.stringify({ data: { user: oauthUser } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 404 });
    },
    tiktokFetchBio: async (username) => {
      if (username === 'ghost_404') return { ok: false, error: 'USER_NOT_FOUND' };
      return {
        ok: true,
        bio: bios.get(username) || '',
        nickname: `Nick ${username}`,
        avatar: 'https://x/av.png',
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

test('simple bind links instantly and returns the profile card', async () => {
  const { token } = await register('simple1@test.dev');
  const r = await bind(token, 'streamer_card');
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(r.body.bound, true);
  assert.equal(r.body.verified, false);
  assert.equal(r.body.display_name, 'Nick streamer_card');
  assert.equal(r.body.avatar_url, 'https://x/av.png');
  assert.equal(r.body.profile.nickname, 'Nick streamer_card');
  assert.equal(r.body.profile.follower_count, 42);
  // Unknown handle → 404, nothing bound.
  const ghost = await bind(token, 'ghost_404');
  assert.equal(ghost.code, 404);
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
  assert.equal(ok.body.nickname, 'Nick streamer_two');
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

test('verify-comment verifies when the code matches, no bio needed', async () => {
  const { token } = await register('bind7@test.dev');
  const r = await bind(token, 'chat_prover');

  const wrong = await app.inject({
    method: 'POST',
    url: '/api/tiktok/verify-comment',
    headers: auth(token),
    payload: { code: 'ZZZZZZZZ' },
  }).then((x) => ({ code: x.statusCode, body: x.json() }));
  assert.equal(wrong.code, 400);
  assert.equal(wrong.body.error, 'CODE_MISMATCH');

  const ok = await app.inject({
    method: 'POST',
    url: '/api/tiktok/verify-comment',
    headers: auth(token),
    payload: { code: r.body.code },
  }).then((x) => ({ code: x.statusCode, body: x.json() }));
  assert.equal(ok.code, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.verified, true);
});

// ------------------------------------------------------------- OAuth

/** Runs the full OAuth hop: url → state → callback. Returns the HTML. */
async function oauthFlow(token) {
  const urlRes = await app
    .inject({ method: 'GET', url: '/api/tiktok/oauth/url', headers: auth(token) })
    .then((r) => r.json());
  const state = new URL(urlRes.url).searchParams.get('state');
  const cb = await app.inject({
    method: 'GET',
    url: `/api/tiktok/oauth/callback?code=AUTH_CODE&state=${state}`,
  });
  return { html: cb.body, statusCode: cb.statusCode };
}

test('oauth/url issues an authorize link with a bound state', async () => {
  const { token } = await register('oauth1@test.dev');
  const r = await app.inject({
    method: 'GET',
    url: '/api/tiktok/oauth/url',
    headers: auth(token),
  });
  assert.equal(r.statusCode, 200);
  const { url } = r.json();
  assert.ok(url.startsWith('https://www.tiktok.com/v2/auth/authorize/'));
  assert.ok(url.includes('client_key=tt-client-key'));
  assert.ok(url.includes('user.info.profile'));
});

test('oauth callback binds the account with open_id identity', async () => {
  const { token } = await register('oauth2@test.dev');
  oauthUser = { ...oauthUser, open_id: 'oid-oauth2', username: 'oauth_bound' };
  const { html } = await oauthFlow(token);
  assert.ok(html.includes('chlauncher://tiktok-bind?status=ok&username=oauth_bound'), html);

  const s = await status(token);
  assert.equal(s.verified, true);
  assert.equal(s.username, 'oauth_bound');
  assert.equal(s.open_id, 'oid-oauth2');
  assert.equal(s.auth_method, 'oauth');
});

test('oauth: one TikTok identity cannot bind two accounts', async () => {
  const a = await register('oauth3a@test.dev');
  const b = await register('oauth3b@test.dev');
  oauthUser = { ...oauthUser, open_id: 'oid-shared', username: 'shared_tt' };
  assert.ok((await oauthFlow(a.token)).html.includes('status=ok'));
  const second = await oauthFlow(b.token);
  assert.ok(second.html.includes('status=error'));
  assert.ok(second.html.includes('taken'));
});

test('oauth callback: unknown state and user denial yield error pages', async () => {
  const bad = await app.inject({
    method: 'GET',
    url: '/api/tiktok/oauth/callback?code=X&state=nope',
  });
  assert.ok(bad.body.includes('state_expired'));

  const denied = await app.inject({
    method: 'GET',
    url: '/api/tiktok/oauth/callback?error=access_denied&error_description=user+denied',
  });
  assert.ok(denied.body.includes('chlauncher://tiktok-bind?status=error'));
});

test('oauth: rebind via oauth replaces a code-pending binding', async () => {
  const { token } = await register('oauth4@test.dev');
  await bind(token, 'old_name');
  oauthUser = { ...oauthUser, open_id: 'oid-oauth4', username: 'new_oauth_name' };
  assert.ok((await oauthFlow(token)).html.includes('status=ok'));
  const s = await status(token);
  assert.equal(s.username, 'new_oauth_name');
  assert.equal(s.code, null);
});

test('all endpoints require auth', async () => {
  for (const url of ['/api/tiktok/bind', '/api/tiktok/verify', '/api/tiktok/unbind']) {
    const r = await app.inject({ method: 'POST', url, payload: {} });
    assert.equal(r.statusCode, 401, url);
  }
  const r = await app.inject({ method: 'GET', url: '/api/tiktok/bind' });
  assert.equal(r.statusCode, 401);
});
