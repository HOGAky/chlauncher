/**
 * @file routes/games.js
 * Game catalog endpoints.
 *
 *  - GET  /api/games                  — list catalog (auth required)
 *  - GET  /api/games/:slug/download   — stream the packaged zip to an
 *    authenticated subscriber. Downloads are gated by an active
 *    subscription so builds never leak to expired accounts.
 */

import fs from 'node:fs';
import path from 'node:path';
import { listGames, findGameBySlug } from '../db.js';
import { hasActiveSubscription } from '../subscriptions.js';
import { config } from '../config.js';

/** Fields exposed to clients (internal file_name is intentionally hidden). */
function gameView(g) {
  return {
    slug: g.slug,
    title: g.title,
    description: g.description,
    version: g.version,
    executable_name: g.executable_name,
    cover_image: g.cover_image,
  };
}

/**
 * @param {import('fastify').FastifyInstance} app
 * @param {{db: import('node:sqlite').DatabaseSync, authenticate: Function}} opts
 */
export default async function gamesRoutes(app, { db, authenticate }) {
  app.addHook('preHandler', authenticate);

  /** GET /api/games — full catalog. */
  app.get('/', async () => ({ games: listGames(db).map(gameView) }));

  /**
   * GET /api/games/:slug/download — streams the zip artifact.
   * 403 SUBSCRIPTION_REQUIRED when the period has lapsed;
   * 404 when the catalog entry or its file is missing.
   */
  app.get('/:slug/download', async (request, reply) => {
    if (!hasActiveSubscription(db, request.auth.userId)) {
      return reply.code(403).send({ error: 'SUBSCRIPTION_REQUIRED' });
    }
    const game = findGameBySlug(db, request.params.slug);
    if (!game) return reply.code(404).send({ error: 'GAME_NOT_FOUND' });

    const filePath = path.join(config.staticDir, 'games', game.file_name);
    if (!fs.existsSync(filePath)) {
      return reply.code(404).send({ error: 'BUILD_NOT_UPLOADED' });
    }

    reply.header('Content-Type', 'application/zip');
    reply.header(
      'Content-Disposition',
      `attachment; filename="${game.file_name}"`
    );
    return reply.send(fs.createReadStream(filePath));
  });
}
