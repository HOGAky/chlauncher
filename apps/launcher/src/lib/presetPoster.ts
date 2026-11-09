/**
 * @file presetPoster.ts
 * Renders a trigger profile/preset as a downloadable PNG "cheat sheet" —
 * the streamer prints or pins it for viewers: top of each row shows the
 * gift icon with its required quantity (x1, x5, …), bottom shows the
 * in-game action it triggers (glyph + name).
 */

import type { GiftEntry, TriggerProfile } from '../types';
import { findGift } from './gifts';

/** Emoji glyph per action command — drawn big on canvas next to the name. */
const ACTION_GLYPHS: Record<string, string> = {
  spawn_enemy: '👾',
  spawn_boss: '👹',
  spawn_chaser: '🏃',
  heal_player: '💚',
  drop_floor: '⬇️',
  yeet: '💨',
  invert_controls: '🔀',
  freeze: '🧊',
  slow_field: '🐌',
  camera_spin: '🎥',
  wall_ahead: '🧱',
  decoy_clones: '👯',
  shield: '🛡️',
  speed_boost: '⚡',
  checkpoint: '🚩',
  coin_rain: '🪙',
  fireworks: '🎆',
  log_only: '📝',
  start_game: '▶️',
};

/** Fallback icon when a rule isn't a named gift (kind glyph). */
const KIND_GLYPHS: Record<string, string> = {
  gift: '🎁',
  like: '❤️',
  comment: '💬',
  donation: '💰',
  follow: '➕',
  share: '↗️',
  subscribe: '⭐',
  join: '👋',
  any: '✨',
};

const loadImage = (src: string) =>
  new Promise<HTMLImageElement | null>((res) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => res(null);
    img.src = src;
  });

/** Finds the catalog gift a rule's match_value names (exact → substring). */
function matchGift(
  rule: { match_value: string; event_kind: string },
  gifts: GiftEntry[]
): GiftEntry | null {
  if (rule.event_kind !== 'gift') return null;
  return findGift(rule.match_value, gifts);
}

/**
 * Renders the profile to a PNG blob. `gifts` is the bundled catalog
 * (public/gifts.json); callers may pass [] — gift icons then fall back
 * to kind glyphs.
 */
export async function renderPresetPoster(
  profile: TriggerProfile,
  gifts: GiftEntry[]
): Promise<Blob> {
  const rules = profile.rules;
  const W = 960;
  const PAD = 24;
  const TITLE_H = 88;
  const ROW_H = 76;
  const FOOT_H = 36;
  const H = PAD + TITLE_H + rules.length * (ROW_H + 8) + FOOT_H + PAD;

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d недоступен');

  // Background — matches the app's dark theme.
  ctx.fillStyle = '#0d1117';
  ctx.fillRect(0, 0, W, H);

  // Title band.
  ctx.fillStyle = '#f0f6fc';
  ctx.font = '700 30px system-ui, "Segoe UI", sans-serif';
  ctx.fillText(profile.game_slug, PAD, PAD + 34);
  ctx.font = '500 15px system-ui, "Segoe UI", sans-serif';
  ctx.fillStyle = '#8b949e';
  const sub = profile.preset
    ? `пресет «${profile.preset}» · ${rules.length} правил`
    : `${rules.length} правил`;
  ctx.fillText(sub, PAD, PAD + 60);
  ctx.textAlign = 'right';
  ctx.fillText('chlauncher', W - PAD, PAD + 34);
  ctx.textAlign = 'left';

  // Pre-load unique gift images once.
  const imgs = new Map<string, HTMLImageElement | null>();
  for (const r of rules) {
    const g = r.event_kind === 'gift' ? matchGift(r, gifts) : null;
    if (g && !imgs.has(g.image)) imgs.set(g.image, await loadImage(`/${g.image}`));
  }

  // Rows.
  rules.forEach((r, i) => {
    const y = PAD + TITLE_H + i * (ROW_H + 8);
    ctx.fillStyle = '#161b22';
    ctx.strokeStyle = '#30363d';
    ctx.beginPath();
    ctx.roundRect(PAD, y, W - PAD * 2, ROW_H, 10);
    ctx.fill();
    ctx.stroke();

    const gift = r.event_kind === 'gift' ? matchGift(r, gifts) : null;
    const iconX = PAD + 14;
    const iconY = y + 10;
    const img = gift ? imgs.get(gift.image) : null;
    if (img) {
      ctx.drawImage(img, iconX, iconY, 56, 56);
    } else {
      ctx.font = '44px "Segoe UI Emoji", system-ui, sans-serif';
      ctx.fillText(KIND_GLYPHS[r.event_kind] ?? KIND_GLYPHS.any, iconX + 4, iconY + 46);
    }

    // Quantity / match label under the icon.
    const qty =
      r.event_kind === 'gift'
        ? `x${Math.max(1, r.min_amount)}`
        : r.min_amount > 0
          ? `≥${r.min_amount}`
          : '';
    ctx.font = '700 14px system-ui, "Segoe UI", sans-serif';
    ctx.fillStyle = '#f0f6fc';
    ctx.textAlign = 'center';
    if (qty) ctx.fillText(qty, iconX + 28, iconY + 72 - 4);
    ctx.textAlign = 'left';

    // Source · kind · match descriptor.
    ctx.font = '500 13px system-ui, "Segoe UI", sans-serif';
    ctx.fillStyle = '#8b949e';
    const matchTxt = r.match_value || 'любое';
    ctx.fillText(`${r.source} · ${r.event_kind} · «${matchTxt}»`, iconX + 72, y + 22);

    // Arrow into the action.
    ctx.font = '500 28px system-ui, "Segoe UI", sans-serif';
    ctx.fillStyle = '#8b949e';
    ctx.fillText('→', W / 2 - 60, y + 48);

    // Action glyph + name.
    ctx.font = '40px "Segoe UI Emoji", system-ui, sans-serif';
    ctx.fillText(ACTION_GLYPHS[r.action] ?? '🎮', W / 2 - 20, y + 54);
    ctx.font = '600 20px system-ui, "Segoe UI", sans-serif';
    ctx.fillStyle = '#58a6ff';
    ctx.fillText(r.action, W / 2 + 36, y + 44);
    if (r.multiplier !== 1) {
      ctx.font = '500 13px system-ui, "Segoe UI", sans-serif';
      ctx.fillStyle = '#8b949e';
      ctx.fillText(`×${r.multiplier}`, W / 2 + 36, y + 62);
    }
  });

  // Footer.
  ctx.font = '400 12px system-ui, "Segoe UI", sans-serif';
  ctx.fillStyle = '#484f58';
  ctx.fillText(
    `сгенерировано ${new Date().toLocaleDateString('ru-RU')} · первое совпавшее правило побеждает`,
    PAD,
    H - PAD - 6
  );

  return new Promise((res, rej) =>
    canvas.toBlob((b) => (b ? res(b) : rej(new Error('PNG encode failed'))), 'image/png')
  );
}
