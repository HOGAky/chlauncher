/**
 * @file tribute.js
 * Tribute (Telegram) billing provider.
 *
 * Flow:
 *  1. Launcher calls POST /api/tg/link-code → deep-link
 *     `TRIBUTE_BOT_URL<code>` — the user opens it in Telegram.
 *  2. Our bind-bot (apps/launcher/tg-bot) receives /start <code> and calls
 *     POST /api/tg/bind with the shared TG_BIND_SECRET → the account is
 *     linked to `telegram_user_id` — the only stable identity Tribute
 *     webhooks carry.
 *  3. The user pays via the Tribute product link; Tribute POSTs a signed
 *     event to POST /api/billing/tribute/webhook
 *     (`trbt-signature` = HMAC-SHA256 of the raw body with the API key).
 *     `new_subscription`/`renewed_subscription` grant the mapped plan
 *     period; `cancelled_subscription` stops auto-renew and caps the
 *     paid-through date at the provider's `expires_at`.
 *
 * Every signed event is journaled in `billing_events` first. Events that
 * arrive before the Telegram account is bound stay unmatched and replay
 * automatically on bind — paying first and binding later works.
 *
 * Idempotency: ledger rows use `(provider='tribute', external_id=
 * trb:<subscription_id>:<expires_at>)` so Tribute's ~24h retry bursts
 * never double-grant days.
 */

import crypto from 'node:crypto';
import { config } from '../config.js';
import { nowIso } from '../db.js';
import {
  findPlan,
  findSubscription,
  updateSubscription,
} from '../db.js';
import {
  activateOrExtend,
  refreshSubscription,
  subscriptionView,
} from '../subscriptions.js';

const LINK_CODE_TTL_MIN = 30;
const LINK_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Days granted per Tribute billing period. */
const PERIOD_DAYS = { monthly: 30, quarterly: 90, yearly: 365 };

function generateCode(len = 8) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (const b of bytes) out += LINK_CODE_ALPHABET[b % LINK_CODE_ALPHABET.length];
  return out;
}

/** timingSafeEqual that survives length mismatches. */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/** Resolves our plan_code for a Tribute subscription_id. */
function planForSubscription(db, tributeSubId, fallbackUserId) {
  const mapped = config.tributePlanMap[String(tributeSubId)];
  if (mapped && findPlan(db, mapped)) return mapped;
  const sub = fallbackUserId != null ? findSubscription(db, fallbackUserId) : null;
  return sub?.plan_code || 'pro';
}

/** Journals a webhook event; returns the row id. */
function logEvent(db, { event, externalId, telegramUserId, matchedUserId, applied, payload }) {
  return db
    .prepare(
      `INSERT INTO billing_events
         (provider, event, external_id, telegram_user_id, matched_user_id, applied, payload, created_at)
       VALUES ('tribute', ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      event,
      externalId,
      telegramUserId ?? null,
      matchedUserId ?? null,
      applied ? 1 : 0,
      JSON.stringify(payload ?? {}),
      nowIso()
    ).lastInsertRowid;
}

/**
 * Applies a paid-period event to `userId`: ledger row + subscription
 * extension. Dedupes on external_id so retries are no-ops.
 */
function applyPaidEvent(db, { userId, subscriptionId, period, expiresAt, planCode }) {
  const externalId = `trb:${subscriptionId}:${expiresAt}`;
  const days = PERIOD_DAYS[period] || 30;
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO payments
         (user_id, provider, external_id, days, status, plan_code, created_at)
       VALUES (?, 'tribute', ?, ?, 'succeeded', ?, ?)`
    )
    .run(userId, externalId, days, planCode, nowIso());
  if (info.changes === 0) return false; // already applied
  activateOrExtend(db, userId, days, planCode);
  return true;
}

/**
 * Applies a cancellation to `userId`: auto-renew off, and the
 * paid-through date is capped at the provider's expires_at (covers
 * chargeback-style early termination; a later expires_at never
 * shortens an existing paid period).
 */
function applyCancelEvent(db, userId, expiresAt) {
  const sub = refreshSubscription(db, userId);
  if (!sub) return;
  const cappedEnd =
    expiresAt && expiresAt < sub.current_period_end
      ? expiresAt
      : sub.current_period_end;
  db.prepare(
    'UPDATE subscriptions SET auto_renew = 0, current_period_end = ? WHERE user_id = ?'
  ).run(cappedEnd, userId);
}

/**
 * Replays unmatched billing_events for a freshly bound telegram id.
 * @returns {number} how many events were applied
 */
