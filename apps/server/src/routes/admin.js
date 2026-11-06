/**
 * @file routes/admin.js
 * Admin API (§3 of docs/admin-and-updates-spec.md) — every route is gated
 * by `requireAdmin` (JWT + users.role='admin' re-read from the DB) and a
 * dedicated rate limit. Every mutation is written to `admin_audit`.
 *
 * Game lifecycle: draft -> build upload -> publish -> (unpublish/rollback).
 * Builds are immutable: `(slug, version)` can never be re-uploaded, and a
 * rollback produces a NEW build with a bumped patch version.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import rateLimit from '@fastify/rate-limit';
import { config } from '../config.js';
import {
  findGameBySlug,
  findUserById,
  findSubscription,
  nowIso,
} from '../db.js';
import { subscriptionView } from '../subscriptions.js';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9a-z.]+)?$/i;

/**
 * Registers the admin routes on a Fastify instance.
 * @param {import('fastify').FastifyInstance} app
 * @param {{db: import('node:sqlite').DatabaseSync, requireAdmin: Function}} opts
 */
export default async function adminRoutes(app, { db, requireAdmin }) {
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
  app.addHook('preHandler', requireAdmin);

  // Raw build uploads arrive as application/octet-stream buffers.
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer' },
    (_req, body, done) => done(null, body)
  );

  /** Writes one admin_audit row; called on every mutation below. */
  function audit(actorId, action, target, meta = {}) {
    db.prepare(
      'INSERT INTO admin_audit (actor_id, action, target, meta, created_at) VALUES (?,?,?,?,?)'
    ).run(actorId, action, target, JSON.stringify(meta), nowIso());
  }

  // ---------------------------------------------------------------
  // Games
  // ---------------------------------------------------------------

  /** GET /api/admin/games — every game incl. drafts, with all builds. */
  app.get('/games', async () => ({
    games: listAdminGames(db),
  }));

  /** POST /api/admin/games — create a draft game entry. */
  app.post('/games', async (request, reply) => {
    const { slug, title, description = '', executable_name } = request.body || {};
    if (!slug || !SLUG_RE.test(slug)) {
      return reply.code(400).send({ error: 'INVALID_SLUG' });
    }
    if (!title || !executable_name) {
      return reply.code(400).send({ error: 'MISSING_FIELDS' });
    }
    if (findGameBySlug(db, slug)) {
      return reply.code(409).send({ error: 'SLUG_TAKEN' });
    }
    const info = db
      .prepare(
        `INSERT INTO games (slug, title, description, version, file_name, executable_name, status, updated_at)
         VALUES (?, ?, ?, '', '', ?, 'draft', ?)`
      )
      .run(slug, title, description, executable_name, nowIso());
    audit(request.auth.userId, 'create_game', slug, { title });
    return reply.code(201).send({ game: adminGameView(db, Number(info.lastInsertRowid)) });
  });

  /** PATCH /api/admin/games/:slug — title/description/cover_image. */
  app.patch('/games/:slug', async (request, reply) => {
    const game = findGameBySlug(db, request.params.slug);
    if (!game) return reply.code(404).send({ error: 'GAME_NOT_FOUND' });
    const { title, description, cover_image } = request.body || {};
    db.prepare(
      `UPDATE games SET
         title = COALESCE(?, title),
         description = COALESCE(?, description),
         cover_image = COALESCE(?, cover_image),
         updated_at = ?
       WHERE id = ?`
    ).run(title ?? null, description ?? null, cover_image ?? null, nowIso(), game.id);
    audit(request.auth.userId, 'update_game', game.slug, {
      fields: ['title', 'description', 'cover_image'].filter(
        (f) => request.body?.[f] !== undefined
      ),
    });
    return { game: adminGameView(db, game.id) };
  });

  /**
   * POST /api/admin/games/:slug/builds?version=X.Y.Z[&changelog=…]
   * Body: application/octet-stream zip. Validates the archive (executable at
   * root, no traversal), hashes it, writes atomically to
   * static/games/<slug>/<version>.zip and records an immutable build row.
   */
  app.post(
    '/games/:slug/builds',
    { bodyLimit: config.maxBuildSize },
    async (request, reply) => {
      const game = findGameBySlug(db, request.params.slug);
      if (!game) return reply.code(404).send({ error: 'GAME_NOT_FOUND' });

      const version = request.query.version || '';
      if (!VERSION_RE.test(version)) {
        return reply.code(400).send({ error: 'INVALID_VERSION' });
      }
      const changelog =
        request.query.changelog || request.headers['x-changelog'] || '';

      if (!Buffer.isBuffer(request.body) || request.body.length === 0) {
        return reply.code(400).send({ error: 'EMPTY_BODY' });
      }
      const body = request.body;

      const dup = db
        .prepare('SELECT id FROM game_builds WHERE game_id = ? AND version = ?')
        .get(game.id, version);
      if (dup) return reply.code(409).send({ error: 'VERSION_EXISTS' });

      // Zip sanity: readable central directory, executable at root,
      // no absolute/parent-traversal entries.
      let entries;
      try {
        entries = listZipEntries(body);
      } catch {
        return reply.code(400).send({ error: 'INVALID_ZIP' });
      }
      const bad = entries.find(
        (n) => n.includes('..') || n.startsWith('/') || /^[a-zA-Z]:/.test(n)
      );
      if (bad) {
        return reply.code(400).send({ error: 'UNSAFE_ZIP_PATH', entry: bad });
      }
      if (!entries.includes(game.executable_name)) {
        return reply.code(400).send({
          error: 'EXECUTABLE_MISSING',
          expected: game.executable_name,
        });
      }

      const sha256 = crypto.createHash('sha256').update(body).digest('hex');
      const rel = `${game.slug}/${version}.zip`;
      const dir = path.join(config.staticDir, 'games', game.slug);
      const dst = path.join(config.staticDir, 'games', rel);
      const tmp = `${dst}.tmp-${process.pid}`;
      fs.mkdirSync(dir, { recursive: true });
      try {
        fs.writeFileSync(tmp, body);
        fs.renameSync(tmp, dst);
      } catch (err) {
        fs.rmSync(tmp, { force: true });
        throw err;
      }

      const info = db
        .prepare(
          `INSERT INTO game_builds
             (game_id, version, file_name, sha256, size_bytes, changelog, uploaded_by, created_at)
           VALUES (?,?,?,?,?,?,?,?)`
        )
        .run(
          game.id, version, rel, sha256, body.length,
          String(changelog), request.auth.userId, nowIso()
        );
      audit(request.auth.userId, 'upload_build', game.slug, {
        version, sha256, size_bytes: body.length,
      });
      return reply.code(201).send({
        build: db
          .prepare('SELECT * FROM game_builds WHERE id = ?')
          .get(Number(info.lastInsertRowid)),
      });
    }
  );

  /** POST /api/admin/games/:slug/publish — {version} becomes live. */
  app.post('/games/:slug/publish', async (request, reply) => {
    const game = findGameBySlug(db, request.params.slug);
    if (!game) return reply.code(404).send({ error: 'GAME_NOT_FOUND' });
    const { version } = request.body || {};
    const build = db
      .prepare('SELECT * FROM game_builds WHERE game_id = ? AND version = ?')
      .get(game.id, version);
    if (!build) return reply.code(404).send({ error: 'BUILD_NOT_FOUND' });
    db.prepare(
      `UPDATE games SET published_build_id = ?, status = 'published', updated_at = ? WHERE id = ?`
    ).run(build.id, nowIso(), game.id);
    audit(request.auth.userId, 'publish', game.slug, { version });
    return { game: adminGameView(db, game.id) };
  });

  /** POST /api/admin/games/:slug/unpublish — hides from public catalog. */
  app.post('/games/:slug/unpublish', async (request, reply) => {
    const game = findGameBySlug(db, request.params.slug);
    if (!game) return reply.code(404).send({ error: 'GAME_NOT_FOUND' });
    db.prepare(
      `UPDATE games SET status = 'archived', updated_at = ? WHERE id = ?`
    ).run(nowIso(), game.id);
    audit(request.auth.userId, 'unpublish', game.slug, {});
    return { game: adminGameView(db, game.id) };
  });

  /**
   * POST /api/admin/games/:slug/rollback — copies the newest build that is
   * NOT the published one into a fresh `<published.patch+1>` build and
   * publishes it (§9.3: users only ever see forward version movement).
   */
  app.post('/games/:slug/rollback', async (request, reply) => {
    const game = findGameBySlug(db, request.params.slug);
    if (!game) return reply.code(404).send({ error: 'GAME_NOT_FOUND' });
    const published = game.published_build_id
      ? db.prepare('SELECT * FROM game_builds WHERE id = ?').get(game.published_build_id)
      : null;
    if (!published) return reply.code(400).send({ error: 'NOTHING_PUBLISHED' });
    const previous = db
      .prepare(
        `SELECT * FROM game_builds
         WHERE game_id = ? AND id != ?
         ORDER BY created_at DESC, id DESC LIMIT 1`
      )
      .get(game.id, published.id);
    if (!previous) return reply.code(400).send({ error: 'NO_PREVIOUS_BUILD' });

    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(published.version);
    if (!m) return reply.code(400).send({ error: 'CANNOT_BUMP_VERSION' });
    const newVersion = `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
    if (
      db.prepare('SELECT 1 FROM game_builds WHERE game_id = ? AND version = ?')
        .get(game.id, newVersion)
    ) {
      return reply.code(409).send({ error: 'VERSION_EXISTS', version: newVersion });
    }

    const rel = `${game.slug}/${newVersion}.zip`;
    fs.copyFileSync(
      path.join(config.staticDir, 'games', previous.file_name),
      path.join(config.staticDir, 'games', rel)
    );
    const info = db
      .prepare(
        `INSERT INTO game_builds
           (game_id, version, file_name, sha256, size_bytes, changelog, uploaded_by, created_at)
         VALUES (?,?,?,?,?,?,?,?)`
      )
      .run(
        game.id, newVersion, rel, previous.sha256, previous.size_bytes,
        `Rollback to ${previous.version}`, request.auth.userId, nowIso()
      );
    db.prepare(
      `UPDATE games SET published_build_id = ?, status = 'published', updated_at = ? WHERE id = ?`
    ).run(Number(info.lastInsertRowid), nowIso(), game.id);
    audit(request.auth.userId, 'rollback', game.slug, {
      from: published.version,
      to: previous.version,
      as: newVersion,
    });
    return { game: adminGameView(db, game.id) };
  });

  // ---------------------------------------------------------------
  // Users
  // ---------------------------------------------------------------

  /** GET /api/admin/users?query= — search users w/ subscription + payments. */
  app.get('/users', async (request) => {
    const q = String(request.query.query || '').trim();
    const rows = q
      ? db
          .prepare('SELECT * FROM users WHERE email LIKE ? ORDER BY id DESC LIMIT 50')
          .all(`%${q}%`)
      : db.prepare('SELECT * FROM users ORDER BY id DESC LIMIT 50').all();
    return { users: rows.map((u) => adminUserView(db, u)) };
  });

  /** POST /api/admin/users/:id/reset-hwid — unbind HWID without cooldown. */
  app.post('/users/:id/reset-hwid', async (request, reply) => {
    const user = findUserById(db, Number(request.params.id));
    if (!user) return reply.code(404).send({ error: 'USER_NOT_FOUND' });
    db.prepare('UPDATE users SET hwid = NULL WHERE id = ?').run(user.id);
    audit(request.auth.userId, 'reset_hwid', user.email, {});
    return { ok: true, user: adminUserView(db, findUserById(db, user.id)) };
  });

  // ---------------------------------------------------------------
  // Audit log
  // ---------------------------------------------------------------

  /** GET /api/admin/audit — last 200 entries, newest first. */
  app.get('/audit', async () => ({
    entries: db
      .prepare(
        `SELECT a.*, u.email AS actor_email
         FROM admin_audit a JOIN users u ON u.id = a.actor_id
         ORDER BY a.id DESC LIMIT 200`
      )
      .all(),
  }));
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function listAdminGames(db) {
  const games = db.prepare('SELECT * FROM games ORDER BY id').all();
  const builds = db
    .prepare(
      `SELECT b.*, u.email AS uploaded_by_email
       FROM game_builds b LEFT JOIN users u ON u.id = b.uploaded_by
       ORDER BY b.created_at DESC, b.id DESC`
    )
    .all();
  const byGame = new Map();
  for (const b of builds) {
    if (!byGame.has(b.game_id)) byGame.set(b.game_id, []);
    byGame.get(b.game_id).push(buildView(b));
  }
  return games.map((g) => gameViewFull(g, byGame.get(g.id) || []));
}

function adminGameView(db, gameId) {
  const g = db.prepare('SELECT * FROM games WHERE id = ?').get(gameId);
  const builds = db
    .prepare(
      `SELECT b.*, u.email AS uploaded_by_email
       FROM game_builds b LEFT JOIN users u ON u.id = b.uploaded_by
       WHERE b.game_id = ? ORDER BY b.created_at DESC, b.id DESC`
    )
    .all(gameId);
  return gameViewFull(g, builds.map(buildView));
}

function gameViewFull(g, builds) {
  const published = builds.find((b) => b.id === g.published_build_id);
  return {
    id: g.id,
    slug: g.slug,
    title: g.title,
    description: g.description,
    executable_name: g.executable_name,
    cover_image: g.cover_image,
    status: g.status,
    published_version: published?.version || null,
    updated_at: g.updated_at,
    builds,
  };
}

function buildView(b) {
  return {
    id: b.id,
    version: b.version,
    sha256: b.sha256,
    size_bytes: b.size_bytes,
    changelog: b.changelog,
    uploaded_by: b.uploaded_by_email || null,
    created_at: b.created_at,
  };
}

function adminUserView(db, u) {
  const sub = findSubscription(db, u.id);
  const payments = db
    .prepare(
      'SELECT * FROM payments WHERE user_id = ? ORDER BY id DESC LIMIT 20'
    )
    .all(u.id);
  const masked = u.hwid ? `${u.hwid.slice(0, 8)}…` : null;
  return {
    id: u.id,
    email: u.email,
    role: u.role,
    hwid: masked,
    created_at: u.created_at,
    subscription: subscriptionView(sub),
    payments,
  };
}

// ---------------------------------------------------------------------------
// Minimal zip reader — central directory only, good enough to list entries.
// ---------------------------------------------------------------------------

/**
 * Lists file names in a zip buffer by walking the end-of-central-directory
 * record. Throws on malformed archives.
 * @param {Buffer} buf
 * @returns {string[]}
 */
function listZipEntries(buf) {
  const EOCD = 0x06054b50;
  const CDIR = 0x02014b50;
  // EOCD lives in the last 64 KiB + 22 bytes of the file.
  let eocd = -1;
  for (
    let i = buf.length - 22;
    i >= Math.max(0, buf.length - 22 - 65536);
    i--
  ) {
    if (buf.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('EOCD not found');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const names = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== CDIR) throw new Error('bad central dir');
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    names.push(buf.toString('utf8', off + 46, off + 46 + nameLen));
    off += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}
