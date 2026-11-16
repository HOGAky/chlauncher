/**
 * @file SpinnerPage.tsx
 * Gift Spinner pool editor (parity spec §7): segment table with
 * weights → live percentages, colors, per-segment actions, spin_ms —
 * plus a canvas preview of the wheel. Rules pick a pool in the mapper
 * (🎡 dropdown); the scheduler picks the outcome and /overlay/spinner
 * only animates it.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Plus, Save, Trash2 } from 'lucide-react';
import * as api from '../api';
import type { SpinnerPool, SpinnerSegment } from '../types';
import { humanError } from '../errorMessages';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';

const PALETTE = ['#7c3aed', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#8b5cf6', '#14b8a6'];

function newPool(): SpinnerPool {
  return { name: '', spin_ms: 4500, segments: [] };
}
function newSeg(i: number): SpinnerSegment {
  return {
    label: `Сегмент ${i + 1}`,
    action: 'log_only',
    weight: 1,
    color: PALETTE[i % PALETTE.length],
  };
}

/** Static wheel preview — same math as /overlay/spinner's draw(). */
function WheelPreview({ pool }: { pool: SpinnerPool }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    const ctx = cv?.getContext('2d');
    if (!cv || !ctx) return;
    const segs = pool.segments;
    const D = cv.width;
    const R = D / 2 - 8;
    const CX = D / 2;
    const CY = D / 2;
    ctx.clearRect(0, 0, D, D);
    const total = segs.reduce((a, s) => a + (s.weight || 1), 0) || 1;
    let a = -Math.PI / 2;
    for (const s of segs) {
      const sweep = ((s.weight || 1) / total) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(CX, CY);
      ctx.arc(CX, CY, R, a, a + sweep);
      ctx.closePath();
      ctx.fillStyle = s.color || '#7c3aed';
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,.4)';
      ctx.stroke();
      const mid = a + sweep / 2;
      ctx.save();
      ctx.translate(CX, CY);
      ctx.rotate(mid);
      ctx.textAlign = 'right';
      ctx.fillStyle = '#fff';
      ctx.font = '600 11px Segoe UI, sans-serif';
      ctx.fillText(String(s.label || '').slice(0, 14), R - 8, 4);
      ctx.restore();
      a += sweep;
    }
    ctx.beginPath();
    ctx.moveTo(CX - 10, 2);
    ctx.lineTo(CX + 10, 2);
    ctx.lineTo(CX, 20);
    ctx.closePath();
    ctx.fillStyle = '#fff';
    ctx.fill();
  }, [pool]);
  return <canvas ref={ref} width={200} height={200} className="mx-auto" />;
}