function replayUnmatched(db, telegramUserId, userId) {
  const rows = db
    .prepare(
      `SELECT * FROM billing_events
       WHERE telegram_user_id = ? AND applied = 0 AND matched_user_id IS NULL
       ORDER BY id`
    )
    .all(telegramUserId);
  let applied = 0;
  const mark = db.prepare(
    'UPDATE billing_events SET applied = 1, matched_user_id = ? WHERE id = ?'
  );
  for (const ev of rows) {
    const p = JSON.parse(ev.payload || '{}');
    let ok = false;
    if (ev.event === 'new_subscription' || ev.event === 'renewed_subscription') {
      ok = applyPaidEvent(db, {
        userId,
        subscriptionId: p.subscription_id,
        period: p.period,
        expiresAt: p.expires_at,
        planCode: planForSubscription(db, p.subscription_id, userId),
      });
    } else if (ev.event === 'cancelled_subscription') {
      applyCancelEvent(db, userId, p.expires_at);
      ok = true;
    }
    if (ok) applied += 1;
    mark.run(userId, ev.id);
  }
  return applied;
}

/**
 * @param {import('fastify').FastifyInstance} app
 * @param {{db: import('node:sqlite').DatabaseSync, authenticate: Function}} opts
 */
export default async function tributeRoutes(app, { db, authenticate }) {
  /**
   * POST /api/billing/tribute/webhook — PUBLIC. Signed by Tribute with
   * `trbt-signature` (HMAC-SHA256 of the raw body, keyed by the API key).
   * The raw body is stashed on request.raw.rawBody by the JSON parser in
   * app.js — signature check runs BEFORE trusting parsed fields.
   */
  app.post('/tribute/webhook', async (request, reply) => {
    if (!config.tributeApiKey) {
      return reply.code(501).send({ error: 'PROVIDER_NOT_CONFIGURED' });
    }
    const raw = request.raw.rawBody;
    const sig = request.headers['trbt-signature'] || '';
    if (!raw || !sig) {
      return reply.code(401).send({ error: 'INVALID_SIGNATURE' });
    }
    const expected = crypto
      .createHmac('sha256', config.tributeApiKey)
      .update(raw)
      .digest('hex');
    if (!safeEqual(expected, sig)) {
      return reply.code(401).send({ error: 'INVALID_SIGNATURE' });
    }

    const { name, payload } = request.body || {};
    if (!name || !payload || typeof payload !== 'object') {
      return reply.code(400).send({ error: 'INVALID_PAYLOAD' });
    }

    const tgId = payload.telegram_user_id ?? null;
    const subscriptionId = payload.subscription_id ?? null;
    const expiresAt =
      typeof payload.expires_at === 'string' ? payload.expires_at : null;
    const externalId =
      subscriptionId != null && expiresAt ? `trb:${subscriptionId}:${expiresAt}` : null;

    const binding = tgId != null
      ? db.prepare('SELECT user_id FROM tg_bindings WHERE telegram_user_id = ?').get(tgId)
      : null;
    const userId = binding?.user_id ?? null;

    if (
      name === 'new_subscription' ||
      name === 'renewed_subscription'
    ) {
      if (!subscriptionId || !expiresAt || tgId == null) {
        return reply.code(400).send({ error: 'INVALID_PAYLOAD' });
      }
      if (userId == null) {
        // Paid before binding — journal and replay on /api/tg/bind.
        logEvent(db, {
          event: name, externalId, telegramUserId: tgId,
          matchedUserId: null, applied: false, payload,
        });
        request.log.warn({ tgId, subscriptionId }, 'tribute event for unbound telegram user');
        return { ok: true };
      }
      const planCode = planForSubscription(db, subscriptionId, userId);
      const applied = applyPaidEvent(db, {
        userId, subscriptionId, period: payload.period, expiresAt, planCode,
      });
      db.prepare(
        'UPDATE subscriptions SET auto_renew = 1 WHERE user_id = ?'
      ).run(userId);
      logEvent(db, {
        event: name, externalId, telegramUserId: tgId,
        matchedUserId: userId, applied, payload,
      });
    } else if (name === 'cancelled_subscription') {
      if (userId == null) {
        logEvent(db, {
          event: name, externalId, telegramUserId: tgId,
          matchedUserId: null, applied: false, payload,
        });
        return { ok: true };
      }
      applyCancelEvent(db, userId, expiresAt);
      logEvent(db, {
        event: name, externalId, telegramUserId: tgId,
        matchedUserId: userId, applied: true, payload,
      });
    } else {
      // Donations, physical orders, digital products — not our surface.
      // Acknowledge so Tribute stops retrying.
      request.log.info({ name }, 'ignoring tribute event');
    }
    return { ok: true };
  });

  /** GET /api/billing/providers — which payment rails are configured. */
  app.get('/providers', { preHandler: authenticate }, async () => ({
    yookassa: !!(config.yookassaShopId && config.yookassaSecretKey),
    tribute: !!(config.tributeApiKey && config.tributeBotUrl),
    tribute_links: config.tributeProductLinks,
  }));
}

/**
 * Telegram binding surface — mounted at /api/tg.
 * @param {import('fastify').FastifyInstance} app
 * @param {{db: import('node:sqlite').DatabaseSync, authenticate: Function}} opts
 */
