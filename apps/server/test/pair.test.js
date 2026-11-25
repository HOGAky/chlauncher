/**
 * @file pair.test.js
 * QR-pairing handoff — the phone submits a verified TikTok sessionid,
 * the launcher polls it back once. §14: the cookie must not rest in the
 * database in plaintext; this suite asserts the stored row is encrypted
 * and the claim path still returns the usable session.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';

let app;
let db;
let realFetch;

const SID = 'sessionid-abc123XYZ';
const IDC = 'idc-target-Zz9q';

before(async () => {
  // fetchTikTokAccountInfo hits tiktok.com — stub the verification so
  // the test is offline and deterministic.
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('passport/web/account/info')) {
      return new Response(
        JSON.stringify({
          data: {
            user_id_str: '777123',
            username: 'streamer_tt',
            screen_name: 'Streamer',
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    return realFetch(url);
  };
  ({ app, db } = await buildApp({ databasePath: ':memory:' }));
  await app.ready();
});

after(async () => {
  globalThis.fetch = realFetch;
  await app.close();
});

test('pair-session stores the cookie encrypted; pair-status returns it once', async () => {
  // 1. launcher creates a pairing code.
  const start = await app.inject({ method: 'POST', url: '/api/auth/pair-start' });
  assert.equal(start.statusCode, 200);
  const code = start.json().code;
  assert.ok(code);

  // 2. phone submits the session — verified upstream, then stored.
  const ses = await app.inject({
    method: 'POST',
    url: '/api/auth/pair-session',
    payload: { code, sessionid: SID, tt_target_idc: IDC },
  });
  assert.equal(ses.statusCode, 200, JSON.stringify(ses.json()));

  // 3. The DB row must hold ciphertext, never the raw cookie (§14).
  const row = db.prepare('SELECT * FROM pair_codes WHERE code = ?').get(code);
  assert.ok(row.tiktok_sessionid.startsWith('enc:'));
  assert.ok(row.tiktok_idc.startsWith('enc:'));
  assert.ok(!row.tiktok_sessionid.includes(SID));
  assert.ok(!row.tiktok_idc.includes(IDC));
  assert.equal(row.tiktok_uid, '777123');

  // 4. The launcher's single status pull gets the decrypted session back.
  const st = await app.inject({
    method: 'POST',
    url: '/api/auth/pair-status',
    payload: { code },
  });
  assert.equal(st.statusCode, 200);
  const body = st.json();
  assert.equal(body.status, 'session');
  assert.equal(body.tiktok_session.sessionid, SID);
  assert.equal(body.tiktok_session.idc, IDC);
  assert.equal(body.tiktok_session.username, 'streamer_tt');

  // 5. One-shot: the consumed code can't be redeemed again.
  const again = await app.inject({
    method: 'POST',
    url: '/api/auth/pair-status',
    payload: { code },
  });
  assert.equal(again.statusCode, 404);
});

test('invalid session format is rejected before storage', async () => {
  const start = await app.inject({ method: 'POST', url: '/api/auth/pair-start' });
  const code = start.json().code;
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/pair-session',
    payload: { code, sessionid: 'bad session<script>' },
  });
  assert.equal(res.statusCode, 400);
  const row = db.prepare('SELECT * FROM pair_codes WHERE code = ?').get(code);
  assert.equal(row.tiktok_sessionid, null);
});
