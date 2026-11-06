/**
 * @file MapperPage.tsx
 * Trigger mapper — the killer feature: visual rule editor mapping raw
 * stream events (TikTok gifts/likes, DonationAlerts donations) to game
 * commands. Profiles persist per-game as JSON in launcher settings.
 */
import React, { useEffect, useState } from 'react';
import { Plus, Save, Trash2, Wand2 } from 'lucide-react';
import * as api from '../api';
import type { TriggerProfile, TriggerRule } from '../types';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';

const SOURCES = ['any', 'tiktok', 'donationalerts', 'simulator'];
const KINDS = ['any', 'gift', 'like', 'comment', 'donation', 'follow', 'share', 'subscribe', 'join'];
const ACTIONS = [
  'spawn_enemy', 'spawn_boss', 'heal_player', 'log_only',
  // Steal the Stream whitelist (docs/roblox-integration.md §C)
  'spawn_chaser', 'invert_controls', 'drop_floor', 'yeet', 'freeze',
  'slow_field', 'camera_spin', 'wall_ahead', 'decoy_clones', 'shield',
  'speed_boost', 'checkpoint', 'coin_rain', 'fireworks',
];

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
  };
}

export default function MapperPage() {
  const [slug, setSlug] = useState('mock-game');
  const [profile, setProfile] = useState<TriggerProfile | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getTriggers(slug).then(setProfile).catch((e) => setError(String(e)));
  }, [slug]);

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
      setError(String(e));
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
          >
            <option value="mock-game">mock-game</option>
          </select>
          <Button
            size="sm"
            variant="outline"
            title="Загрузить пресет правил Steal the Stream (Roblox)"
            onClick={() =>
              api
                .applyTriggerTemplate(slug, 'steal-the-stream')
                .then(setProfile)
                .catch((e) => setError(String(e)))
            }
          >
            <Wand2 size={14} /> StS шаблон
          </Button>
          <Button size="sm" variant="secondary" onClick={addRule}>
            <Plus size={14} /> Правило
          </Button>
          <Button size="sm" onClick={save}>
            <Save size={14} /> {saved ? 'Сохранено' : 'Сохранить'}
          </Button>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        Первое совпавшее правило побеждает — ставьте более специфичные правила выше.
        Пустое «Совпадение» ловит все события этого вида; «Мин. сумма» фильтрует по
        количеству/сумме (донаты — в копейках).
      </p>

      {error && (
        <div className="text-xs text-red-400 bg-destructive/10 border border-destructive/30 rounded-md px-3 py-2">
          {error}
        </div>
      )}

      <div className="flex flex-col gap-2">
        {profile?.rules.map((r) => (
          <Card key={r.id}>
            <CardContent className="pt-3 flex flex-wrap items-center gap-2 text-sm">
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
              <Input
                className="w-32"
                placeholder="совпадение (Rose)"
                value={r.match_value}
                onChange={(e) => patchRule(r.id, { match_value: e.target.value })}
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
                {ACTIONS.map((a) => (
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
                className="ml-auto"
                onClick={() => removeRule(r.id)}
              >
                <Trash2 size={14} />
              </Button>
            </CardContent>
          </Card>
        ))}
        {!profile && <p className="text-sm text-muted-foreground">Загрузка профиля…</p>}
      </div>
    </div>
  );
}
