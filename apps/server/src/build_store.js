/**
 * @file build_store.js
 * Shared game-build upload pipeline used by both the admin API and the
 * publisher self-service API: zip validation (central-directory listing,
 * traversal/absolute-path rejection, executable-at-root check), SHA-256
 * hashing, atomic write to `static/games/<slug>/<version>.zip` and the
 * immutable `game_builds` row.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { nowIso } from './db.js';

export const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9a-z.]+)?$/i;

/**
 * Validates and persists a build zip for `game`.
 * @returns {{ok:false, error:string, entry?:string, expected?:string}
 *         | {ok:true, build:object}}
 */
export function storeGameBuild(db, { game, version, changelog = '', body, uploadedBy }) {
  if (!VERSION_RE.test(version || '')) {
    return { ok: false, error: 'INVALID_VERSION' };
  }
  if (!Buffer.isBuffer(body) || body.length === 0) {
    return { ok: false, error: 'EMPTY_BODY' };
  }
  const dup = db
    .prepare('SELECT id FROM game_builds WHERE game_id = ? AND version = ?')
    .get(game.id, version);
  if (dup) return { ok: false, error: 'VERSION_EXISTS' };

  // Zip sanity: readable central directory, executable at root,
  // no absolute/parent-traversal entries.
  let entries;
  try {
    entries = listZipEntries(body);
  } catch {
    return { ok: false, error: 'INVALID_ZIP' };
  }
  const bad = entries.find(
    (n) => n.includes('..') || n.startsWith('/') || /^[a-zA-Z]:/.test(n)
  );
  if (bad) return { ok: false, error: 'UNSAFE_ZIP_PATH', entry: bad };
  if (!entries.includes(game.executable_name)) {
    return {
      ok: false,
      error: 'EXECUTABLE_MISSING',
      expected: game.executable_name,
    };
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
      String(changelog), uploadedBy, nowIso()
    );
  return {
    ok: true,
    build: db
      .prepare('SELECT * FROM game_builds WHERE id = ?')
      .get(Number(info.lastInsertRowid)),
  };
}

/**
 * Lists file names in a zip buffer by walking the end-of-central-directory
 * record. Throws on malformed archives.
 * @param {Buffer} buf
 * @returns {string[]}
 */
export function listZipEntries(buf) {
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
