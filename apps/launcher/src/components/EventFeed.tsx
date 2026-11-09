/**
 * @file EventFeed.tsx
 * Live feed of stream events — fired AND skipped ones with a status
 * label (cooldown/limit/dropped), so the streamer sees why a rule
 * didn't fire. Backed by `get_event_feed_items` polled while mounted;
 * the context `stream-event` subscription triggers instant refetches.
 */
import React, { useEffect, useState } from 'react';
import * as api from '../api';
import type { FeedItem } from '../types';
import { useApp } from '../App';
import { Badge } from './ui/badge';
import { Button } from './ui/button';

const SOURCE_COLORS: Record<string, string> = {
  tiktok: 'text-cyan-300',
  donationalerts: 'text-amber-300',
  simulator: 'text-violet-300',
};

const STATUS_LABELS: Record<string, { text: string; cls: string }> = {
  cooldown: { text: 'кулдаун', cls: 'text-amber-300 border-amber-300/40' },
  interrupt_cooldown: { text: 'кулдаун', cls: 'text-amber-300 border-amber-300/40' },
  limit: { text: 'лимит', cls: 'text-red-300 border-red-300/40' },
  paused: { text: 'пауза', cls: 'text-sky-300 border-sky-300/40' },
  dropped: { text: 'дроп', cls: 'text-red-300 border-red-300/40' },
};

/** Render cap — the backend deque itself is bounded at 100 entries. */
const RENDER_CAP = 50;

export default function EventFeed() {
  const { feed } = useApp();
  const [items, setItems] = useState<FeedItem[]>([]);

  useEffect(() => {
    let alive = true;
    const poll = () =>
      api
        .getEventFeedItems()
        .then((r) => alive && setItems(r))
        .catch(() => {});
    poll();
    const t = setInterval(poll, 1500);
    return () => {
      alive = false;
      clearInterval(t);
    };
    // `feed.length` — a new live event triggers an immediate refetch.
  }, [feed.length]);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">
          {items.length > 0 ? `${items.length} событий` : ''}
        </span>
        {items.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => setItems([])}
          >
            Очистить
          </Button>
        )}
      </div>
      {items.length === 0 && (
        <p className="text-xs text-muted-foreground">Событий пока нет — отправьте тестовое.</p>
      )}
      {items.slice(0, RENDER_CAP).map((it, i) => {
        const e = it.event;
        const st = STATUS_LABELS[it.status];
        return (
          <div
            key={`${it.ts}-${i}`}
            className={`text-xs bg-secondary/40 border border-border/50 rounded-md px-3 py-1.5 flex items-center gap-2 ${
              st ? 'opacity-70' : ''
            }`}
          >
            <span className={SOURCE_COLORS[e.source] ?? 'text-foreground'}>{e.source}</span>
            <span className="text-muted-foreground">{e.event_kind}</span>
            <span className="font-medium">{e.user}</span>
            <span className="text-muted-foreground truncate flex-1">{e.raw_name}</span>
            {st ? (
              <Badge variant="outline" className={st.cls}>
                {st.text}
              </Badge>
            ) : (
              <Badge variant="default">
                {e.action_command}
                {e.amount > 0 ? ` ×${e.amount}` : ''}
              </Badge>
            )}
          </div>
        );
      })}
    </div>
  );
}
