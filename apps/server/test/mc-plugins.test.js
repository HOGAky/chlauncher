/**
 * @file mc-plugins.test.js
 * Minecraft plugin catalog tests (parity spec §9.4): admin CRUD + jar
 * upload (sha256 computed server-side), public catalog listing, premium
 * download gating behind `mc_premium_plugins`, path-safety.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.ADMIN_EMAILS = 'admin@example.com';
process.env.ENABLE_MOCK_BILLING = '1';
// Plugin jars must not land in the repo's real static dir.
const staticTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-static-'));
process.env.STATIC_DIR = staticTmp;

let app;
let db;
let adminToken;

const auth = (token) => ({ authorization: `Bearer ${token}` });

async function register(email) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password: 'secret123', hwid: `HW-${email}` },
  });
  return res.json();
}

async function mockPay(token, planCode) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/billing/mock-pay',
    headers: auth(token),
    payload: { plan_code: planCode },
  });
  return { status: res.statusCode, body: res.json() };
}

/** A minimal jar — zips start with PK\x03\x04; the bytes don't matter
 *  beyond the magic check and the sha256 contract. */
const FAKE_JAR = Buffer.from('PK\x03\x04-fake-plugin-bytes');

async function createPlugin(slug, { premium = false, upload = true } = {}) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/admin/mc-plugins',
    headers: auth(adminToken),
    payload: { slug, name: `Plugin ${slug}`, version: '1.0.0', premium },
  });
  assert.equal(res.statusCode, 201, res.body);
  if (!upload) return res.json().plugin;
  const up = await app.inject({
    method: 'POST',
    url: `/api/admin/mc-plugins/${slug}/file`,
    headers: { ...auth(adminToken), 'content-type': 'application/octet-stream' },
    payload: FAKE_JAR,
  });
  assert.equal(up.statusCode, 201, up.body);
  return up.json().plugin;
}

before(async () => {
  const { buildApp } = await import('../src/app.js');
  ({ app, db } = await buildApp({ databasePath: ':memory:' }));
  adminToken = (await register('admin@example.com')).token;
});

after(() => {
  fs.rmSync(staticTmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------- admin

test('admin creates + uploads a plugin; sha256 is server-computed', async () => {
  const plugin = await createPlugin('ch-survival');
  assert.equal(plugin.slug, 'ch-survival');
  assert.equal(plugin.premium, false);
  assert.match(plugin.sha256, /^[0-9a-f]{64}$/);
  assert.equal(plugin.size_bytes, FAKE_JAR.length);
  const file = path.join(staticTmp, 'plugins', plugin.file_name);
  assert.ok(fs.existsSync(file));
});

test('admin catalog lists drafts and inactive rows', async () => {
  await createPlugin('draft-no-file', { upload: false });
  const res = await app.inject({
    method: 'GET',
    url: '/api/admin/mc-plugins',
    headers: auth(adminToken),
  });
  const slugs = res.json().plugins.map((p) => p.slug);
  assert.ok(slugs.includes('draft-no-file'));
});

test('non-admin cannot create plugins', async () => {
  const { token } = await register('user1@example.com');
  const res = await app.inject({
    method: 'POST',
    url: '/api/admin/mc-plugins',
    headers: auth(token),
    payload: { slug: 'hax', name: 'x', version: '1' },
  });
  assert.equal(res.statusCode, 403);
});

test('jar upload rejects non-PK payloads', async () => {
  await createPlugin('not-a-jar', { upload: false });
  const res = await app.inject({
    method: 'POST',
    url: '/api/admin/mc-plugins/not-a-jar/file',
    headers: { ...auth(adminToken), 'content-type': 'application/octet-stream' },
    payload: Buffer.from('definitely not a jar'),
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'NOT_A_JAR');
});

// ------------------------------------------------------------- catalog

test('public catalog hides file-less drafts and shows sha256', async () => {
  const { token } = await register('viewer@example.com');
  const res = await app.inject({
    method: 'GET',
    url: '/api/mc/plugins',
    headers: auth(token),
  });
  assert.equal(res.statusCode, 200);
  const slugs = res.json().plugins.map((p) => p.slug);
  assert.ok(slugs.includes('ch-survival'));
  assert.ok(!slugs.includes('draft-no-file')); // no jar uploaded yet
  const p = res.json().plugins.find((x) => x.slug === 'ch-survival');
  assert.match(p.sha256, /^[0-9a-f]{64}$/);
});

test('catalog requires auth', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/mc/plugins' });
  assert.equal(res.statusCode, 401);
});

// ------------------------------------------------------------ download

test('free plugin downloads for any authenticated user', async () => {
  const { token } = await register('dl@example.com');
  const res = await app.inject({
    method: 'GET',
    url: '/api/mc/plugins/ch-survival/download',
    headers: auth(token),
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.rawPayload, FAKE_JAR);
});

test('premium plugin is gated by mc_premium_plugins', async () => {
  await createPlugin('vip-koth', { premium: true });

  const free = await register('free-user@example.com');
  let res = await app.inject({
    method: 'GET',
    url: '/api/mc/plugins/vip-koth/download',
    headers: auth(free.token),
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'PLAN_LIMIT:mc_premium_plugins');

  const pro = await register('pro-user@example.com');
  await mockPay(pro.token, 'pro');
  res = await app.inject({
    method: 'GET',
    url: '/api/mc/plugins/vip-koth/download',
    headers: auth(pro.token),
  });
  assert.equal(res.statusCode, 403); // pro lacks mc_premium_plugins

  const expert = await register('expert-user@example.com');
  await mockPay(expert.token, 'expert');
  res = await app.inject({
    method: 'GET',
    url: '/api/mc/plugins/vip-koth/download',
    headers: auth(expert.token),
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.rawPayload, FAKE_JAR);
});

test('unknown plugin slug 404s', async () => {
  const { token } = await register('dl2@example.com');
  const res = await app.inject({
    method: 'GET',
    url: '/api/mc/plugins/nope/download',
    headers: auth(token),
  });
  assert.equal(res.statusCode, 404);
});

// -------------------------------------------------------------- audit

test('plugin mutations are audited', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/admin/audit',
    headers: auth(adminToken),
  });
  const actions = res.json().entries.map((e) => e.action);
  assert.ok(actions.includes('create_mc_plugin'));
  assert.ok(actions.includes('upload_mc_plugin'));
});
