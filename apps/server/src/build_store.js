/**
 * @file build_store.js
 * Shared game-build upload pipeline used by both the admin API and the
 * publisher self-service API.
 *
 * P0.7 hardening:
 *  - Uploads stream to a temp file inside staticDir (bounded by
 *    `maxBuildSize`) — the whole zip is never held in memory.
 *  - Validation reads only the EOCD tail + central directory region:
 *    entry count, per-entry/total uncompressed sizes, compression ratio,
 *    name length, traversal/absolute/UNC/backslash paths, symlink and
 *    special-file entries, duplicate and case-insensitive name
 *    collisions. An optional root `game.json`/`manifest.json` is parsed
 *    and its slug/version cross-checked when present.
 *  - Persistence is atomic: the tmp file is renamed into place only
 *    after the immutable `game_builds` row commits; a racing duplicate
 *    insert deletes its temp file and loses.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { config } from './config.js';
import { nowIso, withTx } from './db.js';

export const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9a-z.]+)?$/i;

/** Zip method ids we understand when extracting a single small entry. */
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
/** Unix file-type bits in the high word of external attributes. */
const UNIX_SYMLINK = 0xa000;

/**
 * Registers the octet-stream parser that streams uploads to a temp file
 * inside `<staticDir>/.uploads` (same volume → atomic rename later).
 * Body limit is enforced by counting bytes on the wire, not by the
 * Content-Length header. The route receives `request.body` as
 * `{filePath, size}` and MUST call `cleanupUpload` when done.
 */
export function addStreamingUploadParser(app) {
  app.addContentTypeParser(
    'application/octet-stream',
    (request, payload, done) => {
      const dir = path.join(config.staticDir, '.uploads');
      fs.mkdirSync(dir, { recursive: true });
      const tmp = path.join(dir, `${crypto.randomUUID()}.part`);
      const out = fs.createWriteStream(tmp);
      let bytes = 0;
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        out.destroy();
        try {
          fs.rmSync(tmp, { force: true });
        } catch {
          /* temp cleanup is best-effort */
        }
        done(err);
      };
      payload.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > config.maxBuildSize) {
          const err = new Error('upload exceeds MAX_BUILD_SIZE');
          err.statusCode = 413;
          payload.destroy();
          fail(err);
        }
      });
      payload.on('error', fail);
      payload.on('aborted', () =>
        fail(Object.assign(new Error('upload aborted'), { statusCode: 400 }))
      );
      out.on('error', fail);
      out.on('finish', () => {
        if (settled) return;
        settled = true;
        done(null, { filePath: tmp, size: bytes });
      });
      payload.pipe(out);
    }
  );
}

/** Removes an uploaded temp file; always call after storeGameBuild. */
export function cleanupUpload(upload) {
  try {
    if (upload?.filePath) fs.rmSync(upload.filePath, { force: true });
  } catch {
    /* best-effort */
  }
}

/** Drops stale temp uploads older than 24 h (crash leftovers). */
export function sweepUploadTemps() {
  const dir = path.join(config.staticDir, '.uploads');
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  const cutoff = Date.now() - 24 * 3600_000;
  for (const n of names) {
    try {
      const p = path.join(dir, n);
      if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { force: true });
    } catch {
      /* ignore */
    }
  }
}

/**
 * Validates and persists a build zip for `game`.
 * @param {{filePath: string, size: number}} upload — streamed temp file.
 * @returns {{ok:false, error:string, entry?:string, expected?:string}
 *         | {ok:true, build:object}}
 */
