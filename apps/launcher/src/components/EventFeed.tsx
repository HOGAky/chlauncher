/**
 * @file EventFeed.tsx
 * Live feed of mapped stream events — what the game is receiving right now.
 * Sourced from the app context which subscribes to `stream-event`.
 */
import React from 'react';
import { useApp } from '../App';
import { Badge } from './ui/badge';

const SOURCE_COLORS: Record<string, string> = {
  tiktok: 'text-cyan-300',
  donationalerts: 'text-amber-300',
  simulator: 'text-violet-300',
};

export default function EventFeed() {
  const { feed } = useApp();
  return (
    <div className="flex flex-col gap-1.5">
      {feed.length === 0 && (
        <p className="text-xs text-muted-foreground">Событий пока нет — отправьте тестовое.</p>
      )}
      {feed
        .slice()
        .reverse()
        .slice(0, 25)
        .map((e, i) => (
          <div
            key={i}
            className="text-xs bg-secondary/40 border border-border/50 rounded-md px-3 py-1.5 flex items-center gap-2"
          >
            <span className={SOURCE_COLORS[e.source] ?? 'text-foreground'}>{e.source}</span>
            <span className="text-muted-foreground">{e.event_kind}</span>
            <span className="font-medium">{e.user}</span>
            <span className="text-muted-foreground truncate flex-1">{e.raw_name}</span>
            <Badge variant="default">
              {e.action_command}
              {e.amount > 0 ? ` ×${e.amount}` : ''}
            </Badge>
          </div>
        ))}
    </div>
  );
}
