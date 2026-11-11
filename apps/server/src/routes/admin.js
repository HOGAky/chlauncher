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
  nowIso,
  recordDeviceEvent,
  findPlan,
  listAllPlans,
  usageForMonth,
  currentMonth,
  findMcPlugin,
  listAllMcPlugins,
} from '../db.js';
import { subscriptionView, recordPayment, refreshSubscription } from '../subscriptions.js';
import { ipHash } from '../hwid.js';
import { SLUG_RE, storeGameBuild } from '../build_store.js';

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
    const { slug, title, description = '', executable_name, is_free } = request.body || {};
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
        `INSERT INTO games (slug, title, description, version, file_name, executable_name, status, is_free, updated_at)
         VALUES (?, ?, ?, '', '', ?, 'draft', ?, ?)`
      )
      .run(slug, title, description, executable_name, is_free ? 1 : 0, nowIso());
    audit(request.auth.userId, 'create_game', slug, { title });
    return reply.code(201).send({ game: adminGameView(db, Number(info.lastInsertRowid)) });
  });

  /** PATCH /api/admin/games/:slug — title/description/cover_image. */
  app.patch('/games/:slug', async (request, reply) => {
    const game = findGameBySlug(db, request.params.slug);
    if (!game) return reply.code(404).send({ error: 'GAME_NOT_FOUND' });
    const { title, description, cover_image, is_free } = request.body || {};
    db.prepare(
      `UPDATE games SET
         title = COALESCE(?, title),
         description = COALESCE(?, description),
         cover_image = COALESCE(?, cover_image),
         is_free = COALESCE(?, is_free),
         updated_at = ?
       WHERE id = ?`
    ).run(
      title ?? null,
      description ?? null,
      cover_image ?? null,
      is_free === undefined ? null : is_free ? 1 : 0,
      nowIso(),
      game.id
    );
    audit(request.auth.userId, 'update_game', game.slug, {
      fields: ['title', 'description', 'cover_image', 'is_free'].filter(
        (f) => request.body?.[f] !== undefined
      ),
    });
    return { game: adminGameView(db, game.id) };
  });

  /**
   * POST /api/admin/games/:slug/builds?version=X.Y.Z[&changelog=…]
   * Body: application/octet-stream zip. Same validation/persistence
   * pipeline as the publisher API (see build_store.js).
   */
  app.post(
    '/games/:slug/builds',
    { bodyLimit: config.maxBuildSize },
    async (request, reply) => {
      const game = findGameBySlug(db, request.params.slug);
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
      audit(request.auth.userId, 'upload_build', game.slug, {
        version: res.build.version,
        sha256: res.build.sha256,
        size_bytes: res.build.size_bytes,
      });
      return reply.code(201).send({ build: res.build });
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

  /** POST /api/admin/games/:slug/transfer — {user_id} sets games.owner_id. */
  app.post('/games/:slug/transfer', async (request, reply) => {
    const game = findGameBySlug(db, request.params.slug);
    if (!game) return reply.code(404).send({ error: 'GAME_NOT_FOUND' });
    const user = findUserById(db, Number(request.body?.user_id));
    if (!user) return reply.code(404).send({ error: 'USER_NOT_FOUND' });
    db.prepare('UPDATE games SET owner_id = ?, updated_at = ? WHERE id = ?')
      .run(user.id, nowIso(), game.id);
    audit(request.auth.userId, 'transfer_game', game.slug, { to: user.email });
    return { game: adminGameView(db, game.id) };
  });

  // ---------------------------------------------------------------
  // Review queue (publisher submissions)
  // ---------------------------------------------------------------

  /**
   * GET /api/admin/submissions?status=pending|approved|rejected|canceled|all
   * Review queue for publisher-submitted builds.
   */
  app.get('/submissions', async (request) => {
    const VALID = new Set(['pending', 'approved', 'rejected', 'canceled']);
    const status = String(request.query.status || 'pending');
    const where =
      status === 'all'
        ? '1=1'
        : `s.status = '${VALID.has(status) ? status : 'pending'}'`;
    const rows = db
      .prepare(
        `SELECT s.*, g.slug AS game_slug, g.title AS game_title,
                b.version, u.email AS submitted_by_email
         FROM game_submissions s
         JOIN games g ON g.id = s.game_id
         JOIN game_builds b ON b.id = s.build_id
         JOIN users u ON u.id = s.submitted_by
         WHERE ${where}
         ORDER BY s.id DESC LIMIT 200`
      )
      .all();
    return { submissions: rows.map(submissionView) };
  });

  /** POST /api/admin/submissions/:id/approve — build becomes live. */
  app.post('/submissions/:id/approve', async (request, reply) => {
    const s = db
      .prepare('SELECT * FROM game_submissions WHERE id = ?')
      .get(Number(request.params.id));
    if (!s) return reply.code(404).send({ error: 'SUBMISSION_NOT_FOUND' });
    if (s.status !== 'pending') {
      return reply.code(409).send({ error: 'ALREADY_REVIEWED' });
    }
    const game = db.prepare('SELECT * FROM games WHERE id = ?').get(s.game_id);
    const build = db
      .prepare('SELECT * FROM game_builds WHERE id = ?')
      .get(s.build_id);
    db.prepare(
      `UPDATE game_submissions
       SET status = 'approved', reviewer_id = ?, reviewed_at = ? WHERE id = ?`
    ).run(request.auth.userId, nowIso(), s.id);
    db.prepare(
      `UPDATE games SET published_build_id = ?, status = 'published', updated_at = ? WHERE id = ?`
    ).run(s.build_id, nowIso(), s.game_id);
    audit(request.auth.userId, 'approve_submission', game.slug, {
      version: build.version,
      submission_id: s.id,
    });
    return {
      submission: findSubmissionView(db, s.id),
      game: adminGameView(db, game.id),
    };
  });

  /** POST /api/admin/submissions/:id/reject — {feedback} back to publisher. */
  app.post('/submissions/:id/reject', async (request, reply) => {
    const s = db
      .prepare('SELECT * FROM game_submissions WHERE id = ?')
      .get(Number(request.params.id));
    if (!s) return reply.code(404).send({ error: 'SUBMISSION_NOT_FOUND' });
    if (s.status !== 'pending') {
      return reply.code(409).send({ error: 'ALREADY_REVIEWED' });
    }
    const feedback = String(request.body?.feedback || '').slice(0, 2000);
    const game = db.prepare('SELECT * FROM games WHERE id = ?').get(s.game_id);
    const build = db
      .prepare('SELECT * FROM game_builds WHERE id = ?')
      .get(s.build_id);
    db.prepare(
      `UPDATE game_submissions
       SET status = 'rejected', feedback = ?, reviewer_id = ?, reviewed_at = ?
       WHERE id = ?`
    ).run(feedback, request.auth.userId, nowIso(), s.id);
    audit(request.auth.userId, 'reject_submission', game.slug, {
      version: build.version,
      submission_id: s.id,
      feedback,
    });
    return { submission: findSubmissionView(db, s.id) };
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

  /**
   * POST /api/admin/users/:id/grant-days — {days, comment?}
   * Manual subscription extension (spec §5.2): writes a provider='manual'
   * payment row, stacks `days` onto the subscription and audits the action.
   * This is the working "sell by invoice" path until a provider is wired.
   */
  app.post('/users/:id/grant-days', async (request, reply) => {
    const user = findUserById(db, Number(request.params.id));
    if (!user) return reply.code(404).send({ error: 'USER_NOT_FOUND' });
    const { days, comment } = request.body || {};
    const n = Number(days);
    if (!Number.isInteger(n) || n <= 0 || n > 3650) {
      return reply.code(400).send({ error: 'INVALID_DAYS' });
    }
    recordPayment(db, {
      userId: user.id,
      provider: 'manual',
      days: n,
      actorId: request.auth.userId,
    });
    audit(request.auth.userId, 'grant_days', user.email, {
      days: n,
      comment: comment || null,
    });
    const sub = refreshSubscription(db, user.id);
    return { ok: true, subscription: subscriptionView(sub) };
  });

  /**
   * POST /api/admin/users/:id/set-role — {role: 'user'|'publisher'|'admin'}
   * Promotes/demotes a publisher or admin. Self-changes are refused so an
   * admin can't accidentally lock themselves out of the panel.
   */
  app.post('/users/:id/set-role', async (request, reply) => {
    const user = findUserById(db, Number(request.params.id));
    if (!user) return reply.code(404).send({ error: 'USER_NOT_FOUND' });
    if (user.id === request.auth.userId) {
      return reply.code(400).send({ error: 'CANNOT_CHANGE_OWN_ROLE' });
    }
    const role = String(request.body?.role || '');
    if (!['user', 'publisher', 'admin'].includes(role)) {
      return reply.code(400).send({ error: 'INVALID_ROLE' });
    }
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, user.id);
    audit(request.auth.userId, 'set_role', user.email, {
      from: user.role,
      to: role,
    });
    return { ok: true, user: adminUserView(db, findUserById(db, user.id)) };
  });

  /** POST /api/admin/users/:id/reset-hwid — unbind HWID without cooldown. */
  app.post('/users/:id/reset-hwid', async (request, reply) => {
    const user = findUserById(db, Number(request.params.id));
    if (!user) return reply.code(404).send({ error: 'USER_NOT_FOUND' });
    db.prepare('UPDATE users SET hwid = NULL WHERE id = ?').run(user.id);
    recordDeviceEvent(db, user.id, 'reset', null, ipHash(request.ip));
    audit(request.auth.userId, 'reset_hwid', user.email, {});
    return { ok: true, user: adminUserView(db, findUserById(db, user.id)) };
  });

  /**
   * POST /api/admin/users/:id/set-plan — {plan_code}
   * Switches the plan code on the user's subscription row; the expiry
   * date is untouched (granting days stays `grant-days`).
   */
  app.post('/users/:id/set-plan', async (request, reply) => {
    const user = findUserById(db, Number(request.params.id));
    if (!user) return reply.code(404).send({ error: 'USER_NOT_FOUND' });
    const planCode = String(request.body?.plan_code || '');
    if (!findPlan(db, planCode)) {
      return reply.code(400).send({ error: 'UNKNOWN_PLAN' });
    }
    db.prepare('UPDATE subscriptions SET plan_code = ? WHERE user_id = ?').run(
      planCode,
      user.id
    );
    audit(request.auth.userId, 'set_plan', user.email, { plan_code: planCode });
    return { ok: true, user: adminUserView(db, findUserById(db, user.id)) };
  });

  // ---------------------------------------------------------------
  // Tariff plans (§8.3) — CRUD under /api/admin/plans
  // ---------------------------------------------------------------

  /** GET /api/admin/plans — all plans incl. inactive. */
  app.get('/plans', async () => ({ plans: listAllPlans(db) }));

  /** POST /api/admin/plans — create a plan; entitlements is a JSON object. */
  app.post('/plans', async (request, reply) => {
    const { code, title, price_minor, period_days = 30, entitlements = {}, sort = 0 } =
      request.body || {};
    if (!/^[a-z0-9_-]{1,32}$/.test(String(code || ''))) {
      return reply.code(400).send({ error: 'INVALID_PLAN_CODE' });
    }
    if (findPlan(db, code)) {
      return reply.code(409).send({ error: 'PLAN_EXISTS' });
    }
    if (!title || !Number.isInteger(Number(price_minor)) || Number(price_minor) < 0) {
      return reply.code(400).send({ error: 'MISSING_FIELDS' });
    }
    db.prepare(
      `INSERT INTO plans (code, title, price_minor, period_days, entitlements, sort)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      code,
      String(title),
      Number(price_minor),
      Number(period_days) || 30,
      JSON.stringify(entitlements),
      Number(sort) || 0
    );
    audit(request.auth.userId, 'create_plan', code, { title, price_minor });
    return reply.code(201).send({ plan: findPlan(db, code) });
  });

  /** PATCH /api/admin/plans/:code — partial update (title/price/entitlements/active/sort). */
  app.patch('/plans/:code', async (request, reply) => {
    const plan = findPlan(db, request.params.code);
    if (!plan) return reply.code(404).send({ error: 'PLAN_NOT_FOUND' });
    const { title, price_minor, period_days, entitlements, active, sort } =
      request.body || {};
    db.prepare(
      `UPDATE plans SET
         title = COALESCE(?, title),
         price_minor = COALESCE(?, price_minor),
         period_days = COALESCE(?, period_days),
         entitlements = COALESCE(?, entitlements),
         active = COALESCE(?, active),
         sort = COALESCE(?, sort)
       WHERE code = ?`
    ).run(
      title ?? null,
      price_minor === undefined ? null : Number(price_minor),
      period_days === undefined ? null : Number(period_days),
      entitlements === undefined ? null : JSON.stringify(entitlements),
      active === undefined ? null : active ? 1 : 0,
      sort === undefined ? null : Number(sort),
      request.params.code
    );
    audit(request.auth.userId, 'update_plan', request.params.code, {
      fields: Object.keys(request.body || {}),
    });
    return { plan: findPlan(db, request.params.code) };
  });

  // ---------------------------------------------------------------
  // Minecraft plugin catalog (§9.4)
  // ---------------------------------------------------------------

  /** GET /api/admin/mc-plugins — all rows incl. drafts/inactive. */
  app.get('/mc-plugins', async () => ({ plugins: listAllMcPlugins(db) }));

  /** POST /api/admin/mc-plugins — create a catalog entry (no jar yet). */
  app.post('/mc-plugins', async (request, reply) => {
    const { slug, name, version, description = '', premium } = request.body || {};
    if (!slug || !SLUG_RE.test(slug)) {
      return reply.code(400).send({ error: 'INVALID_SLUG' });
    }
    if (!name || !version) {
      return reply.code(400).send({ error: 'MISSING_FIELDS' });
    }
    if (findMcPlugin(db, slug)) {
      return reply.code(409).send({ error: 'SLUG_TAKEN' });
    }
    db.prepare(
      `INSERT INTO mc_plugins
         (slug, name, version, description, premium, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(slug, name, version, description, premium ? 1 : 0, nowIso(), nowIso());
    audit(request.auth.userId, 'create_mc_plugin', slug, { name, version });
    return reply.code(201).send({
      plugin: listAllMcPlugins(db).find((p) => p.slug === slug),
    });
  });

  /** PATCH /api/admin/mc-plugins/:slug — metadata + active toggle. */
  app.patch('/mc-plugins/:slug', async (request, reply) => {
    const plugin = findMcPlugin(db, request.params.slug);
    if (!plugin) return reply.code(404).send({ error: 'PLUGIN_NOT_FOUND' });
    const { name, version, description, premium, active } = request.body || {};
    db.prepare(
      `UPDATE mc_plugins SET
         name = COALESCE(?, name),
         version = COALESCE(?, version),
         description = COALESCE(?, description),
         premium = COALESCE(?, premium),
         active = COALESCE(?, active),
         updated_at = ?
       WHERE slug = ?`
    ).run(
      name ?? null,
      version ?? null,
      description ?? null,
      premium === undefined ? null : premium ? 1 : 0,
      active === undefined ? null : active ? 1 : 0,
      nowIso(),
      plugin.slug
    );
    audit(request.auth.userId, 'update_mc_plugin', plugin.slug, {
      fields: Object.keys(request.body || {}),
    });
    return {
      plugin: listAllMcPlugins(db).find((p) => p.slug === plugin.slug),
    };
  });

  /**
   * POST /api/admin/mc-plugins/:slug/file — uploads the jar
   * (application/octet-stream). Stored under staticDir/plugins as
   * `<slug>-<version>.jar`; sha256 + size are computed server-side and
   * become the download contract the launcher verifies.
   */
  app.post(
    '/mc-plugins/:slug/file',
    { bodyLimit: config.maxBuildSize },
    async (request, reply) => {
      const plugin = findMcPlugin(db, request.params.slug);
      if (!plugin) return reply.code(404).send({ error: 'PLUGIN_NOT_FOUND' });
      const body = request.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        return reply.code(400).send({ error: 'EMPTY_BODY' });
      }
      // Jars are zips — cheap magic check catches wrong-file uploads.
      if (body[0] !== 0x50 || body[1] !== 0x4b) {
        return reply.code(400).send({ error: 'NOT_A_JAR' });
      }
      const rel = `${plugin.slug}-${plugin.version}.jar`;
      const root = path.resolve(config.staticDir, 'plugins');
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(path.join(root, rel), body);
      const sha256 = crypto.createHash('sha256').update(body).digest('hex');
      db.prepare(
        `UPDATE mc_plugins
           SET file_name = ?, sha256 = ?, size_bytes = ?, updated_at = ?
         WHERE slug = ?`
      ).run(rel, sha256, body.length, nowIso(), plugin.slug);
      audit(request.auth.userId, 'upload_mc_plugin', plugin.slug, {
        sha256,
        size_bytes: body.length,
      });
      return reply.code(201).send({
        plugin: listAllMcPlugins(db).find((p) => p.slug === plugin.slug),
      });
    }
  );

  /** DELETE /api/admin/mc-plugins/:slug — removes row + jar file. */
  app.delete('/mc-plugins/:slug', async (request, reply) => {
    const plugin = findMcPlugin(db, request.params.slug);
    if (!plugin) return reply.code(404).send({ error: 'PLUGIN_NOT_FOUND' });
    if (plugin.file_name) {
      const root = path.resolve(config.staticDir, 'plugins');
      const p = path.resolve(root, plugin.file_name);
      if (p.startsWith(root + path.sep) && fs.existsSync(p)) {
        fs.unlinkSync(p);
      }
    }
    db.prepare('DELETE FROM mc_plugins WHERE slug = ?').run(plugin.slug);
    audit(request.auth.userId, 'delete_mc_plugin', plugin.slug, {});
    return { ok: true };
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
  const games = db
    .prepare(
      `SELECT g.*, u.email AS owner_email,
        (SELECT COUNT(*) FROM game_submissions s
          WHERE s.game_id = g.id AND s.status = 'pending') AS pending_submissions
       FROM games g LEFT JOIN users u ON u.id = g.owner_id
       ORDER BY g.id`
    )
    .all();
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
  const g = db
    .prepare(
      `SELECT g.*, u.email AS owner_email,
        (SELECT COUNT(*) FROM game_submissions s
          WHERE s.game_id = g.id AND s.status = 'pending') AS pending_submissions
       FROM games g LEFT JOIN users u ON u.id = g.owner_id
       WHERE g.id = ?`
    )
    .get(gameId);
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
    owner_email: g.owner_email || null,
    is_free: !!g.is_free,
    pending_submissions: g.pending_submissions || 0,
    published_version: published?.version || null,
    updated_at: g.updated_at,
    builds,
  };
}

function findSubmissionView(db, id) {
  const s = db
    .prepare(
      `SELECT s.*, g.slug AS game_slug, g.title AS game_title,
              b.version, u.email AS submitted_by_email
       FROM game_submissions s
       JOIN games g ON g.id = s.game_id
       JOIN game_builds b ON b.id = s.build_id
       JOIN users u ON u.id = s.submitted_by
       WHERE s.id = ?`
    )
    .get(id);
  return s ? submissionView(s) : null;
}

function submissionView(s) {
  return {
    id: s.id,
    game_id: s.game_id,
    game_slug: s.game_slug,
    game_title: s.game_title,
    build_id: s.build_id,
    version: s.version,
    submitted_by: s.submitted_by_email || s.submitted_by,
    status: s.status,
    feedback: s.feedback,
    created_at: s.created_at,
    reviewed_at: s.reviewed_at,
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
  // refreshSubscription (not findSubscription) so the panel shows the
  // lazily-expired truth, not a stale 'active' left by the last read.
  const sub = refreshSubscription(db, u.id);
  const payments = db
    .prepare(
      'SELECT * FROM payments WHERE user_id = ? ORDER BY id DESC LIMIT 20'
    )
    .all(u.id);
  const masked = u.hwid ? `${u.hwid.slice(0, 8)}…` : null;
  const month = currentMonth();
  return {
    id: u.id,
    email: u.email,
    role: u.role,
    hwid: masked,
    created_at: u.created_at,
    subscription: subscriptionView(sub),
    plan_code: sub?.status === 'active' ? sub?.plan_code || 'pro' : 'free',
    usage: { month, coins: usageForMonth(db, u.id, month) },
    payments,
  };
}
