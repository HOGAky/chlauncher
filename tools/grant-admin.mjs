#!/usr/bin/env node
/**
 * @file grant-admin.mjs
 * Point-grants the admin role to an existing account without restarting the
 * server (SQLite WAL allows a concurrent writer):
 *
 *   node tools/grant-admin.mjs <email> [user|admin|publisher]
 *
 * Opens the database through the server's own `openDatabase`, so pending
 * schema migrations run first (an unmigrated v1 DB has no `role` column).
 * The role is written straight into `users.role`; the next admin request
 * picks it up because the server always re-reads the role from the DB.
 * Respects DATABASE_PATH / apps/server/.env like the server itself.
 */

import { openDatabase } from '../apps/server/src/db.js';
import { config } from '../apps/server/src/config.js';

const [email, role = 'admin'] = process.argv.slice(2);
if (!email || !['user', 'admin', 'publisher'].includes(role)) {
  console.error('usage: node tools/grant-admin.mjs <email> [user|admin|publisher]');
  process.exit(1);
}

const db = openDatabase(config.databasePath);
try {
  const user = db
    .prepare('SELECT id, email, role FROM users WHERE email = ?')
    .get(email);
  if (!user) {
    console.error(`no user with email ${email}`);
    process.exit(1);
  }
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, user.id);
  console.log(`${user.email}: ${user.role} -> ${role}`);
} finally {
  db.close();
}
