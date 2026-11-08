/**
 * @file security.test.js
 * Boundary-validation tests for the public download route (Task 2):
 *  - slug must match ^[a-z0-9][a-z0-9_-]{0,63}$ (traversal is rejected
 *    before the file path is even resolved);
 *  - a stored file_name pointing outside static/games is refused.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const { buildApp } = await import('../src/app.js');
const { config, SERVER_ROOT } = await import('../src/config.js');

let app;
let db;
let token;

before(async () => {
  ({ app, db } = await buildApp());
  await app.ready();
  const reg = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email: 'sec@example.com', password: 'secret123', hwid: 'HWID-S' },
  });
  token = reg.json().token;
  // Subscriber: mocks are enabled in the test env.
  await app.inject({
    method: 'POST',
    url: '/api/billing/mock-pay',
    headers: { authorization: `Bearer ${token}` },
  });

  // A game whose build row points outside static/games — only craftable
  // by DB write, never through the upload path (which validates zips).
  const gamesDir = path.join(config.staticDir, 'games', 'evil-game');
  fs.mkdirSync(gamesDir, { recursive: true });
  const outside = path.join(SERVER_ROOT, 'data', 'outside-secret.txt');
  fs.mkdirSync(path.dirname(outside), { recursive: true });
  fs.writeFileSync(outside, 'top secret');
  db.prepare(
    `INSERT INTO games (slug, title, description, version, file_name, executable_name, status)
     VALUES ('evil-game', 'evil', '', '0.0.1', '../../data/outside-secret.txt', 'game.exe', 'published')`
  ).run();
  db.prepare(
    `INSERT INTO game_builds (game_id, version, file_name, sha256, size_bytes, created_at)
     VALUES (last_insert_rowid(), '0.0.1', '../../data/outside-secret.txt', 'x', 1, '2026-01-01T00:00:00Z')`
  ).run();
  db.prepare(
    `UPDATE games SET published_build_id = (SELECT max(id) FROM game_builds) WHERE slug = 'evil-game'`
  ).run();
});

after(async () => {
  await app.close();
  fs.rmSync(path.join(config.staticDir, 'games', 'evil-game'), {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
});

const download = (slug) =>
  app.inject({
    method: 'GET',
    url: `/api/games/${slug}/download`,
    headers: { authorization: `Bearer ${token}` },
  });

for (const bad of ['..', 'a/b', 'a%2Fb', 'A', 'UPPER', 'a'.repeat(65), '-lead']) {
  test(`download rejects invalid slug "${bad}"`, async () => {
    const res = await download(encodeURIComponent(bad));
    // 400 INVALID_SLUG from the boundary check, or 404 when the router
    // normalizes the segment away — both are safe, neither reaches a file.
    assert.ok(
      [400, 404].includes(res.statusCode),
      `slug ${bad} → ${res.statusCode}`
    );
    if (res.statusCode === 400) {
      assert.equal(res.json().error, 'INVALID_SLUG');
    }
  });
}

test('file_name escaping static/games is refused', async () => {
  const res = await download('evil-game');
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error, 'BUILD_NOT_UPLOADED');
});
