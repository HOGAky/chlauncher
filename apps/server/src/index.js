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

const { app, db } = await buildApp({
  databasePath: config.databasePath,
  logger: true,
});

startExpirySweeper(db);

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(`licensing server ready on http://${config.host}:${config.port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
