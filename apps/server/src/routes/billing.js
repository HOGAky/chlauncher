/**
 * @file routes/billing.js
 * Billing endpoints (spec §5): subscription status, provider-agnostic
 * checkout + webhook contract, and flag-gated mock routes for e2e.
 *
 *  - GET  /api/billing/subscription  — current subscription (lazy-expired)
 *  - POST /api/billing/checkout      — create/reuse a pending order + URL
 *  - POST /api/billing/webhook       — PUBLIC provider notifications
 *  - POST /api/billing/mock-pay      — TEST ONLY (ENABLE_MOCK_BILLING)
 *  - POST /api/billing/mock-expire   — TEST ONLY (ENABLE_MOCK_BILLING)
 *
 * Provider v1 is YooKassa. Webhook verification accepts either HTTP Basic
 * `shop_id:secret` (embed it in the notification URL) or a source IP inside
 * the official YooKassa notification subnets. Every `payment.succeeded`
 * resolves strictly via our own `payments` row — the webhook never looks
 * users up by email (§5.3).
 *
 * Atomicity contract (P0.4): every ledger status change that grants or
 * revokes subscription time runs inside ONE SQLite transaction
 * (`withTx`), guarded by a conditional UPDATE on the expected prior
 * state — duplicate, out-of-order and concurrent webhook deliveries are
 * all safe no-ops. Checkout is idempotent on `idempotency_key` (or a
 * recent pending order for the same plan): the provider call uses the
 * internal order ref as its Idempotence-Key so retries never mint two
 * provider payments. Webhook events for payments we don't know yet are
 * journaled in `billing_events` and replayed once the order row exists
 * (webhook can race the checkout response).
 */

import {
  refreshSubscription,
  subscriptionView,
  activateOrExtend,
  recordPayment,
  forceExpire,
} from '../subscriptions.js';
import { nowIso, findPlan, withTx } from '../db.js';
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

/** Client idempotency keys: printable token, bounded length. */
const IDEM_RE = /^[A-Za-z0-9._:-]{4,128}$/;

/** Internal order reference — external_id while the provider id is unknown. */
function newOrderRef() {
  return `ord:${crypto.randomUUID()}`;
}

const isOrderRef = (externalId) => String(externalId || '').startsWith('ord:');

/** Trims a provider payload to what reconciliation actually needs. */
function providerPayload(object) {
  try {
    return JSON.stringify({
      id: object?.id,
      payment_id: object?.payment_id,
      status: object?.status,
      paid: object?.paid,
      amount: object?.amount,
      captured_at: object?.captured_at,
      created_at: object?.created_at,
    }).slice(0, 4000);
  } catch {
    return '{}';
  }
}

/** Journals a webhook event we can't (yet) attach to a payment row. */
function journalEvent(db, { event, externalId, matchedUserId, applied, payload }) {
  db.prepare(
    `INSERT INTO billing_events
       (provider, event, external_id, telegram_user_id, matched_user_id, applied, payload, created_at)
     VALUES ('yookassa', ?, ?, NULL, ?, ?, ?, ?)`
  ).run(
    event,
    externalId ?? null,
    matchedUserId ?? null,
    applied ? 1 : 0,
    providerPayload(payload),
    nowIso()
  );
}

/**
 * The money half of `payment.succeeded` — conditional ledger transition +
 * subscription grant in one transaction. Returns 'applied' | 'duplicate'
 * | 'invalid-state'.
 */
function applySucceeded(db, payment) {
  return withTx(db, () => {
    // Conditional update: only a still-pending row may transition. A
    // concurrent/duplicate delivery sees changes=0 and grants nothing.
    const r = db
      .prepare(
        `UPDATE payments SET status = 'succeeded'
         WHERE id = ? AND status = 'pending'`
      )
      .run(payment.id);
    if (r.changes === 0) {
      return payment.status === 'pending' ? 'invalid-state' : 'duplicate';
    }
    // §8.3: the paid plan activates; leftover days of the old plan are
    // not recalculated — the new period simply stacks.
    activateOrExtend(db, payment.user_id, payment.days, payment.plan_code);
    return 'applied';
  });
}

