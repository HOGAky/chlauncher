/**
 * @file helpers.js
 * Shared test helpers. Owner-gated admin routes (grant-days, set-role,
 * set-plan, plan CRUD, promo) require the caller's account to be bound
 * to a Telegram id listed in config.ownerTgIds — the compiled-in
 * developer id keeps that set non-empty even in tests, so test admins
 * must bind explicitly.
 */

import { config } from '../src/config.js';

let nextOwnerTgId = 880000001;

/**
 * Promotes a user to an owner: binds a unique Telegram id and registers
 * it in config.ownerTgIds for the duration of the test process.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} userId
 */
export function bindOwner(db, userId) {
  const tgId = nextOwnerTgId++;
  config.ownerTgIds.add(tgId);
  db.prepare(
    `INSERT INTO tg_bindings (user_id, telegram_user_id, telegram_username, bound_at)
     VALUES (?, ?, 'owner', ?)`
  ).run(userId, tgId, new Date().toISOString());
  return tgId;
}
