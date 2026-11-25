/**
 * @file GameEditDialog.tsx
 * Мanifest editor for library game packs (admin-only): structured fields
 * (title/desc/section/afk/hidden) over the effective manifest plus a raw
 * JSON mode for full developer access (rules, window, launch, …). Saves
 * as a user-side patch — bundled manifests stay untouched, «Сбросить»
 * restores them.
 */
import React, { useEffect, useState } from 'react';
import { X, Save, RotateCcw, Code2 } from 'lucide-react';
import * as api from '../api';
import { Button } from './ui/button';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Input } from './ui/input';
import { Switch } from './ui/switch';
import { humanError } from '../errorMessages';

interface Props {
  gameId: string;
  /** Existing section names — suggestions for the Раздел field. */
  sections: string[];
  onClose: (changed: boolean) => void;
}

type Manifest = Record<string, unknown>;

export default function GameEditDialog({ gameId, sections, onClose }: Props) {
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [meta, setMeta] = useState<{ overridden: boolean; dir_name: string } | null>(null);
  const [rawMode, setRawMode] = useState(false);
  const [rawText, setRawText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .packManifest(gameId)
      .then((r) => {
        setManifest(r.manifest);
        setRawText(JSON.stringify(r.manifest, null, 2));
        setMeta({ overridden: r.overridden, dir_name: r.dir_name });
      })
      .catch((e) => setError(humanError(e)));
  }, [gameId]);

  /** Patches one manifest field from a structured control. */
  const set = (k: string, v: unknown) =>
    setManifest((m) => {
      if (!m) return m;
      const next = { ...m };
      if (v === undefined || v === '') delete next[k];
      else next[k] = v;
      return next;
    });

  const str = (k: string) => (manifest?.[k] as string | undefined) ?? '';

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = rawMode ? (JSON.parse(rawText) as Manifest) : manifest;
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new Error('Манифест должен быть JSON-объектом');
      }
      await api.savePackManifest(gameId, body);
      onClose(true);
    } catch (e) {
      setError(humanError(e));
      setBusy(false);
    }
  };

  const reset = async () => {
    if (!window.confirm('Удалить свой манифест? Стандартный из сборки вернётся.')) return;
    setBusy(true);
    setError(null);
    try {
      await api.resetPackManifest(gameId);
      onClose(true);
    } catch (e) {
      setError(humanError(e));
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
      onClick={() => onClose(false)}
    >
      <Card
        className="w-full max-w-lg max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Редактор игры — {gameId}</CardTitle>
            <Button size="sm" variant="ghost" onClick={() => onClose(false)}>
              <X size={14} />
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Сохраняется как свой манифест в <code>games/{meta?.dir_name ?? gameId}/game.json</code> —
            поля, которые не трогаешь, наследуют стандартные значения.
          </p>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          {error && (
            <div className="text-xs text-red-400 bg-destructive/10 border border-destructive/30 rounded-md px-3 py-2">
              {error}
            </div>
          )}
          {!manifest && !error && <p className="text-muted-foreground">Загрузка…</p>}
          {manifest && (
            <>
              <div className="flex justify-end">
                <Button
                  size="sm"
                  variant={rawMode ? 'default' : 'secondary'}
                  onClick={() => {
                    if (!rawMode) setRawText(JSON.stringify(manifest, null, 2));
                    setRawMode(!rawMode);
                  }}
                >
                  <Code2 size={13} /> JSON
                </Button>
              </div>
              {rawMode ? (
                <textarea
                  className="w-full h-72 rounded-md border border-input bg-secondary/40 px-3 py-2 font-mono text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  value={rawText}
                  onChange={(e) => setRawText(e.target.value)}
                  spellCheck={false}
                />
              ) : (
                <>
                  <label className="flex flex-col gap-1">
                    <span className="text-muted-foreground">Название</span>
                    <Input value={str('title')} onChange={(e) => set('title', e.target.value)} />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-muted-foreground">Описание</span>
                    <textarea
                      className="w-full h-16 rounded-md border border-input bg-secondary/40 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      value={str('desc')}
                      onChange={(e) => set('desc', e.target.value)}
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-muted-foreground">
                      Раздел (своя вкладка в библиотеке)
                    </span>
                    <Input
                      value={str('section')}
                      onChange={(e) => set('section', e.target.value)}
                      list="game-sections"
                      placeholder="например: Мемы"
                    />
                    <datalist id="game-sections">
                      {sections.map((s) => (
                        <option key={s} value={s} />
                      ))}
                    </datalist>
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-muted-foreground">Иконка (файл в папке пакета)</span>
                    <Input
                      value={str('icon')}
                      onChange={(e) => set('icon', e.target.value)}
                      placeholder="icon.svg"
                    />
                  </label>
                  <div className="flex items-center gap-6">
                    <label className="flex items-center gap-2 text-muted-foreground">
                      АФК-стрим
                      <Switch
                        checked={manifest.afk === true}
                        onCheckedChange={(v) => set('afk', v || undefined)}
                      />
                    </label>
                    <label
                      className="flex items-center gap-2 text-muted-foreground"
                      title="Без гейта тарифа — попадёт в «Бесплатные»"
                    >
                      Без тарифа
                      <Switch
                        checked={manifest.free === true}
                        onCheckedChange={(v) => set('free', v || undefined)}
                      />
                    </label>
                    <label className="flex items-center gap-2 text-muted-foreground">
                      Скрытая
                      <Switch
                        checked={manifest.hidden === true}
                        onCheckedChange={(v) => set('hidden', v || undefined)}
                      />
                    </label>
                  </div>
                </>
              )}
            </>
          )}
        </CardContent>
        <CardContent className="flex items-center gap-2 pt-0">
          <Button size="sm" disabled={busy || !manifest} onClick={save}>
            <Save size={14} /> Сохранить
          </Button>
          {meta?.overridden && (
            <Button size="sm" variant="secondary" disabled={busy} onClick={reset}>
              <RotateCcw size={14} /> Стандартный манифест
            </Button>
          )}
          <span className="text-xs text-muted-foreground ml-auto">
            id пакета не меняется
          </span>
        </CardContent>
      </Card>
    </div>
  );
}
