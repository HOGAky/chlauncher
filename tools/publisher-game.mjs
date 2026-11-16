#!/usr/bin/env node
/**
 * @file publisher-game.mjs
 * Self-service CLI for game publishers (role=publisher) — mirrors
 * publish-game.mjs but talks to /api/publisher instead of /api/admin.
 *
 *   node tools/publisher-game.mjs --server http://127.0.0.1:8787 \
 *     --email dev@example.com --password secret <command> [opts]
 *
 * Commands:
 *   list                                        — own games + builds + submissions
 *   create --slug S --title T --exe X [--description D]
 *   upload --slug S --version V --zip F [--changelog C]
 *   submit --slug S --version V                 — send build to review
 *   release --slug S --title T --exe X --version V --zip F
 *                                               — create+upload+submit in one go
 *
 * HWID: same convention as publish-game.mjs — pass --hwid if the account
 * is bound to another device.
 */

import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { createHash } from 'node:crypto';
import { hostname, userInfo } from 'node:os';

const args = parseArgs(process.argv.slice(2));
const command = args._[0];
const need = (k) => {
  if (!args[k]) {
    console.error(`missing --${k}`);
    process.exit(1);
  }
  return args[k];
};

if (!command || !['list', 'create', 'upload', 'submit', 'release'].includes(command)) {
  console.error('usage: publisher-game.mjs [common opts] <list|create|upload|submit|release> [opts]');
  process.exit(1);
}

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

// ---------------------------------------------------------------- helpers
const api = async (path, { method = 'GET', body, headers = {} } = {}) => {
  const res = await fetch(`${server}/api/publisher${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...headers },
    body,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    console.error(`${method} ${path} → ${res.status}: ${json.error || 'FAILED'}`);
    process.exit(1);
  }
  return json;
};

const createGame = () =>
  api('/games', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      slug: need('slug'),
      title: need('title'),
      executable_name: need('exe'),
      description: args.description || '',
    }),
  });

const uploadBuild = async () => {
  const slug = need('slug');
  const version = need('version');
  const zip = await readFile(need('zip'));
  const qs = new URLSearchParams({ version, changelog: args.changelog || '' });
  const { build } = await api(
    `/games/${encodeURIComponent(slug)}/builds?${qs}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: zip,
    }
  );
  console.log(
    `uploaded ${basename(args.zip)} → ${slug}@${version} ` +
      `(${build.size_bytes} bytes, sha256 ${build.sha256.slice(0, 16)}…)`
  );
};

const submitBuild = async () => {
  const slug = need('slug');
  const { submission } = await api(`/games/${encodeURIComponent(slug)}/submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ version: need('version') }),
  });
  console.log(`submitted ${slug}@${submission.version} for review (id ${submission.id})`);
};

// ---------------------------------------------------------------- login
const login = await fetch(`${server}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email, password, hwid }),
}).then((r) => r.json());
if (login.error) {
  console.error(
    login.error === 'HWID_MISMATCH'
      ? 'HWID_MISMATCH: pass --hwid <bound value> or unbind first.'
      : `login failed: ${login.error}`
  );
  process.exit(1);
}
if (!['publisher', 'admin'].includes(login.user?.role)) {
  console.error(
    `logged in as '${login.user?.role}' — publisher role required ` +
      '(ask an admin: tools/grant-admin.mjs <email> publisher)'
  );
  process.exit(1);
}
const token = login.token;
console.log(`logged in as ${email} (${login.user.role})`);

// ---------------------------------------------------------------- command
switch (command) {
  case 'list': {
    const { games } = await api('/games');
    for (const g of games) {
      console.log(
        `${g.slug}  [${g.status}]  published=${g.published_version || '-'}  ` +
          `builds=${g.builds.length}  submissions=${g.submissions.length}`
      );
      for (const b of g.builds.slice(0, 5)) {
        console.log(`    build ${b.version}  ${(b.size_bytes / 1048576).toFixed(1)} MB`);
      }
      for (const s of g.submissions.slice(0, 3)) {
        console.log(`    submission ${s.version}: ${s.status}${s.feedback ? ` — ${s.feedback}` : ''}`);
      }
    }
    if (!games.length) console.log('(no games yet — create one with `create`)');
    break;
  }
  case 'create': {
    const { game } = await createGame();
    console.log(`created draft ${game.slug} — upload a build next`);
    break;
  }
  case 'upload':
    await uploadBuild();
    break;
  case 'submit':
    await submitBuild();
    break;
  case 'release': {
    const slug = need('slug');
    const { games } = await api('/games');
    if (!games.some((g) => g.slug === slug)) {
      await createGame();
      console.log(`created draft ${slug}`);
    }
    await uploadBuild();
    await submitBuild();
    break;
  }
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        out[key] = argv[++i];
      } else {
        out[key] = true;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}
