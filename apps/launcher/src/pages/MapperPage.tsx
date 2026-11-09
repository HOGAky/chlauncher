/**
 * @file MapperPage.tsx
 * Trigger mapper — the killer feature: visual rule editor mapping raw
 * stream events (TikTok gifts/likes, DonationAlerts donations) to game
 * commands. Profiles persist per-game as JSON in launcher settings.
 */
import React, { useEffect, useState } from 'react';
import {
  Bell,
  ChevronDown,
  ChevronUp,
  ImageDown,
  Pause,
  Play,
  Plus,
  Save,
  Trash2,
  Upload,
  Download,
  Wand2,
  Zap,
} from 'lucide-react';
import * as api from '../api';
import type {
  AlertSpec,
  GiftEntry,
  SchedulerStatus,
  SpinnerPool,
  TriggerPreset,
  TriggerProfile,
  TriggerRule,
  TtsRuleSpec,
} from '../types';
import { renderPresetPoster } from '../lib/presetPoster';
import GiftPicker from '../components/GiftPicker';
import GiftIcon from '../components/GiftIcon';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';

import { humanError } from '../errorMessages';
const SOURCES = ['any', 'tiktok', 'donationalerts', 'simulator'];
const KINDS = ['any', 'gift', 'like', 'comment', 'donation', 'follow', 'share', 'subscribe', 'join'];
const MATCH_MODES = [
  { v: 'contains', t: 'содержит' },
  { v: 'exact', t: 'точно' },
  { v: 'gift_id', t: 'gift id' },
];
const REPEAT_MODES = [
  { v: 'once', t: 'один раз' },
  { v: 'per_unit', t: 'за штуку' },
];
const ACTIONS = [
  'spawn_enemy', 'spawn_boss', 'heal_player', 'log_only',
  // Steal the Stream whitelist (docs/roblox-integration.md §C)
  'spawn_chaser', 'invert_controls', 'drop_floor', 'yeet', 'freeze',
  'slow_field', 'camera_spin', 'wall_ahead', 'decoy_clones', 'shield',
  'speed_boost', 'checkpoint', 'coin_rain', 'fireworks',
];

/** Per-game action vocabularies — the command list a game understands
 *  (StE's per-game trigger library). Unknown slugs get the full list;
 *  free text is always allowed anyway. */
const GAME_ACTIONS: Record<string, string[]> = {
  'mock-game': ['spawn_enemy', 'spawn_boss', 'heal_player', 'log_only'],
};
const actionsFor = (slug: string) => GAME_ACTIONS[slug] ?? ACTIONS;
const DEFAULT_SLUG = 'default'; // profile used when no game is active (cloud servers)

const ALERT_POSITIONS = [
  { v: 'top', t: 'сверху' },
  { v: 'center', t: 'по центру' },
  { v: 'bottom', t: 'снизу' },
];
const ALERT_STYLES = [
  { v: 'default', t: 'обычный' },
  { v: 'minimal', t: 'минимал' },
  { v: 'big', t: 'крупный' },
];

/** Live preview of the alert template with demo placeholders (§3.4). */
function alertPreview(r: TriggerRule): string {
  return (r.alert?.text || '{user} → {label}')
    .replace(/\{user\}/g, 'ivan')
    .replace(/\{gift\}/g, r.match_value || 'Rose')
    .replace(/\{count\}/g, '5')
    .replace(/\{coins\}/g, '99')
    .replace(/\{action\}/g, r.action)
    .replace(/\{label\}/g, r.label || r.action);
}

/** Creates a fresh editable rule row. */
function newRule(): TriggerRule {
  return {
    id: crypto.randomUUID(),
    source: 'tiktok',
    event_kind: 'gift',
    match_value: '',
    min_amount: 0,
    action: 'spawn_enemy',
    multiplier: 1,
    enabled: true,
  };
}

