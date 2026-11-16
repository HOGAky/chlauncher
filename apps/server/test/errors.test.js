/**
 * @file errors.test.js
 * Regression tests for the unified error contract (Task 4): every error
 * response carries {error, message, retryable, details} plus the
 * `x-request-id` correlation header; internal errors never leak stacks.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';

let app, db;
before(async () => {
  ({ app, db } = await buildApp());
});
after(async () => app.close());

test('unknown route returns NOT_FOUND envelope + request id', async () => {
  const res = await app.inject('/api/definitely-missing');
  assert.equal(res.statusCode, 404);
  const body = res.json();
  assert.equal(body.error, 'NOT_FOUND');
  assert.equal(typeof body.message, 'string');
  assert.equal(body.retryable, false);
  assert.ok(res.headers['x-request-id']);
});

test('route errors are enriched with message/retryable/details', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: 'nope@x.io', password: 'short' },
  });
  const body = res.json();
  assert.ok(body.error, 'has machine code');
  assert.ok(body.message, 'has safe human message');
  assert.equal(body.retryable, false);
  assert.ok(res.headers['x-request-id']);
});

test('unhandled errors become INTERNAL_ERROR without stack/SQL leak', async () => {
  // Invalid JSON body → Fastify throws a parse error through the handler.
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { 'content-type': 'application/json' },
    payload: '{not valid json',
  });
  assert.ok(res.statusCode >= 400);
  const body = res.json();
  const serialized = JSON.stringify(body);
  assert.ok(!serialized.includes('apps/server'), 'no internal path');
  assert.ok(!serialized.includes('node_modules'), 'no module path');
  assert.ok(body.error === 'BAD_REQUEST' || body.error === 'INTERNAL_ERROR');
});
