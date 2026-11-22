/**
 * @file GiftPanel.tsx
 * Gift button row — renders straight from the PET_GIFTS config.
 */
import React, { useEffect, useRef, useState } from 'react';
import type { PetGift } from './types.ts';
import { PET_GIFTS, PET_TEXTS } from './petGifts.ts';
import { Button } from '../../components/ui/button';
import { cn } from '../../lib/utils';

interface Props {
  coins: number;
  onSend: (g: PetGift) => boolean;
}

export default function GiftPanel({ coins, onSend }: Props) {
  /** Brief per-button confirm flash (300–500ms) after a successful send. */
  const [sentId, setSentId] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const send = (g: PetGift) => () => {
    if (!onSend(g)) return;
    clearTimeout(timer.current);
    setSentId(g.id);
    timer.current = window.setTimeout(() => setSentId(null), 450);
  };

  return (
    <div className="flex flex-wrap items-center justify-center gap-1.5">
      {PET_GIFTS.map((g) => {
        const poor = coins < g.price;
        return (
          <Button
            key={g.id}
            size="sm"
            variant={sentId === g.id ? 'default' : 'secondary'}
            disabled={poor}
            title={`${g.title} — ${g.hint}. ${PET_TEXTS.virtualNotice}${
              poor ? ` · ${PET_TEXTS.notEnough}` : ''
            }`}
            className={cn(
              'gap-1 px-2 transition-transform',
              sentId === g.id && 'scale-105'
            )}
            onClick={send(g)}
          >
            <span aria-hidden>{g.icon}</span>
            {g.title}
            <span className="text-[10px] opacity-70">{g.price}</span>
          </Button>
        );
      })}
    </div>
  );
}
