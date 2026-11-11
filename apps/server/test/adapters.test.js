/**
 * @file adapters.test.js
 * External game adapters (parity spec §10.3): games.kind='adapter' and
 * adapter_manifest survive create/patch and reach the public catalog.
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.ADMIN_EMAILS = 'admin@example.com';
process.env.ENABLE_MOCK_BILLING = '1';

let app;
let db;
let adminToken;

const auth = (token) => ({ authorization: `Bearer ${token}` });

async function register(email) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password: 'secret123', hwid: `HW-${email}` },
  });
  return res.json();
}

/** Directly seeds a published game row with a build — the catalog JOIN
 *  needs a published_build_id; file bytes aren't needed for listing. */
function seedPublished(slug, { kind = 'game', manifest = '' } = {}) {
  const g = db
    .prepare(
      `INSERT INTO games (slug, title, description, version, file_name, executable_name,
                          status, is_free, kind, adapter_manifest, updated_at)
       VALUES (?, ?, ?, '', '', ?, 'published', 0, ?, ?, ?)`
    )
    .run(slug, `T ${slug}`, '', 'x.exe', kind, manifest, new Date().toISOString());
  const b = db
    .prepare(
      `INSERT INTO game_builds (game_id, version, file_name, sha256, size_bytes, created_at)
       VALUES (?, '1.0.0', ?, '', 0, ?)`
    )
    .run(g.lastInsertRowid, `${slug}/1.0.0.zip`, new Date().toISOString());
  db.prepare('UPDATE games SET published_build_id = ? WHERE id = ?')
    .run(b.lastInsertRowid, g.lastInsertRowid);
}

before(async () => {
  const { buildApp } = await import('../src/app.js');
  ({ app, db } = await buildApp({ databasePath: ':memory:' }));
  adminToken = (await register('admin@example.com')).token;
});

test('admin create accepts kind=adapter + manifest', async () => {
  const manifest = JSON.stringify({ game: 'gta5', actions: [{ id: 'explode' }] });
  const res = await app.inject({
    method: 'POST',
    url: '/api/admin/games',
    headers: auth(adminToken),
    payload: {
      slug: 'gta5-adapter',
      title: 'GTA V Adapter',
      executable_name: 'gta5.exe',
      kind: 'adapter',
      adapter_manifest: manifest,
    },
  });
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(res.json().game.kind, 'adapter');
  assert.equal(res.json().game.adapter_manifest, manifest);
});

test('admin create rejects bad kind / malformed manifest', async () => {
  let res = await app.inject({
    method: 'POST',
    url: '/api/admin/games',
    headers: auth(adminToken),
    payload: { slug: 'bad-kind', title: 'x', executable_name: 'x', kind: 'virus' },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'INVALID_KIND');

  res = await app.inject({
    method: 'POST',
    url: '/api/admin/games',
    headers: auth(adminToken),
    payload: {
      slug: 'bad-manifest', title: 'x', executable_name: 'x',
      adapter_manifest: '{not json',
    },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'INVALID_MANIFEST');
});

test('public catalog exposes kind + adapter_manifest', async () => {
  seedPublished('plain-game');
  const manifest = JSON.stringify({
    game: '7dtd',
    actions: [{ id: 'spawn_horde', label: 'Орда' }],
  });
  seedPublished('dtd-adapter', { kind: 'adapter', manifest });

  const { token } = await register('viewer@example.com');
  const res = await app.inject({
    method: 'GET',
    url: '/api/games',
    headers: auth(token),
  });
  const games = res.json().games;
  const plain = games.find((g) => g.slug === 'plain-game');
  const adapter = games.find((g) => g.slug === 'dtd-adapter');
  assert.equal(plain.kind, 'game');
  assert.equal(adapter.kind, 'adapter');
  assert.equal(adapter.adapter_manifest, manifest);
});
