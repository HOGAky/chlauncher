/**
 * @file routes/pair.js
 * Phone-pairing flow ("Вход по QR"): the launcher shows a QR encoding
 * `<public>/pair/<code>`; the phone opens a small page offering
 *   - "Войти через Telegram" — same bind-bot, `pair_<code>` start param;
 *   - a sessionid paste field — verified against TikTok, then stored on
 *     the code so the launcher picks it up as a saved TikTok session.
 *
 * A raw web page CANNOT read TikTok's HttpOnly cookies — the paste field
 * is the honest phone-side path, and Login Kit OAuth can be bolted on
 * here later once the developer app is approved.
 *
 *   POST /api/auth/pair-start   — create code (launcher) → {code, url}
 *   GET  /pair/:code            — the phone-facing HTML page
 *   GET  /api/auth/pair-state   — lightweight claimed-flags for the page
 *   POST /api/auth/pair-session — page submits sessionid (verified)
 *   POST /api/auth/pair-claim   — bot-side tg claim (x-bot-secret)
 *   POST /api/auth/pair-status  — launcher poll → JWT + stored session
 */

import crypto from 'node:crypto';
import os from 'node:os';
import dgram from 'node:dgram';
import rateLimit from '@fastify/rate-limit';
import { config } from '../config.js';
import {
  createUser,
  setUserHwid,
  nowIso,
  recordDeviceEvent,
} from '../db.js';
import { hashPassword, signToken, syncAdminRole } from '../auth.js';
import { isUsableHwid, hwidHash, ipHash } from '../hwid.js';
import { refreshSubscription, subscriptionView } from '../subscriptions.js';
import { fetchTikTokAccountInfo } from './auth.js';

const CODE_TTL_MS = 10 * 60 * 1000;
const SESSION_ID_RE = /^[A-Za-z0-9._%\-]{10,200}$/;

/**
 * §14: raw TikTok cookies must not rest in the DB — pair rows encrypt
 * `tiktok_sessionid`/`tiktok_idc` with AES-256-GCM. The key derives from
 * JWT_SECRET via HKDF, so no new operator secret is needed and rotating
 * JWT_SECRET invalidates stored pair sessions (they live ≤10 min anyway).
 * Rows written before this change still read as plaintext fallback.
 */
const PAIR_KEY = Buffer.from(
  crypto.hkdfSync('sha256', config.jwtSecret, 'chlauncher', 'pair-code-secrets', 32)
);

function encSecret(v) {
  if (!v) return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', PAIR_KEY, iv);
  const ct = Buffer.concat([c.update(String(v), 'utf8'), c.final()]);
  return `enc:${iv.toString('base64')}.${c.getAuthTag().toString('base64')}.${ct.toString('base64')}`;
}

function decSecret(v) {
  if (!v) return null;
  if (!v.startsWith('enc:')) return v; // pre-encryption plaintext row
  try {
    const [iv, tag, ct] = v
      .slice(4)
      .split('.')
      .map((s) => Buffer.from(s, 'base64'));
    const d = crypto.createDecipheriv('aes-256-gcm', PAIR_KEY, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  } catch {
    return null; // rotated key / tampered row — session is dropped, not leaked
  }
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/**
 * The outbound interface IP — a UDP `connect()` picks the kernel's
 * primary route without sending a packet, so it lands on the real
 * Wi-Fi NIC instead of VirtualBox/VPN adapters. Falls back to the
 * first classic-LAN interface.
 */
function primaryLanIp() {
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    const done = (ip) => {
      try { s.close(); } catch { /* already closed */ }
      resolve(ip);
    };
    s.once('error', () => done(null));
    s.connect(53, '8.8.8.8', () => done(s.address().address));
  }).then((ip) => {
    if (ip) return ip;
    for (const list of Object.values(os.networkInterfaces())) {
      for (const ni of list || []) {
        if (ni.family !== 'IPv4' || ni.internal) continue;
        const [a, b] = ni.address.split('.').map(Number);
        if (a === 192 || a === 10 || (a === 172 && b >= 16 && b <= 31)) return ni.address;
      }
    }
    return null;
  });
}

