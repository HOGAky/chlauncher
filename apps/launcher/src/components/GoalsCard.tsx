/**
 * @file GoalsCard.tsx
 * Stream goals («Цели стрима»): session counters that fire an action
 * once on reaching a target — "300 роз → босс". Live values poll
 * `get_goals` every 3 s; the overlay bar is /overlay/goals.
 */
import React, { useEffect, useState } from 'react';
import { Plus, RotateCcw, Save, Target, Trash2 } from 'lucide-react';
import * as api from '../api';
import { humanError } from '../errorMessages';
import type { GoalProgress, StreamGoal } from '../types';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Switch } from './ui/switch';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';

const KINDS: [string, string][] = [
  ['gift', 'Подарки'],
  ['like', 'Лайки'],
  ['donation', 'Донаты'],
  ['comment', 'Комментарии'],
  ['follow', 'Подписки'],
  ['any', 'Всё подряд'],
];

function newGoal(): StreamGoal {
  return {
    id: '',
    label: '',
    source: 'any',
    event_kind: 'gift',
    match_value: '',
    count_coins: false,
    target: 100,
    action: '',
    celebrate: '',
    enabled: true,
  };
}

export default function GoalsCard() {
  const [goals, setGoals] = useState<StreamGoal[]>([]);
  const [progress, setProgress] = useState<Map<string, GoalProgress>>(new Map());
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  // Live progress — poll every 3 s (same cadence as the overlay page).
  useEffect(() => {
    const poll = () =>
      api
        .getGoals()
        .then((r) => setProgress(new Map(r.goals.map((g) => [g.id, g]))))
        .catch(() => {});
    poll();
    const t = setInterval(poll, 3000);
    return () => clearInterval(t);
  }, []);

  // Load definitions once — the editor state is the source of truth
  // until saved (live rows only carry progress fields).
  useEffect(() => {
    api
      .getGoals()
      .then((r) => setGoals(r.defs))
      .catch(() => {});
  }, []);

  const patch = (i: number, p: Partial<StreamGoal>) =>
    setGoals((gs) => gs.map((g, j) => (j === i ? { ...g, ...p } : g)));

  const save = () => {
    setErr('');
    setMsg('');
    api
      .saveGoals(goals)
      .then(() => setMsg('Цели сохранены'))
      .catch((e) => setErr(humanError(e)));
  };

  const reset = () => {
    api
      .resetGoals()
      .then(() => setMsg('Счётчики сброшены — цели снова активны'))
      .catch((e) => setErr(humanError(e)));
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <Target size={16} /> Цели стрима
          </CardTitle>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={reset}>
              <RotateCcw size={12} /> Сброс
            </Button>
            <Button size="sm" onClick={save}>
              <Save size={12} /> Сохранить
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-xs text-muted-foreground">
          Счётчик за весь стрим: «300 роз → спавн босса». Бары — на оверлее
          «Цели», по выполнении — алерт и одно действие. Счётчики живут до
          сброса или перезапуска лаунчера.
        </p>
        {goals.map((g, i) => {
          const p = progress.get(g.id);
          const val = p?.value ?? 0;
          const pct = g.target > 0 ? Math.min(100, Math.round((val / g.target) * 100)) : 0;
          return (
            <div key={g.id || i} className="rounded-md border border-border/60 p-2.5 flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <Switch
                  checked={g.enabled}
                  onCheckedChange={(v) => patch(i, { enabled: v })}
                />
                <Input
                  className="flex-1"
                  placeholder="Название («300 роз → босс»)"
                  value={g.label}
                  onChange={(e) => patch(i, { label: e.target.value })}
                />
                <span className="text-[11px] text-muted-foreground tabular-nums w-20 text-right">
                  {val}/{g.target}
                  {p?.done && ' ✓'}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setGoals((gs) => gs.filter((_, j) => j !== i))}
                >
                  <Trash2 size={13} />
                </Button>
              </div>
              <div className="h-1.5 rounded bg-secondary overflow-hidden">
                <div
                  className="h-full bg-emerald-500 transition-all"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <select
                  className="bg-input rounded px-2 py-1.5 text-xs"
                  value={g.event_kind}
                  onChange={(e) => patch(i, { event_kind: e.target.value })}
                >
                  {KINDS.map(([v, t]) => (
                    <option key={v} value={v}>
                      {t}
                    </option>
                  ))}
                </select>
                <Input
                  placeholder="Фильтр («rose», пусто = всё)"
                  value={g.match_value}
                  onChange={(e) => patch(i, { match_value: e.target.value })}
                />
                <Input
                  type="number"
                  min={1}
                  placeholder="Цель"
                  value={g.target || ''}
                  onChange={(e) => patch(i, { target: Number(e.target.value) || 0 })}
                />
                <Input
                  placeholder="Действие при достижении"
                  value={g.action}
                  onChange={(e) => patch(i, { action: e.target.value })}
                />
              </div>
              <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <Switch
                  checked={g.count_coins}
                  onCheckedChange={(v) => patch(i, { count_coins: v })}
                />
                Считать коины (стоимость), не количество
              </label>
            </div>
          );
        })}
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          onClick={() => setGoals((gs) => [...gs, newGoal()])}
        >
          <Plus size={13} /> Добавить цель
        </Button>
        {msg && <p className="text-[11px] text-emerald-400">{msg}</p>}
        {err && <p className="text-[11px] text-destructive">{err}</p>}
      </CardContent>
    </Card>
  );
}
