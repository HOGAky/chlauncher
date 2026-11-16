/**
 * @file WidgetsPage.tsx
 * Widget library (StreamToEarn/TikFinity-style): live iframe previews
 * (with demo data) of every widget under any theme, per-widget
 * parameters with proper controls and copy-to-OBS URLs. Widgets are
 * editable HTML/JS files served by the overlay server at /widgets/*
 * (public/widgets) and subscribe to the raw pre-mapper event channel,
 * so they work without trigger rules.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Copy, ExternalLink, Palette } from 'lucide-react';
import { openUrl } from '@tauri-apps/plugin-opener';
import * as api from '../api';
import { useApp } from '../App';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';

type ParamType = 'text' | 'number' | 'color' | 'select' | 'gift';

interface ParamDef {
  key: string;
  label: string;
  type?: ParamType;
  /** For type=select: [value, label][]. */
  options?: [string, string][];
  ph?: string;
}

interface WidgetDef {
  id: string;
  file: string;
  name: string;
  desc: string;
  /** Hardcoded extra query params (e.g. metric=likes). */
  query?: string;
  params?: ParamDef[];
}

const FONT_OPTS: [string, string][] = [
  ['bebas', 'Bebas (плакатный)'],
  ['play', 'Play (техно)'],
  ['mono', 'Mono (машинный)'],
  ['round', 'Round (мягкий)'],
  ['hand', 'Hand (рукописный)'],
  ['glitch', 'Glitch'],
  ['wet', 'Wet (кровавый)'],
  ['russo', 'Russo'],
];
const LOOK_OPTS: [string, string][] = [
  ['panel', 'Панель'],
  ['glass', 'Стекло'],
  ['bare', 'Без фона'],
  ['outline', 'Контур'],
];
const METRIC_OPTS: [string, string][] = [
  ['likes', 'Лайки'],
  ['gifts', 'Подарки'],
  ['coins', 'Монеты'],
];

const WIDGETS: WidgetDef[] = [
  { id: 'likes', file: 'likes.html', name: 'Топ по лайкам', desc: 'Счётчик лайков, цель эфира, топ-3 таперов', params: [
    { key: 'goal', label: 'Цель лайков', type: 'number', ph: '500000' },
  ] },
  { id: 'battle', file: 'battle.html', name: 'Битва подарков', desc: 'Два подарка тянут шкалу в свою сторону', params: [
    { key: 'giftA', label: 'Синий подарок', type: 'gift', ph: 'Rose' },
    { key: 'giftB', label: 'Красный подарок', type: 'gift', ph: 'Heart Me' },
  ] },
  { id: 'topgifts', file: 'topgifts.html', name: 'Топ по подаркам', desc: 'Пьедестал 1-2-3 и список дальше', params: [
    { key: 'top', label: 'Мест в топе', type: 'number', ph: '10' },
  ] },
  { id: 'mono', file: 'mono.html', name: 'Моно-подарок', desc: '«Король» одного выбранного подарка', params: [
    { key: 'mono', label: 'Подарок', type: 'gift', ph: 'Rose' },
    { key: 'mtitle', label: 'Титул', ph: 'КОРОЛЬ РОЗ' },
  ] },
  { id: 'alerts', file: 'alerts.html', name: 'Алерты', desc: 'Всплывашки: подарок / фоллов / шер' },
  { id: 'chat', file: 'chat.html', name: 'Чат эфира', desc: 'Лента комментариев с аватарками' },
  { id: 'stats', file: 'stats.html', name: 'Статистика', desc: 'Зрители / лайки / подарки / топ-донатер' },
  { id: 'events', file: 'events.html', name: 'Лента событий', desc: 'Последние действия в эфире' },
  { id: 'title', file: 'title.html', name: 'Заголовок', desc: 'Большая надпись в любом стиле', params: [
    { key: 'text', label: 'Текст', ph: 'ТГК МЕН' },
    { key: 'sub', label: 'Подпись', ph: 'LIVE' },
  ] },
  { id: 'goal', file: 'goal.html', name: 'Цель стрима', desc: 'Прогресс-бар до цели', params: [
    { key: 'metric', label: 'Метрика', type: 'select', options: METRIC_OPTS },
    { key: 'goal', label: 'Цель', type: 'number', ph: '1000' },
    { key: 'label', label: 'Заголовок', ph: 'ЦЕЛЬ ПО ЛАЙКАМ' },
  ] },
  { id: 'latest', file: 'latest.html', name: 'Последний герой', desc: 'Карточка последнего дарителя/фолловера', params: [
    { key: 'title', label: 'Заголовок', ph: 'Последний герой эфира' },
  ] },
  { id: 'combo', file: 'combo.html', name: 'Серия подарков', desc: 'Счётчик спама одним подарком', params: [
    { key: 'mono', label: 'Подарок (пусто = любой)', type: 'gift', ph: 'Rose' },
    { key: 'sec', label: 'Сброс через, сек', type: 'number', ph: '8' },
    { key: 'title', label: 'Бейдж', ph: 'СЕРИЯ' },
  ] },
  { id: 'countdown', file: 'countdown.html', name: 'Таймер отсчёта', desc: 'Обратный отсчёт до события', params: [
    { key: 'min', label: 'Минуты', type: 'number', ph: '30' },
    { key: 'label', label: 'Заголовок', ph: 'до старта осталось' },
    { key: 'end', label: 'Текст в конце', ph: 'ПОЕХАЛИ!' },
  ] },
  { id: 'top3likes', file: 'top3.html', query: 'metric=likes', name: 'Топ-3 лайков', desc: 'Аватарка, ник и счётчик лайков', params: [
    { key: 'title', label: 'Заголовок', ph: 'ТОП-3 ТАПЕРОВ' },
    { key: 'accent', label: 'Цвет акцента', type: 'color', ph: '#ff2b3a' },
    { key: 'font', label: 'Шрифт', type: 'select', options: FONT_OPTS },
    { key: 'look', label: 'Вид', type: 'select', options: LOOK_OPTS },
  ] },
  { id: 'top3gifts', file: 'top3.html', query: 'metric=coins', name: 'Топ-3 по монетам', desc: 'Кто отправил больше всего монет', params: [
    { key: 'title', label: 'Заголовок', ph: 'ТОП-3 ДАРИТЕЛЕЙ' },
    { key: 'accent', label: 'Цвет акцента', type: 'color', ph: '#ffd94a' },
    { key: 'font', label: 'Шрифт', type: 'select', options: FONT_OPTS },
    { key: 'look', label: 'Вид', type: 'select', options: LOOK_OPTS },
  ] },
];

