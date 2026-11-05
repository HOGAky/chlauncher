/**
 * @file IntegrationsPage.tsx
 * Stream integrations hub: TikTok Live username connect (public room
 * presence), DonationAlerts token connect, and the Browser Source overlay
 * URL for TikTok Live Studio.
 */
import React, { useEffect, useState } from 'react';
import { Radio, Copy, Wallet } from 'lucide-react';
import * as api from '../api';
import { useApp } from '../App';
import { maskSecret } from '../lib/utils';
import type { IntegrationStatus } from '../types';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';

/** Maps serde's IntegrationStatus union to badge + label. */
function statusBadge(st: IntegrationStatus | undefined) {
  if (!st || st === 'disconnected') return <Badge variant="outline">Отключено</Badge>;
  if (st === 'connecting') return <Badge variant="warning">Подключение…</Badge>;
  if (st === 'connected') return <Badge>Онлайн</Badge>;
  if (st === 'live') return <Badge variant="success">В эфире</Badge>;
  if (typeof st === 'object' && 'error' in st)
    return <Badge variant="destructive">Ошибка: {st.error}</Badge>;
  return <Badge variant="outline">{String(st)}</Badge>;
}

export default function IntegrationsPage() {
  const { boot, streamerMode, overlayUrl } = useApp();
  const [username, setUsername] = useState(boot?.tiktok_username ?? '');
  const [daToken, setDaToken] = useState('');
  const [statuses, setStatuses] = useState(boot?.integrations);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let un: (() => void) | undefined;
    api
      .onIntegrationStatus((p) => {
        setStatuses((s) =>
          s
            ? {
                ...s,
                tiktok: p.integration === 'tiktok' ? (p.status as IntegrationStatus) : s.tiktok,
                donationalerts:
                  p.integration === 'donationalerts'
                    ? (p.status as IntegrationStatus)
                    : s.donationalerts,
              }
            : s
        );
      })
      .then((u) => (un = u));
    return () => un?.();
  }, []);

  const ttConnected =
    statuses?.tiktok === 'connected' || statuses?.tiktok === 'live' || statuses?.tiktok === 'connecting';
  const daConnected = statuses?.donationalerts === 'live' || statuses?.donationalerts === 'connecting';

  const copyOverlay = () => {
    navigator.clipboard.writeText(overlayUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="max-w-2xl flex flex-col gap-4">
      <h1 className="text-lg font-semibold">Интеграции стрима</h1>

      {/* TikTok Live */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <Radio size={18} /> TikTok Live
            </CardTitle>
            {statusBadge(statuses?.tiktok)}
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">
            Лаунчер читает публичную трансляцию по нику — пароль не нужен.
            Подарки, лайки и комментарии агрегируются здесь и транслируются в игру.
          </p>
          <div className="flex gap-2">
            <Input
              placeholder="TikTok username (без @)"
              value={username}
              onChange={(e) => setUsername(e.target.value.replace(/^@/, ''))}
            />
            {ttConnected ? (
              <Button variant="secondary" onClick={() => api.tiktokDisconnect()}>
                Отключить
              </Button>
            ) : (
              <Button
                disabled={!username.trim()}
                onClick={() => api.tiktokConnect(username.trim()).catch(() => {})}
              >
                Подключить
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* DonationAlerts */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <Wallet size={18} /> DonationAlerts
            </CardTitle>
            {statusBadge(statuses?.donationalerts)}
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">
            Вставьте access token DonationAlerts — донаты придут в игру в реальном
            времени через WebSocket.
          </p>
          <div className="flex gap-2">
            <Input
              type={streamerMode ? 'password' : 'text'}
              placeholder="Access token"
              value={streamerMode ? '' : daToken}
              onChange={(e) => setDaToken(e.target.value)}
            />
            {daConnected ? (
              <Button variant="secondary" onClick={() => api.daDisconnect()}>
                Отключить
              </Button>
            ) : (
              <Button
                disabled={!daToken.trim()}
                onClick={() => api.daConnect(daToken.trim()).catch(() => {})}
              >
                Подключить
              </Button>
            )}
          </div>
          {boot?.integrations && streamerMode && (
            <p className="text-[11px] text-muted-foreground">
              Токен скрыт в режиме стримера: {maskSecret('x')}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Overlay */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Web-оверлей для TikTok Live Studio</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">
            Добавьте этот URL как «Browser Source» в TikTok Live Studio — последние
            донаты, алерты и топ дарителей отобразятся поверх стрима.
          </p>
          <div className="flex gap-2 items-center">
            <code className="flex-1 text-xs bg-secondary/60 rounded-md px-3 py-2 select-all">
              {overlayUrl}
            </code>
            <Button variant="outline" size="sm" onClick={copyOverlay}>
              <Copy size={14} /> {copied ? 'Скопировано' : 'Копировать'}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
