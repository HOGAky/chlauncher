/**
 * @file PetWidget.tsx
 * «Живой питомец лаунчера»: looping fish GIF + virtual gift panel.
 * Fully local (localStorage, no backend). Effect overlays dispatch
 * through EFFECT_COMPONENTS — a new gift with a new effect needs one
 * entry in petGifts.ts + one renderer + keyframes in index.css.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ImagePlus, RotateCcw } from 'lucide-react';
import type { PetEffect, PetMood } from './types.ts';
import { FISH_GIF_SRC, PET_TEXTS } from './petGifts.ts';
import { usePetState } from './usePetState.ts';
import { clearFish, loadFishBlob, saveFishBlob, MAX_FISH_BYTES } from './petAsset.ts';
import GiftPanel from './GiftPanel.tsx';
import { Card, CardContent } from '../../components/ui/card';
import { Badge } from '../../components/ui/badge';
import { cn } from '../../lib/utils';

/** Effect → overlay renderer map (dispatch, not if/else chains). */
const EFFECT_COMPONENTS: Record<PetEffect, React.FC> = {
  feed: () => (
    <div className="pet-fx" aria-hidden>
      {[-38, 0, 40].map((dx, i) => (
        <span
          key={i}
          className="pet-pellet"
          style={{ left: `calc(58% + ${dx}px)`, animationDelay: `${i * 120}ms` }}
        />
      ))}
    </div>
  ),
  bubbles: () => (
    <div className="pet-fx" aria-hidden>
      {[15, 32, 50, 68, 84].map((x, i) => (
        <span
          key={i}
          className="pet-bubble"
          style={{ left: `${x}%`, animationDelay: `${i * 140}ms` }}
        />
      ))}
    </div>
  ),
  speed: () => (
    <div className="pet-fx" aria-hidden>
      {[30, 55, 80].map((y, i) => (
        <span
          key={i}
          className="pet-zap"
          style={{ top: `${y}%`, animationDelay: `${i * 90}ms` }}
        />
      ))}
    </div>
  ),
  crown: () => (
    <div className="pet-fx" aria-hidden>
      <span className="pet-crown">👑</span>
    </div>
  ),
  hearts: () => (
    <div className="pet-fx" aria-hidden>
      {[30, 55, 75].map((x, i) => (
        <span
          key={i}
          className="pet-heart"
          style={{ left: `${x}%`, animationDelay: `${i * 160}ms` }}
        >
          ❤️
        </span>
      ))}
    </div>
  ),
};

/** Active effects → derived mood (priority: crown > speed > any > idle). */
function moodOf(effects: { effect: PetEffect }[]): PetMood {
  if (effects.some((e) => e.effect === 'crown')) return 'royal';
  if (effects.some((e) => e.effect === 'speed')) return 'excited';
  if (effects.length > 0) return 'happy';
  return 'idle';
}

export default function PetWidget() {
  const { state, effects, sendGift, reset } = usePetState();
  const mood = useMemo(() => moodOf(effects), [effects]);
  // Two-step reset: first click arms, second within 2.5s confirms.
  const [armReset, setArmReset] = useState(false);
  // Custom fish image — user-picked Blob in IndexedDB, shown via
  // objectURL; null/undefined falls back to the bundled GIF.
  const [fishSrc, setFishSrc] = useState(FISH_GIF_SRC);
  const [customFish, setCustomFish] = useState(false);
  const [assetErr, setAssetErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let url: string | null = null;
    let dead = false;
    loadFishBlob().then((b) => {
      if (!b || dead) return;
      url = URL.createObjectURL(b);
      setFishSrc(url);
      setCustomFish(true);
    });
    return () => {
      dead = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, []);

  /** Validates + persists a picked image and swaps the fish. */
  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    if (!f.type.startsWith('image/')) return setAssetErr(PET_TEXTS.gifNotImage);
    if (f.size > MAX_FISH_BYTES) return setAssetErr(PET_TEXTS.gifTooBig);
    setAssetErr(null);
    const url = URL.createObjectURL(f);
    saveFishBlob(f)
      .then(() => {
        setFishSrc(url);
        setCustomFish(true);
      })
      .catch(() => setAssetErr(PET_TEXTS.gifTooBig));
  };

  /** Back to the bundled fish GIF. */
  const revertFish = () => {
    clearFish().catch(() => {});
    setCustomFish(false);
    setFishSrc(FISH_GIF_SRC);
    setAssetErr(null);
  };

  return (
    <Card className="overflow-hidden">
      <CardContent className="flex items-center gap-4 p-4">
        <div
          className="relative shrink-0 w-[180px] h-[130px] select-none"
          title={PET_TEXTS.virtualNotice}
        >
          <div className="absolute inset-0 rounded-xl bg-gradient-to-b from-sky-500/10 to-blue-500/20 border border-sky-500/20" />
          <img
            src={fishSrc}
            alt="Рыба-питомец"
            draggable={false}
            className={cn(
              'absolute left-1/2 top-1/2 w-[160px] -translate-x-1/2 -translate-y-1/2',
              'pet-fish transition-transform duration-300 hover:scale-105',
              mood === 'excited' && 'pet-fish--excited',
              mood === 'royal' && 'pet-fish--royal',
              mood === 'happy' && 'pet-fish--happy'
            )}
          />
          {effects.map((fx) => {
            const Fx = EFFECT_COMPONENTS[fx.effect];
            return (
              <div key={fx.key} className="absolute inset-0">
                <Fx />
                <span className="pet-toast">{fx.label}</span>
              </div>
            );
          })}
        </div>

        <div className="flex-1 min-w-0 flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium">{PET_TEXTS.title}</span>
            <div className="flex items-center gap-2">
              <input
                ref={fileRef}
                type="file"
                accept="image/gif,image/webp,image/apng,image/png"
                className="hidden"
                onChange={onPick}
              />
              <button
                onClick={() =>
                  customFish ? revertFish() : fileRef.current?.click()
                }
                title={customFish ? PET_TEXTS.defaultGif : 'Заменить рыбу своим GIF'}
                className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
              >
                <ImagePlus size={11} />
                {customFish ? PET_TEXTS.defaultGif : PET_TEXTS.customGif}
              </button>
              <button
                onClick={() => {
                  if (armReset) {
                    reset();
                    setArmReset(false);
                  } else {
                    setArmReset(true);
                    window.setTimeout(() => setArmReset(false), 2500);
                  }
                }}
                title={PET_TEXTS.reset}
                className={cn(
                  'flex items-center gap-1 text-[11px] transition-colors',
                  armReset
                    ? 'text-red-400'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                <RotateCcw size={11} />
                {armReset ? PET_TEXTS.resetConfirm : PET_TEXTS.reset}
              </button>
            </div>
          </div>
          {assetErr && (
            <div className="text-[11px] text-red-400">{assetErr}</div>
          )}
          <GiftPanel coins={state.coins} onSend={sendGift} />
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="outline">
              {PET_TEXTS.giftsSent}: {state.totalGifts}
            </Badge>
            <Badge variant="outline">
              {PET_TEXTS.coins}: {state.coins}
            </Badge>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
