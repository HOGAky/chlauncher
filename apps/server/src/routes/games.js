/**
 * @file routes/games.js
 * Public game catalog endpoints (spec §4).
 *
 *  - GET  /api/games                  — published games only, joined with
 *    their published build (version, sha256, size, changelog come from the
 *    immutable build row, not the mutable game row).
 *  - GET  /api/games/:slug/download   — streams the published build's zip
 *    to an authenticated subscriber. Downloads are gated by an active
 *    subscription so builds never leak to expired accounts.
 */

import fs from 'node:fs';
import path from 'node:path';
import { hasActiveSubscription } from '../subscriptions.js';
import { config } from '../config.js';

/** Game slug boundary rule — same as admin.js and the launcher. */
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * Resolves a build's stored relative path and verifies it stays inside
 * `<staticDir>/games` after canonicalization — `..`, absolute paths,
 * backslashes and URL-encoded traversal are rejected before touching fs.
 */
function safeBuildPath(fileName) {
  if (
    !fileName ||
    typeof fileName !== 'string' ||
    fileName.includes('..') ||
    fileName.includes('\\') ||
    fileName.includes('%') ||
    path.isAbsolute(fileName)
  ) {
    return null;
  }
  const gamesRoot = path.resolve(config.staticDir, 'games');
  const resolved = path.resolve(gamesRoot, fileName);
  return resolved.startsWith(gamesRoot + path.sep) ? resolved : null;
}

/** Fields exposed to clients (internal file_name is intentionally hidden). */
function gameView(row) {
  return {
    slug: row.slug,
    title: row.title,
    description: row.description,
    version: row.version,
    sha256: row.sha256,
    size_bytes: row.size_bytes,
    executable_name: row.executable_name,
    cover_image: row.cover_image,
    changelog: row.changelog,
    is_free: !!row.is_free,
    // §10.3: 'adapter' entries are external mods, not launcher games;
    // adapter_manifest is a JSON blob ({actions:[…]}) parsed client-side.
    kind: row.kind || 'game',
    adapter_manifest: row.adapter_manifest || '',
  };
}

/** Published games joined with their published build rows. */
function listPublished(db) {
  return db
    .prepare(
      `SELECT g.slug, g.title, g.description, g.executable_name, g.cover_image, g.is_free,
              g.kind, g.adapter_manifest,
              b.version, b.sha256, b.size_bytes, b.changelog
       FROM games g
       JOIN game_builds b ON b.id = g.published_build_id
       WHERE g.status = 'published'
       ORDER BY g.id`
    )
    .all();
}

/** One published game + its published build, or undefined. */
function findPublished(db, slug) {
  return db
    .prepare(
      `SELECT g.slug, g.title, g.description, g.executable_name, g.cover_image, g.is_free,
              g.kind, g.adapter_manifest,
              b.version, b.sha256, b.size_bytes, b.changelog, b.file_name
       FROM games g
       JOIN game_builds b ON b.id = g.published_build_id
       WHERE g.slug = ? AND g.status = 'published'`
    )
    .get(slug);
}

/**
 * @param {import('fastify').FastifyInstance} app
 * @param {{db: import('node:sqlite').DatabaseSync, authenticate: Function}} opts
 */
export default async function gamesRoutes(app, { db, authenticate }) {
  app.addHook('preHandler', authenticate);

  /** GET /api/games — published catalog. */
  app.get('/', async () => ({ games: listPublished(db).map(gameView) }));

  /**
   * GET /api/games/:slug/download — streams the published build's zip.
   * 403 SUBSCRIPTION_REQUIRED when the period has lapsed;
   * 404 when the game isn't published or its file is missing.
   */
  app.get('/:slug/download', async (request, reply) => {
    if (!SLUG_RE.test(request.params.slug || '')) {
      return reply.code(400).send({ error: 'INVALID_SLUG' });
    }
    const game = findPublished(db, request.params.slug);
    if (!game) return reply.code(404).send({ error: 'GAME_NOT_FOUND' });
    // §8.3: free-tier users may download is_free games; everything else
    // requires an active subscription (any paid plan).
    if (!game.is_free && !hasActiveSubscription(db, request.auth.userId)) {
      return reply.code(403).send({ error: 'SUBSCRIPTION_REQUIRED' });
    }

    const filePath = safeBuildPath(game.file_name);
    if (!filePath || !fs.existsSync(filePath)) {
      return reply.code(404).send({ error: 'BUILD_NOT_UPLOADED' });
    }

    reply.header('Content-Type', 'application/zip');
    reply.header(
      'Content-Disposition',
      `attachment; filename="${game.slug}-${game.version}.zip"`
    );
    return reply.send(fs.createReadStream(filePath));
  });
}