export function storeGameBuild(db, { game, version, changelog = '', upload, uploadedBy }) {
  if (!VERSION_RE.test(version || '')) {
    return { ok: false, error: 'INVALID_VERSION' };
  }
  if (!upload?.filePath || !Number.isInteger(upload.size) || upload.size <= 0) {
    return { ok: false, error: 'EMPTY_BODY' };
  }
  const dup = db
    .prepare('SELECT id FROM game_builds WHERE game_id = ? AND version = ?')
    .get(game.id, version);
  if (dup) return { ok: false, error: 'VERSION_EXISTS' };

  const fd = fs.openSync(upload.filePath, 'r');
  let entries, sha256;
  try {
    entries = listZipEntries(fd, upload.size);
    const bad = validateEntries(entries, game);
    if (bad) return bad;
    const manErr = checkManifest(fd, entries, game, version);
    if (manErr) return manErr;
    sha256 = hashFile(fd, upload.size);
  } catch (err) {
    return { ok: false, error: 'INVALID_ZIP', detail: String(err.message || err) };
  } finally {
    fs.closeSync(fd);
  }

  const rel = `${game.slug}/${version}.zip`;
  const dir = path.join(config.staticDir, 'games', game.slug);
  const dst = path.join(config.staticDir, 'games', rel);
  fs.mkdirSync(dir, { recursive: true });

  // Row first, then the atomic rename — a unique-key race loser deletes
  // its temp file; a rename failure deletes the row (best effort).
  let build;
  try {
    build = withTx(db, () => {
      const info = db
        .prepare(
          `INSERT INTO game_builds
             (game_id, version, file_name, sha256, size_bytes, changelog, uploaded_by, created_at)
           VALUES (?,?,?,?,?,?,?,?)`
        )
        .run(
          game.id, version, rel, sha256, upload.size,
          String(changelog), uploadedBy, nowIso()
        );
      return db
        .prepare('SELECT * FROM game_builds WHERE id = ?')
        .get(Number(info.lastInsertRowid));
    });
  } catch (err) {
    if (String(err?.code || '').includes('SQLITE_CONSTRAINT')) {
      return { ok: false, error: 'VERSION_EXISTS' };
    }
    throw err;
  }
  try {
    // .uploads lives inside staticDir → same volume → atomic rename.
    fs.renameSync(upload.filePath, dst);
  } catch (err) {
    try {
      db.prepare('DELETE FROM game_builds WHERE id = ?').run(build.id);
    } catch {
      /* row cleanup best-effort */
    }
    throw err;
  }
  return { ok: true, build };
}

// ---------------------------------------------------------------------------
// Zip validation
// ---------------------------------------------------------------------------

/**
 * Per-entry metadata from the central directory.
 * @typedef {{name:string, method:number, csize:number, usize:number,
 *           flags:number, lho:number}} ZipEntry
 */

/**
 * Walks the end-of-central-directory record and yields every central
 * directory entry — only the tail + CD region are read.
 * @param {number} fd
 * @param {number} size
 * @returns {ZipEntry[]}
 */
export function listZipEntries(fd, size) {
  const EOCD = 0x06054b50;
  const CDIR = 0x02014b50;
  const tailLen = Math.min(size, 65536 + 22);
  const tail = Buffer.alloc(tailLen);
  fs.readSync(fd, tail, 0, tailLen, size - tailLen);
  let eocd = -1;
  for (let i = tailLen - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('EOCD not found');
  const count = tail.readUInt16LE(eocd + 10);
  if (count > config.maxZipEntries) {
    throw new Error(`too many entries (${count} > ${config.maxZipEntries})`);
  }
  const cdOffset = tail.readUInt32LE(eocd + 16);
  const entries = [];
  let off = cdOffset;
  for (let i = 0; i < count; i++) {
    const head = Buffer.alloc(46);
    if (fs.readSync(fd, head, 0, 46, off) !== 46) throw new Error('short CD');
    if (head.readUInt32LE(0) !== CDIR) throw new Error('bad central dir');
    const method = head.readUInt16LE(8);
    const flags = head.readUInt16LE(6);
    const csize = head.readUInt32LE(20);
    const usize = head.readUInt32LE(24);
    const nameLen = head.readUInt16LE(28);
    const extraLen = head.readUInt16LE(30);
    const commentLen = head.readUInt16LE(32);
    const attrs = head.readUInt32LE(38);
    const lho = head.readUInt32LE(42);
    const name = Buffer.alloc(nameLen);
    fs.readSync(fd, name, 0, nameLen, off + 46);
    entries.push({
      name: name.toString('utf8'),
      method,
      csize,
      usize,
      flags,
      attrs,
      lho,
    });
    off += 46 + nameLen + extraLen + commentLen;
    if (off > size) throw new Error('CD overruns file');
  }
  return entries;
}

/** Entry-name safety rules shared by every zip consumer. */
function unsafeName(name) {
  if (!name || name.length > 512) return true;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(name)) return true;
  if (name.includes('..') || name.includes('\\')) return true;
  if (name.startsWith('/') || name.startsWith('//')) return true;
  if (/^[a-zA-Z]:/.test(name)) return true;
  return false;
}

/**
 * Applies the P0.7 limits to a central-directory listing.
 * @returns {null|{ok:false, error:string, entry?:string, expected?:string}}
 */
