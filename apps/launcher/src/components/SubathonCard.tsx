/**
 * @file SubathonCard.tsx
 * Subathon («субатон»): a countdown extended by paid events — gift
 * coins and subscriptions add seconds, the overlay shows the clock.
 * Rates persist in settings; the running clock is in-memory.
 */
import React, { useEffect, useState } from 'react';
import { Play, Save, Square, Timer } from 'lucide-react';
import * as api from '../api';
import { humanError } from '../errorMessages';
import type { SubathonStatus } from '../types';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';

function fmt(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor(s / 60) % 60;
  const ss = s % 60;
  const mm = String(m).padStart(2, '0');
  const sss = String(ss).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${sss}` : `${mm}:${sss}`;
}

export default function SubathonCard() {
  const [st, setSt] = useState<SubathonStatus | null>(null);
  const [startMin, setStartMin] = useState(60);
  const [secCoin, setSecCoin] = useState(5);
  const [secSub, setSecSub] = useState(300);
  const [maxH, setMaxH] = useState(12);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    const poll = () =>
      api
        .subathonStatus()
        .then((s) => {
          setSt(s);
          setSecCoin(s.sec_per_coin);
          setSecSub(s.sec_per_sub);
          setMaxH(Math.round(s.max_s / 3600));
        })
        .catch(() => {});
    poll();
    const t = setInterval(poll, 1000);
    return () => clearInterval(t);
  }, []);

  const save = () => {
    setErr('');
    setMsg('');
    api
      .saveSubathonCfg({
        sec_per_coin: secCoin,
        sec_per_sub: secSub,
        max_s: Math.max(60, maxH * 3600),
      })
      .then(() => setMsg('Настройки сохранены'))
      .catch((e) => setErr(humanError(e)));
  };

  const start = () => {
    setErr('');
    api.subathonStart(Math.max(60, startMin * 60)).catch((e) => setErr(humanError(e)));
  };

  const stop = () => api.subathonStop().catch((e) => setErr(humanError(e)));

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <Timer size={16} /> Субатон
          </CardTitle>
          {st?.running ? (
            <Button variant="destructive" size="sm" onClick={stop}>
              <Square size={12} /> Стоп
            </Button>
          ) : (
            <Button variant="outline" size="sm" onClick={save}>
              <Save size={12} /> Сохранить
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-xs text-muted-foreground">
          Обратный отсчёт на экране (оверлей «Субатон»): каждый коин
          подарка и подписка продлевают стрим. Потолок — чтобы кит не
          растянул вечность.
        </p>
        {st?.running ? (
          <div className="text-center">
            <div className="text-3xl font-bold tabular-nums text-pink-400">
              {fmt(st.remaining_s)}
            </div>
            <div className="text-[11px] text-muted-foreground">
              добавлено зрителями: +{fmt(st.added_s)}
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2 text-xs">
            <label className="flex flex-col gap-1">
              <span className="text-muted-foreground">Старт, мин</span>
              <Input
                type="number"
                min={1}
                value={startMin}
                onChange={(e) => setStartMin(Number(e.target.value) || 1)}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-muted-foreground">Сек за коин</span>
              <Input
                type="number"
                min={0}
                value={secCoin}
                onChange={(e) => setSecCoin(Number(e.target.value) || 0)}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-muted-foreground">Сек за подписку</span>
              <Input
                type="number"
                min={0}
                value={secSub}
                onChange={(e) => setSecSub(Number(e.target.value) || 0)}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-muted-foreground">Потолок, ч</span>
              <Input
                type="number"
                min={1}
                value={maxH}
                onChange={(e) => setMaxH(Number(e.target.value) || 1)}
              />
            </label>
            <Button size="sm" className="col-span-2" onClick={start}>
              <Play size={12} /> Запустить субатон
            </Button>
          </div>
        )}
        {msg && <p className="text-[11px] text-emerald-400">{msg}</p>}
        {err && <p className="text-[11px] text-destructive">{err}</p>}
      </CardContent>
    </Card>
  );
}
