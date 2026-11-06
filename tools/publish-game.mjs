#!/usr/bin/env node
/**
 * @file publish-game.mjs
 * CLI fallback for publishing game builds without the launcher (spec §8):
 *
 *   node tools/publish-game.mjs \
 *     --server http://127.0.0.1:8787 \
 *     --email admin@example.com --password secret \
 *     --slug my-game --version 1.2.0 \
 *     --zip ./dist/my-game.zip --changelog "bugfixes" --publish
 *
 * Flow: login → POST /api/admin/games/:slug/builds (octet-stream) →
 * optionally POST .../publish. Intended for release pipelines
 * (`cargo build --release` → zip → publish).
 *
 * HWID note: login requires an HWID like the launcher sends. The CLI uses a
 * stable `cli-<host/user hash>` by default; if the admin account is bound to
 * a different HWID (e.g. the launcher's), pass `--hwid <value>` or unbind
 * via the admin panel first.
 */

import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { createHash } from 'node:crypto';
import { hostname, userInfo } from 'node:os';

const args = parseArgs(process.argv.slice(2));
const need = (k) => {
  if (!args[k]) {
    console.error(`missing --${k}`);
    process.exit(1);
  }
  return args[k];
};

const server = (args.server || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const email = need('email');
const password = need('password');
const slug = need('slug');
const version = need('version');
const zipPath = need('zip');
const changelog = args.changelog || '';
const doPublish = !!args.publish;
const hwid =
  args.hwid ||
  'cli-' +
    createHash('sha256')
      .update(`${hostname()}:${userInfo().username}`)
      .digest('hex')
      .slice(0, 24);

// ---------------------------------------------------------------- login
const login = await fetch(`${server}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email, password, hwid }),
}).then((r) => r.json());
if (login.error) {
  if (login.error === 'HWID_MISMATCH') {
    console.error(
      'HWID_MISMATCH: account is bound to another device. ' +
        'Pass --hwid <bound value> or unbind via the admin panel.'
    );
  } else {
    console.error(`login failed: ${login.error}`);
  }
  process.exit(1);
}
if (login.user?.role !== 'admin') {
  console.error(`logged in as '${login.user?.role}' — admin required (grant via tools/grant-admin.mjs)`);
  process.exit(1);
}
const token = login.token;
console.log(`logged in as ${email} (admin)`);

// ---------------------------------------------------------------- upload
const zip = await readFile(zipPath);
const qs = new URLSearchParams({ version, changelog });
const up = await fetch(`${server}/api/admin/games/${encodeURIComponent(slug)}/builds?${qs}`, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${token}`,
    'content-type': 'application/octet-stream',
  },
  body: zip,
}).then((r) => r.json());
if (up.error) {
  console.error(`upload failed: ${up.error}`);
  process.exit(1);
}
console.log(
  `uploaded ${basename(zipPath)} → ${slug}@${version} ` +
    `(${up.build.size_bytes} bytes, sha256 ${up.build.sha256.slice(0, 16)}…)`
);

// ---------------------------------------------------------------- publish
if (doPublish) {
  const pub = await fetch(
    `${server}/api/admin/games/${encodeURIComponent(slug)}/publish`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ version }),
    }
  ).then((r) => r.json());
  if (pub.error) {
    console.error(`publish failed: ${pub.error}`);
    process.exit(1);
  }
  console.log(`published ${slug}@${version} — clients will see it within 10 min`);
} else {
  console.log(`build stored (not published). Re-run with --publish or publish via the admin panel.`);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        out[key] = argv[++i];
      } else {
        out[key] = true;
      }
    }
  }
  return out;
}
