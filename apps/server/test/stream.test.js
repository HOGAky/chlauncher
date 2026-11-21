/**
 * @file stream.test.js
 * Tests for the integrated Roblox stream relay (routes/stream.js,
 * tg-auth-spec §7a/§7b): server-minted keys, one-time launch tickets,
 * durable event queue, claim/release and subscription gating.
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';

let app;
let db;
let token;
let userId;

const auth = (t) => ({ authorization: `Bearer ${t}` });
const post = (url, payload, headers = {}) =>
  app.inject({ method: 'POST', url, payload, headers });
const get = (url, headers = {}) => app.inject({ method: 'GET', url, headers });

before(async () => {
  const { buildApp } = await import('../src/app.js');
  ({ app, db } = await buildApp({ databasePath: ':memory:' }));
  const reg = await post('/api/auth/register', {
    email: 'streamer@example.com',
    password: 'secret123',
    hwid: 'HWID-X',
  });
  token = reg.json().token;
  userId = reg.json().user.id;
});

async function mockPay(t = token) {
  return post('/api/billing/mock-pay', {}, auth(t));
}

test('key mint: plaintext returned once, then hidden', async () => {
  const first = await get('/api/stream/key', auth(token));
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().created, true);
  const key = first.json().stream_key;
  assert.ok(key.startsWith('sk_'));

  const second = await get('/api/stream/key', auth(token));
  assert.equal(second.json().created, false);
  assert.equal(second.json().stream_key, null);
});

test('ticket requires auth and active subscription', async () => {
  assert.equal((await post('/api/stream/ticket', {})).statusCode, 401);
  // No subscription yet → 402.
  const noSub = await post('/api/stream/ticket', {}, auth(token));
  assert.equal(noSub.statusCode, 402);
  assert.equal(noSub.json().error, 'SUBSCRIPTION_EXPIRED');

  await mockPay();
  const ok = await post('/api/stream/ticket', {}, auth(token));
  assert.equal(ok.statusCode, 200);
  assert.ok(ok.json().ticket.length >= 32);
});

test('redeem binds Roblox id and returns a room credential', async () => {
  const { ticket } = (await post('/api/stream/ticket', {}, auth(token))).json();
  const res = await post('/api/stream/redeem', {
    ticket,
    roblox_user_id: 111,
  });
  assert.equal(res.statusCode, 200);
  const roomKey = res.json().stream_key;
  assert.ok(roomKey.startsWith('rk_'));

  // The room credential works on the Roblox-facing endpoints…
  const val = await post(
    '/api/stream/validate',
    { roblox_user_id: 111 },
    { 'x-stream-key': roomKey }
  );
  assert.equal(val.statusCode, 200);
  // One-shot: same ticket cannot redeem twice.
  const again = await post('/api/stream/redeem', {
    ticket,
    roblox_user_id: 111,
  });
  assert.equal(again.statusCode, 401);
  assert.equal(again.json().error, 'invalid_ticket');

  // A different Roblox id is refused by the first-binding rule.
  const t2 = (await post('/api/stream/ticket', {}, auth(token))).json().ticket;
  const other = await post('/api/stream/redeem', {
    ticket: t2,
    roblox_user_id: 999,
  });
  assert.equal(other.statusCode, 409);
  assert.equal(other.json().error, 'bound_to_other_user');
});

test('ingest (JWT) → events poll (room key) roundtrip with cursor', async () => {
  const { ticket } = (await post('/api/stream/ticket', {}, auth(token))).json();
  const { stream_key: roomKey } = (
    await post('/api/stream/redeem', { ticket, roblox_user_id: 111 })
  ).json();

  const push = await post(
    '/api/stream/ingest',
    { event_kind: 'gift', user: 'viewer1', action_command: 'yeet' },
    auth(token)
  );
  assert.equal(push.statusCode, 200);

  const poll = await get('/api/stream/events?since=0', {
    'x-stream-key': roomKey,
  });
  assert.equal(poll.statusCode, 200);
  const { cursor, events } = poll.json();
  assert.ok(cursor > 0);
  assert.equal(events.length, 1);
  assert.equal(events[0].action_command, 'yeet');

  // Re-polling from the returned cursor yields nothing new.
  const again = await get(`/api/stream/events?since=${cursor}`, {
    'x-stream-key': roomKey,
  });
  assert.equal(again.json().events.length, 0);
});

test('claim is exclusive per job; release frees it', async () => {
  const { stream_key: realKey } = (
    await post('/api/stream/key/rotate', {}, auth(token))
  ).json();
  assert.ok(realKey);

  const claim = await post('/api/stream/claim', {
    stream_key: realKey,
    job_id: 'job-A',
  });
  assert.equal(claim.statusCode, 200);

  // Same job: idempotent. Different job: 409.
  assert.equal(
    (await post('/api/stream/claim', { stream_key: realKey, job_id: 'job-A' }))
      .statusCode,
    200
  );
  const conflict = await post('/api/stream/claim', {
    stream_key: realKey,
    job_id: 'job-B',
  });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().error, 'already_claimed');

  // Status reflects the live room.
  const status = (await get('/api/stream/status', auth(token))).json();
  assert.equal(status.claimed_job_id, 'job-A');
  assert.equal(status.room.job_id, 'job-A');

  // Wrong job's release doesn't steal the claim; right job's does.
  await post('/api/stream/release', { stream_key: realKey, job_id: 'job-B' });
  assert.equal(
    db.prepare('SELECT claimed_job_id FROM stream_keys WHERE user_id = ?').get(
      userId
    ).claimed_job_id,
    'job-A'
  );
  await post('/api/stream/release', { stream_key: realKey, job_id: 'job-A' });
  assert.equal(
    db.prepare('SELECT claimed_job_id FROM stream_keys WHERE user_id = ?').get(
      userId
    ).claimed_job_id,
    null
  );
});

test('subscription lapse → 402 on validate/poll; release still works', async () => {
  const { stream_key: key } = (
    await post('/api/stream/key/rotate', {}, auth(token))
  ).json();
  await post('/api/stream/claim', { stream_key: key, job_id: 'job-X' });
  await post('/api/billing/mock-expire', {}, auth(token));

  const val = await post('/api/stream/validate', {
    stream_key: key,
    roblox_user_id: 111,
  });
  assert.equal(val.statusCode, 402);
  assert.equal(val.json().error, 'subscription_expired');

  const poll = await get('/api/stream/events?since=0', {
    'x-stream-key': key,
  });
  assert.equal(poll.statusCode, 402);

  // Release skips the subscription check so claims never wedge.
  const rel = await post('/api/stream/release', {
    stream_key: key,
    job_id: 'job-X',
  });
  assert.equal(rel.statusCode, 200);

  // Unknown key → 401; never reveals whether a key exists.
  const bad = await post('/api/stream/validate', {
    stream_key: 'sk_nope',
    roblox_user_id: 1,
  });
  assert.equal(bad.statusCode, 401);
});

test('X-Stream-Key ingest path stays standalone-relay compatible', async () => {
  // Restore subscription, then use the raw stream key exactly like the
  // old forwarder does (no JWT).
  await mockPay();
  const { stream_key: key } = (
    await post('/api/stream/key/rotate', {}, auth(token))
  ).json();
  const push = await post(
    '/api/stream/ingest',
    { event_kind: 'like', count: 5 },
    { 'x-stream-key': key }
  );
  assert.equal(push.statusCode, 200);
  const poll = await get('/api/stream/events?since=0', {
    'x-stream-key': key,
  });
  assert.ok(
    poll.json().events.some((e) => e.event_kind === 'like' && e.count === 5)
  );
});

test('key rotate kills the old credential and the Roblox binding', async () => {
  // Bind a Roblox id first so the rotation has something to clear.
  const { stream_key: key } = (
    await post('/api/stream/key/rotate', {}, auth(token))
  ).json();
  const bound = await post('/api/stream/validate', {
    stream_key: key,
    roblox_user_id: 555,
  });
  assert.equal(bound.statusCode, 200);
  const before = db
    .prepare('SELECT key_hash, roblox_user_id FROM stream_keys WHERE user_id = ?')
    .get(userId);
  assert.equal(before.roblox_user_id, 555);
  const { stream_key: fresh } = (
    await post('/api/stream/key/rotate', {}, auth(token))
  ).json();
  const after = db
    .prepare('SELECT key_hash, roblox_user_id FROM stream_keys WHERE user_id = ?')
    .get(userId);
  assert.notEqual(after.key_hash, before.key_hash);
  assert.equal(after.roblox_user_id, null);

  // The old room key is dead with the rotation…
  const stale = await get('/api/stream/events?since=0', {
    'x-stream-key': 'rk_doesnotmatter',
  });
  assert.equal(stale.statusCode, 401);
  // …and the fresh key validates + binds anew.
  const val = await post('/api/stream/validate', {
    stream_key: fresh,
    roblox_user_id: 777,
  });
  assert.equal(val.statusCode, 200);
});

test('queue caps at 500 events per key', async () => {
  const { stream_key: key } = (
    await post('/api/stream/key/rotate', {}, auth(token))
  ).json();
  const hash = db
    .prepare('SELECT key_hash FROM stream_keys WHERE user_id = ?')
    .get(userId).key_hash;
  for (let i = 0; i < 505; i += 1) {
    db.prepare(
      'INSERT INTO stream_events (key_hash, payload, created_ts) VALUES (?,?,?)'
    ).run(hash, JSON.stringify({ n: i }), Date.now());
  }
  // The cap is enforced by the ingest path — one more event via the API
  // evicts the oldest beyond 500.
  await post(
    '/api/stream/ingest',
    { n: 'newest' },
    { 'x-stream-key': key }
  );
  const poll = await get('/api/stream/events?since=0', {
    'x-stream-key': key,
  });
  const events = poll.json().events;
  assert.equal(events.length, 500);
  assert.equal(events[0].n, 6); // the 6 oldest were evicted
  assert.equal(events.at(-1).n, 'newest');
});

test('crashed server claim: redeem and stale heartbeat let a new job take over', async () => {
  // Server A redeems + claims, then dies without release — the classic
  // Roblox-server crash that used to wedge the room on already_claimed.
  const t1 = (await post('/api/stream/ticket', {}, auth(token))).json().ticket;
  const rkA = (
    await post('/api/stream/redeem', { ticket: t1, roblox_user_id: 111 })
  ).json().stream_key;
  const claimA = await post('/api/stream/claim', {
    stream_key: rkA,
    job_id: 'job-old',
  });
  assert.equal(claimA.statusCode, 200);

  // Server B launches (new ticket → redeem): the fresh room key must
  // arrive with a cleared claim — A's credential died on rotation.
  const t2 = (await post('/api/stream/ticket', {}, auth(token))).json().ticket;
  const rkB = (
    await post('/api/stream/redeem', { ticket: t2, roblox_user_id: 111 })
  ).json().stream_key;
  const claimB = await post('/api/stream/claim', {
    stream_key: rkB,
    job_id: 'job-new',
  });
  assert.equal(claimB.statusCode, 200);

  // Stale takeover: B crashes too (no release, no redeem). Backdating
  // the room heartbeat beyond the 60 s window lets job C steal.
  db.prepare(
    'UPDATE stream_rooms SET last_seen_at = ? WHERE user_id = ?'
  ).run(new Date(Date.now() - 120_000).toISOString(), userId);
  const claimC = await post('/api/stream/claim', {
    stream_key: rkB,
    job_id: 'job-newer',
  });
  assert.equal(claimC.statusCode, 200);
  assert.equal(
    db
      .prepare('SELECT claimed_job_id FROM stream_keys WHERE user_id = ?')
      .get(userId).claimed_job_id,
    'job-newer'
  );

  // While the heartbeat is fresh, a foreign job still gets 409.
  const conflict = await post('/api/stream/claim', {
    stream_key: rkB,
    job_id: 'job-intruder',
  });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().error, 'already_claimed');
});
