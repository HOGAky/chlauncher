/**
 * @file routes/tiktok_bind.js
 * TikTok account binding — proves that the logged-in user owns a given
 * TikTok username. TikTok has no lightweight OAuth we can use without an
 * approved developer app, so ownership is verified out-of-band:
 *
 *   1. POST /api/tiktok/bind {username} → one-shot code (30 min TTL)
 *   2. user pastes the code into their TikTok bio (Edit profile → Bio)
 *   3. POST /api/tiktok/verify → we fetch the public profile page and
 *      check the signature field for the code
 *   4. verified → the room-connect flow can prefill/trust the username;
 *      the code is wiped and the user removes it from their bio
 *
 *   GET  /api/tiktok/bind    — own binding status
 *   POST /api/tiktok/bind    — (re)start binding, issues a fresh code
 *   POST /api/tiktok/verify  — fetch profile + check bio
 *   POST /api/tiktok/unbind  — drop the binding
 */

import crypto from 'node:crypto';
import rateLimit from '@fastify/rate-limit';
import { nowIso } from '../db.js';

const CODE_TTL_MIN = 30;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const USERNAME_RE = /^[a-zA-Z0-9_.]{2,24}$/;
const PROFILE_TIMEOUT_MS = 12 * 1000;
const PROFILE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function generateCode(len = 8) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

/**
 * Fetches the public TikTok profile and extracts the bio (signature).
 * Returns {ok:true, bio} | {ok:false, error}.
 */
async function fetchTikTokBio(username) {
  let res;
  try {
    res = await fetch(`https://www.tiktok.com/@${encodeURIComponent(username)}`, {
      redirect: 'follow',
      signal: AbortSignal.timeout(PROFILE_TIMEOUT_MS),
      headers: {
        'user-agent': PROFILE_UA,
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'en-US,en;q=0.9',
      },
    });
  } catch {
    return { ok: false, error: 'PROFILE_FETCH_FAILED' };
  }
  if (res.status === 404) return { ok: false, error: 'USER_NOT_FOUND' };
  if (!res.ok) return { ok: false, error: 'PROFILE_FETCH_FAILED' };

  const html = await res.text();
  // The hydration blob carries userInfo.user.signature for public pages;
  // a captcha/rate-limited response simply lacks it.
  const m = html.match(
    /<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/
  );
  if (!m) return { ok: false, error: 'PROFILE_FETCH_FAILED' };
  try {
    const data = JSON.parse(m[1]);
    const userInfo =
      data?.['__DEFAULT_SCOPE__']?.['webapp.user-detail']?.userInfo;
    if (userInfo?.user == null) return { ok: false, error: 'USER_NOT_FOUND' };
    return {
      ok: true,
      bio: userInfo.user.signature || '',
      nickname: userInfo.user.nickname || '',
      avatar: userInfo.user.avatarMedium || userInfo.user.avatarThumb || '',
      follower_count: userInfo.stats?.followerCount ?? null,
    };
  } catch {
    return { ok: false, error: 'PROFILE_FETCH_FAILED' };
  }
}

/**
 * @param {import('fastify').FastifyInstance} app
 * @param {{db: import('node:sqlite').DatabaseSync, authenticate: Function, fetchBio?: Function}} opts
 */
export default async function tiktokBindRoutes(app, { db, authenticate, fetchBio }) {
  const bioFetcher = fetchBio || fetchTikTokBio;
  await app.register(rateLimit, { max: 30, timeWindow: '1 minute' });
  app.addHook('preHandler', authenticate);

  const view = (row) => ({
    bound: !!row,
    username: row?.username || null,
    verified: !!row?.verified,
    code: row && !row.verified ? row.verify_code : null,
    code_expires_at: row && !row.verified ? row.code_expires_at : null,
    bound_at: row?.bound_at || null,
    verified_at: row?.verified_at || null,
  });

  /**
   * POST /bind {username} — starts (or restarts) the flow. Any previous
   * binding on this account is replaced; a username verified by another
   * account is refused.
   */
  app.post('/bind', async (request, reply) => {
    const username = String(request.body?.username || '')
      .replace(/^@/, '')
      .trim();
    if (!USERNAME_RE.test(username)) {
      return reply.code(400).send({ error: 'INVALID_USERNAME' });
    }
    const taken = db
      .prepare(
        'SELECT user_id FROM tiktok_bindings WHERE username = ? AND verified = 1'
      )
      .get(username);
    if (taken && taken.user_id !== request.auth.userId) {
      return reply.code(409).send({ error: 'USERNAME_TAKEN' });
    }

    const code = generateCode();
    const now = nowIso();
    const expires = new Date(Date.now() + CODE_TTL_MIN * 60_000).toISOString();
    db.prepare(
      `INSERT INTO tiktok_bindings
         (user_id, username, verified, verify_code, code_expires_at, bound_at, updated_at)
       VALUES (?, ?, 0, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         username = excluded.username,
         verified = 0,
         verify_code = excluded.verify_code,
         code_expires_at = excluded.code_expires_at,
         verified_at = NULL,
         updated_at = excluded.updated_at`
    ).run(request.auth.userId, username, code, expires, now, now);
    return view(
      db.prepare('SELECT * FROM tiktok_bindings WHERE user_id = ?').get(request.auth.userId)
    );
  });

  /**
   * POST /verify — fetches the public profile and looks for the code in
   * the bio. Success flips verified=1; the code field is cleared so a
   * stale code can't be replayed against a changed bio.
   */
  app.post('/verify', async (request, reply) => {
    const row = db
      .prepare('SELECT * FROM tiktok_bindings WHERE user_id = ?')
      .get(request.auth.userId);
    if (!row) return reply.code(404).send({ error: 'NOT_BOUND' });
    if (row.verified) return view(row);
    if (!row.verify_code || row.code_expires_at <= nowIso()) {
      return reply.code(410).send({ error: 'CODE_EXPIRED' });
    }

    const profile = await bioFetcher(row.username);
    if (!profile.ok) {
      return reply.code(400).send({ error: profile.error });
    }
    if (!profile.bio.includes(row.verify_code)) {
      return reply.code(400).send({
        error: 'CODE_NOT_IN_BIO',
        bio_preview: profile.bio.slice(0, 80),
      });
    }

    // First verified claim wins — re-check under the unique index.
    try {
      db.prepare(
        `UPDATE tiktok_bindings
           SET verified = 1, verified_at = ?, verify_code = NULL,
               code_expires_at = NULL, updated_at = ?
         WHERE user_id = ?`
      ).run(nowIso(), nowIso(), request.auth.userId);
    } catch {
      return reply.code(409).send({ error: 'USERNAME_TAKEN' });
    }
    return {
      ...view(
        db
          .prepare('SELECT * FROM tiktok_bindings WHERE user_id = ?')
          .get(request.auth.userId)
      ),
      nickname: profile.nickname,
      avatar: profile.avatar,
      follower_count: profile.follower_count,
    };
  });

  /** GET /bind — the caller's binding status (launcher UI). */
  app.get('/bind', async (request) =>
    view(
      db.prepare('SELECT * FROM tiktok_bindings WHERE user_id = ?').get(request.auth.userId)
    )
  );

  /** POST /unbind — detach the TikTok account. */
  app.post('/unbind', async (request) => {
    db.prepare('DELETE FROM tiktok_bindings WHERE user_id = ?').run(request.auth.userId);
    return view(null);
  });
}
