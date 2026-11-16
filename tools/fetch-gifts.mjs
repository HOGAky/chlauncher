#!/usr/bin/env node
/**
 * tools/fetch-gifts.mjs — refresh the launcher's bundled TikTok gift catalog.
 *
 * Scrapes the public community gift list (names, coin prices, icon images)
 * and emits committed assets:
 *
 *   apps/launcher/public/gifts.json        — [{ name, coins, image }]
 *   apps/launcher/public/gifts/<slug>.webp — icon assets (webp, ~96px)
 *
 * Entries are deduplicated on (name, coins): the same display name can be a
 * different gift at a different coin price across regions, so each pair is a
 * distinct catalog row. Deterministic output — sorted by coins asc, then name.
 *
 * Usage:  node tools/fetch-gifts.mjs [--list <url>] [--check]
 *   --check  validate the committed catalog without re-fetching (schema +
 *            every referenced image exists + minimum size); exits non-zero
 *            on failure. Used by CI to catch a stale/hand-edited catalog.
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUB = join(ROOT, 'apps/launcher/public');
const GIFTS_DIR = join(PUB, 'gifts');
const CATALOG = join(PUB, 'gifts.json');
const listIdx = process.argv.indexOf('--list');
const LIST_URL = listIdx >= 0 ? process.argv[listIdx + 1] : 'https://streamtoearn.io/ru/gifts';
const CHECK_ONLY = process.argv.includes('--check');
const MIN_ENTRIES = 1500;

const slugify = (s) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'gift';

/** Parses <div class="gift"> blocks into [{ name, coins, img }] deduped on (name, coins). */
export function parseGiftList(html) {
  const blocks = html.match(/<div class="gift"[^>]*>[\s\S]*?<\/p>\s*<\/div>/g) ?? [];
  const seen = new Map();
  for (const b of blocks) {
    const img = /<img\s+src="(https:\/\/[^"]+)"/.exec(b)?.[1];
    const name = /class="gift-name"[^>]*>([\s\S]*?)<\/p>/.exec(b)?.[1].trim();
    const coins = Number(/class="gift-price"[^>]*>(\d+)/.exec(b)?.[1]);
    if (!img || !name || !Number.isFinite(coins)) continue;
    const key = `${name}|${coins}`;
    if (!seen.has(key)) seen.set(key, { name, coins, img });
  }
  return [...seen.values()].sort((a, b) => a.coins - b.coins || a.name.localeCompare(b.name));
}

/** Validates a committed catalog row set (schema + image files present). */
function checkCatalog() {
  const rows = JSON.parse(readFileSync(CATALOG, 'utf8'));
  if (!Array.isArray(rows) || rows.length < MIN_ENTRIES)
    throw new Error(`catalog has ${rows.length} entries, expected ≥ ${MIN_ENTRIES}`);
  for (const [i, r] of rows.entries()) {
    if (typeof r.name !== 'string' || !r.name) throw new Error(`row ${i}: bad name`);
    if (!Number.isInteger(r.coins) || r.coins < 0) throw new Error(`row ${i}: bad coins`);
    if (typeof r.image !== 'string' || !r.image.startsWith('gifts/'))
      throw new Error(`row ${i}: bad image path ${r.image}`);
    if (!existsSync(join(PUB, r.image))) throw new Error(`row ${i}: missing ${r.image}`);
  }
  console.log(`gifts catalog OK — ${rows.length} entries, all icons present`);
}

async function fetchHtml(url) {
  const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return r.text();
}

async function download(url, dest) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
}

async function main() {
  if (CHECK_ONLY) return checkCatalog();
  const html = await fetchHtml(LIST_URL);
  const items = parseGiftList(html);
  if (items.length < MIN_ENTRIES)
    throw new Error(`parsed only ${items.length} gifts — page layout may have changed`);
  mkdirSync(GIFTS_DIR, { recursive: true });

  const usedSlugs = new Map();
  const rows = [];
  let fetched = 0;
  for (const { name, coins, img } of items) {
    const base = slugify(name);
    const n = (usedSlugs.get(base) ?? 0) + 1;
    usedSlugs.set(base, n);
    const file = `gifts/${base}${n > 1 ? `-${n}` : ''}.webp`;
    const dest = join(PUB, file);
    if (!existsSync(dest)) {
      await download(img, dest);
      fetched++;
    }
    rows.push({ name, coins, image: file });
  }
  writeFileSync(CATALOG, JSON.stringify(rows, null, 1) + '\n');
  console.log(`gifts.json — ${rows.length} entries (${fetched} icons downloaded)`);
}

main().catch((e) => {
  console.error(`fetch-gifts: ${e.message}`);
  process.exit(1);
});
