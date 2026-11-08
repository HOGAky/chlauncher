/**
 * @file IntegrationsPage.tsx
 * Stream integrations hub: TikTok Live username connect (public room
 * presence), DonationAlerts token connect, and the Browser Source overlay
 * URL for TikTok Live Studio.
 */
import React, { useEffect, useState } from 'react';
import { Radio, Copy, Wallet, Cloud, RefreshCw } from 'lucide-react';
import * as api from '../api';
import { useApp } from '../App';
import { maskSecret } from '../lib/utils';
import type { ForwardStatus, IntegrationStatus } from '../types';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Switch } from '../components/ui/switch';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';

import { humanError } from '../errorMessages';
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

  // Roblox cloud-relay forward
  const fwd = boot?.forward;
  const [fwdEnabled, setFwdEnabled] = useState(fwd?.enabled ?? false);
  const [fwdUrl, setFwdUrl] = useState(fwd?.forward_url ?? '');
  const [fwdSecret, setFwdSecret] = useState('');
  const [streamKey, setStreamKey] = useState(fwd?.stream_key ?? '');
  const [fwdStatus, setFwdStatus] = useState<ForwardStatus | null>(fwd?.status ?? null);
  const [fwdErr, setFwdErr] = useState('');
  const [keyCopied, setKeyCopied] = useState(false);

  useEffect(() => {
    const t = setInterval(() => {
      api.getForwardStatus().then(setFwdStatus).catch(() => {});
    }, 5000);
    return () => clearInterval(t);
  }, []);

  const saveForward = (enabled: boolean) => {
    setFwdErr('');
    api
      .setForwardConfig(enabled, fwdUrl.trim(), fwdSecret)
      .then(() => setFwdEnabled(enabled))
      .catch((e) => setFwdErr(humanError(e)));
  };

  const copyKey = () => {
    navigator.clipboard.writeText(streamKey).then(() => {
      setKeyCopied(true);
      setTimeout(() => setKeyCopied(false), 1500);
    });
  };

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

      {/* Roblox / cloud relay forward */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <Cloud size={18} /> Roblox (облачный релей)
            </CardTitle>
            {fwdStatus?.last_error ? (
              <Badge variant="destructive">{fwdStatus.last_error}</Badge>
            ) : fwdEnabled ? (
              <Badge variant="success">Форвард включён</Badge>
            ) : (
              <Badge variant="outline">Выключено</Badge>
            )}
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">
            События уходят HTTP-POST'ом на облачный релей — Roblox-игра забирает
            их поллингом. Ключ стримера = пропуск в руму (вводится в игре).
          </p>
          <div className="flex gap-2 items-center">
            <code className="flex-1 text-xs bg-secondary/60 rounded-md px-3 py-2 select-all truncate">
              {streamerMode ? maskSecret(streamKey || '…') : streamKey || 'ключ не создан'}
            </code>
            <Button variant="outline" size="sm" onClick={copyKey} disabled={!streamKey}>
              <Copy size={14} /> {keyCopied ? 'OK' : 'Копия'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => api.regenerateStreamKey().then(setStreamKey).catch(() => {})}
            >
              <RefreshCw size={14} /> Новый
            </Button>
          </div>
          <Input
            placeholder="URL релея, напр. https://relay.example.com"
            value={fwdUrl}
            onChange={(e) => setFwdUrl(e.target.value)}
          />
          <Input
            type={streamerMode ? 'password' : 'text'}
            placeholder={fwd?.has_admin_secret ? 'Admin-секрет (уже сохранён)' : 'Admin-секрет релея'}
            value={fwdSecret}
            onChange={(e) => setFwdSecret(e.target.value)}
          />
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Switch checked={fwdEnabled} onCheckedChange={saveForward} />
              <span className="text-xs text-muted-foreground">
                Форвардить события + продлевать ключ
              </span>
            </div>
            {fwdStatus && (
              <span className="text-[11px] text-muted-foreground">
                доставлено {fwdStatus.delivered} · потеряно {fwdStatus.dropped}
              </span>
            )}
          </div>
          {fwdStatus?.registered_until && (
            <p className="text-[11px] text-muted-foreground">
              Ключ зарегистрирован до {new Date(fwdStatus.registered_until).toLocaleString()}
            </p>
          )}
          {fwdErr && <p className="text-[11px] text-destructive">{fwdErr}</p>}
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