function validateEntries(entries, game) {
  const seen = new Set();
  const seenFold = new Set();
  let totalUsize = 0;
  for (const e of entries) {
    if (unsafeName(e.name)) {
      return { ok: false, error: 'UNSAFE_ZIP_PATH', entry: e.name };
    }
    // Symlinks/special files must never materialize on extract.
    if (((e.attrs >>> 16) & 0xf000) === UNIX_SYMLINK) {
      return { ok: false, error: 'UNSAFE_ZIP_PATH', entry: e.name };
    }
    const fold = e.name.toLowerCase();
    if (seen.has(e.name) || seenFold.has(fold)) {
      return { ok: false, error: 'DUPLICATE_ZIP_ENTRY', entry: e.name };
    }
    seen.add(e.name);
    seenFold.add(fold);
    if (e.usize > config.maxZipFileBytes) {
      return { ok: false, error: 'ZIP_ENTRY_TOO_LARGE', entry: e.name };
    }
    totalUsize += e.usize;
    if (totalUsize > config.maxZipExpandedBytes) {
      return { ok: false, error: 'ZIP_EXPANDED_TOO_LARGE' };
    }
    // Ratio check only on meaningfully-compressed entries — tiny files
    // have noisy ratios.
    if (e.csize >= 4096 && e.usize > e.csize * config.maxZipRatio) {
      return { ok: false, error: 'ZIP_RATIO_EXCEEDED', entry: e.name };
    }
  }
  if (!entries.some((e) => e.name === game.executable_name)) {
    return {
      ok: false,
      error: 'EXECUTABLE_MISSING',
      expected: game.executable_name,
    };
  }
  return null;
}

/**
 * When the zip ships a root `game.json`/`manifest.json`, it must be a
 * small valid JSON object whose `slug`/`version` fields (if present)
 * agree with this upload — a mismatched manifest is rejected.
 * @returns {null|{ok:false, error:string}}
 */
function checkManifest(fd, entries, game, version) {
  const entry = entries.find(
    (e) => e.name === 'game.json' || e.name === 'manifest.json'
  );
  if (!entry) return null;
  if (entry.usize > 1024 * 1024) {
    return { ok: false, error: 'INVALID_MANIFEST' };
  }
  let raw;
  try {
    raw = readZipEntry(fd, entry);
  } catch {
    return { ok: false, error: 'INVALID_MANIFEST' };
  }
  let manifest;
  try {
    manifest = JSON.parse(raw.toString('utf8'));
  } catch {
    return { ok: false, error: 'INVALID_MANIFEST' };
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, error: 'INVALID_MANIFEST' };
  }
  if (manifest.slug !== undefined && manifest.slug !== game.slug) {
    return { ok: false, error: 'MANIFEST_SLUG_MISMATCH' };
  }
  if (manifest.version !== undefined && String(manifest.version) !== version) {
    return { ok: false, error: 'MANIFEST_VERSION_MISMATCH' };
  }
  return null;
}

/** Reads+inflates ONE entry via its local-file header (small entries). */
function readZipEntry(fd, entry) {
  const head = Buffer.alloc(30);
  if (fs.readSync(fd, head, 0, 30, entry.lho) !== 30) {
    throw new Error('short local header');
  }
  if (head.readUInt32LE(0) !== 0x04034b50) throw new Error('bad local header');
  const nameLen = head.readUInt16LE(26);
  const extraLen = head.readUInt16LE(28);
  const dataOff = entry.lho + 30 + nameLen + extraLen;
  const buf = Buffer.alloc(entry.csize);
  if (fs.readSync(fd, buf, 0, entry.csize, dataOff) !== entry.csize) {
    throw new Error('short entry data');
  }
  if (entry.method === METHOD_STORED) return buf;
  if (entry.method === METHOD_DEFLATE) return zlib.inflateRawSync(buf);
  throw new Error(`unsupported method ${entry.method}`);
}

/** Streaming sha256 over the uploaded file. */
function hashFile(fd, size) {
  const h = crypto.createHash('sha256');
  const buf = Buffer.alloc(Math.min(size, 4 * 1024 * 1024));
  let off = 0;
  while (off < size) {
    const n = fs.readSync(fd, buf, 0, buf.length, off);
    if (n <= 0) break;
    h.update(buf.subarray(0, n));
    off += n;
  }
  return h.digest('hex');
}
