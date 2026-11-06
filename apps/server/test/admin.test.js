/**
 * @file admin.test.js
 * Tests for the admin surface (§1 roles, §3 admin API, §4 public catalog).
 * Runs on an in-memory DB via app.inject. ADMIN_EMAILS must be set before
 * the app modules load, so everything is imported dynamically inside `before`.
 *
 * Upload tests build tiny in-memory zips (STORE method, no compression) —
 * helpers `crc32`/`makeZip` live at the bottom.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';

process.env.ADMIN_EMAILS = 'root@example.com, owner@example.com ';

let app;
let db;
let config;
let buildApp;
let adminToken;
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

/** Creates a draft game via the admin API and tracks its zip for cleanup. */
async function createGame(slug, executable = 'game.exe') {
  const res = await app.inject({
    method: 'POST',
    url: '/api/admin/games',
    headers: auth(adminToken),
    payload: { slug, title: slug, description: 't', executable_name: executable },
  });
  return res;
}

/** Uploads a build zip (STORE) for `slug` at `version`. */
async function uploadBuild(slug, version, zipBuf, extraQuery = '') {
  const res = await app.inject({
    method: 'POST',
    url: `/api/admin/games/${slug}/builds?version=${version}${extraQuery}`,
    headers: { ...auth(adminToken), 'content-type': 'application/octet-stream' },
    payload: zipBuf,
  });
  return res;
}

before(async () => {
  ({ buildApp } = await import('../src/app.js'));
  ({ config } = await import('../src/config.js'));
  ({ app, db } = await buildApp({ databasePath: ':memory:' }));
  const { body } = await register('root@example.com');
  adminToken = body.token;
});

after(() => {
  for (const p of createdZips) fs.rmSync(p, { force: true });
});

// --------------------------------------------------------------- §1 roles

test('ADMIN_EMAILS grants role=admin on register', async () => {
  const { status, body } = await register('owner@example.com');
  assert.equal(status, 200);
  assert.equal(body.user.role, 'admin');
  assert.equal(jwt.decode(body.token).role, 'admin');
});

test('login re-syncs the role for ADMIN_EMAILS accounts', async () => {
  // Drop the env-listed account to 'user', then re-run the same sync the
  // login path performs — it must be promoted back to 'admin'.
  db.prepare("UPDATE users SET role = 'user' WHERE email = 'owner@example.com'").run();
  const { syncAdminRole } = await import('../src/auth.js');
  const user = db
    .prepare('SELECT * FROM users WHERE email = ?')
    .get('owner@example.com');
  syncAdminRole(db, user);
  assert.equal(user.role, 'admin');
});

test('regular users keep role=user and get a user-role JWT', async () => {
  const { body } = await register('plain@example.com');
  assert.equal(body.user.role, 'user');
  assert.equal(jwt.decode(body.token).role, 'user');
});

test('non-admin gets 403 on /api/admin/*', async () => {
  const { body } = await register('user2@example.com');
  const res = await app.inject({
    method: 'GET',
    url: '/api/admin/games',
    headers: auth(body.token),
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'FORBIDDEN');
});

// ---------------------------------------------------------- §3 admin API

test('create -> upload -> publish -> visible in public catalog', async () => {
  const created = await createGame('test-game');
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().game.status, 'draft');

  // Draft is invisible publicly even before any build exists.
  const anon = await register('viewer@example.com');
  let pub = await app.inject({
    method: 'GET',
    url: '/api/games',
    headers: auth(anon.body.token),
  });
  assert.ok(!pub.json().games.some((g) => g.slug === 'test-game'));

  const zip = makeZip([
    { name: 'game.exe', data: 'MZ fake exe bytes' },
    { name: 'data/config.json', data: '{}' },
  ]);
  const up = await uploadBuild('test-game', '1.0.0', zip, '&changelog=first');
  assert.equal(up.statusCode, 201);
  const build = up.json().build;
  const expectedSha = crypto.createHash('sha256').update(zip).digest('hex');
  assert.equal(build.sha256, expectedSha);
  assert.equal(build.size_bytes, zip.length);
  assert.equal(build.changelog, 'first');
  createdZips.push(
    path.join(config.staticDir, 'games', 'test-game', '1.0.0.zip')
  );

  const pub2 = await app.inject({
    method: 'POST',
    url: '/api/admin/games/test-game/publish',
    headers: { ...auth(adminToken), 'content-type': 'application/json' },
    payload: { version: '1.0.0' },
  });
  assert.equal(pub2.statusCode, 200);
  assert.equal(pub2.json().game.status, 'published');
  assert.equal(pub2.json().game.published_version, '1.0.0');

  // Public catalog now exposes version + sha256 + changelog.
  pub = await app.inject({
    method: 'GET',
    url: '/api/games',
    headers: auth(anon.body.token),
  });
  const row = pub.json().games.find((g) => g.slug === 'test-game');
  assert.ok(row);
  assert.equal(row.version, '1.0.0');
  assert.equal(row.sha256, expectedSha);
  assert.equal(row.changelog, 'first');
});