/**
 * The money half of a refund (policy, P0.4): the granted period is
 * clawed back — `current_period_end` shrinks by the payment's `days`
 * (never below now → the row expires lazily) and auto-renew stops.
 * Runs in one transaction with the ledger transition.
 */
function applyRefund(db, payment) {
  return withTx(db, () => {
    const r = db
      .prepare(
        `UPDATE payments SET status = 'refunded'
         WHERE id = ? AND status IN ('succeeded','pending')`
      )
      .run(payment.id);
    if (r.changes === 0) return 'duplicate';
    const sub = refreshSubscription(db, payment.user_id);
    if (sub) {
      const end = new Date(sub.current_period_end).getTime();
      const revoked = Math.max(Date.now(), end - payment.days * 86400000);
      db.prepare(
        `UPDATE subscriptions
         SET auto_renew = 0, current_period_end = ? WHERE user_id = ?`
      ).run(new Date(revoked).toISOString(), payment.user_id);
      refreshSubscription(db, payment.user_id); // flips to 'expired' when due
    }
    return 'applied';
  });
}

/** Validates the webhook `object` against our pending order row. */
function verifyPaymentObject(payment, object) {
  if (!object || typeof object !== 'object') return 'missing-object';
  if (object.status !== 'succeeded' || object.paid !== true) {
    return 'unpaid-or-wrong-status';
  }
  // Compare amounts in integer minor units — we stored the expectation
  // at checkout; legacy rows without it skip the check.
  if (payment.amount_minor != null) {
    const gotMinor = Math.round(Number(object?.amount?.value) * 100);
    const gotCurrency = object?.amount?.currency;
    if (gotMinor !== payment.amount_minor || gotCurrency !== payment.currency) {
      return 'amount-mismatch';
    }
  }
  return null;
}

/**
 * Replays journaled `payment.succeeded` events whose external_id now
 * resolves to a real payment row — closes the webhook-arrived-before-
 * checkout-response race.
 */
