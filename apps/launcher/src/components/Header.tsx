/**
 * @file Header.tsx
 * Top bar: app identity, masked account info, Streamer Mode toggle,
 * logout.
 */
import React, { useEffect, useState } from 'react';
import { EyeOff, LogOut, ClipboardCopy, Radio } from 'lucide-react';
import { useApp } from '../App';
import * as api from '../api';
import { maskEmail } from '../lib/utils';
import type { IntegrationStatus } from '../types';
import { Switch } from './ui/switch';
import { Button } from './ui/button';
import { Badge } from './ui/badge';

export default function Header() {
  const { email, streamerMode, setStreamerMode, clearSession, subscription } = useApp();
  const [ttStatus, setTtStatus] = useState<IntegrationStatus | undefined>();
  const subActive = subscription?.status === 'active';

  // Live indicator: initial snapshot + instant updates via integration-status.
  useEffect(() => {
    let un: (() => void) | undefined;
    api.getIntegrationStatus().then((s) => setTtStatus(s.tiktok)).catch(() => {});
    api
      .onIntegrationStatus((p) => {
        if (p.integration === 'tiktok') setTtStatus(p.status as IntegrationStatus);
      })
      .then((u) => (un = u));
    return () => un?.();
  }, []);
  // Null-safe period end — the badge must survive a missing/field-less sub.
  const until = subscription?.current_period_end
    ? new Date(subscription.current_period_end).toLocaleDateString('ru-RU')
    : '—';

  const logout = () => {
    if (window.confirm('Выйти из аккаунта? Текущая сессия будет завершена.')) {
      void clearSession();
    }
  };

  const [copied, setCopied] = useState(false);
  /** Copies a secrets-free diagnostics report to the clipboard. */
  const copyDiagnostics = async () => {
    try {
      const report = await api.getDiagnostics();
      await navigator.clipboard.writeText(report);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard API may be unavailable — diagnostics still in the log file */
    }
  };

  return (
    <header className="h-14 shrink-0 flex items-center justify-between px-4 border-b border-border bg-card/60">
      <div className="flex items-center gap-3">
        <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-primary to-accent flex items-center justify-center font-black">
          ▶
        </div>
        <span className="font-semibold tracking-wide">chlauncher</span>
        <Badge variant={subActive ? 'success' : 'destructive'}>
          {subActive ? `Подписка до ${until}` : 'Подписка неактивна'}
        </Badge>
        <Badge
          variant={
            ttStatus === 'live'
              ? 'success'
              : ttStatus === 'connecting' || ttStatus === 'connected'
                ? 'warning'
                : 'outline'
          }
          className="gap-1"
          title="Статус связи с TikTok-эфиром"
        >
          <Radio size={12} />
          {ttStatus === 'live'
            ? 'LIVE'
            : ttStatus === 'connecting' || ttStatus === 'connected'
              ? 'связь…'
              : 'оффлайн'}
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
        <Button
          variant="ghost"
          size="icon"
          title={copied ? 'Скопировано' : 'Скопировать diagnostics'}
          onClick={() => void copyDiagnostics()}
        >
          <ClipboardCopy size={16} className={copied ? 'text-green-400' : ''} />
        </Button>
        <Button variant="ghost" size="icon" title="Выйти" onClick={logout}>
          <LogOut size={16} />
        </Button>
      </div>
    </header>
  );
}
