/**
 * @file Header.tsx
 * Top bar: app identity, masked account info, Streamer Mode toggle,
 * logout.
 */
import React, { useEffect, useRef, useState } from 'react';
import { EyeOff, LogOut, ClipboardCopy, Radio } from 'lucide-react';
import { useApp } from '../App';
import * as api from '../api';
import { humanError } from '../errorMessages';
import { maskEmail } from '../lib/utils';
import type { IntegrationStatus } from '../types';
import { Switch } from './ui/switch';
import { Button } from './ui/button';
import { Badge } from './ui/badge';

export default function Header() {
  const { email, streamerMode, setStreamerMode, clearSession, subscription, boot } = useApp();
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
  // Quick TikTok connect popover (EFIR parity): click the LIVE badge →
  // @username field + connect/disconnect without leaving the page.
  const [ttOpen, setTtOpen] = useState(false);
  // Last connected nick — restored from settings so the field survives
  // app restarts (it used to blank out every launch).
  const [ttUser, setTtUser] = useState(() => boot?.tiktok_username ?? '');
  const [ttErr, setTtErr] = useState('');
  const [ttBusy, setTtBusy] = useState(false);
  const ttRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ttOpen) return;
    const close = (e: MouseEvent) => {
      if (!ttRef.current?.contains(e.target as Node)) setTtOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [ttOpen]);

  const ttConnect = async () => {
    const u = ttUser.trim().replace(/^@/, '');
    if (!u || ttBusy) return;
    setTtBusy(true);
    setTtErr('');
    try {
      await api.tiktokConnect(u);
      setTtOpen(false);
    } catch (e) {
      setTtErr(humanError(e));
    } finally {
      setTtBusy(false);
    }
  };
  const ttDisconnect = async () => {
    setTtBusy(true);
    try {
      await api.tiktokDisconnect();
      setTtOpen(false);
    } catch (e) {
      setTtErr(humanError(e));
    } finally {
      setTtBusy(false);
    }
  };

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
        <img src="/logo.svg" alt="" className="h-8 w-8 shrink-0 select-none" draggable={false} />
        <span className="font-semibold tracking-wide">chlauncher</span>
        <Badge variant={subActive ? 'success' : 'destructive'}>
          {subActive ? `Подписка до ${until}` : 'Подписка неактивна'}
        </Badge>
        <div className="relative" ref={ttRef}>
          <button onClick={() => setTtOpen(!ttOpen)} title="Подключение к TikTok-эфиру">
            <Badge
              variant={
                ttStatus === 'live'
                  ? 'success'
                  : ttStatus === 'connecting' || ttStatus === 'connected'
                    ? 'warning'
                    : typeof ttStatus === 'object'
                      ? 'destructive'
                      : 'outline'
              }
              className="gap-1 cursor-pointer"
            >
              <Radio size={12} />
              {ttStatus === 'live'
                ? 'LIVE'
                : ttStatus === 'connecting' || ttStatus === 'connected'
                  ? 'связь…'
                  : typeof ttStatus === 'object'
                    ? 'ошибка'
                    : 'оффлайн'}
            </Badge>
          </button>
          {ttOpen && (
            <div className="absolute right-0 top-full z-50 mt-2 w-64 rounded-lg border border-border bg-card p-3 shadow-xl">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void ttConnect();
                }}
                className="flex flex-col gap-2"
              >
                <label className="text-xs font-medium text-muted-foreground">
                  Аккаунт TikTok
                </label>
                <div className="flex gap-1.5">
                  <span className="flex items-center text-sm text-muted-foreground">@</span>
                  <input
                    autoFocus
                    className="h-8 flex-1 rounded-md border border-input bg-background px-2 text-sm"
                    placeholder="username"
                    maxLength={32}
                    value={ttUser}
                    onChange={(e) => setTtUser(e.target.value)}
                  />
                  <Button size="sm" type="submit" disabled={ttBusy || !ttUser.trim()}>
                    →
                  </Button>
                </div>
                {ttErr && <p className="text-xs text-red-400">{ttErr}</p>}
                <div className="flex items-center justify-between pt-1">
                  <span className="text-xs text-muted-foreground">
                    {ttStatus === 'live'
                      ? 'Эфир читается'
                      : typeof ttStatus === 'object'
                        ? (ttStatus as { error: string }).error
                        : 'Не подключено'}
                  </span>
                  {(ttStatus === 'live' || ttStatus === 'connecting' || ttStatus === 'connected') && (
                    <button
                      type="button"
                      className="text-xs text-red-400 hover:underline"
                      onClick={() => void ttDisconnect()}
                      disabled={ttBusy}
                    >
                      Отключить
                    </button>
                  )}
                </div>
              </form>
            </div>
          )}
        </div>
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
