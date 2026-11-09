/**
 * @file publisher.test.js
 * Publisher self-service cycle: role grant → draft → build upload →
 * submit → admin review (approve/reject) → catalog visibility.
 * Runs on an in-memory DB via app.inject. ADMIN_EMAILS must be set
 * before src/config.js is evaluated.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { before, after } from 'node:test';

process.env.ADMIN_EMAILS = 'root@example.com';

let app;
let db;
let config;
let adminToken;
let pubToken;
let pub2Token;
const createdZips = [];

const auth = (token) => ({ authorization: `Bearer ${token}` });

async function register(email, hwid = 'HWID-X') {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password: 'secret123', hwid },
  });
  return { status: res.statusCode, body: res.json() };
}

const pub = (method, url, token = pubToken, payload) =>
  app.inject({
    method,
    url: `/api/publisher${url}`,
    headers: payload?.raw
      ? { ...auth(token), 'content-type': 'application/octet-stream' }
      : auth(token),
    payload: payload?.raw ?? payload,
  });

const adm = (method, url, payload) =>
  app.inject({ method, url: `/api/admin${url}`, headers: auth(adminToken), payload });

async function pubUpload(slug, version, zipBuf, token = pubToken) {
  return pub('POST', `/games/${slug}/builds?version=${version}`, token, { raw: zipBuf });
}

before(async () => {
  ({ config } = await import('../src/config.js'));
  const { buildApp } = await import('../src/app.js');
  ({ app, db } = await buildApp({ databasePath: ':memory:' }));
  adminToken = (await register('root@example.com')).body.token;
  pubToken = (await register('dev@example.com', 'HWID-DEV')).body.token;
  pub2Token = (await register('other@example.com', 'HWID-OTHER')).body.token;
});

after(() => {
  for (const p of createdZips) {
    fs.rmSync(p, { force: true, maxRetries: 10, retryDelay: 100 });
    fs.rmSync(path.dirname(p), { recursive: true, force: true });
  }
});

// ------------------------------------------------------------- role gate

test('regular user gets 403 on publisher API', async () => {
  const res = await pub('GET', '/games');
  assert.equal(res.statusCode, 403);
});

test('admin set-role grants publisher access', async () => {
  for (const email of ['dev@example.com', 'other@example.com']) {
    const u = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    const res = await adm('POST', `/users/${u.id}/set-role`, { role: 'publisher' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().user.role, 'publisher');
  }
  const list = await pub('GET', '/games');
  assert.equal(list.statusCode, 200);
});

test('admin cannot change own role', async () => {
  const root = db.prepare('SELECT id FROM users WHERE email = ?').get('root@example.com');
  const res = await adm('POST', `/users/${root.id}/set-role`, { role: 'user' });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'CANNOT_CHANGE_OWN_ROLE');
});

// ------------------------------------------------------------- draft

test('publisher creates a draft game with owner set', async () => {
  const res = await pub('POST', '/games', pubToken, {
    slug: 'sky-dodge',
    title: 'Sky Dodge',
    description: 'dodge stuff',
    executable_name: 'sky.exe',
  });
  assert.equal(res.statusCode, 201);
  assert.equal(res.json().game.status, 'draft');
  assert.equal(res.json().game.owner_email, 'dev@example.com');
});

test('duplicate slug rejected for anyone', async () => {
  const res = await pub('POST', '/games', pub2Token, {
    slug: 'sky-dodge',
    title: 'x',
    executable_name: 'x.exe',
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, 'SLUG_TAKEN');
});

// ------------------------------------------------------------- builds

test('build upload validates the zip like the admin path', async () => {
  const missing = makeZip([{ name: 'readme.txt', data: 'hi' }]);
  const bad = await pubUpload('sky-dodge', '0.1.0', missing);
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error, 'EXECUTABLE_MISSING');

  const traversal = makeZip([
    { name: 'sky.exe', data: 'x' },
    { name: '../evil.exe', data: 'x' },
  ]);
  const badPath = await pubUpload('sky-dodge', '0.1.0', traversal);
  assert.equal(badPath.statusCode, 400);
  assert.equal(badPath.json().error, 'UNSAFE_ZIP_PATH');
});

test('build upload stores an immutable build', async () => {
  const zip = makeZip([{ name: 'sky.exe', data: 'MZ-sky-1.0.0' }]);
  createdZips.push(path.join(config.staticDir, 'games', 'sky-dodge', '1.0.0.zip'));
  const res = await pubUpload('sky-dodge', '1.0.0', zip);
  assert.equal(res.statusCode, 201);
  assert.equal(res.json().build.version, '1.0.0');
  assert.equal(res.json().build.sha256.length, 64);

  const dup = await pubUpload('sky-dodge', '1.0.0', zip);
  assert.equal(dup.statusCode, 409);
});

// ------------------------------------------------------------- submit/review

test('submit queues a pending submission; second submit is blocked', async () => {
  const res = await pub('POST', '/games/sky-dodge/submit', pubToken, { version: '1.0.0' });
  assert.equal(res.statusCode, 201);
  assert.equal(res.json().submission.status, 'pending');

  const again = await pub('POST', '/games/sky-dodge/submit', pubToken, { version: '1.0.0' });
  assert.equal(again.statusCode, 409);
  assert.equal(again.json().error, 'REVIEW_PENDING');
});

test('metadata edit is blocked while review is pending', async () => {
  const res = await app.inject({
    method: 'PATCH',
    url: '/api/publisher/games/sky-dodge',
    headers: auth(pubToken),
    payload: { title: 'Renamed' },
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, 'REVIEW_PENDING');
});

test('other publishers cannot see or touch the game', async () => {
  for (const [method, url, payload] of [
    ['PATCH', '/games/sky-dodge', { title: 'hax' }],
    ['POST', '/games/sky-dodge/submit', { version: '1.0.0' }],
  ]) {
    const res = await app.inject({
      method,
      url: `/api/publisher${url}`,
      headers: auth(pub2Token),
      payload,
    });
    assert.equal(res.statusCode, 404, `${method} ${url}`);
  }
});

test('admin sees the pending submission and approves it', async () => {
  const queue = await adm('GET', '/submissions?status=pending');
  assert.equal(queue.statusCode, 200);
  const sub = queue.json().submissions.find((s) => s.game_slug === 'sky-dodge');
  assert.ok(sub);
  assert.equal(sub.version, '1.0.0');
  assert.equal(sub.submitted_by, 'dev@example.com');

  const ok = await adm('POST', `/submissions/${sub.id}/approve`);
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().submission.status, 'approved');
  assert.equal(ok.json().game.status, 'published');
  assert.equal(ok.json().game.published_version, '1.0.0');
});

test('approved game appears in the public catalog', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/games',
    headers: auth(pub2Token),
  });
  const game = res.json().games.find((g) => g.slug === 'sky-dodge');
  assert.ok(game);
  assert.equal(game.version, '1.0.0');
});

// ------------------------------------------------- update + reject path

test('update flow: new build, submit, reject keeps the old live version', async () => {
  const zip = makeZip([{ name: 'sky.exe', data: 'MZ-sky-1.1.0' }]);
  createdZips.push(path.join(config.staticDir, 'games', 'sky-dodge', '1.1.0.zip'));
  assert.equal((await pubUpload('sky-dodge', '1.1.0', zip)).statusCode, 201);
  assert.equal(
    (await pub('POST', '/games/sky-dodge/submit', pubToken, { version: '1.1.0' })).statusCode,
    201
  );

  const queue = await adm('GET', '/submissions?status=pending');
  const sub = queue.json().submissions.find((s) => s.version === '1.1.0');
  const rej = await adm('POST', `/submissions/${sub.id}/reject`, {
    feedback: 'crashes on launch',
  });
  assert.equal(rej.statusCode, 200);
  assert.equal(rej.json().submission.status, 'rejected');

  // Still live at 1.0.0.
  const cat = await app.inject({
    method: 'GET',
    url: '/api/games',
    headers: auth(pub2Token),
  });
  assert.equal(cat.json().games.find((g) => g.slug === 'sky-dodge').version, '1.0.0');

  // Publisher sees the rejection feedback.
  const mine = await pub('GET', '/games');
  const entry = mine.json().games.find((g) => g.slug === 'sky-dodge');
  assert.equal(entry.submissions[0].status, 'rejected');
  assert.equal(entry.submissions[0].feedback, 'crashes on launch');
});

test('publisher can withdraw a pending submission and resubmit', async () => {
  assert.equal(
    (await pub('POST', '/games/sky-dodge/submit', pubToken, { version: '1.1.0' })).statusCode,
    201
  );
  const mine = await pub('GET', '/games');
  const sub = mine.json().games
    .find((g) => g.slug === 'sky-dodge')
    .submissions.find((s) => s.status === 'pending');
  const cancel = await pub('POST', `/submissions/${sub.id}/cancel`);
  assert.equal(cancel.statusCode, 200);

  const resub = await pub('POST', '/games/sky-dodge/submit', pubToken, { version: '1.1.0' });
  assert.equal(resub.statusCode, 201);
});

// ------------------------------------------------------------- ownership

test('admin can transfer a game to a publisher', async () => {
  await adm('POST', '/games', {
    slug: 'admin-made',
    title: 'Admin Made',
    executable_name: 'a.exe',
  });
  const other = db.prepare('SELECT id FROM users WHERE email = ?').get('other@example.com');
  const tr = await adm('POST', '/games/admin-made/transfer', { user_id: other.id });
  assert.equal(tr.statusCode, 200);
  assert.equal(tr.json().game.owner_email, 'other@example.com');
});

test('revoking publisher role cuts off the API again', async () => {
  const dev = db.prepare('SELECT id FROM users WHERE email = ?').get('dev@example.com');
  await adm('POST', `/users/${dev.id}/set-role`, { role: 'user' });
  assert.equal((await pub('GET', '/games')).statusCode, 403);
});

// ------------------------------------------------------------- zip helper

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Builds a minimal valid zip (STORE entries, no compression). */
function makeZip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data);
    const crc = crc32(data);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    parts.push(lh, name, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);

    offset += 30 + name.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBuf, eocd]);
}