test('download serves the published build to subscribers only', async () => {
  // Subscriber flow: mock-pay then download.
  const { body } = await register('dl@example.com');
  const token = body.token;

  const denied = await app.inject({
    method: 'GET',
    url: '/api/games/test-game/download',
    headers: auth(token),
  });
  assert.equal(denied.statusCode, 403);

  await app.inject({
    method: 'POST',
    url: '/api/billing/mock-pay',
    headers: auth(token),
  });
  const dl = await app.inject({
    method: 'GET',
    url: '/api/games/test-game/download',
    headers: auth(token),
  });
  assert.equal(dl.statusCode, 200);
  assert.equal(dl.headers['content-type'], 'application/zip');
  const buf = dl.rawPayload;
  assert.equal(
    crypto.createHash('sha256').update(buf).digest('hex'),
    db.prepare(
      `SELECT b.sha256 FROM games g JOIN game_builds b ON b.id = g.published_build_id
       WHERE g.slug = 'test-game'`
    ).get().sha256
  );
});

test('duplicate (slug, version) upload is rejected with VERSION_EXISTS', async () => {
  const zip = makeZip([{ name: 'game.exe', data: 'v1' }]);
  const res = await uploadBuild('test-game', '1.0.0', zip);
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, 'VERSION_EXISTS');
});

test('zip validation: missing executable and traversal entries rejected', async () => {
  await createGame('zipcheck', 'need-this.exe');
  const noExe = await uploadBuild(
    'zipcheck',
    '1.0.0',
    makeZip([{ name: 'other.exe', data: 'x' }])
  );
  assert.equal(noExe.statusCode, 400);
  assert.equal(noExe.json().error, 'EXECUTABLE_MISSING');

  const evil = await uploadBuild(
    'zipcheck',
    '1.0.0',
    makeZip([
      { name: 'need-this.exe', data: 'x' },
      { name: '../escape.txt', data: 'x' },
    ])
  );
  assert.equal(evil.statusCode, 400);
  assert.equal(evil.json().error, 'UNSAFE_ZIP_PATH');
});

test('unpublish archives the game; rollback republishes previous build', async () => {
  // second build -> publish -> rollback -> previous build under patch+1.
  const zip2 = makeZip([{ name: 'game.exe', data: 'v2 bytes' }]);
  const up2 = await uploadBuild('test-game', '1.0.1', zip2);
  assert.equal(up2.statusCode, 201);
  createdZips.push(
    path.join(config.staticDir, 'games', 'test-game', '1.0.1.zip')
  );
  await app.inject({
    method: 'POST',
    url: '/api/admin/games/test-game/publish',
    headers: { ...auth(adminToken), 'content-type': 'application/json' },
    payload: { version: '1.0.1' },
  });

  const rb = await app.inject({
    method: 'POST',
    url: '/api/admin/games/test-game/rollback',
    headers: auth(adminToken),
  });
  assert.equal(rb.statusCode, 200);
  const game = rb.json().game;
  assert.equal(game.published_version, '1.0.2'); // copy of 1.0.0 content
  const rbBuild = game.builds.find((b) => b.version === '1.0.2');
  const v100 = game.builds.find((b) => b.version === '1.0.0');
  assert.equal(rbBuild.sha256, v100.sha256);
  createdZips.push(
    path.join(config.staticDir, 'games', 'test-game', '1.0.2.zip')
  );

  const un = await app.inject({
    method: 'POST',
    url: '/api/admin/games/test-game/unpublish',
    headers: auth(adminToken),
  });
  assert.equal(un.json().game.status, 'archived');

  const anon = await register('viewer2@example.com');
  const pub = await app.inject({
    method: 'GET',
    url: '/api/games',
    headers: auth(anon.body.token),
  });
  assert.ok(!pub.json().games.some((g) => g.slug === 'test-game'));
});

test('audit log records admin mutations', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/admin/audit',
    headers: auth(adminToken),
  });
  const actions = res.json().entries.map((e) => e.action);
  for (const a of ['create_game', 'upload_build', 'publish', 'rollback', 'unpublish']) {
    assert.ok(actions.includes(a), `audit missing ${a}`);
  }
});

test('admin users list shows subscription + masked hwid', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/admin/users?query=dl@example.com',
    headers: auth(adminToken),
  });
  const u = res.json().users.find((x) => x.email === 'dl@example.com');
  assert.ok(u);
  assert.equal(u.subscription.status, 'active');
  assert.ok(!u.hwid || u.hwid.includes('…'));
});

// ------------------------------------------------------------- zip maker

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
    lh.writeUInt16LE(20, 4); // version needed
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18); // compressed
    lh.writeUInt32LE(data.length, 22); // uncompressed
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
