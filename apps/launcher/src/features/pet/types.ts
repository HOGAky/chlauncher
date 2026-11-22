/**
 * @file types.ts
 * Shared types for the launcher pet (аквариум) feature.
 * Kept framework-agnostic so the state layer can later be swapped for
 * game-sdk IPC events without touching the widget.
 */

/** Visual reaction identifier — dispatched through the effect map. */
export type PetEffect = 'feed' | 'bubbles' | 'speed' | 'crown' | 'hearts';

/** Derived display mood of the fish. */
export type PetMood = 'idle' | 'happy' | 'excited' | 'royal';

/** Static gift definition — extends by appending to PET_GIFTS. */
export interface PetGift {
  id: string;
  /** Short name shown on the button and in the "+Корм" toast. */
  title: string;
  /** Emoji icon — no image assets required. */
  icon: string;
  /** Price in virtual coins (never real money). */
  price: number;
  /** Effect key rendered via EFFECT_COMPONENTS in PetWidget. */
  effect: PetEffect;
  /** Reaction length in ms (1.5–3s; the crown may last longer). */
  durationMs: number;
  /** One-line description for the hover tooltip. */
  hint: string;
}

/** Persisted part of the pet state (localStorage). */
export interface PetState {
  totalGifts: number;
  coins: number;
  lastGift: string | null;
  /** gift id -> times sent. */
  counts: Record<string, number>;
}

/** Runtime-only effect instance (not persisted). */
export interface ActiveEffect {
  key: number;
  effect: PetEffect;
  giftId: string;
  /** Toast label, e.g. "+Корм". */
  label: string;
}
