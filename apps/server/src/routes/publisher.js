/**
 * @file routes/publisher.js
 * Publisher self-service API — game authors manage their own catalog
 * entries without admin intervention for day-to-day work.
 *
 * Flow: register game (draft, owner_id = caller) → upload builds →
 * submit a build for review → admin approves (goes live) or rejects
 * (feedback lands back here). Ownership is strictly enforced: a
 * publisher only ever sees `games.owner_id = <self>`; admins manage
 * everything through /api/admin and can transfer ownership.
 *
 *   GET    /api/publisher/games                  — own games + builds + submissions
 *   POST   /api/publisher/games                  — create draft {slug,title,executable_name,description?}
 *   PATCH  /api/publisher/games/:slug            — title/description/cover_image
 *   POST   /api/publisher/games/:slug/builds     — octet-stream zip upload
 *   POST   /api/publisher/games/:slug/submit     — {version} → pending review
 *   POST   /api/publisher/submissions/:id/cancel — withdraw a pending submission
 */

import rateLimit from '@fastify/rate-limit';
import { config } from '../config.js';
import { findUserById, nowIso } from '../db.js';
import { SLUG_RE, storeGameBuild } from '../build_store.js';

/**
 * @param {import('fastify').FastifyInstance} app
 * @param {{db: import('node:sqlite').DatabaseSync, requirePublisher: Function}} opts
 */
