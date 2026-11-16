/**
 * @file GiftIcon.tsx
 * Inline catalog icon for a mapper rule row — resolves the rule's
 * match_value to a bundled gift image (name + coin price on hover),
 * falling back to the 🎁 glyph when the rule isn't a named gift.
 */
import React, { useEffect, useState } from 'react';
import { Gift } from 'lucide-react';
import type { GiftEntry } from '../types';
import { findGift, loadGifts } from '../lib/gifts';

export default function GiftIcon({
  matchValue,
  kind,
}: {
  matchValue: string;
  kind: string;
}) {
  const [gifts, setGifts] = useState<GiftEntry[] | null>(null);
  useEffect(() => {
    loadGifts().then(setGifts);
  }, []);

  const g = kind === 'gift' && gifts ? findGift(matchValue, gifts) : null;
  if (g) {
    return (
      <img
        src={`/${g.image}`}
        alt={g.name}
        title={`${g.name} — ${g.coins} монет`}
        className="h-7 w-7 shrink-0 rounded"
        loading="lazy"
      />
    );
  }
  return <Gift size={16} className="shrink-0 text-muted-foreground" />;
}
