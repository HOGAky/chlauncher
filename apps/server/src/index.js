/**
 * @file index.js
 * Production entry point for the licensing backend.
 *
 * Boots the Fastify app on the configured host/port and starts the hourly
 * subscription-expiry sweeper. Graceful shutdown is handled by Fastify's
 * own signal handling (the `onClose` hook closes the database).
 */

import { buildApp } from './app.js';
import { config } from './config.js';
import { startExpirySweeper } from './subscriptions.js';
import { sweepUploadTemps } from './build_store.js';

const { app, db } = await buildApp({
  databasePath: config.databasePath,
  logger: true,
});

startExpirySweeper(db);
sweepUploadTemps();

// Graceful shutdown: stop accepting new requests, drain in-flight ones
// (payments/uploads finish or the client retries), then close SQLite.
let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, 'shutting down');
  try {
    await app.close(); // onClose hook closes the db
    process.exit(0);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(`licensing server ready on http://${config.host}:${config.port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