// Mirrors theme keys/labels in public/widgets/themes.js.
const THEME_LABELS: [string, string][] = [
  ['chrome', 'Liquid Chrome'], ['thorns', 'Dark Thorns'], ['blood', 'Blood Drip'],
  ['glitz', 'Pink Glitz'], ['cyber', 'Neon Cyber'], ['comic', 'Comic Fight'],
  ['luxury', 'Royal Gold'], ['bubble', 'Y2K Bubble'], ['vapor', 'Vaporwave'],
  ['slime', 'Toxic Slime'], ['fire', 'Hellfire'], ['minimal', 'Ghost Clean'],
  ['nosferatu', 'Nosferatu'], ['nightmare', 'Nightmare'], ['zombie', 'Zombie'],
  ['witcher', 'Witcher'], ['pixel', 'Pixel 8-bit'], ['holo', 'Holo Foil'],
  ['matrix', 'Matrix Rain'], ['ice', 'Ice Crystal'], ['sakura', 'Sakura'],
  ['bullion', '3D Gold Bar'], ['paper', 'Craft Paper'], ['vhs', 'VHS Retro'],
];

const CANVAS_W = 1080;
const CANVAS_H = 1920;

export default function WidgetsPage() {
  const { boot } = useApp();
  const [msg, setMsg] = useState<string | null>(null);
  const [giftNames, setGiftNames] = useState<string[]>([]);
  // overlay_pages в глобальном boot может протухнуть (rotate_overlay_token
  // меняет токен — старый URL даёт 403 на всё). Перечитываем свежий
  // bootstrap при заходе — страница самовосстанавливается.
  const [widgetsUrl, setWidgetsUrl] = useState(boot?.overlay_pages?.widgets ?? null);
  useEffect(() => {
    api
      .getBootstrap()
      .then((b) => {
        if (b.overlay_pages?.widgets) setWidgetsUrl(b.overlay_pages.widgets);
      })
      .catch(() => {});
  }, []);

  // Derive overlay base URL + token from the gallery page entry.
  const { base, token } = useMemo(() => {
    const raw = widgetsUrl;
    if (!raw) return { base: null as string | null, token: '' };
    try {
      const u = new URL(raw);
      return { base: u.origin, token: u.searchParams.get('t') ?? '' };
    } catch {
      return { base: null, token: '' };
    }
  }, [widgetsUrl]);

  // Gift names for the <datalist> in gift-type params.
  useEffect(() => {
    if (!base) return;
    fetch(`${base}/gifts/gifts.json?t=${encodeURIComponent(token)}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: { name?: string }[]) =>
        setGiftNames(rows.map((r) => r.name).filter(Boolean) as string[])
      )
      .catch(() => {});
  }, [base, token]);

  const widgetUrl = (
    w: WidgetDef,
    theme: string,
    extra: Record<string, string>,
    demo: boolean
  ) => {
    if (!base) return '';
    const u = new URL(`${base}/widgets/${w.file}`);
    if (token) u.searchParams.set('t', token);
    u.searchParams.set('theme', theme);
    if (w.query) new URLSearchParams(w.query).forEach((v, k) => u.searchParams.set(k, v));
    for (const p of w.params ?? []) {
      const v = (extra[p.key] ?? '').trim();
      if (v) u.searchParams.set(p.key, v);
    }
    if (demo) u.searchParams.set('demo', '1');
    return u.toString();
  };

  const toolsUrl = (page: string) => {
    if (!base) return '';
    const u = new URL(`${base}/widgets/${page}`);
    if (token) u.searchParams.set('t', token);
    return u.toString();
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Библиотека виджетов</h1>
        {base && (
          <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => { const u = toolsUrl('gallery.html'); if (u) openUrl(u).catch(() => navigator.clipboard?.writeText(u).catch(() => {})); }}>
              <ExternalLink size={14} /> Галерея
            </Button>
            <Button size="sm" variant="outline" onClick={() => { const u = toolsUrl('titlemaker.html'); if (u) openUrl(u).catch(() => navigator.clipboard?.writeText(u).catch(() => {})); }}>
              <Palette size={14} /> Титл-мейкер
            </Button>
          </div>
        )}
      </div>
      <p className="text-xs text-muted-foreground -mt-2">
        Превью показывает виджет на демо-событиях; в эфире он реагирует на реальные
        (и на Симулятор). Скопируйте URL → OBS/TikTok LIVE Studio → Browser Source,
        размер {CANVAS_W}×{CANVAS_H}.
      </p>

      {!base && (
        <div className="text-sm text-red-400">
          Оверлей-сервер не запущен — проверьте ошибку сервиса на главном экране.
        </div>
      )}
      {msg && <div className="text-sm text-emerald-400">{msg}</div>}

      {base && (
        <>
          {/* Shared gift-name suggestions for all gift-type params. */}
          <datalist id="ttw-gift-names">
            {giftNames.map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
          <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(330px, 1fr))' }}>
            {WIDGETS.map((w) => (
              <WidgetCard
                key={w.id}
                w={w}
                urlFor={(theme, extra, demo) => widgetUrl(w, theme, extra, demo)}
                onCopied={() => setMsg(`URL «${w.name}» скопирован`)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function ParamControl({
  p,
  value,
  onChange,
}: {
  p: ParamDef;
  value: string;
  onChange: (v: string) => void;
}) {
  const type = p.type ?? 'text';
  const cls = 'bg-input rounded px-2 py-1 text-xs w-full';
  if (type === 'select') {
    return (
      <label className="flex flex-col gap-0.5">
        <span className="text-[0.62rem] text-muted-foreground">{p.label}</span>
        <select className={cls} value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">— по умолчанию —</option>
          {(p.options ?? []).map(([v, l]) => (
            <option key={v} value={v}>{l}</option>
          ))}
        </select>
      </label>
    );
  }
  if (type === 'color') {
    return (
      <label className="flex items-center gap-2">
        <input
          type="color"
          className="h-6 w-9 cursor-pointer rounded border border-border bg-input p-0.5"
          value={value || p.ph || '#ffffff'}
          onChange={(e) => onChange(e.target.value)}
        />
        <span className="text-[0.62rem] text-muted-foreground">{p.label}</span>
      </label>
    );
  }
  return (
    <label className="flex flex-col gap-0.5">
      <span className="text-[0.62rem] text-muted-foreground">{p.label}</span>
      <input
        className={cls}
        type={type === 'number' ? 'number' : 'text'}
        min={type === 'number' ? 0 : undefined}
        placeholder={p.ph}
        list={type === 'gift' ? 'ttw-gift-names' : undefined}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function WidgetCard({
  w,
  urlFor,
  onCopied,
}: {
  w: WidgetDef;
  urlFor: (theme: string, extra: Record<string, string>, demo: boolean) => string;
  onCopied: () => void;
}) {
  const [theme, setTheme] = useState(THEME_LABELS[0][0]);
  const [extra, setExtra] = useState<Record<string, string>>({});
  const [demoObs, setDemoObs] = useState(false);

  // Preview box: measure the real width and scale the 1080-wide canvas.
  const boxRef = useRef<HTMLDivElement>(null);
  const [boxW, setBoxW] = useState(0);
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBoxW(el.clientWidth));
    ro.observe(el);
    setBoxW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const scale = boxW / CANVAS_W;

  // Debounce the iframe URL so typing doesn't reload the preview on
  // every keystroke; the copy URL is always live.
  const url = urlFor(theme, extra, demoObs);
  const demoUrl = urlFor(theme, extra, true);
  // Открытие «на посмотреть» — всегда с demo=1: без эфира виджет
  // иначе отрисовывает пустую сцену и выглядит сломанным.
  const open = () => {
    if (!demoUrl) return;
    openUrl(demoUrl).catch(() => navigator.clipboard?.writeText(demoUrl).catch(() => {}));
  };
  const [previewUrl, setPreviewUrl] = useState(urlFor(theme, extra, true));
  useEffect(() => {
    const t = setTimeout(() => setPreviewUrl(urlFor(theme, extra, true)), 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme, JSON.stringify(extra)]);

  return (
    <Card className="overflow-hidden">
      <CardHeader className="py-2 px-3">
        <CardTitle className="text-sm">{w.name}</CardTitle>
        <p className="text-[0.68rem] text-muted-foreground leading-tight">{w.desc}</p>
      </CardHeader>
      <CardContent className="px-3 pb-3 flex flex-col gap-2">
        <div
          ref={boxRef}
          className="relative rounded overflow-hidden bg-black/60 cursor-zoom-in"
          style={{ height: Math.max(140, CANVAS_H * scale) }}
          title="Клик — открыть виджет в полном размере"
          onClick={open}
        >
          {previewUrl && boxW > 0 && (
            <iframe
              key={previewUrl}
              src={previewUrl}
              title={w.name}
              className="absolute top-0 left-0 pointer-events-none"
              style={{
                width: CANVAS_W,
                height: CANVAS_H,
                border: 0,
                transform: `scale(${scale})`,
                transformOrigin: 'top left',
              }}
              tabIndex={-1}
            />
          )}
        </div>

        <label className="flex flex-col gap-0.5">
          <span className="text-[0.62rem] text-muted-foreground">Тема</span>
          <select
            className="bg-input rounded px-2 py-1 text-xs"
            value={theme}
            onChange={(e) => setTheme(e.target.value)}
          >
            {THEME_LABELS.map(([k, l]) => (
              <option key={k} value={k}>{l} ({k})</option>
            ))}
          </select>
        </label>

        {(w.params ?? []).map((p) => (
          <ParamControl
            key={p.key}
            p={p}
            value={extra[p.key] ?? ''}
            onChange={(v) => setExtra((x) => ({ ...x, [p.key]: v }))}
          />
        ))}

        <label className="flex items-center gap-1.5 text-[0.66rem] text-muted-foreground select-none">
          <input
            type="checkbox"
            checked={demoObs}
            onChange={(e) => setDemoObs(e.target.checked)}
          />
          Добавить демо-данные в URL (тест в OBS)
        </label>

        <div className="flex gap-1.5">
          <Button
            size="sm"
            variant="outline"
            className="flex-1 text-xs"
            onClick={() => {
              navigator.clipboard.writeText(url);
              onCopied();
            }}
          >
            <Copy size={12} /> URL для OBS
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-xs px-2"
            onClick={open}
            title="Открыть в браузере (с демо-данными)"
          >
            <ExternalLink size={12} />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
