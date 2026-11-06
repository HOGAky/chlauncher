/**
 * @file no-mock.test.js
 * Verifies §5.5: with ENABLE_MOCK_BILLING unset and NODE_ENV=production the
 * mock billing endpoints are not registered at all (404, not just denied).
 * Needs its own file because the flag is read once at module load.
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';

delete process.env.ENABLE_MOCK_BILLING;
process.env.NODE_ENV = 'production';

let app;

before(async () => {
  const { buildApp } = await import('../src/app.js');
  ({ app } = await buildApp({ databasePath: ':memory:' }));
});

test('mock-pay/mock-expire return 404 when mocks are disabled', async () => {
  const reg = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email: 'u@x.com', password: 'secret123', hwid: 'H1' },
  });
  const headers = { authorization: `Bearer ${reg.json().token}` };
  for (const url of ['/api/billing/mock-pay', '/api/billing/mock-expire']) {
    const res = await app.inject({ method: 'POST', url, headers });
    assert.equal(res.statusCode, 404, `${url} should be unregistered`);
  }
});

test('checkout is 501 PROVIDER_NOT_CONFIGURED without creds', async () => {
  const reg = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email: 'u2@x.com', password: 'secret123', hwid: 'H2' },
  });
  const res = await app.inject({
    method: 'POST',
    url: '/api/billing/checkout',
    headers: { authorization: `Bearer ${reg.json().token}` },
  });
  assert.equal(res.statusCode, 501);
  assert.equal(res.json().error, 'PROVIDER_NOT_CONFIGURED');
});
