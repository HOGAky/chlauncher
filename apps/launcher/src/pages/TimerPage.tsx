/**
 * @file TimerPage.tsx
 * Stream timer app («таймер эфира»): countdown viewers extend via
 * gifts/likes/follows/shares/subs — our own take on the 7x7Time-style
 * app, rendered by /overlay/timer in a capture window.
 * Sections: live clock + controls, event rates, per-gift ±sec rules,
 * and the visual style of the overlay page.
 */
import React, { useEffect, useState } from 'react';
import { MonitorPlay, Pause, Play, Plus, Save, Square, Timer, Trash2 } from 'lucide-react';
import * as api from '../api';
import { humanError } from '../errorMessages';
import type { SubathonCfg, SubathonStatus } from '../types';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Switch } from '../components/ui/switch';

const DEFAULT_CFG: Required<SubathonCfg> = {
  enabled: true,
  start_s: 3600,
  sec_per_coin: 5,
  sec_per_sub: 300,
  sec_per_follow: 10,
  sec_per_share: 20,
  likes_per_add: 100,
  like_add_s: 10,
  max_s: 43200,
  gift_rules: [],
  theme: 'dark',
  accent: '#f472b6',
  scale: 1,
  position: 'center',
  show_feed: true,
  sound: true,
};

function fmt(s: number): string {
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, ss = s % 60;
  const mm = String(m).padStart(2, '0'), sss = String(ss).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${sss}` : `${mm}:${sss}`;
}

const THEMES = [
  { v: 'dark', t: 'Тёмная' },
  { v: 'light', t: 'Светлая' },
  { v: 'neon', t: 'Неон' },
  { v: 'minimal', t: 'Минимал' },
];
const POSITIONS = [
  { v: 'center', t: 'По центру' },
  { v: 'top-right', t: 'Верх справа' },
  { v: 'top-left', t: 'Верх слева' },
  { v: 'bottom-right', t: 'Низ справа' },
  { v: 'bottom-left', t: 'Низ слева' },
];

export default function TimerPage() {
  const [st, setSt] = useState<SubathonStatus | null>(null);
  const [cfg, setCfg] = useState<Required<SubathonCfg>>(DEFAULT_CFG);
  const [startMin, setStartMin] = useState(60);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    const poll = () =>
      api.subathonStatus()
        .then((s) => {
          setSt(s);
          setCfg((c) => ({ ...c, ...s.cfg }));
        })
        .catch(() => {});
    poll();
    const t = setInterval(poll, 1000);
    return () => clearInterval(t);
  }, []);

  const save = () => {
    setErr(''); setMsg('');
    api.saveSubathonCfg(cfg)
      .then(() => setMsg('Сохранено'))
      .catch((e) => setErr(humanError(e)));
  };
  const act = (fn: () => Promise<unknown>) => () => {
    setErr('');
    fn().catch((e) => setErr(humanError(e)));
  };

  const setRule = (i: number, patch: Partial<{ name: string; sec: number }>) =>
    setCfg((c) => ({
      ...c,
      gift_rules: c.gift_rules.map((r, j) => (j === i ? { ...r, ...patch } : r)),
    }));

  const running = st?.running ?? false;
  const paused = st?.paused ?? false;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Timer size={18} /> Таймер эфира
          </h2>
          <p className="text-sm text-muted-foreground">
            Обратный отсчёт, который зрители продлевают подарками, лайками
            и подписками. Открой окно и захвати его в LIVE Studio / OBS.
          </p>
        </div>
        <Badge variant={running ? 'success' : 'outline'}>
          {running ? (paused ? 'Пауза' : 'Идёт') : 'Остановлен'}
        </Badge>
      </div>
      {err && <div className="text-sm text-red-400">{err}</div>}
      {msg && <div className="text-sm text-emerald-400">{msg}</div>}

      {/* Live clock + transport controls */}
      <Card>
        <CardContent className="py-4 flex flex-wrap items-center gap-4">
          <div className="text-4xl font-bold tabular-nums" style={{ color: cfg.accent }}>
            {fmt(st?.remaining_s ?? 0)}
          </div>
          <div className="text-xs text-muted-foreground">
            добавлено зрителями: +{fmt(st?.added_s ?? 0)}
          </div>
          <span className="flex-1" />
          {!running ? (
            <>
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                старт, мин
                <Input type="number" min={1} className="h-8 w-20" value={startMin}
                  onChange={(e) => setStartMin(Number(e.target.value) || 1)} />
              </label>
              <Button size="sm" onClick={act(() => api.subathonStart(Math.max(60, startMin * 60)))}>
                <Play size={14} className="mr-1" /> Старт
              </Button>
            </>
          ) : (
            <>
              {paused ? (
                <Button size="sm" variant="outline" onClick={act(api.subathonResume)}>
                  <Play size={14} className="mr-1" /> Продолжить
                </Button>
              ) : (
                <Button size="sm" variant="outline" onClick={act(api.subathonPause)}>
                  <Pause size={14} className="mr-1" /> Пауза
                </Button>
              )}
              <Button size="sm" variant="destructive" onClick={act(api.subathonStop)}>
                <Square size={14} className="mr-1" /> Стоп
              </Button>
            </>
          )}
          <Button size="sm" variant="secondary" onClick={act(() => api.openOverlayWindow('overlay/timer', false))}>
            <MonitorPlay size={14} className="mr-1" /> Окно
          </Button>
          <Button size="sm" variant="secondary" title="Пурпурный фон для chroma-key"
            onClick={act(() => api.openOverlayWindow('overlay/timer', true))}>
            Chroma
          </Button>
          <Button size="sm" variant="ghost" onClick={act(() => api.closeOverlayWindow('overlay/timer'))}>
            Закрыть
          </Button>
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        {/* Event rates */}
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Сколько времени дают события</CardTitle></CardHeader>
          <CardContent className="grid grid-cols-2 gap-3 text-xs">
            <label className="flex items-center gap-2 text-muted-foreground">
              вкл.
              <Switch checked={cfg.enabled} onCheckedChange={(v) => setCfg({ ...cfg, enabled: v })} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-muted-foreground">потолок, ч</span>
              <Input type="number" min={1} value={Math.round(cfg.max_s / 3600)}
                onChange={(e) => setCfg({ ...cfg, max_s: Math.max(60, (Number(e.target.value) || 1) * 3600) })} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-muted-foreground">сек за коин подарка</span>
              <Input type="number" min={0} value={cfg.sec_per_coin}
                onChange={(e) => setCfg({ ...cfg, sec_per_coin: Number(e.target.value) || 0 })} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-muted-foreground">сек за подписку</span>
              <Input type="number" min={0} value={cfg.sec_per_sub}
                onChange={(e) => setCfg({ ...cfg, sec_per_sub: Number(e.target.value) || 0 })} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-muted-foreground">сек за фоллоу</span>
              <Input type="number" min={0} value={cfg.sec_per_follow}
                onChange={(e) => setCfg({ ...cfg, sec_per_follow: Number(e.target.value) || 0 })} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-muted-foreground">сек за репост</span>
              <Input type="number" min={0} value={cfg.sec_per_share}
                onChange={(e) => setCfg({ ...cfg, sec_per_share: Number(e.target.value) || 0 })} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-muted-foreground">лайков за плюс</span>
              <Input type="number" min={0} value={cfg.likes_per_add}
                onChange={(e) => setCfg({ ...cfg, likes_per_add: Number(e.target.value) || 0 })} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-muted-foreground">сек за пачку лайков</span>
              <Input type="number" min={0} value={cfg.like_add_s}
                onChange={(e) => setCfg({ ...cfg, like_add_s: Number(e.target.value) || 0 })} />
            </label>
          </CardContent>
        </Card>

        {/* Per-gift rules */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Правила по подаркам (± сек за штуку)</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-xs">
            <p className="text-muted-foreground">
              Точное имя подарка заменяет ставку за коин. Отрицательное значение
              крадёт время («Rose −10с»).
            </p>
            {cfg.gift_rules.map((r, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input className="h-8 flex-1" placeholder="Rose" value={r.name}
                  onChange={(e) => setRule(i, { name: e.target.value })} />
                <Input className="h-8 w-24" type="number" value={r.sec}
                  onChange={(e) => setRule(i, { sec: Number(e.target.value) || 0 })} />
                <Button size="sm" variant="ghost"
                  onClick={() => setCfg({ ...cfg, gift_rules: cfg.gift_rules.filter((_, j) => j !== i) })}>
                  <Trash2 size={14} />
                </Button>
              </div>
            ))}
            <Button size="sm" variant="outline"
              onClick={() => setCfg({ ...cfg, gift_rules: [...cfg.gift_rules, { name: '', sec: 30 }] })}>
              <Plus size={14} className="mr-1" /> Правило
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* Style */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">Вид таймера</CardTitle></CardHeader>
        <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-3 text-xs">
          <label className="flex items-center gap-2 text-muted-foreground">
            тема
            <select className="h-8 rounded-md border border-input bg-secondary/40 px-2"
              value={cfg.theme} onChange={(e) => setCfg({ ...cfg, theme: e.target.value })}>
              {THEMES.map((t) => <option key={t.v} value={t.v}>{t.t}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-2 text-muted-foreground">
            акцент
            <input type="color" className="h-8 w-10 rounded border border-input bg-secondary/40"
              value={cfg.accent} onChange={(e) => setCfg({ ...cfg, accent: e.target.value })} />
          </label>
          <label className="flex items-center gap-2 text-muted-foreground">
            позиция
            <select className="h-8 rounded-md border border-input bg-secondary/40 px-2"
              value={cfg.position} onChange={(e) => setCfg({ ...cfg, position: e.target.value })}>
              {POSITIONS.map((p) => <option key={p.v} value={p.v}>{p.t}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-2 text-muted-foreground">
            масштаб
            <input type="range" min={0.5} max={2} step={0.1} value={cfg.scale}
              onChange={(e) => setCfg({ ...cfg, scale: Number(e.target.value) })} />
            <span>{cfg.scale.toFixed(1)}×</span>
          </label>
          <label className="flex items-center gap-2 text-muted-foreground">
            лента +сек
            <Switch checked={cfg.show_feed} onCheckedChange={(v) => setCfg({ ...cfg, show_feed: v })} />
          </label>
          <label className="flex items-center gap-2 text-muted-foreground">
            звук
            <Switch checked={cfg.sound} onCheckedChange={(v) => setCfg({ ...cfg, sound: v })} />
          </label>
          <span className="flex-1" />
          <Button size="sm" onClick={save}><Save size={14} className="mr-1" /> Сохранить</Button>
        </CardContent>
      </Card>
    </div>
  );
}