export function replayUnmatchedYookassa(db) {
  const rows = db
    .prepare(
      `SELECT * FROM billing_events
       WHERE provider = 'yookassa' AND applied = 0 AND matched_user_id IS NULL
         AND event = 'payment.succeeded'
       ORDER BY id LIMIT 100`
    )
    .all();
  for (const ev of rows) {
    const payment = db
      .prepare(
        "SELECT * FROM payments WHERE provider = 'yookassa' AND external_id = ?"
      )
      .get(ev.external_id);
    if (!payment) continue;
    const result = applySucceeded(db, payment);
    if (result === 'applied' || result === 'duplicate') {
      db.prepare(
        'UPDATE billing_events SET applied = 1, matched_user_id = ? WHERE id = ?'
      ).run(payment.user_id, ev.id);
    }
  }
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
   * POST /api/billing/checkout — {plan_code?, idempotency_key?} creates a
   * pending payments row priced from the plans table and asks YooKassa
   * for a hosted checkout page. 501 until YOOKASSA_* is set.
   *
   * Idempotent: the same `idempotency_key` (body or Idempotency-Key
   * header) returns the existing order; a recent identical pending order
   * is reused so a double-click can't mint two payable sessions. The
   * internal `ord:<uuid>` ref doubles as the provider Idempotence-Key —
   * a retry after a mid-flight crash resolves to the same provider
   * payment.
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
    const idemRaw =
      request.body?.idempotency_key || request.headers['idempotency-key'] || '';
    const idemKey = String(idemRaw);
    if (idemKey && !IDEM_RE.test(idemKey)) {
      return reply.code(400).send({ error: 'INVALID_IDEMPOTENCY_KEY' });
    }
    const userId = request.auth.userId;

    // Reuse an existing order for the same idempotency key, or the most
    // recent still-pending order for this user+plan (double-click safe).
    let order = idemKey
      ? db
          .prepare(
            `SELECT * FROM payments
             WHERE provider = 'yookassa' AND user_id = ? AND client_ref = ?`
          )
          .get(userId, idemKey)
      : db
          .prepare(
            `SELECT * FROM payments
             WHERE provider = 'yookassa' AND user_id = ? AND plan_code = ?
               AND status = 'pending' AND created_at > ?
             ORDER BY id DESC LIMIT 1`
          )
          .get(userId, planCode, new Date(Date.now() - 3600_000).toISOString());
    if (order) {
      if (order.checkout_url && !isOrderRef(order.external_id)) {
        // Provider already answered — hand the same session back.
        return {
          payment_id: order.external_id,
          plan_code: order.plan_code,
          checkout_url: order.checkout_url,
          reused: true,
        };
      }
      if (!isOrderRef(order.external_id)) {
        // Finished/failed payment for this key — nothing to reuse.
        return {
          payment_id: order.external_id,
          plan_code: order.plan_code,
          checkout_url: null,
          reused: true,
          status: order.status,
        };
      }
      // ord:* row — provider call crashed or is in flight; retry below
      // with the SAME order ref (provider dedupes on Idempotence-Key).
    } else {
      const orderRef = newOrderRef();
      try {
        const info = db
          .prepare(
            `INSERT INTO payments
               (user_id, provider, external_id, days, status, plan_code,
                client_ref, amount_minor, currency, created_at)
             VALUES (?, 'yookassa', ?, ?, 'pending', ?, ?, ?, ?, ?)`
          )
          .run(
            userId,
            orderRef,
            plan.period_days,
            planCode,
            idemKey || null,
            plan.price_minor,
            plan.currency,
            nowIso()
          );
        order = db
          .prepare('SELECT * FROM payments WHERE id = ?')
          .get(Number(info.lastInsertRowid));
      } catch (err) {
        // UNIQUE(provider, client_ref, user_id) raced — re-read the row.
        if (idemKey) {
          order = db
            .prepare(
              `SELECT * FROM payments
               WHERE provider = 'yookassa' AND user_id = ? AND client_ref = ?`
            )
            .get(userId, idemKey);
          if (order?.checkout_url && !isOrderRef(order.external_id)) {
            return {
              payment_id: order.external_id,
              plan_code: order.plan_code,
              checkout_url: order.checkout_url,
              reused: true,
            };
          }
        }
        if (!order) throw err;
      }
    }

    const amount = {
      value: (plan.price_minor / 100).toFixed(2),
      currency: plan.currency,
    };
    let res, body;
    try {
      res = await fetch('https://api.yookassa.ru/v3/payments', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Basic ${Buffer.from(
            `${config.yookassaShopId}:${config.yookassaSecretKey}`
          ).toString('base64')}`,
          // Stable per order — provider-side dedupe across our retries.
          'idempotence-key': order.external_id,
        },
        body: JSON.stringify({
          amount,
          capture: true,
          confirmation: { type: 'redirect', return_url: 'chlauncher://billing/return' },
          description: `chlauncher ${plan.title} — ${plan.period_days} days`,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      body = await res.json().catch(() => ({}));
    } catch (err) {
      // Network/timeout — the pending row survives; the next retry
      // reuses the same Idempotence-Key so no second provider payment.
      request.log.warn({ err: String(err) }, 'yookassa checkout unreachable');
      return reply.code(502).send({ error: 'PROVIDER_ERROR' });
    }
    if (!res.ok || !body.id) {
      request.log.warn({ status: res.status, body }, 'yookassa checkout failed');
      return reply.code(502).send({ error: 'PROVIDER_ERROR' });
    }
    // Provider ids are unique; if a retry raced us the unique index
    // throws and the winner's row is returned instead.
    const upd = db
      .prepare(
        `UPDATE payments SET external_id = ?, checkout_url = ?, provider_payload = ?
         WHERE id = ? AND external_id = ?`
      )
      .run(
        body.id,
        body.confirmation?.confirmation_url || null,
        providerPayload(body),
        order.id,
        order.external_id
      );
    if (upd.changes === 0) {
      order = db.prepare('SELECT * FROM payments WHERE id = ?').get(order.id);
    } else {
      order.external_id = body.id;
      order.checkout_url = body.confirmation?.confirmation_url || null;
    }
    // A webhook may have beaten the response — replay journaled events.
    replayUnmatchedYookassa(db);
    return {
      payment_id: order.external_id,
      plan_code: planCode,
      checkout_url: order.checkout_url || null,
    };
  });

  /**
   * POST /api/billing/webhook — PUBLIC. YooKassa notification handler:
   * verify → validate the object against our pending order → apply the
   * state transition + grant/revoke in ONE transaction. Unknown payments
   * are journaled and replayed (webhook can beat the checkout response).
   */
  app.post('/webhook', async (request, reply) => {
    if (!config.yookassaShopId) {
      return reply.code(501).send({ error: 'PROVIDER_NOT_CONFIGURED' });
    }
    if (!verifyWebhookAuth(request)) {
      return reply.code(401).send({ error: 'INVALID_SIGNATURE' });
    }

    const { event, object } = request.body || {};
    // refund.succeeded carries the REFUND object — the payment id lives
    // in object.payment_id; every other event keys on object.id.
    const externalId =
      event === 'refund.succeeded' ? object?.payment_id : object?.id;
    if (!event || typeof event !== 'string' || !externalId) {
      return reply.code(400).send({ error: 'INVALID_PAYLOAD' });
    }

    const payment = db
      .prepare("SELECT * FROM payments WHERE provider = 'yookassa' AND external_id = ?")
      .get(externalId);
    if (!payment) {
      // Unknown payment — journal so the reconciler can apply it once
      // the order row exists; acknowledge so the provider stops retrying.
      request.log.warn({ externalId, event }, 'webhook for unknown payment');
      journalEvent(db, {
        event,
        externalId,
        matchedUserId: null,
        applied: false,
        payload: object,
      });
      return { ok: true };
    }

    if (event === 'payment.succeeded') {
      const invalid = verifyPaymentObject(payment, object);
      if (invalid) {
        request.log.warn(
          { externalId, invalid },
          'webhook object failed validation — not granting'
        );
        journalEvent(db, {
          event: `rejected:${invalid}`,
          externalId,
          matchedUserId: payment.user_id,
          applied: false,
          payload: object,
        });
        return { ok: true };
      }
      const result = applySucceeded(db, payment);
      db.prepare(
        'UPDATE payments SET provider_payload = ? WHERE id = ?'
      ).run(providerPayload(object), payment.id);
      journalEvent(db, {
        event,
        externalId,
        matchedUserId: payment.user_id,
        applied: result === 'applied',
        payload: object,
      });
    } else if (event === 'payment.canceled') {
      withTx(db, () => {
        const r = db
          .prepare(
            `UPDATE payments SET status = 'failed'
             WHERE id = ? AND status = 'pending'`
          )
          .run(payment.id);
        if (r.changes === 0 && payment.status === 'succeeded') {
          // Late cancel after grant — chargeback-shaped; needs manual
          // review, never silently revokes or re-grants.
          journalEvent(db, {
            event: 'late_cancel',
            externalId,
            matchedUserId: payment.user_id,
            applied: false,
            payload: object,
          });
        }
      });
    } else if (event === 'refund.succeeded') {
      const refundedMinor = Math.round(Number(object?.amount?.value) * 100);
      const fullRefund =
        payment.amount_minor == null || refundedMinor >= payment.amount_minor;
      const result = applyRefund(db, payment);
      journalEvent(db, {
        event: fullRefund ? event : 'partial_refund',
        externalId,
        matchedUserId: payment.user_id,
        applied: result === 'applied',
        payload: object,
      });
    } else {
      // waiting_for_capture, refund updates etc. — acknowledge.
      request.log.info({ event, externalId }, 'ignoring yookassa event');
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
