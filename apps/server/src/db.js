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
import { DatabaseSync } from 'node:sqlite';

/** Current UTC time as an ISO-8601 string. */
export function nowIso() {
  return new Date().toISOString();
}

/** ISO-8601 string for `days` days in the future from `from` (default: now). */
export function isoInDays(days, from = new Date()) {
  return new Date(from.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Opens (and creates if needed) the SQLite database, applies the schema and
 * seeds the game catalog. Returns the DatabaseSync handle.
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

  seedGames(db);
  return db;
}

/**
 * Ensures the catalog contains the bundled test game. Idempotent — safe to
 * run on every boot.
 * @param {DatabaseSync} db
 */
function seedGames(db) {
  const insert = db.prepare(`
    INSERT INTO games (slug, title, description, version, file_name, executable_name, cover_image)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(slug) DO NOTHING
  `);
  insert.run(
    'mock-game',
    'Mock Arena',
    'Built-in test game used to verify launcher downloads, DRM handshake and live event triggers.',
    '0.1.0',
    'mock-game-0.1.0.zip',
    process.platform === 'win32' ? 'mock-game.exe' : 'mock-game',
    ''
  );
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