/** Base URL the QR should point at — phone-reachable LAN address in
 * dev; PUBLIC_BASE_URL (set in prod) always wins. */
async function lanBaseUrl() {
  if (config.publicBaseUrl && !/127\.0\.0\.1|localhost/.test(config.publicBaseUrl)) {
    return config.publicBaseUrl.replace(/\/+$/, '');
  }
  const port = new URL(config.publicBaseUrl).port || 8787;
  const ip = await primaryLanIp();
  return ip ? `http://${ip}:${port}` : config.publicBaseUrl.replace(/\/+$/, '');
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function pairPage(code, botUrl) {
  const tgUrl = botUrl ? `${botUrl}pair_${code}` : '';
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>chlauncher — вход</title>
<body style="background:#0f1117;color:#eee;font:14px system-ui;display:flex;justify-content:center;padding:24px 12px">
<div style="max-width:420px;width:100%">
<h2 style="margin:0 0 4px">chlauncher</h2>
<p style="color:#9aa">Привязка телефона — код <b>${esc(code)}</b></p>
<div id="status" style="padding:10px;border:1px solid #2a2f3a;border-radius:10px;background:#161a22;color:#9aa">Ожидание действий…</div>
${tgUrl ? `<a href="${esc(tgUrl)}" style="display:block;margin-top:14px;padding:14px;text-align:center;background:#229ed9;color:#fff;border-radius:10px;text-decoration:none;font-weight:600">Войти через Telegram</a>
<p style="color:#889;font-size:12px">Откроется бот — нажмите Start. Вход в лаунчер завершится автоматически.</p>` : ''}
<details style="margin-top:16px"><summary style="cursor:pointer;color:#7cf">Дать сессию TikTok (sessionid, продвинуто)</summary>
<p style="color:#889;font-size:12px">Страница не может прочитать куки TikTok сама — вставьте <code>sessionid</code> (DevTools → Application → Cookies), если TikTok у вас в браузере телефона.</p>
<input id="sid" placeholder="sessionid" style="width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid #2a2f3a;background:#0d1017;color:#eee">
<input id="idc" placeholder="tt-target-idc (необязательно)" style="width:100%;box-sizing:border-box;margin-top:8px;padding:10px;border-radius:8px;border:1px solid #2a2f3a;background:#0d1017;color:#eee">
<button onclick="send()" style="margin-top:8px;padding:12px;width:100%;border:0;border-radius:8px;background:#7c5cff;color:#fff;font-weight:600">Передать сессию</button>
<div id="msg" style="margin-top:8px;font-size:12px"></div></details>
<script>
const code=${JSON.stringify(code)};
async function send(){
 const m=document.getElementById('msg');
 try{
  const r=await fetch('/api/auth/pair-session',{method:'POST',headers:{'content-type':'application/json'},
   body:JSON.stringify({code,sessionid:document.getElementById('sid').value,tt_target_idc:document.getElementById('idc').value})});
  const j=await r.json();
  m.style.color=r.ok?'#7d7':'#e77';
  m.textContent=r.ok?('Сессия @'+j.username+' принята — вернитесь в лаунчер'):('Ошибка: '+(j.error||r.status));
 }catch(e){m.style.color='#e77';m.textContent='Сеть: '+e.message}
}
async function poll(){
 try{
  const r=await fetch('/api/auth/pair-state?code='+encodeURIComponent(code));
  const j=await r.json();
  const parts=[];
  if(j.telegram)parts.push('Telegram подтверждён');
  if(j.session)parts.push('сессия TikTok принята (@'+(j.username||'')+')');
  if(parts.length)document.getElementById('status').innerHTML='<b style="color:#7d7">'+parts.join(' · ')+'</b><br>Можно вернуться в лаунчер.';
 }catch(e){}
}
setInterval(poll,3000);poll();
</script>
</div></body>`;
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    role: user.role || 'user',
    hwid_bound: !!user.hwid,
    hwid_last_reset: user.hwid_last_reset,
    created_at: user.created_at,
  };
}

/**
 * @param {import('fastify').FastifyInstance} app
 * @param {{db: import('node:sqlite').DatabaseSync, authenticate: Function}} opts
 */
export default async function pairRoutes(app, { db }) {
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });

  const getCode = (code) =>
    db.prepare('SELECT * FROM pair_codes WHERE code = ?').get(String(code || ''));

  /** POST /api/auth/pair-start — launcher creates a pairing code. */
  app.post(
    '/api/auth/pair-start',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async () => {
      const code = crypto.randomBytes(12).toString('base64url');
      db.prepare(
        `INSERT INTO pair_codes (code, expires_at, created_at) VALUES (?,?,?)`
      ).run(code, new Date(Date.now() + CODE_TTL_MS).toISOString(), nowIso());
      return {
        code,
        url: `${await lanBaseUrl()}/pair/${code}`,
        expires_in: CODE_TTL_MS / 1000,
      };
    }
  );

  /** GET /pair/:code — the phone-facing page (public). */
  app.get('/pair/:code', async (request, reply) => {
    const row = getCode(request.params.code);
    if (!row || row.expires_at <= nowIso()) {
      return reply
        .code(410)
        .type('text/html; charset=utf-8')
        .send('<!doctype html><meta charset="utf-8"><body style="background:#0f1117;color:#eee;font:14px system-ui;padding:40px;text-align:center">Ссылка устарела — сгенерируйте новый QR в лаунчере.</body>');
    }
    return reply
      .type('text/html; charset=utf-8')
      .send(pairPage(request.params.code, config.tributeBotUrl));
  });

  /** GET /api/auth/pair-state — page-side claimed flags. */
  app.get('/api/auth/pair-state', async (request) => {
    const row = getCode(request.query?.code);
    if (!row || row.expires_at <= nowIso()) {
      return { valid: false };
    }
    return {
      valid: true,
      telegram: row.telegram_user_id != null,
      session: row.tiktok_sessionid != null,
      username: row.tiktok_username || null,
    };
  });

  /** POST /api/auth/pair-session — phone submits sessionid (verified). */
  app.post(
    '/api/auth/pair-session',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { code, sessionid, tt_target_idc } = request.body || {};
      const row = getCode(code);
      if (!row || row.consumed || row.expires_at <= nowIso()) {
        return reply.code(410).send({ error: 'CODE_INVALID' });
      }
      const sid = String(sessionid || '').trim();
      const idc = String(tt_target_idc || '').trim();
      if (!SESSION_ID_RE.test(sid) || (idc && !SESSION_ID_RE.test(idc))) {
        return reply.code(400).send({ error: 'INVALID_PAYLOAD' });
      }
      const info = await fetchTikTokAccountInfo(sid, idc);
      if (!info.ok) {
        return reply.code(401).send({ error: 'TIKTOK_SESSION_INVALID' });
      }
      db.prepare(
        `UPDATE pair_codes
         SET tiktok_sessionid = ?, tiktok_idc = ?, tiktok_uid = ?, tiktok_username = ?
         WHERE code = ?`
      ).run(
        encSecret(sid),
        encSecret(idc) || null,
        info.uid,
        info.username || null,
        row.code
      );
      return { ok: true, username: info.username || '' };
    }
  );

  /** POST /api/auth/pair-claim — bot-side: the user pressed Start. */
  app.post('/api/auth/pair-claim', async (request, reply) => {
    if (!config.tgBindSecret) {
      return reply.code(501).send({ error: 'PROVIDER_NOT_CONFIGURED' });
    }
    if (!safeEqual(request.headers['x-bot-secret'] || '', config.tgBindSecret)) {
      return reply.code(401).send({ error: 'INVALID_SECRET' });
    }
    const { code, telegram_user_id: tgId, telegram_username: tgName } =
      request.body || {};
    const row = getCode(code);
    if (!row || row.consumed || row.expires_at <= nowIso() || !Number.isInteger(tgId)) {
      return reply.code(410).send({ error: 'CODE_INVALID' });
    }
    db.prepare(
      `UPDATE pair_codes SET telegram_user_id = ?, telegram_username = ?
       WHERE code = ? AND telegram_user_id IS NULL`
    ).run(tgId, String(tgName || ''), row.code);
    return { ok: true };
  });

  /**
   * POST /api/auth/pair-status {code, hwid?} — launcher poll.
   * 'pending' until the phone claims something; the first status that
   * can deliver a result consumes the code:
   *   - telegram claimed → find-or-create tg_* user → JWT (HWID rules
   *     mirror /api/auth/telegram-status) plus any stored session;
   *   - only a session stored → {status:'session'} and the cookie pair.
   */
  app.post(
    '/api/auth/pair-status',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { code, hwid } = request.body || {};
      const row = getCode(code);
      if (!row || row.consumed || row.expires_at <= nowIso()) {
        return reply.code(404).send({ error: 'CODE_INVALID' });
      }
      const sessionid = decSecret(row.tiktok_sessionid);
      const tiktokSession = sessionid
        ? {
            sessionid,
            idc: decSecret(row.tiktok_idc) || null,
            uid: row.tiktok_uid || null,
            username: row.tiktok_username || null,
          }
        : null;
      if (row.telegram_user_id == null && !tiktokSession) {
        return { status: 'pending' };
      }

      const claimed = db
        .prepare('UPDATE pair_codes SET consumed = 1 WHERE code = ? AND consumed = 0')
        .run(row.code);
      if (claimed.changes === 0) {
        return reply.code(404).send({ error: 'CODE_INVALID' });
      }

      if (row.telegram_user_id == null) {
        return { status: 'session', tiktok_session: tiktokSession };
      }

      const tgId = row.telegram_user_id;
      let user = db
        .prepare(
          `SELECT u.* FROM users u
           JOIN tg_bindings b ON b.user_id = u.id
           WHERE b.telegram_user_id = ?`
        )
        .get(tgId);
      if (!user) {
        user = createUser(db, {
          email: `tg_${tgId}@telegram.local`,
          passwordHash: hashPassword(crypto.randomBytes(24).toString('hex')),
          hwid: hwid && isUsableHwid(hwid) ? hwidHash(hwid) : null,
        });
        db.prepare(
          `INSERT INTO tg_bindings (user_id, telegram_user_id, telegram_username, bound_at)
           VALUES (?,?,?,?)`
        ).run(user.id, tgId, row.telegram_username || '', nowIso());
      }
      syncAdminRole(db, user);

      if (user.role !== 'admin') {
        if (!hwid) {
          return reply.code(400).send({ error: 'HWID_REQUIRED' });
        }
        if (!isUsableHwid(hwid)) {
          return reply.code(400).send({ error: 'HWID_UNAVAILABLE' });
        }
        const hash = hwidHash(hwid);
        if (user.hwid && user.hwid !== hash) {
          recordDeviceEvent(db, user.id, 'login_denied', hash, ipHash(request.ip));
          return reply.code(403).send({ error: 'HWID_MISMATCH' });
        }
        if (!user.hwid) {
          setUserHwid(db, user.id, hash);
          recordDeviceEvent(db, user.id, 'bound', hash, ipHash(request.ip));
        }
      }
      const subscription = refreshSubscription(db, user.id);
      return {
        status: 'ready',
        token: signToken(user),
        user: publicUser(user),
        subscription: subscriptionView(subscription),
        tiktok_session: tiktokSession,
      };
    }
  );
}
