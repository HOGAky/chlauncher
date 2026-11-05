/**
 * @file routes/billing.js
 * Billing endpoints: subscription status + payment entry points.
 *
 * Real provider webhooks (Stripe / YooKassa) are stubbed in
 * `POST /api/billing/webhook` — wire the signing-secret verification there.
 * For development and end-to-end testing the server exposes two mock
 * endpoints:
 *   POST /api/billing/mock-pay     → grant/extend a 30-day period
 *   POST /api/billing/mock-expire  → force the subscription into 'expired'
 */

import { refreshSubscription, subscriptionView, activateOrExtend, forceExpire } from '../subscriptions.js';

/**
 * @param {import('fastify').FastifyInstance} app
 * @param {{db: import('node:sqlite').DatabaseSync, authenticate: Function}} opts
 */
export default async function billingRoutes(app, { db, authenticate }) {
  /**
   * GET /api/billing/subscription — current subscription (lazy-expired).
   */
  app.get(
    '/subscription',
    { preHandler: authenticate },
    async (request) => {
      const sub = refreshSubscription(db, request.auth.userId);
      return { subscription: subscriptionView(sub) };
    }
  );

  /**
   * POST /api/billing/mock-pay — TEST ONLY.
   * Simulates a successful one-month payment: activates or extends the
   * subscription by 30 days. Replace with a real checkout flow later.
   */
  app.post('/mock-pay', { preHandler: authenticate }, async (request) => {
    const sub = activateOrExtend(db, request.auth.userId);
    request.log.info({ userId: request.auth.userId }, 'mock payment applied');
    return { ok: true, subscription: subscriptionView(sub) };
  });

  /**
   * POST /api/billing/mock-expire — TEST ONLY.
   * Force-expires the subscription so lockout behaviour can be tested
   * without waiting 30 days.
   */
  app.post('/mock-expire', { preHandler: authenticate }, async (request) => {
    forceExpire(db, request.auth.userId);
    const sub = refreshSubscription(db, request.auth.userId);
    return { ok: true, subscription: subscriptionView(sub) };
  });

  /**
   * POST /api/billing/webhook — production entry point for payment
   * providers. Currently returns 501 until STRIPE_WEBHOOK_SECRET /
   * YOOKASSA_* credentials are configured (see .env.example).
   */
  app.post('/webhook', async (request, reply) => {
    request.log.warn('billing webhook hit but no provider configured');
    return reply.code(501).send({
      error: 'NOT_CONFIGURED',
      hint: 'Configure STRIPE_WEBHOOK_SECRET or YOOKASSA_* env vars and implement signature verification here.',
    });
  });
}
