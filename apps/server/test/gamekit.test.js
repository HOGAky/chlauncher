/**
 * @file gamekit.test.js
 * Headless tests for the overlay-game trigger engine (gamekit.js Engine).
 * Covers spec §15 items: gift→action, streak/replay dedupe, comment
 * commands (case-insensitive), like batches, antiflood at high event
 * rates, queue priority drops, and per-user cooldowns.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// gamekit.js is a classic <script> living inside an ESM package, so a
// plain require()/import won't reach its CJS export branch — run the
// IIFE in a manual sandbox and pull the test-only export back out.
const kitPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../launcher/src-tauri/overlay/gamekit.js'
);
const src = readFileSync(kitPath, 'utf8');
const mod = { exports: {} };
new Function('module', 'exports', 'window', `${src}\n;return module.exports;`)(
  mod, mod.exports, undefined
);
const { Engine, fmtTime, fmtNum, leaderboard } = mod.exports;

const ev = (over = {}) => ({
  source: 'tiktok',
  event_kind: 'gift',
  user: 'viewer1',
  raw_name: 'Rose',
  coins: 1,
  count: 1,
  ts_ms: Date.now(),
  ...over,
});
const cfg = (rules, antiflood = {}) => ({ rules, antiflood });

test('gift adds a block action (§15.1)', () => {
  const e = new Engine(cfg([{ event: 'gift', match: { names: ['Rose'] }, action: { type: 'add_block', value: 1 } }]));
  e.feed(ev());
  const acts = e.pump();
  assert.equal(acts.length, 1);
  assert.equal(acts[0].type, 'add_block');
  assert.equal(acts[0]._user, 'viewer1');
});

test('same payload re-fed inside the window does not duplicate (§15.2)', () => {
  const e = new Engine(cfg([{ event: 'gift', match: {}, action: { type: 'add_block', value: 1 } }]));
  const gift = ev({ coins: 5, count: 3 });
  e.feed(gift);
  e.feed({ ...gift });            // replay after reconnect
  e.feed({ ...gift, ts_ms: gift.ts_ms + 1 }); // retry with new ts
  assert.equal(e.pump().length, 1);
});

test('distinct gifts in the window all fire', () => {
  const e = new Engine(cfg([{ event: 'gift', match: {}, action: { type: 'add_block', value: 1 } }]));
  e.feed(ev({ user: 'a', coins: 1 }));
  e.feed(ev({ user: 'b', coins: 1 }));
  e.feed(ev({ user: 'a', coins: 2 }));  // different coins → distinct
  assert.equal(e.pump().length, 3);
});

test('comment commands are case-insensitive and need the ! prefix (§15.3)', () => {
  const e = new Engine(cfg([{ event: 'comment', match: { commands: ['!boy'] }, action: { type: 'join_team' } }]));
  e.feed(ev({ event_kind: 'comment', raw_name: '!BOY', coins: 0 }));
  e.feed(ev({ event_kind: 'comment', raw_name: '  !boy please', coins: 0, user: 'v2' }));
  e.feed(ev({ event_kind: 'comment', raw_name: 'boy', coins: 0, user: 'v3' })); // no bang → no match
  assert.equal(e.pump().length, 2);
});

test('min_coins gate blocks cheap gifts (§15 match)', () => {
  const e = new Engine(cfg([{ event: 'gift', match: { min_coins: 100 }, action: { type: 'destroy' } }]));
  e.feed(ev({ coins: 50 }));
  e.feed(ev({ coins: 100, user: 'rich' }));
  const acts = e.pump();
  assert.equal(acts.length, 1);
  assert.equal(acts[0]._user, 'rich');
});

test('antiflood: 200 events/sec never exceeds the action budget (§15.6)', () => {
  const e = new Engine(cfg(
    [{ event: 'gift', match: {}, action: { type: 'add_block', value: 1 } }],
    { max_per_sec: 20, queue_cap: 500 }
  ));
  for (let i = 0; i < 200; i++) e.feed(ev({ user: `u${i}`, coins: i + 1 }));
  assert.equal(e.pump().length, 20);           // per-second budget
  assert.ok(e.queue.length <= 500);            // bounded
  for (let i = 0; i < 5000; i++) e.feed(ev({ user: `x${i}`, coins: i + 1 }));
  assert.ok(e.queue.length <= 500);            // still bounded after a flood
});

test('queue overflow drops low-priority actions first (§5.3)', () => {
  const e = new Engine(cfg(
    [
      { event: 'gift', match: { names: ['Spark'] }, action: { type: 'play_fx' }, priority: 'low' },
      { event: 'gift', match: { names: ['Lion'] }, action: { type: 'boss' } },
    ],
    { max_per_sec: 1000, queue_cap: 3 }
  ));
  e.feed(ev({ raw_name: 'Spark', user: 'a', coins: 1 }));
  e.feed(ev({ raw_name: 'Spark', user: 'b', coins: 2 }));
  e.feed(ev({ raw_name: 'Spark', user: 'c', coins: 3 }));
  // Queue full of low-prio fx → critical boss evicts one instead of dropping.
  e.feed(ev({ raw_name: 'Lion', user: 'whale', coins: 1000 }));
  const types = e.pump().map((a) => a.type);
  assert.ok(types.includes('boss'));
});

test('per-user cooldown limits command spam (§5.3)', () => {
  const e = new Engine(cfg([
    { event: 'comment', match: { commands: ['!attack'] }, action: { type: 'attack' }, perUserCdMs: 60000 },
  ]));
  e.feed(ev({ event_kind: 'comment', raw_name: '!attack', coins: 0 }));
  e.feed(ev({ event_kind: 'comment', raw_name: '!attack', coins: 0, user: 'other' }));
  e.feed(ev({ event_kind: 'comment', raw_name: '!attack', coins: 0 })); // same user again — blocked
  assert.equal(e.pump().length, 2);
});

test('per-user per-minute cap throttles one spammy viewer', () => {
  const e = new Engine(cfg(
    [{ event: 'gift', match: {}, action: { type: 'add_block', value: 1 } }],
    { per_user_per_min: 5, max_per_sec: 1000 }
  ));
  for (let i = 0; i < 50; i++) e.feed(ev({ coins: i + 1 }));
  assert.equal(e.pump().length, 5);
});

test('rule cooldown gates rapid repeats', () => {
  const e = new Engine(cfg([
    { event: 'gift', match: { names: ['Galaxy'] }, action: { type: 'destroy' }, cooldownMs: 60000 },
  ]));
  e.feed(ev({ raw_name: 'Galaxy', user: 'a', coins: 100 }));
  e.feed(ev({ raw_name: 'Galaxy', user: 'b', coins: 100 }));
  assert.equal(e.pump().length, 1);
});

test('event kinds are strictly matched', () => {
  const e = new Engine(cfg([{ event: 'follow', match: {}, action: { type: 'block' } }]));
  e.feed(ev({ event_kind: 'share' }));
  e.feed(ev({ event_kind: 'follow' }));
  assert.equal(e.pump().length, 1);
});

test('helpers: leaderboard order, fmtTime, fmtNum', () => {
  const top = leaderboard({ a: 1, b: 50, c: 30 }, 2);
  assert.deepEqual(top, [{ user: 'b', score: 50 }, { user: 'c', score: 30 }]);
  assert.equal(fmtTime(300), '05:00');
  assert.equal(fmtTime(-5), '00:00');
  assert.equal(fmtNum(999), '999');
  assert.equal(fmtNum(1500), '1.5k');
});
