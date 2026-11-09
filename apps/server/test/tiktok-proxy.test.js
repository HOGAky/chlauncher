/**
 * @file tiktok-proxy.test.js
 * The EulerStream sign proxy (/api/tiktok-sign/*):
 *  - unauthenticated → 401
 *  - authenticated but no active subscription → 403 SUBSCRIPTION_REQUIRED
 *  - subscribed + no EULERSTREAM_API_KEY → ping {enabled:false}, proxy 503
 *  - subscribed + key configured → transparent forward upstream with the
 *    SERVER's x-api-key (never the client's), headers/body verbatim,
 *    response headers passed through (the SDK needs x-set-tt-cookie etc.)
 *  - non whitelisted paths (/accounts/, /) → 400 (no open proxy)
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { buildApp } from '../src/app.js';
import { config } from '../src/config.js';
import { updateSubscription, isoInDays } from '../src/db.js';

let app, db, upstream, upstreamPort;
let upstreamRequests = [];

// A stub "eulerstream" that echoes enough to assert passthrough.
before(async () => {
  upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      upstreamRequests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString(),
      });
      res.writeHead(200, {
        'content-type': 'application/json',
        'x-set-tt-cookie': 'tt-cookie-value',
        'x-room-id': 'room-42',
      });
      res.end(JSON.stringify({ ok: true, echo: req.url }));
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  upstreamPort = upstream.address().port;

  config.eulerApiKey = 'TEST-EULER-KEY';
  config.eulerBaseUrl = `http://127.0.0.1:${upstreamPort}`;
  ({ app, db } = await buildApp());
});
after(async () => {
  config.eulerApiKey = '';
  await app.close();
  upstream.close();
});

const register = async (email, { subscribed = false } = {}) => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password: 'secret123', hwid: 'HWID-PX' },
  });
  const body = res.json();
  if (subscribed) {
    const uid = db.prepare('SELECT id FROM users WHERE email = ?').get(email).id;
    updateSubscription(db, uid, 'active', isoInDays(30));
  }
  return `Bearer ${body.token}`;
};

test('ping requires auth + active subscription', async () => {
  const noAuth = await app.inject({ method: 'GET', url: '/api/tiktok-sign/ping' });
  assert.equal(noAuth.statusCode, 401);

  const noSub = await app.inject({
    method: 'GET',
    url: '/api/tiktok-sign/ping',
    headers: { authorization: await register('ping-nosub@x.io') },
  });
  assert.equal(noSub.statusCode, 403);
  assert.equal(noSub.json().error, 'SUBSCRIPTION_REQUIRED');

  const ok = await app.inject({
    method: 'GET',
    url: '/api/tiktok-sign/ping',
    headers: { authorization: await register('ping-sub@x.io', { subscribed: true }) },
  });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().enabled, true);
});

test('ping reports enabled:false when no upstream key configured', async () => {
  config.eulerApiKey = '';
  const res = await app.inject({
    method: 'GET',
    url: '/api/tiktok-sign/ping',
    headers: { authorization: await register('ping-off@x.io', { subscribed: true }) },
  });
  assert.equal(res.json().enabled, false);
  config.eulerApiKey = 'TEST-EULER-KEY';
});

test('proxy forwards path/query/headers and injects the server api key', async () => {
  const auth = await register('proxy@x.io', { subscribed: true });
  upstreamRequests = [];
  const res = await app.inject({
    method: 'POST',
    url: '/api/tiktok-sign/tiktok/sign_url?client=ttlive-node',
    headers: {
      authorization: auth,
      'content-type': 'application/json',
      'user-agent': 'tiktok-live-connector/2.5.0',
      'x-api-key': 'CLIENT-SUPPLIED-FAKE',
    },
    payload: JSON.stringify({ url: 'https://webcast.tiktok.com/x', client: 'ttlive-node' }),
  });
  assert.equal(res.statusCode, 200);
  // SDK-critical response headers pass through.
  assert.equal(res.headers['x-set-tt-cookie'], 'tt-cookie-value');
  assert.equal(res.headers['x-room-id'], 'room-42');

  const up = upstreamRequests[0];
  assert.equal(up.method, 'POST');
  assert.equal(up.url, '/tiktok/sign_url?client=ttlive-node');
  // Server key wins; the client-supplied one never reaches upstream.
  assert.equal(up.headers['x-api-key'], 'TEST-EULER-KEY');
  // Nor does the user's JWT.
  assert.equal(up.headers.authorization, undefined);
  // Client UA is preserved (SDK identifies itself upstream).
  assert.match(up.headers['user-agent'], /tiktok-live-connector/);
  assert.match(up.body, /webcast\.tiktok\.com/);
});

test('GET proxying works and non-whitelisted paths are rejected', async () => {
  const auth = await register('paths@x.io', { subscribed: true });
  const ok = await app.inject({
    method: 'GET',
    url: '/api/tiktok-sign/webcast/anchors/someuser/room_id',
    headers: { authorization: auth },
  });
  assert.equal(ok.statusCode, 200);

  for (const p of ['/api/tiktok-sign/accounts/x', '/api/tiktok-sign/', '/api/tiktok-sign/../etc']) {
    const res = await app.inject({
      method: 'GET',
      url: p,
      headers: { authorization: auth },
    });
    assert.notEqual(res.statusCode, 200, `${p} must not proxy`);
  }
});

test('proxy is 503 (not a crash) without a configured key', async () => {
  config.eulerApiKey = '';
  const auth = await register('nokey@x.io', { subscribed: true });
  const res = await app.inject({
    method: 'GET',
    url: '/api/tiktok-sign/tiktok/sign_url',
    headers: { authorization: auth },
  });
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().error, 'SIGN_NOT_CONFIGURED');
  config.eulerApiKey = 'TEST-EULER-KEY';
});
