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
 *   GET  /api/tiktok/bind           — own binding status
 *   POST /api/tiktok/bind           — (re)start binding, issues a fresh code
 *   POST /api/tiktok/verify         — fetch profile + check bio
 *   POST /api/tiktok/verify-comment — code seen in LIVE chat (client proof)
 *   POST /api/tiktok/unbind         — drop the binding
 *   GET  /api/tiktok/oauth/url      — Login Kit authorize URL + CSRF state
 *   GET  /api/tiktok/oauth/callback — TikTok redirect: code→token→user.info
 */

import crypto from 'node:crypto';
import rateLimit from '@fastify/rate-limit';
import { config } from '../config.js';
import { nowIso } from '../db.js';

const CODE_TTL_MIN = 30;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const USERNAME_RE = /^[a-zA-Z0-9_.]{2,24}$/;
const PROFILE_TIMEOUT_MS = 12 * 1000;
const OAUTH_STATE_TTL_MIN = 10;
const OAUTH_TIMEOUT_MS = 15 * 1000;
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

/** Small HTML page that hands the result back to the launcher. */
function callbackPage(params) {
  const qs = new URLSearchParams(params).toString();
  const deep = `chlauncher://tiktok-bind?${qs}`;
  return `<!doctype html><meta charset="utf-8"><title>chlauncher</title>
<script>location.href=${JSON.stringify(deep)};</script>
<body style="background:#0f1117;color:#eee;font:14px system-ui;display:flex;align-items:center;justify-content:center;min-height:90vh">
<div><h2>${params.status === 'ok' ? 'TikTok привязан' : 'Ошибка привязки'}</h2>
<p>Можно закрыть вкладку и вернуться в лаунчер. <a style="color:#7cf" href="${deep}">Открыть лаунчер</a></p></div></body>`;
}

