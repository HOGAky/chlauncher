/**
 * @file GamesPage.tsx
 * Built-in interactive TikTok games (parity spec §7–§9): catalogue card
 * per game — session controls (start/pause/resume/stop), capture-window
 * button (transparent / chroma), per-game settings (round, volume,
 * antiflood) and a JSON rules editor. Results ledger below.
 */
import React, { useEffect, useState } from 'react';
import { Gamepad2, Lock, MonitorPlay, Pause, Play, Square, Save, Trophy, Download, Upload } from 'lucide-react';
import * as api from '../api';
import type { BuiltinGameMeta, BuiltinGamesView, GameResult } from '../types';
import { humanError } from '../errorMessages';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Input } from '../components/ui/input';

export default function GamesPage() {
  const [view, setView] = useState<BuiltinGamesView | null>(null);
  const [results, setResults] = useState<GameResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = () =>
    api
      .builtinGames()
      .then(setView)
      .catch((e) => setError(humanError(e)));

  useEffect(() => {
    void refresh();
    api
      .gameResults()
      .then((r) => setResults(r.results))
      .catch(() => {});
    const id = setInterval(refresh, 10_000);
    return () => clearInterval(id);
  }, []);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  };

  const active = view?.session.active ?? null;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Интерактивные игры</h2>
        <p className="text-sm text-muted-foreground">
          Игра живёт в отдельном окне — захватите его в TikTok LIVE Studio / OBS.
          Подарки, лайки и команды чата меняют игру в реальном времени.
        </p>
      </div>
      {error && <div className="text-sm text-red-400">{error}</div>}
      {active && (
        <Card>
          <CardContent className="py-3 flex items-center gap-3 text-sm">
            <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
            Сессия: <b>{view?.games.find((g) => g.id === active.game_id)?.title ?? active.game_id}</b>
            <span className="text-muted-foreground">({active.status})</span>
            <span className="flex-1" />
            {active.status === 'running' ? (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => act(api.gamePause)}>
                <Pause size={14} className="mr-1" /> Пауза
              </Button>
            ) : (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => act(api.gameResume)}>
                <Play size={14} className="mr-1" /> Продолжить
              </Button>
            )}
            <Button size="sm" variant="destructive" disabled={busy} onClick={() => act(api.gameStop)}>
              <Square size={14} className="mr-1" /> Стоп
            </Button>
          </CardContent>
        </Card>
      )}
      <div className="grid gap-4 xl:grid-cols-3">
        {view?.games.map((g) => (
          <GameCard
            key={g.id}
            g={g}
            active={active?.game_id === g.id}
            busy={busy}
            onStart={() =>
              act(async () => {
                await api.gameStart(g.id);
                await api.openOverlayWindow(g.overlay_path.replace(/^\//, ''), false);
              })
            }
            onStartChroma={() =>
              act(async () => {
                await api.gameStart(g.id);
                await api.openOverlayWindow(g.overlay_path.replace(/^\//, ''), true);
              })
            }
            onClose={() => act(() => api.closeOverlayWindow(g.overlay_path.replace(/^\//, '')))}
            onError={setError}
          />
        ))}
      </div>
      {results.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Trophy size={16} /> История сессий
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-xs">
            {results.slice(0, 10).map((r, i) => (
              <div key={i} className="flex gap-3 text-muted-foreground">
                <span>{new Date(r.ended_at).toLocaleString('ru-RU')}</span>
                <span className="text-foreground font-medium">{r.game_id}</span>
                <span>{r.winner ?? '—'}</span>
                {typeof r.score === 'number' && <span>{r.score} очков</span>}
                {r.top?.[0] && <span>топ: {r.top[0].user}</span>}
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function GameCard({
  g,
  active,
  busy,
  onStart,
  onStartChroma,
  onClose,
  onError,
}: {
  g: BuiltinGameMeta;
  active: boolean;
  busy: boolean;
  onStart: () => void;
  onStartChroma: () => void;
  onClose: () => void;
  onError: (e: string | null) => void;
}) {
  const [cfg, setCfg] = useState(g.cfg);
  const [rulesText, setRulesText] = useState(() => JSON.stringify(g.cfg.rules, null, 2));
  const [edit, setEdit] = useState(false);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    onError(null);
    try {
      const rules = JSON.parse(rulesText);
      const next = { ...cfg, rules };
      await api.gameSetCfg(g.id, next);
      setCfg(next);
      setEdit(false);
    } catch (e) {
      onError(humanError(e));
    } finally {
      setSaving(false);
    }
  };

  // §11 — presets round-trip as plain JSON files between streamers.
  const exportCfg = () => {
    const blob = new Blob([JSON.stringify(cfg, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `chlauncher_${g.id}_preset.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const importCfg = (f: File | null) => {
    if (!f) return;
    f.text()
      .then((t) => {
        const parsed = JSON.parse(t);
        if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
        setCfg((c) => ({ ...c, ...parsed }));
        if (Array.isArray(parsed.rules)) setRulesText(JSON.stringify(parsed.rules, null, 2));
        setEdit(true);
      })
      .catch(() => onError('Невалидный JSON пресета'));
  };

  return (
    <Card className={active ? 'border-primary/50' : ''}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Gamepad2 size={16} />
          {g.title}
          {!g.allowed && <Lock size={14} className="text-amber-400" />}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted-foreground text-xs">{g.desc}</p>
        <div className="flex flex-wrap gap-2">
          {!g.allowed ? (
            <span className="text-xs text-amber-400">Нужен тариф с этой игрой</span>
          ) : (
            <>
              <Button size="sm" disabled={busy} onClick={onStart}>
                <Play size={14} className="mr-1" /> Старт
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                title="Окно с пурпурным фоном — для chroma-key, когда прозрачность недоступна"
                onClick={onStartChroma}
              >
                <MonitorPlay size={14} className="mr-1" /> Chroma
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={onClose}>
                Закрыть окно
              </Button>
            </>
          )}
        </div>
        <div className="flex items-center gap-2 text-xs">
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={cfg.enabled}
              onChange={(e) => setCfg({ ...cfg, enabled: e.target.checked })}
            />
            включена
          </label>
          <label className="flex items-center gap-1">
            раунд, с
            <Input
              type="number"
              className="h-6 w-20 text-xs"
              value={cfg.round_sec}
              onChange={(e) => setCfg({ ...cfg, round_sec: Number(e.target.value) || 0 })}
            />
          </label>
          <label className="flex items-center gap-1">
            звук
            <input
              type="range"
              min={0}
              max={1}
              step={0.1}
              value={cfg.volume}
              onChange={(e) => setCfg({ ...cfg, volume: Number(e.target.value) })}
            />
          </label>
        </div>
        <div>
          <button
            className="text-xs text-primary hover:underline"
            onClick={() => setEdit((v) => !v)}
          >
            {edit ? 'Скрыть триггеры' : `Триггеры (${g.cfg.rules.length}) — редактировать`}
          </button>
          {edit && (
            <div className="mt-2 space-y-2">
              <textarea
                className="w-full h-44 rounded-md border border-border bg-background p-2 font-mono text-[11px]"
                value={rulesText}
                onChange={(e) => setRulesText(e.target.value)}
                spellCheck={false}
              />
              <Button size="sm" disabled={saving} onClick={save}>
                <Save size={14} className="mr-1" /> Сохранить настройки
              </Button>
            </div>
          )}
          {!edit && (
            <div className="mt-2 flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={saving}
                onClick={save}
                title="Сохранить раунд/звук/флаг включения без правки триггеров"
              >
                <Save size={14} className="mr-1" /> Сохранить
              </Button>
              <Button size="sm" variant="ghost" onClick={exportCfg} title="Скачать пресет JSON">
                <Download size={14} />
              </Button>
              <label
                className="inline-flex cursor-pointer items-center rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-secondary/60"
                title="Загрузить пресет JSON"
              >
                <Upload size={14} />
                <input
                  type="file"
                  accept="application/json,.json"
                  className="hidden"
                  onChange={(e) => importCfg(e.target.files?.[0] ?? null)}
                />
              </label>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
