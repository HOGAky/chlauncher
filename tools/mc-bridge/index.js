#!/usr/bin/env node
/**
 * @file index.js
 * chlauncher → Minecraft bridge. Polls the stream-event relay
 * (`GET /api/stream/events?key&since`) and executes RCON console
 * commands on any Minecraft server (vanilla, Paper, Forge — anything
 * with `enable-rcon=true` in server.properties).
 *
 * The same relay key a Roblox place polls works here unchanged —
 * DonationAlerts/TikTok events are transport-agnostic upstream of the
 * EventHub.
 *
 *   node tools/mc-bridge/index.js --config mc-bridge.json
 *   node tools/mc-bridge/index.js \
 *     --relay https://host:8443 --key STREAM_KEY \
 *     --rcon-host 127.0.0.1 --rcon-port 25575 --rcon-pass secret \
 *     --player Steve --fallback "say [stream] {user}: {raw_name}"
 *
 * Command templates (`commands` map, keyed by action_command) support
 * {user} (viewer name, sanitized), {player} (target player),
 * {amount}, {command}, {raw_name}. Unknown action_commands fall back
 * to `fallback` template (if set) or are logged and skipped.
 */

import fs from 'node:fs';
import { RconClient } from './rcon.js';

const args = parseArgs(process.argv.slice(2));

let file = {};
if (args.config) {
  file = JSON.parse(fs.readFileSync(args.config, 'utf8'));
}

const relay = (args.relay || file.relay || '').replace(/\/+$/, '');
const streamKey = args.key || file.stream_key;
const pollMs = Number(args['poll-ms'] || file.poll_ms || 1500);
const rconHost = args['rcon-host'] || file.rcon?.host || '127.0.0.1';
const rconPort = Number(args['rcon-port'] || file.rcon?.port || 25575);
const rconPass = args['rcon-pass'] || file.rcon?.password;
const player = args.player || file.default_target || '';
const commands = file.commands || {};
const fallback = args.fallback ?? file.fallback;

if (!relay || !streamKey || !rconPass) {
  console.error('required: --relay, --key, --rcon-pass (or --config file)');
  console.error('see tools/mc-bridge/config.example.json');
  process.exit(1);
}

const rcon = new RconClient({ host: rconHost, port: rconPort, password: rconPass });

/** MC command context must not break quoting — keep names tight. */
const sanitize = (s) =>
  String(s ?? '')
    .replace(/[\\"'`]/g, '')
    .slice(0, 48);

function render(template, ev) {
  return template
    .replaceAll('{user}', sanitize(ev.user))
    .replaceAll('{player}', sanitize(ev.target || player))
    .replaceAll('{amount}', String(ev.amount ?? 1))
    .replaceAll('{command}', sanitize(ev.action_command))
    .replaceAll('{raw_name}', sanitize(ev.raw_name).slice(0, 80));
}

let since = 0;
let consecutiveErrors = 0;

async function poll() {
  const url = `${relay}/api/stream/events?key=${encodeURIComponent(streamKey)}&since=${since}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (res.status === 401) throw new Error('STREAM_KEY rejected (401)');
  if (res.status === 402) throw new Error('subscription_expired (402) — stream key lapsed');
  if (!res.ok) throw new Error(`relay ${res.status}`);
  const data = await res.json();
  if (typeof data.cursor === 'number') since = data.cursor;
  for (const ev of data.events || []) {
    if (ev?.type !== 'event' || !ev.action_command) continue;
    const tpl = commands[ev.action_command] ?? fallback;
    if (!tpl) {
      console.log(`[skip] ${ev.action_command} — no template, no fallback`);
      continue;
    }
    const cmd = render(tpl, ev);
    try {
      const { body } = await rcon.send(cmd);
      console.log(`[rcon] ${cmd}${body ? ` → ${body.trim().slice(0, 80)}` : ''}`);
    } catch (e) {
      console.error(`[rcon-fail] ${cmd}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

console.log(`mc-bridge: ${relay} → rcon ${rconHost}:${rconPort}`);
console.log(`templates: ${Object.keys(commands).length}, fallback: ${fallback ? 'on' : 'off'}`);

// Warm up the RCON connection so auth problems surface at start.
try {
  await rcon.send('list');
  console.log('rcon: connected');
} catch (e) {
  console.error(`rcon connect failed: ${e.message}`);
  process.exit(2);
}

for (;;) {
  try {
    await poll();
    consecutiveErrors = 0;
  } catch (e) {
    consecutiveErrors++;
    console.error(`[poll] ${e.message}`);
    if (consecutiveErrors > 10) {
      console.error('too many poll failures — exiting');
      process.exit(3);
    }
  }
  await new Promise((r) => setTimeout(r, pollMs));
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