/** Exchanges the OAuth code for an access token (TikTok Login Kit). */
async function oauthTokenExchange(fetcher, { code, redirectUri }) {
  const body = new URLSearchParams({
    client_key: config.tiktokClientKey,
    client_secret: config.tiktokClientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  });
  const res = await fetcher('https://open.tiktokapis.com/v2/oauth/token/', {
    method: 'POST',
    signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    return { ok: false, error: json.error || 'TOKEN_EXCHANGE_FAILED' };
  }
  return { ok: true, token: json.access_token };
}

/** Fetches the authorized user's profile (open_id + username + avatar). */
async function oauthUserInfo(fetcher, accessToken) {
  const fields = 'open_id,union_id,avatar_url,display_name,username';
  const res = await fetcher(
    `https://open.tiktokapis.com/v2/user/info/?fields=${fields}`,
    {
      signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
      headers: { authorization: `Bearer ${accessToken}` },
    }
  );
  const json = await res.json().catch(() => ({}));
  const user = json?.data?.user;
  if (!res.ok || !user?.open_id) {
    return { ok: false, error: 'USERINFO_FAILED' };
  }
  return { ok: true, user };
}

/**
 * @param {import('fastify').FastifyInstance} app
 * @param {{db: import('node:sqlite').DatabaseSync, authenticate: Function, fetchBio?: Function, oauthFetch?: Function}} opts
 */
export default async function tiktokBindRoutes(app, { db, authenticate, fetchBio, oauthFetch }) {
  const bioFetcher = fetchBio || fetchTikTokBio;
  const http = oauthFetch || fetch;
  await app.register(rateLimit, { max: 60, timeWindow: '1 minute' });

  /**
   * GET /oauth/callback — PUBLIC: the browser lands here straight from
   * tiktok.com, so the user can't be authenticated by JWT; the one-shot
   * `state` parameter carries the session identity instead. Registered
   * before the authenticate hook on purpose.
   */
  app.get('/oauth/callback', { config: { skipAuth: true } }, async (request, reply) => {
    const { code, state, error, error_description } = request.query || {};
    const finish = (params) =>
      reply.type('text/html; charset=utf-8').send(callbackPage(params));
    if (error) {
      return finish({ status: 'error', reason: String(error_description || error).slice(0, 120) });
    }
    if (!code || !state) return reply.code(400).send({ error: 'INVALID_CALLBACK' });
    if (!config.tiktokClientKey || !config.tiktokClientSecret) {
      return reply.code(501).send({ error: 'OAUTH_NOT_CONFIGURED' });
    }

    const row = db
      .prepare('SELECT * FROM tiktok_oauth_states WHERE state = ?')
      .get(String(state));
    db.prepare('DELETE FROM tiktok_oauth_states WHERE state = ? OR expires_at <= ?').run(
      String(state),
      nowIso()
    );
    if (!row || row.expires_at <= nowIso()) {
      return finish({ status: 'error', reason: 'state_expired' });
    }

    const redirectUri =
      config.tiktokRedirectUri || `${config.publicBaseUrl}/api/tiktok/oauth/callback`;
    const tok = await oauthTokenExchange(http, { code: String(code), redirectUri });
    if (!tok.ok) return finish({ status: 'error', reason: tok.error });
    const info = await oauthUserInfo(http, tok.token);
    if (!info.ok) return finish({ status: 'error', reason: info.error });

    const u = info.user;
    const username = String(u.username || '').replace(/^@/, '');
    if (!username) {
      // user.info.profile scope not granted by the app review — we can't
      // bind a room without the handle.
      return finish({ status: 'error', reason: 'no_username_scope' });
    }

    // One TikTok identity per account — either dimension may collide.
    const owner = db
      .prepare(
        `SELECT user_id FROM tiktok_bindings
         WHERE (open_id = ? OR (username = ? AND verified = 1)) AND user_id != ?`
      )
      .get(u.open_id, username, row.user_id);
    if (owner) return finish({ status: 'error', reason: 'taken' });

    const now = nowIso();
    db.prepare('DELETE FROM tiktok_bindings WHERE open_id = ?').run(u.open_id);
    db.prepare(
      `INSERT INTO tiktok_bindings
         (user_id, username, verified, bound_at, verified_at, updated_at,
          open_id, union_id, display_name, avatar_url, auth_method)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 'oauth')
       ON CONFLICT(user_id) DO UPDATE SET
         username = excluded.username, verified = 1, verify_code = NULL,
         code_expires_at = NULL, verified_at = excluded.verified_at,
         updated_at = excluded.updated_at, open_id = excluded.open_id,
         union_id = excluded.union_id, display_name = excluded.display_name,
         avatar_url = excluded.avatar_url, auth_method = 'oauth'`
    ).run(
      row.user_id,
      username,
      now,
      now,
      now,
      u.open_id,
      u.union_id || null,
      u.display_name || '',
      u.avatar_url || ''
    );
    return finish({ status: 'ok', username });
  });

  app.addHook('preHandler', async (request, reply) => {
    if (request.routeOptions?.config?.skipAuth) return;
    return authenticate(request, reply);
  });

  /**
   * GET /oauth/url — builds the Login Kit authorize URL with a one-shot
   * CSRF state bound to the caller. The launcher opens it in the system
   * browser; the callback deep-links the result back.
   */
  app.get('/oauth/url', async (request, reply) => {
    if (!config.tiktokClientKey || !config.tiktokClientSecret) {
      return reply.code(501).send({ error: 'OAUTH_NOT_CONFIGURED' });
    }
    const state = crypto.randomBytes(18).toString('hex');
    db.prepare(
      `INSERT INTO tiktok_oauth_states (state, user_id, expires_at, created_at)
       VALUES (?, ?, ?, ?)`
    ).run(
      state,
      request.auth.userId,
      new Date(Date.now() + OAUTH_STATE_TTL_MIN * 60_000).toISOString(),
      nowIso()
    );
    const redirectUri =
      config.tiktokRedirectUri || `${config.publicBaseUrl}/api/tiktok/oauth/callback`;
    const url =
      'https://www.tiktok.com/v2/auth/authorize/?' +
      new URLSearchParams({
        client_key: config.tiktokClientKey,
        scope: 'user.info.basic,user.info.profile',
        response_type: 'code',
        redirect_uri: redirectUri,
        state,
      }).toString();
    return { url, redirect_uri: redirectUri };
  });

  const view = (row) => ({
    bound: !!row,
    username: row?.username || null,
    verified: !!row?.verified,
    code: row && !row.verified ? row.verify_code : null,
    code_expires_at: row && !row.verified ? row.code_expires_at : null,
    bound_at: row?.bound_at || null,
    verified_at: row?.verified_at || null,
    open_id: row?.open_id || null,
    display_name: row?.display_name || null,
    avatar_url: row?.avatar_url || null,
    auth_method: row?.auth_method || null,
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

  /** Marks the caller's pending binding verified; shared by both proofs. */
  const markVerified = (request, reply) => {
    const row = db
      .prepare('SELECT * FROM tiktok_bindings WHERE user_id = ?')
      .get(request.auth.userId);
    if (!row) return { error: reply.code(404).send({ error: 'NOT_BOUND' }) };
    if (row.verified) return { row };
    if (!row.verify_code || row.code_expires_at <= nowIso()) {
      return { error: reply.code(410).send({ error: 'CODE_EXPIRED' }) };
    }
    return { row };
  };

  const applyVerified = (userId, reply) => {
    try {
      db.prepare(
        `UPDATE tiktok_bindings
           SET verified = 1, verified_at = ?, verify_code = NULL,
               code_expires_at = NULL, updated_at = ?
         WHERE user_id = ?`
      ).run(nowIso(), nowIso(), userId);
    } catch {
      reply.code(409).send({ error: 'USERNAME_TAKEN' });
      return null;
    }
    return db
      .prepare('SELECT * FROM tiktok_bindings WHERE user_id = ?')
      .get(userId);
  };

  /**
   * POST /verify — fetches the public profile and looks for the code in
   * the bio. Success flips verified=1; the code field is cleared so a
   * stale code can't be replayed against a changed bio.
   */
  app.post('/verify', async (request, reply) => {
    const { row, error } = markVerified(request, reply);
    if (error) return error;
    if (row.verified) return view(row);

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

    const updated = applyVerified(request.auth.userId, reply);
    if (!updated) return;
    return {
      ...view(updated),
      nickname: profile.nickname,
      avatar: profile.avatar,
      follower_count: profile.follower_count,
    };
  });

  /**
   * POST /verify-comment {code} — second proof channel: the launcher's
   * sidecar observed the caller posting the code in a TikTok LIVE chat.
   * Posting requires being logged in as that account. Advisory-level
   * proof (client-reported) — same trust model as the bio check.
   */
  app.post('/verify-comment', async (request, reply) => {
    const { row, error } = markVerified(request, reply);
    if (error) return error;
    if (row.verified) return view(row);

    const code = String(request.body?.code || '').trim();
    if (!code || code !== row.verify_code) {
      return reply.code(400).send({ error: 'CODE_MISMATCH' });
    }
    const updated = applyVerified(request.auth.userId, reply);
    if (!updated) return;
    return view(updated);
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
