/**
 * @file production.test.js
 * Production-hardening checks (Task 1):
 *  - production without a real JWT_SECRET refuses to start;
 *  - production with ENABLE_MOCK_BILLING=1 refuses to start;
 *  - CORS answers only whitelisted origins;
 *  - ADMIN_EMAILS is ignored in production (no auto-promotion);
 *  - trustProxy defaults to false.
 *
 * `loadConfig`/`validateProductionConfig` are pure — production scenarios
 * are exercised by passing an env map, no process restart needed.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

const { loadConfig, validateProductionConfig, DEV_JWT_SECRET } =
  await import('../src/config.js');
const { buildApp } = await import('../src/app.js');

const PROD_ENV = {
  NODE_ENV: 'production',
  JWT_SECRET: 'a'.repeat(64),
};

test('production without JWT_SECRET refuses to start', () => {
  const cfg = loadConfig({ ...PROD_ENV, JWT_SECRET: '' });
  assert.throws(() => validateProductionConfig(cfg), /JWT_SECRET/);
});

test('production with the dev JWT secret refuses to start', () => {
  const cfg = loadConfig({ ...PROD_ENV, JWT_SECRET: DEV_JWT_SECRET });
  assert.throws(() => validateProductionConfig(cfg), /JWT_SECRET/);
});

test('production with ENABLE_MOCK_BILLING=1 refuses to start', () => {
  const cfg = loadConfig({ ...PROD_ENV, ENABLE_MOCK_BILLING: '1' });
  assert.throws(() => validateProductionConfig(cfg), /MOCK_BILLING/);
});

test('dev mode passes validation with defaults', () => {
  const cfg = loadConfig({ NODE_ENV: 'development' });
  assert.equal(cfg.isProduction, false);
  assert.doesNotThrow(() => validateProductionConfig(cfg));
});

test('ADMIN_EMAILS is ignored in production', () => {
  const dev = loadConfig({
    NODE_ENV: 'development',
    ADMIN_EMAILS: 'boss@x.com, other@x.com ',
  });
  assert.deepEqual([...dev.adminEmails].sort(), ['boss@x.com', 'other@x.com']);

  const prod = loadConfig({ ...PROD_ENV, ADMIN_EMAILS: 'boss@x.com' });
  assert.equal(prod.adminEmails.size, 0);
});

test('trustProxy defaults to false, TRUST_PROXY=true enables it', () => {
  assert.equal(loadConfig({ NODE_ENV: 'test' }).trustProxy, false);
  assert.equal(
    loadConfig({ NODE_ENV: 'test', TRUST_PROXY: 'true' }).trustProxy,
    true
  );
});

test('dev CORS whitelist defaults to local webview origins', () => {
  const cfg = loadConfig({ NODE_ENV: 'development' });
  assert.ok(cfg.corsOrigins.includes('http://localhost:1420'));
  assert.ok(cfg.corsOrigins.includes('http://127.0.0.1:1420'));
});

// ------------------------------------------------------------------ CORS

describe('CORS whitelist', () => {
  let app;
  before(async () => {
    ({ app } = await buildApp({
      corsOrigins: ['https://launcher.example.com'],
    }));
    await app.ready();
  });
  after(() => app.close());

  test('whitelisted origin gets CORS headers', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { origin: 'https://launcher.example.com' },
    });
    assert.equal(
      res.headers['access-control-allow-origin'],
      'https://launcher.example.com'
    );
  });

  test('foreign origin gets no CORS headers', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { origin: 'https://evil.example.com' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['access-control-allow-origin'], undefined);
  });

  test('no Origin header → request still answered (non-browser clients)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().ok, true);
  });
});
