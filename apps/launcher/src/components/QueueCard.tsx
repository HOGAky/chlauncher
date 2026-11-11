/**
 * @file QueueCard.tsx
 * Viewer queue («Очередь зрителей»): chat types !join to line up, the
 * streamer pulls the next one — that injects a `queue` event into the
 * pipeline so a trigger rule can act (e.g. invite into a Roblox room).
 * List renders on /overlay/queue.
 */
import React, { useEffect, useState } from 'react';
import { Eraser, ListOrdered, StepForward } from 'lucide-react';
import * as api from '../api';
import { humanError } from '../errorMessages';
import type { QueueStatus } from '../types';
import { Button } from './ui/button';
import { Switch } from './ui/switch';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';

export default function QueueCard() {
  const [st, setSt] = useState<QueueStatus | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    const poll = () => api.queueStatus().then(setSt).catch(() => {});
    poll();
    const t = setInterval(poll, 1500);
    return () => clearInterval(t);
  }, []);

  const next = () =>
    api.queueNext().catch((e) => setErr(humanError(e)));
  const clear = () =>
    api.queueClear().catch((e) => setErr(humanError(e)));
  const toggle = (open: boolean) =>
    api.queueSetOpen(open).catch((e) => setErr(humanError(e)));

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <ListOrdered size={16} /> Очередь зрителей
          </CardTitle>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            !join {st?.open ? 'открыта' : 'закрыта'}
            <Switch checked={st?.open ?? true} onCheckedChange={toggle} />
          </label>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-xs text-muted-foreground">
          Зрители пишут !join, чтобы встать в очередь, !leave — выйти.
          Кнопка «Следующий» вызывает первого — правило с типом «queue»
          решает, что с ним делать (телепорт в Roblox-комнату и т.п.).
          Список — на оверлее «Очередь».
        </p>
        {st?.last_called && (
          <p className="text-xs text-emerald-400">Сейчас: {st.last_called}</p>
        )}
        <div className="max-h-40 overflow-y-auto rounded-md border border-border/60">
          {st?.entries.length ? (
            st.entries.slice(0, 30).map((e) => (
              <div
                key={e.user}
                className="flex gap-2 px-2.5 py-1 text-xs border-b border-border/40 last:border-0"
              >
                <span className="w-6 text-sky-400 tabular-nums">{e.pos}</span>
                <span className="truncate">{e.user}</span>
              </div>
            ))
          ) : (
            <p className="px-2.5 py-2 text-xs text-muted-foreground">
              Очередь пуста
            </p>
          )}
        </div>
        <div className="flex gap-2">
          <Button size="sm" onClick={next} disabled={!st?.entries.length}>
            <StepForward size={12} /> Следующий
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={clear}
            disabled={!st?.entries.length}
          >
            <Eraser size={12} /> Очистить
          </Button>
          <span className="ml-auto text-[11px] text-muted-foreground self-center">
            в очереди: {st?.entries.length ?? 0}
          </span>
        </div>
        {err && <p className="text-[11px] text-destructive">{err}</p>}
      </CardContent>
    </Card>
  );
}
