/**
 * @file TimedCard.tsx
 * Timed auto-events («каждые N минут → действие») + hype-meter knobs.
 * A fired timer re-enters the pipeline as a `timer` event — a rule
 * (kind=timer, match=label) runs the action like any trigger.
 */
import React, { useEffect, useState } from 'react';
import { AlarmClock, Flame, Plus, Save, Trash2 } from 'lucide-react';
import * as api from '../api';
import { humanError } from '../errorMessages';
import type { HypeStatus, TimedEvent } from '../types';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Switch } from './ui/switch';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';

export default function TimedCard() {
  const [events, setEvents] = useState<TimedEvent[]>([]);
  const [hype, setHype] = useState<HypeStatus | null>(null);
  const [window_s, setWindow] = useState(60);
  const [target, setTarget] = useState(500);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    api.getTimedEvents().then(setEvents).catch(() => {});
    api
      .hypeStatus()
      .then((h) => {
        setHype(h);
        setWindow(h.window_s);
        setTarget(h.target_coins);
      })
      .catch(() => {});
    const t = setInterval(() => api.hypeStatus().then(setHype).catch(() => {}), 2000);
    return () => clearInterval(t);
  }, []);

  const patch = (i: number, p: Partial<TimedEvent>) =>
    setEvents((es) => es.map((e, j) => (j === i ? { ...e, ...p } : e)));

  const saveAll = () => {
    setErr('');
    setMsg('');
    Promise.all([
      api.saveTimedEvents(events),
      api.saveHypeCfg({ window_s, target_coins: target }),
    ])
      .then(() => setMsg('Сохранено'))
      .catch((e) => setErr(humanError(e)));
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <AlarmClock size={16} /> Автособытия и хайп
          </CardTitle>
          <Button variant="outline" size="sm" onClick={saveAll}>
            <Save size={12} /> Сохранить
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-xs text-muted-foreground">
          Таймер шлёт событие «timer» каждые N минут — правило с типом
          «timer» и совпадением по названию выполняет действие
          (напоминание, периодический эффект).
        </p>
        {events.map((e, i) => (
          <div key={e.id || i} className="flex items-center gap-2">
            <Switch checked={e.enabled} onCheckedChange={(v) => patch(i, { enabled: v })} />
            <Input
              className="flex-1"
              placeholder="Название («напоминание»)"
              value={e.label}
              onChange={(ev) => patch(i, { label: ev.target.value })}
            />
            <Input
              className="w-20"
              type="number"
              min={1}
              title="Интервал, мин"
              value={e.interval_min}
              onChange={(ev) => patch(i, { interval_min: Number(ev.target.value) || 1 })}
            />
            <span className="text-[11px] text-muted-foreground">мин</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setEvents((es) => es.filter((_, j) => j !== i))}
            >
              <Trash2 size={13} />
            </Button>
          </div>
        ))}
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          disabled={events.length >= 20}
          onClick={() =>
            setEvents((es) => [
              ...es,
              { id: '', label: '', interval_min: 10, enabled: true },
            ])
          }
        >
          <Plus size={13} /> Добавить таймер
        </Button>

        <div className="border-t border-border/60 pt-3 flex flex-col gap-2">
          <div className="flex items-center gap-2 text-xs">
            <Flame size={14} className="text-orange-400" />
            <span className="font-medium">Хайп-метр</span>
            <span className="ml-auto tabular-nums text-muted-foreground">
              {hype ? `${hype.coins} коинов · ${hype.level}%` : ''}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <label className="flex flex-col gap-1">
              <span className="text-muted-foreground">Окно, сек</span>
              <Input
                type="number"
                min={5}
                value={window_s}
                onChange={(e) => setWindow(Number(e.target.value) || 5)}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-muted-foreground">100% = коинов</span>
              <Input
                type="number"
                min={1}
                value={target}
                onChange={(e) => setTarget(Number(e.target.value) || 1)}
              />
            </label>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Шкала на оверлее «Хайп» — растёт от платных событий за окно.
          </p>
        </div>
        {msg && <p className="text-[11px] text-emerald-400">{msg}</p>}
        {err && <p className="text-[11px] text-destructive">{err}</p>}
      </CardContent>
    </Card>
  );
}
