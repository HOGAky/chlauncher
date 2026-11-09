/**
 * @file presetPoster.ts
 * Renders a trigger profile/preset as a downloadable PNG "cheat sheet" —
 * the streamer prints or pins it for viewers: top of each row shows the
 * gift icon with its required quantity (x1, x5, …), bottom shows the
 * in-game action it triggers (glyph + name).
 */

import type { GiftEntry, PresetRow, TriggerProfile } from '../types';
import { presetRows } from './presetRows';

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

/**
 * Renders the profile to a PNG blob. `gifts` is the bundled catalog
 * (public/gifts.json); callers may pass [] — gift icons then fall back
 * to kind glyphs. Rows come from `presetRows` so the poster, the
 * /overlay/preset page and the OverlaysPage preview all agree.
 * `profile.overlay` (accent color, font scale) applies here too.
 */
export async function renderPresetPoster(
  profile: TriggerProfile,
  gifts: GiftEntry[]
): Promise<Blob> {
  const rows = presetRows(profile, gifts);
  const ov = profile.overlay;
  const accent: string = /^#[0-9a-fA-F]{6}$/.test(ov?.accent_color ?? '')
    ? ov!.accent_color!
    : '#58a6ff';
  const scale = ov?.font_scale && ov.font_scale >= 0.5 ? Math.min(ov.font_scale, 2) : 1;
  const W = 960;
  const PAD = 24;
  const TITLE_H = 88;
  const ROW_H = Math.round(76 * scale);
  const FOOT_H = 36;
  const H = PAD + TITLE_H + rows.length * (ROW_H + 8) + FOOT_H + PAD;

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
    ? `пресет «${profile.preset}» · ${rows.length} правил`
    : `${rows.length} правил`;
  ctx.fillText(sub, PAD, PAD + 60);
  ctx.textAlign = 'right';
  ctx.fillText('chlauncher', W - PAD, PAD + 34);
  ctx.textAlign = 'left';

  // Pre-load unique images once (gift icons + media art).
  const imgs = new Map<string, HTMLImageElement | null>();
  for (const r of rows) {
    for (const src of [r.gift_image, r.image]) {
      if (src && !imgs.has(src)) imgs.set(src, await loadImage(src));
    }
  }

  // Rows.
  const rules = profile.rules.filter((r) => r.enabled !== false && (r.action || r.label));
  rows.forEach((r: PresetRow, i) => {
    const rule = rules[i];
    const y = PAD + TITLE_H + i * (ROW_H + 8);
    ctx.fillStyle = '#161b22';
    ctx.strokeStyle = '#30363d';
    ctx.beginPath();
    ctx.roundRect(PAD, y, W - PAD * 2, ROW_H, 10);
    ctx.fill();
    ctx.stroke();

    const iconX = PAD + 14;
    const iconY = y + Math.round(10 * scale);
    const iconSize = Math.round(56 * scale);
    const img = r.gift_image ? imgs.get(r.gift_image) : null;
    if (img) {
      ctx.drawImage(img, iconX, iconY, iconSize, iconSize);
    } else {
      ctx.font = `${Math.round(44 * scale)}px "Segoe UI Emoji", system-ui, sans-serif`;
      ctx.fillText(KIND_GLYPHS[rule.event_kind] ?? KIND_GLYPHS.any, iconX + 4, iconY + Math.round(46 * scale));
    }

    // Quantity / match label under the icon.
    const qty = r.count > 1 ? `x${r.count}` : rule.min_amount > 0 ? `≥${rule.min_amount}` : r.count === 1 ? 'x1' : '';
    ctx.font = `700 ${Math.round(14 * scale)}px system-ui, "Segoe UI", sans-serif`;
    ctx.fillStyle = '#f0f6fc';
    ctx.textAlign = 'center';
    if (qty) ctx.fillText(qty, iconX + iconSize / 2, iconY + iconSize + Math.round(14 * scale));
    ctx.textAlign = 'left';

    // Source · kind · match descriptor + coin price.
    ctx.font = `500 ${Math.round(13 * scale)}px system-ui, "Segoe UI", sans-serif`;
    ctx.fillStyle = '#8b949e';
    const coinsTxt = r.coins ? ` · ${r.coins} ◉` : '';
    ctx.fillText(`${rule.source} · ${rule.event_kind} · «${r.gift}»${coinsTxt}`, iconX + iconSize + 16, y + Math.round(22 * scale));

    // Arrow into the action.
    ctx.font = `500 ${Math.round(28 * scale)}px system-ui, "Segoe UI", sans-serif`;
    ctx.fillStyle = '#8b949e';
    ctx.fillText('→', W / 2 - 60, y + Math.round(48 * scale));

    // Action: media art or glyph + label.
    const art = r.image ? imgs.get(r.image) : null;
    if (art) {
      ctx.drawImage(art, W / 2 - 20, y + Math.round(12 * scale), Math.round(44 * scale), Math.round(44 * scale));
    } else {
      ctx.font = `${Math.round(40 * scale)}px "Segoe UI Emoji", system-ui, sans-serif`;
      ctx.fillText(ACTION_GLYPHS[rule.action] ?? '🎮', W / 2 - 20, y + Math.round(54 * scale));
    }
    ctx.font = `600 ${Math.round(20 * scale)}px system-ui, "Segoe UI", sans-serif`;
    ctx.fillStyle = accent;
    ctx.fillText(r.label, W / 2 + 36, y + Math.round(44 * scale));
    if (rule.multiplier !== 1) {
      ctx.font = `500 ${Math.round(13 * scale)}px system-ui, "Segoe UI", sans-serif`;
      ctx.fillStyle = '#8b949e';
      ctx.fillText(`×${rule.multiplier}`, W / 2 + 36, y + Math.round(62 * scale));
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
