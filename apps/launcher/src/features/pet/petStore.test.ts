/**
 * @file petStore.test.ts
 * Unit tests for the launcher-pet pure state logic (gift catalogue,
 * balance, counters, persistence). Runs on `node --test` — Node ≥22.6
 * strips types, matching the project's existing test convention.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PET_GIFTS, STARTING_COINS, getGiftById } from './petGifts.ts';
import { applyGift, defaultPetState, loadPetState, savePetState } from './petStore.ts';
import type { PetStorage } from './petStore.ts';

const memStorage = (): PetStorage => {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
};

const food = getGiftById('food')!;
const crown = getGiftById('crown')!;

test('catalogue has ≥4 gifts with unique ids, prices and effects', () => {
  assert.ok(PET_GIFTS.length >= 4);
  const ids = new Set(PET_GIFTS.map((g) => g.id));
  assert.equal(ids.size, PET_GIFTS.length, 'duplicate gift ids');
  for (const g of PET_GIFTS) {
    assert.ok(g.price > 0, `${g.id}: price must be positive`);
    assert.ok(g.durationMs >= 1500 && g.durationMs <= 10_000,
      `${g.id}: duration out of spec range`);
  }
});

test('default state: 100 coins, zero gifts', () => {
  const s = defaultPetState();
  assert.equal(s.coins, STARTING_COINS);
  assert.equal(s.totalGifts, 0);
  assert.equal(s.lastGift, null);
});

test('applyGift deducts price and updates counters/lastGift', () => {
  const s1 = applyGift(defaultPetState(), food)!;
  assert.equal(s1.coins, 99);
  assert.equal(s1.totalGifts, 1);
  assert.equal(s1.lastGift, 'food');
  assert.equal(s1.counts.food, 1);

  const s2 = applyGift(s1, crown)!;
  assert.equal(s2.coins, 89);
  assert.equal(s2.totalGifts, 2);
  assert.equal(s2.counts.food, 1);
  assert.equal(s2.counts.crown, 1);
});

test('applyGift refuses when balance is insufficient', () => {
  const broke = { ...defaultPetState(), coins: 2 };
  assert.equal(applyGift(broke, crown), null);
  const s = applyGift(broke, food)!; // price 1 — still affordable
  assert.equal(s.coins, 1);
  assert.equal(applyGift({ ...s }, food)!.coins, 0);
  assert.equal(applyGift({ ...s, coins: 0 }, food), null);
});

test('state round-trips through storage; reset restores defaults', () => {
  const st = memStorage();
  const s = applyGift(defaultPetState(), food)!;
  savePetState(st, s);
  const loaded = loadPetState(st);
  assert.equal(loaded.coins, 99);
  assert.equal(loaded.totalGifts, 1);
  assert.equal(loaded.lastGift, 'food');
  st.removeItem('chlauncher.pet.state.v1');
  assert.deepEqual(loadPetState(st), defaultPetState());
});

test('loadPetState survives corrupt and partial JSON', () => {
  const st = memStorage();
  st.setItem('chlauncher.pet.state.v1', '{not json');
  assert.deepEqual(loadPetState(st), defaultPetState());
  st.setItem('chlauncher.pet.state.v1', '{"coins":5}');
  const s = loadPetState(st);
  assert.equal(s.coins, 5);
  assert.equal(s.totalGifts, 0);
});
