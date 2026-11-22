/**
 * @file usePetState.ts
 * Pet state hook: thin React wrapper over the pure petStore logic —
 * persisted balance/counters + runtime effect queue capped at
 * MAX_ACTIVE_EFFECTS. No backend, no real payments — offline toy.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ActiveEffect, PetGift, PetState } from './types.ts';
import { MAX_ACTIVE_EFFECTS, STORAGE_KEY } from './petGifts.ts';
import { applyGift, defaultPetState, loadPetState, savePetState } from './petStore.ts';

export function usePetState() {
  const [state, setState] = useState<PetState>(() => loadPetState(localStorage));
  const [effects, setEffects] = useState<ActiveEffect[]>([]);
  const timers = useRef<number[]>([]);
  const keySeq = useRef(0);

  useEffect(() => {
    try {
      savePetState(localStorage, state);
    } catch {
      /* storage full / private mode — the toy still works in-session */
    }
  }, [state]);

  useEffect(() => {
    const t = timers.current;
    return () => t.forEach((id) => clearTimeout(id));
  }, []);

  /**
   * Attempts to send a gift. Returns false when the balance can't cover
   * the price — the button is normally disabled first, this is a guard.
   */
  const sendGift = useCallback((gift: PetGift): boolean => {
    let paid = false;
    setState((s) => {
      const next = applyGift(s, gift);
      if (!next) return s;
      paid = true;
      return next;
    });
    if (!paid) return false;

    const fx: ActiveEffect = {
      key: ++keySeq.current,
      effect: gift.effect,
      giftId: gift.id,
      label: `+${gift.title}`,
    };
    // Newest wins: drop the oldest layer when the cap is reached.
    setEffects((e) => [...e.slice(-(MAX_ACTIVE_EFFECTS - 1)), fx]);
    timers.current.push(
      window.setTimeout(
        () => setEffects((e) => e.filter((x) => x.key !== fx.key)),
        gift.durationMs
      )
    );
    return true;
  }, []);

  /** Clears persisted progress and running effects. */
  const reset = useCallback(() => {
    timers.current.forEach((id) => clearTimeout(id));
    timers.current = [];
    setEffects([]);
    setState(defaultPetState());
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }, []);

  return { state, effects, sendGift, reset };
}
