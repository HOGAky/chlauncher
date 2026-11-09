#!/usr/bin/env node
/**
 * @file publisher.mjs
 * Publisher self-service CLI — the full game-shipping cycle without the
 * launcher. The caller must hold role='publisher' or 'admin'.
 *
 *   node tools/publisher.mjs create --slug my-game --title "My Game" --exe game.exe \
 *        [--description "..."] --email dev@x.com --password ***
 *   node tools/publisher.mjs upload --slug my-game --version 1.0.0 \
 *        --zip ./dist/my-game.zip [--changelog "..."] --email ... --password ...
 *   node tools/publisher.mjs submit --slug my-game --version 1.0.0 --email ... --password ...
 *   node tools/publisher.mjs cancel --submission 7 --email ... --password ...
 *   node tools/publisher.mjs list --email ... --password ...
 *
 * Options common to all commands: --server (default http://127.0.0.1:8787),
 * --email, --password, --hwid (stable cli-<hash> by default).
 *
 * Review flow: `submit` queues the build for an admin; approval publishes
 * it to the catalog, rejection returns `feedback` (visible via `list`).
 */

import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { createHash } from 'node:crypto';
import { hostname, userInfo } from 'node:os';

const [command, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);
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
const hwid =
  args.hwid ||
  'cli-' +
    createHash('sha256')
      .update(`${hostname()}:${userInfo().username}`)
      .digest('hex')
      .slice(0, 24);

if (!['create', 'upload', 'submit', 'cancel', 'list'].includes(command)) {
  console.error('usage: publisher.mjs <create|upload|submit|cancel|list> [options]');
  process.exit(1);
}

// ---------------------------------------------------------------- login
const login = await api('POST', '/api/auth/login', {
  body: { email, password, hwid },
});
if (login.error) {
  if (login.error === 'HWID_MISMATCH') {
    console.error('HWID_MISMATCH: pass --hwid <bound value> or unbind first.');
  } else {
    console.error(`login failed: ${login.error}`);
  }
  process.exit(1);
}
if (!['publisher', 'admin'].includes(login.user?.role)) {
  console.error(
    `role '${login.user?.role}' has no publisher access — ` +
      'ask an admin to run POST /api/admin/users/:id/set-role {role:"publisher"}'
  );
  process.exit(1);
}
const token = login.token;

// ------------------------------------------------------------- commands
if (command === 'create') {
  const res = await api('POST', '/api/publisher/games', {
    body: {
      slug: need('slug'),
      title: need('title'),
      executable_name: need('exe'),
      description: args.description || '',
    },
  });
  fail(res);
  console.log(`created draft '${res.game.slug}' (${res.game.title})`);
} else if (command === 'upload') {
  const slug = need('slug');
  const version = need('version');
  const zip = await readFile(need('zip'));
  const qs = new URLSearchParams({ version, changelog: args.changelog || '' });
  const res = await api('POST', `/api/publisher/games/${slug}/builds?${qs}`, {
    raw: zip,
  });
  fail(res);
  console.log(
    `uploaded ${basename(args.zip)} → ${slug}@${res.build.version} ` +
      `(${res.build.size_bytes} bytes, sha256 ${res.build.sha256.slice(0, 16)}…)`
  );
} else if (command === 'submit') {
  const res = await api('POST', `/api/publisher/games/${need('slug')}/submit`, {
    body: { version: need('version') },
  });
  fail(res);
  console.log(
    `submitted ${res.submission.game_slug}@${res.submission.version} ` +
      'for review — check back with `list`'
  );
} else if (command === 'cancel') {
  const res = await api('POST', `/api/publisher/submissions/${need('submission')}/cancel`);
  fail(res);
  console.log('submission withdrawn');
} else if (command === 'list') {
  const res = await api('GET', '/api/publisher/games');
  fail(res);
  for (const g of res.games) {
    console.log(`\n${g.slug} — ${g.title} [${g.status}]`);
    for (const b of g.builds) {
      console.log(
        `  build ${b.version}  ${b.size_bytes}B  sha256:${b.sha256.slice(0, 12)}…`
      );
    }
    for (const s of g.submissions) {
      console.log(
        `  submission #${s.id} v${s.version}: ${s.status}` +
          (s.feedback ? ` — "${s.feedback}"` : '')
      );
    }
  }
}

// ---------------------------------------------------------------- utils
async function api(method, path, { body, raw } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  let payload;
  if (raw) {
    headers['content-type'] = 'application/octet-stream';
    payload = raw;
  } else if (body) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const r = await fetch(`${server}${path}`, { method, headers, body: payload });
  return r.json().catch(() => ({ error: `HTTP_${r.status}` }));
}

function fail(res) {
  if (res.error) {
    console.error(`failed: ${res.error}` + (res.expected ? ` (expected ${res.expected})` : ''));
    process.exit(1);
  }
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
