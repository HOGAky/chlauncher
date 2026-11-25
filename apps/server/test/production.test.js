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
  HWID_HASH_SECRET: 'b'.repeat(64),
  OWNER_TG_IDS: '123456',
  PUBLIC_BASE_URL: 'https://api.example.com',
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

test('a minimal sane production env passes validation', () => {
  const cfg = loadConfig(PROD_ENV);
  assert.doesNotThrow(() => validateProductionConfig(cfg));
});

test('compiled-in owner keeps the production owner gate populated', () => {
  // The developer's Telegram id is baked into loadConfig — an empty
  // OWNER_TG_IDS env can no longer leave the owner set empty (P0.3).
  const cfg = loadConfig({ ...PROD_ENV, OWNER_TG_IDS: '' });
  assert.ok(cfg.ownerTgIds.has(1189459943));
  assert.doesNotThrow(() => validateProductionConfig(cfg));
});

test('production rejects BILLING_WEBHOOK_SKIP_IP_CHECK', () => {
  const cfg = loadConfig({ ...PROD_ENV, BILLING_WEBHOOK_SKIP_IP_CHECK: '1' });
  assert.throws(
    () => validateProductionConfig(cfg),
    /BILLING_WEBHOOK_SKIP_IP_CHECK/
  );
});

test('production rejects a public bind without ALLOW_PUBLIC_BIND', () => {
  const cfg = loadConfig({ ...PROD_ENV, SERVER_HOST: '0.0.0.0' });
  assert.throws(() => validateProductionConfig(cfg), /ALLOW_PUBLIC_BIND/);
  const allowed = loadConfig({
    ...PROD_ENV,
    SERVER_HOST: '0.0.0.0',
    ALLOW_PUBLIC_BIND: '1',
  });
  assert.doesNotThrow(() => validateProductionConfig(allowed));
});

test('production requires an https PUBLIC_BASE_URL', () => {
  const cfg = loadConfig({ ...PROD_ENV, PUBLIC_BASE_URL: 'http://x.test' });
  assert.throws(() => validateProductionConfig(cfg), /PUBLIC_BASE_URL/);
});

test('relative DATABASE_PATH anchors to the server root, not cwd', () => {
  const cfg = loadConfig({ ...PROD_ENV, DATABASE_PATH: 'data/test.db' });
  assert.match(cfg.databasePath, /apps[\\/]server[\\/]data[\\/]test\.db$/);
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

test('trustProxy defaults to false; TRUST_PROXY=true trusts only listed hops', () => {
  assert.equal(loadConfig({ NODE_ENV: 'test' }).trustProxy, false);
  const trust = loadConfig({
    NODE_ENV: 'test',
    TRUST_PROXY: 'true',
    TRUSTED_PROXY_CIDRS: '10.0.0.0/8, 172.16.0.0/12',
  }).trustProxy;
  assert.ok(Array.isArray(trust));
  assert.ok(trust.includes('127.0.0.1'));
  assert.ok(trust.includes('10.0.0.0/8'));
  assert.ok(trust.includes('172.16.0.0/12'));
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

// ------------------------------------------------------------- readiness

describe('readiness probe (§P0.8)', () => {
  let app;
  before(async () => {
    ({ app } = await buildApp({}));
    await app.ready();
  });
  after(() => app.close());

  test('/api/ready reports 200 with per-dependency checks, no secrets', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/ready' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, true);
    assert.equal(body.checks.db, 'ok');
    assert.equal(body.checks.static, 'ok');
    // Nothing that leaks paths, config or schema details.
    assert.deepEqual(Object.keys(body), ['ok', 'checks']);
  });
});