export async function tgRoutes(app, { db, authenticate }) {
  /**
   * POST /api/tg/link-code — {plan_code?} → one-shot deep-link code for
   * the bind-bot. Launcher opens `bot_url` in the system browser.
   */
  app.post('/link-code', { preHandler: authenticate }, async (request, reply) => {
    if (!config.tributeBotUrl || !config.tgBindSecret) {
      return reply.code(501).send({ error: 'PROVIDER_NOT_CONFIGURED' });
    }
    const planCode = request.body?.plan_code
      ? String(request.body.plan_code)
      : null;
    if (planCode && !findPlan(db, planCode)) {
      return reply.code(400).send({ error: 'UNKNOWN_PLAN' });
    }
    const code = generateCode();
    const expiresAt = new Date(
      Date.now() + LINK_CODE_TTL_MIN * 60_000
    ).toISOString();
    db.prepare(
      `INSERT INTO billing_link_codes (code, user_id, plan_code, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(code, request.auth.userId, planCode, expiresAt, nowIso());
    return {
      code,
      bot_url: `${config.tributeBotUrl}${code}`,
      expires_at: expiresAt,
    };
  });

  /**
   * POST /api/tg/bind — called by OUR bind-bot, not end users. Header
   * `x-bot-secret` must equal TG_BIND_SECRET. Body:
   * {code, telegram_user_id, telegram_username}. Consumes the code,
   * upserts the binding, replays unmatched webhook events and returns
   * the product link the bot should show next.
   */
  app.post('/bind', async (request, reply) => {
    if (!config.tgBindSecret) {
      return reply.code(501).send({ error: 'PROVIDER_NOT_CONFIGURED' });
    }
    if (!safeEqual(request.headers['x-bot-secret'] || '', config.tgBindSecret)) {
      return reply.code(401).send({ error: 'INVALID_SECRET' });
    }
    const { code, telegram_user_id: tgId, telegram_username: tgName } =
      request.body || {};
    if (!code || !Number.isInteger(tgId)) {
      return reply.code(400).send({ error: 'INVALID_PAYLOAD' });
    }
    const row = db
      .prepare('SELECT * FROM billing_link_codes WHERE code = ?')
      .get(String(code));
    if (!row || row.used || row.expires_at <= nowIso()) {
      return reply.code(410).send({ error: 'CODE_INVALID' });
    }
    db.prepare('UPDATE billing_link_codes SET used = 1 WHERE code = ?').run(code);
    // Rebind semantics: the latest code wins — the Telegram id moves to
    // the new account, and any previous binding on this account drops.
    db.prepare('DELETE FROM tg_bindings WHERE telegram_user_id = ? OR user_id = ?').run(
      tgId,
      row.user_id
    );
    db.prepare(
      `INSERT INTO tg_bindings (user_id, telegram_user_id, telegram_username, bound_at)
       VALUES (?, ?, ?, ?)`
    ).run(row.user_id, tgId, String(tgName || ''), nowIso());
    const applied = replayUnmatched(db, tgId, row.user_id);
    const planCode = row.plan_code || 'pro';
    return {
      ok: true,
      applied_events: applied,
      plan_code: planCode,
      product_url: config.tributeProductLinks[planCode] || null,
      subscription: subscriptionView(refreshSubscription(db, row.user_id)),
    };
  });

  /**
   * GET /api/tg/bind-status?telegram_user_id=… — bot-side lookup for
   * `/status` replies. Same shared-secret auth as /bind.
   */
  app.get('/bind-status', async (request, reply) => {
    if (!config.tgBindSecret) {
      return reply.code(501).send({ error: 'PROVIDER_NOT_CONFIGURED' });
    }
    if (!safeEqual(request.headers['x-bot-secret'] || '', config.tgBindSecret)) {
      return reply.code(401).send({ error: 'INVALID_SECRET' });
    }
    const tgId = Number(request.query?.telegram_user_id);
    const binding = Number.isInteger(tgId)
      ? db.prepare('SELECT * FROM tg_bindings WHERE telegram_user_id = ?').get(tgId)
      : null;
    if (!binding) return { bound: false };
    const user = db
      .prepare('SELECT email FROM users WHERE id = ?')
      .get(binding.user_id);
    const [local, domain = ''] = (user?.email || '?').split('@');
    const masked =
      local.length <= 2 ? `${local[0] || '?'}…@${domain}` : `${local.slice(0, 2)}…@${domain}`;
    return {
      bound: true,
      email_masked: masked,
      subscription: subscriptionView(refreshSubscription(db, binding.user_id)),
    };
  });

  /** GET /api/tg/status — the caller's own binding (launcher UI). */
  app.get('/status', { preHandler: authenticate }, async (request) => {
    const binding = db
      .prepare('SELECT * FROM tg_bindings WHERE user_id = ?')
      .get(request.auth.userId);
    return {
      bound: !!binding,
      telegram_username: binding?.telegram_username || null,
      bound_at: binding?.bound_at || null,
    };
  });

  /** POST /api/tg/unbind — detach the caller's Telegram account. */
  app.post('/unbind', { preHandler: authenticate }, async (request) => {
    db.prepare('DELETE FROM tg_bindings WHERE user_id = ?').run(request.auth.userId);
    return { ok: true };
  });
}
