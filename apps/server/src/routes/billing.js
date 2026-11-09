/**
 * @file routes/billing.js
 * Billing endpoints (spec §5): subscription status, provider-agnostic
 * checkout + webhook contract, and flag-gated mock routes for e2e.
 *
 *  - GET  /api/billing/subscription  — current subscription (lazy-expired)
 *  - POST /api/billing/checkout      — create a pending payment + checkout URL
 *  - POST /api/billing/webhook       — PUBLIC provider notifications
 *  - POST /api/billing/mock-pay      — TEST ONLY (ENABLE_MOCK_BILLING)
 *  - POST /api/billing/mock-expire   — TEST ONLY (ENABLE_MOCK_BILLING)
 *
 * Provider v1 is YooKassa. Webhook verification accepts either HTTP Basic
 * `shop_id:secret` (embed it in the notification URL) or a source IP inside
 * the official YooKassa notification subnets. Every `payment.succeeded`
 * resolves strictly via our own `payments` row — the webhook never looks
 * users up by email (§5.3).
 */

import {
  refreshSubscription,
  subscriptionView,
  activateOrExtend,
  recordPayment,
  forceExpire,
} from '../subscriptions.js';
import { nowIso, findPlan } from '../db.js';
import { config } from '../config.js';

/** Official YooKassa notification source networks (docs.yookassa.ru). */
const YOOKASSA_NETS = [
  ['185.71.76.0', 27],
  ['185.71.77.0', 27],
  ['77.75.153.0', 25],
  ['77.75.154.128', 25],
  ['77.75.156.11', 32],
  ['77.75.156.35', 32],
  ['77.75.157.32', 32],
];

function ipToInt(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !(p >= 0 && p <= 255))) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function ipInNets(ip, nets) {
  const v = ipToInt(ip);
  if (v === null) return false;
  return nets.some(([base, bits]) => {
    const b = ipToInt(base);
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (v & mask) === (b & mask);
  });
}

/**
 * Verifies the caller is entitled to hit the webhook: HTTP Basic
 * `shop_id:secret` or a YooKassa source IP (skippable for dev tunnels).
 * @returns {boolean}
 */
function verifyWebhookAuth(request) {
  const header = request.headers.authorization || '';
  if (header.startsWith('Basic ')) {
    const [id, ...rest] = Buffer.from(header.slice(6), 'base64')
      .toString('utf8')
      .split(':');
    if (id === config.yookassaShopId && rest.join(':') === config.yookassaSecretKey) {
      return true;
    }
  }
  if (config.webhookSkipIpCheck) return true;
  return ipInNets(request.ip, YOOKASSA_NETS);
}

/**
 * @param {import('fastify').FastifyInstance} app
 * @param {{db: import('node:sqlite').DatabaseSync, authenticate: Function}} opts
 */
