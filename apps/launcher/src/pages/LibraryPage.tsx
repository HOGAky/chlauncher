/**
 * @file LibraryPage.tsx
 * Game library grid: download/update/play/kill per game + launch window
 * options tuned for TikTok Live Studio capture (9:16, borderless,
 * always-on-top, chroma key).
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Download, Play, RefreshCw, Square, Lock } from 'lucide-react';
import * as api from '../api';
import { useApp } from '../App';
import type { LibraryEntry, WindowOptions } from '../types';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Switch } from '../components/ui/switch';

import { humanError } from '../errorMessages';
const RESOLUTIONS: { label: string; w: number; h: number }[] = [
  { label: '9:16 · 540×960', w: 540, h: 960 },
  { label: '9:16 · 1080×1920', w: 1080, h: 1920 },
  { label: '16:9 · 1280×720', w: 1280, h: 720 },
  { label: '16:9 · 1920×1080', w: 1920, h: 1080 },
];

export default function LibraryPage() {
  const { subscription, boot } = useApp();
  const active = subscription?.status === 'active';
  const [games, setGames] = useState<LibraryEntry[]>([]);
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [opts, setOpts] = useState<WindowOptions>(
    boot?.window_options ?? { width: 540, height: 960, borderless: true, always_on_top: true, chroma_key: false }
  );
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api.listGames().then((r) => setGames(r.games)).catch((e) => setError(humanError(e)));
  }, []);

  useEffect(() => {
    refresh();
    let un: (() => void) | undefined;
    let un2: (() => void) | undefined;
    api.onGameExited(() => refresh()).then((u) => (un = u));
    api.onCatalogChanged(() => refresh()).then((u) => (un2 = u));
    return () => {
      un?.();
      un2?.();
    };
  }, [refresh]);

  /** Wraps an action with per-game busy state + error surfacing. */
  const act = (slug: string, label: string, fn: () => Promise<unknown>) => async () => {
    setBusy((b) => ({ ...b, [slug]: label }));
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(`${slug}: ${humanError(e)}`);
    } finally {
      setBusy((b) => ({ ...b, [slug]: '' }));
      refresh();
    }
  };

  const setOpt = <K extends keyof WindowOptions>(k: K, v: WindowOptions[K]) =>
    setOpts((o) => ({ ...o, [k]: v }));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Библиотека игр</h1>
        <Badge variant={active ? 'success' : 'destructive'}>
          {active ? 'Подписка активна' : 'Free · только бесплатные игры'}
        </Badge>
      </div>

      {/* Launch window options for TikTok Live Studio capture */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Параметры окна игры (для TikTok Live Studio)</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-3 text-sm">
          <label className="flex items-center gap-2">
            <span className="text-muted-foreground">Разрешение</span>
            <select
              className="h-8 rounded-md border border-input bg-secondary/40 px-2 text-sm"
              value={`${opts.width}x${opts.height}`}
              onChange={(e) => {
                const [w, h] = e.target.value.split('x').map(Number);
                setOpts((o) => ({ ...o, width: w, height: h }));
              }}
            >
              {RESOLUTIONS.map((r) => (
                <option key={r.label} value={`${r.w}x${r.h}`}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-muted-foreground">
            Без рамок
            <Switch checked={opts.borderless} onCheckedChange={(v) => setOpt('borderless', v)} />
          </label>
          <label className="flex items-center gap-2 text-muted-foreground">
            Поверх окон
            <Switch checked={opts.always_on_top} onCheckedChange={(v) => setOpt('always_on_top', v)} />
          </label>
          <label className="flex items-center gap-2 text-muted-foreground">
            <span className="inline-block h-3 w-3 rounded-sm bg-[#00FF00]" />
            Chroma Key
            <Switch
              checked={opts.chroma_key}
              onCheckedChange={(v) => {
                setOpt('chroma_key', v);
                api.setChromaKey(v).catch(() => {});
              }}
            />
          </label>
        </CardContent>
      </Card>

      {error && (
        <div className="text-xs text-red-400 bg-destructive/10 border border-destructive/30 rounded-md px-3 py-2">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {games.map((g) => {
          const isBusy = !!busy[g.slug];
          // §8.3: Free accounts play is_free titles; paid titles need an
          // active sub AND the paid_games entitlement (undefined = not
          // fetched yet → optimistic, the server still enforces).
          const canPlay = g.is_free || (active && (g.paid_games_allowed ?? true));
          return (
            <Card key={g.slug} className="overflow-hidden">
              <div className="h-24 bg-gradient-to-br from-primary/30 to-accent/30 flex items-end p-3">
                <span className="text-2xl font-black opacity-70">{g.title}</span>
              </div>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle>{g.title}</CardTitle>
                  <div className="flex gap-1.5">
                    {g.running && <Badge variant="success">Запущена</Badge>}
                    {g.update_available && <Badge variant="warning">Обновление</Badge>}
                    {g.is_free ? (
                      <Badge variant="outline">Free</Badge>
                    ) : !g.paid_games_allowed && !active ? (
                      <Badge variant="destructive">Платная</Badge>
                    ) : null}
                    {!g.installed && <Badge variant="outline">Не установлена</Badge>}
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  v{g.version}
                  {g.installed && ` · установлена v${g.installed.version}`}
                </p>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground line-clamp-2">{g.description}</p>
              </CardContent>
              <CardFooter>
                {!g.installed || g.update_available ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={isBusy || !canPlay}
                    title={canPlay ? '' : 'Платная игра — нужна подписка'}
                    onClick={act(g.slug, 'dl', () => api.downloadGame(g.slug))}
                  >
                    {g.update_available ? <RefreshCw size={14} /> : <Download size={14} />}
                    {isBusy ? 'Загрузка…' : g.update_available ? 'Обновить' : 'Скачать'}
                  </Button>
                ) : (
                  <>
                    <Button
                      size="sm"
                      disabled={isBusy || !canPlay || g.running}
                      title={canPlay ? '' : 'Платная игра — нужна подписка'}
                      onClick={act(g.slug, 'play', () => api.playGame(g.slug, opts))}
                    >
                      {canPlay ? <Play size={14} /> : <Lock size={14} />}
                      {isBusy ? 'Запуск…' : 'Играть'}
                    </Button>
                    {g.running && (
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => {
                          if (window.confirm(`Закрыть «${g.title}»? Сначала будет отправлен graceful shutdown.`)) {
                            void act(g.slug, 'kill', () => api.killGame(g.slug))();
                          }
                        }}
                      >
                        <Square size={14} /> Закрыть
                      </Button>
                    )}
                  </>
                )}
              </CardFooter>
            </Card>
          );
        })}
        {games.length === 0 && (
          <p className="text-sm text-muted-foreground col-span-full">
            Каталог пуст или сервер недоступен.
          </p>
        )}
      </div>
    </div>
  );
}
