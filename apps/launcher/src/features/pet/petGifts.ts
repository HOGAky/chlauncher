/**
 * @file petGifts.ts
 * Gift catalogue + feature constants. Adding a new gift = appending an
 * entry here (and, for a brand-new effect, one entry in the
 * EFFECT_COMPONENTS map in PetWidget.tsx + its CSS keyframes).
 */
import type { PetGift } from './types.ts';

export const STORAGE_KEY = 'chlauncher.pet.state.v1';
export const STARTING_COINS = 100;
/** Cap on simultaneous effect layers so the widget stays readable. */
export const MAX_ACTIVE_EFFECTS = 3;
/** Local GIF asset — bundled via public/, never fetched at runtime. */
export const FISH_GIF_SRC = '/pets/fish.gif';

export const PET_GIFTS: PetGift[] = [
  {
    id: 'food',
    title: 'Корм',
    icon: '🐟',
    price: 1,
    effect: 'feed',
    durationMs: 2000,
    hint: 'Рыбка ест: хлопья падают сверху',
  },
  {
    id: 'bubble',
    title: 'Пузырь',
    icon: '🫧',
    price: 2,
    effect: 'bubbles',
    durationMs: 2500,
    hint: 'Фонтан пузырей вокруг аквариума',
  },
  {
    id: 'lightning',
    title: 'Молния',
    icon: '⚡️',
    price: 5,
    effect: 'speed',
    durationMs: 2500,
    hint: 'Разгон: рыбка несётся с искрами',
  },
  {
    id: 'crown',
    title: 'Корона',
    icon: '👑',
    price: 10,
    effect: 'crown',
    durationMs: 6000,
    hint: 'Королевская корона и золотое сияние',
  },
  {
    id: 'heart',
    title: 'Сердце',
    icon: '❤️',
    price: 3,
    effect: 'hearts',
    durationMs: 2200,
    hint: 'Любовь: сердечки и прыжок радости',
  },
];

export const getGiftById = (id: string) => PET_GIFTS.find((g) => g.id === id);

/** UI strings in one place (перенос в локализацию — правка только тут). */
export const PET_TEXTS = {
  title: 'Питомец лаунчера',
  virtualNotice: 'Подарки виртуальные — это не реальная покупка',
  sent: (title: string) => `+${title}`,
  giftsSent: 'Подарков',
  coins: 'Монеты',
  reset: 'Сбросить питомца',
  resetConfirm: 'Точно сбросить?',
  notEnough: 'Не хватает монет',
} as const;
