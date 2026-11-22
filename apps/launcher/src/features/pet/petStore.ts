/**
 * @file petStore.ts
 * Pure state logic for the launcher pet — no React, no DOM hooks beyond
 * an injectable storage, so it is unit-testable on plain `node --test`.
 */
import type { PetGift, PetState } from './types.ts';
import { STARTING_COINS, STORAGE_KEY } from './petGifts.ts';

export const defaultPetState = (): PetState => ({
  totalGifts: 0,
  coins: STARTING_COINS,
  lastGift: null,
  counts: {},
});

/**
 * Deducts a gift's price and bumps counters. Returns null when the
 * balance can't cover the price — callers treat it as "button disabled".
 */
export function applyGift(s: PetState, gift: PetGift): PetState | null {
  if (s.coins < gift.price) return null;
  return {
    coins: s.coins - gift.price,
    totalGifts: s.totalGifts + 1,
    lastGift: gift.id,
    counts: { ...s.counts, [gift.id]: (s.counts[gift.id] ?? 0) + 1 },
  };
}

/** localStorage-shape storage — injected so tests can pass a stub. */
export interface PetStorage {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

/** Reads persisted state; corrupt/foreign JSON falls back to defaults. */
export function loadPetState(storage: PetStorage, key = STORAGE_KEY): PetState {
  try {
    const raw = storage.getItem(key);
    if (!raw) return defaultPetState();
    const p = JSON.parse(raw) as Partial<PetState>;
    return {
      totalGifts: typeof p.totalGifts === 'number' ? p.totalGifts : 0,
      coins: typeof p.coins === 'number' ? p.coins : STARTING_COINS,
      lastGift: typeof p.lastGift === 'string' ? p.lastGift : null,
      counts: p.counts && typeof p.counts === 'object' ? p.counts : {},
    };
  } catch {
    return defaultPetState();
  }
}

export function savePetState(storage: PetStorage, s: PetState, key = STORAGE_KEY) {
  storage.setItem(key, JSON.stringify(s));
}
