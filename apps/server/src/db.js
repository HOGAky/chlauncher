/**
 * @file db.js
 * SQLite persistence layer for the licensing server.
 *
 * Uses Node's built-in `node:sqlite` (DatabaseSync) so the project has zero
 * native dependencies. All timestamps are stored as ISO-8601 UTC strings —
 * they sort correctly lexicographically, which makes expiry comparisons
 * trivial string comparisons.
 *
 * Schema:
 *  - users          — accounts with optional HWID binding
 *  - subscriptions  — one row per user, 30-day periods
 *  - games          — catalog entries pointing at downloadable zip artifacts
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';
import { hwidHash } from './hwid.js';

/** Current UTC time as an ISO-8601 string. */
export function nowIso() {
  return new Date().toISOString();
}

/** ISO-8601 string for `days` days in the future from `from` (default: now). */
export function isoInDays(days, from = new Date()) {
  return new Date(from.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Opens (and creates if needed) the SQLite database, applies the v1 baseline
 * schema and then runs any pending linear migrations (PRAGMA user_version).
 *
 * @param {string} databasePath - File path, or ':memory:' for tests.
 * @returns {DatabaseSync}
 */
export function openDatabase(databasePath) {
  if (databasePath !== ':memory:') {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  }

  const db = new DatabaseSync(databasePath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      email            TEXT NOT NULL UNIQUE,
      password_hash    TEXT NOT NULL,
      hwid             TEXT,
      hwid_last_reset  TEXT,
      created_at       TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS subscriptions (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id             INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      status              TEXT NOT NULL CHECK (status IN ('active','expired','canceled')),
      current_period_end  TEXT NOT NULL,
      auto_renew          INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS games (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      slug             TEXT NOT NULL UNIQUE,
      title            TEXT NOT NULL,
      description      TEXT NOT NULL DEFAULT '',
      version          TEXT NOT NULL,
      file_name        TEXT NOT NULL,
      executable_name  TEXT NOT NULL,
      cover_image      TEXT NOT NULL DEFAULT ''
    );
  `);

  migrate(db);
  return db;
}

// ---------------------------------------------------------------------------
// Migrations — linear array indexed by target version-1. `PRAGMA user_version`
// holds the applied count; every entry must be idempotent-in-context (it runs
// exactly once per database inside a transaction).
// ---------------------------------------------------------------------------

/** @type {Array<(db: DatabaseSync) => void>} */
const MIGRATIONS = [
  // v1 → v2: admin roles, versioned game builds, payments ledger, audit log.
  (db) => {
    db.exec(`
      ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'
        CHECK (role IN ('user','admin'));

      CREATE TABLE game_builds (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        game_id      INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
        version      TEXT NOT NULL,
        file_name    TEXT NOT NULL,
        sha256       TEXT NOT NULL,
        size_bytes   INTEGER NOT NULL,
        changelog    TEXT NOT NULL DEFAULT '',
        uploaded_by  INTEGER REFERENCES users(id),
        created_at   TEXT NOT NULL,
        UNIQUE(game_id, version)
      );

      ALTER TABLE games ADD COLUMN published_build_id INTEGER
        REFERENCES game_builds(id);
      ALTER TABLE games ADD COLUMN status TEXT NOT NULL DEFAULT 'published'
        CHECK (status IN ('draft','published','archived'));
      ALTER TABLE games ADD COLUMN updated_at TEXT;

      CREATE TABLE payments (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id      INTEGER NOT NULL REFERENCES users(id),
        provider     TEXT NOT NULL,
        external_id  TEXT,
        days         INTEGER NOT NULL,
        status       TEXT NOT NULL DEFAULT 'succeeded'
                     CHECK (status IN ('pending','succeeded','failed','refunded')),
        actor_id     INTEGER REFERENCES users(id),
        created_at   TEXT NOT NULL,
        UNIQUE(provider, external_id)
      );

      CREATE TABLE admin_audit (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        actor_id   INTEGER NOT NULL REFERENCES users(id),
        action     TEXT NOT NULL,
        target     TEXT NOT NULL,
        meta       TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
    `);
    migrateExistingGames(db);
  },
  // v2 → v3: session invalidation (token_version), device-events journal,
  // and HMAC'd HWIDs — plaintext hwid values are re-hashed in place.
  (db) => {
    db.exec(`
      ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0;

      CREATE TABLE device_events (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER REFERENCES users(id),
        event_type TEXT NOT NULL,
        hwid_hash  TEXT,
        ip_hash    TEXT,
        created_at TEXT NOT NULL
      );
    `);
    // Existing plaintext bindings become HMAC hashes. Same column — the
    // value was always opaque to the server, so callers just compare equal.
    const rows = db
      .prepare('SELECT id, hwid FROM users WHERE hwid IS NOT NULL')
      .all();
    const upd = db.prepare('UPDATE users SET hwid = ? WHERE id = ?');
    for (const r of rows) upd.run(hwidHash(r.hwid), r.id);
  },
  // v3 → v4: persistent login-attempt journal. Replaces the in-memory Map
  // so the brute-force lockout survives server restarts; `key` is
  // `ip_hash|email_lower` — nothing sensitive is stored in plaintext.
  (db) => {
    db.exec(`
      CREATE TABLE login_attempts (
        key       TEXT PRIMARY KEY,
        count     INTEGER NOT NULL DEFAULT 0,
        reset_at  INTEGER NOT NULL
      );
    `);
  },
  // v4 → v5: publisher self-service. `users.role` gains 'publisher' — the
  // CHECK constraint can't be altered in place, so the column is swapped
  // (add → copy → drop → rename) instead of rebuilding the heavily
  // FK-referenced users table. `games.owner_id` ties a game to the
  // publisher account that manages it (NULL = admin/system-owned);
  // `game_submissions` is the review journal: a publisher submits a build,
  // an admin approves (→ becomes the published build) or rejects with
  // feedback. Builds themselves stay immutable as before.
  (db) => {
    db.exec(`
      ALTER TABLE users ADD COLUMN role_new TEXT NOT NULL DEFAULT 'user'
        CHECK (role_new IN ('user','publisher','admin'));
      UPDATE users SET role_new = role;
      ALTER TABLE users DROP COLUMN role;
      ALTER TABLE users RENAME COLUMN role_new TO role;

      ALTER TABLE games ADD COLUMN owner_id INTEGER REFERENCES users(id);

      CREATE TABLE game_submissions (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        game_id      INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
        build_id     INTEGER NOT NULL REFERENCES game_builds(id) ON DELETE CASCADE,
        submitted_by INTEGER NOT NULL REFERENCES users(id),
        status       TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','approved','rejected','canceled')),
        feedback     TEXT NOT NULL DEFAULT '',
        reviewer_id  INTEGER REFERENCES users(id),
        created_at   TEXT NOT NULL,
        reviewed_at  TEXT
      );
      CREATE INDEX idx_game_submissions_status ON game_submissions(status);
      CREATE INDEX idx_game_submissions_game ON game_submissions(game_id);
    `);
  },
  // v5 → v6: tariff plans (parity spec §8.1). `plans` holds the catalog of
  // subscription tiers with a JSON entitlements blob; existing active
  // subscriptions migrate to 'pro' so nothing is lost. `usage_monthly`
  // tracks earn-limit consumption reported by launchers; `usage_nonces`
  // makes /api/usage/report idempotent. `games.is_free` lets the Free tier
  // launch a whitelist of catalog games.
  (db) => {
    db.exec(`
      CREATE TABLE plans (
        code          TEXT PRIMARY KEY,
        title         TEXT NOT NULL,
        price_minor   INTEGER NOT NULL,
        currency      TEXT NOT NULL DEFAULT 'RUB',
        period_days   INTEGER NOT NULL DEFAULT 30,
        entitlements  TEXT NOT NULL,
        active        INTEGER NOT NULL DEFAULT 1,
        sort          INTEGER NOT NULL DEFAULT 0
      );

      ALTER TABLE subscriptions ADD COLUMN plan_code TEXT NOT NULL DEFAULT 'pro';
      ALTER TABLE payments      ADD COLUMN plan_code TEXT;
      ALTER TABLE games         ADD COLUMN is_free INTEGER NOT NULL DEFAULT 0;

      CREATE TABLE usage_monthly (
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        month      TEXT NOT NULL,
        coins      INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_id, month)
      );

      CREATE TABLE usage_nonces (
        nonce      TEXT PRIMARY KEY,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL
      );
    `);

    // Seed the default tiers — placeholder prices/names (owner decides,
    // spec §15). free/pro/expert map to §8.2 entitlement keys.
    const seed = db.prepare(
      `INSERT OR IGNORE INTO plans
         (code, title, price_minor, currency, period_days, entitlements, active, sort)
       VALUES (?, ?, ?, 'RUB', 30, ?, 1, ?)`
    );
    seed.run('free', 'Free', 0, JSON.stringify({
      max_presets: 3,
      max_rules_per_preset: 12,
      max_media_triggers: 5,
      tts: false,
      spinner: false,
      custom_overlay_style: false,
      interrupts: false,
      earn_limit_coins_month: 5000,
      paid_games: false,
      mc_premium_plugins: false,
      interactive_games: ['gift_tower'],
    }), 0);
    seed.run('pro', 'Pro', 29900, JSON.stringify({
      max_presets: 25,
      max_rules_per_preset: 50,
      max_media_triggers: 50,
      tts: true,
      spinner: true,
      custom_overlay_style: true,
      interrupts: true,
      earn_limit_coins_month: null,
      paid_games: true,
      mc_premium_plugins: false,
      interactive_games: ['gift_tower', 'boy_vs_girl', 'survive_horde'],
    }), 1);
    seed.run('expert', 'Expert', 59900, JSON.stringify({
      max_presets: 100,
      max_rules_per_preset: 200,
      max_media_triggers: 200,
      tts: true,
      spinner: true,
      custom_overlay_style: true,
      interrupts: true,
      earn_limit_coins_month: null,
      paid_games: true,
      mc_premium_plugins: true,
      interactive_games: ['gift_tower', 'boy_vs_girl', 'survive_horde'],
    }), 2);
  },
  // v6 → v7: Minecraft plugin catalog (parity spec §9.4). Rows are
  // catalog entries the launcher can install into the managed Paper
  // server's plugins dir; jar bytes live under staticDir/plugins and are
  // integrity-pinned by the stored sha256. `premium` gates the download
  // behind the plan's `mc_premium_plugins` entitlement.
  (db) => {
    db.exec(`
      CREATE TABLE mc_plugins (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        slug        TEXT UNIQUE NOT NULL,
        name        TEXT NOT NULL,
        version     TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        sha256      TEXT NOT NULL DEFAULT '',
        size_bytes  INTEGER NOT NULL DEFAULT 0,
        premium     INTEGER NOT NULL DEFAULT 0,
        file_name   TEXT NOT NULL DEFAULT '',
        active      INTEGER NOT NULL DEFAULT 1,
        created_at  TEXT NOT NULL,
        updated_at  TEXT
      );
    `);
  },
  // v7 → v8: external game adapters (parity spec §10.3). Mods publish
  // as catalog entries with kind='adapter'; `adapter_manifest` is a JSON
  // blob `{actions:[{id,label,params}]}` the mapper renders as an action
  // dropdown instead of a free-text command field.
  (db) => {
    db.exec(`
      ALTER TABLE games ADD COLUMN kind TEXT NOT NULL DEFAULT 'game'
        CHECK (kind IN ('game','adapter'));
      ALTER TABLE games ADD COLUMN adapter_manifest TEXT NOT NULL DEFAULT '';
    `);
  },
  // v8 → v9: Tribute (Telegram) billing provider. `tg_bindings` ties a
  // chlauncher account to a Telegram user id — that id is the only stable
  // identity Tribute webhooks carry. `billing_link_codes` holds one-shot
  // deep-link codes the launcher hands to the user (`t.me/<bot>?start=<code>`)
  // so our bind-bot can attach the Telegram id to the right account.
  // `billing_events` is the provider webhook journal: every signed event
  // lands here first (matched or not); unmatched ones replay automatically
  // when the user binds their Telegram later.
  (db) => {
    db.exec(`
      CREATE TABLE tg_bindings (
        user_id           INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        telegram_user_id  INTEGER NOT NULL UNIQUE,
        telegram_username TEXT NOT NULL DEFAULT '',
        bound_at          TEXT NOT NULL
      );

      CREATE TABLE billing_link_codes (
        code       TEXT PRIMARY KEY,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        plan_code  TEXT,
        expires_at TEXT NOT NULL,
        used       INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE TABLE billing_events (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        provider         TEXT NOT NULL,
        event            TEXT NOT NULL,
        external_id      TEXT,
        telegram_user_id INTEGER,
        matched_user_id  INTEGER,
        applied          INTEGER NOT NULL DEFAULT 0,
        payload          TEXT NOT NULL DEFAULT '{}',
        created_at       TEXT NOT NULL
      );
      CREATE INDEX idx_billing_events_tg ON billing_events(telegram_user_id, applied);
    `);
  },
];

/** Runs all pending migrations in order. Idempotent via user_version. */
function migrate(db) {
  let v = db.prepare('PRAGMA user_version').get().user_version;
  while (v < MIGRATIONS.length) {
    db.exec('BEGIN');
    try {
      MIGRATIONS[v](db);
      v += 1;
      db.exec(`PRAGMA user_version = ${v}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

/**
 * v2 data migration: every pre-existing catalog row gets a game_builds entry
 * and becomes published. The flat zip in static/games is moved into the new
 * `<slug>/<version>.zip` layout and hashed. Missing files are tolerated —
 * the build row is still recorded so the catalog stays consistent.
 */
function migrateExistingGames(db) {
  const games = db.prepare('SELECT * FROM games').all();
  const insertBuild = db.prepare(`
    INSERT INTO game_builds
      (game_id, version, file_name, sha256, size_bytes, changelog, uploaded_by, created_at)
    VALUES (?, ?, ?, ?, ?, '', NULL, ?)
  `);
  const setPublished = db.prepare(
    'UPDATE games SET published_build_id = ? WHERE id = ?'
  );

  for (const g of games) {
    const rel = `${g.slug}/${g.version}.zip`;
    const src = path.join(config.staticDir, 'games', g.file_name);
    const dst = path.join(config.staticDir, 'games', rel);
    let sha256 = '';
    let size = 0;
    try {
      if (!fs.existsSync(dst) && fs.existsSync(src)) {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.renameSync(src, dst);
      }
      if (fs.existsSync(dst)) {
        const buf = fs.readFileSync(dst);
        sha256 = crypto.createHash('sha256').update(buf).digest('hex');
        size = buf.length;
      }
    } catch {
      /* file access problems must not abort the schema migration */
    }
    const info = insertBuild.run(g.id, g.version, rel, sha256, size, nowIso());
    setPublished.run(Number(info.lastInsertRowid), g.id);
  }
}

// ---------------------------------------------------------------------------
// Typed query helpers
// ---------------------------------------------------------------------------

/** Fetches a user row by email. @returns {object|undefined} */
export function findUserByEmail(db, email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email);
}

/** Fetches a user row by id. @returns {object|undefined} */
export function findUserById(db, id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

/**
 * Creates a user plus an initially-expired subscription row so that every
 * account always has exactly one subscription record.
 * @returns {object} the created user row
 */
export function createUser(db, { email, passwordHash, hwid = null }) {
  const info = db
    .prepare(
      'INSERT INTO users (email, password_hash, hwid, created_at) VALUES (?, ?, ?, ?)'
    )
    .run(email, passwordHash, hwid, nowIso());
  const userId = Number(info.lastInsertRowid);

  db.prepare(
    `INSERT INTO subscriptions (user_id, status, current_period_end, auto_renew)
     VALUES (?, 'expired', ?, 0)`
  ).run(userId, nowIso());

  return findUserById(db, userId);
}

/** Updates the HWID column of a user (null unbinds the device). */
export function setUserHwid(db, userId, hwid) {
  db.prepare('UPDATE users SET hwid = ? WHERE id = ?').run(hwid, userId);
}

/** Records the moment of an HWID reset (rate-limited to 1 per 7 days). */
export function markHwidReset(db, userId) {
  db.prepare('UPDATE users SET hwid_last_reset = ? WHERE id = ?').run(
    nowIso(),
    userId
  );
}

/**
 * Appends to the device-events journal (Task 5): bound / login_denied /
 * reset / reset_requested with HMAC'd hwid+ip — never raw values.
 */
export function recordDeviceEvent(
  db,
  userId,
  eventType,
  hwidHashVal = null,
  ipHashVal = null
) {
  db.prepare(
    `INSERT INTO device_events (user_id, event_type, hwid_hash, ip_hash, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(userId, eventType, hwidHashVal, ipHashVal, nowIso());
}

/** Bumps token_version — invalidates every JWT issued so far (logout). */
export function bumpTokenVersion(db, userId) {
  db.prepare(
    'UPDATE users SET token_version = token_version + 1 WHERE id = ?'
  ).run(userId);
}

// ---------------------------------------------------------------------------
// Login-attempt journal (brute-force lockout, DB-backed since v4)
// ---------------------------------------------------------------------------

/** Returns the live counter row for `key`, or null when expired/absent. */
export function getLoginAttempts(db, key) {
  const row = db
    .prepare('SELECT count, reset_at FROM login_attempts WHERE key = ?')
    .get(key);
  if (!row || row.reset_at <= Date.now()) return null;
  return row;
}

/** Increments the failure counter for `key`; creates a fresh window row. */
export function noteLoginAttempt(db, key, windowMs) {
  const e = getLoginAttempts(db, key);
  if (e) {
    db.prepare('UPDATE login_attempts SET count = count + 1 WHERE key = ?').run(key);
    return { count: e.count + 1, reset_at: e.reset_at };
  }
  const resetAt = Date.now() + windowMs;
  db.prepare(
    'INSERT OR REPLACE INTO login_attempts (key, count, reset_at) VALUES (?, 1, ?)'
  ).run(key, resetAt);
  return { count: 1, reset_at: resetAt };
}

/** Clears the counter on successful login. */
export function clearLoginAttempts(db, key) {
  db.prepare('DELETE FROM login_attempts WHERE key = ?').run(key);
}

/** Periodic sweep — drops expired rows so the table can't grow forever. */
export function sweepLoginAttempts(db) {
  db.prepare('DELETE FROM login_attempts WHERE reset_at <= ?').run(Date.now());
}

/** Fetches the subscription row for a user. @returns {object|undefined} */
export function findSubscription(db, userId) {
  return db
    .prepare('SELECT * FROM subscriptions WHERE user_id = ?')
    .get(userId);
}

/** Sets subscription status/period explicitly (used by tests & billing). */
export function updateSubscription(db, userId, status, periodEndIso) {
  db.prepare(
    'UPDATE subscriptions SET status = ?, current_period_end = ? WHERE user_id = ?'
  ).run(status, periodEndIso, userId);
}

/** Lists every game in the catalog. */
export function listGames(db) {
  return db.prepare('SELECT * FROM games ORDER BY id').all();
}

/** Finds one game by slug. */
export function findGameBySlug(db, slug) {
  return db.prepare('SELECT * FROM games WHERE slug = ?').get(slug);
}

// ---------------------------------------------------------------------------
// Tariff plans & usage metering (parity spec §8)
// ---------------------------------------------------------------------------

/** Active plan rows for the public catalog, ordered for display. */
export function listActivePlans(db) {
  return db
    .prepare('SELECT * FROM plans WHERE active = 1 ORDER BY sort, price_minor')
    .all()
    .map(planView);
}

/** All plan rows (admin view — includes inactive). */
export function listAllPlans(db) {
  return db.prepare('SELECT * FROM plans ORDER BY sort, price_minor').all().map(planView);
}

/** One plan row by code (raw, with entitlements JSON parsed). */
export function findPlan(db, code) {
  const row = db.prepare('SELECT * FROM plans WHERE code = ?').get(code);
  return row ? planView(row) : null;
}

/** Public plan shape — `entitlements` arrives already parsed. */
export function planView(row) {
  let entitlements = {};
  try {
    entitlements = JSON.parse(row.entitlements || '{}');
  } catch {
    /* malformed JSON → safest is an empty (fully restricted) map */
  }
  return {
    code: row.code,
    title: row.title,
    price_minor: row.price_minor,
    currency: row.currency,
    period_days: row.period_days,
    entitlements,
    active: !!row.active,
    sort: row.sort,
  };
}

/**
 * Resolves the plan a user is effectively on RIGHT NOW: an active
 * subscription returns its `plan_code`; anything else (expired, missing)
 * means Free. Unknown/stale plan codes fall back to Free too.
 * @returns {object} plan row via {@link planView}
 */
export function activePlanForUser(db, userId) {
  const sub = db
    .prepare(
      'SELECT status, plan_code, current_period_end FROM subscriptions WHERE user_id = ?'
    )
    .get(userId);
  // Lazy expiry can't run here (would be a circular import), so check the
  // period end directly — an overdue row counts as Free.
  const live =
    sub?.status === 'active' && (!sub.current_period_end || sub.current_period_end > nowIso());
  const code = live ? sub.plan_code : 'free';
  return findPlan(db, code) || findPlan(db, 'free');
}

/** Current UTC month as 'YYYY-MM' — the usage_monthly key. */
export function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

/** Coins consumed by `userId` in `month` (0 when absent). */
export function usageForMonth(db, userId, month) {
  const row = db
    .prepare('SELECT coins FROM usage_monthly WHERE user_id = ? AND month = ?')
    .get(userId, month);
  return row ? row.coins : 0;
}

/**
 * Applies a usage report idempotently: a fresh `nonce` inserts and adds
 * `coinsDelta`; a seen nonce is a retry → returns `applied: false` with
 * the current total and no write.
 * @returns {{applied: boolean, coins: number}}
 */
export function reportUsage(db, userId, month, coinsDelta, nonce) {
  const seen = db
    .prepare('SELECT nonce FROM usage_nonces WHERE nonce = ?')
    .get(nonce);
  if (seen) {
    return { applied: false, coins: usageForMonth(db, userId, month) };
  }
  db.prepare(
    'INSERT INTO usage_nonces (nonce, user_id, created_at) VALUES (?, ?, ?)'
  ).run(nonce, userId, nowIso());
  db.prepare(
    `INSERT INTO usage_monthly (user_id, month, coins, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, month)
     DO UPDATE SET coins = coins + excluded.coins, updated_at = excluded.updated_at`
  ).run(userId, month, coinsDelta, nowIso());
  return { applied: true, coins: usageForMonth(db, userId, month) };
}

// ---------------------------------------------------------------------------
// Minecraft plugin catalog (spec §9.4)
// ---------------------------------------------------------------------------

/** Public plugin shape — internal file_name is intentionally hidden. */
export function mcPluginView(row) {
  return {
    slug: row.slug,
    name: row.name,
    version: row.version,
    description: row.description,
    sha256: row.sha256,
    size_bytes: row.size_bytes,
    premium: !!row.premium,
  };
}

/** Active catalog rows for `GET /api/mc/plugins`. */
export function listMcPlugins(db) {
  return db
    .prepare(
      `SELECT * FROM mc_plugins WHERE active = 1 AND file_name <> ''
       ORDER BY premium, name`
    )
    .all()
    .map(mcPluginView);
}

/** All rows incl. drafts — the admin view adds file/active internals. */
export function listAllMcPlugins(db) {
  return db
    .prepare('SELECT * FROM mc_plugins ORDER BY id')
    .all()
    .map((r) => ({
      ...mcPluginView(r),
      file_name: r.file_name,
      active: !!r.active,
      created_at: r.created_at,
      updated_at: r.updated_at,
    }));
}

/** One plugin row by slug (raw — includes file_name/active). */
export function findMcPlugin(db, slug) {
  return db.prepare('SELECT * FROM mc_plugins WHERE slug = ?').get(slug);
}
