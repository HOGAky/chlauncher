/**
 * @file PointsCard.tsx
 * Viewer points + !buy shop («очки зрителей»): earn rates, the shop
 * list (each item injects a `shop` event — a rule decides the action),
 * and the top balances. Balances persist to points.json.
 */
import React, { useEffect, useState } from 'react';
import { Coins, Plus, Save, ShoppingBag, Trash2 } from 'lucide-react';
import * as api from '../api';
import { humanError } from '../errorMessages';
import type { PointsCfg, PointsRow, ShopItem } from '../types';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Switch } from './ui/switch';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';

export default function PointsCard() {
  const [cfg, setCfg] = useState<PointsCfg | null>(null);
  const [items, setItems] = useState<ShopItem[]>([]);
  const [top, setTop] = useState<PointsRow[]>([]);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    api.getPointsCfg().then(setCfg).catch(() => {});
    api.getShopItems().then(setItems).catch(() => {});
    const poll = () => api.pointsTop().then(setTop).catch(() => {});
    poll();
    const t = setInterval(poll, 5000);
    return () => clearInterval(t);
  }, []);

  const patchItem = (i: number, p: Partial<ShopItem>) =>
    setItems((xs) => xs.map((x, j) => (j === i ? { ...x, ...p } : x)));

  const save = () => {
    setErr('');
    setMsg('');
    Promise.all([
      cfg ? api.savePointsCfg(cfg) : Promise.resolve(),
      api.saveShopItems(items),
    ])
      .then(() => setMsg('Сохранено'))
      .catch((e) => setErr(humanError(e)));
  };

  const c = cfg ?? {
    enabled: false,
    per_comment: 1,
    comment_cooldown_s: 60,
    per_coin: 10,
    per_sub: 500,
    per_follow: 50,
  };
  const set = (p: Partial<PointsCfg>) => setCfg({ ...c, ...p });

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <Coins size={16} /> Очки и магазин
          </CardTitle>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              вкл
              <Switch checked={c.enabled} onCheckedChange={(v) => set({ enabled: v })} />
            </label>
            <Button variant="outline" size="sm" onClick={save}>
              <Save size={12} /> Сохранить
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-xs text-muted-foreground">
          Зрители копят очки за активность и тратят: «!buy kill». Покупка
          шлёт событие «shop» — правило с типом «shop» и совпадением по
          названию товара выполняет действие. Балансы переживают
          перезапуск.
        </p>

        <div className="grid grid-cols-3 gap-2 text-xs">
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">за коммент</span>
            <Input
              type="number"
              min={0}
              value={c.per_comment}
              onChange={(e) => set({ per_comment: Number(e.target.value) || 0 })}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">за коин</span>
            <Input
              type="number"
              min={0}
              value={c.per_coin}
              onChange={(e) => set({ per_coin: Number(e.target.value) || 0 })}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">кд комм, сек</span>
            <Input
              type="number"
              min={0}
              value={c.comment_cooldown_s}
              onChange={(e) => set({ comment_cooldown_s: Number(e.target.value) || 0 })}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">за подписку</span>
            <Input
              type="number"
              min={0}
              value={c.per_sub}
              onChange={(e) => set({ per_sub: Number(e.target.value) || 0 })}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">за фоллов</span>
            <Input
              type="number"
              min={0}
              value={c.per_follow}
              onChange={(e) => set({ per_follow: Number(e.target.value) || 0 })}
            />
          </label>
        </div>

        <div className="border-t border-border/60 pt-3">
          <div className="flex items-center gap-2 text-xs font-medium mb-2">
            <ShoppingBag size={14} /> Магазин (!buy …)
          </div>
          {items.map((it, i) => (
            <div key={it.id || i} className="flex items-center gap-2 mb-2">
              <Switch
                checked={it.enabled}
                onCheckedChange={(v) => patchItem(i, { enabled: v })}
              />
              <Input
                className="w-28"
                placeholder="kill"
                value={it.name}
                onChange={(e) => patchItem(i, { name: e.target.value })}
              />
              <Input
                className="w-24"
                type="number"
                min={0}
                placeholder="цена"
                value={it.price || ''}
                onChange={(e) => patchItem(i, { price: Number(e.target.value) || 0 })}
              />
              <Input
                className="flex-1"
                placeholder="подсказка («спавнит крипера»)"
                value={it.hint}
                onChange={(e) => patchItem(i, { hint: e.target.value })}
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setItems((xs) => xs.filter((_, j) => j !== i))}
              >
                <Trash2 size={13} />
              </Button>
            </div>
          ))}
          <Button
            variant="outline"
            size="sm"
            disabled={items.length >= 50}
            onClick={() =>
              setItems((xs) => [
                ...xs,
                { id: '', name: '', price: 100, hint: '', enabled: true },
              ])
            }
          >
            <Plus size={13} /> Товар
          </Button>
        </div>

        {top.length > 0 && (
          <div className="border-t border-border/60 pt-3">
            <div className="text-xs font-medium mb-1">Топ по очкам</div>
            <div className="max-h-32 overflow-y-auto">
              {top.slice(0, 10).map((r, i) => (
                <div key={r.user} className="flex gap-2 text-xs py-0.5">
                  <span className="w-5 text-sky-400 tabular-nums">{i + 1}</span>
                  <span className="truncate flex-1">{r.user}</span>
                  <span className="tabular-nums text-muted-foreground">{r.points}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        {msg && <p className="text-[11px] text-emerald-400">{msg}</p>}
        {err && <p className="text-[11px] text-destructive">{err}</p>}
      </CardContent>
    </Card>
  );
}