export default function SpinnerPage() {
  const [pools, setPools] = useState<SpinnerPool[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [pool, setPool] = useState<SpinnerPool | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const reload = () => api.listSpinners().then(setPools).catch(() => {});
  useEffect(() => {
    reload();
  }, []);

  const open = (name: string | null) => {
    setSel(name);
    setPool(name ? (pools.find((p) => p.name === name) ?? null) : newPool());
  };

  const patch = (p: Partial<SpinnerPool>) => setPool((c) => c && { ...c, ...p });
  const patchSeg = (i: number, p: Partial<SpinnerSegment>) =>
    setPool(
      (c) =>
        c && {
          ...c,
          segments: c.segments.map((s, j) => (j === i ? { ...s, ...p } : s)),
        }
    );

  const save = () => {
    if (!pool) return;
    api
      .saveSpinner(pool)
      .then(() => {
        setMsg(`Пул «${pool.name}» сохранён`);
        setTimeout(() => setMsg(null), 2500);
        reload().then(() => setSel(pool.name));
      })
      .catch((e) => setError(humanError(e)));
  };

  const remove = () => {
    if (!pool?.name) return;
    api
      .deleteSpinner(pool.name)
      .then(() => {
        setPool(newPool());
        setSel(null);
        reload();
      })
      .catch((e) => setError(humanError(e)));
  };

  const total = pool?.segments.reduce((a, s) => a + (s.weight || 1), 0) || 1;

  return (
    <div className="max-w-4xl flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Gift Spinner</h1>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => open(null)}>
            <Plus size={14} /> Новый пул
          </Button>
          {pool && sel && (
            <Button size="sm" variant="destructive" onClick={remove}>
              <Trash2 size={14} /> Удалить
            </Button>
          )}
          <Button size="sm" onClick={save} disabled={!pool}>
            <Save size={14} /> Сохранить
          </Button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground -mt-2">
        Правило с 🎡 вместо действия крутит колесо: лаунчер выбирает сегмент
        взвешенно, оверлей /overlay/spinner только анимирует — остановка точно
        на выбранном сегменте.
      </p>

      {error && <div className="text-sm text-red-400">{error}</div>}
      {msg && <div className="text-sm text-emerald-400">{msg}</div>}

      <div className="flex gap-4">
        {/* Pool list */}
        <Card className="w-56 shrink-0">
          <CardHeader className="py-3">
            <CardTitle className="text-sm">Пулы</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-1">
            {pools.length === 0 && (
              <div className="text-xs text-muted-foreground">Пулов нет — создайте первый</div>
            )}
            {pools.map((p) => (
              <button
                key={p.name}
                onClick={() => open(p.name)}
                className={`text-left rounded px-2 py-1.5 text-sm ${
                  sel === p.name ? 'bg-primary/15 text-primary' : 'hover:bg-secondary/60'
                }`}
              >
                🎡 {p.name}
                <span className="text-xs text-muted-foreground ml-1">
                  ({p.segments.length})
                </span>
              </button>
            ))}
          </CardContent>
        </Card>

        {/* Editor */}
        {pool ? (
          <Card className="flex-1">
            <CardHeader className="py-3">
              <CardTitle className="text-sm">
                {sel ? `Пул «${pool.name}»` : 'Новый пул'}
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 text-sm">
              <div className="flex gap-3">
                <label className="flex flex-col gap-1 flex-1">
                  <span className="text-xs text-muted-foreground">Имя пула</span>
                  <input
                    className="bg-input rounded px-2 py-1.5"
                    value={pool.name}
                    disabled={!!sel}
                    onChange={(e) => patch({ name: e.target.value })}
                    placeholder="chaos-wheel"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-muted-foreground">Спин, мс</span>
                  <input
                    type="number"
                    min={500}
                    step={500}
                    className="w-24 bg-input rounded px-2 py-1.5"
                    value={pool.spin_ms}
                    onChange={(e) => patch({ spin_ms: Number(e.target.value) })}
                  />
                </label>
              </div>

              <div className="flex gap-4 items-start">
                <div className="flex-1 flex flex-col gap-1">
                  <div className="grid grid-cols-[1fr_1fr_70px_64px_36px_28px] gap-1 text-[11px] text-muted-foreground px-1">
                    <span>Подпись</span>
                    <span>Действие</span>
                    <span>Вес</span>
                    <span>Шанс</span>
                    <span>Цвет</span>
                    <span />
                  </div>
                  {pool.segments.map((s, i) => (
                    <div
                      key={i}
                      className="grid grid-cols-[1fr_1fr_70px_64px_36px_28px] gap-1 items-center"
                    >
                      <input
                        className="bg-input rounded px-2 py-1 text-xs"
                        value={s.label}
                        onChange={(e) => patchSeg(i, { label: e.target.value })}
                      />
                      <input
                        className="bg-input rounded px-2 py-1 text-xs font-mono"
                        value={s.action}
                        onChange={(e) => patchSeg(i, { action: e.target.value })}
                        placeholder="spawn_enemy"
                      />
                      <input
                        type="number"
                        min={1}
                        className="bg-input rounded px-2 py-1 text-xs"
                        value={s.weight}
                        onChange={(e) => patchSeg(i, { weight: Number(e.target.value) })}
                      />
                      <span className="text-xs text-muted-foreground text-center">
                        {Math.round(((s.weight || 1) / total) * 100)}%
                      </span>
                      <input
                        type="color"
                        className="h-6 w-full bg-transparent"
                        value={s.color || '#7c3aed'}
                        onChange={(e) => patchSeg(i, { color: e.target.value })}
                      />
                      <button
                        className="text-muted-foreground hover:text-red-400"
                        onClick={() =>
                          patch({ segments: pool.segments.filter((_, j) => j !== i) })
                        }
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  ))}
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-1 self-start"
                    onClick={() =>
                      patch({ segments: [...pool.segments, newSeg(pool.segments.length)] })
                    }
                  >
                    <Plus size={13} /> Сегмент
                  </Button>
                </div>
                <WheelPreview pool={pool} />
              </div>
            </CardContent>
          </Card>
        ) : (
          <Card className="flex-1">
            <CardContent className="py-10 text-center text-sm text-muted-foreground">
              Выберите пул слева или создайте новый — затем привяжите его к
              правилу в маппере (поле 🎡).
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
