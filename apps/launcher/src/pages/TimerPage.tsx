/**
 * @file TimerPage.tsx
 * EFIR-style stream timer («таймер эфира»): countdown viewers extend and
 * mess with — gifts/likes/follows add or steal seconds, trigger gifts
 * fire shield/reverse/ruiner/save/multiplier effects, roulettes spin
 * weighted slots. Engine: src-tauri/src/efirtimer.rs; widgets:
 * efirtimer.html / efirroll.html / efirstats.html on the overlay server.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Copy, ExternalLink, MonitorPlay, Pause, Play, Plus, Save, Shield, Square, Timer, Trash2, Undo2, X } from 'lucide-react';
import { openUrl } from '@tauri-apps/plugin-opener';
import * as api from '../api';
import { useApp } from '../App';
import GiftPicker from '../components/GiftPicker';
import { humanError } from '../errorMessages';
import { useVisibleInterval } from '../lib/utils';
import type { EfirTimerCfg, EfirTimerStatus } from '../types';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Switch } from '../components/ui/switch';

const uid = () => Math.random().toString(36).slice(2, 10);
const ids = (s: string) => s.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
const idsStr = (a?: string[]) => (a || []).join(', ');

const DEFAULT_CFG: EfirTimerCfg = {
  enabled: true,
  donationMode: 'gifts',
  walletCommands: {},
  uptimeRouletteId: '',
  uptimeStartTime: '',
  defaultGiftsEnabled: true,
  defaultGiftSeconds: 1,
  initialTime: 60,
  bonusEnabled: true, bonusMin: 60, bonusMax: 300,
  isFreezeEnabled: false, giftFreezeIds: [], freezeDuration: 60,
  giftUnfreezeIds: [], unfreezeDuration: 60, unfreezeWorksWhenShielded: false,
  isReverseEnabled: false, giftReverseIds: [], reverseWorksWhenShielded: false,
  isRuinerEnabled: false, giftRuinerIds: [], ruinerDuration: 60,
  ruinerMinTime: 60, ruinerMaxTime: 300,
  giftSaveIds: [], ruinerWorksWhenShielded: false, saveWorksWhenShielded: false,
  isMultiplierGiftEnabled: true, multiplierValue: 2, multiplierDuration: 60,
  giftMultiplierIds: [], multiplierWorksWhenShielded: false,
  isDebuffGiftEnabled: false, debuffValue: 2, debuffDuration: 60,
  giftDebuffIds: [], debuffWorksWhenShielded: false,
  isSetTimeEnabled: false, giftSetTimeIds: [], setTimeValue: 300, setTimeWorksWhenShielded: false,
  isResetEnabled: false, giftResetIds: [], resetWorksWhenShielded: false,
  isPenaltyEnabled: false, penalties: [],
  customTriggers: [],
  likesEnabled: true, likeThreshold: 100, likeTime: 10, likesWorksWhenShielded: false,
  subsEnabled: true, subTime: 300, subsWorksWhenShielded: false,
  roulettes: [],
  soundMap: {},
  styles: {
    themeId: 'roulette',
    roulettePrimary: '#6366f1', rouletteSecondary: '#f59e0b',
    rouletteSurface: '#111827', rouletteText: '#ffffff',
    fontFamily: 'Russo One, sans-serif',
    timerColor: '#ffffff', timerGlow: 0.4, enableStroke: true,
    buffColor: '#34d399', debuffColor: '#f43f5e',
    floatPlusColor: '#34d399', floatMinusColor: '#f87171',
    buffCardBg: '#10b981', debuffCardBg: '#e11d48',
    statsTransparent: false, statsUptimeLabel: '', statsLikesLabel: '',
  },
  volume: 0.5,
};

const THEMES = [
  { id: 'roulette', n: 'Рулетка', c: { roulettePrimary: '#6366f1', rouletteSecondary: '#f59e0b', rouletteSurface: '#111827', timerColor: '#ffffff', buffColor: '#34d399', debuffColor: '#f43f5e', floatPlusColor: '#34d399', floatMinusColor: '#f87171' } },
  { id: 'neon', n: 'Неон', c: { roulettePrimary: '#22d3ee', rouletteSecondary: '#e879f9', rouletteSurface: '#0b1020', timerColor: '#22d3ee', buffColor: '#4ade80', debuffColor: '#fb7185', floatPlusColor: '#4ade80', floatMinusColor: '#fb7185' } },
  { id: 'cyber', n: 'Кибер', c: { roulettePrimary: '#f0abfc', rouletteSecondary: '#fde047', rouletteSurface: '#18181b', timerColor: '#fde047', buffColor: '#a3e635', debuffColor: '#f87171', floatPlusColor: '#a3e635', floatMinusColor: '#f87171' } },
  { id: 'ocean', n: 'Океан', c: { roulettePrimary: '#38bdf8', rouletteSecondary: '#2dd4bf', rouletteSurface: '#082f49', timerColor: '#7dd3fc', buffColor: '#34d399', debuffColor: '#fb923c', floatPlusColor: '#34d399', floatMinusColor: '#fb923c' } },
  { id: 'ice', n: 'Лёд', c: { roulettePrimary: '#93c5fd', rouletteSecondary: '#e0f2fe', rouletteSurface: '#0c4a6e', timerColor: '#e0f2fe', buffColor: '#67e8f9', debuffColor: '#fda4af', floatPlusColor: '#67e8f9', floatMinusColor: '#fda4af' } },
  { id: 'sunset', n: 'Закат', c: { roulettePrimary: '#fb923c', rouletteSecondary: '#f43f5e', rouletteSurface: '#431407', timerColor: '#fdba74', buffColor: '#a3e635', debuffColor: '#f43f5e', floatPlusColor: '#a3e635', floatMinusColor: '#f43f5e' } },
  { id: 'sakura', n: 'Сакура', c: { roulettePrimary: '#f9a8d4', rouletteSecondary: '#fbcfe8', rouletteSurface: '#500724', timerColor: '#fbcfe8', buffColor: '#86efac', debuffColor: '#fb7185', floatPlusColor: '#86efac', floatMinusColor: '#fb7185' } },
  { id: 'emerald', n: 'Изумруд', c: { roulettePrimary: '#34d399', rouletteSecondary: '#a7f3d0', rouletteSurface: '#022c22', timerColor: '#a7f3d0', buffColor: '#4ade80', debuffColor: '#f87171', floatPlusColor: '#4ade80', floatMinusColor: '#f87171' } },
  { id: 'ruby', n: 'Рубин', c: { roulettePrimary: '#f43f5e', rouletteSecondary: '#fda4af', rouletteSurface: '#4c0519', timerColor: '#fecdd3', buffColor: '#4ade80', debuffColor: '#fb7185', floatPlusColor: '#4ade80', floatMinusColor: '#fb7185' } },
  { id: 'gold', n: 'Золото', c: { roulettePrimary: '#fbbf24', rouletteSecondary: '#fde68a', rouletteSurface: '#451a03', timerColor: '#fde68a', buffColor: '#84cc16', debuffColor: '#f87171', floatPlusColor: '#84cc16', floatMinusColor: '#f87171' } },
  { id: 'lavender', n: 'Лаванда', c: { roulettePrimary: '#a78bfa', rouletteSecondary: '#ddd6fe', rouletteSurface: '#2e1065', timerColor: '#ddd6fe', buffColor: '#6ee7b7', debuffColor: '#fda4af', floatPlusColor: '#6ee7b7', floatMinusColor: '#fda4af' } },
  { id: 'mono', n: 'Моно', c: { roulettePrimary: '#e5e7eb', rouletteSecondary: '#9ca3af', rouletteSurface: '#111111', timerColor: '#f3f4f6', buffColor: '#d1d5db', debuffColor: '#6b7280', floatPlusColor: '#d1d5db', floatMinusColor: '#6b7280' } },
];

const SLOT_KINDS = [
  { v: 'add_time', t: '+время' }, { v: 'sub_time', t: '−время' },
  { v: 'set_time', t: 'установить' }, { v: 'reset_time', t: 'сброс' },
  { v: 'multiply_time', t: 'время xN' }, { v: 'divide_time', t: 'время /N' },
  { v: 'freeze', t: 'щит' }, { v: 'unfreeze', t: 'снять щит' },
  { v: 'reverse_time', t: 'реверс' }, { v: 'extra_spin', t: 'ещё прокрут' },
  { v: 'ruiner', t: 'руинер' }, { v: 'save', t: 'сейв' },
  { v: 'multiplier', t: 'буст xN' }, { v: 'debuff', t: 'дебафф xN' },
  { v: 'special', t: 'текст' },
];

function fmtT(s: number): string {
  const neg = s < 0; s = Math.abs(Math.floor(s));
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, ss = s % 60;
  return (neg ? '-' : '') + (h ? `${h}:${String(m).padStart(2, '0')}:` : '') + `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

export default function TimerPage() {
  const { boot } = useApp();
  const [st, setSt] = useState<EfirTimerStatus | null>(null);
  const [cfg, setCfg] = useState<EfirTimerCfg>(DEFAULT_CFG);
  const [startMin, setStartMin] = useState(60);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [spinSel, setSpinSel] = useState('');
  const [wins, setWins] = useState<Record<string, boolean>>({});
  const fileRef = React.useRef<HTMLInputElement>(null);

  // Overlay base+token — live preview iframe + OBS links. Boot can be
  // stale after token rotation → re-read fresh bootstrap once.
  const [widgetsUrl, setWidgetsUrl] = useState(boot?.overlay_pages?.widgets ?? null);
  useEffect(() => {
    api.getBootstrap()
      .then((b) => b.overlay_pages?.widgets && setWidgetsUrl(b.overlay_pages.widgets))
      .catch(() => {});
  }, []);
  const { base, token } = useMemo(() => {
    if (!widgetsUrl) return { base: null as string | null, token: '' };
    try {
      const u = new URL(widgetsUrl);
      return { base: u.origin, token: u.searchParams.get('t') ?? '' };
    } catch {
      return { base: null, token: '' };
    }
  }, [widgetsUrl]);
  const widgetUrl = (file: string) =>
    base ? `${base}/widgets/${file}?t=${encodeURIComponent(token)}` : '';

  const toggleWin = (kind: 'timer' | 'roll' | 'stats' | 'pult') => {
    if (wins[kind]) {
      api.closeTimerWindow(kind).catch(() => {});
      setWins((w) => ({ ...w, [kind]: false }));
    } else {
      api.openTimerWindow(kind)
        .then(() => setWins((w) => ({ ...w, [kind]: true })))
        .catch((e) => setErr(humanError(e)));
    }
  };

  // cfg грузим ОДИН раз — иначе секундный поллинг затирает несохранённые
  // правки (галочки «сами выключаются»). Статус опрашиваем отдельно.
  const cfgLoaded = React.useRef(false);
  useEffect(() => {
    api.efirtimerStatus()
      .then((s) => { setSt(s); setCfg((c) => ({ ...c, ...(s.cfg || {}) })); cfgLoaded.current = true; })
      .catch(() => {});
  }, []);

  useVisibleInterval(() => {
    api.efirtimerStatus().then(setSt).catch(() => {});
  }, 1000, false);

  const state = st?.state;
  const save = () => {
    setErr(''); setMsg('');
    api.saveEfirtimerCfg(cfg)
      .then(() => setMsg('Сохранено'))
      .catch((e) => setErr(humanError(e)));
  };
  const run = (p: Promise<unknown>) => p.catch((e) => setErr(humanError(e)));
  const manual = (action: string, secs?: number, rouletteId?: string) =>
    run(api.efirtimerManual(action, secs, rouletteId));

  const set = <K extends keyof EfirTimerCfg>(k: K, v: EfirTimerCfg[K]) =>
    setCfg((c) => ({ ...c, [k]: v }));
  const setStyle = <K extends keyof EfirTimerCfg['styles']>(k: K, v: EfirTimerCfg['styles'][K]) =>
    setCfg((c) => ({ ...c, styles: { ...c.styles, [k]: v } }));

  const Num = ({ v, on, w = 90 }: { v: number; on: (n: number) => void; w?: number }) => (
    <Input type="number" value={v} style={{ width: w }}
      onChange={(e) => on(Number(e.target.value) || 0)} />
  );
  const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div className="flex items-center gap-3 py-1.5">
      <span className="w-56 text-sm text-zinc-400">{label}</span>
      <div className="flex items-center gap-2 flex-wrap">{children}</div>
    </div>
  );
  const GiftIds = ({ v, on }: { v: string[]; on: (a: string[]) => void }) => (
    <>
      <Input placeholder="подарки через запятую" value={idsStr(v)}
        className="w-64" onChange={(e) => on(ids(e.target.value))} />
      <GiftPicker onPick={(n) => on([...(v || []), n])} />
    </>
  );
  const ShieldFlag = ({ v, on }: { v: boolean; on: (b: boolean) => void }) => (
    <label className="flex items-center gap-1.5 text-xs text-zinc-500">
      <Switch checked={v} onCheckedChange={on} /> под щитом
    </label>
  );

  const trig = (
    title: string, enKey: keyof EfirTimerCfg, idsKey: keyof EfirTimerCfg,
    extra?: React.ReactNode, shieldKey?: keyof EfirTimerCfg,
  ) => (
    <Row label={title}>
      <Switch checked={!!cfg[enKey]} onCheckedChange={(b) => set(enKey, b as never)} />
      <GiftIds v={(cfg[idsKey] as string[]) || []} on={(a) => set(idsKey, a as never)} />
      {extra}
      {shieldKey && <ShieldFlag v={!!cfg[shieldKey]} on={(b) => set(shieldKey, b as never)} />}
    </Row>
  );

  // ---- EFIR-стиль: подарок + команда из чата + цена + звук + «при щите» ----
  const WCmd = ({ rowId }: { rowId: string }) => {
    const wc = (cfg.walletCommands || {})[rowId];
    const put = (patch: Partial<import('../types').EfirWalletCmd>) =>
      set('walletCommands', {
        ...(cfg.walletCommands || {}),
        [rowId]: { ...{ command: '', price: 0 }, ...(wc || {}), ...patch },
      });
    return (
      <>
        <div className="flex-1 min-w-[130px]">
          <div className="text-[10px] text-zinc-500 mb-0.5">КОМАНДА ИЗ ЧАТА</div>
          <Input value={wc?.command || ''} placeholder="!команда"
            onChange={(e) => {
              let v = e.target.value.trim().toLowerCase();
              if (v && !v.startsWith('!')) v = '!' + v;
              put({ command: v });
            }} />
        </div>
        <div className="w-24">
          <div className="text-[10px] text-zinc-500 mb-0.5">СТОИМОСТЬ</div>
          <Num v={wc?.price || 0} w={96} on={(n) => put({ price: n })} />
        </div>
      </>
    );
  };
  const Spec = ({ v, on }: { v: import('../types').EfirSound | undefined; on: (s: import('../types').EfirSound) => void }) => {
    const sp = typeof v === 'object' && v
      ? v : { media: (v as string) || '', trimStartMs: 0, trimEndMs: 0, volume: 1 };
    return (
      <div className="flex items-center gap-2 flex-wrap rounded-md border border-zinc-800 bg-zinc-900/40 px-2 py-1.5">
        <Input value={sp.media} placeholder="🔊 звук: media id" className="w-44 h-8"
          onChange={(e) => on({ ...sp, media: e.target.value.trim() })} />
        <span className="text-[10px] text-zinc-500">до</span>
        <Num v={sp.trimEndMs} w={64} on={(n) => on({ ...sp, trimEndMs: n })} />
        <span className="text-[10px] text-zinc-500">мс</span>
        <Num v={Math.round((sp.volume ?? 1) * 100)} w={56}
          on={(n) => on({ ...sp, volume: Math.max(0, Math.min(1, n / 100)) })} />
        <span className="text-[10px] text-zinc-500">%</span>
      </div>
    );
  };
  // Одна «половина» EFIR-карточки: подарок / команда+цена / звук / флаги / extra.
  const Sub = ({ title, idsKey, rowId, soundKey, shieldKey, children }: {
    title: string; idsKey: keyof EfirTimerCfg; rowId: string;
    soundKey?: string; shieldKey?: keyof EfirTimerCfg; children?: React.ReactNode;
  }) => (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-3 space-y-2.5 flex-1 min-w-[280px]">
      <div className="text-[10px] font-semibold tracking-wider text-zinc-500">{title}</div>
      <GiftIds v={(cfg[idsKey] as string[]) || []} on={(a) => set(idsKey, a as never)} />
      <div className="flex gap-2 flex-wrap"><WCmd rowId={rowId} /></div>
      {soundKey && (
        <Spec v={(cfg.soundMap || {})[soundKey]}
          on={(s) => set('soundMap', { ...(cfg.soundMap || {}), [soundKey]: s })} />
      )}
      {children}
      {shieldKey && (
        <label className="flex items-center gap-2 text-xs text-zinc-400">
          <Switch checked={!!cfg[shieldKey]} onCheckedChange={(b) => set(shieldKey, b as never)} />
          Работает при щите
        </label>
      )}
    </div>
  );
  // EFIR-секция: заголовок + переключатель справа + подкарточки.
  const TrigSection = ({ title, desc, en, children }: {
    title: string; desc?: string; en: keyof EfirTimerCfg; children: React.ReactNode;
  }) => (
    <div className="rounded-xl border border-zinc-800 p-3.5 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="font-semibold">{title}</div>
          {desc && <div className="text-xs text-zinc-500">{desc}</div>}
        </div>
        <Switch checked={!!cfg[en]} onCheckedChange={(b) => set(en, b as never)} />
      </div>
      {!!cfg[en] && <div className="flex gap-3 flex-wrap">{children}</div>}
    </div>
  );

  return (
    <div className="space-y-4 pb-10">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold flex items-center gap-2"><Timer /> Таймер эфира</h1>
        <div className="flex gap-2">
          <input ref={fileRef} type="file" accept=".json" className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (!f) return;
              f.text().then((text) => api.efirtimerImport(text)
                .then((c) => { setCfg((old) => ({ ...old, ...c })); setMsg('Конфиг EFIR импортирован'); setErr(''); })
                .catch((x) => setErr(humanError(x))));
            }} />
          <Button variant="outline" onClick={() => fileRef.current?.click()}>
            Импорт EFIR-конфига</Button>
          <Button onClick={save}><Save className="mr-1 h-4 w-4" />Сохранить</Button>
        </div>
      </div>
      {msg && <div className="text-sm text-emerald-400">{msg}</div>}
      {err && <div className="text-sm text-red-400">{err}</div>}

      {/* ---- live clock + пульт ---- */}
      <Card>
        <CardHeader><CardTitle className="flex items-center gap-3">
          Пульт
          {state && (
            <span className="font-mono text-3xl" style={{
              color: state.isFrozen ? '#34d399' : state.isReversed ? '#ff4dd2'
                : state.timeLeft < 300 && state.timeLeft > 0 ? '#ff3b3b' : '#fff',
            }}>{fmtT(state.timeLeft)}</span>
          )}
          <div className="flex gap-1.5 ml-3">
            {state?.isVictory && <Badge>ПОБЕДА</Badge>}
            {state?.isFrozen && <Badge variant="outline">ЩИТ {fmtT(state.freezeTimeLeft)}</Badge>}
            {state?.isReversed && <Badge variant="outline">РЕВЕРС</Badge>}
            {state?.multiplier?.active && (
              <Badge variant="outline">{state.multiplier.type === 'debuff' ? '−' : ''}x{state.multiplier.value} {fmtT(state.multiplier.timeLeft)}</Badge>
            )}
            {state?.ruiner?.active && <Badge variant="destructive">РУИНЕР {fmtT(state.ruiner.timeLeft)}</Badge>}
            {(state?.ruinerPending ?? 0) > 0 && <Badge variant="outline">бомб в очереди: {state?.ruinerPending}</Badge>}
          </div>
        </CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <Num v={startMin} on={setStartMin} w={80} /> <span className="text-sm text-zinc-400">мин</span>
            <Button onClick={() => run(api.efirtimerStart(startMin * 60))}><Play className="h-4 w-4 mr-1" />Старт</Button>
            {state?.isRunning
              ? <Button variant="outline" onClick={() => run(api.efirtimerPause())}><Pause className="h-4 w-4 mr-1" />Пауза</Button>
              : <Button variant="outline" onClick={() => run(api.efirtimerResume())}><Play className="h-4 w-4 mr-1" />Продолжить</Button>}
            <Button variant="destructive" onClick={() => run(api.efirtimerStop())}><Square className="h-4 w-4 mr-1" />Стоп</Button>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Button variant="outline" onClick={() => manual('add', 60)}>+1 мин</Button>
            <Button variant="outline" onClick={() => manual('add', 600)}>+10 мин</Button>
            <Button variant="outline" onClick={() => manual('sub', 60)}>−1 мин</Button>
            <Button variant="outline" onClick={() => manual('sub', 600)}>−10 мин</Button>
            <Button variant="outline" onClick={() => manual('freeze')}><Shield className="h-4 w-4 mr-1" />Щит</Button>
            <Button variant="outline" onClick={() => manual('unfreeze')}><Undo2 className="h-4 w-4 mr-1" />Снять щит</Button>
            <Button variant="outline" onClick={() => manual('reverse')}>Реверс</Button>
            <Button variant="outline" onClick={() => manual('ruiner')}>Руинер</Button>
            <Button variant="outline" onClick={() => manual('save')}>Сейв</Button>
            <select className="h-9 rounded-md border bg-transparent px-2 text-sm" value={spinSel}
              onChange={(e) => setSpinSel(e.target.value)}>
              <option value="">— рулетка —</option>
              {cfg.roulettes.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
            <Button variant="outline" onClick={() => manual('spin', undefined, spinSel || undefined)}>Крутануть</Button>
          </div>
          {/* Кнопки рулеток «в пульте» с их цветами (showInRemote) */}
          {cfg.roulettes.some((r) => r.showInRemote && r.isEnabled) && (
            <div className="flex items-center gap-2 flex-wrap">
              {cfg.roulettes.filter((r) => r.showInRemote && r.isEnabled).map((r) => (
                <Button key={r.id} variant="outline"
                  style={r.remoteButtonColor ? { borderColor: r.remoteButtonColor, color: r.remoteButtonColor } : undefined}
                  onClick={() => manual('spin', undefined, r.id)}>
                  {r.mode === 'cards' ? '🂠 ' : ''}{r.name || 'Рулетка'}
                </Button>
              ))}
            </div>
          )}
          {/* Активный «ход судьбы» — выбор карты за донатера */}
          {st?.card && st.card.phase === 'waiting' && (
            <div className="flex items-center gap-2 flex-wrap border rounded-md p-2 border-indigo-500/50">
              <span className="text-sm">🂠 {st.card.rouletteName}: {st.card.user?.username} выбирает карту —</span>
              {st.card.cards.map((_, i) => (
                <Button key={i} size="sm" variant="outline"
                  onClick={() => run(api.efirtimerCardPick(i))}>{i + 1}</Button>
              ))}
            </div>
          )}
          <div className="text-xs text-zinc-500">
            Виджеты для OBS: «Виджеты» → EFIR Таймер / EFIR Рулетка / EFIR Статистика.
          </div>
        </CardContent>
      </Card>

      {/* ---- окна: виджеты по ссылкам, пульт — отдельное окно ---- */}
      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><MonitorPlay className="h-5 w-5" /> Окна на стрим</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <Button variant={wins.pult ? 'destructive' : 'default'} onClick={() => toggleWin('pult')}>
              {wins.pult ? <><X className="h-4 w-4 mr-1" />Закрыть пульт</> : '🎛 Пульт управления'}
            </Button>
            {([['timer', 'Таймер'], ['roll', 'Рулетка'], ['stats', 'Статистика']] as const).map(([k, label]) => (
              <Button key={k} variant={wins[k] ? 'destructive' : 'ghost'} size="sm" onClick={() => toggleWin(k)}>
                {wins[k] ? <><X className="h-4 w-4 mr-1" />Закрыть: {label}</> : <><ExternalLink className="h-4 w-4 mr-1" />{label} (окно)</>}
              </Button>
            ))}
          </div>
          <div className="text-xs text-zinc-500">
            Пульт — отдельное окно поверх всех приложений (как «Пульт TIMER» у EFIR).
            Виджеты на стрим — по ссылкам ниже (OBS Browser Source).
          </div>
          <div className="space-y-1.5">
            {([['efirtimer.html', 'Таймер (OBS)'], ['efirroll.html', 'Рулетка (OBS)'], ['efirstats.html', 'Статистика (OBS)']] as const).map(([f, label]) => (
              <div key={f} className="flex items-center gap-2">
                <span className="w-36 text-sm text-zinc-400">{label}</span>
                <Input readOnly value={widgetUrl(f)} className="flex-1 text-xs font-mono" onFocus={(e) => e.target.select()} />
                <Button size="sm" variant="ghost" onClick={() => navigator.clipboard?.writeText(widgetUrl(f)).then(() => setMsg('Ссылка скопирована'))}>
                  <Copy className="h-4 w-4" />
                </Button>
                <Button size="sm" variant="ghost" onClick={() => openUrl(widgetUrl(f)).catch(() => {})}>
                  <ExternalLink className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* ---- основное ---- */}
      <Card>
        <CardHeader><CardTitle>Основное</CardTitle></CardHeader>
        <CardContent>
          <Row label="Таймер включён"><Switch checked={cfg.enabled} onCheckedChange={(b) => set('enabled', b)} /></Row>
          <Row label="Режим донатов">
            <select className="h-9 rounded-md border bg-transparent px-2 text-sm" value={cfg.donationMode}
              onChange={(e) => set('donationMode', e.target.value)}>
              <option value="gifts">Подарки → сразу эффекты</option>
              <option value="balance">Кошельки + чат-команды</option>
            </select>
            <span className="text-xs text-zinc-500">
              {cfg.donationMode === 'balance'
                ? 'монеты подарков копятся на балансе зрителя; !команды в чате'
                : 'подарки сразу бьют по триггерам'}
            </span>
          </Row>
          <Row label="Режим донатов">
            <select className="h-9 rounded-md border bg-transparent px-2 text-sm" value={cfg.donationMode}
              onChange={(e) => set('donationMode', e.target.value)}>
              <option value="gifts">Подарки → сразу эффекты</option>
              <option value="balance">Кошельки + чат-команды</option>
            </select>
            <span className="text-xs text-zinc-500">
              {cfg.donationMode === 'balance'
                ? 'монеты подарков копятся на балансе зрителя; !команды в чате'
                : 'подарки сразу бьют по триггерам'}
            </span>
          </Row>
          <Row label="Любой подарок даёт время">
            <Switch checked={cfg.defaultGiftsEnabled} onCheckedChange={(b) => set('defaultGiftsEnabled', b)} />
            <Num v={cfg.defaultGiftSeconds} on={(n) => set('defaultGiftSeconds', n)} /> <span className="text-sm">сек/монета</span>
          </Row>
          <Row label="Бонусный прокрут при 0">
            <Switch checked={cfg.bonusEnabled} onCheckedChange={(b) => set('bonusEnabled', b)} />
            <Num v={cfg.bonusMin} on={(n) => set('bonusMin', n)} />–<Num v={cfg.bonusMax} on={(n) => set('bonusMax', n)} /> <span className="text-sm">сек</span>
          </Row>
          <Row label="Лайки зрителя → время">
            <Switch checked={cfg.likesEnabled} onCheckedChange={(b) => set('likesEnabled', b)} />
            каждые <Num v={cfg.likeThreshold} on={(n) => set('likeThreshold', n)} /> лайков = +
            <Num v={cfg.likeTime} on={(n) => set('likeTime', n)} /> сек
            <ShieldFlag v={cfg.likesWorksWhenShielded} on={(b) => set('likesWorksWhenShielded', b)} />
          </Row>
          <Row label="Подписка (фоллов) → время">
            <Switch checked={cfg.subsEnabled} onCheckedChange={(b) => set('subsEnabled', b)} /> +
            <Num v={cfg.subTime} on={(n) => set('subTime', n)} /> сек
            <ShieldFlag v={cfg.subsWorksWhenShielded} on={(b) => set('subsWorksWhenShielded', b)} />
          </Row>
          <Row label="Громкость звуков">
            <input type="range" min={0} max={1} step={0.05} value={cfg.volume}
              onChange={(e) => set('volume', Number(e.target.value))} className="w-48" />
            <span className="text-sm">{Math.round(cfg.volume * 100)}%</span>
          </Row>
        </CardContent>
      </Card>

      {/* ---- gift triggers (EFIR-раскладка) ---- */}
      <Card>
        <CardHeader><CardTitle>Баффы, Штрафы и Щит</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <TrigSection title="Руинер и Сейв" en="isRuinerEnabled"
            desc="Взрывает отсчёт; при взрыве — прокрут рулетки с добавлением времени">
            <Sub title="ПОДАРОК РУИНЕРА" idsKey="giftRuinerIds" rowId="ruin"
              soundKey="ruiner" shieldKey="ruinerWorksWhenShielded">
              <div className="flex items-center gap-2 flex-wrap text-xs text-zinc-500">
                время на раздумье <Num v={cfg.ruinerDuration} w={70} on={(n) => set('ruinerDuration', n)} />с,
                диапазон при проигрыше <Num v={cfg.ruinerMinTime} w={70} on={(n) => set('ruinerMinTime', n)} />–
                <Num v={cfg.ruinerMaxTime} w={70} on={(n) => set('ruinerMaxTime', n)} />с
              </div>
            </Sub>
            <Sub title="ПОДАРОК СЕЙВА" idsKey="giftSaveIds" rowId="save"
              soundKey="save" shieldKey="saveWorksWhenShielded" />
          </TrigSection>

          <TrigSection title="Щит таймера" en="isFreezeEnabled"
            desc="Замораживает отсчёт на время прочности щита">
            <Sub title="УСТАНОВИТЬ ЩИТ" idsKey="giftFreezeIds" rowId="freeze" soundKey="freeze">
              <div className="flex items-center gap-2 text-xs text-zinc-500">
                прочность щита <Num v={cfg.freezeDuration} w={70} on={(n) => set('freezeDuration', n)} />с
              </div>
            </Sub>
            <Sub title="СНЯТЬ ЩИТ" idsKey="giftUnfreezeIds" rowId="unfreeze"
              shieldKey="unfreezeWorksWhenShielded">
              <div className="flex items-center gap-2 text-xs text-zinc-500">
                −<Num v={cfg.unfreezeDuration} w={70} on={(n) => set('unfreezeDuration', n)} />с щита
              </div>
            </Sub>
          </TrigSection>

          <TrigSection title="Разворот времени" en="isReverseEnabled"
            desc="Время начинает тикать в обратную сторону">
            <Sub title="ПОДАРОК РАЗВОРОТА" idsKey="giftReverseIds" rowId="reverse"
              soundKey="reverse_time" shieldKey="reverseWorksWhenShielded" />
          </TrigSection>

          <TrigSection title="Буст и Дебафф" en="isMultiplierGiftEnabled"
            desc="Множители к добавлению / отниманию времени">
            <Sub title="ПОДАРОК БУСТА (xN к +)" idsKey="giftMultiplierIds" rowId="boost"
              soundKey="multiplier" shieldKey="multiplierWorksWhenShielded">
              <div className="flex items-center gap-2 text-xs text-zinc-500">
                x<Num v={cfg.multiplierValue} w={64} on={(n) => set('multiplierValue', n)} /> на
                <Num v={cfg.multiplierDuration} w={70} on={(n) => set('multiplierDuration', n)} />с
              </div>
            </Sub>
            <Sub title="ПОДАРОК ДЕБАФФА (xN к −)" idsKey="giftDebuffIds" rowId="debuff"
              soundKey="debuff" shieldKey="debuffWorksWhenShielded">
              <div className="flex items-center gap-2 text-xs text-zinc-500">
                x<Num v={cfg.debuffValue} w={64} on={(n) => set('debuffValue', n)} /> на
                <Num v={cfg.debuffDuration} w={70} on={(n) => set('debuffDuration', n)} />с
                <Switch checked={cfg.isDebuffGiftEnabled} onCheckedChange={(b) => set('isDebuffGiftEnabled', b)} />
              </div>
            </Sub>
          </TrigSection>

          <TrigSection title="Установить время и Сброс" en="isSetTimeEnabled"
            desc="Подарок ставит точное время или обнуляет таймер (ПОБЕДА)">
            <Sub title="УСТАНОВИТЬ ВРЕМЯ" idsKey="giftSetTimeIds" rowId="settime"
              shieldKey="setTimeWorksWhenShielded">
              <div className="flex items-center gap-2 text-xs text-zinc-500">
                ставит <Num v={cfg.setTimeValue} w={80} on={(n) => set('setTimeValue', n)} />с
              </div>
            </Sub>
            <Sub title="СБРОС (ПОБЕДА)" idsKey="giftResetIds" rowId="reset"
              shieldKey="resetWorksWhenShielded">
              <label className="flex items-center gap-2 text-xs text-zinc-400">
                <Switch checked={cfg.isResetEnabled} onCheckedChange={(b) => set('isResetEnabled', b)} /> включён
              </label>
            </Sub>
          </TrigSection>
        </CardContent>
      </Card>

      {/* ---- penalties ---- */}
      <Card>
        <CardHeader><CardTitle className="flex items-center justify-between">
          Штрафы (крадут время)
          <Button size="sm" variant="outline" onClick={() => set('penalties', [...cfg.penalties,
            { id: uid(), name: 'Штраф', giftIds: [], penaltyAmount: 600, penaltyThreshold: 300, isEnabled: true, worksWhenShielded: false }])}>
            <Plus className="h-4 w-4 mr-1" />Штраф</Button>
        </CardTitle></CardHeader>
        <CardContent className="space-y-2">
          <Row label="Штрафы включены"><Switch checked={cfg.isPenaltyEnabled} onCheckedChange={(b) => set('isPenaltyEnabled', b)} /></Row>
          {cfg.penalties.map((p, i) => (
            <div key={p.id} className="flex items-center gap-2 flex-wrap border rounded-md p-2">
              <Switch checked={p.isEnabled} onCheckedChange={(b) => set('penalties', cfg.penalties.map((x, j) => j === i ? { ...x, isEnabled: b } : x))} />
              <Input value={p.name} className="w-32" onChange={(e) => set('penalties', cfg.penalties.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} />
              <GiftIds v={p.giftIds} on={(a) => set('penalties', cfg.penalties.map((x, j) => j === i ? { ...x, giftIds: a } : x))} />
              −<Num v={p.penaltyAmount} on={(n) => set('penalties', cfg.penalties.map((x, j) => j === i ? { ...x, penaltyAmount: n } : x))} /> сек,
              пол <Num v={p.penaltyThreshold} on={(n) => set('penalties', cfg.penalties.map((x, j) => j === i ? { ...x, penaltyThreshold: n } : x))} />
              <ShieldFlag v={p.worksWhenShielded} on={(b) => set('penalties', cfg.penalties.map((x, j) => j === i ? { ...x, worksWhenShielded: b } : x))} />
              <Button size="sm" variant="ghost" onClick={() => set('penalties', cfg.penalties.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></Button>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* ---- custom triggers ---- */}
      <Card>
        <CardHeader><CardTitle className="flex items-center justify-between">
          Свои триггеры (+/−/установить/сброс)
          <Button size="sm" variant="outline" onClick={() => set('customTriggers', [...cfg.customTriggers,
            { id: uid(), name: 'Триггер', giftIds: [], type: 'add', value: 60, isEnabled: true, worksWhenShielded: false }])}>
            <Plus className="h-4 w-4 mr-1" />Триггер</Button>
        </CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {cfg.customTriggers.map((t, i) => (
            <div key={t.id} className="flex items-center gap-2 flex-wrap border rounded-md p-2">
              <Switch checked={t.isEnabled} onCheckedChange={(b) => set('customTriggers', cfg.customTriggers.map((x, j) => j === i ? { ...x, isEnabled: b } : x))} />
              <Input value={t.name} className="w-32" onChange={(e) => set('customTriggers', cfg.customTriggers.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} />
              <GiftIds v={t.giftIds} on={(a) => set('customTriggers', cfg.customTriggers.map((x, j) => j === i ? { ...x, giftIds: a } : x))} />
              <select className="h-9 rounded-md border bg-transparent px-2 text-sm" value={t.type}
                onChange={(e) => set('customTriggers', cfg.customTriggers.map((x, j) => j === i ? { ...x, type: e.target.value } : x))}>
                <option value="add">+время</option><option value="sub">−время</option>
                <option value="set">установить</option><option value="reset">сброс</option>
              </select>
              {t.type !== 'reset' && <Num v={t.value} on={(n) => set('customTriggers', cfg.customTriggers.map((x, j) => j === i ? { ...x, value: n } : x))} />}
              <ShieldFlag v={t.worksWhenShielded} on={(b) => set('customTriggers', cfg.customTriggers.map((x, j) => j === i ? { ...x, worksWhenShielded: b } : x))} />
              <Button size="sm" variant="ghost" onClick={() => set('customTriggers', cfg.customTriggers.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></Button>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* ---- wallet chat commands (режим «кошельки») ---- */}
      <Card>
        <CardHeader><CardTitle>Кошельки — чат-команды</CardTitle></CardHeader>
        <CardContent>
          <div className="text-xs text-zinc-500 mb-3">
            В режиме «Кошельки» монеты подарков копятся на балансе зрителя, а команды <code>!команда [N]</code> в чате
            запускают триггер за цену в монетах. <code>!balance</code> — показать баланс.
          </div>
          {(() => {
            const rows: [string, string][] = [
              ['freeze', 'Щит'], ['unfreeze', 'Снять щит'], ['reverse', 'Реверс'],
              ['ruin', 'Руинер'], ['save', 'Сейв'], ['boost', 'Буст'], ['debuff', 'Дебафф'],
              ['settime', 'Установить время'], ['reset', 'Сброс'],
              ...cfg.roulettes.map((r): [string, string] => [`roulette:${r.id}`, `Рулетка «${r.name}»`]),
              ...cfg.penalties.map((p): [string, string] => [`penalty:${p.id}`, `Штраф «${p.name}»`]),
              ...cfg.customTriggers.map((t): [string, string] => [`custom:${t.id}`, `Триггер «${t.name}»`]),
            ];
            const put = (id: string, patch: Partial<import('../types').EfirWalletCmd>) =>
              set('walletCommands', {
                ...(cfg.walletCommands || {}),
                [id]: { ...{ command: '', price: 0 }, ...((cfg.walletCommands || {})[id] || {}), ...patch },
              });
            return rows.map(([id, label]) => {
              const wc = (cfg.walletCommands || {})[id];
              return (
                <div key={id} className="flex items-center gap-2 py-1 flex-wrap">
                  <span className="w-44 text-sm text-zinc-400 truncate" title={label}>{label}</span>
                  <Input value={wc?.command || ''} placeholder="!команда" className="w-32"
                    onChange={(e) => {
                      let v = e.target.value.trim().toLowerCase();
                      if (v && !v.startsWith('!')) v = '!' + v;
                      put(id, { command: v });
                    }} />
                  <Num v={wc?.price || 0} w={80} on={(n) => put(id, { price: n })} />
                  <span className="text-xs text-zinc-500">монет</span>
                  <Input value={wc?.sound?.media || ''} placeholder="звук: media id" className="w-44"
                    onChange={(e) => put(id, { sound: { media: e.target.value.trim(), trimStartMs: wc?.sound?.trimStartMs || 0, trimEndMs: wc?.sound?.trimEndMs || 0, volume: wc?.sound?.volume ?? 1 } })} />
                </div>
              );
            });
          })()}
        </CardContent>
      </Card>

      {/* ---- uptime (аптайм стрима в STATS-виджете) ---- */}
      <Card>
        <CardHeader><CardTitle>Аптайм</CardTitle></CardHeader>
        <CardContent>
          <Row label="Старт аптайма">
            <Input type="datetime-local" className="w-56" value={cfg.uptimeStartTime || ''}
              onChange={(e) => set('uptimeStartTime', e.target.value)} />
            <span className="text-xs text-zinc-500">пусто = от старта таймера</span>
          </Row>
          <Row label="Рулетка аптайма">
            <select className="h-9 rounded-md border bg-transparent px-2 text-sm" value={cfg.uptimeRouletteId || ''}
              onChange={(e) => set('uptimeRouletteId', e.target.value)}>
              <option value="">—</option>
              {cfg.roulettes.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </Row>
        </CardContent>
      </Card>

      {/* ---- roulettes ---- */}
      <Card>
        <CardHeader><CardTitle className="flex items-center justify-between">
          Рулетки
          <Button size="sm" variant="outline" onClick={() => set('roulettes', [...cfg.roulettes,
            { id: uid(), name: 'Новая рулетка', triggerType: 'gift', triggerGiftIds: [], likesThreshold: 0,
              addsCost: false, isEnabled: true, worksWhenShielded: false,
              mode: 'wheel', choiceTimeoutSeconds: 120, remoteButtonColor: '',
              showInRemote: true, isMain: false, donationAmount: '', slots: [] }])}>
            <Plus className="h-4 w-4 mr-1" />Рулетка</Button>
        </CardTitle></CardHeader>
        <CardContent className="space-y-4">
          {cfg.roulettes.map((r, ri) => (
            <div key={r.id} className="border rounded-md p-3 space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                <Switch checked={r.isEnabled} onCheckedChange={(b) => set('roulettes', cfg.roulettes.map((x, j) => j === ri ? { ...x, isEnabled: b } : x))} />
                <Input value={r.name} className="w-44" onChange={(e) => set('roulettes', cfg.roulettes.map((x, j) => j === ri ? { ...x, name: e.target.value } : x))} />
                <select className="h-9 rounded-md border bg-transparent px-2 text-sm" value={r.triggerType}
                  onChange={(e) => set('roulettes', cfg.roulettes.map((x, j) => j === ri ? { ...x, triggerType: e.target.value } : x))}>
                  <option value="gift">по подарку</option><option value="like">по лайкам</option><option value="both">и то и то</option>
                </select>
                {r.triggerType !== 'like' && <GiftIds v={r.triggerGiftIds} on={(a) => set('roulettes', cfg.roulettes.map((x, j) => j === ri ? { ...x, triggerGiftIds: a } : x))} />}
                {r.triggerType !== 'gift' && <>каждые <Num v={r.likesThreshold} on={(n) => set('roulettes', cfg.roulettes.map((x, j) => j === ri ? { ...x, likesThreshold: n } : x))} /> лайков</>}
                <label className="flex items-center gap-1.5 text-xs text-zinc-500">
                  <Switch checked={r.addsCost} onCheckedChange={(b) => set('roulettes', cfg.roulettes.map((x, j) => j === ri ? { ...x, addsCost: b } : x))} />
                  монеты → в таймер
                </label>
                <ShieldFlag v={r.worksWhenShielded} on={(b) => set('roulettes', cfg.roulettes.map((x, j) => j === ri ? { ...x, worksWhenShielded: b } : x))} />
                <Button size="sm" variant="ghost" onClick={() => set('roulettes', cfg.roulettes.filter((_, j) => j !== ri))}><Trash2 className="h-4 w-4" /></Button>
              </div>
              <div className="flex items-center gap-2 flex-wrap pl-6">
                <select className="h-8 rounded-md border bg-transparent px-1.5 text-xs" value={r.mode || 'wheel'}
                  onChange={(e) => set('roulettes', cfg.roulettes.map((x, j) => j === ri ? { ...x, mode: e.target.value } : x))}>
                  <option value="wheel">лента</option>
                  <option value="cards">🂠 карты (выбор в чате)</option>
                </select>
                {r.mode === 'cards' && (
                  <span className="flex items-center gap-1 text-xs text-zinc-500">выбор
                    <Num v={r.choiceTimeoutSeconds || 120} w={64}
                      on={(n) => set('roulettes', cfg.roulettes.map((x, j) => j === ri ? { ...x, choiceTimeoutSeconds: n } : x))} />сек
                  </span>
                )}
                <label className="flex items-center gap-1.5 text-xs text-zinc-500">
                  <Switch checked={r.showInRemote !== false}
                    onCheckedChange={(b) => set('roulettes', cfg.roulettes.map((x, j) => j === ri ? { ...x, showInRemote: b } : x))} />
                  в пульте
                </label>
                <input type="color" title="Цвет кнопки пульта" value={r.remoteButtonColor || '#6366f1'}
                  className="h-8 w-10 rounded border bg-transparent"
                  onChange={(e) => set('roulettes', cfg.roulettes.map((x, j) => j === ri ? { ...x, remoteButtonColor: e.target.value } : x))} />
                <label className="flex items-center gap-1.5 text-xs text-zinc-500">
                  <Switch checked={!!r.isMain}
                    onCheckedChange={(b) => set('roulettes', cfg.roulettes.map((x, j) => j === ri ? { ...x, isMain: b } : x))} />
                  главная
                </label>
              </div>
              <div className="space-y-1.5 pl-6">
                {r.slots.map((s, si) => (
                  <div key={s.id} className="flex items-center gap-2 flex-wrap">
                    <Switch checked={s.isEnabled} onCheckedChange={(b) => set('roulettes', cfg.roulettes.map((x, j) => j === ri
                      ? { ...x, slots: x.slots.map((y, k) => k === si ? { ...y, isEnabled: b } : y) } : x))} />
                    <input type="color" value={s.color} className="h-8 w-10 rounded border bg-transparent"
                      onChange={(e) => set('roulettes', cfg.roulettes.map((x, j) => j === ri
                        ? { ...x, slots: x.slots.map((y, k) => k === si ? { ...y, color: e.target.value } : y) } : x))} />
                    <Input value={s.label} className="w-36" placeholder="Название"
                      onChange={(e) => set('roulettes', cfg.roulettes.map((x, j) => j === ri
                        ? { ...x, slots: x.slots.map((y, k) => k === si ? { ...y, label: e.target.value } : y) } : x))} />
                    <select className="h-9 rounded-md border bg-transparent px-2 text-sm" value={s.type}
                      onChange={(e) => set('roulettes', cfg.roulettes.map((x, j) => j === ri
                        ? { ...x, slots: x.slots.map((y, k) => k === si ? { ...y, type: e.target.value } : y) } : x))}>
                      {SLOT_KINDS.map((k) => <option key={k.v} value={k.v}>{k.t}</option>)}
                    </select>
                    <Num v={s.value} on={(n) => set('roulettes', cfg.roulettes.map((x, j) => j === ri
                      ? { ...x, slots: x.slots.map((y, k) => k === si ? { ...y, value: n } : y) } : x))} w={80} />
                    {(s.type === 'multiply_time' || s.type === 'divide_time' || s.type === 'multiplier' || s.type === 'debuff') && (
                      <>x<Num v={s.multiplierValue} on={(n) => set('roulettes', cfg.roulettes.map((x, j) => j === ri
                        ? { ...x, slots: x.slots.map((y, k) => k === si ? { ...y, multiplierValue: n } : y) } : x))} w={70} /></>
                    )}
                    {s.type === 'special' && (
                      <Input value={s.textValue} className="w-40" placeholder="Текст"
                        onChange={(e) => set('roulettes', cfg.roulettes.map((x, j) => j === ri
                          ? { ...x, slots: x.slots.map((y, k) => k === si ? { ...y, textValue: e.target.value } : y) } : x))} />
                    )}
                    <span className="text-xs text-zinc-500">шанс</span>
                    <Num v={s.chance} on={(n) => set('roulettes', cfg.roulettes.map((x, j) => j === ri
                      ? { ...x, slots: x.slots.map((y, k) => k === si ? { ...y, chance: n } : y) } : x))} w={70} />
                    <select className="h-8 rounded-md border bg-transparent px-1 text-xs" value={s.target || 'self'}
                      title="На кого действует слот"
                      onChange={(e) => set('roulettes', cfg.roulettes.map((x, j) => j === ri
                        ? { ...x, slots: x.slots.map((y, k) => k === si ? { ...y, target: e.target.value } : y) } : x))}>
                      <option value="self">себе</option>
                      <option value="opponent">сопернику</option>
                      <option value="all">всем</option>
                    </select>
                    <label className="flex items-center gap-1 text-xs text-zinc-500">
                      <Switch checked={s.isEliminable} onCheckedChange={(b) => set('roulettes', cfg.roulettes.map((x, j) => j === ri
                        ? { ...x, slots: x.slots.map((y, k) => k === si ? { ...y, isEliminable: b } : y) } : x))} />
                      выбывает
                    </label>
                    <Button size="sm" variant="ghost" onClick={() => set('roulettes', cfg.roulettes.map((x, j) => j === ri
                      ? { ...x, slots: x.slots.filter((_, k) => k !== si) } : x))}><Trash2 className="h-4 w-4" /></Button>
                  </div>
                ))}
                <Button size="sm" variant="outline" onClick={() => set('roulettes', cfg.roulettes.map((x, j) => j === ri
                  ? { ...x, slots: [...x.slots, { id: uid(), label: '+60 сек', type: 'add_time', value: 60,
                      multiplierValue: 2, textValue: '', chance: 10, color: '#6366f1', isEnabled: true,
                      isEliminable: false, extraSpinRouletteId: '', target: 'self' }] } : x))}>
                  <Plus className="h-4 w-4 mr-1" />Слот</Button>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* ---- sounds ---- */}
      <Card>
        <CardHeader><CardTitle>Звуки на триггеры</CardTitle></CardHeader>
        <CardContent>
          <div className="text-xs text-zinc-500 mb-3">
            ID файла из «Медиатеки» + обрезка (мс) и громкость звука. Пусто — короткий синтезированный сигнал.
          </div>
          {[['default','По умолчанию'],['like','Лайки'],['follow','Подписка'],['gift','Подарок'],
            ['roulette','Рулетка (алерт)'],['spin','Прокрут (старт)'],['win','Победа слота'],['bonus','Бонус'],
            ['ruiner','Руинер'],['save','Сейв'],['freeze','Щит'],['reverse_time','Реверс'],
            ['multiplier','Буст'],['debuff','Дебафф'],['frozen_gift','Блок щитом'],['cards','Карты'],
            ['wallet_credit','Пополнение'],['wallet_command','Списание'],
          ].map(([key, label]) => {
            const raw = (cfg.soundMap || {})[key];
            const sp = typeof raw === 'object' && raw
              ? raw
              : { media: (raw as string) || '', trimStartMs: 0, trimEndMs: 0, volume: 1 };
            const put = (patch: Partial<typeof sp>) =>
              set('soundMap', { ...(cfg.soundMap || {}), [key]: { ...sp, ...patch } });
            return (
              <div key={key} className="flex items-center gap-2 py-1 flex-wrap">
                <span className="w-36 text-sm text-zinc-400">{label}</span>
                <Input value={sp.media} placeholder="media id" className="w-56"
                  onChange={(e) => put({ media: e.target.value.trim() })} />
                <span className="text-xs text-zinc-500">от</span>
                <Num v={sp.trimStartMs} w={70} on={(n) => put({ trimStartMs: n })} />
                <span className="text-xs text-zinc-500">до</span>
                <Num v={sp.trimEndMs} w={70} on={(n) => put({ trimEndMs: n })} />
                <span className="text-xs text-zinc-500">гр.</span>
                <Num v={Math.round((sp.volume ?? 1) * 100)} w={64}
                  on={(n) => put({ volume: Math.max(0, Math.min(1, n / 100)) })} />
                <span className="text-xs text-zinc-500">%</span>
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* ---- appearance ---- */}
      <Card>
        <CardHeader><CardTitle>Оформление</CardTitle></CardHeader>
        <CardContent>
          <div className="flex gap-2 flex-wrap mb-4">
            {THEMES.map((t) => (
              <button key={t.id} onClick={() => setCfg((c) => ({ ...c, styles: { ...c.styles, ...t.c, themeId: t.id } }))}
                className={`px-3 py-1.5 rounded-md border text-sm ${cfg.styles.themeId === t.id ? 'border-indigo-400 bg-indigo-500/20' : 'border-zinc-700'}`}>
                <span className="inline-block w-3 h-3 rounded-full mr-1.5 align-middle" style={{ background: t.c.roulettePrimary }} />
                {t.n}
              </button>
            ))}
          </div>
          <Row label="Шрифт"><Input value={cfg.styles.fontFamily} className="w-72" onChange={(e) => setStyle('fontFamily', e.target.value)} /></Row>
          {[
            ['Цвет таймера', 'timerColor'], ['Рулетка: основной', 'roulettePrimary'],
            ['Рулетка: акцент', 'rouletteSecondary'], ['Рулетка: фон', 'rouletteSurface'],
            ['Рулетка: текст', 'rouletteText'], ['Буст', 'buffColor'], ['Дебафф', 'debuffColor'],
            ['+время', 'floatPlusColor'], ['−время', 'floatMinusColor'],
            ['Карточка буста', 'buffCardBg'], ['Карточка дебаффа', 'debuffCardBg'],
          ].map(([label, key]) => (
            <Row key={key as string} label={label as string}>
              <input type="color" value={(cfg.styles as never)[key]} className="h-8 w-14 rounded border bg-transparent"
                onChange={(e) => setStyle(key as never, e.target.value as never)} />
            </Row>
          ))}
          <Row label="Предосмотр (живой)">
            <div className="rounded-md overflow-hidden border border-zinc-700 bg-black" style={{ width: 500, height: 280 }}>
              {base
                ? <iframe src={widgetUrl('efirtimer.html')} className="w-full h-full" title="timer preview" />
                : <div className="text-xs text-zinc-500 p-4">Оверлей-сервер не поднят</div>}
            </div>
          </Row>
          <Row label="Свечение">
            <input type="range" min={0} max={1} step={0.05} value={cfg.styles.timerGlow}
              onChange={(e) => setStyle('timerGlow', Number(e.target.value))} className="w-48" />
          </Row>
          <Row label="Обводка цифр"><Switch checked={cfg.styles.enableStroke} onCheckedChange={(b) => setStyle('enableStroke', b)} /></Row>
          <Row label="Статистика: фон">
            <Switch checked={!cfg.styles.statsTransparent} onCheckedChange={(b) => setStyle('statsTransparent', !b)} />
            <span className="text-xs text-zinc-500">{cfg.styles.statsTransparent ? 'прозрачный (только цифры)' : 'с фоном'}</span>
          </Row>
          <Row label="Статистика: текст аптайма">
            <Input value={cfg.styles.statsUptimeLabel} className="w-64" placeholder="АПТАЙМ СТРИМА"
              onChange={(e) => setStyle('statsUptimeLabel', e.target.value)} />
          </Row>
          <Row label="Статистика: текст «до рулетки»">
            <Input value={cfg.styles.statsLikesLabel} className="w-64" placeholder="ДО РУЛЕТКИ"
              onChange={(e) => setStyle('statsLikesLabel', e.target.value)} />
          </Row>
        </CardContent>
      </Card>
    </div>
  );
}
