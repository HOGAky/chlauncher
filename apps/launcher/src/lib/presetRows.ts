/**
 * @file presetRows.ts
 * Shared row model for the preset cheat sheet — the TS mirror of
 * `overlay::preset_frame` (spec §5.2). The /overlay/preset page renders
 * these rows live from WS frames; the PNG poster and the OverlaysPage
 * preview build them here so all three renderers agree on content.
 */
import type { GiftEntry, PresetRow, TriggerProfile } from '../types';
import { findGift } from './gifts';

/** Builds the cheat-sheet rows for a profile (enabled rules only). */
export function presetRows(profile: TriggerProfile, gifts: GiftEntry[]): PresetRow[] {
  return profile.rules
    .filter((r) => r.enabled !== false && (r.action || r.label))
    .map((r) => {
      const g = r.event_kind === 'gift' ? findGift(r.match_value, gifts) : null;
      return {
        gift: r.match_value || r.event_kind,
        gift_image: g ? `/${g.image}` : undefined,
        count: (r.every_n ?? 0) > 0 ? r.every_n! : 1,
        coins: g?.coins ?? 0,
        label: r.label || r.action,
        image: r.image ? `/media/${r.image.id}` : undefined,
      };
    });
}
