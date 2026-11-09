/**
 * @file GiftPicker.tsx
 * Popover grid of TikTok gift icons for the trigger mapper — the streamer
 * picks a gift instead of typing its name. The catalog is bundled at
 * `public/gifts.json` + `public/gifts/` (refresh: `node tools/fetch-gifts.mjs`).
 */
import React, { useEffect, useRef, useState } from 'react';
import { Gift } from 'lucide-react';
import type { GiftEntry } from '../types';
import { Button } from './ui/button';
import { Input } from './ui/input';

export default function GiftPicker({ onPick }: { onPick: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<GiftEntry[] | null>(null);
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  // Load the catalog lazily on first open.
  useEffect(() => {
    if (open && rows === null) {
      fetch('/gifts.json')
        .then((r) => r.json())
        .then(setRows)
        .catch(() => setRows([]));
    }
  }, [open, rows]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const needle = q.trim().toLowerCase();
  const filtered = !rows
    ? []
    : needle
      ? rows.filter((r) => r.name.toLowerCase().includes(needle))
      : rows;

  return (
    <div ref={ref} className="relative">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        title="Выбрать подарок из каталога"
        onClick={() => setOpen((o) => !o)}
      >
        <Gift size={14} />
      </Button>
      {open && (
        <div className="absolute z-50 mt-1 w-[380px] rounded-md border border-border bg-popover p-2 shadow-md">
          <Input
            autoFocus
            className="mb-2 h-8"
            placeholder="Поиск подарка (Rose, Lion, …)"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <div className="grid max-h-64 grid-cols-6 gap-1 overflow-y-auto">
            {filtered.slice(0, 300).map((g) => (
              <button
                key={`${g.name}|${g.coins}`}
                type="button"
                title={`${g.name} — ${g.coins} монет`}
                className="flex flex-col items-center gap-0.5 rounded p-1 text-[10px] text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
                onClick={() => {
                  onPick(g.name);
                  setOpen(false);
                }}
              >
                <img src={`/${g.image}`} alt={g.name} className="h-10 w-10" loading="lazy" />
                <span className="max-w-full truncate">{g.name}</span>
              </button>
            ))}
            {rows && filtered.length === 0 && (
              <p className="col-span-6 py-4 text-center text-xs text-muted-foreground">
                Ничего не найдено — введите название вручную
              </p>
            )}
            {rows === null && (
              <p className="col-span-6 py-4 text-center text-xs text-muted-foreground">
                Загрузка каталога…
              </p>
            )}
          </div>
          {filtered.length > 300 && (
            <p className="mt-1 text-center text-[10px] text-muted-foreground">
              +{filtered.length - 300} — уточните поиск
            </p>
          )}
        </div>
      )}
    </div>
  );
}
