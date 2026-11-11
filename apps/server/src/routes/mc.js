/**
 * @file routes/mc.js
 * Minecraft plugin catalog endpoints (parity spec §9.4).
 *
 *  - GET /api/mc/plugins                — active catalog (name, version,
 *    sha256, premium flag). The launcher cross-checks the sha256 after
 *    download — it is part of the integrity contract, not just metadata.
 *  - GET /api/mc/plugins/:slug/download — streams the jar to an
 *    authenticated user. `premium` rows additionally require the plan's
 *    `mc_premium_plugins` entitlement (expert tier in the defaults).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import {
  activePlanForUser,
  findMcPlugin,
  listMcPlugins,
} from '../db.js';

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * Resolves a plugin's stored relative path and verifies it stays inside
 * `<staticDir>/plugins` after canonicalization — same traversal rules
 * as the game-build guard in routes/games.js.
 */
function safePluginPath(fileName) {
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
  const root = path.resolve(config.staticDir, 'plugins');
  const resolved = path.resolve(root, fileName);
  return resolved.startsWith(root + path.sep) ? resolved : null;
}

/**
 * @param {import('fastify').FastifyInstance} app
 * @param {{db: import('node:sqlite').DatabaseSync, authenticate: Function}} opts
 */
export default async function mcRoutes(app, { db, authenticate }) {
  app.addHook('preHandler', authenticate);

  /** GET /api/mc/plugins — catalog for any logged-in user. */
  app.get('/plugins', async () => ({ plugins: listMcPlugins(db) }));

  /**
   * GET /api/mc/plugins/:slug/download — jar stream.
   * 403 PLAN_LIMIT:mc_premium_plugins for premium rows on free/pro plans;
   * 404 when the plugin isn't active or its file is missing.
   */
  app.get('/plugins/:slug/download', async (request, reply) => {
    if (!SLUG_RE.test(request.params.slug || '')) {
      return reply.code(400).send({ error: 'INVALID_SLUG' });
    }
    const plugin = findMcPlugin(db, request.params.slug);
    if (!plugin || !plugin.active) {
      return reply.code(404).send({ error: 'PLUGIN_NOT_FOUND' });
    }
    if (plugin.premium) {
      const plan = activePlanForUser(db, request.auth.userId);
      if (!plan?.entitlements?.mc_premium_plugins) {
        return reply.code(403).send({ error: 'PLAN_LIMIT:mc_premium_plugins' });
      }
    }
    const filePath = safePluginPath(plugin.file_name);
    if (!filePath || !fs.existsSync(filePath)) {
      return reply.code(404).send({ error: 'PLUGIN_FILE_MISSING' });
    }
    reply.header('Content-Type', 'application/java-archive');
    reply.header(
      'Content-Disposition',
      `attachment; filename="${plugin.slug}-${plugin.version}.jar"`
    );
    return reply.send(fs.createReadStream(filePath));
  });
}
