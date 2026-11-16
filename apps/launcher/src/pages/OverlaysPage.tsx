/**
 * @file OverlaysPage.tsx
 * Preset overlay editor (stage 7, spec §5.2): per-game OverlayStyle —
 * template, accent, opacity, scale, border, layout — with a live DOM
 * preview of the same rows the /overlay/preset page renders. Saving
 * pushes a `preset` frame, so an open Browser Source updates live.
 * The PNG poster and this preview share `presetRows` — one renderer
 * model for cheat sheet across overlay/download (spec §5.5).
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Copy, ImageDown, Save } from 'lucide-react';
import * as api from '../api';
import type { GiftEntry, OverlayStyle, PresetRow, TriggerProfile } from '../types';
import { useApp } from '../App';
import { loadGifts } from '../lib/gifts';
import { presetRows } from '../lib/presetRows';
import { renderPresetPoster } from '../lib/presetPoster';
import { humanError } from '../errorMessages';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';

const DEFAULT_SLUG = 'default';
const TEMPLATES = [
  { v: 'cards', t: 'Карточки', d: 'сетка: иконка сверху, действие снизу' },
  { v: 'list', t: 'Список', d: 'строки: подарок → действие' },
  { v: 'text', t: 'Текст', d: 'компактные строки без иконок' },
] as const;
const BORDERS = [
  { v: 'thin', t: 'тонкая' },
  { v: 'glow', t: 'свечение' },
  { v: 'none', t: 'без рамки' },
] as const;

const DEFAULT_STYLE: Required<
  Pick<OverlayStyle, 'template' | 'accent_color' | 'bg_opacity' | 'font_scale' | 'border' | 'columns' | 'max_rows' | 'rotate_ms'>
> = {
  template: 'cards',
  accent_color: '#58a6ff',
  bg_opacity: 0.85,
  font_scale: 1,
  border: 'thin',
  columns: 3,
  max_rows: 0,
  rotate_ms: 0,
};

export default function OverlaysPage() {
  const { boot } = useApp();
  const [slug, setSlug] = useState(DEFAULT_SLUG);
  const [gameSlugs, setGameSlugs] = useState<string[]>([DEFAULT_SLUG]);
  const [profile, setProfile] = useState<TriggerProfile | null>(null);
  const [gifts, setGifts] = useState<GiftEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    loadGifts().then(setGifts);
    api
      .listGames()
      .then((r) =>
        setGameSlugs((old) => [
          ...new Set([...old, DEFAULT_SLUG, ...r.games.map((g) => g.slug)]),
        ])
      )
      .catch(() => {});
  }, []);

  useEffect(() => {
    api
      .getTriggers(slug)
      .then(setProfile)
      .catch((e) => setError(humanError(e)));
  }, [slug]);

  const style = { ...DEFAULT_STYLE, ...(profile?.overlay ?? {}) };
  const rows = useMemo(
    () => (profile ? presetRows(profile, gifts) : []),
    [profile, gifts]
  );
  const shown = style.max_rows > 0 ? rows.slice(0, style.max_rows) : rows;

  const patch = (p: Partial<OverlayStyle>) =>
    setProfile((pr) => pr && { ...pr, overlay: { ...style, ...p } });

  const save = () => {
    if (!profile) return;
    api
      .saveTriggers({ ...profile, overlay: style })
      .then(() => setMsg('Сохранено — оверлей пресета обновился у всех подключённых источников'))
      .catch((e) => setError(humanError(e)));
  };

  const downloadPng = () => {
    if (!profile) return;
    renderPresetPoster({ ...profile, overlay: style }, gifts)
      .then((blob) => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `preset-${profile.preset ?? profile.game_slug}.png`;
        a.click();
        URL.revokeObjectURL(a.href);
      })
      .catch((e) => setError(humanError(e)));
  };

  const presetUrl = boot?.overlay_pages?.preset;

  const accent = style.accent_color;
  const borderCss =
    style.border === 'none'
      ? 'none'
      : style.border === 'glow'
        ? `1px solid ${accent}; box-shadow: 0 0 14px ${accent}66`
        : '1px solid #30363d';
  const fontScale = `${style.font_scale}em`;

  return (
    <div className="max-w-4xl flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Оверлей пресета</h1>
        <div className="flex gap-2">
          {presetUrl && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                navigator.clipboard.writeText(presetUrl);
                setMsg('URL /overlay/preset скопирован');
              }}
            >
              <Copy size={14} /> URL оверлея
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={downloadPng}>
            <ImageDown size={14} /> PNG
          </Button>
          <Button size="sm" onClick={save} disabled={!profile}>
            <Save size={14} /> Сохранить
          </Button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground -mt-2">
        Живая шпаргалка «подарок → действие» для зрителей. Стиль хранится в профиле
        игры; сохранение мгновенно обновляет открытый оверлей.
      </p>

      {error && <div className="text-sm text-red-400">{error}</div>}
      {msg && <div className="text-sm text-emerald-400">{msg}</div>}

      <div className="flex gap-4">
        {/* Settings column */}
        <Card className="w-72 shrink-0">
          <CardHeader className="py-3">
            <CardTitle className="text-sm">Стиль</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Профиль</span>
              <select
                className="bg-input rounded px-2 py-1.5"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
              >
                {gameSlugs.map((s) => (
                  <option key={s} value={s}>
                    {s === DEFAULT_SLUG ? 'default (облачные серверы)' : s}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Шаблон</span>
              <select
                className="bg-input rounded px-2 py-1.5"
                value={style.template}
                onChange={(e) => patch({ template: e.target.value })}
              >
                {TEMPLATES.map((t) => (
                  <option key={t.v} value={t.v} title={t.d}>
                    {t.t} — {t.d}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">Акцент</span>
              <input
                type="color"
                value={accent}
                onChange={(e) => patch({ accent_color: e.target.value })}
                className="h-7 w-12 bg-transparent"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">
                Прозрачность фона — {Math.round(style.bg_opacity * 100)}%
              </span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={style.bg_opacity}
                onChange={(e) => patch({ bg_opacity: Number(e.target.value) })}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">
                Масштаб шрифта — {style.font_scale.toFixed(2)}×
              </span>
              <input
                type="range"
                min={0.5}
                max={2}
                step={0.05}
                value={style.font_scale}
                onChange={(e) => patch({ font_scale: Number(e.target.value) })}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Рамка</span>
              <select
                className="bg-input rounded px-2 py-1.5"
                value={style.border}
                onChange={(e) => patch({ border: e.target.value })}
              >
                {BORDERS.map((b) => (
                  <option key={b.v} value={b.v}>
                    {b.t}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">Колонки</span>
              <input
                type="number"
                min={1}
                max={6}
                className="w-16 bg-input rounded px-2 py-1"
                value={style.columns}
                onChange={(e) => patch({ columns: Number(e.target.value) })}
              />
            </label>
            <label className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">Макс. строк (0 — все)</span>
              <input
                type="number"
                min={0}
                className="w-16 bg-input rounded px-2 py-1"
                value={style.max_rows}
                onChange={(e) => patch({ max_rows: Number(e.target.value) })}
              />
            </label>
            <label className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">
                Ротация страниц, с (0 — выкл)
              </span>
              <input
                type="number"
                min={0}
                step={5}
                className="w-16 bg-input rounded px-2 py-1"
                value={Math.round(style.rotate_ms / 1000)}
                onChange={(e) => patch({ rotate_ms: Number(e.target.value) * 1000 })}
              />
            </label>
          </CardContent>
        </Card>

        {/* Live preview — mirrors /overlay/preset rendering. */}
        <div
          className="flex-1 rounded-lg p-3 min-h-64"
          style={{
            background: `rgba(13,17,23,${style.bg_opacity})`,
            border: '1px dashed #30363d',
            fontSize: fontScale,
          }}
        >
          <div className="text-[0.7em] uppercase tracking-widest text-muted-foreground mb-2">
            {slug} — {style.template} — {shown.length}/{rows.length} строк
          </div>
          {shown.length === 0 && (
            <div className="text-sm text-muted-foreground py-8 text-center">
              В профиле нет активных правил — добавьте их в маппере
            </div>
          )}
          {style.template === 'cards' && (
            <div
              className="grid gap-2"
              style={{ gridTemplateColumns: `repeat(${Math.max(1, style.columns)}, 1fr)` }}
            >
              {shown.map((r, i) => (
                <PreviewCard key={i} r={r} accent={accent} border={borderCss} />
              ))}
            </div>
          )}
          {style.template === 'list' && (
            <div className="flex flex-col gap-1.5">
              {shown.map((r, i) => (
                <div
                  key={i}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 bg-black/40"
                  style={{ border: borderCss }}
                >
                  <RowIcon r={r} size={28} />
                  <span className="text-[0.85em]">
                    {r.gift}
                    {r.count > 1 && <b style={{ color: accent }}> ×{r.count}</b>}
                  </span>
                  {r.coins > 0 && (
                    <span className="text-[0.7em] text-muted-foreground">{r.coins} ◉</span>
                  )}
                  <span className="text-muted-foreground ml-auto">→</span>
                  <span className="text-[0.85em] font-medium" style={{ color: accent }}>
                    {r.label}
                  </span>
                </div>
              ))}
            </div>
          )}
          {style.template === 'text' && (
            <div className="flex flex-col gap-1 text-[0.85em]">
              {shown.map((r, i) => (
                <div key={i}>
                  <span className="text-muted-foreground">
                    {r.gift}
                    {r.count > 1 ? ` ×${r.count}` : ''}
                  </span>
                  <span className="text-muted-foreground"> → </span>
                  <span style={{ color: accent }}>{r.label}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function RowIcon({ r, size }: { r: PresetRow; size: number }) {
  const src = r.gift_image ?? r.image;
  if (src) {
    return (
      <img
        src={src}
        alt=""
        style={{ width: size, height: size, objectFit: 'contain' }}
        onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')}
      />
    );
  }
  return <span style={{ fontSize: size * 0.8 }}>🎁</span>;
}

function PreviewCard({
  r,
  accent,
  border,
}: {
  r: PresetRow;
  accent: string;
  border: string;
}) {
  return (
    <div
      className="rounded-md bg-black/40 px-2 py-2 flex flex-col items-center gap-1 text-center"
      style={{ border }}
    >
      <RowIcon r={r} size={40} />
      <div className="text-[0.75em] leading-tight">
        {r.gift}
        {r.count > 1 && <b style={{ color: accent }}> ×{r.count}</b>}
        {r.coins > 0 && (
          <div className="text-[0.85em] text-muted-foreground">{r.coins} ◉</div>
        )}
      </div>
      <div className="text-[0.7em] text-muted-foreground">▼</div>
      <div className="text-[0.8em] font-medium leading-tight" style={{ color: accent }}>
        {r.label}
      </div>
    </div>
  );
}
