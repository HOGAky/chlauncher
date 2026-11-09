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
