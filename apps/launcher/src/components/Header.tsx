/**
 * @file Header.tsx
 * Top bar: app identity, masked account info, Streamer Mode toggle,
 * logout.
 */
import React from 'react';
import { EyeOff, LogOut } from 'lucide-react';
import { useApp } from '../App';
import { maskEmail } from '../lib/utils';
import { Switch } from './ui/switch';
import { Button } from './ui/button';
import { Badge } from './ui/badge';

export default function Header() {
  const { email, streamerMode, setStreamerMode, clearSession, subscription } = useApp();
  const subActive = subscription?.status === 'active';

  return (
    <header className="h-14 shrink-0 flex items-center justify-between px-4 border-b border-border bg-card/60">
      <div className="flex items-center gap-3">
        <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-primary to-accent flex items-center justify-center font-black">
          ▶
        </div>
        <span className="font-semibold tracking-wide">chlauncher</span>
        <Badge variant={subActive ? 'success' : 'destructive'}>
          {subActive
            ? `Подписка до ${new Date(subscription!.current_period_end!).toLocaleDateString('ru-RU')}`
            : 'Подписка неактивна'}
        </Badge>
      </div>
      <div className="flex items-center gap-4">
        <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none">
          <EyeOff size={14} />
          Режим стримера
          <Switch checked={streamerMode} onCheckedChange={setStreamerMode} />
        </label>
        <span className="text-xs text-muted-foreground">
          {streamerMode ? maskEmail(email) : email}
        </span>
        <Button variant="ghost" size="icon" title="Выйти" onClick={clearSession}>
          <LogOut size={16} />
        </Button>
      </div>
    </header>
  );
}