export default async function publisherRoutes(app, { db, requirePublisher }) {
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });
  app.addHook('preHandler', requirePublisher);

  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer' },
    (_req, body, done) => done(null, body)
  );

  const findOwnGame = (slug, userId) =>
    db
      .prepare('SELECT * FROM games WHERE slug = ? AND owner_id = ?')
      .get(slug, userId);

  const hasPending = (gameId) =>
    db
      .prepare(
        "SELECT 1 FROM game_submissions WHERE game_id = ? AND status = 'pending'"
      )
      .get(gameId);

  /** GET /api/publisher/games — everything the caller owns. */
  app.get('/games', async (request) => ({
    games: db
      .prepare('SELECT * FROM games WHERE owner_id = ? ORDER BY id')
      .all(request.auth.userId)
      .map((g) => publisherGameView(db, g)),
  }));

  /** POST /api/publisher/games — create a draft entry owned by the caller. */
  app.post('/games', async (request, reply) => {
    const { slug, title, description = '', executable_name } = request.body || {};
    if (!slug || !SLUG_RE.test(slug)) {
      return reply.code(400).send({ error: 'INVALID_SLUG' });
    }
    if (!title || !executable_name) {
      return reply.code(400).send({ error: 'MISSING_FIELDS' });
    }
    if (db.prepare('SELECT 1 FROM games WHERE slug = ?').get(slug)) {
      return reply.code(409).send({ error: 'SLUG_TAKEN' });
    }
    const info = db
      .prepare(
        `INSERT INTO games
           (slug, title, description, version, file_name, executable_name, status, owner_id, updated_at)
         VALUES (?, ?, ?, '', '', ?, 'draft', ?, ?)`
      )
      .run(slug, title, description, executable_name, request.auth.userId, nowIso());
    const game = db.prepare('SELECT * FROM games WHERE id = ?').get(Number(info.lastInsertRowid));
    return reply.code(201).send({ game: publisherGameView(db, game) });
  });

  /** PATCH /api/publisher/games/:slug — metadata; blocked during review. */
  app.patch('/games/:slug', async (request, reply) => {
    const game = findOwnGame(request.params.slug, request.auth.userId);
    if (!game) return reply.code(404).send({ error: 'GAME_NOT_FOUND' });
    if (hasPending(game.id)) {
      return reply.code(409).send({ error: 'REVIEW_PENDING' });
    }
    const { title, description, cover_image } = request.body || {};
    db.prepare(
      `UPDATE games SET
         title = COALESCE(?, title),
         description = COALESCE(?, description),
         cover_image = COALESCE(?, cover_image),
         updated_at = ?
       WHERE id = ?`
    ).run(title ?? null, description ?? null, cover_image ?? null, nowIso(), game.id);
    const updated = db.prepare('SELECT * FROM games WHERE id = ?').get(game.id);
    return { game: publisherGameView(db, updated) };
  });

  /**
   * POST /api/publisher/games/:slug/builds?version=X.Y.Z[&changelog=…]
   * Body: application/octet-stream zip — same pipeline as admin uploads.
   * A pending review does not block uploads (builds are immutable; the
   * submission references one specific build).
   */
  app.post(
    '/games/:slug/builds',
    { bodyLimit: config.maxBuildSize },
    async (request, reply) => {
      const game = findOwnGame(request.params.slug, request.auth.userId);
      if (!game) return reply.code(404).send({ error: 'GAME_NOT_FOUND' });
      const res = storeGameBuild(db, {
        game,
        version: request.query.version || '',
        changelog:
          request.query.changelog || request.headers['x-changelog'] || '',
        body: request.body,
        uploadedBy: request.auth.userId,
      });
      if (!res.ok) {
        const code = res.error === 'VERSION_EXISTS' ? 409 : 400;
        const { ok: _ok, error: _e, ...extra } = res;
        return reply.code(code).send({ error: res.error, ...extra });
      }
      return reply.code(201).send({ build: res.build });
    }
  );

  /**
   * POST /api/publisher/games/:slug/submit — {version}
   * Hands a build to the review queue. One pending submission per game.
   */
  app.post('/games/:slug/submit', async (request, reply) => {
    const game = findOwnGame(request.params.slug, request.auth.userId);
    if (!game) return reply.code(404).send({ error: 'GAME_NOT_FOUND' });
    if (hasPending(game.id)) {
      return reply.code(409).send({ error: 'REVIEW_PENDING' });
    }
    const { version } = request.body || {};
    const build = db
      .prepare('SELECT * FROM game_builds WHERE game_id = ? AND version = ?')
      .get(game.id, version);
    if (!build) return reply.code(404).send({ error: 'BUILD_NOT_FOUND' });
    const info = db
      .prepare(
        `INSERT INTO game_submissions
           (game_id, build_id, submitted_by, created_at)
         VALUES (?,?,?,?)`
      )
      .run(game.id, build.id, request.auth.userId, nowIso());
    return reply.code(201).send({
      submission: submissionView(
        db.prepare('SELECT * FROM game_submissions WHERE id = ?')
          .get(Number(info.lastInsertRowid)),
        game,
        build
      ),
    });
  });

  /** POST /api/publisher/submissions/:id/cancel — withdraw while pending. */
  app.post('/submissions/:id/cancel', async (request, reply) => {
    const s = db
      .prepare('SELECT * FROM game_submissions WHERE id = ?')
      .get(Number(request.params.id));
    if (!s || s.submitted_by !== request.auth.userId) {
      return reply.code(404).send({ error: 'SUBMISSION_NOT_FOUND' });
    }
    if (s.status !== 'pending') {
      return reply.code(409).send({ error: 'ALREADY_REVIEWED' });
    }
    db.prepare(
      "UPDATE game_submissions SET status = 'canceled', reviewed_at = ? WHERE id = ?"
    ).run(nowIso(), s.id);
    return { ok: true };
  });
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function publisherGameView(db, g) {
  const builds = db
    .prepare(
      `SELECT id, version, sha256, size_bytes, changelog, created_at
       FROM game_builds WHERE game_id = ?
       ORDER BY created_at DESC, id DESC`
    )
    .all(g.id);
  const submissions = db
    .prepare(
      `SELECT s.*, b.version
       FROM game_submissions s JOIN game_builds b ON b.id = s.build_id
       WHERE s.game_id = ? ORDER BY s.id DESC`
    )
    .all(g.id)
    .map((s) => submissionView(s, g, { version: s.version }));
  const published = db
    .prepare('SELECT version FROM game_builds WHERE id = ?')
    .get(g.published_build_id);
  const owner = g.owner_id ? findUserById(db, g.owner_id) : null;
  return {
    id: g.id,
    slug: g.slug,
    title: g.title,
    description: g.description,
    executable_name: g.executable_name,
    cover_image: g.cover_image,
    status: g.status,
    owner_email: owner?.email || null,
    published_version: published?.version || null,
    updated_at: g.updated_at,
    builds,
    submissions,
  };
}

function submissionView(s, game, build) {
  return {
    id: s.id,
    game_slug: game.slug,
    version: build.version,
    status: s.status,
    feedback: s.feedback,
    created_at: s.created_at,
    reviewed_at: s.reviewed_at,
  };
}