export default function MapperPage() {
  const [slug, setSlug] = useState(DEFAULT_SLUG);
  const [gameSlugs, setGameSlugs] = useState<string[]>([DEFAULT_SLUG]);
  const [activeSlug, setActiveSlug] = useState<string | null>(null);
  const [profile, setProfile] = useState<TriggerProfile | null>(null);
  const [presets, setPresets] = useState<TriggerPreset[]>([]);
  const [presetSel, setPresetSel] = useState('');
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sched, setSched] = useState<SchedulerStatus | null>(null);
  const [spinners, setSpinners] = useState<SpinnerPool[]>([]);
  const [openIds, setOpenIds] = useState<Set<string>>(new Set());
  // Rules with the 🔔 alert drawer open (§3.4).
  const [alertIds, setAlertIds] = useState<Set<string>>(new Set());
  // Global alert settings — master switch + default-alert threshold (§3.2).
  const [alertsCfg, setAlertsCfg] = useState<{
    enabled: boolean;
    default_for_gifts_from_coins: number;
    default_duration_ms: number;
    volume: number;
  } | null>(null);

  // Scheduler status — polled only while this page is open (§2.6).
  useEffect(() => {
    let alive = true;
    const poll = () =>
      api
        .getSchedulerStatus()
        .then((s) => alive && setSched(s))
        .catch(() => {});
    poll();
    const t = setInterval(poll, 1500);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  useEffect(() => {
    api.listSpinners().then(setSpinners).catch(() => {});
    api.getAlertsSettings().then(setAlertsCfg).catch(() => {});
  }, []);

  /** Persists one alert-setting field; `enabled` applies live (§3.1). */
  const patchAlertsCfg = (patch: Partial<NonNullable<typeof alertsCfg>>) => {
    const next = { ...alertsCfg!, ...patch };
    setAlertsCfg(next);
    api
      .setAlertsSettings(
        next.enabled,
        next.default_for_gifts_from_coins,
        next.default_duration_ms,
        next.volume
      )
      .catch((e) => setError(humanError(e)));
  };

  const toggleOpen = (id: string) =>
    setOpenIds((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  const toggleAlert = (id: string) =>
    setAlertIds((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  /** Patches `alert` on one rule — `null` disables the overlay alert. */
  const patchAlert = (id: string, patch: Partial<AlertSpec> | null) =>
    setProfile(
      (p) =>
        p && {
          ...p,
          rules: p.rules.map((r) =>
            r.id === id
              ? {
                  ...r,
                  alert:
                    patch === null
                      ? null
                      : { text: '{user} → {label}', ...(r.alert ?? {}), ...patch },
                }
              : r
          ),
        }
    );

  /** Patches `tts` on one rule — `null` disables the voice-over. */
  const patchTts = (id: string, patch: Partial<TtsRuleSpec> | null) =>
    setProfile(
      (p) =>
        p && {
          ...p,
          rules: p.rules.map((r) =>
            r.id === id
              ? { ...r, tts: patch === null ? null : { ...(r.tts ?? {}), ...patch } }
              : r
          ),
        }
    );

  // Game selector: catalog games + the "default" routing profile.
  // Initial selection = the profile currently mapping live events.
  useEffect(() => {
    api.listGames().then((r) => {
      const slugs = [DEFAULT_SLUG, ...r.games.map((g) => g.slug)];
      setGameSlugs((old) => [...new Set([...old, ...slugs])]);
    }).catch(() => {});
    api.getActiveTriggerProfile().then((s) => {
      if (s) {
        setActiveSlug(s);
        setSlug(s);
      }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    api.getTriggers(slug).then(setProfile).catch((e) => setError(humanError(e)));
  }, [slug]);

  const reloadPresets = () =>
    api
      .listTriggerPresets()
      .then(setPresets)
      .catch((e) => setError(humanError(e)));

  useEffect(() => {
    reloadPresets();
  }, []);

  /** Updates one field of one rule. */
  const patchRule = (id: string, patch: Partial<TriggerRule>) =>
    setProfile(
      (p) => p && { ...p, rules: p.rules.map((r) => (r.id === id ? { ...r, ...patch } : r)) }
    );

  const removeRule = (id: string) =>
    setProfile((p) => p && { ...p, rules: p.rules.filter((r) => r.id !== id) });

  const addRule = () =>
    setProfile((p) => p && { ...p, rules: [newRule(), ...p.rules] });

  const save = async () => {
    if (!profile) return;
    setError(null);
    try {
      await api.saveTriggers(profile);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (e) {
      setError(humanError(e));
    }
  };

  /** Applies the selected preset to this game's profile. */
  const applyPreset = () => {
    if (!presetSel) return;
    setError(null);
    api
      .applyTriggerPreset(slug, presetSel)
      .then(setProfile)
      .catch((e) => setError(humanError(e)));
  };

  /** Saves the current rules as a named preset tagged for this game
   *  ("default" → universal preset, offered for every game). */
  const saveAsPreset = () => {
    if (!profile) return;
    const name = window.prompt(`Имя пресета для «${slug}»:`)?.trim();
    if (!name) return;
    setError(null);
    api
      .saveTriggerPreset({
        name,
        game_slug: slug === DEFAULT_SLUG ? null : slug,
        rules: profile.rules,
      })
      .then(() => {
        setPresetSel(name);
        reloadPresets();
      })
      .catch((e) => setError(humanError(e)));
  };

  /** Deletes the selected streamer preset (built-ins can't be deleted). */
  const deletePreset = () => {
    const p = presets.find((x) => x.name === presetSel);
    if (!p || p.builtin) return;
    if (!window.confirm(`Удалить пресет «${presetSel}»? Профили игр не пострадают.`)) return;
    setError(null);
    api
      .deleteTriggerPreset(presetSel)
      .then(() => {
        setPresetSel('');
        reloadPresets();
      })
      .catch((e) => setError(humanError(e)));
  };

  const selBuiltin = presets.find((p) => p.name === presetSel)?.builtin;

  /** ▶ — saves the profile, then runs this rule through the pipeline
   *  bypassing cooldowns/limits (§2.5 test button). */
  const runTest = async (ruleId: string) => {
    if (!profile) return;
    setError(null);
    try {
      await api.saveTriggers(profile);
      await api.testRule(slug, ruleId);
    } catch (e) {
      setError(humanError(e));
    }
  };

  /** Exports the selected preset as a downloadable JSON file. */
  const exportPreset = async () => {
    if (!presetSel) return;
    setError(null);
    try {
      const json = await api.exportTriggerPreset(presetSel);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
      a.download = `preset-${presetSel}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      setError(humanError(e));
    }
  };

  /** Imports a preset JSON file (renames on collision). */
  const importPreset = () => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.json,application/json';
    inp.onchange = async () => {
      const f = inp.files?.[0];
      if (!f) return;
      setError(null);
      try {
        const text = await f.text();
        const p = await api.importTriggerPreset(text);
        setPresetSel(p.name);
        reloadPresets();
      } catch (e) {
        setError(humanError(e));
      }
    };
    inp.click();
  };

  /** Renders the profile as a PNG cheat sheet and downloads it. */
  const [busyPng, setBusyPng] = useState(false);
  const downloadPoster = async () => {
    if (!profile || busyPng) return;
    setBusyPng(true);
    setError(null);
    try {
      const gifts: GiftEntry[] = await fetch('/gifts.json')
        .then((r) => (r.ok ? r.json() : []))
        .catch(() => []);
      const blob = await renderPresetPoster(profile, gifts);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `preset-${profile.preset ?? profile.game_slug}.png`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusyPng(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Маппер триггеров</h1>
        <div className="flex items-center gap-2">
          <select
            className="h-8 rounded-md border border-input bg-secondary/40 px-2 text-sm"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            title="Игра, чей профиль редактируется — пресеты фильтруются под неё"
          >
            {gameSlugs.map((s) => (
              <option key={s} value={s}>
                {s === DEFAULT_SLUG ? 'default · облако/без игры' : s}
              </option>
            ))}
          </select>
          {activeSlug === slug ? (
            <Badge variant="success">маппит события</Badge>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              title="Сделать этот профиль активным — живые события будут мапиться по нему"
              onClick={() =>
                api
                  .setActiveTriggerProfile(slug)
                  .then(() => setActiveSlug(slug))
                  .catch((e) => setError(humanError(e)))
              }
            >
              ● сделать активным
            </Button>
          )}
          <Button size="sm" variant="secondary" onClick={addRule}>
            <Plus size={14} /> Правило
          </Button>
          <Button size="sm" onClick={save}>
            <Save size={14} /> {saved ? 'Сохранено' : 'Сохранить'}
          </Button>
        </div>
      </div>

      {sched && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-border/60 bg-secondary/20 px-3 py-1.5 text-xs">
          <Button
            size="sm"
            variant={sched.paused ? 'default' : 'outline'}
            className="h-7"
            title="Перерыв: действия стоп, события копятся в очереди"
            onClick={() =>
              api
                .schedulerPause(!sched.paused)
                .then(() => setSched({ ...sched, paused: !sched.paused }))
                .catch((e) => setError(humanError(e)))
            }
          >
            {sched.paused ? <Play size={13} /> : <Pause size={13} />}
            {sched.paused ? ' Продолжить' : ' Пауза'}
          </Button>
          <span className="text-muted-foreground">
            очередь: <b className="text-foreground">{sched.queued}</b>
          </span>
          {sched.dropped > 0 && (
            <span className="text-muted-foreground">
              дропнуто: <b className="text-amber-300">{sched.dropped}</b>
            </span>
          )}
          {sched.skipped_cooldown > 0 && (
            <span className="text-muted-foreground">
              кулдаун: <b className="text-foreground">{sched.skipped_cooldown}</b>
            </span>
          )}
          {sched.skipped_limit > 0 && (
            <span className="text-muted-foreground">
              лимит: <b className="text-amber-300">{sched.skipped_limit}</b>
            </span>
          )}
          {sched.takeover && (
            <Badge variant="destructive">
              <Zap size={11} className="mr-1" /> прерывание: {sched.takeover.preset}
            </Badge>
          )}
          {sched.accumulators.map((a) => (
            <span key={a.rule_id} className="text-muted-foreground">
              {a.label || a.rule_id.slice(0, 6)}:{' '}
              <b className="text-foreground">
                {a.value}/{a.target || '…'}
              </b>
            </span>
          ))}
          {sched.accumulators.length > 0 && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2"
              title="Сбросить счётчики накопителей"
              onClick={() => api.schedulerResetCounters().catch(() => {})}
            >
              сброс счётчиков
            </Button>
          )}
          {alertsCfg && (
            <span className="ml-auto flex items-center gap-2 border-l border-border/60 pl-3">
              <label className="flex items-center gap-1.5 text-muted-foreground">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 accent-primary"
                  checked={alertsCfg.enabled}
                  title="Мастер-выключатель алертов на оверлее"
                  onChange={(e) => patchAlertsCfg({ enabled: e.target.checked })}
                />
                алерты
              </label>
              <label className="flex items-center gap-1 text-muted-foreground" title="Подарки дороже порога получают дефолтный алерт без настройки правила (0 = выкл)">
                ≥<Input
                  className="h-6 w-16 px-1.5 text-xs"
                  type="number"
                  min={0}
                  value={alertsCfg.default_for_gifts_from_coins}
                  onChange={(e) =>
                    patchAlertsCfg({
                      default_for_gifts_from_coins: Number(e.target.value) || 0,
                    })
                  }
                />
                ◉ — авто-алерт
              </label>
            </span>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">Пресет:</span>
        <select
          className="h-8 rounded-md border border-input bg-secondary/40 px-2 text-sm"
          value={presetSel}
          onChange={(e) => setPresetSel(e.target.value)}
        >
          <option value="">— выбрать —</option>
          {presets
            .filter((p) => p.game_slug == null || p.game_slug === slug)
            .map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
                {p.builtin ? ' (встроенный)' : ''}
                {p.game_slug && p.game_slug !== slug ? ` → ${p.game_slug}` : ''}
              </option>
            ))}
        </select>
        <Button
          size="sm"
          variant="outline"
          disabled={!presetSel}
          title="Применить пресет к профилю этой игры"
          onClick={applyPreset}
        >
          <Wand2 size={14} /> Применить
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!profile}
          title="Сохранить текущие правила как именованный пресет"
          onClick={saveAsPreset}
        >
          <Save size={14} /> Как пресет
        </Button>
        {presetSel && !selBuiltin && (
          <Button
            size="sm"
            variant="ghost"
            title="Удалить свой пресет"
            onClick={deletePreset}
          >
            <Trash2 size={14} />
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          disabled={!presetSel}
          title="Экспорт пресета в JSON-файл (поделиться)"
          onClick={exportPreset}
        >
          <Upload size={14} />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          title="Импорт пресета из JSON-файла"
          onClick={importPreset}
        >
          <Download size={14} />
        </Button>
        {profile?.preset && (
          <Badge variant="outline" className="ml-auto">
            применён: {profile.preset}
          </Badge>
        )}
        <Button
          size="sm"
          variant="outline"
          disabled={!profile || busyPng}
          title="Скачать PNG-табличку: подарок ×N → действие (для зрителей/закрепа)"
          onClick={downloadPoster}
        >
          <ImageDown size={14} /> PNG
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">
        Первое совпавшее правило побеждает — ставьте более специфичные правила выше.
        Пустое «Совпадение» ловит все события этого вида; «Мин. сумма» фильтрует по
        количеству/сумме (донаты — в копейках). Пресеты — именованные наборы правил,
        которые можно применять к любой игре; встроенный «steal-the-stream» удалить нельзя.
      </p>

      {error && (
        <div className="text-xs text-red-400 bg-destructive/10 border border-destructive/30 rounded-md px-3 py-2">
          {error}
        </div>
      )}

      <div className="flex flex-col gap-2">
        {profile?.rules.map((r) => {
          const open = openIds.has(r.id);
          return (
            <Card key={r.id} className={r.enabled === false ? 'opacity-55' : ''}>
              <CardContent className="pt-3 flex flex-wrap items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-primary"
                  checked={r.enabled !== false}
                  title={r.enabled === false ? 'Правило выключено' : 'Правило включено'}
                  onChange={(e) => patchRule(r.id, { enabled: e.target.checked })}
                />
                <Badge variant="outline">ЕСЛИ</Badge>
                <select
                  className="h-8 rounded-md border border-input bg-secondary/40 px-2 text-sm"
                  value={r.source}
                  onChange={(e) => patchRule(r.id, { source: e.target.value })}
                >
                  {SOURCES.map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
                <select
                  className="h-8 rounded-md border border-input bg-secondary/40 px-2 text-sm"
                  value={r.event_kind}
                  onChange={(e) => patchRule(r.id, { event_kind: e.target.value })}
                >
                  {KINDS.map((k) => (
                    <option key={k}>{k}</option>
                  ))}
                </select>
                <GiftIcon matchValue={r.match_value} kind={r.event_kind} />
                <Input
                  className="w-32"
                  placeholder="совпадение (Rose)"
                  value={r.match_value}
                  onChange={(e) => patchRule(r.id, { match_value: e.target.value })}
                />
                <GiftPicker
                  onPick={(name) =>
                    patchRule(r.id, {
                      source: 'tiktok',
                      event_kind: 'gift',
                      match_value: name,
                    })
                  }
                />
                <span className="text-muted-foreground text-xs">≥</span>
                <Input
                  className="w-20"
                  type="number"
                  min={0}
                  value={r.min_amount}
                  onChange={(e) => patchRule(r.id, { min_amount: Number(e.target.value) || 0 })}
                />
                <Badge variant="default">ТО</Badge>
                <Input
                  className="w-40"
                  list="action-commands"
                  placeholder="action_command"
                  value={r.action}
                  onChange={(e) => patchRule(r.id, { action: e.target.value })}
                />
                <datalist id="action-commands">
                  {actionsFor(slug).map((a) => (
                    <option key={a} value={a} />
                  ))}
                </datalist>
                <span className="text-muted-foreground text-xs">×</span>
                <Input
                  className="w-16"
                  type="number"
                  step="0.5"
                  min={0}
                  value={r.multiplier}
                  onChange={(e) => patchRule(r.id, { multiplier: Number(e.target.value) || 0 })}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  title={r.alert ? 'Алерт настроен — открыть редактор' : 'Настроить алерт на оверлее'}
                  className={r.alert ? 'text-primary' : ''}
                  onClick={() => toggleAlert(r.id)}
                >
                  <Bell size={14} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  title="Тест: прогнать правило минуя кулдауны"
                  onClick={() => runTest(r.id)}
                >
                  <Play size={14} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  title="Дополнительно: кулдауны, приоритет, повторы"
                  onClick={() => toggleOpen(r.id)}
                >
                  {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="ml-auto"
                  onClick={() => removeRule(r.id)}
                >
                  <Trash2 size={14} />
                </Button>
              </CardContent>
              {open && (
                <CardContent className="border-t border-border/50 pt-3 grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-2 text-xs">
                  <label className="flex flex-col gap-1">
                    <span className="text-muted-foreground">Подпись действия</span>
                    <Input
                      value={r.label ?? ''}
                      placeholder={r.action}
                      onChange={(e) => patchRule(r.id, { label: e.target.value })}
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-muted-foreground">Совпадение</span>
                    <select
                      className="h-8 rounded-md border border-input bg-secondary/40 px-2 text-sm"
                      value={r.match_mode ?? 'contains'}
                      onChange={(e) => patchRule(r.id, { match_mode: e.target.value })}
                    >
                      {MATCH_MODES.map((m) => (
                        <option key={m.v} value={m.v}>
                          {m.t}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-muted-foreground">Срабатывание</span>
                    <select
                      className="h-8 rounded-md border border-input bg-secondary/40 px-2 text-sm"
                      value={r.repeat ?? 'once'}
                      onChange={(e) => patchRule(r.id, { repeat: e.target.value })}
                    >
                      {REPEAT_MODES.map((m) => (
                        <option key={m.v} value={m.v}>
                          {m.t}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-muted-foreground">Каждые N (лайки/счётчик)</span>
                    <Input
                      type="number"
                      min={0}
                      value={r.every_n ?? 0}
                      onChange={(e) => patchRule(r.id, { every_n: Number(e.target.value) || 0 })}
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-muted-foreground">Кулдаун, мс</span>
                    <Input
                      type="number"
                      min={0}
                      step={500}
                      value={r.cooldown_ms ?? 0}
                      onChange={(e) => patchRule(r.id, { cooldown_ms: Number(e.target.value) || 0 })}
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-muted-foreground">Кулдаун зрителя, мс</span>
                    <Input
                      type="number"
                      min={0}
                      step={500}
                      value={r.user_cooldown_ms ?? 0}
                      onChange={(e) =>
                        patchRule(r.id, { user_cooldown_ms: Number(e.target.value) || 0 })
                      }
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-muted-foreground">Задержка, мс</span>
                    <Input
                      type="number"
                      min={0}
                      step={100}
                      value={r.delay_ms ?? 0}
                      onChange={(e) => patchRule(r.id, { delay_ms: Number(e.target.value) || 0 })}
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-muted-foreground">Приоритет (больше — раньше)</span>
                    <Input
                      type="number"
                      value={r.priority ?? 0}
                      onChange={(e) => patchRule(r.id, { priority: Number(e.target.value) || 0 })}
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-muted-foreground">Макс. повторов за событие</span>
                    <Input
                      type="number"
                      min={1}
                      value={r.max_repeat ?? 20}
                      onChange={(e) => patchRule(r.id, { max_repeat: Number(e.target.value) || 1 })}
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-muted-foreground">Спиннер (пул)</span>
                    <select
                      className="h-8 rounded-md border border-input bg-secondary/40 px-2 text-sm"
                      value={r.spinner ?? ''}
                      onChange={(e) =>
                        patchRule(r.id, { spinner: e.target.value || null })
                      }
                    >
                      <option value="">— нет —</option>
                      {spinners.map((p) => (
                        <option key={p.name} value={p.name}>
                          🎡 {p.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex items-center gap-2 pt-5">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-primary"
                      checked={r.continue_matching ?? false}
                      onChange={(e) => patchRule(r.id, { continue_matching: e.target.checked })}
                    />
                    <span className="text-muted-foreground">не останавливать перебор</span>
                  </label>
                  <label className="flex items-center gap-2 pt-5">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-primary"
                      checked={r.interrupt ?? false}
                      onChange={(e) => patchRule(r.id, { interrupt: e.target.checked })}
                    />
                    <span className="text-muted-foreground">прерывание (обрывает очередь)</span>
                  </label>
                  {r.interrupt && (
                    <label className="flex flex-col gap-1">
                      <span className="text-muted-foreground">Пресет прерывания</span>
                      <select
                        className="h-8 rounded-md border border-input bg-secondary/40 px-2 text-sm"
                        value={r.interrupt_preset ?? ''}
                        onChange={(e) =>
                          patchRule(r.id, { interrupt_preset: e.target.value || null })
                        }
                      >
                        <option value="">— без смены пресета —</option>
                        {presets
                          .filter((p) => p.game_slug == null || p.game_slug === slug)
                          .map((p) => (
                            <option key={p.name} value={p.name}>
                              {p.name}
                            </option>
                          ))}
                      </select>
                    </label>
                  )}
                  {r.interrupt && (
                    <label className="flex flex-col gap-1">
                      <span className="text-muted-foreground">Длительность прерывания, мс</span>
                      <Input
                        type="number"
                        min={0}
                        step={5000}
                        value={r.interrupt_duration_ms ?? 60_000}
                        onChange={(e) =>
                          patchRule(r.id, {
                            interrupt_duration_ms: Number(e.target.value) || 60_000,
                          })
                        }
                      />
                    </label>
                  )}
                </CardContent>
              )}
              {/* 🔔 Alert drawer (§3.4) — text + duration + position +
                  style, TTS template, live preview, test on overlay. */}
              {alertIds.has(r.id) && (
                <CardContent className="border-t border-primary/30 bg-primary/5 pt-3 flex flex-col gap-3 text-xs">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-primary"
                      checked={!!r.alert}
                      onChange={(e) => patchAlert(r.id, e.target.checked ? {} : null)}
                    />
                    <span className="font-medium">Алерт на оверлее при срабатывании</span>
                  </label>
                  {r.alert && (
                    <>
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-x-4 gap-y-2">
                        <label className="flex flex-col gap-1 md:col-span-2">
                          <span className="text-muted-foreground">
                            Текст — плейсхолдеры: {'{user} {gift} {count} {coins} {action} {label}'}
                          </span>
                          <Input
                            value={r.alert.text ?? ''}
                            placeholder="{user} отправил {gift} → {label}"
                            onChange={(e) => patchAlert(r.id, { text: e.target.value })}
                          />
                        </label>
                        <label className="flex flex-col gap-1">
                          <span className="text-muted-foreground">Длительность, мс</span>
                          <Input
                            type="number"
                            min={200}
                            step={500}
                            value={r.alert.duration_ms ?? 4000}
                            onChange={(e) =>
                              patchAlert(r.id, {
                                duration_ms: Number(e.target.value) || 4000,
                              })
                            }
                          />
                        </label>
                        <label className="flex flex-col gap-1">
                          <span className="text-muted-foreground">Позиция</span>
                          <select
                            className="h-8 rounded-md border border-input bg-secondary/40 px-2 text-sm"
                            value={r.alert.position ?? 'top'}
                            onChange={(e) => patchAlert(r.id, { position: e.target.value })}
                          >
                            {ALERT_POSITIONS.map((p) => (
                              <option key={p.v} value={p.v}>
                                {p.t}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="flex flex-col gap-1">
                          <span className="text-muted-foreground">Стиль</span>
                          <select
                            className="h-8 rounded-md border border-input bg-secondary/40 px-2 text-sm"
                            value={r.alert.style ?? 'default'}
                            onChange={(e) => patchAlert(r.id, { style: e.target.value })}
                          >
                            {ALERT_STYLES.map((s) => (
                              <option key={s.v} value={s.v}>
                                {s.t}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                      {/* Live preview of the alert card (same palette as
                          /overlay/alerts, minimal chrome). */}
                      <div className="flex items-center gap-3">
                        <div
                          className={`rounded-xl px-5 py-2 text-sm font-semibold text-white shadow-lg ${
                            r.alert.style === 'minimal'
                              ? 'bg-secondary/80 border border-border font-normal text-xs'
                              : r.alert.style === 'big'
                                ? 'bg-gradient-to-br from-violet-600 to-pink-600 text-lg'
                                : 'bg-gradient-to-br from-violet-600 to-pink-600'
                          }`}
                        >
                          {alertPreview(r)}
                        </div>
                        <span className="text-muted-foreground">← предпросмотр</span>
                      </div>
                    </>
                  )}
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-primary"
                      checked={!!r.tts}
                      onChange={(e) => patchTts(r.id, e.target.checked ? {} : null)}
                    />
                    <span className="font-medium">Озвучка (TTS)</span>
                  </label>
                  {r.tts && (
                    <label className="flex flex-col gap-1">
                      <span className="text-muted-foreground">Шаблон фразы (те же плейсхолдеры)</span>
                      <Input
                        value={r.tts.template ?? ''}
                        placeholder="{user} прислал {gift}"
                        onChange={(e) => patchTts(r.id, { template: e.target.value })}
                      />
                    </label>
                  )}
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => runTest(r.id)}>
                      <Play size={12} /> Показать на оверлее
                    </Button>
                    <span className="text-muted-foreground">
                      сохраняет профиль и прогоняет правило как тест — алерт появится на
                      /overlay/alerts
                    </span>
                  </div>
                </CardContent>
              )}
            </Card>
          );
        })}
        {!profile && <p className="text-sm text-muted-foreground">Загрузка профиля…</p>}
      </div>
    </div>
  );
}
