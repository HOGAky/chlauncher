/**
 * @file subscriptions.js
 * Subscription domain logic — the heart of the 30-day billing model.
 *
 * Rules implemented here:
 *  - A paid period lasts exactly 30 days. Paying while still active extends
 *    from the current `current_period_end` (stacking), paying while expired
 *    starts a fresh 30-day window from now.
 *  - Expiry is enforced lazily: every read path calls `refreshSubscription`
 *    which flips `active` -> `expired` the moment `current_period_end` passes.
 *    A coarse hourly sweep (`startExpirySweeper`) covers idle users so stale
 *    rows never linger between requests.
 */

import {
  findSubscription,
  updateSubscription,
  nowIso,
  isoInDays,
} from './db.js';

const SUBSCRIPTION_DAYS = 30;

/**
 * Lazily expires a subscription whose paid period has elapsed, then returns
 * the up-to-date row. Call this on EVERY read path that cares about status.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} userId
 * @returns {object|undefined} fresh subscription row
 */
export function refreshSubscription(db, userId) {
  const sub = findSubscription(db, userId);
  if (!sub) return undefined;
  if (sub.status === 'active' && sub.current_period_end <= nowIso()) {
    updateSubscription(db, userId, 'expired', sub.current_period_end);
    return findSubscription(db, userId);
  }
  return sub;
}

/**
 * Returns a public view of a subscription row for API responses.
 * @param {object|undefined} sub
 */
export function subscriptionView(sub) {
  if (!sub) return { status: 'expired', current_period_end: null };
  const active = sub.status === 'active';
  const daysLeft = active
    ? Math.max(
        0,
        Math.ceil(
          (new Date(sub.current_period_end) - Date.now()) / 86400000
        )
      )
    : 0;
  return {
    status: sub.status,
    current_period_end: sub.current_period_end,
    auto_renew: !!sub.auto_renew,
    days_left: daysLeft,
    plan_code: sub.plan_code || 'pro',
  };
}

/**
 * Activates or extends the subscription by `days` days (one billing period
 * by default). Stacks onto remaining time when already active.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} userId
 * @param {number} [days]
 * @param {string|null} [planCode] — when given, switches the plan code
 *   (spec §8.3: the new plan applies immediately, leftover days on the
 *   old plan are NOT recalculated — days simply stack).
 * @returns {object} updated subscription row
 */
export function activateOrExtend(db, userId, days = SUBSCRIPTION_DAYS, planCode = null) {
  const sub = refreshSubscription(db, userId);
  const base =
    sub && sub.status === 'active' && sub.current_period_end > nowIso()
      ? new Date(sub.current_period_end)
      : new Date();
  const newEnd = isoInDays(days, base);
  updateSubscription(db, userId, 'active', newEnd);
  if (planCode) {
    db.prepare('UPDATE subscriptions SET plan_code = ? WHERE user_id = ?').run(
      planCode,
      userId
    );
  }
  return findSubscription(db, userId);
}

/**
 * Records one payment/grant in the `payments` ledger and extends the
 * subscription by `days`. Shared by provider webhooks and the admin
 * grant-days action (spec §5.1).
 *
 * Idempotent on `(provider, externalId)`: a duplicate insert is ignored and
 * NO extra days are granted — safe for webhook retries. Pass a NULL
 * externalId for one-off manual grants (NULLs never conflict in SQLite).
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{userId:number, provider:string, externalId?:string|null,
 *          days:number, actorId?:number|null}} p
 * @returns {{applied: boolean, subscription: object}} — `applied` is false
 *          when the payment row already existed (duplicate webhook).
 */
export function recordPayment(
  db,
  { userId, provider, externalId = null, days = SUBSCRIPTION_DAYS, actorId = null, planCode = null }
) {
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO payments
         (user_id, provider, external_id, days, status, actor_id, plan_code, created_at)
       VALUES (?,?,?,?, 'succeeded', ?, ?, ?)`
    )
    .run(userId, provider, externalId, days, actorId, planCode, nowIso());
  if (info.changes === 0) {
    return { applied: false, subscription: refreshSubscription(db, userId) };
  }
  const subscription = activateOrExtend(db, userId, days, planCode);
  return { applied: true, subscription };
}

/**
 * Force-expires a subscription (mock endpoint for testing lockout).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} userId
 */
export function forceExpire(db, userId) {
  updateSubscription(db, userId, 'expired', new Date(0).toISOString());
}

/**
 * Whether the user's subscription currently permits launching games.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} userId
 * @returns {boolean}
 */
export function hasActiveSubscription(db, userId) {
  const sub = refreshSubscription(db, userId);
  return !!sub && sub.status === 'active';
}

/**
 * Hourly background sweep that lazily expires any overdue subscriptions —
 * the "cron job" half of the expiry story. Returns the interval handle so
 * tests can clear it.
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function startExpirySweeper(db) {
  return setInterval(() => {
    db.prepare(
      `UPDATE subscriptions SET status = 'expired'
       WHERE status = 'active' AND current_period_end <= ?`
    ).run(nowIso());
  }, 60 * 60 * 1000).unref();
}
