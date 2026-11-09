/**
 * @file gifts.ts
 * Shared loader for the bundled TikTok gift catalog (public/gifts.json) —
 * fetched once, cached for the session, so the mapper's rule rows, the
 * picker and the PNG poster all resolve icons without repeated fetches.
 */
import type { GiftEntry } from '../types';

let cache: Promise<GiftEntry[]> | null = null;

/** Loads gifts.json once per session; resolves to [] on failure. */
export const loadGifts = (): Promise<GiftEntry[]> =>
  (cache ??= fetch('/gifts.json')
    .then((r) => (r.ok ? r.json() : []))
    .then((rows: GiftEntry[]) => (Array.isArray(rows) ? rows : []))
    .catch(() => []));

/**
 * Resolves a rule's match_value to a catalog gift: exact name match
 * (case-insensitive) first, then a substring match on the shortest
 * candidate (substring hits prefer tight matches — "Rose" → "Rose",
 * not "Rose Box XL").
 */
export function findGift(matchValue: string, gifts: GiftEntry[]): GiftEntry | null {
  const m = matchValue.trim().toLowerCase();
  if (!m) return null;
  const exact = gifts.find((g) => g.name.toLowerCase() === m);
  if (exact) return exact;
  const loose = gifts.filter((g) => g.name.toLowerCase().includes(m));
  loose.sort((a, b) => a.name.length - b.name.length);
  return loose[0] ?? null;
}
