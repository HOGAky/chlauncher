/**
 * @file errorMessages.test.ts
 * Unit tests for the unified error contract parser/mapper (Task 4).
 * Runs on plain `node --test` — no vitest needed (Node ≥22.6 strips types).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseError, humanError, ERROR_MESSAGES } from './errorMessages.ts';

test('plain machine code parses', () => {
  const p = parseError('HWID_MISMATCH');
  assert.equal(p.code, 'HWID_MISMATCH');
  assert.equal(p.requestId, null);
});

test('code with request id and detail parses', () => {
  const p = parseError('HASH_MISMATCH|req=abc-123|expected aaa, got bbb');
  assert.equal(p.code, 'HASH_MISMATCH');
  assert.equal(p.requestId, 'abc-123');
  assert.equal(p.detail, 'expected aaa, got bbb');
});

test('legacy "CODE: detail" strings keep the code', () => {
  const p = parseError('INVALID_SLUG: bad slug ..');
  assert.equal(p.code, 'INVALID_SLUG');
});

test('arbitrary JS error messages collapse to INTERNAL_ERROR', () => {
  const p = parseError('Cannot read properties of undefined (reading x)');
  assert.equal(p.code, 'INTERNAL_ERROR');
});

test('non-string errors handled', () => {
  assert.equal(parseError(null).code, 'INTERNAL_ERROR');
  assert.equal(parseError(new Error('boom')).code, 'INTERNAL_ERROR');
});

test('every known code has a Russian message', () => {
  for (const code of [
    'NETWORK_ERROR', 'SERVER_UNAVAILABLE', 'UNAUTHORIZED', 'SESSION_EXPIRED',
    'INVALID_CREDENTIALS', 'EMAIL_TAKEN', 'HWID_MISMATCH', 'HWID_RESET_COOLDOWN',
    'SUBSCRIPTION_REQUIRED', 'GAME_NOT_FOUND', 'BUILD_NOT_UPLOADED',
    'HASH_MISMATCH', 'DOWNLOAD_FAILED', 'INSTALL_FAILED', 'LAUNCH_FAILED',
    'GAME_ALREADY_RUNNING', 'GAME_NOT_RUNNING', 'TOO_MANY_ATTEMPTS',
    'INTERNAL_ERROR',
  ]) {
    assert.ok(ERROR_MESSAGES[code], `missing message for ${code}`);
  }
});

test('humanError returns message, never the raw code', () => {
  const msg = humanError('EMAIL_TAKEN');
  assert.match(msg, /уже зарегистрирован/i);
  assert.ok(!msg.includes('EMAIL_TAKEN'));
});

test('humanError appends request id when requested', () => {
  const msg = humanError('INTERNAL_ERROR|req=req-42', { withRequestId: true });
  assert.ok(msg.includes('req-42'), msg);
});
