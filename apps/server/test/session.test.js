/**
 * @file session.test.js
 * Task 5 regressions — HWID/session hardening:
 *  - `!hwid-unavailable` sentinels rejected (HWID_UNAVAILABLE)
 *  - HWIDs persisted as HMAC hashes, never raw
 *  - device_events journal written on bind/deny/reset
 *  - login brute-force lockout (TOO_MANY_ATTEMPTS + retry_after_ms)
 *  - logout invalidates the JWT (SESSION_EXPIRED afterwards)
 *  - /api/account/me never returns the stored HWID value
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';

let app, db;
before(async () => {
  ({ app, db } = await buildApp());
});
after(async () => app.close());

const register = (email, hwid = 'HWID-T') =>
  app
    .inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email, password: 'secret123', hwid },
    })
    .then((r) => r.json());

const login = (email, password, hwid) =>
  app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password, hwid },
  });

test('register rejects sentinel/invalid hwid', async () => {
  for (const bad of ['!hwid-unavailable', '!', '', 'x'.repeat(300)]) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: `bad-${Math.random()}@x.io`, password: 'secret123', hwid: bad },
    });
    assert.equal(res.json().error, 'HWID_UNAVAILABLE', `hwid=${JSON.stringify(bad)}`);
  }
});

test('login rejects sentinel hwid', async () => {
  await register('sentinel@x.io', 'HWID-OK');
  const res = await login('sentinel@x.io', 'secret123', '!hwid-unavailable');
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'HWID_UNAVAILABLE');
});

test('stored hwid is an HMAC hash, not the raw value', async () => {
  const body = await register('hash@x.io', 'RAW-HWID-42');
  const row = db.prepare('SELECT hwid FROM users WHERE email = ?').get('hash@x.io');
  assert.match(row.hwid, /^[0-9a-f]{64}$/);
  assert.notEqual(row.hwid, 'RAW-HWID-42');
  // The raw value never reaches the API response either.
  assert.ok(!JSON.stringify(body).includes('RAW-HWID-42'));
});

test('same raw hwid still matches after hashing (login works)', async () => {
  await register('match@x.io', 'HWID-M');
  const res = await login('match@x.io', 'secret123', 'HWID-M');
  assert.equal(res.statusCode, 200);
});

test('device_events records bound + login_denied', async () => {
  await register('events@x.io', 'HWID-E');
  await login('events@x.io', 'secret123', 'HWID-FOREIGN'); // → HWID_MISMATCH
  const uid = db.prepare('SELECT id FROM users WHERE email = ?').get('events@x.io').id;
  const events = db
    .prepare('SELECT event_type FROM device_events WHERE user_id = ? ORDER BY id')
    .all(uid)
    .map((r) => r.event_type);
  assert.deepEqual(events, ['bound', 'login_denied']);
});

test('login brute-force lockout: 5 fails → TOO_MANY_ATTEMPTS', async () => {
  await register('brute@x.io', 'HWID-B');
  for (let i = 0; i < 5; i++) {
    const res = await login('brute@x.io', 'wrong-password', 'HWID-B');
    assert.equal(res.json().error, 'INVALID_CREDENTIALS', `attempt ${i}`);
  }
  const blocked = await login('brute@x.io', 'secret123', 'HWID-B');
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.json().error, 'TOO_MANY_ATTEMPTS');
  assert.ok(blocked.json().retry_after_ms > 0);
  // Another email on the same IP is NOT locked out.
  const other = await login('nobody@x.io', 'x', 'HWID-B');
  assert.equal(other.json().error, 'INVALID_CREDENTIALS');
});

test('logout invalidates the JWT (old token → SESSION_EXPIRED)', async () => {
  const body = await register('logout@x.io', 'HWID-L');
  const headers = { authorization: `Bearer ${body.token}` };
  const me1 = await app.inject({ method: 'GET', url: '/api/account/me', headers });
  assert.equal(me1.statusCode, 200);

  const out = await app.inject({
    method: 'POST',
    url: '/api/auth/logout',
    headers,
  });
  assert.equal(out.statusCode, 200);

  const me2 = await app.inject({ method: 'GET', url: '/api/account/me', headers });
  assert.equal(me2.statusCode, 401);
  assert.equal(me2.json().error, 'SESSION_EXPIRED');

  // Fresh login gets a working token.
  const relogin = await login('logout@x.io', 'secret123', 'HWID-L');
  assert.equal(relogin.statusCode, 200);
  const me3 = await app.inject({
    method: 'GET',
    url: '/api/account/me',
    headers: { authorization: `Bearer ${relogin.json().token}` },
  });
  assert.equal(me3.statusCode, 200);
});

test('/me exposes hwid_bound flag, never the raw/hashed value', async () => {
  const body = await register('me@x.io', 'HWID-ME-RAW');
  const me = await app.inject({
    method: 'GET',
    url: '/api/account/me',
    headers: { authorization: `Bearer ${body.token}` },
  });
  const u = me.json().user;
  assert.equal(u.hwid_bound, true);
  assert.equal(u.hwid, undefined);
  assert.ok(!JSON.stringify(me.json()).includes('HWID-ME-RAW'));
});
