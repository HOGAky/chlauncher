/**
 * @file routes/promo.js
 * Growth surface adopted from the EFIR teardown (docs/competitor-efir.md):
 *
 *  POST /api/promo/redeem    {code}  → grants the code's subscription days
 *  GET  /api/referrals               → my referral code + stats
 *  POST /api/referrals/apply {code}  → attach a referrer to my account once
 *
 * Promo codes are created in the admin panel (/api/admin/promo*).
 * Referral codes are permanent per user and generated lazily. Rewards:
 * the referee gets REFEREE_DAYS at once, the referrer gets REFERRER_DAYS
 * credited per accepted referral (capped at REFERRAL_CAP to limit abuse —
 * HWID binding already makes self-referral farming expensive).
 */

import crypto from 'node:crypto';
import { nowIso } from '../db.js';
import { recordPayment, subscriptionView } from '../subscriptions.js';

const CODE_RE = /^[A-Z0-9_-]{4,32}$/i;
const REFERRER_DAYS = 7;
const REFEREE_DAYS = 3;
const REFERRAL_CAP = 20;

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const refCode = () =>
  Array.from(crypto.randomBytes(8), (b) => ALPHABET[b % ALPHABET.length]).join('');

/** Returns (and lazily creates) the user's permanent referral code. */
function ensureReferralCode(db, userId) {
  const user = db.prepare('SELECT referral_code FROM users WHERE id = ?').get(userId);
  if (user?.referral_code) return user.referral_code;
  for (let i = 0; i < 8; i += 1) {
    const code = refCode();
    try {
      db.prepare('UPDATE users SET referral_code = ? WHERE id = ?').run(code, userId);
      return code;
    } catch {
      /* astronomically unlikely collision — retry */
    }
  }
  throw new Error('REFERRAL_CODE_FAILED');
}

export default async function promoRoutes(app, { db, authenticate }) {
  app.addHook('preHandler', authenticate);

  /**
   * POST /api/promo/redeem {code}
   * Atomic: the redemption row's UNIQUE(code, user_id) + the uses bump
   * under a transaction make double-redeem and over-use races impossible.
   */
  app.post('/promo/redeem', async (request, reply) => {
    const code = String(request.body?.code || '').trim().toUpperCase();
    if (!CODE_RE.test(code)) {
      return reply.code(400).send({ error: 'PROMO_INVALID' });
    }
    const promo = db.prepare('SELECT * FROM promo_codes WHERE code = ?').get(code);
    if (!promo) return reply.code(404).send({ error: 'PROMO_NOT_FOUND' });
    if (promo.expires_at && promo.expires_at < nowIso()) {
      return reply.code(410).send({ error: 'PROMO_EXPIRED' });
    }
    const already = db
      .prepare('SELECT 1 FROM promo_redemptions WHERE code = ? AND user_id = ?')
      .get(code, request.auth.userId);
    if (already) return reply.code(409).send({ error: 'PROMO_ALREADY_USED' });

    db.exec('BEGIN');
    try {
      const bump = db
        .prepare('UPDATE promo_codes SET uses = uses + 1 WHERE code = ? AND uses < max_uses')
        .run(code);
      if (bump.changes === 0) {
        db.exec('ROLLBACK');
        return reply.code(410).send({ error: 'PROMO_EXHAUSTED' });
      }
      db.prepare(
        'INSERT INTO promo_redemptions (code, user_id, days, created_at) VALUES (?,?,?,?)'
      ).run(code, request.auth.userId, promo.days, nowIso());
      recordPayment(db, {
        userId: request.auth.userId,
        provider: 'promo',
        externalId: `promo:${code}:${request.auth.userId}`,
        days: promo.days,
      });
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    const sub = db.prepare('SELECT * FROM subscriptions WHERE user_id = ?').get(request.auth.userId);
    return { ok: true, days: promo.days, subscription: subscriptionView(sub) };
  });

  /** GET /api/referrals — my code, how many applied, days earned. */
  app.get('/referrals', async (request) => {
    const code = ensureReferralCode(db, request.auth.userId);
    const stats = db
      .prepare(
        `SELECT COUNT(*) AS applied, COALESCE(SUM(days), 0) AS days
         FROM referral_rewards WHERE referrer_id = ?`
      )
      .get(request.auth.userId);
    const referredBy = db
      .prepare('SELECT referred_by FROM users WHERE id = ?')
      .get(request.auth.userId);
    return {
      code,
      applied: stats.applied,
      days_earned: stats.days,
      cap: REFERRAL_CAP,
      referred: !!referredBy?.referred_by,
      reward_days: REFERRER_DAYS,
      referee_days: REFEREE_DAYS,
    };
  });

  /**
   * POST /api/referrals/apply {code}
   * One-shot: users.referred_by is set once. Rewards both sides via the
   * normal payments ledger (provider='referral'). Self-referral and
   * rewarding beyond REFERRAL_CAP are refused.
   */
  app.post('/referrals/apply', async (request, reply) => {
    const code = String(request.body?.code || '').trim().toUpperCase();
    if (!CODE_RE.test(code)) {
      return reply.code(400).send({ error: 'REFERRAL_INVALID' });
    }
    const me = db
      .prepare('SELECT id, referred_by FROM users WHERE id = ?')
      .get(request.auth.userId);
    if (me.referred_by) {
      return reply.code(409).send({ error: 'REFERRAL_ALREADY_APPLIED' });
    }
    const referrer = db.prepare('SELECT id FROM users WHERE referral_code = ?').get(code);
    if (!referrer) return reply.code(404).send({ error: 'REFERRAL_NOT_FOUND' });
    if (referrer.id === me.id) {
      return reply.code(400).send({ error: 'REFERRAL_SELF' });
    }

    db.exec('BEGIN');
    try {
      const claimed = db
        .prepare('UPDATE users SET referred_by = ? WHERE id = ? AND referred_by IS NULL')
        .run(referrer.id, me.id);
      if (claimed.changes === 0) {
        db.exec('ROLLBACK');
        return reply.code(409).send({ error: 'REFERRAL_ALREADY_APPLIED' });
      }
      const rewarded = db
        .prepare('SELECT COUNT(*) AS n FROM referral_rewards WHERE referrer_id = ?')
        .get(referrer.id).n;
      db.prepare(
        `INSERT INTO referral_rewards (referrer_id, referee_id, kind, days, created_at)
         VALUES (?,?,?,?,?)`
      ).run(referrer.id, me.id, 'signup', rewarded < REFERRAL_CAP ? REFERRER_DAYS : 0, nowIso());
      recordPayment(db, {
        userId: me.id,
        provider: 'referral',
        externalId: `referee:${me.id}`,
        days: REFEREE_DAYS,
      });
      if (rewarded < REFERRAL_CAP) {
        recordPayment(db, {
          userId: referrer.id,
          provider: 'referral',
          externalId: `referrer:${referrer.id}:${me.id}`,
          days: REFERRER_DAYS,
        });
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    const sub = db.prepare('SELECT * FROM subscriptions WHERE user_id = ?').get(me.id);
    return { ok: true, days: REFEREE_DAYS, subscription: subscriptionView(sub) };
  });
}
