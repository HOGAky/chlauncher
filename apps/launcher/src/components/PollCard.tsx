/**
 * @file PollCard.tsx
 * Chat polls («Голосования»): the streamer starts a vote, chat types the
 * option number (`1`/`!2`/`!vote 3`), the winner is announced on the
 * alerts overlay and re-injected as a `poll` event — so a normal
 * trigger rule can run the action. Live bars: /overlay/poll.
 */
import React, { useEffect, useState } from 'react';
import { BarChart3, Play, Plus, Square, Trash2 } from 'lucide-react';
import * as api from '../api';
import { humanError } from '../errorMessages';
import type { PollStatus } from '../types';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';

export default function PollCard() {
  const [title, setTitle] = useState('');
  const [options, setOptions] = useState<string[]>(['', '']);
  const [duration, setDuration] = useState(30);
  const [action, setAction] = useState('');
  const [st, setSt] = useState<PollStatus | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    const poll = () => api.pollStatus().then(setSt).catch(() => {});
    poll();
    const t = setInterval(poll, 1000);
    return () => clearInterval(t);
  }, []);

  const start = () => {
    setErr('');
    api
      .pollStart({
        title: title.trim(),
        options: options.map((o) => o.trim()).filter(Boolean),
        duration_s: duration,
        action: action.trim(),
      })
      .catch((e) => setErr(humanError(e)));
  };

  const stop = () => api.pollStop().catch((e) => setErr(humanError(e)));

  const max = st ? Math.max(1, ...st.counts) : 1;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <BarChart3 size={16} /> Голосование в чате
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-xs text-muted-foreground">
          Зрители голосуют номером в чате (1, 2… или !vote 2). Победитель
          попадает в алерты и запускает действие — например «spawn
          {'{option}'}». Живые столбики — на оверлее «Опрос».
        </p>

        {st?.running ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium">{st.title || 'Голосование'}</span>
              <span className="text-muted-foreground tabular-nums">
                {st.ends_in_s > 0 ? `${st.ends_in_s}с · ` : ''}
                {st.total} голосов
              </span>
            </div>
            {st.options.map((o, i) => (
              <div key={i} className="text-xs">
                <div className="flex justify-between gap-2">
                  <span className="truncate">
                    <b className="text-sky-400 mr-1">{i + 1}</b>
                    {o}
                  </span>
                  <span className="tabular-nums text-muted-foreground">
                    {st.counts[i] ?? 0}
                  </span>
                </div>
                <div className="h-1.5 mt-1 rounded bg-secondary overflow-hidden">
                  <div
                    className="h-full bg-sky-500 transition-all"
                    style={{ width: `${((st.counts[i] ?? 0) / max) * 100}%` }}
                  />
                </div>
              </div>
            ))}
            <Button variant="destructive" size="sm" onClick={stop}>
              <Square size={12} /> Завершить и выбрать победителя
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <Input
              placeholder="Вопрос («кого спавнить?»)"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            {options.map((o, i) => (
              <div key={i} className="flex gap-2">
                <Input
                  placeholder={`Вариант ${i + 1}`}
                  value={o}
                  onChange={(e) =>
                    setOptions((os) => os.map((x, j) => (j === i ? e.target.value : x)))
                  }
                />
                {options.length > 2 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setOptions((os) => os.filter((_, j) => j !== i))}
                  >
                    <Trash2 size={13} />
                  </Button>
                )}
              </div>
            ))}
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={options.length >= 8}
                onClick={() => setOptions((os) => [...os, ''])}
              >
                <Plus size={13} /> Вариант
              </Button>
              <Input
                className="w-24"
                type="number"
                min={0}
                title="Секунды, 0 = вручную"
                value={duration}
                onChange={(e) => setDuration(Number(e.target.value) || 0)}
              />
              <Input
                className="flex-1"
                placeholder="Действие: spawn {option}"
                value={action}
                onChange={(e) => setAction(e.target.value)}
              />
            </div>
            <Button size="sm" className="self-start" onClick={start}>
              <Play size={12} /> Запустить голосование
            </Button>
            {st?.last_winner && (
              <p className="text-[11px] text-muted-foreground">
                Прошлый победитель: «{st.last_winner}»
              </p>
            )}
          </div>
        )}
        {err && <p className="text-[11px] text-destructive">{err}</p>}
      </CardContent>
    </Card>
  );
}