export default async function billingRoutes(app, { db, authenticate }) {
  /** GET /api/billing/subscription — current subscription (lazy-expired). */
  app.get(
    '/subscription',
    { preHandler: authenticate },
    async (request) => {
      const sub = refreshSubscription(db, request.auth.userId);
      return { subscription: subscriptionView(sub) };
    }
  );

  /**
   * POST /api/billing/checkout — {plan_code?} creates a pending payments
   * row priced from the plans table and asks YooKassa for a hosted
   * checkout page. 501 until YOOKASSA_* is set.
   */
  app.post('/checkout', { preHandler: authenticate }, async (request, reply) => {
    if (!config.yookassaShopId || !config.yookassaSecretKey) {
      return reply.code(501).send({ error: 'PROVIDER_NOT_CONFIGURED' });
    }
    const planCode = String(request.body?.plan_code || 'pro');
    const plan = findPlan(db, planCode);
    if (!plan || !plan.active || plan.price_minor <= 0) {
      return reply.code(400).send({ error: 'UNKNOWN_PLAN' });
    }
    const amount = {
      value: (plan.price_minor / 100).toFixed(2),
      currency: plan.currency,
    };
    const res = await fetch('https://api.yookassa.ru/v3/payments', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Basic ${Buffer.from(
          `${config.yookassaShopId}:${config.yookassaSecretKey}`
        ).toString('base64')}`,
        'idempotence-key': crypto.randomUUID(),
      },
      body: JSON.stringify({
        amount,
        capture: true,
        confirmation: { type: 'redirect', return_url: 'chlauncher://billing/return' },
        description: `chlauncher ${plan.title} — ${plan.period_days} days`,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.id) {
      request.log.warn({ status: res.status, body }, 'yookassa checkout failed');
      return reply.code(502).send({ error: 'PROVIDER_ERROR' });
    }
    db.prepare(
      `INSERT INTO payments (user_id, provider, external_id, days, status, plan_code, created_at)
       VALUES (?, 'yookassa', ?, ?, 'pending', ?, ?)`
    ).run(request.auth.userId, body.id, plan.period_days, plan.code, nowIso());
    return {
      payment_id: body.id,
      plan_code: plan.code,
      checkout_url: body.confirmation?.confirmation_url || null,
    };
  });

  /**
   * POST /api/billing/webhook — PUBLIC. YooKassa notification handler:
   * verify → match our payments row by external_id → extend idempotently.
   * canceled/refunded update the ledger but never touch the subscription
   * (manual review via admin per spec).
   */
  app.post('/webhook', async (request, reply) => {
    if (!config.yookassaShopId) {
      return reply.code(501).send({ error: 'PROVIDER_NOT_CONFIGURED' });
    }
    if (!verifyWebhookAuth(request)) {
      return reply.code(401).send({ error: 'INVALID_SIGNATURE' });
    }

    const { event, object } = request.body || {};
    const externalId = object?.id;
    if (!externalId) return reply.code(400).send({ error: 'INVALID_PAYLOAD' });

    const payment = db
      .prepare("SELECT * FROM payments WHERE provider = 'yookassa' AND external_id = ?")
      .get(externalId);
    if (!payment) {
      // Unknown payment — acknowledge so the provider stops retrying.
      request.log.warn({ externalId }, 'webhook for unknown payment');
      return { ok: true };
    }

    if (event === 'payment.succeeded') {
      if (payment.status === 'succeeded') return { ok: true }; // idempotent
      if (payment.status !== 'pending') return { ok: true };
      db.prepare("UPDATE payments SET status = 'succeeded' WHERE id = ?").run(payment.id);
      // §8.3: the paid plan activates; leftover days of the old plan are
      // not recalculated — the new period simply stacks.
      activateOrExtend(db, payment.user_id, payment.days, payment.plan_code);
    } else if (event === 'payment.canceled') {
      db.prepare("UPDATE payments SET status = 'failed' WHERE id = ? AND status = 'pending'").run(payment.id);
    } else if (event === 'refund.succeeded') {
      db.prepare("UPDATE payments SET status = 'refunded' WHERE id = ?").run(payment.id);
    }
    return { ok: true };
  });

  // -------------------------------------------------------------------
  // Mock endpoints — only registered when ENABLE_MOCK_BILLING allows (§5.5)
  // -------------------------------------------------------------------
  if (config.enableMockBilling) {
    /** POST /api/billing/mock-pay — TEST ONLY: grant/extend a plan. */
    app.post('/mock-pay', { preHandler: authenticate }, async (request, reply) => {
      const planCode = String(request.body?.plan_code || 'pro');
      const plan = findPlan(db, planCode);
      if (!plan || !plan.active || plan.price_minor <= 0) {
        return reply.code(400).send({ error: 'UNKNOWN_PLAN' });
      }
      const { subscription } = recordPayment(db, {
        userId: request.auth.userId,
        provider: 'mock',
        externalId: `mock-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        days: plan.period_days,
        planCode: plan.code,
      });
      request.log.info({ userId: request.auth.userId }, 'mock payment applied');
      return { ok: true, subscription: subscriptionView(subscription) };
    });

    /** POST /api/billing/mock-expire — TEST ONLY: force-expire the period. */
    app.post('/mock-expire', { preHandler: authenticate }, async (request) => {
      forceExpire(db, request.auth.userId);
      const sub = refreshSubscription(db, request.auth.userId);
      return { ok: true, subscription: subscriptionView(sub) };
    });
  }
}
